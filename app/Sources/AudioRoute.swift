// Default audio devices, for `Sotto --audio-route` (read by the daemon's
// window chooser, SPEC §6.16) and the debug log.
//
// Why the daemon cares: WebKit captures the microphone through Apple's
// voice-processing I/O, which opens the *system default input* first. When
// that is a Bluetooth headset (AirPods), the headset switches to its
// hands-free (SCO) profile for the whole voice session, even though the page
// then picks the built-in mic (measured on macOS 26: AirPods Max output
// 48 kHz -> 24 kHz, and the log shows "changing BT output device's profile to
// BluetoothFormatSCO"). Chrome does not do this. Since the native mic
// (NativeMic.swift) the app avoids it on headphones, so `auto` needs Chrome
// only when there is no other input or the output is not headphones.
import CoreAudio
import Foundation

struct AudioDeviceSummary {
    var name: String
    var bluetooth: Bool
    var headphones: Bool?

    var dictionary: [String: Any] {
        var d: [String: Any] = ["name": name, "bluetooth": bluetooth]
        if let h = headphones { d["headphones"] = h }
        return d
    }
}

struct AudioRoute {
    var input: AudioDeviceSummary?
    var output: AudioDeviceSummary?
    /// A non-Bluetooth, non-virtual input exists (normally the built-in mic).
    var builtinInput: Bool
    /// The app captures natively on headphones (MicController.pref != webkit),
    /// so a Bluetooth default input no longer forces the hands-free profile.
    var nativeMic: Bool

    var dictionary: [String: Any] {
        ["input": input?.dictionary ?? NSNull(), "output": output?.dictionary ?? NSNull(),
         "builtin_input": builtinInput, "native_mic": nativeMic]
    }

    var json: String { jsonString(dictionary) }

    static func current(env: [String: String] = ProcessInfo.processInfo.environment) -> AudioRoute {
        let inputs = Devices.inputs()
        let def = Devices.defaultDevice(input: true)
        let input = inputs.first(where: { $0.id == def }).map { AudioDeviceSummary(name: $0.name, bluetooth: $0.bluetooth) }
        let output = Devices.output().map { AudioDeviceSummary(name: $0.name, bluetooth: $0.bluetooth, headphones: $0.headphones) }
        let pref = (env["SOTTO_APP_MIC"] ?? Prefs.store.string(forKey: MicController.prefKey) ?? "auto").lowercased()
        return AudioRoute(input: input, output: output, builtinInput: inputs.contains { !$0.bluetooth && !$0.virtual },
                          nativeMic: pref != "webkit")
    }
}
