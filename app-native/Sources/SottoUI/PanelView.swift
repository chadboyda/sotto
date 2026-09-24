// The floating panel's root view (docs/NATIVE.md §5.4): the page's information design
// (design/final) in native SwiftUI. Top to bottom: header, banner, dial, status word,
// connect steps or a state card, the Claude card, captions, footer.
import SwiftUI
import AppKit
import SottoClient

/// Root view of the floating panel.
public struct PanelView: View {
    let model: StateModel
    @Environment(\.colorScheme) private var scheme
    @FocusState private var focused: Bool
    /// Snapshot support: draw a still frame at this time.
    var stillAt: Double?

    public init(model: StateModel) { self.model = model }
    init(model: StateModel, stillAt: Double?) { self.model = model; self.stillAt = stillAt }

    public var body: some View {
        let t = Theme.of(scheme)
        let v = model.pageView
        VStack(spacing: 0) {
            HeaderView(model: model, view: v, stillAt: stillAt)
                .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 4)
            if let b = model.topBanner {
                BannerView(model: model, banner: b, more: max(0, model.banners.count - (model.banners.first?.key == b.key ? 1 : 0)))
                    .padding(.horizontal, 16).padding(.bottom, 6)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            // ImageRenderer draws no ScrollView content, so a still frame lays out flat.
            if stillAt != nil { middle(v, t); Spacer(minLength: 0) } else {
                ScrollView(.vertical) { middle(v, t) }.scrollIndicators(.never)
            }
            CaptionsView(captions: model.captions)
                .padding(.horizontal, 16).padding(.bottom, 10)
            Divider().overlay(t.line)
            FooterView(model: model, view: v)
                .padding(.horizontal, 16).padding(.vertical, 12)
        }
        .background(t.bg)
        .foregroundStyle(t.fg)
        .animation(.easeOut(duration: 0.2), value: model.topBanner?.key)
        // The root is focusable only to receive M / Space, and hides its own ring.
        // focusEffectDisabled propagates through the environment, so re-enable it for
        // the content: keyboard users (Tab, Full Keyboard Access) must see which
        // button has focus.
        .focusEffectDisabled(false)
        .focusable()
        .focusEffectDisabled()
        .focused($focused)
        .onKeyPress(characters: CharacterSet(charactersIn: "mM "), phases: .down) { press in
            let mods = !press.modifiers.intersection([.command, .control, .option]).isEmpty
            return model.handleKey(String(press.characters.prefix(1)), repeat_: press.phase == .repeat, modifiers: mods) ? .handled : .ignored
        }
        .onAppear { focused = true }
        .onChange(of: model.announcement?.seq) { _, _ in
            guard let a = model.announcement else { return }
            Self.announce(a.text, assertive: a.assertive)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Sotto")
        .environment(\.sottoStill, stillAt != nil)
    }

    private func middle(_ v: ViewText.PageView, _ t: Theme) -> some View {
        VStack(spacing: 14) {
            if v.dial != "hidden" { dial(v, t) }
            StatusWordView(view: v, model: model)
            if let steps = v.steps { StepsView(steps: steps) }
            if v.view == "card", let card = v.card { StateCardView(model: model, card: card) }
            ClaudeCardView(model: model, stillAt: stillAt)
        }
        .padding(.horizontal, 16).padding(.bottom, 12)
        .frame(maxWidth: .infinity)
    }

    private func dial(_ v: ViewText.PageView, _ t: Theme) -> some View {
        let full = v.dial == "full"
        return DialContainer(model: model, floor: v.floor, attention: model.attention && v.view == "live", stillAt: stillAt)
            .frame(width: full ? 264 : 150, height: full ? 264 : 150)
            .frame(maxWidth: .infinity)
            .padding(.top, full ? 4 : 0)
            .animation(.spring(duration: 0.35), value: full)
    }

    /// VoiceOver announcement (the page's aria-live regions).
    static func announce(_ text: String, assertive: Bool) {
        // The panel never becomes main and rarely key (non-activating), and VoiceOver drops
        // announcements posted on a hidden window, so prefer a visible window and fall
        // back to the application element.
        guard let app = NSApp else { return }
        let window: NSWindow? = app.keyWindow ?? app.windows.first(where: { $0.isVisible && $0 is NSPanel }) ?? app.windows.first(where: { $0.isVisible })
        let el: Any = window ?? app
        NSAccessibility.post(element: el, notification: .announcementRequested,
                             userInfo: [.announcement: text, .priority: (assertive ? NSAccessibilityPriorityLevel.high : .medium).rawValue])
    }
}

/// The dial is the only view that reads the audio levels, so level updates re-render it alone.
struct DialContainer: View {
    let model: StateModel
    let floor: String
    let attention: Bool
    var stillAt: Double?
    /// Bumped once sound stops, so the dial re-checks whether its timeline can pause.
    @State private var settleTick = 0

    var body: some View {
        let mic = Double(model.isSleeping ? model.wakeLevel : model.micLevel)
        let voice = Double(model.speakerLevel)
        let input = DialInput(floor: floor, working: model.claudeBusy && !model.attention, attention: attention, mic: mic, voice: voice)
        let muted = floor == "muted"
        let label = model.isSleeping ? (model.wakeMuted ? "Listen for your voice again" : "Stop listening for your voice")
            : muted ? "Unmute" : "Mute"
        let quiet = mic < 0.01 && voice < 0.01
        DialView(input: input, muteLabel: label, muteEnabled: model.isLive || model.isSleeping, stillAt: stillAt, settleTick: settleTick) {
            if model.isSleeping { model.wakeMuted.toggle() } else { model.toggleMute() }
        }
        .task(id: quiet) {
            guard quiet, stillAt == nil else { return }
            try? await Task.sleep(for: .milliseconds(1500))
            settleTick &+= 1
        }
    }
}

// MARK: - Header

struct HeaderView: View {
    let model: StateModel
    let view: ViewText.PageView
    var stillAt: Double?
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let t = Theme.of(scheme)
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 7) {
                    Circle().fill(t.headerColor(view.header.key)).frame(width: 9, height: 9)
                        .accessibilityHidden(true)
                    Text(view.header.label).font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(t.headerColor(view.header.key))
                    if let d = view.header.detail {
                        Text("· \(d)").font(.system(size: 13)).foregroundStyle(t.fg3)
                    }
                }
                if let p = model.project {
                    Text(p).font(.system(size: 12)).foregroundStyle(t.fg3).lineLimit(1).truncationMode(.middle)
                        .padding(.leading, 16)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Status: \(view.header.label)\(view.header.detail.map { ", \($0)" } ?? "")\(model.project.map { ", project \($0)" } ?? "")")
            Spacer(minLength: 8)
            usage(t)
            Button { model.openSettings?() } label: {
                Image(systemName: "gearshape").font(.system(size: 15)).foregroundStyle(t.fg2)
                    .frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Settings")
            .help("Settings")
            .disabled(model.openSettings == nil)
        }
    }

    @ViewBuilder private func usage(_ t: Theme) -> some View {
        if model.status != nil {
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                let now = stillAt.map { Date(timeIntervalSinceReferenceDate: $0) } ?? ctx.date
                let today = model.todaySeconds(at: now)
                let session = model.sessionClock(at: now)
                // Widest first; a long header label drops "Session", then the session clock.
                ViewThatFits(in: .horizontal) {
                    chip(t, session: session, sessionWord: true, today: today)
                    chip(t, session: session, sessionWord: false, today: today)
                    chip(t, session: nil, sessionWord: false, today: today)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(session.map { "Session \($0), " } ?? "")today \(ViewText.formatUsage(today))")
            }
        }
    }

    private func chip(_ t: Theme, session: String?, sessionWord: Bool, today: Double) -> some View {
        HStack(spacing: 4) {
            if let s = session {
                if sessionWord { Text("Session").foregroundStyle(t.fg3) }
                Text(s).monospacedDigit().fontWeight(.semibold)
                Text("·").foregroundStyle(t.fg3)
            }
            Text(ViewText.formatDuration(today)).monospacedDigit().fontWeight(.semibold)
            Text("·").foregroundStyle(t.fg3)
            Text(ViewText.formatCost(today)).monospacedDigit().fontWeight(.semibold)
            Text("today").foregroundStyle(t.fg3)
        }
        .font(.system(size: 12))
        .lineLimit(1)
        .fixedSize()
        .padding(.horizontal, 9).padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 8).fill(t.surface2))
    }
}

// MARK: - Banner

struct BannerView: View {
    let model: StateModel
    let banner: StateModel.Banner
    let more: Int
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let t = Theme.of(scheme)
        let color = banner.level == "error" ? t.err : banner.level == "warn" ? t.attn : t.fg2
        let tint = banner.level == "error" ? t.errTint : banner.level == "warn" ? t.attnTint : t.surface2
        HStack(alignment: .center, spacing: 8) {
            Image(systemName: banner.level == "info" ? "info.circle" : "exclamationmark.triangle.fill")
                .foregroundStyle(color).accessibilityHidden(true)
            Text(banner.text).font(.system(size: 13)).foregroundStyle(t.fg).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            if more > 0 { Text("+\(more)").font(.system(size: 11, weight: .semibold)).foregroundStyle(t.fg3).help("\(more) more") }
            if let a = banner.action {
                Button(Self.label(a)) { model.perform(a, banner: banner.key) }
                    .buttonStyle(PanelButtonStyle(color: t.fg, edge: color.opacity(0.6), fill: t.surface1, compact: true))
            }
            Button {
                if banner.key == "cmd_error" { model.clearCommandError() } else { model.dismissBanner(key: banner.key) }
            } label: {
                Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(t.fg3)
                    .frame(width: 24, height: 24).contentShape(Rectangle())
            }
                .buttonStyle(.plain)
                .padding(-3) // a 24 pt target without growing the banner
                .accessibilityLabel("Dismiss")
                .help("Dismiss")
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 10).fill(tint))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(color.opacity(0.35), lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(banner.level == "error" ? [.isHeader] : [])
    }

    static func label(_ a: StateModel.Banner.Action) -> String {
        switch a {
        case .switchMic: return "Switch mic"
        case .tryAgain: return "Try again"
        case .turnOnAudio: return "Turn on audio"
        }
    }
}

// MARK: - Status word

struct StatusWordView: View {
    let view: ViewText.PageView
    let model: StateModel
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let t = Theme.of(scheme)
        VStack(spacing: 6) {
            Text(view.word)
                .font(.system(size: view.word.count > 18 ? 22 : 28, weight: .semibold, design: .default))
                .foregroundStyle(view.wordTone == "attn" ? t.attn : view.floor == "muted" ? t.mute : t.fg)
                .multilineTextAlignment(.center)
                .id(view.word)
                .transition(.opacity)
                .accessibilityAddTraits(.isHeader)
            subline(t)
        }
        .animation(.easeInOut(duration: 0.25), value: view.word)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func subline(_ t: Theme) -> some View {
        if view.view == "live" && (view.floor == "listening" || view.floor == "you" || view.floor == "voice" || view.floor == "muted") && view.wordTone == nil {
            HStack(spacing: 5) {
                KeyCap("M"); Text("or").foregroundStyle(t.fg3); KeyCap("Space")
                Text(view.floor == "muted" ? "to unmute" : "to mute").foregroundStyle(t.fg3)
                if view.floor == "muted" { Text("· Still billing").foregroundStyle(t.mute) }
            }
            .font(.system(size: 13))
            .accessibilityLabel(view.floor == "muted" ? "Press M or Space to unmute. Still billing." : "Press M or Space to mute.")
        } else if let sub = view.sub {
            Text(sub).font(.system(size: 13)).foregroundStyle(view.wordTone == "attn" ? t.fg2 : t.fg3).multilineTextAlignment(.center)
        }
    }
}

struct KeyCap: View {
    let text: String
    @Environment(\.colorScheme) private var scheme
    init(_ text: String) { self.text = text }
    var body: some View {
        let t = Theme.of(scheme)
        Text(text).font(.system(size: 12, weight: .medium)).foregroundStyle(t.fg2)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 5).fill(t.surface2))
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(t.edge.opacity(0.6), lineWidth: 1))
    }
}

// MARK: - Connect steps

struct StepsView: View {
    let steps: [ViewText.Step]
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let t = Theme.of(scheme)
        VStack(alignment: .leading, spacing: 6) {
            ForEach(steps, id: \.key) { s in
                HStack(spacing: 8) {
                    Group {
                        switch s.state {
                        case "done": Image(systemName: "checkmark.circle.fill").foregroundStyle(t.live)
                        case "active": Spinner(color: t.fg2)
                        default: Image(systemName: "circle").foregroundStyle(t.fg3)
                        }
                    }
                    .frame(width: 16, height: 16)
                    Text(s.label).font(.system(size: 13)).foregroundStyle(s.state == "pending" ? t.fg3 : t.fg)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(s.label): \(s.state == "done" ? "done" : s.state == "active" ? "in progress" : "waiting")")
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
    }
}

// MARK: - State card (paused, sleeping, off, errors, key, mic)

struct StateCardView: View {
    let model: StateModel
    let card: ViewText.Card
    @Environment(\.sottoStill) private var still
    @Environment(\.colorScheme) private var scheme
    @State private var keyText = ""
    @State private var keyError: String?
    @State private var saving = false

    var body: some View {
        let t = Theme.of(scheme)
        let accent = t.toneColor(card.tone)
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: Self.icon(card)).foregroundStyle(card.tone == "neutral" ? t.fg2 : accent).accessibilityHidden(true)
                Text(card.title).font(.system(size: 16, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
            }
            Text(card.body).font(.system(size: 13)).foregroundStyle(t.fg2).fixedSize(horizontal: false, vertical: true)
            if let steps = card.steps {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(steps.enumerated()), id: \.offset) { i, s in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("\(i + 1).").monospacedDigit().foregroundStyle(t.fg3)
                            Text(s).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .font(.system(size: 13))
                if let link = card.link {
                    Button(link.label) {
                        if let u = URL(string: link.href) { NSWorkspace.shared.open(u) }
                    }
                    .buttonStyle(PanelButtonStyle(color: t.fg, edge: t.edge, fill: t.surface1, compact: true))
                }
            }
            if let note = card.note { Text(note).font(.system(size: 12)).foregroundStyle(t.fg3).fixedSize(horizontal: false, vertical: true) }
            if let pending = card.pending {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Waiting for you").font(.system(size: 11, weight: .semibold)).foregroundStyle(t.fg3).textCase(.uppercase)
                    MarkdownText(markdown: pending, expanded: false).font(.system(size: 13))
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8).fill(t.surface2))
            }
            if card.keyInput { keyInput(t) }
            if let b = card.button {
                HStack {
                    Button(b) { model.perform(card.action) }
                        .buttonStyle(PanelButtonStyle(color: card.secondary ? t.fg : (t.dark ? t.bg : .white), edge: card.secondary ? t.edge : t.live,
                                                      fill: card.secondary ? t.surface1 : t.live, compact: true))
                        .keyboardShortcut(card.kbd ? KeyboardShortcut(.space, modifiers: []) : nil)
                    if card.kbd { Text("or press Space").font(.system(size: 12)).foregroundStyle(t.fg3) }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(card.tone == "neutral" ? t.surface1 : (card.tone == "err" ? t.errTint : t.attnTint)))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(card.tone == "neutral" ? t.line : accent.opacity(0.5), lineWidth: 1))
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private func keyInput(_ t: Theme) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Group {
                    if still {
                        // ImageRenderer cannot draw AppKit fields; a look-alike for the still frame.
                        Text("Paste your key (sk-...)").font(.system(size: 13)).foregroundStyle(t.fg3)
                            .padding(.horizontal, 8).frame(maxWidth: .infinity, minHeight: 24, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 5).fill(t.surface1))
                            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(t.edge.opacity(0.6)))
                    } else {
                        SecureField("Paste your key (sk-...)", text: $keyText).textFieldStyle(.roundedBorder)
                    }
                }
                    .accessibilityLabel("OpenAI API key")
                    .onSubmit(save)
                Button(saving ? "Checking…" : "Save key", action: save)
                    .buttonStyle(PanelButtonStyle(color: t.fg, edge: t.edge, fill: t.surface1, compact: true))
                    .disabled(saving || keyText.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if let e = keyError { Text(e).font(.system(size: 12)).foregroundStyle(t.err) }
        }
    }

    private func save() {
        let k = keyText
        guard !k.trimmingCharacters(in: .whitespaces).isEmpty, !saving else { return }
        saving = true
        keyError = nil
        Task { @MainActor in
            let err = await model.saveKey(k)
            saving = false
            // The key is never kept: cleared whatever the outcome.
            keyText = ""
            keyError = err?.message
        }
    }

    static func icon(_ c: ViewText.Card) -> String {
        switch c.kind {
        case "paused": return "pause.circle"
        case "cap": return "hourglass"
        case "sleeping": return "moon.zzz"
        case "off", "closed", "closing": return "power"
        case "apikey": return "key"
        case "permission": return "mic.badge.plus"
        case "lost", "disconnected": return "bolt.horizontal.circle"
        case "starting": return "waveform"
        case "replaced": return "rectangle.on.rectangle"
        default: return c.kind.hasPrefix("mic-") ? "mic.slash" : "exclamationmark.triangle"
        }
    }
}

// MARK: - Claude card

struct ClaudeCardView: View {
    let model: StateModel
    var stillAt: Double?
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let now = stillAt.map { Date(timeIntervalSinceReferenceDate: $0) } ?? ctx.date
            content(now: now)
        }
    }

    @ViewBuilder private func content(now: Date) -> some View {
        let t = Theme.of(scheme)
        let card = model.claudeCard
        // The paused/sleeping card already shows the pending result: don't repeat it.
        let repeated = card.kind == "finished" && model.pageView.card?.pending != nil
        if !repeated && (card.kind != "idle" || card.agents != nil || model.requestLine != nil) {
            let accent = card.kind == "approval" ? t.attn : card.kind == "working" ? t.work : card.kind == "finished" ? t.live : t.fg3
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Group {
                        switch card.kind {
                        case "working": Spinner(color: t.work)
                        case "approval": Image(systemName: "hand.raised.fill").foregroundStyle(t.attn)
                        case "finished": Image(systemName: "checkmark.circle.fill").foregroundStyle(t.live)
                        default: Image(systemName: "circle.dotted").foregroundStyle(t.fg3)
                        }
                    }
                    .frame(width: 16, height: 16)
                    .accessibilityHidden(true)
                    Text(card.title).font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(card.kind == "finished" || card.kind == "idle" ? t.fg : accent)
                    Spacer(minLength: 4)
                    if let w = model.workingTime(at: now) { Text(w).font(.system(size: 12)).monospacedDigit().foregroundStyle(t.fg3) }
                }
                if card.kind == "working", let step = card.step {
                    Text(step).font(.system(size: 14)).foregroundStyle(card.secondary == true ? t.fg2 : t.fg)
                        .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                        .contentTransition(.opacity)
                        .animation(.easeInOut(duration: 0.2), value: step)
                }
                if card.kind == "approval" {
                    if let cmd = card.command {
                        Text(cmd).font(.system(size: 12, design: .monospaced)).foregroundStyle(t.fg)
                            .lineLimit(4).padding(8).frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 6).fill(t.surface2))
                            .textSelection(.enabled)
                    }
                    if let note = card.note { Text(note).font(.system(size: 12)).foregroundStyle(t.attn) }
                }
                if card.kind == "finished", let summary = card.summary {
                    let long = summary.count >= 150 || summary.contains("```") || summary.range(of: "\n\\s*\n", options: .regularExpression) != nil
                    MarkdownText(markdown: summary, expanded: model.summaryExpanded)
                        .font(.system(size: 14))
                        .lineLimit(model.summaryExpanded ? nil : 4)
                        .textSelection(.enabled)
                    if long {
                        Button { model.summaryExpanded.toggle() } label: {
                            Text(model.summaryExpanded ? "Less" : "More").font(.system(size: 14, weight: .medium)).foregroundStyle(t.work)
                        }
                            .buttonStyle(.plain)
                            .accessibilityValue(model.summaryExpanded ? "expanded" : "collapsed")
                    }
                }
                if let r = model.requestLine {
                    Text(r.text).font(.system(size: 12)).foregroundStyle(r.tone == "error" ? t.err : r.tone == "warn" ? t.attn : t.fg3)
                        .lineLimit(2)
                }
                if let a = card.agents {
                    Label(a, systemImage: "person.2").font(.system(size: 11, weight: .medium)).foregroundStyle(t.fg2)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Capsule().fill(t.surface2))
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12).fill(card.kind == "approval" ? t.attnTint : t.surface1))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(card.kind == "working" ? t.work.opacity(0.6) : card.kind == "approval" ? t.attnEdge : t.line, lineWidth: 1))
            .accessibilityElement(children: .contain)
            .accessibilityLabel(card.title)
        }
    }
}

// MARK: - Markdown (Claude's words, rendered natively)

/// Claude's markdown as native text: paragraphs, bullet and numbered lists, headings as
/// bold lines, inline bold/italic/code/links (http/https only). Code blocks show as
/// "(code)" when collapsed and as monospaced text when expanded (lib.renderMarkdown).
struct MarkdownText: View {
    let markdown: String
    let expanded: Bool

    enum Block: Equatable { case para(String), bullet(String), number(Int, String), heading(String), code(String) }

    static func blocks(_ md: String) -> [Block] {
        var out: [Block] = []
        var para: [String] = []
        func flush() { if !para.isEmpty { out.append(.para(para.joined(separator: " "))); para = [] } }
        let lines = md.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var i = 0
        var n = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flush()
                let fence = String(trimmed.prefix(3))
                var body: [String] = []
                i += 1
                while i < lines.count && !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(fence) { body.append(lines[i]); i += 1 }
                out.append(.code(body.joined(separator: "\n")))
                i += 1; continue
            }
            if trimmed.isEmpty { flush(); n = 0; i += 1; continue }
            if let r = trimmed.range(of: "^[-*+•]\\s+", options: .regularExpression) {
                flush(); out.append(.bullet(String(trimmed[r.upperBound...]))); i += 1; continue
            }
            if let r = trimmed.range(of: "^\\d{1,3}[.)]\\s+", options: .regularExpression) {
                flush(); n += 1; out.append(.number(n, String(trimmed[r.upperBound...]))); i += 1; continue
            }
            if let r = trimmed.range(of: "^#{1,6}\\s+", options: .regularExpression) {
                flush(); out.append(.heading(String(trimmed[r.upperBound...]).trimmingCharacters(in: CharacterSet(charactersIn: "# ")))); i += 1; continue
            }
            if trimmed.range(of: "^([-*_])(\\s*\\1){2,}$", options: .regularExpression) != nil { flush(); i += 1; continue }
            para.append(trimmed.hasPrefix(">") ? String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces) : trimmed)
            i += 1
        }
        flush()
        return out
    }

    /// Inline markdown; links to anything but http(s) keep only their text.
    static func inline(_ s: String) -> AttributedString {
        var a = (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)))
            ?? AttributedString(s)
        for run in a.runs {
            if let url = run.link, !["http", "https"].contains(url.scheme?.lowercased() ?? "") { a[run.range].link = nil }
        }
        return a
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(Self.blocks(markdown).enumerated()), id: \.offset) { _, b in
                switch b {
                case .para(let s): Text(Self.inline(s)).fixedSize(horizontal: false, vertical: true)
                case .heading(let s): Text(Self.inline(s)).bold()
                case .bullet(let s):
                    HStack(alignment: .firstTextBaseline, spacing: 6) { Text("•"); Text(Self.inline(s)).fixedSize(horizontal: false, vertical: true) }
                case .number(let n, let s):
                    HStack(alignment: .firstTextBaseline, spacing: 6) { Text("\(n).").monospacedDigit(); Text(Self.inline(s)).fixedSize(horizontal: false, vertical: true) }
                case .code(let c):
                    if expanded {
                        Text(c).font(.system(size: 12, design: .monospaced)).padding(6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.12)))
                    } else {
                        Text("(code)").foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

// MARK: - Captions

/// Captions (design/c-ambient): the latest line large, the previous one dimmer.
struct CaptionsView: View {
    let captions: [ViewText.Caption]
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let t = Theme.of(scheme)
        let latest = captions.last
        let prev = captions.count > 1 ? captions[captions.count - 2] : nil
        VStack(alignment: .leading, spacing: 8) {
            if let p = prev {
                line(p, t, latest: false)
                    .opacity(p.session != latest?.session ? 0.5 : 0.75)
            }
            if let l = latest { line(l, t, latest: true) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.easeOut(duration: 0.15), value: latest?.id)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(latest.map { "\(ViewText.speakerLabel($0.role)) said: \($0.text)" } ?? "No captions yet")
        .accessibilityAddTraits(.updatesFrequently)
    }

    private func line(_ c: ViewText.Caption, _ t: Theme, latest: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 5) {
                Circle().fill(c.role == "assistant" ? t.voice : t.live).frame(width: 6, height: 6)
                Text(ViewText.speakerLabel(c.role)).font(.system(size: 12, weight: .semibold)).foregroundStyle(t.fg3)
            }
            Text(c.text)
                .font(.system(size: latest ? 17 : 14))
                .foregroundStyle(latest ? t.fg : t.fg2)
                .lineLimit(latest ? 3 : 1)
                .truncationMode(latest ? .head : .tail)
                .fixedSize(horizontal: false, vertical: true)
        }
        .id(c.id)
    }
}

// MARK: - Footer

struct FooterView: View {
    let model: StateModel
    let view: ViewText.PageView
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let t = Theme.of(scheme)
        let st = model.status?.state ?? "off"
        let linked = model.phase != "boot" && model.phase != "lost"
        HStack {
            if st == "paused" || st == "sleeping" {
                Button { model.resume() } label: { Label(st == "sleeping" ? "Wake now" : "Resume", systemImage: "play.fill") }
                    .buttonStyle(PanelButtonStyle(color: t.fg, edge: t.edge, fill: t.surface1))
                    .disabled(view.card?.kind == "cap")
            } else {
                Button { model.pause() } label: { Label("Pause", systemImage: "pause") }
                    .buttonStyle(PanelButtonStyle(color: t.fg, edge: t.edge, fill: t.surface1))
                    .disabled(!(["live", "connecting", "reconnecting", "waiting_page"].contains(st)))
            }
            Spacer()
            Button { model.end() } label: { Label("End voice", systemImage: "power") }
                .buttonStyle(PanelButtonStyle(color: t.err, edge: t.err.opacity(0.7), fill: t.surface1))
                .disabled(st == "off" || st == "closing")
                .help("Turn voice off (same as /talk off)")
        }
        .disabled(!linked)
    }
}

/// The footer's large bordered buttons (design/final: Pause and End voice).
struct PanelButtonStyle: ButtonStyle {
    let color: Color, edge: Color, fill: Color
    var compact = false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: compact ? 13 : 15, weight: .medium))
            .foregroundStyle(color)
            .padding(.horizontal, compact ? 10 : 18).frame(minWidth: compact ? 0 : 110, minHeight: compact ? 26 : 40)
            .background(RoundedRectangle(cornerRadius: compact ? 7 : 10).fill(fill.opacity(configuration.isPressed ? 0.7 : 1)))
            .overlay(RoundedRectangle(cornerRadius: compact ? 7 : 10).strokeBorder(edge, lineWidth: 1))
            .opacity(enabled ? 1 : 0.45)
            .contentShape(RoundedRectangle(cornerRadius: compact ? 7 : 10))
    }
}

/// A small activity arc (ProgressView is an AppKit control that still frames cannot draw).
struct Spinner: View {
    let color: Color
    @Environment(\.sottoStill) private var still
    @Environment(\.accessibilityReduceMotion) private var reduce
    var body: some View {
        if still || reduce {
            arc(0)
        } else {
            TimelineView(.animation) { ctx in arc(ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1) * 360) }
        }
    }
    private func arc(_ deg: Double) -> some View {
        Circle().trim(from: 0, to: 0.72).stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
            .rotationEffect(.degrees(deg)).frame(width: 13, height: 13)
    }
}

private struct StillKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    /// A still frame (snapshots): no timelines, no AppKit-backed controls.
    var sottoStill: Bool {
        get { self[StillKey.self] }
        set { self[StillKey.self] = newValue }
    }
}
