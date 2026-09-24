// The CoreAudio engines behind RealAudioIO (NATIVE.md §5.3):
//   HALInput  plain AUHAL input-only unit bound to one device (split, listen). No VPIO,
//             no default-device aggregate, so AirPods never switch to the hands-free profile.
//   HALOutput plain AUHAL output-only unit bound to one device (split, sample previews).
//   VPIOEngine AVAudioEngine with voice processing (vpio): Apple's AEC for speakers.
// Nothing here is created in --test (FakeAudioIO), and nothing touches AVAudioEngine.inputNode
// outside VPIOEngine.
import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

private func check(_ s: OSStatus, _ what: String) throws {
    if s != noErr { throw AudioIOError.engine("\(what) failed (\(s))") }
}

private func makeHAL() throws -> AudioUnit {
    var desc = AudioComponentDescription(componentType: kAudioUnitType_Output, componentSubType: kAudioUnitSubType_HALOutput,
                                         componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
    guard let comp = AudioComponentFindNext(nil, &desc) else { throw AudioIOError.engine("no AUHAL") }
    var u: AudioUnit?
    try check(AudioComponentInstanceNew(comp, &u), "AUHAL instance")
    guard let au = u else { throw AudioIOError.engine("no AUHAL unit") }
    return au
}

private func dispose(_ au: AudioUnit) {
    AudioOutputUnitStop(au)
    AudioUnitUninitialize(au)
    AudioComponentInstanceDispose(au)
}

private func monoFloat(_ rate: Double) -> AudioStreamBasicDescription {
    AudioStreamBasicDescription(mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
                                mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved,
                                mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
}

// MARK: - HAL input

final class HALInput {
    let deviceID: AudioDeviceID
    private(set) var rate: Double = 48_000
    private var unit: AudioUnit?
    private(set) var ring: CaptureRing?
    fileprivate let renderBuf: UnsafeMutablePointer<Float>
    fileprivate let renderCap = 16_384

    init(deviceID: AudioDeviceID) {
        self.deviceID = deviceID
        renderBuf = .allocate(capacity: renderCap)
        renderBuf.initialize(repeating: 0, count: renderCap)
    }
    deinit { stop(); renderBuf.deallocate() }

    /// Builds the unit and returns the capture rate; `start(ring:)` then runs it.
    func prepare() throws -> Double {
        let au = try makeHAL()
        unit = au
        var one: UInt32 = 1, zero: UInt32 = 0
        try check(AudioUnitSetProperty(au, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &one, 4), "enable input")
        try check(AudioUnitSetProperty(au, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &zero, 4), "disable output")
        var dev = deviceID
        try check(AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, UInt32(MemoryLayout<AudioDeviceID>.size)), "bind input device")
        var hw = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try check(AudioUnitGetProperty(au, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 1, &hw, &size), "input hw format")
        rate = hw.mSampleRate > 0 ? hw.mSampleRate : 48_000
        // AUHAL converts format and channel count (first channel) on input, not the rate.
        var client = monoFloat(rate)
        try check(AudioUnitSetProperty(au, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &client, size), "input client format")
        var cb = AURenderCallbackStruct(inputProc: halInputProc, inputProcRefCon: Unmanaged.passUnretained(self).toOpaque())
        try check(AudioUnitSetProperty(au, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, &cb, UInt32(MemoryLayout<AURenderCallbackStruct>.size)), "input callback")
        try check(AudioUnitInitialize(au), "input initialize")
        return rate
    }

    func start(ring: CaptureRing) throws {
        self.ring = ring
        guard let au = unit else { throw AudioIOError.engine("input not prepared") }
        try check(AudioOutputUnitStart(au), "input start")
    }

    func stop() {
        if let au = unit { dispose(au) }
        unit = nil
    }

    fileprivate func render(_ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>, _ ts: UnsafePointer<AudioTimeStamp>, _ frames: UInt32) -> OSStatus {
        guard let au = unit, let ring = ring, Int(frames) <= renderCap else { return noErr }
        var abl = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: frames * 4, mData: UnsafeMutableRawPointer(renderBuf)))
        let err = AudioUnitRender(au, flags, ts, 1, frames, &abl)
        guard err == noErr else { return err }
        let host = ts.pointee.mFlags.contains(.hostTimeValid) ? hostTicksToNs(ts.pointee.mHostTime) : 0
        ring.write(renderBuf, count: Int(frames), hostNs: host)
        return noErr
    }
}

private func halInputProc(_ ref: UnsafeMutableRawPointer, _ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>, _ ts: UnsafePointer<AudioTimeStamp>,
                          _ bus: UInt32, _ frames: UInt32, _ data: UnsafeMutablePointer<AudioBufferList>?) -> OSStatus {
    Unmanaged<HALInput>.fromOpaque(ref).takeUnretainedValue().render(flags, ts, frames)
}

// MARK: - HAL output

final class HALOutput {
    let deviceID: AudioDeviceID?
    fileprivate let pipeline: OutputPipeline
    private var unit: AudioUnit?

    init(deviceID: AudioDeviceID?, pipeline: OutputPipeline) {
        self.deviceID = deviceID
        self.pipeline = pipeline
    }
    deinit { stop() }

    func start() throws {
        let au = try makeHAL()
        unit = au
        var one: UInt32 = 1, zero: UInt32 = 0
        try check(AudioUnitSetProperty(au, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &one, 4), "enable output")
        try check(AudioUnitSetProperty(au, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &zero, 4), "disable input")
        if var dev = deviceID {
            try check(AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, UInt32(MemoryLayout<AudioDeviceID>.size)), "bind output device")
        }
        // The output side of AUHAL resamples: the client renders 24 kHz mono float.
        var client = monoFloat(Double(JitterPlayout.sampleRate))
        try check(AudioUnitSetProperty(au, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &client, UInt32(MemoryLayout<AudioStreamBasicDescription>.size)), "output client format")
        var cb = AURenderCallbackStruct(inputProc: halOutputProc, inputProcRefCon: Unmanaged.passUnretained(self).toOpaque())
        try check(AudioUnitSetProperty(au, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &cb, UInt32(MemoryLayout<AURenderCallbackStruct>.size)), "output callback")
        try check(AudioUnitInitialize(au), "output initialize")
        try check(AudioOutputUnitStart(au), "output start")
    }

    func stop() {
        if let au = unit { dispose(au) }
        unit = nil
    }
}

private func halOutputProc(_ ref: UnsafeMutableRawPointer, _ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>, _ ts: UnsafePointer<AudioTimeStamp>,
                           _ bus: UInt32, _ frames: UInt32, _ data: UnsafeMutablePointer<AudioBufferList>?) -> OSStatus {
    let out = Unmanaged<HALOutput>.fromOpaque(ref).takeUnretainedValue()
    guard let abl = UnsafeMutableAudioBufferListPointer(data), let first = abl.first, let p = first.mData?.assumingMemoryBound(to: Float.self) else { return noErr }
    let host = ts.pointee.mFlags.contains(.hostTimeValid) ? hostTicksToNs(ts.pointee.mHostTime) : hostNowNs()
    out.pipeline.render(p, count: Int(frames), hostNs: host)
    return noErr
}

// MARK: - VPIO (AVAudioEngine with voice processing)

final class VPIOEngine {
    private let engine = AVAudioEngine()
    private var sink: AVAudioSinkNode?
    private var source: AVAudioSourceNode?
    private(set) var ring: CaptureRing?
    /// Non-fatal binding problems (e.g. a non-default output that would not bind), for the route log.
    private(set) var warnings: [String] = []
    var onConfigurationChange: (() -> Void)?
    private var observer: NSObjectProtocol?

    /// Enables voice processing, **then** binds the devices (NATIVE.md §5.3), wires
    /// input -> sink (capture ring) and source (playout) -> mixer -> output.
    func start(inputID: AudioDeviceID?, outputID: AudioDeviceID?, pipeline: OutputPipeline, emitterRing: (Double) -> CaptureRing) throws {
        let input = engine.inputNode
        do { try input.setVoiceProcessingEnabled(true) } catch { throw AudioIOError.engine("voice processing: \(error.localizedDescription)") }
        input.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
        if let id = inputID, id != CoreAudioDevices.defaultID(input: true) {
            do { try input.auAudioUnit.setDeviceID(id) } catch { warnings.append("input_bind_failed") }
        }
        if let id = outputID, id != CoreAudioDevices.defaultID(input: false) {
            // TODO(open issue): fall back to a raw kAudioUnitSubType_VoiceProcessingIO when this fails.
            do { try engine.outputNode.auAudioUnit.setDeviceID(id) } catch { warnings.append("output_bind_failed") }
        }
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0 else { throw AudioIOError.noInputDevice }
        let ring = emitterRing(inFormat.sampleRate)
        self.ring = ring
        let sink = AVAudioSinkNode { ts, frames, abl -> OSStatus in
            let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: abl))
            guard let b = list.first, let p = b.mData?.assumingMemoryBound(to: Float.self) else { return noErr }
            // Voice processing may report several channels; channel 0 is the processed mic.
            let stride = list.count == 1 ? max(1, Int(b.mNumberChannels)) : 1
            let host = ts.pointee.mFlags.contains(.hostTimeValid) ? hostTicksToNs(ts.pointee.mHostTime) : 0
            ring.write(p, count: Int(frames), stride: stride, hostNs: host)
            return noErr
        }
        let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(JitterPlayout.sampleRate), channels: 1, interleaved: false)!
        let source = AVAudioSourceNode(format: outFormat) { _, ts, frames, abl -> OSStatus in
            let list = UnsafeMutableAudioBufferListPointer(abl)
            guard let b = list.first, let p = b.mData?.assumingMemoryBound(to: Float.self) else { return noErr }
            let host = ts.pointee.mFlags.contains(.hostTimeValid) ? hostTicksToNs(ts.pointee.mHostTime) : hostNowNs()
            pipeline.render(p, count: Int(frames), hostNs: host)
            return noErr
        }
        engine.attach(sink)
        engine.attach(source)
        engine.connect(input, to: sink, format: inFormat)
        engine.connect(source, to: engine.mainMixerNode, format: outFormat)
        self.sink = sink
        self.source = source
        observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            self?.onConfigurationChange?()
        }
        engine.prepare()
        do { try engine.start() } catch { throw AudioIOError.engine("engine start: \(error.localizedDescription)") }
    }

    deinit { stop() }

    func stop() {
        if let o = observer { NotificationCenter.default.removeObserver(o) }
        observer = nil
        engine.stop()
        if let s = sink { engine.detach(s) }
        if let s = source { engine.detach(s) }
        sink = nil
        source = nil
    }
}
