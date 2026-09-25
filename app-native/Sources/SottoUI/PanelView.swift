// The floating panel's root view (docs/NATIVE.md §5.4), in the Filament + Orrery design
// (design/concepts-v2/hybrid): one lit string across the panel, a page of New York serif
// below it, the peg on the left as the mute control, and Orrery's moments grafted on
// (the eclipse approval, the sunrise wake, tides from the voice, milestone stars,
// Claude's news as the headline, a moon-phase glyph for Claude).
//
// Every zone is a fixed box (HybridLayout): content changes inside a zone with a
// cross-fade and no zone ever resizes, so nothing on screen jumps when the state changes.
import SwiftUI
import AppKit
import SottoClient

/// Root view of the floating panel.
public struct PanelView: View {
    let model: StateModel
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    @FocusState private var focused: Bool
    /// Snapshot support: draw a still frame at this time.
    var stillAt: Double?

    public init(model: StateModel) { self.model = model }
    init(model: StateModel, stillAt: Double?) { self.model = model; self.stillAt = stillAt }

    public var body: some View {
        GeometryReader { geo in
            let L = HybridLayout(size: geo.size)
            let t = HybridTheme.of(scheme, increaseContrast: contrast == .increased)
            ZStack(alignment: .topLeading) {
                PanelBackground(layout: L)
                FilamentStage(model: model, layout: L, stillAt: stillAt)
                content(L, t)
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
        }
        .background(HybridTheme.of(scheme, increaseContrast: contrast == .increased).ground)
        .foregroundStyle(HybridTheme.of(scheme, increaseContrast: contrast == .increased).ink)
        .coordinateSpace(name: PanelFrames.space)
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

    @ViewBuilder private func content(_ L: HybridLayout, _ t: HybridTheme) -> some View {
        let v = model.pageView
        let W = L.size.width
        HeaderView(model: model, view: v, stillAt: stillAt)
            .padding(.leading, 16).padding(.trailing, 14)
            .place(CGRect(x: 0, y: 0, width: W, height: L.headerH), alignment: .center)
        HeadlineView(model: model, layout: L, stillAt: stillAt)
            .place(CGRect(x: L.textX, y: L.wordY, width: L.x1 - L.textX, height: L.wordH))
        PegButton(model: model)
            .place(CGRect(x: L.pegX - 32, y: L.y - 32, width: 64, height: 64))
        CaptionLine(model: model, layout: L, stillAt: stillAt)
            .place(CGRect(x: L.textX, y: L.capY, width: L.x1 - L.textX, height: L.capH), reader: "captions")
        ClaudeColumn(model: model, layout: L, stillAt: stillAt)
            .place(CGRect(x: L.textX, y: L.rowY, width: L.columnRight - L.textX, height: max(40, L.pageBottom - L.rowY)), reader: "claude")
        FooterView(model: model, view: v, stillAt: stillAt)
            .padding(.leading, 12).padding(.trailing, 10)
            .place(CGRect(x: 0, y: L.footerTop, width: W, height: L.footerH), alignment: .center, reader: "footer")
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

extension View {
    /// Pin a view to a fixed box of the panel (a ZStack with top-leading alignment).
    func place(_ r: CGRect, alignment: Alignment = .topLeading, reader: String? = nil) -> some View {
        frame(width: max(0, r.width), height: max(0, r.height), alignment: alignment)
            .background { if let reader { PanelFrames.reader(reader) } }
            .padding(.leading, r.minX).padding(.top, r.minY)
    }
}

/// Deep space with a still, faint lift behind the string (dark); a printed page (light).
/// Painted once: it never animates. Reduce Transparency falls back to flat ground.
struct PanelBackground: View {
    let layout: HybridLayout
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceTransparency) private var flat

    var body: some View {
        let t = HybridTheme.of(scheme, increaseContrast: contrast == .increased)
        Canvas { g, size in
            g.fill(Path(CGRect(origin: .zero, size: size)), with: .color(t.ground))
            guard t.dark, !flat else { return }
            // CSS: radial-gradient(120% 46% at 30% <string y>, lift, ground 72%).
            let rx = size.width * 1.2, ry = size.height * 0.46
            var l = g
            l.translateBy(x: size.width * 0.3, y: layout.y)
            l.scaleBy(x: rx / ry, y: 1)
            l.fill(Path(ellipseIn: CGRect(x: -ry, y: -ry, width: 2 * ry, height: 2 * ry)),
                   with: .radialGradient(Gradient(stops: [.init(color: t.lift, location: 0), .init(color: t.ground, location: 0.72), .init(color: t.ground, location: 1)]),
                                         center: .zero, startRadius: 0, endRadius: ry))
        }
        .frame(width: layout.size.width, height: layout.size.height)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Where the zones sit in the panel (ClaudeCardLayoutTests).
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

// MARK: - Header

/// The header: the status word in a fixed slot and the project on the left; the usage
/// readout on the right (one flat capsule with symbols). Ticks once a second.
struct HeaderView: View {
    let model: StateModel
    let view: ViewText.PageView
    var stillAt: Double?
    @Environment(\.accessibilityReduceMotion) private var reduce

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let now = stillAt.map { Date(timeIntervalSinceReferenceDate: $0) } ?? ctx.date
            let v = model.pageView(at: now)
            let key = v.header.key == "attention" && v.view == "live" ? "need" : v.header.key
            HeaderContent(key: key, label: ViewText.statusWord(v), detail: nil, project: model.project,
                          pills: model.status == nil ? nil : model.usagePills(at: now), openSettings: model.openSettings)
                // While the moon crosses, the usage recedes; the question stays at full strength.
                .environment(\.sottoCapsuleDim, model.attention && view.view == "live")
        }
    }
}

private struct CapsuleDimKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var sottoCapsuleDim: Bool {
        get { self[CapsuleDimKey.self] }
        set { self[CapsuleDimKey.self] = newValue }
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
    /// Settings moved to the footer (the hybrid header is status + usage only); kept for callers.
    var openSettings: (() -> Void)?
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.sottoCapsuleDim) private var dim
    @Environment(\.accessibilityReduceMotion) private var reduce

    /// What one candidate row shows.
    struct Shown: Equatable { var project = true, detail = true, session = true, today = true }

    static let candidates: [Shown] = [
        Shown(),
        Shown(project: false),
        Shown(project: false, detail: false),
        Shown(project: false, detail: false, today: false),
        Shown(project: false, detail: false, session: false, today: false),
    ]

    /// The status word's fixed slot, so a longer word never nudges the project.
    static let statusSlot: CGFloat = 72

    var body: some View {
        let t = HybridTheme.of(scheme, increaseContrast: contrast == .increased)
        ViewThatFits(in: .horizontal) {
            ForEach(Array(Self.candidates.enumerated()), id: \.offset) { _, c in row(t, c) }
        }
        .coordinateSpace(name: PillFrames.space)
    }

    private func row(_ t: HybridTheme, _ c: Shown) -> some View {
        HStack(alignment: .center, spacing: 0) {
            status(t, c).layoutPriority(1)
            Spacer(minLength: 12)
            if let p = pills {
                usage(t, p, c)
                    .opacity(dim ? 0.45 : 1)
                    .animation(reduce ? .linear(duration: 0.15) : .timingCurve(0.2, 0, 0, 1, duration: 0.45).delay(0.3), value: dim)
            }
        }
        .frame(minHeight: 36)
    }

    /// The usage readout (IMPLEMENTATION.md §1): one flat capsule, 26 pt tall, 13 pt radius,
    /// `cap` fill, no outline, a 5 pt inset, hairlines between the slots. No word labels
    /// (VoiceOver reads "Session", "Today" and "Cost today").
    private func usage(_ t: HybridTheme, _ p: ViewText.UsagePills, _ c: Shown) -> some View {
        var slots: [UsagePill] = []
        if c.session, let s = p.session { slots.append(UsagePill(name: "Session", pill: s, kind: .clock, help: "This voice session")) }
        if c.today { slots.append(UsagePill(name: "Today", pill: p.today, kind: .clock, help: "Voice time billed today")) }
        slots.append(UsagePill(name: "Cost", pill: p.cost, kind: .cost, help: "Today's cost at $0.05 per minute"))
        return HStack(spacing: 0) {
            ForEach(Array(slots.enumerated()), id: \.element.name) { i, slot in
                if i > 0 { Rectangle().fill(t.hair2).frame(width: 1, height: 12).accessibilityHidden(true) }
                slot.padding(.horizontal, 7)
            }
        }
        .padding(.horizontal, 5)
        .frame(height: 26)
        .background(Capsule(style: .continuous).fill(t.cap))
        .fixedSize()
        .accessibilityElement(children: .combine)
    }

    private func status(_ t: HybridTheme, _ c: Shown) -> some View {
        let color: Color = key == "need" ? t.needInk : key == "muted" ? t.mutedInk : key == "error" ? t.err : t.ink
        let project = c.project ? project : nil
        return HStack(alignment: .center, spacing: 10) {
            Text(label).font(.system(size: 12, weight: .semibold))
                .foregroundStyle(color)
                .lineLimit(1).minimumScaleFactor(0.8)
                .frame(width: Self.statusSlot, alignment: .leading)
                .id(label)
                .transition(.opacity)
            if let p = project {
                // Ideal width 56: a long name ellipsizes before the row gives it up.
                Text(p).font(.system(size: 12)).lineLimit(1).truncationMode(.middle).foregroundStyle(t.ink2).frame(idealWidth: 56)
            }
        }
        .animation(.timingCurve(0.2, 0, 0, 1, duration: 0.2), value: label)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Status: \(label)\(self.project.map { ", project \($0)" } ?? "")")
    }
}

/// One usage slot: a 12 pt symbol in ink3 (timer, calendar; the cost's "$" is its own), then
/// a 12 pt medium tabular figure in a box of fixed width, so a ticking figure never moves
/// anything. The box widens once: a clock at the hour, the cost at $100
/// (lib.usagePills `wide`). The name is spoken (accessibility label and tooltip), not shown.
struct UsagePill: View {
    enum Kind { case clock, cost }
    let name: String
    let pill: ViewText.Pill
    let kind: Kind
    var help: String = ""
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast

    /// Session: timer; Today: calendar; Cost: none ("$" names it).
    var symbol: String? {
        switch name { case "Session": return "timer"; case "Today": return "calendar"; default: return nil }
    }

    static let figureSize: CGFloat = 12
    static let figureFont = Font.system(size: figureSize, weight: .semibold).monospacedDigit()

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
        let font = NSFont.monospacedDigitSystemFont(ofSize: figureSize, weight: .semibold)
        let w = samples.map { ($0 as NSString).size(withAttributes: [.font: font]).width }.max() ?? 0
        return (w + 1).rounded(.up)
    }

    var body: some View {
        let t = HybridTheme.of(scheme, increaseContrast: contrast == .increased)
        HStack(alignment: .center, spacing: 6) {
            if let symbol {
                Image(systemName: symbol).font(.system(size: 10.5, weight: .regular)).foregroundStyle(t.ink3)
                    .frame(width: 12, height: 12).accessibilityHidden(true)
            }
            Text(pill.text).font(Self.figureFont).foregroundStyle(t.ink).lineLimit(1)
                .frame(width: Self.figureWidth(kind, wide: pill.wide), alignment: .trailing)
        }
        .frame(height: 16)
        .fixedSize()
        .background(GeometryReader { g in
            Color.clear.preference(key: PillFrames.self, value: [name: g.frame(in: .named(PillFrames.space))])
        })
        .help(help)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(name == "Cost" ? "Cost today \(pill.text)" : "\(name) \(pill.text)")
    }
}

// MARK: - Headline

/// The big word (IMPLEMENTATION.md §6): who holds the floor, else Claude's news, else the
/// page's word. Held 1.3 s by the model's word hold, cross-faded in 200 ms. Ticks once a
/// second only while a timed rule is pending ("Claude finished", "Switching to").
struct HeadlineView: View {
    let model: StateModel
    let layout: HybridLayout
    var stillAt: Double?
    var mini = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceMotion) private var reduce

    var body: some View {
        let _ = model.redrawTick
        let now = stillAt.map { Date(timeIntervalSinceReferenceDate: $0) } ?? Date()
        // The timed rules end on their own ("Claude finished" after 30 s; the approval's words
        // at totality): wake once at that moment instead of ticking.
        let ends = [model.finishedAt?.addingTimeInterval(ViewText.finishedHeadlineMs / 1000),
                    model.attention ? model.attentionAt?.addingTimeInterval(ViewText.eclipseTotalityMs / 1000 + 0.01) : nil]
            .compactMap { $0 }.filter { $0 > now }.min()
        word(now)
            .task(id: ends) {
                guard stillAt == nil, let ends else { return }
                try? await Task.sleep(for: .seconds(max(0.05, ends.timeIntervalSinceNow)))
                model.touchForRedraw()
            }
    }

    private func word(_ now: Date) -> some View {
        let t = HybridTheme.of(scheme, increaseContrast: contrast == .increased)
        let h = model.headline(at: now)
        // The strip has no room for a second line naming the terminal, so the word does.
        let word = mini && h.word == ViewText.approvalWord ? "Approve in \(model.terminalName ?? "the terminal")" : h.word
        let color: Color = h.tone == "attn" ? t.needInk : h.tone == "muted" ? t.mutedInk : h.tone == "err" ? t.err : t.ink
        let size = layout.wordSize
        return ZStack(alignment: .leading) {
            Text(word).font(.system(size: size, weight: .semibold))
            .tracking(-0.012 * size)
            .foregroundStyle(color)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .id(word)
            .transition(.opacity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .animation(reduce ? .linear(duration: 0.15) : .timingCurve(0.2, 0, 0, 1, duration: 0.2), value: word)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityAddTraits(.updatesFrequently)
    }
}

// MARK: - Peg (the mute control)

/// The peg is the mute button: a 64 pt target over the drawn peg, named "Mute" with the
/// pressed state carrying mute. Asleep it toggles listening for your voice.
struct PegButton: View {
    let model: StateModel

    var body: some View {
        let muted = model.effectiveMuted && model.isLive
        let label = model.isSleeping ? (model.wakeMuted ? "Listen for your voice again" : "Stop listening for your voice") : "Mute"
        Button {
            if model.isSleeping { model.wakeMuted.toggle() } else { model.toggleMute() }
        } label: {
            Circle().fill(Color.clear).frame(width: 64, height: 64).contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!(model.isLive || model.isSleeping))
        .accessibilityLabel(label)
        .accessibilityAddTraits(muted || (model.isSleeping && model.wakeMuted) ? .isSelected : [])
        .accessibilityValue(muted ? "Muted. Sotto can't hear you. Still billing." : model.isLive ? "Level \(Int((model.micMeter * 100).rounded()))%" : "")
        .help(model.isSleeping ? label + " (M)" : (muted ? "Unmute (M)" : "Mute (M)"))
    }
}

// MARK: - Caption

/// One line under the string: who spoke plus their words, or a cause plus one action
/// (can't hear: the mic in use and "Switch mic"). Fixed height; a new line cross-fades in.
struct CaptionLine: View {
    let model: StateModel
    let layout: HybridLayout
    var stillAt: Double?
    /// The compact strip: its word already names the terminal ("Approve in iTerm2"), so the
    /// line shows what is being approved, the command in mono (IMPLEMENTATION.md §1 Mini).
    var mini = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceMotion) private var reduce

    enum Line: Equatable {
        case banner(StateModel.Banner, more: Int)
        case approval(terminal: String?, project: String?)
        case command(String)
        case muted
        case hint(String)
        case said(role: String, who: String, text: String, id: Int)
        case empty

        var key: String {
            switch self {
            case .banner(let b, _): return "b:\(b.key):\(b.text)"
            case .approval: return "approval"
            case .command(let c): return "cmd:\(c)"
            case .muted: return "muted"
            case .hint(let s): return "h:\(s)"
            case .said(_, _, _, let id): return "c:\(id)"
            case .empty: return "empty"
            }
        }
    }

    static func line(_ m: StateModel, at now: Date, mini: Bool = false) -> Line {
        let v = m.pageView(at: now)
        if let b = m.topBanner, !(m.bannerYieldsToCaption(b) && !m.captions.isEmpty && (v.view == "live" || v.card?.kind == "sleeping")) {
            return .banner(b, more: max(0, m.banners.count - (m.banners.first?.key == b.key ? 1 : 0)))
        }
        if m.attentionShown(at: now) && v.view == "live" {
            let parts = ApprovalBody.split(m.claudeCard.command)
            if mini, let c = parts.command ?? parts.sentence { return .command(c) }
            return .approval(terminal: m.terminalName, project: m.project)
        }
        if v.view == "live" && v.floor == "muted" { return .muted }
        if v.floor == "connecting" || v.floor == "reconnecting", let note = ViewText.captionNote(v) { return .hint(note) }
        if let name = m.switchingTo(at: now), v.view == "live" {
            if case .object(let o)? = m.settings?["personas"], case .array(let list)? = o["personas"],
               let hit = list.first(where: { if case .object(let p) = $0, case .string(let id)? = p["id"] { return id == m.personaSwitch?.to }; return false }),
               case .object(let p) = hit, case .string(let d)? = p["description"], !d.isEmpty { return .hint(d) }
            return .hint("\(name) is joining. The conversation carries over.")
        }
        if v.view == "card", let c = v.card {
            switch c.kind {
            case "sleeping": return .hint(c.listening == true ? "Just start talking. Nothing is sent or billed until then." : c.body)
            case "paused": return .hint("\(c.title). Press Space to resume.")
            case "cap": return .empty
            default: break
            }
        }
        if let c = m.captions.last, v.view == "live" || v.card?.kind == "sleeping" {
            return .said(role: c.role, who: c.role == "assistant" ? m.personaName(m.personaId) : "You", text: c.text, id: c.id)
        }
        if v.view == "card" { return .empty }
        return .empty
    }

    var body: some View {
        let t = HybridTheme.of(scheme, increaseContrast: contrast == .increased)
        let _ = model.redrawTick
        let line = Self.line(model, at: stillAt.map { Date(timeIntervalSinceReferenceDate: $0) } ?? Date(), mini: mini)
        ZStack(alignment: .leading) {
            row(t, line).id(line.key).transition(.opacity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .font(.system(size: layout.capSize))
        .animation(reduce ? .linear(duration: 0.15) : .timingCurve(0.2, 0, 0, 1, duration: 0.2), value: line.key)
    }

    @ViewBuilder private func row(_ t: HybridTheme, _ line: Line) -> some View {
        switch line {
        case .banner(let b, let more):
            HStack(spacing: 8) {
                // The notice's own words ("I can't hear you — using …"): the headline stays
                // "Listening", so this line is the only place that says why (web parity).
                Text(b.text).foregroundStyle(b.level == "error" ? t.err : t.ink2).lineLimit(1).truncationMode(.tail)
                    .help(b.text).accessibilityLabel(b.text)
                Spacer(minLength: 4)
                if more > 0 { Text("+\(more)").foregroundStyle(t.fg3).help("\(more) more") }
                if let a = b.action {
                    Button(Self.label(a)) { model.perform(a, banner: b.key) }.buttonStyle(QuietCapsuleStyle(height: 28))
                }
                Button {
                    if b.key == "cmd_error" { model.clearCommandError() } else { model.dismissBanner(key: b.key) }
                } label: {
                    Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(t.ink3)
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityLabel("Dismiss").help("Dismiss")
            }
            .accessibilityElement(children: .contain)
        case .approval(let terminal, let project):
            (Text("In ") + Text(terminal ?? "the terminal").fontWeight(.semibold).foregroundColor(t.ink)
                + Text(project.map { " \u{00B7} \($0)" } ?? ""))
                .foregroundStyle(t.ink2).lineLimit(1)
        case .command(let c):
            Text(verbatim: c).font(.system(size: layout.capSize, weight: .medium, design: .monospaced))
                .foregroundStyle(t.ink).lineLimit(1).truncationMode(.tail).help(c)
                .accessibilityLabel("Command: \(c)")
        case .muted:
            // lib.captionNote's words, the cause in the muted ink.
            (Text("Sotto can't hear you.").foregroundColor(t.mutedInk) + Text(" Still billing. Press M to listen."))
                .foregroundStyle(t.ink2).lineLimit(1).truncationMode(.tail)
        case .hint(let s):
            Text(s).foregroundStyle(t.ink2).lineLimit(1).minimumScaleFactor(0.85).truncationMode(.tail).help(s)
        case .said(let role, let who, let text, _):
            // Live captions stream in: when a line outgrows the zone, keep the newest words
            // (head truncation) and the speaker's name fixed on the left.
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(who).font(.system(size: layout.capSize * 0.88, weight: .semibold)).foregroundStyle(role == "assistant" ? t.voiceInk : t.youInk)
                    .fixedSize()
                Text(text).foregroundStyle(t.ink).lineLimit(1).truncationMode(.head)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(who) said: \(text)")
        case .empty:
            Color.clear.frame(height: 1).accessibilityHidden(true)
        }
    }

    static func label(_ a: StateModel.Banner.Action) -> String {
        switch a {
        case .switchMic: return "Switch mic"
        case .tryAgain: return "Try again"
        case .turnOnAudio: return "Turn on audio"
        }
    }
}

/// A quiet action capsule: a hairline, ink text, 10% fill on hover, 0.96 on press.
struct QuietCapsuleStyle: ButtonStyle {
    var height: CGFloat = 32
    var tone: Color?
    var lineWidth: CGFloat = 1
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        let t = HybridTheme.of(scheme, increaseContrast: contrast == .increased)
        let c = tone ?? t.ink
        return configuration.label
            .font(.system(size: height >= 40 ? 14 : 12, weight: height >= 40 ? .semibold : .medium))
            .foregroundStyle(c)
            .padding(.horizontal, 12)
            .frame(minHeight: height)
            .background(Capsule().fill(configuration.isPressed ? (tone ?? t.ink).opacity(0.1) : Color.clear))
            .overlay(Capsule().strokeBorder(tone ?? t.hair2, lineWidth: lineWidth))
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .opacity(enabled ? 1 : 0.45)
            .contentShape(Capsule())
    }
}

// MARK: - Footer

struct FooterView: View {
    let model: StateModel
    let view: ViewText.PageView
    var stillAt: Double?
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        let t = HybridTheme.of(scheme, increaseContrast: contrast == .increased)
        let st = model.status?.state ?? "off"
        let linked = model.phase != "boot" && model.phase != "lost"
        let dim = model.attention && view.view == "live"
        HStack(spacing: 8) {
            PersonaChip(model: model)
            Spacer(minLength: 8)
            if st == "paused" || st == "sleeping" {
                IconButton(symbol: "play.fill", label: st == "sleeping" ? "Wake now" : "Resume") { model.resume() }
                    .disabled(view.card?.kind == "cap")
            } else {
                IconButton(symbol: "pause", label: "Pause") { model.pause() }
                    .disabled(!(["live", "connecting", "reconnecting", "waiting_page"].contains(st)))
            }
            IconButton(symbol: "power", label: "End voice", help: "Turn voice off (same as /talk off)") { model.end() }
                .disabled(st == "off" || st == "closing")
            IconButton(symbol: "gearshape", label: "Settings") { model.openSettings?() }
                .disabled(model.openSettings == nil)
        }
        .foregroundStyle(t.ink2)
        .disabled(!linked)
        .opacity(dim ? 0.5 : 1)
        .animation(.timingCurve(0.2, 0, 0, 1, duration: 0.45).delay(0.3), value: dim)
    }
}

/// A 40 pt round control: ink2, a hairline fill on hover, 0.96 on press.
struct IconButton: View {
    let symbol: String
    let label: String
    var help: String?
    let action: () -> Void
    @State private var hover = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        let t = HybridTheme.of(scheme, increaseContrast: contrast == .increased)
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 15, weight: .regular))
                .frame(width: 40, height: 40)
                .background(Circle().fill(hover && enabled ? t.hair : Color.clear))
                .foregroundStyle(hover && enabled ? t.ink : t.ink2)
                .contentShape(Circle())
        }
        .buttonStyle(PressScale())
        .opacity(enabled ? 1 : 0.4)
        .onHover { hover = $0 }
        .accessibilityLabel(label)
        .help(help ?? label)
    }
}

struct PressScale: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.scaleEffect(configuration.isPressed ? 0.96 : 1)
    }
}

/// The persona chip: a tiny drawing of the persona's own tuning (peg, harmonic shape,
/// bridge), then its name, voice and a chevron. It opens Settings, where the persona picker is.
struct PersonaChip: View {
    let model: StateModel
    @State private var hover = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        let t = HybridTheme.of(scheme, increaseContrast: contrast == .increased)
        let id = model.personaId
        Button { model.openSettings?() } label: {
            HStack(spacing: 9) {
                TuningGlyph(tuning: .of(id)).frame(width: 30, height: 20).foregroundStyle(t.ink)
                Text(model.personaName(id)).font(.system(size: 13, weight: .semibold)).foregroundStyle(t.ink).lineLimit(1)
                if let voice = model.status?.voice, !voice.isEmpty {
                    Text(voice).font(.system(size: 12)).foregroundStyle(t.ink2).lineLimit(1)
                }
                Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(t.ink3)
            }
            .padding(.leading, 6).padding(.trailing, 10)
            .frame(height: 40)
            .background(Capsule().fill(hover ? t.hair : Color.clear))
            .contentShape(Capsule())
        }
        .buttonStyle(PressScale())
        .onHover { hover = $0 }
        .disabled(model.openSettings == nil)
        .accessibilityLabel("Persona: \(model.personaName(id))")
        .accessibilityHint("Opens Settings to choose who you talk to")
        .help("Persona")
    }
}

/// A persona's tuning as a 30 x 20 glyph: the peg, the string's harmonic shape and the bridge.
struct TuningGlyph: View {
    let tuning: Tuning
    var body: some View {
        Canvas { g, _ in
            var faint = g
            faint.opacity = 0.55
            faint.stroke(Path(ellipseIn: CGRect(x: 4 - 2.6, y: 10 - 2.6, width: 5.2, height: 5.2)), with: .foreground, lineWidth: 1.3)
            let n = 22
            var pts: [Double] = []
            var mx = 0.0
            for i in 0...n {
                let s = Double(i) / Double(n)
                var v = 0.0
                for (k, w) in tuning.w.enumerated() { v += w * sin(Double(k + 1) * .pi * s) * cos(Double(k + 1) * 0.9 + Double(k) * 0.9) }
                pts.append(v); mx = max(mx, abs(v))
            }
            let A = 5.2 * max(0.5, min(1.1, tuning.amp))
            func wave(_ off: Double) -> Path {
                var p = Path()
                for (i, v) in pts.enumerated() {
                    let pt = CGPoint(x: 8 + Double(i) / Double(n) * 18, y: 10 - v / (mx == 0 ? 1 : mx) * A + off)
                    if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
                }
                return p
            }
            g.stroke(wave(0), with: .foreground, style: StrokeStyle(lineWidth: 1 + 0.35 * tuning.width, lineCap: .round, lineJoin: .round))
            if tuning.doubled > 0 { var d = g; d.opacity = 0.6 * tuning.doubled; d.stroke(wave(1.6), with: .foreground, lineWidth: 1) }
            faint.fill(Path(ellipseIn: CGRect(x: 27.5 - 1.2, y: 10 - 1.2, width: 2.4, height: 2.4)), with: .foreground)
        }
        .accessibilityHidden(true)
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
            TimelineView(.animation(minimumInterval: 1.0 / 30)) { ctx in arc(ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1) * 360) }
        }
    }
    private func arc(_ deg: Double) -> some View {
        Circle().trim(from: 0, to: 0.72).stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            .rotationEffect(.degrees(deg)).frame(width: 12, height: 12)
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

// MARK: - Probe (test mode)

/// What the live panel is showing right now, read from the same functions its views call.
/// Test mode logs this on request (SOTTO_APP_TEST_ACTION_DIR `probe`), so an end-to-end test
/// can check the real app's message pipeline (daemon -> link -> StateModel -> views), not
/// the offscreen renderer: v0.4.0 rendered captions in its snapshots but never on screen.
@MainActor
public enum PanelProbe {
    public static func describe(_ m: StateModel, at now: Date = Date()) -> [String: Any] {
        var o: [String: Any] = [:]
        switch CaptionLine.line(m, at: now) {
        case .said(let role, let who, let text, _): o["line"] = "said"; o["role"] = role; o["who"] = who; o["text"] = text
        case .banner(let b, _): o["line"] = "banner"; o["text"] = b.text
        case .approval(let term, _): o["line"] = "approval"; o["text"] = term ?? ""
        case .command(let c): o["line"] = "command"; o["text"] = c
        case .muted: o["line"] = "muted"
        case .hint(let s): o["line"] = "hint"; o["text"] = s
        case .empty: o["line"] = "empty"
        }
        o["headline"] = m.headline(at: now).word
        o["claude_page"] = m.pageMessages
        o["claude_says"] = m.claudeSays
        o["summary"] = m.summary ?? ""
        o["floor"] = m.floor ?? ""
        let i = FilamentInput.from(m, reduced: false)
        o["string_mic"] = i.mic
        o["string_voice"] = i.voice
        o["string_mode"] = i.mode.rawValue
        o["breathing"] = FilamentEngine.breathing(i, now: now.timeIntervalSinceReferenceDate)
        return o
    }
}
