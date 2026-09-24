// Which engine and devices a session gets (NATIVE.md §5.3). Pure, so the rules are table-tested.
import Foundation

public struct AudioPlan: Equatable, Sendable {
    public var mode: AudioMode
    public var input: AudioDevice?
    public var output: AudioDevice?
    public var reason: String

    /// Voice processing (Apple's AEC) runs only in `vpio`.
    public var echoCancellation: Bool { mode == .vpio }

    public var route: AudioRouteInfo {
        AudioRouteInfo(mode: mode, input: input, output: output, echoCancellation: echoCancellation, reason: reason)
    }

    /// - output: the output device in use (preferred if present, else the system default).
    /// - input: the capture device from `pickInput`.
    /// - pref: echo cancellation Automatic/Always/Never.
    /// - listenOnly: sleeping (wake listening): input only, never voice processing.
    public static func decide(output: AudioDevice?, input: AudioDevice?, pref: EchoCancellation,
                              listenOnly: Bool = false, test: Bool = false) -> AudioPlan {
        if test { return AudioPlan(mode: .fake, input: input, output: output, reason: "test") }
        if listenOnly { return AudioPlan(mode: .listen, input: input, output: nil, reason: "sleeping") }
        switch pref {
        case .always: return AudioPlan(mode: .vpio, input: input, output: output, reason: "pref_always")
        case .never: return AudioPlan(mode: .split, input: input, output: output, reason: "pref_never")
        case .automatic:
            if output?.headphones == true { return AudioPlan(mode: .split, input: input, output: output, reason: "headphones") }
            return AudioPlan(mode: .vpio, input: input, output: output, reason: output == nil ? "no_output" : "speakers")
        }
    }

    /// Mic device rule (port of MicPlan.autoDevice): the saved device if present, else the system
    /// default unless it is Bluetooth, else built-in (then any non-Bluetooth, non-virtual input).
    /// Automatic choice never picks a Bluetooth mic when another exists: opening one switches
    /// AirPods to the hands-free profile. An explicitly saved Bluetooth mic is honored.
    public static func pickInput(inputs: [AudioDevice], defaultInput: String?, preferred: String?) -> AudioDevice? {
        if let p = preferred, let d = inputs.first(where: { $0.id == p }) { return d }
        let virtualish: (AudioDevice) -> Bool = { $0.transport == .virtual || $0.transport == .aggregate }
        let def = inputs.first(where: { $0.id == defaultInput }) ?? inputs.first(where: { !virtualish($0) }) ?? inputs.first
        guard let d = def else { return nil }
        if d.bluetooth,
           let alt = inputs.first(where: { $0.transport == .builtIn && !$0.bluetooth })
            ?? inputs.first(where: { !$0.bluetooth && !virtualish($0) }) {
            return alt
        }
        return d
    }

    /// The saved output if present, else the system default.
    public static func pickOutput(outputs: [AudioDevice], defaultOutput: String?, preferred: String?) -> AudioDevice? {
        if let p = preferred, let d = outputs.first(where: { $0.id == p }) { return d }
        return outputs.first(where: { $0.id == defaultOutput }) ?? outputs.first
    }

    /// Headphone-class output: Bluetooth, the built-in jack's `hdpn` data source, or a
    /// headphone-named USB device. Everything else (built-in speakers, HDMI, AirPlay, unknown) is speakers.
    public static func isHeadphones(transport: AudioTransport, dataSourceHdpn: Bool, name: String) -> Bool {
        switch transport {
        case .bluetooth: return true
        case .builtIn: return dataSourceHdpn
        case .usb:
            let n = name.lowercased()
            return ["headphone", "headset", "earphone", "earbud", "airpods"].contains { n.contains($0) }
        default: return false
        }
    }
}
