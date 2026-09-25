// Settings + onboarding copy (docs/NATIVE.md §5.4). Pure: ports of web/lib.js
// keySettingsView/keyCardView/micPromptView and web/echo.js echoTestVerdict, plus
// the native-only rows. Table-tested in SettingsTextTests against the JS tests' strings.
import Foundation
import SottoClient

/// macOS microphone privacy state (AVCaptureDevice.authorizationStatus(for: .audio)).
public enum MicPermission: String, Equatable, Sendable {
    case unknown, notDetermined, granted, denied, restricted
}

/// Launch-at-login state (SMAppService.mainApp.status).
public enum LoginItemState: String, Equatable, Sendable {
    case unavailable, off, on, requiresApproval
}

/// Which onboarding card the panel should show first, if any.
public enum OnboardingStep: String, Equatable, Sendable { case microphone, apiKey }

public enum SettingsText {
    // MARK: API key (ports of lib.keySettingsView / lib.keyCardView)

    public struct KeyRow: Equatable, Sendable {
        public var text: String; public var help: String
        public var change: Bool; public var remove: Bool; public var changeLabel: String
    }

    /// The settings row for the key. Never needs the key itself: `hint` is its last four characters.
    public static func keyRow(_ key: PageStatus.Key?) -> KeyRow {
        guard let key else { return KeyRow(text: "Checking…", help: "", change: false, remove: false, changeLabel: "Change") }
        let whereText = keyWhere(key)
        if key.present != true {
            return KeyRow(
                text: "No key yet",
                help: key.keychain == true
                    ? "Add one to start talking. It is checked with OpenAI and kept in your macOS Keychain."
                    : "Export OPENAI_API_KEY before starting Claude Code, or add it to the plugin's .env file.",
                change: key.can_change == true, remove: false, changeLabel: "Add key")
        }
        let help: String
        if key.source == "keychain" { help = "Saved in your macOS Keychain." }
        else if key.can_change == true { help = "From \(whereText). A key saved here replaces it." }
        else { help = "From \(whereText). Change it there." }
        return KeyRow(text: "Key ending in \(key.hint ?? "????")", help: help,
                      change: key.can_change == true, remove: key.can_remove == true, changeLabel: "Change")
    }

    public struct KeyCard: Equatable, Sendable { public var title: String; public var body: String; public var keyInput: Bool }

    static let keyIntro = "Sotto talks through OpenAI's gpt-live-1 voice model, billed to your OpenAI account at about $0.05 a minute. Paste a key from platform.openai.com/api-keys."
    static let keyKeep = "Sotto checks it with OpenAI, then keeps it in your macOS Keychain. It is never shown again."

    /// The key onboarding card (port of lib.keyCardView for the native app: the daemon
    /// state stands in for the page phase). nil when no key card is needed.
    public static func keyCard(state: String?, key: PageStatus.Key?, lastErrorCode: String?) -> KeyCard? {
        let st = state ?? "off"
        if st == "live" || st == "connecting" || st == "reconnecting" { return nil }
        let missing = lastErrorCode == "no_api_key" && st != "off"
        let rejected = key?.can_change == true && lastErrorCode == "openai_auth" && st != "off"
        if key?.setup != true && !missing && !rejected { return nil }
        let hint = key?.hint ?? "????"
        if let key, key.present == true, key.can_change != true, !rejected, !missing {
            return KeyCard(title: "Your OpenAI API key is set outside Sotto",
                           body: "The key in use (ending in \(hint)) comes from \(keyWhere(key)). Change it there, then run /talk on again.",
                           keyInput: false)
        }
        if let key, key.keychain == false {
            return KeyCard(title: "Add your OpenAI API key to start",
                           body: "Export OPENAI_API_KEY before starting Claude Code, or add it to the plugin's .env file, then run /talk on again.",
                           keyInput: false)
        }
        if rejected {
            return KeyCard(title: "OpenAI rejected your API key",
                           body: "The key ending in \(hint) no longer works. Paste a new one. \(keyKeep)", keyInput: true)
        }
        if let key, key.present == true {
            return KeyCard(title: "Replace your OpenAI API key",
                           body: "Sotto uses the key ending in \(hint), from \(keyWhere(key)). Paste a new one to replace it. \(keyKeep)",
                           keyInput: true)
        }
        return KeyCard(title: "Add your OpenAI API key to start", body: "\(keyIntro) \(keyKeep)", keyInput: true)
    }

    static func keyWhere(_ key: PageStatus.Key) -> String {
        if key.source == "dotenv", let f = key.file, !f.isEmpty { return f }
        return key.label ?? "somewhere outside Sotto"
    }

    /// Client-side shape check before the daemon validates with OpenAI. nil = send it.
    public static func keyInputProblem(_ raw: String) -> String? {
        let k = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if k.isEmpty { return "Paste your OpenAI API key first." }
        if !k.hasPrefix("sk-") || k.count < 20 || k.contains(where: { $0.isWhitespace }) {
            return "That does not look like an OpenAI API key. Keys start with sk-."
        }
        return nil
    }

    // MARK: Microphone permission (port of lib.micPromptView / micFailureView for the app)

    public struct MicCard: Equatable, Sendable {
        public var title: String; public var body: String
        public var steps: [String]; public var button: String?; public var note: String?
    }

    public static func micCard(_ p: MicPermission) -> MicCard? {
        switch p {
        case .granted: return nil
        case .notDetermined, .unknown:
            return MicCard(title: "Allow microphone access",
                           body: "Sotto needs the microphone to hear you. macOS asks once; click Allow. Nothing is sent until a voice session starts.",
                           steps: [], button: "Allow Microphone",
                           note: "Don't see the question? It may be behind this panel, or check System Settings, then Privacy & Security, then Microphone.")
        case .denied:
            return MicCard(title: "Sotto can't use the microphone",
                           body: "Allow it in System Settings > Privacy & Security > Microphone. Voice is paused and not billing.",
                           steps: ["Open System Settings, then Privacy & Security, then Microphone.", "Turn on Sotto.", "Come back here; Sotto picks it up right away."],
                           button: "Open System Settings", note: nil)
        case .restricted:
            return MicCard(title: "The microphone is restricted on this Mac",
                           body: "A profile or parental control blocks microphone access for apps. Sotto can't hear you until it is allowed.",
                           steps: [], button: "Open System Settings", note: nil)
        }
    }

    /// First onboarding card needed: the mic, then the key.
    public static func onboardingStep(mic: MicPermission, status: PageStatus?) -> OnboardingStep? {
        if mic != .granted && mic != .unknown { return .microphone }
        if keyCard(state: status?.state, key: status?.key, lastErrorCode: status?.last_error?.code) != nil { return .apiKey }
        return nil
    }

    // MARK: Speaking policy, wake, window

    public static func policyLabel(_ p: String) -> String {
        switch p { case "quiet": return "Quiet"; case "milestones": return "Milestones"; case "walkthrough": return "Walkthrough"; default: return p.capitalized }
    }
    /// Same strings as the page's POLICY_HELP.
    public static func policyHelp(_ p: String) -> String {
        switch p {
        case "quiet": return "Speaks only when you talk to it."
        case "milestones": return "Mentions finished work, approvals and errors."
        case "walkthrough": return "Narrates Claude's progress as it goes."
        default: return ""
        }
    }
    public static func wakeLabel(_ s: String) -> String {
        switch s { case "off": return "Off"; case "low": return "Low"; case "medium": return "Medium"; case "high": return "High"; default: return s.capitalized }
    }
    public static let wakeHelp = "How readily your voice wakes a sleeping session. Nothing is sent or billed until it wakes."

    /// Settings > Appearance (the page's segmented control): System follows macOS, live.
    public static func appearanceLabel(_ a: String) -> String {
        switch a {
        case "light": return "Light"
        case "dark": return "Dark"
        default: return "System"
        }
    }
    public static let appearanceHelp = "System follows your Mac's appearance. The Chrome page keeps its own choice."

    public static func windowLabel(_ w: String) -> String {
        switch w {
        case "auto": return "Automatic"
        case "app": return "Sotto app"
        case "chrome": return "Chrome"
        case "default": return "Default browser"
        default: return w.capitalized
        }
    }
    public static func windowHelp(_ w: String) -> String {
        switch w {
        case "auto", "app": return "Voice opens in this app. The Chrome page stays available as a fallback."
        case "chrome": return "Voice opens in a Chrome window instead of this app, starting with the next session."
        case "default": return "Voice opens in your default browser instead of this app, starting with the next session."
        default: return ""
        }
    }

    // MARK: Voice

    public static func voiceLabel(_ v: String) -> String { v.prefix(1).uppercased() + v.dropFirst() }
    public static let voiceHelp = "Changing it restarts the voice session; the conversation carries over."
    public static let voiceSamplesHelp = "Plays a short sample; the live session keeps its voice. Each sample is recorded once (a few seconds of voice time) and then kept."

    // MARK: Persona (the page's persona picker, web/app.js renderPersonas / choosePersona)

    public static let personaDefaultHelp = "How the voice talks: its tone, humor and opinions. What Claude does stays the same."
    public static let personaVoiceToggle = "Switch to the persona's own voice"
    public static let personaSwitching = "Switching the persona…"
    public static func personaSwitched(_ name: String) -> String { "Switching to \(name). The conversation carries over." }

    /// The picker row: the name, tagged when it comes from a file (web personaLabel).
    public static func personaLabel(_ p: Settings.Personas.Persona) -> String {
        switch p.source {
        case "project": return "\(p.name) (project)"
        case "user": return "\(p.name) (yours)"
        default: return p.name
        }
    }

    /// The one-line description plus the persona's own voice, else the general help.
    public static func personaHelp(_ p: Settings.Personas.Persona?) -> String {
        guard let p, let d = p.description, !d.isEmpty else { return personaDefaultHelp }
        guard let v = p.voice, !v.isEmpty else { return d }
        return "\(d) Voice: \(voiceLabel(v))."
    }

    // MARK: Echo (port of echo.echoTestVerdict + the page's renderEcho)

    public struct EchoVerdict: Equatable, Sendable { public var level: String; public var title: String; public var advice: String }

    /// `level` is the measurement ("low"|"some"|"high"|"unknown") or an already-mapped verdict ("good"|"heavy").
    public static func echoVerdict(_ level: String?) -> EchoVerdict {
        switch level {
        case "high", "heavy":
            return EchoVerdict(level: "heavy", title: "Heavy echo", advice: "The microphone hears the speaker. Use headphones or turn the speaker down; the echo guard keeps Sotto from answering itself.")
        case "some":
            return EchoVerdict(level: "some", title: "Some echo", advice: "Echo cancellation catches most of it and Sotto filters the rest. Headphones are best.")
        case "low", "good":
            return EchoVerdict(level: "good", title: "Good", advice: "The microphone does not hear the speaker. You can talk over Sotto at any time.")
        default:
            return EchoVerdict(level: "unknown", title: "Not sure", advice: "Too quiet to measure. Try again with the speaker a little louder.")
        }
    }

    public static func echoSummary(running: Bool, verdict: EchoVerdict?, error: String?, headphones: Bool) -> String {
        if running { return "Listening for the speaker…" }
        if let error { return "Could not test. \(error)" }
        if let v = verdict { return "\(v.title). \(v.advice)" }
        return headphones ? "Headphones: no echo to worry about." : "Not tested on this speaker yet."
    }

    public static let echoHelp = "Plays a short sound on this speaker and listens for it with echo cancellation on."

    /// The echo guard line under Test echo. `heardMsAgo` is status.echo_heard_ms_ago.
    public static func echoGuard(mode: String?, heardMsAgo: Double?) -> String {
        switch mode {
        case "off": return "Echo guard: off."
        case "on": return "Echo guard: always on."
        default:
            if let ms = heardMsAgo, ms >= 0, ms < 120_000 { return "Echo guard: on (the mic hears the speaker; you can still talk over Sotto)." }
            return "Echo guard: automatic, not needed now."
        }
    }

    public static func echoCancellationLabel(_ m: String) -> String {
        switch m { case "automatic": return "Automatic"; case "always": return "Always"; case "never": return "Never"; default: return m.capitalized }
    }
    public static func echoCancellationHelp(_ m: String) -> String {
        switch m {
        case "always": return "Voice processing stays on, even on headphones. Bluetooth headphones may switch to their lower-quality call mode."
        case "never": return "No voice processing. Use headphones, or Sotto may hear itself."
        default: return "On for speakers, off for headphones so AirPods keep full sound quality."
        }
    }

    // MARK: Devices + login

    public static let automaticDevice = "Automatic"
    public static let micCompareHelp = "Speak and watch the bars: pick the one that moves when you talk."

    /// Under the Microphone picker when the mic in use (chosen, or picked automatically) is Bluetooth:
    /// its mic puts AirPods and other headsets into call mode (lower-quality sound both ways).
    public static let bluetoothMicHelp = "Bluetooth mics switch your headphones to call quality."
    public static func bluetoothMicWarning(selected: DeviceChoice?, active: DeviceChoice?) -> String? {
        (selected ?? active)?.bluetooth == true ? bluetoothMicHelp : nil
    }

    public static func loginHelp(_ s: LoginItemState) -> String {
        switch s {
        case .unavailable: return "Available once Sotto is installed in Applications."
        case .off: return "Sotto waits in the menu bar after you log in, ready for /talk."
        case .on: return "Sotto opens in the menu bar when you log in."
        case .requiresApproval: return "Approve Sotto in System Settings, then General, then Login Items."
        }
    }
}
