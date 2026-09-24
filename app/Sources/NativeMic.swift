// Native microphone capture for the voice page (SPEC §6.16, "native mic").
//
// Why: WebKit captures through Apple's voice-processing unit (VPIO), which
// opens the *system default input* even when the page asks for another device.
// With AirPods as the default input they drop to the Bluetooth hands-free
// profile (48 -> 24 kHz) for the whole session, and VPIO ducks other audio by
// about 15 dB. There is no WebKit API to steer or configure that unit.
//
// So when the output is headphones (no echo path, so no echo cancellation is
// needed) the app captures the chosen input itself with a plain AUHAL input
// unit bound to that one device (the built-in mic when the default input is
// Bluetooth): no VPIO, no default-device aggregate, no hands-free switch, no
// ducking. The samples go to the page (app/Resources/mic.js), which turns them
// into a MediaStreamTrack through an AudioWorklet. On speakers the page keeps
// WebKit's own capture, so Apple's echo cancellation still applies.
import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

// MARK: - devices

struct InputDevice {
    var id: AudioDeviceID
    var uid: String
    var name: String
    var transport: UInt32
    var bluetooth: Bool { transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE }
    var builtIn: Bool { transport == kAudioDeviceTransportTypeBuiltIn }
    var virtual: Bool { transport == kAudioDeviceTransportTypeVirtual || transport == kAudioDeviceTransportTypeAggregate }
    /// Stable, opaque id for the page (never the raw CoreAudio UID).
    var pageId: String { "sotto-" + fnv1a(uid) }

    var pageDictionary: [String: Any] { ["id": pageId, "label": name, "bluetooth": bluetooth] }
}

struct OutputInfo {
    var name: String
    var bluetooth: Bool
    /// Headphone-class output: Bluetooth, or the built-in jack with headphones in.
    /// Unknown kinds (USB, HDMI, AirPlay) count as speakers, so they keep AEC.
    var headphones: Bool
}

func fnv1a(_ s: String) -> String {
    var h: UInt64 = 0xcbf29ce484222325
    for b in s.utf8 { h ^= UInt64(b); h = h &* 0x100000001b3 }
    return String(h, radix: 16)
}

enum Devices {
    static func all() -> [AudioDeviceID] {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    static func defaultDevice(input: Bool) -> AudioDeviceID? {
        var addr = AudioObjectPropertyAddress(mSelector: input ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice,
                                              mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let err = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
        return err == noErr && id != 0 ? id : nil
    }

    static func string(_ d: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
        var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(d, &addr, 0, nil, &size, &value) == noErr, let v = value else { return nil }
        return v.takeRetainedValue() as String
    }

    static func u32(_ d: AudioObjectID, _ sel: AudioObjectPropertySelector, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> UInt32? {
        var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
        var v: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(d, &addr, 0, nil, &size, &v) == noErr ? v : nil
    }

    static func inputChannels(_ d: AudioObjectID) -> Int {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(d, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(d, &addr, 0, nil, &size, raw) == noErr else { return 0 }
        let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    /// Capture devices, minus the private aggregates that voice processing
    /// and AVAudioEngine create on the fly.
    static func inputs() -> [InputDevice] {
        all().compactMap { id in
            guard inputChannels(id) > 0, let name = string(id, kAudioObjectPropertyName) else { return nil }
            if name.hasPrefix("CADefaultDeviceAggregate") || name.hasPrefix("VPAUAggregateAudioDevice") { return nil }
            return InputDevice(id: id, uid: string(id, kAudioDevicePropertyDeviceUID) ?? name, name: name,
                               transport: u32(id, kAudioDevicePropertyTransportType) ?? 0)
        }
    }

    static func output() -> OutputInfo? {
        guard let id = defaultDevice(input: false) else { return nil }
        let transport = u32(id, kAudioDevicePropertyTransportType) ?? 0
        let bt = transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE
        // 'hdpn': the built-in output's data source when headphones are plugged in.
        let jack = transport == kAudioDeviceTransportTypeBuiltIn
            && u32(id, kAudioDevicePropertyDataSource, scope: kAudioObjectPropertyScopeOutput) == 0x6864_706E
        return OutputInfo(name: string(id, kAudioObjectPropertyName) ?? "", bluetooth: bt, headphones: bt || jack)
    }
}

// MARK: - plan

/// Which capture path a getUserMedia call gets. Pure, so `Sotto --mic-plan-eval`
/// can test it with made-up routes.
struct MicPlan {
    enum Mode: String { case native, webkit }
    var mode: Mode
    var device: InputDevice?
    var reason: String

    var dictionary: [String: Any] {
        var d: [String: Any] = ["mode": mode.rawValue, "reason": reason]
        if let dev = device { d["device"] = dev.pageDictionary }
        return d
    }

    /// pref: "auto" | "native" | "webkit". requested: a page id, "default" or nil.
    /// Returns nil when a specific requested device does not exist (the page
    /// then retries without a device, as it does for WebKit's NotFoundError).
    static func decide(pref: String, output: OutputInfo?, inputs: [InputDevice], defaultInput: AudioDeviceID?, requested: String?) -> MicPlan? {
        var device: InputDevice?
        if let r = requested, !r.isEmpty, r != "default" {
            guard let d = inputs.first(where: { $0.pageId == r }) else { return nil }
            device = d
        } else {
            device = autoDevice(inputs: inputs, defaultInput: defaultInput)
        }
        switch pref {
        case "webkit": return MicPlan(mode: .webkit, device: device, reason: "pref_webkit")
        case "native": return device == nil ? MicPlan(mode: .webkit, device: nil, reason: "no_input") : MicPlan(mode: .native, device: device, reason: "pref_native")
        default:
            // Headphones: no echo path, so skip voice processing (and with it
            // the hands-free switch and the ducking). Speakers: WebKit's
            // capture, i.e. Apple's echo cancellation.
            if output?.headphones == true, let d = device { return MicPlan(mode: .native, device: d, reason: "headphones") }
            return MicPlan(mode: .webkit, device: device, reason: output == nil ? "no_output" : "speakers")
        }
    }

    /// The default input, unless it is Bluetooth: then the built-in mic (the
    /// same rule as the page's lib.pickInputDevice, SPEC §7.5 "Default mic").
    static func autoDevice(inputs: [InputDevice], defaultInput: AudioDeviceID?) -> InputDevice? {
        let def = inputs.first(where: { $0.id == defaultInput }) ?? inputs.first(where: { !$0.virtual })
        guard let d = def else { return nil }
        if d.bluetooth, let alt = inputs.first(where: { $0.builtIn && !$0.bluetooth }) ?? inputs.first(where: { !$0.bluetooth && !$0.virtual }) {
            return alt
        }
        return d
    }

    /// For `--mic-plan-eval '<json>'` (tests): {pref, output:{bluetooth,headphones},
    /// inputs:[{name,transport:"bluetooth"|"builtin"|"usb"|"virtual"}], default:<index>, requested:<name>}
    static func evaluate(json: String) -> String {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return "{\"error\":\"bad json\"}" }
        let kinds: [String: UInt32] = ["bluetooth": kAudioDeviceTransportTypeBluetooth, "builtin": kAudioDeviceTransportTypeBuiltIn,
                                       "usb": kAudioDeviceTransportTypeUSB, "virtual": kAudioDeviceTransportTypeVirtual]
        let raw = obj["inputs"] as? [[String: Any]] ?? []
        let inputs = raw.enumerated().map { i, d in
            InputDevice(id: AudioDeviceID(i + 1), uid: d["name"] as? String ?? "\(i)", name: d["name"] as? String ?? "",
                        transport: kinds[d["transport"] as? String ?? ""] ?? 0)
        }
        let output = (obj["output"] as? [String: Any]).map {
            OutputInfo(name: "", bluetooth: $0["bluetooth"] as? Bool ?? false, headphones: $0["headphones"] as? Bool ?? false)
        }
        let def = (obj["default"] as? Int).map { AudioDeviceID($0 + 1) }
        let requested = (obj["requested"] as? String).flatMap { name in inputs.first(where: { $0.name == name })?.pageId ?? name }
        guard let plan = decide(pref: obj["pref"] as? String ?? "auto", output: output, inputs: inputs, defaultInput: def, requested: requested) else {
            return "{\"error\":\"NotFoundError\"}"
        }
        var d: [String: Any] = ["mode": plan.mode.rawValue, "reason": plan.reason]
        if let dev = plan.device { d["device"] = dev.name }
        return jsonString(d)
    }
}

func jsonString(_ obj: Any) -> String {
    guard let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), let s = String(data: d, encoding: .utf8) else { return "{}" }
    return s
}

// MARK: - capture sources

/// Delivers 48 kHz mono Int16 chunks (about 10 ms each) with the wall-clock
/// time, in ms, of the newest sample in the chunk.
protocol MicSource: AnyObject {
    var label: String { get }
    func start(_ onChunk: @escaping (Data, Double) -> Void) throws
    func stop()
}

let micRate: Double = 48_000

/// Sample FIFO shared by the real-time thread (writer) and the drain timer.
final class SampleFifo {
    private var buf: [Int16]
    private var count = 0
    private var lastWallMs: Double = 0
    private var lock = os_unfair_lock()
    init(capacity: Int) { buf = [Int16](repeating: 0, count: capacity) }

    func write(_ p: UnsafePointer<Int16>, _ n: Int, wallMs: Double) {
        os_unfair_lock_lock(&lock)
        if count + n > buf.count { count = 0 } // drain stalled: drop the backlog, keep latency low
        let m = min(n, buf.count)
        buf.withUnsafeMutableBufferPointer { b in (b.baseAddress! + count).update(from: p, count: m) }
        count += m
        lastWallMs = wallMs
        os_unfair_lock_unlock(&lock)
    }

    func drain() -> (Data, Double)? {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        guard count > 0 else { return nil }
        let d = buf.withUnsafeBufferPointer { Data(buffer: UnsafeBufferPointer(start: $0.baseAddress, count: count)) }
        count = 0
        return (d, lastWallMs)
    }
}

func wallMs() -> Double { Date().timeIntervalSince1970 * 1000 }

/// A plain AUHAL input unit on one device: input enabled, output disabled.
/// Unlike VPIO it opens exactly that device and nothing else.
final class HALMicSource: MicSource {
    let device: InputDevice
    var label: String { device.name }
    private var unit: AudioUnit?
    private var deviceRate: Double = 48_000
    private let fifo = SampleFifo(capacity: 48_000)
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "sotto.mic.drain", qos: .userInteractive)
    fileprivate var renderBuf = [Float](repeating: 0, count: 8192)
    fileprivate var converter: AVAudioConverter?
    fileprivate var inFormat: AVAudioFormat?
    fileprivate var outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: micRate, channels: 1, interleaved: true)!
    fileprivate var int16Buf = [Int16](repeating: 0, count: 8192)

    init(device: InputDevice) { self.device = device }

    func start(_ onChunk: @escaping (Data, Double) -> Void) throws {
        var desc = AudioComponentDescription(componentType: kAudioUnitType_Output, componentSubType: kAudioUnitSubType_HALOutput,
                                             componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
        guard let comp = AudioComponentFindNext(nil, &desc) else { throw micError("no AUHAL") }
        var u: AudioUnit?
        try check(AudioComponentInstanceNew(comp, &u), "instance")
        guard let au = u else { throw micError("no unit") }
        unit = au
        var one: UInt32 = 1, zero: UInt32 = 0
        try check(AudioUnitSetProperty(au, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &one, 4), "enable input")
        try check(AudioUnitSetProperty(au, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &zero, 4), "disable output")
        var dev = device.id
        try check(AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, UInt32(MemoryLayout<AudioDeviceID>.size)), "device")
        var hw = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try check(AudioUnitGetProperty(au, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 1, &hw, &size), "hw format")
        deviceRate = hw.mSampleRate > 0 ? hw.mSampleRate : 48_000
        // AUHAL converts format and channels (first channel) but not the rate.
        var client = AudioStreamBasicDescription(mSampleRate: deviceRate, mFormatID: kAudioFormatLinearPCM,
                                                 mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved,
                                                 mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
        try check(AudioUnitSetProperty(au, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &client, size), "client format")
        inFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: deviceRate, channels: 1, interleaved: false)
        if deviceRate != micRate, let inF = inFormat { converter = AVAudioConverter(from: inF, to: outFormat) }
        var cb = AURenderCallbackStruct(inputProc: halInputProc, inputProcRefCon: Unmanaged.passUnretained(self).toOpaque())
        try check(AudioUnitSetProperty(au, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, &cb, UInt32(MemoryLayout<AURenderCallbackStruct>.size)), "callback")
        try check(AudioUnitInitialize(au), "initialize")
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + .milliseconds(10), repeating: .milliseconds(10), leeway: .milliseconds(1))
        t.setEventHandler { [fifo] in if let (d, w) = fifo.drain() { onChunk(d, w) } }
        timer = t
        t.resume()
        try check(AudioOutputUnitStart(au), "start")
    }

    func stop() {
        timer?.cancel()
        timer = nil
        if let au = unit {
            AudioOutputUnitStop(au)
            AudioUnitUninitialize(au)
            AudioComponentInstanceDispose(au)
        }
        unit = nil
    }

    /// Real-time thread: render, convert to 48 kHz Int16, push to the FIFO.
    fileprivate func render(_ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>, _ ts: UnsafePointer<AudioTimeStamp>, _ frames: UInt32) -> OSStatus {
        guard let au = unit, Int(frames) <= renderBuf.count else { return noErr }
        let wall = wallMs()
        return renderBuf.withUnsafeMutableBufferPointer { rb -> OSStatus in
            var abl = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: frames * 4, mData: UnsafeMutableRawPointer(rb.baseAddress)))
            let err = AudioUnitRender(au, flags, ts, 1, frames, &abl)
            guard err == noErr else { return err }
            if let conv = converter, let inF = inFormat {
                guard let inBuf = AVAudioPCMBuffer(pcmFormat: inF, frameCapacity: frames),
                      let outBuf = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: AVAudioFrameCount(Double(frames) * micRate / deviceRate) + 16) else { return noErr }
                inBuf.frameLength = frames
                inBuf.floatChannelData![0].update(from: rb.baseAddress!, count: Int(frames))
                var fed = false
                conv.convert(to: outBuf, error: nil) { _, status in
                    if fed { status.pointee = .noDataNow; return nil }
                    fed = true
                    status.pointee = .haveData
                    return inBuf
                }
                if outBuf.frameLength > 0 { fifo.write(outBuf.int16ChannelData![0], Int(outBuf.frameLength), wallMs: wall) }
            } else {
                let n = Int(frames)
                int16Buf.withUnsafeMutableBufferPointer { ib in
                    for i in 0..<n { ib[i] = Int16(max(-1, min(1, rb[i])) * 32767) }
                    fifo.write(ib.baseAddress!, n, wallMs: wall)
                }
            }
            return noErr
        }
    }

    private func check(_ s: OSStatus, _ what: String) throws {
        if s != noErr { throw micError("\(what) failed (\(s))") }
    }
}

private func halInputProc(_ ref: UnsafeMutableRawPointer, _ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>, _ ts: UnsafePointer<AudioTimeStamp>,
                          _ bus: UInt32, _ frames: UInt32, _ data: UnsafeMutablePointer<AudioBufferList>?) -> OSStatus {
    Unmanaged<HALMicSource>.fromOpaque(ref).takeUnretainedValue().render(flags, ts, frames)
}

func micError(_ s: String) -> NSError { NSError(domain: "SottoMic", code: 1, userInfo: [NSLocalizedDescriptionKey: s]) }

/// Test source: a 16-bit mono WAV (the TTS fixture) played in real time after
/// `leadMs` of silence, then silence; or a quiet 440 Hz tone without a file.
/// Test mode never opens a real microphone natively.
final class FixtureMicSource: MicSource {
    let label: String
    private var samples: [Int16] = []
    private var pos = 0
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "sotto.mic.fixture", qos: .userInteractive)
    private var started: Double = 0
    private var sent = 0
    private let leadFrames: Int
    private let tone: Bool

    init(path: String?, leadMs: Int) {
        leadFrames = Int(micRate) * leadMs / 1000
        if let p = path, let s = FixtureMicSource.load(p) {
            samples = s
            tone = false
            label = "Test fixture"
        } else {
            tone = true
            label = "Test tone"
        }
    }

    /// Minimal WAV reader: PCM16 mono, any rate (resampled linearly to 48 kHz).
    static func load(_ path: String) -> [Int16]? {
        guard let d = try? Data(contentsOf: URL(fileURLWithPath: path)), d.count > 44 else { return nil }
        func u32(_ o: Int) -> UInt32 { d.subdata(in: o..<o + 4).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) } }
        func u16(_ o: Int) -> UInt16 { d.subdata(in: o..<o + 2).withUnsafeBytes { $0.loadUnaligned(as: UInt16.self) } }
        var o = 12
        var rate = 24_000.0
        var pcm: Data?
        while o + 8 <= d.count {
            let id = String(data: d.subdata(in: o..<o + 4), encoding: .ascii) ?? ""
            let len = Int(u32(o + 4))
            if id == "fmt " { guard u16(o + 8) == 1, u16(o + 10) == 1, u16(o + 22) == 16 else { return nil }; rate = Double(u32(o + 12)) }
            if id == "data" { pcm = d.subdata(in: o + 8..<min(d.count, o + 8 + len)) }
            o += 8 + len + (len & 1)
        }
        guard let p = pcm else { return nil }
        let src = p.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        let n = Int(Double(src.count) * micRate / rate)
        return (0..<n).map { i in
            let x = Double(i) * rate / micRate
            let a = Int(x), f = x - Double(a)
            let s0 = Double(src[min(a, src.count - 1)]), s1 = Double(src[min(a + 1, src.count - 1)])
            return Int16(s0 + (s1 - s0) * f)
        }
    }

    func start(_ onChunk: @escaping (Data, Double) -> Void) throws {
        started = wallMs()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + .milliseconds(10), repeating: .milliseconds(10), leeway: .milliseconds(1))
        t.setEventHandler { [weak self] in
            guard let self = self else { return }
            let now = wallMs()
            let due = Int((now - self.started) * micRate / 1000)
            let n = due - self.sent
            guard n > 0 else { return }
            var out = [Int16](repeating: 0, count: n)
            for i in 0..<n {
                let k = self.sent + i
                if self.tone { out[i] = Int16(3000 * sin(2 * Double.pi * 440 * Double(k) / micRate)) }
                else if k >= self.leadFrames, k - self.leadFrames < self.samples.count { out[i] = self.samples[k - self.leadFrames] }
            }
            self.sent = due
            onChunk(out.withUnsafeBufferPointer { Data(buffer: $0) }, now)
        }
        timer = t
        t.resume()
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }
}
