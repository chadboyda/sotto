// Shared pieces of SottoAudio: typed errors, mic permission, the host clock,
// the test-process guard, lock-free atomics and the AudioIO factory.
import AVFoundation
import CSottoAtomics
import Foundation

// MARK: - errors

/// Typed audio failures. `name` follows the page's getUserMedia error names, so the
/// daemon's `mic_error` handling (voice.js: /NotAllowed|Permission|Security/ = denied) works unchanged.
public enum AudioIOError: Error, Equatable, Sendable {
    /// The user denied microphone access (System Settings > Privacy > Microphone).
    case micDenied
    /// Access is restricted by policy (MDM, parental controls).
    case micRestricted
    /// No usable input device.
    case noInputDevice
    /// A real engine was asked to start in a `--test` process (never touches hardware).
    case testMode
    /// CoreAudio / AVAudioEngine failure.
    case engine(String)

    public var name: String {
        switch self {
        case .micDenied, .micRestricted: return "NotAllowedError"
        case .noInputDevice: return "NotFoundError"
        case .testMode: return "TestModeError"
        case .engine: return "NotReadableError"
        }
    }

    public var message: String {
        switch self {
        case .micDenied: return "Microphone access is off for Sotto. Turn it on in System Settings > Privacy & Security > Microphone."
        case .micRestricted: return "Microphone access is restricted on this Mac."
        case .noInputDevice: return "No microphone found."
        case .testMode: return "Real audio is disabled in test mode."
        case .engine(let s): return "Audio engine error: \(s)"
        }
    }
}

// MARK: - permission

public enum MicPermission: String, Sendable {
    case authorized, denied, restricted, notDetermined

    public static func current() -> MicPermission {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return .authorized
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        @unknown default: return .denied
        }
    }

    /// Shows the system prompt when undetermined. The callback runs on the main queue.
    public static func request(_ done: @escaping (Bool) -> Void) {
        AVCaptureDevice.requestAccess(for: .audio) { ok in DispatchQueue.main.async { done(ok) } }
    }

    /// nil when capture may start now.
    var error: AudioIOError? {
        switch self {
        case .authorized, .notDetermined: return nil
        case .denied: return .micDenied
        case .restricted: return .micRestricted
        }
    }
}

// MARK: - clock

/// `clock_gettime_nsec_np(CLOCK_UPTIME_RAW)`: the host clock of frame timestamps (NATIVE.md §2.1).
@inline(__always) public func hostNowNs() -> UInt64 { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) }

private let timebase: (numer: UInt64, denom: UInt64) = {
    var tb = mach_timebase_info_data_t()
    mach_timebase_info(&tb)
    return (UInt64(tb.numer), UInt64(max(tb.denom, 1)))
}()

/// mach host ticks (AudioTimeStamp.mHostTime) to ns on the same clock as `hostNowNs`.
@inline(__always) func hostTicksToNs(_ ticks: UInt64) -> UInt64 {
    timebase.numer == timebase.denom ? ticks : ticks &* timebase.numer / timebase.denom
}

// MARK: - test guard

public enum ProcessGuard {
    /// True for `--test` / `--selftest` runs, `SOTTO_APP_TEST=1`, and XCTest hosts. Real engines refuse to start then.
    public static let isTestProcess: Bool = {
        let args = CommandLine.arguments
        let env = ProcessInfo.processInfo.environment
        return args.contains("--test") || args.contains("--selftest") || env["SOTTO_APP_TEST"] == "1"
            || env["XCTestConfigurationFilePath"] != nil || env["XCTestBundlePath"] != nil
            || NSClassFromString("XCTestCase") != nil
    }()
}

// MARK: - factory

/// `FakeAudioIO` whenever `test` is true (NATIVE.md §5.3), else the CoreAudio engine.
public func makeAudioIO(test: Bool, env: [String: String] = ProcessInfo.processInfo.environment) -> AudioIO {
    if test || ProcessGuard.isTestProcess { return FakeAudioIO(env: env) }
    return RealAudioIO()
}

// MARK: - atomics

/// A heap Int64 read and written with C11 atomics (safe from the render thread).
final class AtomicInt: @unchecked Sendable {
    private let p: UnsafeMutablePointer<Int64>
    init(_ v: Int64 = 0) { p = .allocate(capacity: 1); p.initialize(to: v) }
    deinit { p.deallocate() }
    @inline(__always) var value: Int64 { sotto_atomic_load(p) }
    @inline(__always) func store(_ v: Int64) { sotto_atomic_store(p, v) }
    @inline(__always) @discardableResult func add(_ v: Int64) -> Int64 { sotto_atomic_add(p, v) }
    @inline(__always) func exchange(_ v: Int64) -> Int64 { sotto_atomic_exchange(p, v) }
    @inline(__always) var float: Float { Float(bitPattern: UInt32(truncatingIfNeeded: value)) }
    @inline(__always) func storeFloat(_ f: Float) { store(Int64(f.bitPattern)) }
}

// MARK: - small DSP helpers

/// RMS of PCM16 samples, 0...1.
func rms(_ s: UnsafeBufferPointer<Int16>) -> Float {
    guard !s.isEmpty else { return 0 }
    var acc: Double = 0
    for v in s { let f = Double(v); acc += f * f }
    return Float((acc / Double(s.count)).squareRoot() / 32768)
}

func peak(_ s: UnsafeBufferPointer<Int16>) -> Int {
    var m = 0
    for v in s { let a = abs(Int(v)); if a > m { m = a } }
    return m
}

@inline(__always) func floatToInt16(_ f: Float) -> Int16 {
    let x = (f * 32768).rounded()
    return Int16(max(-32768, min(32767, x)))
}

/// PCM16LE bytes <-> [Int16] (host is little-endian on every supported Mac).
func int16Array(_ d: Data) -> [Int16] {
    let n = d.count / 2
    var out = [Int16](repeating: 0, count: n)
    out.withUnsafeMutableBytes { dst in _ = d.copyBytes(to: dst, count: n * 2) }
    return out
}

func pcmData(_ s: [Int16]) -> Data { s.withUnsafeBufferPointer { Data(buffer: $0) } }
