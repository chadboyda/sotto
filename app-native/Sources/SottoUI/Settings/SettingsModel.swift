// Settings + onboarding state (docs/NATIVE.md §3.1 Settings, §3.3 commands, §5.4).
// Daemon-backed rows go through StateModel.sendCommand; app-local rows (devices,
// echo cancellation, login item, mic permission, logs) go through SettingsHooks,
// which SottoApp wires to SottoAudio / ServiceManagement / AVFoundation. SottoUI
// never imports SottoAudio. The API key is never stored here: it goes straight
// into `cmd key_save` and only `status.key.hint` is ever shown.
import Foundation
import Observation
import SottoClient

/// The `settings` message payload (docs/NATIVE.md §3.1).
public struct NativeSettings: Codable, Equatable, Sendable {
    public struct Voices: Codable, Equatable, Sendable {
        public var voices: [String]; public var current: String?; public var live: Bool?; public var live_voice: String?
        public init(voices: [String], current: String? = nil, live: Bool? = nil, live_voice: String? = nil) {
            self.voices = voices; self.current = current; self.live = live; self.live_voice = live_voice
        }
    }
    /// The persona picker: SottoClient's decoded form (docs/NATIVE.md §3.1).
    public typealias Personas = Settings.Personas
    public typealias Persona = Settings.Personas.Persona
    public var voices: Voices?
    public var personas: Personas?
    public var window: String?
    public var policies: [String]?
    public var wake_sensitivities: [String]?
    public var data_dir: String?
    public var version: String?
    public init(voices: Voices? = nil, personas: Personas? = nil, window: String? = nil, policies: [String]? = nil, wake_sensitivities: [String]? = nil, data_dir: String? = nil, version: String? = nil) {
        self.voices = voices; self.personas = personas; self.window = window; self.policies = policies; self.wake_sensitivities = wake_sensitivities
        self.data_dir = data_dir; self.version = version
    }
    /// Decode from a loosely typed payload (welcome.settings, a settings message, get_voices data).
    public init?(json: JSONValue) {
        guard case .object = json, let data = try? JSONEncoder().encode(json),
              let s = try? JSONDecoder().decode(NativeSettings.self, from: data) else { return nil }
        self = s
    }
}

/// One audio device row (supplied by the app from SottoAudio.AudioDevice).
public struct DeviceChoice: Identifiable, Equatable, Sendable {
    public var id: String; public var name: String; public var bluetooth: Bool; public var headphones: Bool
    public init(id: String, name: String, bluetooth: Bool = false, headphones: Bool = false) {
        self.id = id; self.name = name; self.bluetooth = bluetooth; self.headphones = headphones
    }
}

/// App-local actions. Every closure is optional; a nil closure hides or disables its row.
/// All are called on the main actor.
public struct SettingsHooks {
    /// nil = automatic device choice.
    public var selectInput: ((String?) -> Void)?
    public var selectOutput: ((String?) -> Void)?
    /// "automatic" | "always" | "never" (EchoCancellation raw values).
    public var setEchoCancellation: ((String) -> Void)?
    /// Start/stop per-device input meters for "Compare microphones"; the app writes
    /// `SettingsModel.inputLevels`. Must not open devices under `--test`.
    public var setInputMetering: ((Bool) -> Void)?
    /// Fetch GET /api/voice-preview, play it through the output unit, send `played {what:"sample"}`.
    public var playVoicePreview: ((String) async throws -> Void)?
    public var stopVoicePreview: (() -> Void)?
    /// Ask macOS for the microphone; returns the new state.
    public var requestMicAccess: (() async -> MicPermission)?
    public var openMicPrivacySettings: (() -> Void)?
    /// Register/unregister the login item; returns the resulting state.
    public var setLaunchAtLogin: ((Bool) throws -> LoginItemState)?
    public var openLogs: (() -> Void)?
    public var refreshDevices: (() -> Void)?
    /// "system" | "light" | "dark": the app saves it in its defaults and sets NSApp.appearance.
    public var setAppearance: ((String) -> Void)?
    public init() {}
}

@MainActor
@Observable
public final class SettingsModel {
    public let state: StateModel
    public var hooks = SettingsHooks()

    // Daemon-fed.
    public var settings: NativeSettings?

    // App-fed (SottoAudio / system).
    public var inputDevices: [DeviceChoice] = []
    public var outputDevices: [DeviceChoice] = []
    /// Saved choice; nil = automatic.
    public var selectedInput: String?
    public var selectedOutput: String?
    /// The devices the engine is really using (AudioRouteInfo), for "Automatic (MacBook Pro Microphone)".
    public var activeInput: DeviceChoice?
    public var activeOutput: DeviceChoice?
    public var echoCancellation: String = "automatic"
    /// Per-device RMS 0...1 while "Compare microphones" is open.
    public var inputLevels: [String: Float] = [:]
    public var micPermission: MicPermission = .unknown
    /// Settings > Appearance, from the app's defaults (ViewText.normalizeTheme values).
    public var appearance: String = "system"
    public var loginItem: LoginItemState = .unavailable

    // Transient UI state.
    public private(set) var pending: [String: String] = [:]
    public private(set) var errors: [String: String] = [:]
    public var voiceMessage: String?
    /// "Switching to Moss. The conversation carries over." until the new persona is live.
    public private(set) var personaMessage: String?
    public private(set) var previewing: String?
    public private(set) var echoRunning = false
    public private(set) var echoResult: SettingsText.EchoVerdict?
    public private(set) var echoError: String?
    public private(set) var keyBusy = false
    public private(set) var keyError: String?
    public private(set) var keyMessage: String?
    public var metering = false { didSet { if metering != oldValue { hooks.setInputMetering?(metering) } } }

    public init(state: StateModel) { self.state = state }

    // MARK: Daemon messages

    /// Feed every daemon message; picks out the settings payload (welcome.settings or `settings`).
    public func ingest(_ message: ServerMessage) {
        switch message {
        case .welcome(_, _, _, let raw):
            if let s = raw["settings"], let v = NativeSettings(json: s) { settings = v }
        case .settings(let s):
            // SottoClient decodes `settings` to a typed case (B4).
            if let j = try? JSONValue(encoding: s), let v = NativeSettings(json: j) { settings = v }
        case .other(let type, let raw) where type == "settings":
            if let v = NativeSettings(json: .object(raw.filter { $0.key != "type" })) { settings = v }
        default: break
        }
        // A persona switch is done once the live session runs in it.
        if personaMessage != nil, let p = settings?.personas, let live = p.live_persona, live == p.current { personaMessage = nil }
    }

    // MARK: Derived values

    public var status: PageStatus? { state.status }
    public var policies: [String] { settings?.policies ?? ["quiet", "milestones", "walkthrough"] }
    public var wakeLevels: [String] { settings?.wake_sensitivities ?? ["off", "low", "medium", "high"] }
    public var windowModes: [String] { ["auto", "app", "chrome", "default"] }
    public var voices: [String] { settings?.voices?.voices ?? [] }

    public var policy: String { pending["policy"] ?? status?.speaking_policy ?? "milestones" }
    public var voice: String { pending["voice"] ?? settings?.voices?.current ?? status?.voice ?? "marin" }
    public var personas: [NativeSettings.Persona] { settings?.personas?.personas ?? [] }
    /// The persona id in effect: the in-flight choice, then the daemon's (settings, then status, which a terminal switch updates first).
    public var persona: String { pending["persona"] ?? status?.persona ?? settings?.personas?.current ?? "sotto" }
    /// "Switch to the persona's own voice" (the daemon's default is on).
    public var personaUseVoice: Bool {
        if let p = pending["persona_voice"] { return p == "on" }
        return settings?.personas?.use_voice ?? true
    }
    public var currentPersona: NativeSettings.Persona? { personas.first { $0.id == persona } }
    /// The help line under the picker, as the page's drawer words it.
    public var personaHelp: String {
        if pending["persona"] != nil { return SettingsText.personaSwitching }
        return personaMessage ?? SettingsText.personaHelp(currentPersona)
    }
    public var wakeSensitivity: String {
        pending["wake"] ?? (status?.wake?.enabled == false ? "off" : status?.wake?.sensitivity) ?? "medium"
    }
    public var window: String { pending["window"] ?? settings?.window ?? "auto" }
    public var keyRow: SettingsText.KeyRow { SettingsText.keyRow(status?.key) }
    public var keyCard: SettingsText.KeyCard? {
        SettingsText.keyCard(state: status?.state, key: status?.key, lastErrorCode: status?.last_error?.code)
    }
    public var onboardingStep: OnboardingStep? { SettingsText.onboardingStep(mic: micPermission, status: status) }
    public var onHeadphones: Bool { activeOutput?.headphones ?? outputDevices.first { $0.id == selectedOutput }?.headphones ?? false }
    public var echoSummary: String {
        SettingsText.echoSummary(running: echoRunning, verdict: echoResult, error: echoError, headphones: onHeadphones)
    }
    public var echoGuard: String { SettingsText.echoGuard(mode: status?.echo_guard, heardMsAgo: status?.echo_heard_ms_ago) }
    public func error(_ field: String) -> String? { errors[field] }

    // MARK: Daemon-backed settings

    public func setPolicy(_ p: String) { run("policy", value: p, command: "set_policy", args: ["policy": .string(p)]) }
    public func setWake(_ s: String) { run("wake", value: s, command: "set_wake", args: ["sensitivity": .string(s)]) }
    public func setAppearance(_ a: String) {
        let v = ViewText.normalizeTheme(a)
        guard v != appearance else { return }
        appearance = v
        hooks.setAppearance?(v)
    }
    public func setWindow(_ w: String) { run("window", value: w, command: "set_window", args: ["mode": .string(w)]) { data in
        if self.settings == nil { self.settings = NativeSettings() }
        if case .string(let saved)? = data["window"] { self.settings?.window = saved } else { self.settings?.window = w }
    } }
    public func setVoice(_ v: String) {
        guard v != voice else { return }
        voiceMessage = nil
        run("voice", value: v, command: "set_voice", args: ["voice": .string(v)]) { data in
            if case .string(let m)? = data["message"] { self.voiceMessage = m }
            if self.settings?.voices != nil { self.settings?.voices?.current = v }
        }
    }

    /// Pick a persona (`cmd set_persona`, SPEC §4.6): a live session is re-created in it, with its
    /// own voice when the toggle is on. The daemon answers with the persona and voice now in effect.
    public func setPersona(_ id: String) {
        guard id != persona else { return }
        personaMessage = nil
        run("persona", value: id, command: "set_persona", args: ["persona": .string(id)]) { data in
            var chosen = id
            if case .string(let p)? = data["persona"] { chosen = p }
            self.settings?.personas?.current = chosen
            if case .string(let v)? = data["voice"], self.settings?.voices != nil { self.settings?.voices?.current = v }
            if case .bool(true)? = data["switching"] {
                let name = self.personas.first { $0.id == chosen }?.name ?? chosen
                self.personaMessage = SettingsText.personaSwitched(name)
            }
        }
    }

    /// The "Switch to the persona's own voice" toggle (`cmd set_persona {use_voice}`); persisted by the daemon.
    public func setPersonaUseVoice(_ on: Bool) {
        run("persona_voice", value: on ? "on" : "off", command: "set_persona", args: ["use_voice": .bool(on)]) { data in
            var saved = on
            if case .bool(let b)? = data["use_voice"] { saved = b }
            self.settings?.personas?.use_voice = saved
        }
    }

    /// Ask for the voice list when no settings message has arrived yet.
    public func loadVoicesIfNeeded() async {
        guard voices.isEmpty, let send = state.sendCommand else { return }
        if case .success(let data) = await send("get_voices", [:]), let v = decodeVoices(data) {
            if settings == nil { settings = NativeSettings() }
            settings?.voices = v
        }
    }

    private func decodeVoices(_ json: JSONValue) -> NativeSettings.Voices? {
        guard let data = try? JSONEncoder().encode(json) else { return nil }
        return try? JSONDecoder().decode(NativeSettings.Voices.self, from: data)
    }

    private func run(_ field: String, value: String, command: String, args: [String: JSONValue],
                     onOK: (([String: JSONValue]) -> Void)? = nil) {
        guard let send = state.sendCommand else { errors[field] = "Not connected to sotto."; return }
        pending[field] = value
        errors[field] = nil
        Task { @MainActor in
            let r = await send(command, args)
            switch r {
            case .success(let data):
                if case .object(let o) = data { onOK?(o) } else { onOK?([:]) }
            case .failure(let e):
                self.errors[field] = e.message.isEmpty ? "Could not change this setting." : e.message
            }
            // Keep showing the new value until the status that carries it (or the failure) arrives.
            if self.pending[field] == value { self.pending[field] = nil }
        }
    }

    // MARK: Voice preview

    public func togglePreview(_ v: String) {
        if previewing == v { hooks.stopVoicePreview?(); previewing = nil; return }
        guard let play = hooks.playVoicePreview else { return }
        hooks.stopVoicePreview?()
        previewing = v
        errors["preview"] = nil
        Task { @MainActor in
            do { try await play(v) } catch { if self.previewing == v { self.errors["preview"] = "Could not play \(SettingsText.voiceLabel(v)). \(error.localizedDescription)" } }
            if self.previewing == v { self.previewing = nil }
        }
    }

    // MARK: Echo test

    public func runEchoTest() async {
        guard !echoRunning, let send = state.sendCommand else { return }
        echoRunning = true; echoError = nil; echoResult = nil
        defer { echoRunning = false }
        switch await send("echo_test", [:]) {
        case .success(let data):
            var level: String?
            if case .object(let o) = data {
                if case .string(let l)? = o["level"] { level = l }
                else if case .string(let v)? = o["verdict"] { level = v }
            }
            echoResult = SettingsText.echoVerdict(level)
        case .failure(let e):
            echoError = e.message.isEmpty ? "The daemon did not answer." : e.message
        }
    }

    // MARK: API key

    /// Send the key to the daemon (which validates it with OpenAI and saves it to the Keychain).
    /// The key is not kept anywhere in the app. Returns true when saved.
    @discardableResult
    public func saveKey(_ raw: String) async -> Bool {
        if let problem = SettingsText.keyInputProblem(raw) { keyError = problem; return false }
        guard let send = state.sendCommand else { keyError = "Not connected to sotto."; return false }
        keyBusy = true; keyError = nil; keyMessage = nil
        defer { keyBusy = false }
        let key = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        switch await send("key_save", ["key": .string(key)]) {
        case .success(let data):
            if case .object(let o) = data, case .string(let m)? = o["message"] { keyMessage = m } else { keyMessage = "Key saved." }
            return true
        case .failure(let e):
            keyError = e.message.isEmpty ? "Could not save the key." : e.message
            return false
        }
    }

    public func removeKey() async {
        guard let send = state.sendCommand else { keyError = "Not connected to sotto."; return }
        keyBusy = true; keyError = nil; keyMessage = nil
        defer { keyBusy = false }
        switch await send("key_remove", [:]) {
        case .success(let data):
            if case .object(let o) = data, case .string(let m)? = o["message"] { keyMessage = m } else { keyMessage = "Key removed." }
        case .failure(let e):
            keyError = e.message.isEmpty ? "Could not remove the key." : e.message
        }
    }

    public func clearKeyFeedback() { keyError = nil; keyMessage = nil }

    func setEchoResult(_ v: SettingsText.EchoVerdict?) { echoResult = v; echoError = nil }

    // MARK: App-local

    public func chooseInput(_ id: String?) { selectedInput = id; hooks.selectInput?(id) }
    public func chooseOutput(_ id: String?) { selectedOutput = id; hooks.selectOutput?(id); echoResult = nil; echoError = nil }
    public func chooseEchoCancellation(_ m: String) { echoCancellation = m; hooks.setEchoCancellation?(m) }

    public func requestMic() async {
        switch micPermission {
        case .denied, .restricted: hooks.openMicPrivacySettings?()
        default:
            guard let ask = hooks.requestMicAccess else { return }
            micPermission = await ask()
        }
    }

    public func setLaunchAtLogin(_ on: Bool) {
        guard let set = hooks.setLaunchAtLogin else { return }
        errors["login"] = nil
        do { loginItem = try set(on) } catch { errors["login"] = "Could not change the login item. \(error.localizedDescription)" }
    }

    public func openBrowser() {
        guard let send = state.sendCommand else { return }
        errors["browser"] = nil
        Task { @MainActor in
            if case .failure(let e) = await send("open_browser", [:]) { self.errors["browser"] = e.message }
        }
    }
}
