// The Settings window (docs/NATIVE.md §5.4): same rows and copy as the page's
// settings drawer, as a native grouped Form. Changes apply right away.
import SwiftUI
import SottoClient

public struct SettingsView: View {
    @Bindable var model: SettingsModel
    public init(model: SettingsModel) { self.model = model }

    public var body: some View {
        Form {
            conversationSection
            audioSection
            keySection
            appSection
        }
        .formStyle(.grouped)
        .frame(minWidth: 460, idealWidth: 480, minHeight: 520)
        .task { await model.loadVoicesIfNeeded() }
        .onDisappear { model.metering = false; model.hooks.stopVoicePreview?() }
    }

    // MARK: Conversation

    private var conversationSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Picker("Speaking policy", selection: Binding(get: { model.policy }, set: { model.setPolicy($0) })) {
                    ForEach(model.policies, id: \.self) { Text(SettingsText.policyLabel($0)).tag($0) }
                }
                .pickerStyle(.segmented)
                FieldHelp(SettingsText.policyHelp(model.policy), error: model.error("policy"))
            }

            if !model.personas.isEmpty { personaRow }

            VStack(alignment: .leading, spacing: 6) {
                Picker("Voice", selection: Binding(get: { model.voice }, set: { model.setVoice($0) })) {
                    if model.voices.isEmpty { Text(SettingsText.voiceLabel(model.voice)).tag(model.voice) }
                    ForEach(model.voices, id: \.self) { Text(SettingsText.voiceLabel($0)).tag($0) }
                }
                FieldHelp(model.voiceMessage ?? SettingsText.voiceHelp, error: model.error("voice"))
            }

            if model.hooks.playVoicePreview != nil && !model.voices.isEmpty {
                DisclosureGroup("Hear the voices") {
                    VoiceGrid(model: model)
                    FieldHelp(SettingsText.voiceSamplesHelp, error: model.error("preview"))
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Picker("Voice wake", selection: Binding(get: { model.wakeSensitivity }, set: { model.setWake($0) })) {
                    ForEach(model.wakeLevels, id: \.self) { Text(SettingsText.wakeLabel($0)).tag($0) }
                }
                FieldHelp(SettingsText.wakeHelp, error: model.error("wake"))
            }
        } header: { Text("Conversation") }
    }

    /// Persona picker, as the page's drawer has it: the names (tagged when they come from a file),
    /// the chosen one's one-line description and voice under it, and the voice toggle.
    private var personaRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            Picker("Persona", selection: Binding(get: { model.persona }, set: { model.setPersona($0) })) {
                if model.currentPersona == nil { Text(model.persona).tag(model.persona) }
                ForEach(model.personas) { p in
                    Text(SettingsText.personaLabel(p)).tag(p.id)
                }
            }
            .accessibilityHint(model.personaHelp)
            FieldHelp(model.personaHelp, error: model.error("persona"))
            Toggle(SettingsText.personaVoiceToggle, isOn: Binding(get: { model.personaUseVoice }, set: { model.setPersonaUseVoice($0) }))
                .toggleStyle(.checkbox)
            if let e = model.error("persona_voice") { FieldHelp("", error: e) }
        }
    }

    // MARK: Audio

    private var audioSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .center, spacing: 10) {
                    Picker("Microphone", selection: Binding(get: { model.selectedInput ?? "" }, set: { model.chooseInput($0.isEmpty ? nil : $0) })) {
                        Text(automaticLabel(model.activeInput)).tag("")
                        ForEach(model.inputDevices) { d in Text(d.name).tag(d.id) }
                    }
                    LevelMeter(level: model.state.micLevel, segments: 8)
                        .frame(width: 56, height: 10)
                        .accessibilityLabel("Microphone level")
                }
                if let mic = model.inputDevices.first(where: { $0.id == model.selectedInput }), mic.bluetooth {
                    FieldHelp("Bluetooth microphones switch headphones into call mode and sound worse. The built-in microphone is usually better.")
                }
            }
            if !model.inputDevices.isEmpty && model.hooks.setInputMetering != nil {
                DisclosureGroup("Compare microphones", isExpanded: $model.metering) {
                    FieldHelp(SettingsText.micCompareHelp)
                    ForEach(model.inputDevices) { d in
                        MicCompareRow(device: d, level: model.inputLevels[d.id] ?? 0,
                                      chosen: model.selectedInput == d.id || (model.selectedInput == nil && model.activeInput?.id == d.id)) {
                            model.chooseInput(d.id)
                        }
                    }
                }
            }

            Picker("Speaker", selection: Binding(get: { model.selectedOutput ?? "" }, set: { model.chooseOutput($0.isEmpty ? nil : $0) })) {
                Text(automaticLabel(model.activeOutput)).tag("")
                ForEach(model.outputDevices) { d in Text(d.name).tag(d.id) }
            }

            VStack(alignment: .leading, spacing: 6) {
                Picker("Echo cancellation", selection: Binding(get: { model.echoCancellation }, set: { model.chooseEchoCancellation($0) })) {
                    ForEach(["automatic", "always", "never"], id: \.self) { Text(SettingsText.echoCancellationLabel($0)).tag($0) }
                }
                FieldHelp(SettingsText.echoCancellationHelp(model.echoCancellation))
            }

            VStack(alignment: .leading, spacing: 6) {
                LabeledContent("Echo") {
                    Button(model.echoRunning ? "Testing…" : "Test echo") { Task { await model.runEchoTest() } }
                        .disabled(model.echoRunning || model.state.sendCommand == nil)
                }
                // The verdict's colour rides on a symbol; the words stay primary so they
                // keep full contrast (system green/orange text on white is about 2:1).
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if let sym = echoSymbol {
                        Image(systemName: sym).foregroundStyle(echoTone).accessibilityHidden(true)
                    }
                    Text(model.echoSummary)
                        .foregroundStyle(model.echoError != nil ? Color.red : Color.primary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(.callout)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.updatesFrequently)
                FieldHelp("\(SettingsText.echoHelp) \(model.echoGuard)")
            }
        } header: { Text("Audio") }
    }

    private var echoSymbol: String? {
        if model.echoError != nil { return "xmark.octagon.fill" }
        switch model.echoResult?.level {
        case "heavy": return "exclamationmark.triangle.fill"
        case "good": return "checkmark.circle.fill"
        case nil: return nil
        default: return "info.circle.fill"
        }
    }

    private var echoTone: Color {
        if model.echoError != nil { return .red }
        switch model.echoResult?.level { case "heavy": return .orange; case "good": return .green; default: return .primary }
    }

    private func automaticLabel(_ active: DeviceChoice?) -> String {
        if let a = active { return "\(SettingsText.automaticDevice) (\(a.name))" }
        return SettingsText.automaticDevice
    }

    // MARK: Key

    private var keySection: some View {
        Section {
            KeySettingsRow(model: model)
        } header: { Text("OpenAI API key") }
    }

    // MARK: App

    private var appSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Picker("Open voice in", selection: Binding(get: { model.window }, set: { model.setWindow($0) })) {
                    ForEach(model.windowModes, id: \.self) { Text(SettingsText.windowLabel($0)).tag($0) }
                }
                FieldHelp(SettingsText.windowHelp(model.window), error: model.error("window"))
            }
            if model.hooks.setLaunchAtLogin != nil {
                VStack(alignment: .leading, spacing: 6) {
                    Toggle("Open at login", isOn: Binding(get: { model.loginItem == .on || model.loginItem == .requiresApproval },
                                                          set: { model.setLaunchAtLogin($0) }))
                        .disabled(model.loginItem == .unavailable)
                    FieldHelp(SettingsText.loginHelp(model.loginItem), error: model.error("login"))
                }
            }
            HStack {
                if let open = model.hooks.openLogs { Button("Open Logs") { open() } }
                Button("Open in Browser") { model.openBrowser() }
                    .disabled(model.state.sendCommand == nil)
                Spacer()
                if let v = model.settings?.version { Text("Sotto \(v)").font(.caption).foregroundStyle(.secondary) }
            }
            if let e = model.error("browser") { FieldHelp("", error: e) }
        } header: { Text("App") }
    }
}

// MARK: - Pieces

/// Secondary help text under a control; an error replaces it in red.
struct FieldHelp: View {
    let text: String; let error: String?
    init(_ text: String, error: String? = nil) { self.text = text; self.error = error }
    var body: some View {
        let shown = error ?? text
        if !shown.isEmpty {
            Text(shown)
                .font(.caption)
                .foregroundStyle(error == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(Color.red))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Segmented level bar (0...1 RMS, shown on a dB-ish curve so speech fills it).
public struct LevelMeter: View {
    public var level: Float
    public var segments: Int
    public init(level: Float, segments: Int = 10) { self.level = level; self.segments = segments }
    public var body: some View {
        let lit = Self.litSegments(level: level, segments: segments)
        HStack(spacing: 2) {
            ForEach(0..<segments, id: \.self) { i in
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(i < lit ? Self.color(i, of: segments) : Color.secondary.opacity(0.18))
            }
        }
        .animation(.linear(duration: 0.08), value: lit)
        .accessibilityValue("\(Int((Double(lit) / Double(max(segments, 1))) * 100)) percent")
    }
    /// -54 dBFS .. -6 dBFS mapped across the segments.
    public static func litSegments(level: Float, segments: Int) -> Int {
        guard level > 0 else { return 0 }
        let db = 20 * log10(Double(level))
        let t = min(max((db + 54) / 48, 0), 1)
        return Int((t * Double(segments)).rounded())
    }
    static func color(_ i: Int, of n: Int) -> Color {
        let t = Double(i) / Double(max(n - 1, 1))
        return t > 0.85 ? .orange : .green
    }
}

struct MicCompareRow: View {
    let device: DeviceChoice; let level: Float; let chosen: Bool; let choose: () -> Void
    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text(device.name).lineLimit(1).truncationMode(.middle)
                if device.bluetooth { Text("Bluetooth").font(.caption2).foregroundStyle(.secondary) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            LevelMeter(level: level, segments: 12).frame(width: 110, height: 10)
            if chosen {
                Image(systemName: "checkmark").foregroundStyle(.tint).frame(width: 44).accessibilityLabel("In use")
            } else {
                Button("Use", action: choose).controlSize(.small).frame(width: 44)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct VoiceGrid: View {
    let model: SettingsModel
    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: 6)], alignment: .leading, spacing: 6) {
            ForEach(model.voices, id: \.self) { v in
                let playing = model.previewing == v
                Button { model.togglePreview(v) } label: {
                    HStack(spacing: 5) {
                        Image(systemName: playing ? "stop.fill" : "play.fill").font(.caption2).frame(width: 10)
                        Text(SettingsText.voiceLabel(v)).lineLimit(1)
                        if v == model.voice { Spacer(minLength: 0); Image(systemName: "checkmark").font(.caption2).foregroundStyle(.secondary) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .accessibilityLabel(playing ? "Stop \(SettingsText.voiceLabel(v)) sample" : "Play \(SettingsText.voiceLabel(v)) sample")
            }
        }
        .padding(.vertical, 2)
    }
}

/// The key row: "Key ending in abcd" + Change/Remove, with an inline secure field.
struct KeySettingsRow: View {
    let model: SettingsModel
    @State private var editing = false
    @State private var draft = ""
    @State private var confirmRemove = false

    var body: some View {
        let row = model.keyRow
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(row.text, systemImage: model.status?.key?.present == true ? "key.fill" : "key")
                    .labelStyle(.titleAndIcon)
                Spacer()
                if row.change && !editing {
                    Button(row.changeLabel) { editing = true; model.clearKeyFeedback() }
                }
                if row.remove && !editing {
                    Button("Remove", role: .destructive) { confirmRemove = true }
                        .confirmationDialog("Remove the key from your Keychain?", isPresented: $confirmRemove) {
                            Button("Remove Key", role: .destructive) { Task { await model.removeKey() } }
                        } message: {
                            Text("The current voice session keeps running; the next one needs a key.")
                        }
                }
            }
            if editing {
                KeyEntryField(model: model, draft: $draft, autoFocus: true) { ok in
                    if ok { editing = false }
                } cancel: { editing = false; draft = ""; model.clearKeyFeedback() }
            }
            if let m = model.keyMessage, !editing { FieldHelp(m) }
            else if !editing { FieldHelp(row.help, error: model.keyError) }
        }
        .disabled(model.keyBusy && !editing)
    }
}

/// The secure field + Save shared by settings and onboarding. The draft lives only in view state
/// and is cleared the moment it is sent.
struct KeyEntryField: View {
    let model: SettingsModel
    @Binding var draft: String
    var autoFocus = false
    var done: (Bool) -> Void
    var cancel: (() -> Void)?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                SecureField("sk-...", text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.password)
                    .focused($focused)
                    .onSubmit(submit)
                    .disabled(model.keyBusy)
                    .accessibilityLabel("OpenAI API key")
                if let cancel { Button("Cancel", action: cancel).disabled(model.keyBusy) }
                Button(action: submit) {
                    if model.keyBusy { ProgressView().controlSize(.small).frame(width: 34) } else { Text("Save").frame(minWidth: 34) }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(model.keyBusy || draft.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if model.keyBusy { FieldHelp("Checking the key with OpenAI…") }
            else if let e = model.keyError { FieldHelp("", error: e) }
        }
        .onAppear { if autoFocus { focused = true } }
    }

    private func submit() {
        guard !model.keyBusy else { return }
        let key = draft
        // A malformed paste stays in the field so it can be fixed; saveKey reports the problem.
        if SettingsText.keyInputProblem(key) != nil { Task { await model.saveKey(key) }; return }
        draft = ""
        Task { done(await model.saveKey(key)) }
    }
}
