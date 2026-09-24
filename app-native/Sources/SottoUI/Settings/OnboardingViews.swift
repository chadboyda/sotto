// Onboarding cards (docs/NATIVE.md §5.4): microphone permission, then the API key.
// The panel shows `OnboardingView` in place of the dial while `model.onboardingStep` is non-nil.
import SwiftUI
import SottoClient

public struct OnboardingView: View {
    let model: SettingsModel
    public init(model: SettingsModel) { self.model = model }
    public var body: some View {
        switch model.onboardingStep {
        case .microphone?: MicAccessView(model: model)
        case .apiKey?: KeySetupView(model: model)
        case nil: EmptyView()
        }
    }
}

/// Explains the microphone and asks macOS (or opens the privacy pane once denied).
public struct MicAccessView: View {
    let model: SettingsModel
    public init(model: SettingsModel) { self.model = model }

    public var body: some View {
        if let card = SettingsText.micCard(model.micPermission) {
            OnboardingCard(symbol: model.micPermission == .denied || model.micPermission == .restricted ? "mic.slash" : "mic",
                           tint: model.micPermission == .denied || model.micPermission == .restricted ? .orange : .accentColor,
                           title: card.title, text: card.body) {
                if !card.steps.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(card.steps.enumerated()), id: \.offset) { i, s in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text("\(i + 1).").monospacedDigit().foregroundStyle(.secondary)
                                Text(s).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .font(.callout)
                }
                if let b = card.button {
                    Button(b) { Task { await model.requestMic() } }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .keyboardShortcut(.defaultAction)
                }
                if let n = card.note { FieldHelp(n) }
            }
        }
    }
}

/// First-run / rejected-key card: a secure field whose contents go only into `cmd key_save`.
public struct KeySetupView: View {
    let model: SettingsModel
    @State private var draft = ""
    public init(model: SettingsModel) { self.model = model }

    public var body: some View {
        let card = model.keyCard ?? SettingsText.KeyCard(title: "Add your OpenAI API key to start",
                                                         body: "\(SettingsText.keyIntro) \(SettingsText.keyKeep)", keyInput: true)
        OnboardingCard(symbol: "key", tint: model.status?.last_error?.code == "openai_auth" ? .orange : .accentColor,
                       title: card.title, text: card.body) {
            if card.keyInput {
                KeyEntryField(model: model, draft: $draft, autoFocus: true) { _ in }
                if let m = model.keyMessage { FieldHelp(m) }
                Link("Get a key at platform.openai.com", destination: URL(string: "https://platform.openai.com/api-keys")!)
                    .font(.callout)
            }
        }
    }
}

/// Shared card layout: icon, title, body, then actions.
struct OnboardingCard<Actions: View>: View {
    let symbol: String; let tint: Color; let title: String; let text: String
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(tint)
                .frame(width: 44, height: 44)
                .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityHidden(true)
            Text(title)
                .font(.title3.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text(text)
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            actions
        }
        .frame(maxWidth: 400, alignment: .leading)
        .padding(20)
        .frame(maxWidth: .infinity)
    }
}
