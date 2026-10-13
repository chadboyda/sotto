import CoreAudio
import Foundation

/// Other apps using the microphone (SPEC §6.15 "Call hold"): Core Audio's process objects
/// (`kAudioHardwarePropertyProcessObjectList`, macOS 14) report, per client process, whether it
/// runs an input stream. Reading them is a plain property query: no prompt, no TCC, and nothing
/// about Focus or Do Not Disturb. This app's own capture (wake listening) is excluded by pid.
public enum MicUsers {
    /// Bundle ids (or "pid N") of other processes with an active input stream; nil when the
    /// system does not offer process objects.
    public static func others(excluding own: pid_t = getpid()) -> [String]? {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList,
                                              mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return nil }
        let n = Int(size) / MemoryLayout<AudioObjectID>.size
        if n == 0 { return [] }
        var ids = [AudioObjectID](repeating: 0, count: n)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return nil }
        var out: [String] = []
        for id in ids {
            guard let running: UInt32 = value(id, kAudioProcessPropertyIsRunningInput), running != 0 else { continue }
            let pid: pid_t = value(id, kAudioProcessPropertyPID) ?? 0
            if pid == own || pid == 0 { continue }
            out.append(bundleID(id) ?? "pid \(pid)")
        }
        return out
    }

    private static func value<T>(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> T? {
        var addr = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<T>.size)
        let p = UnsafeMutableRawPointer.allocate(byteCount: MemoryLayout<T>.size, alignment: MemoryLayout<T>.alignment)
        defer { p.deallocate() }
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, p) == noErr else { return nil }
        return p.load(as: T.self)
    }

    private static func bundleID(_ id: AudioObjectID) -> String? {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyBundleID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<CFString?>.size)
        var s: Unmanaged<CFString>?
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &s) == noErr, let v = s?.takeRetainedValue() as String?, !v.isEmpty else { return nil }
        return v
    }
}
