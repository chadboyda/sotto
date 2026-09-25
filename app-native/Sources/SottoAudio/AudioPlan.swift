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

    /// Mic device rule: exactly the mic the user chose if it is present, else the macOS system
    /// default input, whatever it is (a Bluetooth headset's mic included: wearing one is the
    /// reason to use it). With no known default, the first non-virtual input.
    public static func pickInput(inputs: [AudioDevice], defaultInput: String?, preferred: String?) -> AudioDevice? {
        if let p = preferred, let d = inputs.first(where: { $0.id == p }) { return d }
        let virtualish: (AudioDevice) -> Bool = { $0.transport == .virtual || $0.transport == .aggregate }
        return inputs.first(where: { $0.id == defaultInput }) ?? inputs.first(where: { !virtualish($0) }) ?? inputs.first
    }

    /// Why a re-evaluated plan moved to other devices, for the route's reason: `device_removed`
    /// when the device in use is gone, `default_changed` when it followed the system default
    /// (Automatic), `choice_changed` when the user picked another device. nil when the devices
    /// are the same.
    public static func changeTag(old: AudioPlan?, new: AudioPlan, available: [AudioDevice], preferredInput: String?, preferredOutput: String?) -> String? {
        guard let old = old else { return nil }
        var tags: [String] = []
        func tag(_ was: AudioDevice?, _ now: AudioDevice?, preferred: String?) {
            guard let was = was, was.id != now?.id else { return }
            if !available.contains(where: { $0.id == was.id }) { tags.append("device_removed") }
            else if preferred == nil || preferred == now?.id { tags.append(preferred == nil ? "default_changed" : "choice_changed") }
            else { tags.append("choice_changed") }
        }
        tag(old.input, new.input, preferred: preferredInput)
        if new.output != nil { tag(old.output, new.output, preferred: preferredOutput) }
        let unique = tags.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
        return unique.isEmpty ? nil : unique.joined(separator: ",")
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
