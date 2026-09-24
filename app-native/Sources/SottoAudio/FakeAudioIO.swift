// Fake audio for `--test` (NATIVE.md §5.3): no CoreAudio unit, ever.
//   input:  SOTTO_APP_MIC_FIXTURE (any WAV, resampled to 24 kHz mono) after SOTTO_APP_MIC_FIXTURE_LEAD_MS,
//           then silence; a quiet 440 Hz tone when the variable is unset. Paced at 20 ms.
//   output: the same jitter buffer and mix as the real engine, clocked by the same timer, recorded in
//           memory and written to SOTTO_APP_OUT_WAV (24 kHz mono PCM16) every 1 s and on stop.
//   SOTTO_APP_ECHO_SIM_DB mixes the rendered output back into the input 40 ms later at that gain.
//   SOTTO_APP_MIC_QUEUE_DIR: a directory the test drops WAV clips into while the app runs; each is
//           taken (renamed *.taken) within 100 ms and spoken into the mic after the clip before it,
//           over silence (no tone). Lets a real-API e2e speak at the moments it chooses (barge-in, wake).
//   onTestEvent reports clip start/end, output speech start/end and flushes (test timing, never audio).
import Foundation

public final class FakeAudioIO: AudioIO, @unchecked Sendable {
    public struct Options {
        /// 24 kHz mono input; nil = tone.
        public var fixture: [Int16]?
        public var leadMs: Int = 0
        public var outWav: URL?
        /// Linear gain of the simulated echo (nil = off).
        public var echoGain: Float?
        /// Directory polled for WAV clips to speak next (test e2e); nil = off.
        public var micQueueDir: URL?
        /// Replace exact zeros in the input with a ±1 LSB floor (on for the app's
        /// `--test` mode, so the silent-mic detector never fires; off in unit tests
        /// that compare samples; `SOTTO_APP_MIC_FIXTURE=silence` sends true zeros).
        public var noiseFloor = false
        public init(fixture: [Int16]? = nil, leadMs: Int = 0, outWav: URL? = nil, echoGain: Float? = nil, micQueueDir: URL? = nil) {
            self.fixture = fixture; self.leadMs = leadMs; self.outWav = outWav; self.echoGain = echoGain; self.micQueueDir = micQueueDir
        }

        public init(env: [String: String]) {
            noiseFloor = env["SOTTO_APP_MIC_FIXTURE"] != "silence"
            if !noiseFloor { fixture = [] }  // exact digital silence throughout
            if let p = env["SOTTO_APP_MIC_FIXTURE"], !p.isEmpty, p != "silence", let d = try? Data(contentsOf: URL(fileURLWithPath: p)) {
                fixture = try? WAV.decode24k(d)
            }
            leadMs = Int(env["SOTTO_APP_MIC_FIXTURE_LEAD_MS"] ?? "") ?? 0
            if let p = env["SOTTO_APP_OUT_WAV"], !p.isEmpty { outWav = URL(fileURLWithPath: p) }
            if let s = env["SOTTO_APP_ECHO_SIM_DB"]?.replacingOccurrences(of: "\u{2212}", with: "-"), let db = Double(s) {
                echoGain = Float(pow(10, db / 20))
            }
            if let p = env["SOTTO_APP_MIC_QUEUE_DIR"], !p.isEmpty { micQueueDir = URL(fileURLWithPath: p, isDirectory: true) }
        }
    }

    public var onMicFrame: ((PCMFrame) -> Void)? { didSet { emitter.onMicFrame = onMicFrame } }
    public var onRoute: ((AudioRouteInfo) -> Void)?
    public var onLevels: ((_ mic: Float, _ speaker: Float) -> Void)?
    public var onError: ((AudioIOError) -> Void)?
    public var onMicSilence: ((Bool) -> Void)?
    public var muted: Bool {
        get { emitter.muted.value != 0 }
        set { emitter.muted.store(newValue ? 1 : 0) }
    }
    public var echoCancellation: EchoCancellation = .automatic
    public private(set) var route: AudioRouteInfo?
    /// Test timing events (on the fake's queue): `mic_clip` {name, phase}, `out_speech` {phase, ...}, `playout_flush`.
    public var onTestEvent: ((String, [String: Any]) -> Void)?

    public let options: Options
    static let fakeInput = AudioDevice(id: "sotto-fake-mic", name: "Test fixture", bluetooth: false, headphones: false, transport: .virtual)
    static let fakeOutput = AudioDevice(id: "sotto-fake-out", name: "Test output (file)", bluetooth: false, headphones: false, transport: .virtual)

    private let emitter = MicFrameEmitter()
    let pipeline = OutputPipeline()
    private let queue = DispatchQueue(label: "sotto.audio.fake", qos: .userInteractive)
    private var timer: DispatchSourceTimer?

    // Queue-confined state.
    private var startedNs: UInt64 = 0
    private var ticksSinceStart: Int64 = 0
    private var inputPos = 0            // samples of input timeline produced (across restarts)
    private var echoLine: [[Int16]] = []  // rendered output frames waiting to leak into the mic
    private var recorded: [Int16] = []
    private var ticksSinceWrite = 0
    private var ticksSinceLevels = 0
    private var sampleCompletions: [() -> Void] = []
    // Mic queue (SOTTO_APP_MIC_QUEUE_DIR) and output speech tracking, queue-confined.
    private var pendingClips: [(name: String, pcm: [Int16])] = []
    private var clip: (name: String, pcm: [Int16], pos: Int)?
    private var ticksSincePoll = 0
    private var outSpeaking = false
    private var outQuietTicks = 0
    private var outFrames = 0
    private var outMaxBufferMs = 0.0
    private let scratch = UnsafeMutablePointer<Float>.allocate(capacity: Framer.frameSamples)
    private let lock = NSLock()   // guards `running` for callers on other threads
    private var running = false

    public init(options: Options) {
        self.options = options
        scratch.initialize(repeating: 0, count: Framer.frameSamples)
        emitter.onSilence = { [weak self] s in DispatchQueue.main.async { self?.onMicSilence?(s) } }
        recorded.reserveCapacity(24_000 * 60)
    }

    public convenience init(env: [String: String] = ProcessInfo.processInfo.environment) {
        self.init(options: Options(env: env))
    }

    deinit { timer?.cancel(); scratch.deallocate() }

    // MARK: lifecycle

    public func start(listenOnly: Bool) throws {
        lock.lock()
        let was = running
        running = true
        lock.unlock()
        let r = AudioRouteInfo(mode: .fake, input: FakeAudioIO.fakeInput, output: FakeAudioIO.fakeOutput, echoCancellation: false, reason: listenOnly ? "test_listen" : "test")
        let changed = r != route
        route = r
        if changed { onRoute?(r) }
        if was { return }
        queue.sync {
            startedNs = hostNowNs()
            ticksSinceStart = 0
        }
        let t = DispatchSource.makeTimerSource(flags: .strict, queue: queue)
        t.schedule(deadline: .now(), repeating: .milliseconds(20), leeway: .milliseconds(1))
        t.setEventHandler { [weak self] in self?.catchUp() }
        timer = t
        t.resume()
    }

    public func stop() {
        lock.lock()
        let was = running
        running = false
        lock.unlock()
        guard was else { return }
        timer?.cancel()
        timer = nil
        route = nil
        queue.sync { writeOutput() }
    }

    /// Emits every 20 ms tick that is due since start (so timer jitter never changes the rate).
    private func catchUp() {
        let due = Int64((hostNowNs() - startedNs) / 20_000_000) + 1
        while ticksSinceStart < due {
            tick(hostNs: startedNs &+ UInt64(ticksSinceStart) * 20_000_000)
            ticksSinceStart += 1
        }
    }

    /// One 20 ms step: render one output frame, then produce one input frame. Queue-confined
    /// (tests call it directly on an unstarted instance).
    func tick(hostNs: UInt64) {
        let n = Framer.frameSamples
        pipeline.render(scratch, count: n, hostNs: hostNs)
        var outFrame = [Int16](repeating: 0, count: n)
        for k in 0..<n { outFrame[k] = floatToInt16(scratch[k]) }
        recorded.append(contentsOf: outFrame)

        var input = [Int16](repeating: 0, count: n)
        let lead = options.leadMs * 24
        for k in 0..<n {
            let pos = inputPos + k
            if let fx = options.fixture {
                let i = pos - lead
                if i >= 0, i < fx.count { input[k] = fx[i] }
            } else if options.micQueueDir != nil {
                // Queue mode: silence between clips.
            } else {
                input[k] = Int16(600 * sin(2 * Double.pi * 440 * Double(pos) / 24_000))
            }
        }
        let pos0 = inputPos
        inputPos += n
        mixClip(into: &input)
        trackOutput(outFrame)
        if let g = options.echoGain {
            echoLine.append(outFrame)
            if echoLine.count > 2 {  // 2 frames = 40 ms
                let e = echoLine.removeFirst()
                for k in 0..<n { input[k] = Int16(max(-32768, min(32767, (Float(input[k]) + g * Float(e[k])).rounded()))) }
            }
        }
        // A 1 LSB noise floor (-90 dBFS) like a real mic: exact zeros mean a dead
        // capture (SilenceDetector, SPEC §6.16 "Silent mic"), which the daemon answers
        // by moving the voice.
        if options.noiseFloor { for k in 0..<n where input[k] == 0 { input[k] = (pos0 + k) & 1 == 0 ? 1 : -1 } }
        emitter.emit(input, hostNs: hostNs)

        ticksSinceWrite += 1
        if ticksSinceWrite >= 50 { writeOutput() }
        ticksSinceLevels += 1
        if ticksSinceLevels >= 2 {
            ticksSinceLevels = 0
            let mic = emitter.micLevel, spk = pipeline.speakerLevel
            if let cb = onLevels { DispatchQueue.main.async { cb(mic, spk) } }
        }
        if !sampleCompletions.isEmpty, pipeline.samples.isEmpty {
            let cbs = sampleCompletions
            sampleCompletions.removeAll()
            DispatchQueue.main.async { cbs.forEach { $0() } }
        }
    }

    /// Queue mode: take new clips (every 100 ms) and mix the current one into this input frame.
    private func mixClip(into input: inout [Int16]) {
        guard let dir = options.micQueueDir else { return }
        ticksSincePoll += 1
        if ticksSincePoll >= 5 {
            ticksSincePoll = 0
            let fm = FileManager.default
            let names = ((try? fm.contentsOfDirectory(atPath: dir.path)) ?? []).filter { $0.hasSuffix(".wav") }.sorted()
            for name in names {
                let url = dir.appendingPathComponent(name)
                let taken = dir.appendingPathComponent(name + ".taken")
                guard (try? fm.moveItem(at: url, to: taken)) != nil,
                      let d = try? Data(contentsOf: taken), let pcm = try? WAV.decode24k(d) else { continue }
                pendingClips.append((name, pcm))
            }
        }
        if clip == nil, !pendingClips.isEmpty {
            let c = pendingClips.removeFirst()
            clip = (c.name, c.pcm, 0)
            onTestEvent?("mic_clip", ["name": c.name, "phase": "start", "ms": c.pcm.count / 24])
        }
        guard var c = clip else { return }
        let n = input.count
        for k in 0..<n where c.pos + k < c.pcm.count {
            input[k] = Int16(max(-32768, min(32767, Int(input[k]) + Int(c.pcm[c.pos + k]))))
        }
        c.pos += n
        if c.pos >= c.pcm.count {
            clip = nil
            onTestEvent?("mic_clip", ["name": c.name, "phase": "end"])
        } else {
            clip = c
        }
    }

    /// Output speech start/end (peak hysteresis, 300 ms of quiet ends it) with the deepest buffer seen.
    private func trackOutput(_ frame: [Int16]) {
        guard onTestEvent != nil else { return }
        var peak = 0
        for v in frame { peak = max(peak, abs(Int(v))) }
        let buffered = pipeline.playout.bufferedMs
        if peak >= 800 {
            outQuietTicks = 0
            if !outSpeaking {
                outSpeaking = true
                outFrames = 0
                outMaxBufferMs = 0
                onTestEvent?("out_speech", ["phase": "start", "buffer_ms": buffered])
            }
        } else if outSpeaking {
            outQuietTicks += 1
            if outQuietTicks >= 15 {
                outSpeaking = false
                onTestEvent?("out_speech", ["phase": "end", "frames": outFrames - 15, "max_buffer_ms": outMaxBufferMs,
                                            "underruns": pipeline.playout.underruns, "overruns": pipeline.playout.overruns])
            }
        }
        if outSpeaking {
            outFrames += 1
            outMaxBufferMs = max(outMaxBufferMs, buffered)
        }
    }

    func writeOutput() {
        ticksSinceWrite = 0
        guard let url = options.outWav else { return }
        try? WAV.encodePCM16(recorded).write(to: url, options: .atomic)
    }

    /// Everything rendered so far (24 kHz mono), for tests.
    var recordedOutput: [Int16] { queue.sync { recorded } }

    // MARK: playout

    public func enqueuePlayback(_ pcm: Data, seq: UInt32, afterFlush: Bool) {
        pipeline.playout.push(pcm, seq: seq, afterFlush: afterFlush)
    }

    public func flushPlayback() {
        let buffered = pipeline.playout.bufferedMs
        pipeline.playout.flush()
        if let cb = onTestEvent { queue.async { cb("playout_flush", ["buffer_ms": buffered]) } }
    }

    public func playSample(_ wav: Data, completion: @escaping () -> Void) {
        guard let pcm = try? WAV.decode24k(wav), !pcm.isEmpty else { completion(); return }
        queue.async {
            self.pipeline.samples.write(pcm)
            self.sampleCompletions.append(completion)
        }
    }

    public func stopSample() {
        queue.async { self.pipeline.samples.reset() }
    }

    public func stats() -> PlayoutStats {
        let p = pipeline.playout
        return PlayoutStats(playoutSeq: p.playoutSeq, playoutHostNs: p.playoutHostNs, bufferMs: p.bufferedMs,
                            underruns: p.underruns, overruns: p.overruns, captureDrops: 0)
    }

    /// Mic frames emitted so far.
    public var micFrameCount: Int { emitter.frameCount }

    public func inputDevices() -> [AudioDevice] { [FakeAudioIO.fakeInput] }
    public func outputDevices() -> [AudioDevice] { [FakeAudioIO.fakeOutput] }
    public func setPreferredDevices(input: String?, output: String?) {}
}
