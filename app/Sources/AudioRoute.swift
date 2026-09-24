// Default audio devices, for `Sotto --audio-route` (read by the daemon's
// window chooser, SPEC §6.16) and the debug log.
//
// Why the daemon cares: WebKit captures the microphone through Apple's
// voice-processing I/O, which opens the *system default input* first. When
// that is a Bluetooth headset (AirPods), the headset switches to its
// hands-free (SCO) profile for the whole voice session, even though the page
// then picks the built-in mic (measured on macOS 26: AirPods Max output
// 48 kHz -> 24 kHz, and the log shows "changing BT output device's profile to
// BluetoothFormatSCO"). Chrome does not do this, so `auto` prefers Chrome then.
import CoreAudio
import Foundation

struct AudioDeviceSummary {
    var name: String
    var bluetooth: Bool

    var dictionary: [String: Any] { ["name": name, "bluetooth": bluetooth] }
}

struct AudioRoute {
    var input: AudioDeviceSummary?
    var output: AudioDeviceSummary?

    var dictionary: [String: Any] {
        ["input": input?.dictionary ?? NSNull(), "output": output?.dictionary ?? NSNull()]
    }

    var json: String {
        guard let d = try? JSONSerialization.data(withJSONObject: dictionary, options: [.sortedKeys]),
              let s = String(data: d, encoding: .utf8) else { return "{}" }
        return s
    }

    static func current() -> AudioRoute {
        AudioRoute(input: summary(defaultDevice(kAudioHardwarePropertyDefaultInputDevice)),
                   output: summary(defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)))
    }

    private static func summary(_ dev: AudioDeviceID?) -> AudioDeviceSummary? {
        guard let dev = dev else { return nil }
        let transport = u32Prop(dev, kAudioDevicePropertyTransportType) ?? 0
        let bt = transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE
        return AudioDeviceSummary(name: stringProp(dev, kAudioObjectPropertyName) ?? "", bluetooth: bt)
    }

    private static func defaultDevice(_ sel: AudioObjectPropertySelector) -> AudioDeviceID? {
        var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let err = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
        return err == noErr && id != 0 ? id : nil
    }

    private static func stringProp(_ d: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
        var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(d, &addr, 0, nil, &size, &value) == noErr, let v = value else { return nil }
        return v.takeRetainedValue() as String
    }

    private static func u32Prop(_ d: AudioObjectID, _ sel: AudioObjectPropertySelector) -> UInt32? {
        var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var v: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(d, &addr, 0, nil, &size, &v) == noErr ? v : nil
    }
}
