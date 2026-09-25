// The CoreAudio AudioIO (NATIVE.md §5.3). Public API on the main queue.
// Refuses to start in test processes (--test, --selftest, SOTTO_APP_TEST=1, XCTest): automation
// never opens a real mic or speaker.
import AVFoundation
import CoreAudio
import Foundation

public final class RealAudioIO: AudioIO, @unchecked Sendable {
    public var onMicFrame: ((PCMFrame) -> Void)? { didSet { emitter.onMicFrame = onMicFrame } }
    public var onRoute: ((AudioRouteInfo) -> Void)?
    public var onLevels: ((_ mic: Float, _ speaker: Float) -> Void)?
    public var onError: ((AudioIOError) -> Void)?
    public var onMicSilence: ((Bool) -> Void)?
    public var muted: Bool {
        get { emitter.muted.value != 0 }
        set { emitter.muted.store(newValue ? 1 : 0) }
    }
    public var echoCancellation: EchoCancellation = .automatic { didSet { if oldValue != echoCancellation { scheduleReevaluate(force: false, delay: 0) } } }
    public private(set) var route: AudioRouteInfo?

    private let isTestProcess: Bool
    private let emitter = MicFrameEmitter()
    private let pipeline = OutputPipeline()
    private let captureQueue = DispatchQueue(label: "sotto.audio.capture", qos: .userInteractive)
    /// Capture drops across rebuilds. `stats()` runs on the link queue, so it reads this
    /// atomic rather than the main-owned `capture`.
    private let captureDrops = AtomicInt()

    private var running = false
    private var listenOnly = false
    private var plan: AudioPlan?
    private var capture: CapturePipeline?
    private var halIn: HALInput?
    private var halOut: HALOutput?
    private var vpio: VPIOEngine?
    /// A temporary output for `playSample` while no session output runs.
    private var previewOut: HALOutput?
    private var sampleCompletions: [() -> Void] = []
    private var housekeeping: Timer?
    private var preferredInput: String?
    private var preferredOutput: String?
    private var watcher: DeviceWatcher?
    private var reevaluateWork: DispatchWorkItem?
    private var pendingPermission = false

    public init(isTestProcess: Bool = ProcessGuard.isTestProcess) {
        self.isTestProcess = isTestProcess
        emitter.onSilence = { [weak self] silent in DispatchQueue.main.async { self?.onMicSilence?(silent) } }
    }

    deinit { teardown() }

    // MARK: lifecycle

    public func start(listenOnly: Bool) throws {
        if isTestProcess { throw AudioIOError.testMode }
        if running, listenOnly == self.listenOnly { return }
        switch MicPermission.current() {
        case .authorized: break
        case .denied: throw AudioIOError.micDenied
        case .restricted: throw AudioIOError.micRestricted
        case .notDetermined:
            self.listenOnly = listenOnly
            guard !pendingPermission else { return }
            pendingPermission = true
            MicPermission.request { [weak self] ok in
                guard let self = self else { return }
                self.pendingPermission = false
                if !ok { self.onError?(.micDenied); return }
                do { try self.start(listenOnly: self.listenOnly) } catch let e as AudioIOError { self.onError?(e) } catch { self.onError?(.engine("\(error)")) }
            }
            return
        }
        self.listenOnly = listenOnly
        if running {  // listen <-> full switch: same watchers and timers, new engines
            try rebuild(force: true)
            return
        }
        running = true
        do {
            try rebuild(force: true)
        } catch {
            running = false
            teardown()
            throw error
        }
        watcher = DeviceWatcher { [weak self] in
            guard let self = self else { return }
            self.scheduleReevaluate(force: self.inputRateChanged(), delay: 0.4)
        }
        watchCurrentDevices()
        let t = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(t, forMode: .common)
        housekeeping = t
    }

    public func stop() {
        running = false
        pendingPermission = false
        teardown()
        watcher?.unwatch()
        watcher = nil
        if previewOut == nil { housekeeping?.invalidate(); housekeeping = nil }
        route = nil
        plan = nil
    }

    private func teardown() {
        reevaluateWork?.cancel()
        capture?.stop(); capture = nil
        halIn?.stop(); halIn = nil
        halOut?.stop(); halOut = nil
        vpio?.stop(); vpio = nil
    }

    // MARK: plan + build

    private func currentPlan() -> (AudioPlan, AudioDeviceID?, AudioDeviceID?) {
        let ins = CoreAudioDevices.list(input: true)
        let outs = CoreAudioDevices.list(input: false)
        let input = AudioPlan.pickInput(inputs: ins.map(\.device), defaultInput: CoreAudioDevices.defaultUID(input: true), preferred: preferredInput)
        let output = AudioPlan.pickOutput(outputs: outs.map(\.device), defaultOutput: CoreAudioDevices.defaultUID(input: false), preferred: preferredOutput)
        let plan = AudioPlan.decide(output: output, input: input, pref: echoCancellation, listenOnly: listenOnly)
        return (plan, ins.first(where: { $0.device.id == input?.id })?.objectID, outs.first(where: { $0.device.id == output?.id })?.objectID)
    }

    /// Rebuilds the engines when the plan changed (or `force`), then reports the route.
    private func rebuild(force: Bool) throws {
        let (next, inID, outID) = currentPlan()
        if !force, next == plan { return }
        teardown()
        guard let inputID = inID else { plan = next; throw AudioIOError.noInputDevice }
        emitter.resetDetector()
        var reason = next.reason
        var mode = next.mode
        if mode != .listen {
            // The jitter playout has one consumer: a preview output must not render
            // alongside the session's output (a preview while sleeping, then wake).
            previewOut?.stop(); previewOut = nil
        }
        if mode == .vpio {
            do {
                let v = VPIOEngine()
                v.onConfigurationChange = { [weak self] in self?.scheduleReevaluate(force: true, delay: 0.4) }
                try v.start(inputID: inputID, outputID: outID, pipeline: pipeline) { rate in
                    let c = CapturePipeline(rate: rate, emitter: self.emitter, queue: self.captureQueue, drops: self.captureDrops)
                    self.capture = c
                    return c.ring
                }
                if !v.warnings.isEmpty { reason += "," + v.warnings.joined(separator: ",") }
                vpio = v
            } catch {
                // Voice processing would not start (unsupported device pair, aggregate failure):
                // keep the session audible on the plain units; the daemon's echo filter remains.
                capture?.stop(); capture = nil
                mode = .split
                reason += ",vpio_failed"
            }
        }
        switch mode {
        case .vpio:
            break
        case .split, .listen:
            let hin = HALInput(deviceID: inputID)
            let rate = try hin.prepare()
            let c = CapturePipeline(rate: rate, emitter: emitter, queue: captureQueue, drops: captureDrops)
            try hin.start(ring: c.ring)
            capture = c
            halIn = hin
            if mode == .split {
                let out = HALOutput(deviceID: outID, pipeline: pipeline)
                try out.start()
                halOut = out
            }
        case .fake, .off:
            throw AudioIOError.testMode
        }
        capture?.start()
        plan = next
        var r = next.route
        r.mode = mode
        r.echoCancellation = mode == .vpio
        r.reason = reason
        r.captureRate = capture?.rate ?? 0
        r.deviceRate = CoreAudioDevices.nominalRate(inputID) ?? 0
        route = r
        watchCurrentDevices()
        onRoute?(r)
    }

    private func watchCurrentDevices() {
        guard let w = watcher else { return }
        var ids: [AudioDeviceID] = []
        if let p = plan {
            if let i = p.input, let id = CoreAudioDevices.objectID(uid: i.id, input: true) { ids.append(id) }
            if let o = p.output, let id = CoreAudioDevices.objectID(uid: o.id, input: false) { ids.append(id) }
        }
        w.watch(devices: ids)
    }

    /// The plain AUHAL input converts format but not rate: when the bound device's nominal rate
    /// moves (another app, a Bluetooth profile change) the capture chain must be rebuilt at the
    /// new rate, or the mic reaches the daemon pitch-shifted or not at all. (VPIO reports this
    /// through AVAudioEngineConfigurationChange instead.)
    private func inputRateChanged() -> Bool {
        guard let hin = halIn, let now = CoreAudioDevices.nominalRate(hin.deviceID) else { return false }
        return abs(now - hin.rate) > 0.5
    }

    /// Device and configuration changes, debounced (0.4 s): rebuild only when the plan changes.
    private func scheduleReevaluate(force: Bool, delay: Double) {
        reevaluateWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, self.running else { return }
            do { try self.rebuild(force: force) } catch let e as AudioIOError { self.onError?(e) } catch { self.onError?(.engine("\(error)")) }
        }
        reevaluateWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    // MARK: playout

    public func enqueuePlayback(_ pcm: Data, seq: UInt32, afterFlush: Bool) {
        pipeline.playout.push(pcm, seq: seq, afterFlush: afterFlush)
    }

    public func flushPlayback() { pipeline.playout.flush() }

    public func playSample(_ wav: Data, completion: @escaping () -> Void) {
        guard let pcm = try? WAV.decode24k(wav), !pcm.isEmpty else { completion(); return }
        if isTestProcess { completion(); return }
        pipeline.samples.write(pcm)
        sampleCompletions.append(completion)
        if halOut == nil, vpio == nil, previewOut == nil {
            // No session output (paused or listening): a temporary output on the chosen device.
            let outs = CoreAudioDevices.list(input: false)
            let pick = AudioPlan.pickOutput(outputs: outs.map(\.device), defaultOutput: CoreAudioDevices.defaultUID(input: false), preferred: preferredOutput)
            let out = HALOutput(deviceID: outs.first(where: { $0.device.id == pick?.id })?.objectID, pipeline: pipeline)
            do { try out.start(); previewOut = out } catch {
                pipeline.samples.reset()
                finishSamples()
                return
            }
        }
        if housekeeping == nil {
            let t = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.tick() }
            RunLoop.main.add(t, forMode: .common)
            housekeeping = t
        }
    }

    private func finishSamples() {
        let cbs = sampleCompletions
        sampleCompletions.removeAll()
        previewOut?.stop(); previewOut = nil
        if !running { housekeeping?.invalidate(); housekeeping = nil }
        cbs.forEach { $0() }
    }

    private func tick() {
        if running { onLevels?(emitter.micLevel, pipeline.speakerLevel) }
        if !sampleCompletions.isEmpty, pipeline.samples.isEmpty { finishSamples() }
    }

    public func stopSample() {
        guard !sampleCompletions.isEmpty || !pipeline.samples.isEmpty else { return }
        pipeline.samples.reset()
        finishSamples()
    }

    public func stats() -> PlayoutStats {
        let p = pipeline.playout
        return PlayoutStats(playoutSeq: p.playoutSeq, playoutHostNs: p.playoutHostNs, bufferMs: p.bufferedMs,
                            underruns: p.underruns, overruns: p.overruns, captureDrops: Int(captureDrops.value))
    }

    // MARK: devices

    public func inputDevices() -> [AudioDevice] { CoreAudioDevices.list(input: true).map(\.device) }
    public func outputDevices() -> [AudioDevice] { CoreAudioDevices.list(input: false).map(\.device) }
    public func defaultDeviceID(input: Bool) -> String? { CoreAudioDevices.defaultUID(input: input) }

    public func setPreferredDevices(input: String?, output: String?) {
        preferredInput = input
        preferredOutput = output
        if running { scheduleReevaluate(force: false, delay: 0) }
    }
}
