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
                .padding(.leading, 16).padding(.trailing, 8).padding(.top, 12).padding(.bottom, 8)
            if let b = model.topBanner {
                BannerView(model: model, banner: b, more: max(0, model.banners.count - (model.banners.first?.key == b.key ? 1 : 0)))
                    .padding(.horizontal, 16).padding(.bottom, 6)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            // The dial takes the room that is left (the page's --dial clamp), so the Claude
            // card, the captions and the footer keep their places.
            // The Claude card sits under the word and has room reserved for its tallest
            // collapsed form, so it grows into that room and the captions stay put.
            GeometryReader { geo in
                let cap = Self.summaryCap(v, region: geo.size.height)
                let d = Self.dialSize(v, available: geo.size.height - reserve(cap))
                // ImageRenderer draws no ScrollView content, so a still frame lays out flat.
                Group {
                    if stillAt != nil { middle(v, t, dial: d).frame(width: geo.size.width, height: geo.size.height, alignment: .top).clipped() } else {
                        ScrollView(.vertical) { middle(v, t, dial: d) }.scrollIndicators(.never)
                    }
                }
                .environment(\.sottoSummaryCap, cap)
            }
            CaptionsView(captions: model.captions)
                .background(PanelFrames.reader("captions"))
                .padding(.horizontal, 16).padding(.bottom, 10)
            Divider().overlay(t.line)
            FooterView(model: model, view: v)
                .padding(.horizontal, 16).padding(.vertical, 12)
        }
        .background(t.bg)
        .foregroundStyle(t.fg)
        .coordinateSpace(name: PanelFrames.space)
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

    private func middle(_ v: ViewText.PageView, _ t: Theme, dial size: CGFloat) -> some View {
        VStack(spacing: 14) {
            if v.dial != "hidden" { dial(v, t, size: size) }
            StatusWordView(view: v, model: model)
            if let steps = v.steps { StepsView(steps: steps) }
            if v.view == "card", let card = v.card { StateCardView(model: model, card: card) }
            ClaudeCardView(model: model, stillAt: stillAt, live: v.view == "live")
                .background(PanelFrames.reader("claude"))
        }
        .padding(.horizontal, 16).padding(.bottom, 12)
        .frame(maxWidth: .infinity)
    }

    /// Room kept under the word for the Claude card: its tallest collapsed form, or the
    /// expanded summary's capped scroller while "More" is open.
    private func reserve(_ cap: CGFloat) -> CGFloat {
        model.summaryExpanded && model.claudeCard.kind == "finished" ? ClaudeCardView.collapsedHeight - ClaudeCardView.collapsedSummary + cap : ClaudeCardView.collapsedHeight
    }

    /// The expanded summary's scroller: up to 220 pt, less in a short panel, so the dial at
    /// its smallest, the word and the whole card still fit above the captions.
    static func summaryCap(_ v: ViewText.PageView, region h: CGFloat) -> CGFloat {
        let above: CGFloat = (v.dial == "full" ? 120 + 4 : v.dial == "hidden" ? 0 : 150) + 14 + 62 + 12
        let chrome = ClaudeCardView.collapsedHeight - ClaudeCardView.collapsedSummary
        return min(ClaudeCardView.expandedCap, max(60, (h - above - chrome).rounded(.down)))
    }

    /// The full dial fills the height left over after the word and its hint (120...264 pt);
    /// the small one stays 150 pt over a state card.
    static func dialSize(_ v: ViewText.PageView, available h: CGFloat) -> CGFloat {
        guard v.dial == "full" else { return 150 }
        return min(264, max(120, (h - 96).rounded(.down)))
    }

    private func dial(_ v: ViewText.PageView, _ t: Theme, size: CGFloat) -> some View {
        let full = v.dial == "full"
        return DialContainer(model: model, floor: v.floor, attention: model.attention && v.view == "live", stillAt: stillAt)
            .frame(width: size, height: size)
            .frame(maxWidth: .infinity)
            .padding(.top, full ? 4 : 0)
            .animation(.spring(duration: 0.35), value: size)
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

/// The header (web/index.html `.top`, SPEC-DEVIATIONS "header pills"): the status
/// glyph and word with the detail and project under it on the left; on the right the
/// usage readout (Session while live, Today, Cost; one quiet capsule) and the gear. Ticks once a second.
struct HeaderView: View {
    let model: StateModel
    let view: ViewText.PageView
    var stillAt: Double?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let now = stillAt.map { Date(timeIntervalSinceReferenceDate: $0) } ?? ctx.date
            HeaderContent(key: view.header.key, label: view.header.label, detail: view.header.detail, project: model.project,
                          pills: model.status == nil ? nil : model.usagePills(at: now), openSettings: model.openSettings)
        }
    }
}

/// The header's layout, separate from the model so tests can tick the pills through
/// fixed values (HeaderLayoutTests). When the row is short of room, whole items hide in
/// the page's order (web/header.js fitHeader): the project, the detail, Today, then
/// Session. Cost always stays.
struct HeaderContent: View {
    let key: String
    let label: String
    let detail: String?
    let project: String?
    let pills: ViewText.UsagePills?
    var openSettings: (() -> Void)?
    @Environment(\.colorScheme) private var scheme

    /// What one candidate row shows.
    struct Shown: Equatable { var project = true, detail = true, session = true, today = true }

    static let candidates: [Shown] = [
        Shown(),
        Shown(project: false),
        Shown(project: false, detail: false),
        Shown(project: false, detail: false, today: false),
        Shown(project: false, detail: false, session: false, today: false),
    ]

    var body: some View {
        let t = Theme.of(scheme)
        ViewThatFits(in: .horizontal) {
            ForEach(Array(Self.candidates.enumerated()), id: \.offset) { _, c in row(t, c) }
        }
        .coordinateSpace(name: PillFrames.space)
    }

    private func row(_ t: Theme, _ c: Shown) -> some View {
        HStack(alignment: .center, spacing: 0) {
            status(t, c).layoutPriority(1)
            Spacer(minLength: 12)
            if let p = pills { usage(t, p, c) }
            Button { openSettings?() } label: {
                Image(systemName: "gearshape").font(.system(size: 16)).foregroundStyle(t.fg2)
                    .frame(width: 36, height: 36).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.leading, 8)
            .accessibilityLabel("Settings")
            .help("Settings")
            .disabled(openSettings == nil)
        }
        .frame(minHeight: 36)
    }

    /// The usage readout (design/pills-v2, variant D; web/styles.css `.usage`): one flat
    /// capsule, the shown slots split by hairlines. Ambient metadata under the status:
    /// no ring, no lift, nothing that reads as a button.
    private func usage(_ t: Theme, _ p: ViewText.UsagePills, _ c: Shown) -> some View {
        var slots: [UsagePill] = []
        if c.session, let s = p.session { slots.append(UsagePill(name: "Session", pill: s, kind: .clock, help: "This voice session")) }
        if c.today { slots.append(UsagePill(name: "Today", pill: p.today, kind: .clock, help: "Voice time billed today")) }
        slots.append(UsagePill(name: "Cost", pill: p.cost, kind: .cost, help: "Today's cost at $0.05 per minute"))
        return HStack(spacing: 0) {
            ForEach(Array(slots.enumerated()), id: \.element.name) { i, slot in
                if i > 0 { Rectangle().fill(t.hairline).frame(width: 1, height: 12).padding(.horizontal, 8).accessibilityHidden(true) }
                slot
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 24)
        .background(Capsule(style: .continuous).fill(t.fill))
        .fixedSize()
        .accessibilityElement(children: .combine)
    }

    private func status(_ t: Theme, _ c: Shown) -> some View {
        let color = t.headerColor(key)
        let detail = c.detail ? detail : nil
        let project = c.project ? project : nil
        return HStack(alignment: .top, spacing: 8) {
            Circle().fill(color).frame(width: 9, height: 9).padding(.top, 6)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                Text(label).font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(["live", "muted", "attention", "error"].contains(key) ? color : t.fg)
                    .lineLimit(1).fixedSize()
                if detail != nil || project != nil {
                    HStack(spacing: 4) {
                        if let d = detail { Text(d).fontWeight(.semibold).foregroundStyle(key == "muted" ? t.mute : t.fg2).fixedSize() }
                        if detail != nil && project != nil { Text("·").foregroundStyle(t.fg3) }
                        // Ideal width 56: a long name ellipsizes before the row gives it up.
                        if let p = project { Text(p).lineLimit(1).truncationMode(.middle).foregroundStyle(t.fg2).frame(idealWidth: 56) }
                    }
                    .font(.system(size: 12))
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Status: \(label)\(self.detail.map { ", \($0)" } ?? "")\(self.project.map { ", project \($0)" } ?? "")")
    }
}

/// One usage slot: an 11 pt SF Symbol in fg3 (timer, calendar; the cost's "$" is its
/// own), then a 12 pt medium tabular figure in a box of fixed width, so a ticking figure
/// never moves anything. The box widens once: a clock at the hour, the cost at $100
/// (lib.usagePills `wide`). The name is spoken (accessibility label and tooltip), not shown.
struct UsagePill: View {
    enum Kind { case clock, cost }
    let name: String
    let pill: ViewText.Pill
    let kind: Kind
    var help: String = ""
    @Environment(\.colorScheme) private var scheme

    /// Session: timer; Today: calendar; Cost: none ("$" names it).
    var symbol: String? {
        switch name { case "Session": return "timer"; case "Today": return "calendar"; default: return nil }
    }

    static let figureSize: CGFloat = 12
    static let figureFont = Font.system(size: figureSize, weight: .medium).monospacedDigit()

    /// The widest text each slot must hold, measured once in the figure's font.
    static func figureWidth(_ kind: Kind, wide: Bool) -> CGFloat {
        switch (kind, wide) {
        case (.clock, false): return clockNarrow
        case (.clock, true): return clockWide
        case (.cost, false): return costNarrow
        case (.cost, true): return costWide
        }
    }
    static let clockNarrow = measure(["00:00"])
    static let clockWide = measure(["00:00:00"])
    static let costNarrow = measure(["$00.00", "<$0.01"])
    static let costWide = measure(["$000.00", "$0000.00"])

    static func measure(_ samples: [String]) -> CGFloat {
        let font = NSFont.monospacedDigitSystemFont(ofSize: figureSize, weight: .medium)
        let w = samples.map { ($0 as NSString).size(withAttributes: [.font: font]).width }.max() ?? 0
        return (w + 1).rounded(.up)
    }

    var body: some View {
        let t = Theme.of(scheme)
        HStack(alignment: .center, spacing: 4) {
            if let symbol {
                Image(systemName: symbol).font(.system(size: 10, weight: .medium)).foregroundStyle(t.fg3)
                    .frame(width: 11, height: 11).accessibilityHidden(true)
            }
            Text(pill.text).font(Self.figureFont).foregroundStyle(t.fg2).lineLimit(1)
                .frame(width: Self.figureWidth(kind, wide: pill.wide), alignment: .trailing)
        }
        .frame(height: 16)
        .fixedSize()
        .background(GeometryReader { g in
            Color.clear.preference(key: PillFrames.self, value: [name: g.frame(in: .named(PillFrames.space))])
        })
        .help(help)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(name) \(pill.text)")
    }
}

/// Where the Claude card and the captions sit in the panel (ClaudeCardLayoutTests).
struct PanelFrames: PreferenceKey {
    static let space = "sotto.panel"
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue()) { $1 }
    }
    static func reader(_ name: String) -> some View {
        GeometryReader { g in Color.clear.preference(key: PanelFrames.self, value: [name: g.frame(in: .named(space))]) }
    }
}

/// Where each pill sits in the header (tests read it through onPreferenceChange).
struct PillFrames: PreferenceKey {
    static let space = "sotto.header"
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue()) { $1 }
    }
}

// MARK: - Banner

struct BannerView: View {
    let model: StateModel
    let banner: StateModel.Banner
    let more: Int
    @Environment(\.colorScheme) private var scheme

    /// The page's banner (feat/ui-polish): a raised neutral surface; the tone is in the
    /// icon alone (amber for warnings, red for errors), never a tinted wash or a warm ring.
    var body: some View {
        let t = Theme.of(scheme)
        let icon = banner.level == "error" ? t.err : banner.level == "warn" ? t.attnIcon : t.fg3
        HStack(alignment: .center, spacing: 8) {
            Image(systemName: banner.level == "info" ? "info.circle" : banner.level == "error" ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill")
                .font(.system(size: 15)).foregroundStyle(icon).frame(width: 18).accessibilityHidden(true)
            Text(banner.text).font(.system(size: 13)).foregroundStyle(t.fg).fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, 7)
            Spacer(minLength: 4)
            if more > 0 { Text("+\(more)").font(.system(size: 12)).foregroundStyle(t.fg2).help("\(more) more") }
            if let a = banner.action {
                Button(Self.label(a)) { model.perform(a, banner: banner.key) }
                    .buttonStyle(PanelButtonStyle(color: t.fg, edge: .clear, fill: t.dark ? Color.white.opacity(0.06) : Color.black.opacity(0.05), compact: true))
            }
            Button {
                if banner.key == "cmd_error" { model.clearCommandError() } else { model.dismissBanner(key: banner.key) }
            } label: {
                Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(t.fg3)
                    .frame(width: 32, height: 32).contentShape(Rectangle())
            }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
                .help("Dismiss")
        }
        .padding(.leading, 12).padding(.trailing, 4).padding(.vertical, 4)
        .frame(minHeight: 48)
        .raised(t, radius: 14, lifted: true)
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
        // In the live view the word is one line and the line under it keeps its height,
        // so the Claude card and the captions never move when the floor changes
        // (SPEC-DEVIATIONS "Claude card, status word and timers" 6).
        let live = view.view == "live"
        VStack(spacing: 6) {
            Text(view.word)
                .font(.system(size: live ? 28 : (view.word.count > 18 ? 22 : 28), weight: .semibold, design: .default))
                .foregroundStyle(view.wordTone == "attn" ? t.attn : view.floor == "muted" ? t.mute : t.fg)
                .multilineTextAlignment(.center)
                .lineLimit(live ? 1 : nil)
                .minimumScaleFactor(live ? 0.6 : 1)
                .id(view.word)
                .transition(.opacity)
                .accessibilityAddTraits(.isHeader)
            subline(t)
                .lineLimit(live ? 1 : nil)
                .frame(height: live ? 22 : nil)
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
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: Self.icon(card)).foregroundStyle(card.tone == "neutral" ? t.fg2 : card.tone == "err" ? t.err : t.attnIcon).accessibilityHidden(true)
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
                .padding(.horizontal, 16).padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 12).fill(t.dark ? Color.white.opacity(0.06) : Color.black.opacity(0.05)))
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
        // A neutral raised surface in every tone (feat/ui-polish): the tone is in the icon.
        .raised(t, radius: 18)
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

/// The Claude Code card (web `.claude`, one card, four states). Its height is bounded
/// so it never pushes the captions or the footer: one line for Claude's words while it
/// works, a summary clamped to three lines when it finishes, with "More" for the rest
/// (then a capped, inset scroller). The ring is drawn outside the shape in every state,
/// so a state change never nudges the layout by a point.
struct ClaudeCardView: View {
    let model: StateModel
    var stillAt: Double?
    /// The live view always shows the card ("Claude is idle" as a quiet line), like the page.
    var live = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.sottoStill) private var still
    @Environment(\.sottoSummaryCap) private var cap

    /// Collapsed summary: three 15 pt lines at the page's 1.45 line height.
    static let summaryLine: CGFloat = 21
    static let collapsedSummary: CGFloat = summaryLine * 3
    /// Expanded summary: scrolls inside the card past this.
    static let expandedCap: CGFloat = 220
    /// The card's tallest forms (head, body, More, the request line, padding, the gap above).
    static let collapsedHeight: CGFloat = 14 + 12 + 20 + 4 + collapsedSummary + 4 + 24 + 4 + 18 + 12

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let now = stillAt.map { Date(timeIntervalSinceReferenceDate: $0) } ?? ctx.date
            content(now: now)
        }
    }

    static func isLong(_ summary: String) -> Bool {
        summary.count >= 150 || summary.contains("```") || summary.range(of: "\n\\s*\n", options: .regularExpression) != nil
    }

    @ViewBuilder private func content(now: Date) -> some View {
        let t = Theme.of(scheme)
        let card = model.claudeCard
        // The paused/sleeping card already shows the pending result: don't repeat it.
        let repeated = card.kind == "finished" && model.pageView.card?.pending != nil
        if !repeated && (live || card.kind != "idle" || card.agents != nil || model.requestLine != nil) {
            let raised = card.kind != "idle"
            VStack(alignment: .leading, spacing: 4) {
                head(t, card, now: now)
                if card.kind == "working", let step = card.step {
                    Text(step).font(.system(size: card.secondary == true ? 13 : 15)).foregroundStyle(card.secondary == true ? t.fg2 : t.fg)
                        .lineLimit(1).truncationMode(.tail)
                        .frame(maxWidth: .infinity, minHeight: 21, alignment: .leading)
                        .contentTransition(.opacity)
                        .animation(.easeInOut(duration: 0.2), value: step)
                }
                if card.kind == "approval" {
                    if let cmd = card.command {
                        Text(cmd).font(.system(size: 13, weight: .medium, design: .monospaced)).foregroundStyle(t.fg)
                            .lineLimit(5).padding(.horizontal, 12).padding(.vertical, 8).frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 6).fill(t.dark ? Color.white.opacity(0.06) : Color.black.opacity(0.05)))
                            .textSelection(.enabled)
                            .padding(.top, 4)
                    }
                    if let note = card.note { Text(note).font(.system(size: 13)).foregroundStyle(t.fg) }
                }
                if card.kind == "finished", let summary = card.summary { summaryView(t, summary) }
                if let r = model.requestLine {
                    Text(r.text).font(.system(size: 13)).foregroundStyle(r.tone == "error" ? t.err : r.tone == "warn" ? t.attn : t.fg3)
                        .lineLimit(1).truncationMode(.tail)
                }
            }
            .padding(.horizontal, raised ? 12 : 0).padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .modifier(CardSurface(theme: t, kind: card.kind))
            .accessibilityElement(children: .contain)
            .accessibilityLabel(card.title)
        }
    }

    private func head(_ t: Theme, _ card: ViewText.ClaudeCard, now: Date) -> some View {
        HStack(spacing: 8) {
            Group {
                switch card.kind {
                // Static on purpose (as on the page): the dial's bezel chase already says "working".
                case "working":
                    Circle().trim(from: 0, to: 0.75).stroke(t.work, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                        .rotationEffect(.degrees(45)).frame(width: 12, height: 12)
                case "approval": Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 13)).foregroundStyle(t.attnIcon)
                case "finished": Image(systemName: "checkmark.circle.fill").font(.system(size: 14)).foregroundStyle(t.live)
                default: Circle().strokeBorder(t.fg3, lineWidth: 2).frame(width: 14, height: 14)
                }
            }
            .frame(width: 16, height: 16)
            .accessibilityHidden(true)
            Text(card.title).font(.system(size: card.kind == "approval" ? 15 : 13, weight: card.kind == "idle" ? .regular : .semibold))
                .foregroundStyle(card.kind == "working" ? t.work : card.kind == "approval" ? t.attn : card.kind == "idle" ? t.fg2 : t.fg)
                .lineLimit(1).fixedSize()
                .layoutPriority(1)
            Spacer(minLength: 4)
            if let a = card.agents {
                // The background agents are a quiet chip; their work never reaches the card's
                // text. Short of room it keeps the count ("2 agents").
                let n = a.split(separator: " ").first.map(String.init) ?? ""
                ViewThatFits(in: .horizontal) {
                    agentsChip(t, a)
                    agentsChip(t, n == "1" ? "1 agent" : "\(n) agents")
                }
                .help(a)
                .accessibilityLabel(a)
            }
            if let w = model.workingTime(at: now) {
                Text(w).font(.system(size: 12)).monospacedDigit().foregroundStyle(t.fg3).lineLimit(1).fixedSize()
            }
        }
        .frame(minHeight: 20)
    }

    private func agentsChip(_ t: Theme, _ text: String) -> some View {
        Label(text, systemImage: "person.2").labelStyle(.titleAndIcon)
            .font(.system(size: 11, weight: .medium)).foregroundStyle(t.fg2).lineLimit(1)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(Capsule().fill(t.surface2))
            .fixedSize()
    }

    @ViewBuilder private func summaryView(_ t: Theme, _ summary: String) -> some View {
        let long = Self.isLong(summary)
        let expanded = model.summaryExpanded && long
        Group {
            if expanded {
                // Short enough: no scroller. Longer: a capped scroll view whose scroller sits
                // in the card's trailing padding, inset from the rounded corner, with the text
                // padded clear of it, so nothing is under the bar or clipped by the radius.
                ViewThatFits(in: .vertical) {
                    MarkdownText(markdown: summary, expanded: true).padding(.trailing, 4)
                    if still {
                        // ImageRenderer draws no ScrollView content: the same frame, clipped,
                        // with the overlay scroller where AppKit would draw it.
                        MarkdownText(markdown: summary, expanded: true)
                            .padding(.trailing, 16)
                            .frame(maxWidth: .infinity, maxHeight: cap, alignment: .topLeading)
                            .clipped()
                            .overlay(alignment: .topTrailing) {
                                Capsule().fill(t.fg3.opacity(0.45)).frame(width: 6, height: 70).padding(.top, 3).offset(x: 5)
                            }
                            .frame(height: cap)
                    } else {
                    ScrollView(.vertical) {
                        MarkdownText(markdown: summary, expanded: true)
                            .padding(.trailing, 16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .scrollIndicators(.automatic)
                    .frame(height: cap)
                    .padding(.trailing, -8)
                    }
                }
            } else {
                MarkdownText(markdown: summary, expanded: false)
                    .frame(maxWidth: .infinity, maxHeight: Self.collapsedSummary, alignment: .topLeading)
                    .clipped()
            }
        }
        .font(.system(size: 15))
        .foregroundStyle(t.fg)
        .textSelection(.enabled)
        if long {
            Button { model.summaryExpanded.toggle() } label: {
                Text(model.summaryExpanded ? "Less" : "More").font(.system(size: 13, weight: .semibold)).foregroundStyle(t.work)
                    .frame(minHeight: 24).contentShape(Rectangle())
            }
                .buttonStyle(.plain)
                .accessibilityValue(model.summaryExpanded ? "expanded" : "collapsed")
        }
    }
}

/// The card's surface per state (web `body[data-claude=…] .claude`): idle is a quiet line
/// under a hairline; working, finished and approval are raised (radius 18); working has a
/// work-coloured ring, approval a 1.5 pt amber ring (neutral fill in light).
struct CardSurface: ViewModifier {
    let theme: Theme
    let kind: String
    func body(content: Content) -> some View {
        switch kind {
        case "idle":
            content.overlay(alignment: .top) { Rectangle().fill(theme.line).frame(height: 1) }
        case "working":
            content.raised(theme, radius: 18, ring: theme.work.opacity(0.4))
        case "approval":
            content.raised(theme, radius: 18, fill: theme.attnTint, ring: theme.attnEdge, ringWidth: 1.5, lifted: true)
        default:
            content.raised(theme, radius: 18)
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
private struct SummaryCapKey: EnvironmentKey { static let defaultValue: CGFloat = ClaudeCardView.expandedCap }
extension EnvironmentValues {
    /// The expanded summary's height cap for the room the panel has.
    var sottoSummaryCap: CGFloat {
        get { self[SummaryCapKey.self] }
        set { self[SummaryCapKey.self] = newValue }
    }
    /// A still frame (snapshots): no timelines, no AppKit-backed controls.
    var sottoStill: Bool {
        get { self[StillKey.self] }
        set { self[StillKey.self] = newValue }
    }
}
