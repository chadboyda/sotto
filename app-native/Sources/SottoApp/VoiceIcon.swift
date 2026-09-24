// What the menu-bar icon and the compact pill show (docs/NATIVE.md §5.1).
// Pure: the Controller feeds it the daemon status, the link state and the
// audio levels; `--selftest icon` checks the table.
import AppKit
import SottoClient

enum VoiceIcon: String, CaseIterable {
    case off, connecting, paused, sleeping, listening, userSpeaking, assistantSpeaking, working, muted, error

    var symbol: String {
        switch self {
        case .off: return "waveform.slash"
        case .connecting: return "ellipsis.circle"
        case .paused: return "pause.circle"
        case .sleeping: return "moon.zzz"
        case .listening: return "waveform"
        case .userSpeaking: return "mic.fill"
        case .assistantSpeaking: return "speaker.wave.2.fill"
        case .working: return "gearshape.2"
        case .muted: return "mic.slash.fill"
        case .error: return "exclamationmark.triangle.fill"
        }
    }

    var label: String {
        switch self {
        case .off: return "Voice off"
        case .connecting: return "Connecting"
        case .paused: return "Paused"
        case .sleeping: return "Sleeping, listening for your voice"
        case .listening: return "Listening"
        case .userSpeaking: return "You are speaking"
        case .assistantSpeaking: return "Sotto is speaking"
        case .working: return "Claude is working"
        case .muted: return "Muted"
        case .error: return "Needs attention"
        }
    }

    var tint: NSColor? {
        switch self {
        case .error: return .systemRed
        case .muted: return .systemOrange
        case .userSpeaking, .assistantSpeaking: return .controlAccentColor
        default: return nil
        }
    }
}

/// Everything the icon depends on, as plain values.
struct IconInput: Equatable {
    var attached = false        // a daemon link exists (sotto://open accepted)
    var linkUp = false          // welcome received on the current connection
    var linkFailed = false      // reconnects exhausted / protocol mismatch
    var state = "off"           // PageStatus.state
    var muted = false
    var busy = false
    var errorCode = ""          // PageStatus.last_error.code
    var micFailed = false
    var lastUser: TimeInterval = 0       // last time the mic level was above the speech threshold
    var lastAssistant: TimeInterval = 0  // last time the speaker level was
}

enum IconModel {
    static let speakingHold: TimeInterval = 1.2
    /// RMS above which the level counts as speech (0...1 full scale). The dial
    /// levels are RMS of 20 ms frames: room noise sits near 0.005, speech at 0.05+.
    static let speechLevel: Float = 0.03

    static func icon(_ i: IconInput, now: TimeInterval) -> VoiceIcon {
        if !i.attached { return .off }
        if i.linkFailed { return .error }
        if !i.linkUp { return i.state == "off" ? .off : .connecting }
        switch i.state {
        case "off", "closing", "": return .off
        case "waiting_page", "connecting", "reconnecting": return i.micFailed ? .error : .connecting
        case "paused": return (!i.errorCode.isEmpty && i.errorCode != "idle") || i.micFailed ? .error : .paused
        case "sleeping": return i.micFailed ? .error : .sleeping
        case "live":
            if i.micFailed { return .error }
            if i.muted { return .muted }
            if now - i.lastAssistant < speakingHold { return .assistantSpeaking }
            if now - i.lastUser < speakingHold { return .userSpeaking }
            if i.busy { return .working }
            return .listening
        default:
            return .connecting
        }
    }

    static func input(status s: PageStatus?, into i: inout IconInput) {
        guard let s = s else { return }
        i.state = s.state
        i.muted = s.live?.muted ?? false
        i.busy = s.claude?.busy ?? false
        i.errorCode = s.last_error?.code ?? ""
    }

    /// `--selftest icon '{"attached":true,"link_up":true,"state":"live",...,"now":10}'`.
    static func evaluate(json: String) -> String {
        guard let o = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return "{\"error\":\"bad json\"}" }
        var i = IconInput()
        i.attached = o["attached"] as? Bool ?? true
        i.linkUp = o["link_up"] as? Bool ?? true
        i.linkFailed = o["link_failed"] as? Bool ?? false
        i.state = o["state"] as? String ?? "off"
        i.muted = o["muted"] as? Bool ?? false
        i.busy = o["busy"] as? Bool ?? false
        i.errorCode = o["error"] as? String ?? ""
        i.micFailed = o["mic_failed"] as? Bool ?? false
        i.lastUser = o["last_user"] as? Double ?? 0
        i.lastAssistant = o["last_assistant"] as? Double ?? 0
        let now = o["now"] as? Double ?? 1000
        let icon = icon(i, now: now)
        return jsonString(["icon": icon.rawValue, "symbol": icon.symbol, "label": icon.label])
    }
}
