// Audio engine surface (docs/NATIVE.md §2, §5). Engines: RealAudioIO (CoreAudio) and FakeAudioIO (--test); see makeAudioIO(test:).
// SottoAudio does not import SottoClient: frames here are plain PCM + timing.
import Foundation

/// 20 ms of PCM16LE mono 24 kHz (960 bytes) with its capture host time.
public struct PCMFrame: Sendable {
    public var samples: Data
    public var hostTimeNs: UInt64
    public var muted: Bool
    public init(samples: Data, hostTimeNs: UInt64, muted: Bool) { self.samples = samples; self.hostTimeNs = hostTimeNs; self.muted = muted }
}

public enum AudioMode: String, Sendable { case vpio, split, listen, fake, off }

/// How a device is attached (CoreAudio transport type). Added by B3 for AudioPlan's rules.
public enum AudioTransport: String, Sendable { case builtIn, bluetooth, usb, hdmi, displayPort, airPlay, thunderbolt, pci, virtual, aggregate, unknown }

public struct AudioDevice: Equatable, Sendable, Identifiable {
    public var id: String       // CoreAudio UID
    public var name: String
    public var bluetooth: Bool
    public var headphones: Bool
    /// Added by B3 (additive): transport, so AudioPlan can prefer built-in and skip virtual devices.
    public var transport: AudioTransport = .unknown
    public init(id: String, name: String, bluetooth: Bool, headphones: Bool) { self.id = id; self.name = name; self.bluetooth = bluetooth; self.headphones = headphones }
    public init(id: String, name: String, bluetooth: Bool, headphones: Bool, transport: AudioTransport) {
        self.id = id; self.name = name; self.bluetooth = bluetooth; self.headphones = headphones; self.transport = transport
    }
}

public struct AudioRouteInfo: Equatable, Sendable {
    public var mode: AudioMode
    public var input: AudioDevice?
    public var output: AudioDevice?
    /// Added by B3 (additive): whether voice processing (AEC) is on, for the `route` message's `echo_cancellation`.
    public var echoCancellation: Bool = false
    /// Added by B3 (additive): why this plan was chosen (e.g. "speakers", "headphones", "pref_always", "sleeping", "test").
    public var reason: String = ""
    public init(mode: AudioMode, input: AudioDevice?, output: AudioDevice?) { self.mode = mode; self.input = input; self.output = output }
    public init(mode: AudioMode, input: AudioDevice?, output: AudioDevice?, echoCancellation: Bool, reason: String) {
        self.mode = mode; self.input = input; self.output = output; self.echoCancellation = echoCancellation; self.reason = reason
    }
}

public struct PlayoutStats: Equatable, Sendable {
    public var playoutSeq: UInt32; public var playoutHostNs: UInt64; public var bufferMs: Double
    public var underruns: Int; public var overruns: Int; public var captureDrops: Int
    public init(playoutSeq: UInt32 = 0, playoutHostNs: UInt64 = 0, bufferMs: Double = 0, underruns: Int = 0, overruns: Int = 0, captureDrops: Int = 0) {
        self.playoutSeq = playoutSeq; self.playoutHostNs = playoutHostNs; self.bufferMs = bufferMs
        self.underruns = underruns; self.overruns = overruns; self.captureDrops = captureDrops
    }
}

public enum EchoCancellation: String, Sendable { case automatic, always, never }

public protocol AudioIO: AnyObject {
    /// Mic frames, 50/s, on a background queue. Zeros (muted=true) while muted.
    var onMicFrame: ((PCMFrame) -> Void)? { get set }
    /// Route changes (device switch, headphones, engine rebuild).
    var onRoute: ((AudioRouteInfo) -> Void)? { get set }
    /// Mic and speaker RMS (0...1) at ~30 Hz, main queue, for the dial.
    var onLevels: ((_ mic: Float, _ speaker: Float) -> Void)? { get set }
    var muted: Bool { get set }
    /// Added by B3 (additive): asynchronous failures after `start` (permission denied after the prompt,
    /// device lost with no replacement, engine error). Main queue. Send as `mic_error {name, message}`.
    var onError: ((AudioIOError) -> Void)? { get set }
    /// Added by B3 (additive): true when the unmuted mic has delivered exact digital silence for 3 s
    /// (a privacy-blocked or dead input), false when real signal returns. Main queue.
    var onMicSilence: ((Bool) -> Void)? { get set }
    /// Added by B3 (additive): the current route, nil while stopped.
    var route: AudioRouteInfo? { get }
    /// Start capture (+ playout unless `listenOnly`). Idempotent.
    func start(listenOnly: Bool) throws
    func stop()
    /// Downlink: one speaker frame (PCM16LE 24 kHz) with its seq; `afterFlush` resets the buffer.
    func enqueuePlayback(_ pcm: Data, seq: UInt32, afterFlush: Bool)
    /// Drop everything queued for playout now (short fade).
    func flushPlayback()
    /// Play a WAV (voice preview / echo test) through the session's output unit.
    func playSample(_ wav: Data, completion: @escaping () -> Void)
    /// Stop any `playSample` audio now (its completion still fires). Leaves the session's
    /// playout alone: a Settings preview stop must not cut the model's live speech.
    func stopSample()
    func stats() -> PlayoutStats
    func inputDevices() -> [AudioDevice]
    func outputDevices() -> [AudioDevice]
    /// nil = automatic choice (docs/NATIVE.md §5 rules).
    func setPreferredDevices(input: String?, output: String?)
    var echoCancellation: EchoCancellation { get set }
}
