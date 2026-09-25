// Claude's column (IMPLEMENTATION.md §3, concept-3 §1): the Claude row (moon glyph,
// "Claude · Working", a plain tabular timer) and the page under it, Claude's own words in
// New York with rendered markdown. In an approval the page becomes the question: the
// command in mono, where it runs, Claude's reason, and "Show terminal". A state card
// (key, microphone, off) sets its text on the same page. The column is one fixed box.
import SwiftUI
import AppKit
import SottoClient

struct ClaudeColumn: View {
    let model: StateModel
    let layout: HybridLayout
    var stillAt: Double?
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceMotion) private var reduceEnv
    @Environment(\.sottoStill) private var still
    private var reduce: Bool { reduceEnv || model.reducedMotion }

    /// The Claude row's height and the gap under it.
    static let rowHeight: CGFloat = 20

    var body: some View {
        let t = HybridTheme.of(scheme, increaseContrast: contrast == .increased)
        let v = model.pageView
        // The approval's opening runs on its own clock for its first 1.7 s (the page dims
        // while the moon crosses, then the question rises part by part).
        let at = model.attentionAt?.timeIntervalSinceReferenceDate
        let now0 = stillAt ?? Date().timeIntervalSinceReferenceDate
        let opening = model.attention && v.view == "live" && !reduce && at.map { now0 - $0 < 1.8 } == true
        let _ = model.redrawTick
        Group {
            if stillAt == nil && opening {
                TimelineView(.animation(minimumInterval: nil, paused: false)) { ctx in
                    column(t, v, now: ctx.date.timeIntervalSinceReferenceDate)
                }
            } else {
                column(t, v, now: now0)
            }
        }
        .task(id: model.attentionAt) {
            // Leave the fast clock once the opening is done.
            guard stillAt == nil, opening else { return }
            try? await Task.sleep(for: .milliseconds(1900))
            model.touchForRedraw()
        }
    }

    private func column(_ t: HybridTheme, _ v: ViewText.PageView, now: Double) -> some View {
        let date = Date(timeIntervalSinceReferenceDate: now)
        let live = v.view == "live"
        let eAge = model.attention && live ? model.attentionAt.map { now - $0.timeIntervalSinceReferenceDate } ?? 99 : nil
        let rm = reduce
        // The page dims to 15% while the moon crosses (0.3 to 0.75 s), then the question replaces it at 1.0 s.
        let pageDim = eAge.map { rm ? 1 : Ease.out(($0 - 0.3) / 0.45) } ?? 0
        let showApproval = eAge.map { rm || $0 >= 1.0 } ?? false
        return VStack(alignment: .leading, spacing: 8) {
            row(t, v, date: date, eAge: eAge)
                .frame(height: Self.rowHeight)
                .background(PanelFrames.reader("claude-head"))
            ZStack(alignment: .topLeading) {
                if showApproval, let age = eAge {
                    ApprovalBody(model: model, layout: layout, age: rm ? 99 : age)
                        .transition(.identity)
                } else if !live, let card = v.card, !["sleeping", "paused"].contains(card.kind) {
                    StateBody(model: model, card: card, layout: layout)
                } else if live && v.floor == "connecting", model.pageMessages.isEmpty, let steps = v.steps {
                    StepsView(steps: steps)
                } else {
                    page(t, v)
                        .opacity(1 - 0.85 * pageDim)
                        .opacity(v.card?.kind == "sleeping" ? 0.4 : v.card?.kind == "paused" ? 0.7 : 1)
                }
            }
            .frame(minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .clipped()
        }
        .frame(minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
    }

    // MARK: Row

    private func row(_ t: HybridTheme, _ v: ViewText.PageView, date: Date, eAge: Double?) -> some View {
        var card = model.claudeCard
        // The moon eclipses at totality, not before: until then the row still says "Working".
        if card.kind == "approval" && !model.attentionShown(at: date) { card.kind = "working" }
        let kind = card.kind
        let head = ViewText.claudeHead(card)
        let r = (phase: HybridText.Phase(head: head.phase), word: head.detail, sentence: head.need ? head.label : nil,
                 accessibility: head.need ? head.label : "\(head.label) \u{00B7} \(head.detail ?? "")")
        let color: Color = r.phase == .need ? t.needInk : r.phase == .idle ? t.ink3 : r.phase == .done ? t.ink2 : t.ink
        // In approval the timer counts the wait; while Claude works, the work. It freezes for the eclipse's first 300 ms.
        let need = r.phase == .need
        let working = card.kind == "working" || kind == "working"
        let timer: (Date) -> String? = { d in
            if need { return model.waitingTime(at: d) }
            if working {
                if let a = model.attentionAt, model.attention { return model.workingClock(at: a) }
                return model.workingClock(at: d)
            }
            return nil
        }
        let ticking = stillAt == nil && (need || working)
        return HStack(spacing: 8) {
            MoonGlyph(phase: r.phase).foregroundStyle(color).contentTransition(.opacity)
            Group {
                if let s = r.sentence {
                    Text(s).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(t.needInk)
                } else {
                    (Text(head.label).font(.system(size: 12.5, weight: .semibold)).foregroundColor(t.ink)
                        + Text(" \u{00B7} \(r.word ?? "")").font(.system(size: 12.5, weight: .medium)).foregroundColor(t.ink2))
                }
            }
            .lineLimit(1).truncationMode(.tail)
            .layoutPriority(1)
            Spacer(minLength: 4)
            if let a = card.agents {
                let n = a.split(separator: " ").first.map(String.init) ?? ""
                ViewThatFits(in: .horizontal) {
                    Label(a, systemImage: "person.2").labelStyle(.titleAndIcon)
                    Label(n == "1" ? "1 agent" : "\(n) agents", systemImage: "person.2").labelStyle(.titleAndIcon)
                    Color.clear.frame(width: 0, height: 0)
                }
                .font(.system(size: 11.5, weight: .medium)).foregroundStyle(t.ink2).lineLimit(1)
                .help(a).accessibilityLabel(a)
            }
            if ticking {
                // Only the figure ticks (1 Hz); the page around it never redraws for it.
                TimelineView(.periodic(from: .now, by: 1)) { ctx in ClaudeTimer(text: timer(ctx.date), need: need) }
            } else {
                ClaudeTimer(text: timer(date), need: need)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(r.accessibility + (timer(date).map { ", \($0)" } ?? ""))
    }

    // MARK: Page

    static func messages(_ m: StateModel, pending: String?) -> [String] {
        var msgs = m.pageMessages
        if let p = pending, msgs.last.map({ ViewText.stripMarkdown($0) != ViewText.stripMarkdown(p) }) ?? true { msgs.append(p) }
        return msgs
    }

    @ViewBuilder private func page(_ t: HybridTheme, _ v: ViewText.PageView) -> some View {
        let pending = v.card?.pending
        let msgs = Self.messages(model, pending: pending)
        let finished = model.claudeCard.kind == "finished" || pending != nil
        VStack(alignment: .leading, spacing: 10) {
            // "Asked: ..." while the request is in flight (a failed or held one says so), as on the page.
            if let r = model.requestLine {
                Text(r.text).font(.system(size: 13)).foregroundStyle(r.tone == "error" ? t.err : r.tone == "warn" ? t.ink : t.fg3)
                    .lineLimit(1).truncationMode(.tail)
            }
            if !msgs.isEmpty {
                ClaudePage(messages: msgs, finished: finished, layout: layout, expanded: model.summaryExpanded,
                           toggle: { model.summaryExpanded.toggle() })
            }
        }
    }
}

/// Claude's elapsed time: a plain tabular figure with a timer symbol, 58 pt, right-aligned,
/// no box. In an approval it counts the wait, in need-ink Semibold. Empty (opacity 0) when idle.
struct ClaudeTimer: View {
    let text: String?
    var need = false
    static let width: CGFloat = 58
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    var body: some View {
        let t = HybridTheme.of(scheme, increaseContrast: contrast == .increased)
        HStack(spacing: 5) {
            Image(systemName: "timer").font(.system(size: 10.5)).foregroundStyle(need ? t.needInk : t.ink3)
            Text(text ?? "0:00").font(.system(size: 12.5, weight: need ? .semibold : .medium)).monospacedDigit()
                .foregroundStyle(need ? t.needInk : t.ink2)
        }
        .frame(width: Self.width, alignment: .trailing)
        .opacity(text == nil ? 0 : 1)
        .accessibilityHidden(text == nil)
    }
}

/// Claude's words: the latest message at 100%, earlier ones at 50% and 42%, the page
/// hanging from the bottom and older lines passing out under a top fade (so a half-clipped
/// line never reads as a bug). A finished summary that does not fit shows from its start
/// with "More"; expanded, it scrolls inside the page (the zone never grows).
struct ClaudePage: View {
    let messages: [String]
    let finished: Bool
    let layout: HybridLayout
    var expanded = false
    var toggle: () -> Void = {}
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.sottoStill) private var still

    static let opacities: [Double] = [0.42, 0.5, 1]

    var body: some View {
        let t = HybridTheme.of(scheme, increaseContrast: contrast == .increased)
        let n = messages.count
        let latest = messages[n - 1]
        GeometryReader { geo in
        Group {
            if finished && expanded {
                if still {
                    // ImageRenderer draws no ScrollView content: the same box, clipped, with a scroller mark.
                    VStack(alignment: .leading, spacing: 6) {
                        MarkdownPage(markdown: latest, layout: layout, expanded: true).padding(.trailing, 10)
                            .frame(minHeight: 0, maxHeight: .infinity, alignment: .topLeading).clipped()
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .overlay(alignment: .topTrailing) { Capsule().fill(t.ink3.opacity(0.5)).frame(width: 5, height: 80).padding(.top, 4) }
                        more(t, "Less")
                    }
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        ScrollView(.vertical) {
                            MarkdownPage(markdown: latest, layout: layout, expanded: true).padding(.trailing, 10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .scrollIndicators(.automatic)
                        more(t, "Less")
                    }
                }
            } else {
                FirstFit {
                    stack(t, Array(messages.suffix(3)))
                    stack(t, Array(messages.suffix(2)))
                    stack(t, [latest])
                    if finished {
                        // From its start, with a bottom fade and More.
                        VStack(alignment: .leading, spacing: 4) {
                            MarkdownPage(markdown: latest, layout: layout, expanded: false)
                                .frame(minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .clipped()
                                .mask(LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.8), .init(color: .clear, location: 1)],
                                                     startPoint: .top, endPoint: .bottom))
                            more(t, "More")
                        }
                    } else {
                        // Streaming: hang from the bottom; older words go out under the top fade.
                        stack(t, Array(messages.suffix(3)))
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(minHeight: 0, maxHeight: .infinity, alignment: .bottomLeading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .clipped()
                            .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .clear, location: 10 / 300),
                                                         .init(color: .black, location: 68 / 300), .init(color: .black, location: 1)],
                                                 startPoint: .top, endPoint: .bottom))
                    }
                }
            }
        }
        .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
        }
        .textSelection(.enabled)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Claude: " + ViewText.stripMarkdown(latest))
    }

    private func stack(_ t: HybridTheme, _ msgs: [String]) -> some View {
        VStack(alignment: .leading, spacing: layout.lineHeight * 0.55) {
            ForEach(Array(msgs.enumerated()), id: \.offset) { i, m in
                let op = Self.opacities[max(0, Self.opacities.count - msgs.count + i)]
                MarkdownPage(markdown: m, layout: layout, expanded: false).opacity(op)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func more(_ t: HybridTheme, _ label: String) -> some View {
        Button(action: toggle) {
            Text(label).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(t.ink).underline(true, color: t.hair2)
                .frame(minHeight: 28).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(expanded ? "expanded" : "collapsed")
    }
}

/// Shows the first subview whose natural height fits the box (the rest are parked out of
/// view). A Layout rather than ViewThatFits, so still frames (ImageRenderer) choose the same.
struct FirstFit: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    static func chosen(_ subviews: Subviews, in size: CGSize) -> Int {
        for (i, s) in subviews.enumerated() where i < subviews.count - 1 {
            if s.sizeThatFits(ProposedViewSize(width: size.width, height: nil)).height <= size.height + 0.5 { return i }
        }
        return subviews.count - 1
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let pick = Self.chosen(subviews, in: bounds.size)
        for (i, s) in subviews.enumerated() {
            if i == pick { s.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size)) }
            else { s.place(at: CGPoint(x: bounds.minX - 100_000, y: bounds.minY), proposal: ProposedViewSize(bounds.size)) }
        }
    }
}

// MARK: - Markdown (Claude's words, rendered natively)

/// Claude's markdown as New York text: paragraphs, "–" lists and numbered lists, headings as
/// semibold lines, inline strong/emphasis, code spans in SF Mono at 0.84 em with a hairline
/// underline (never a box), http(s) links. A code block is "(code)" collapsed and plain
/// mono lines expanded.
struct MarkdownPage: View {
    let markdown: String
    let layout: HybridLayout
    var expanded = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        let t = HybridTheme.of(scheme, increaseContrast: contrast == .increased)
        let size = layout.serif
        let spacing = max(0, layout.lineHeight - size * 1.19)
        VStack(alignment: .leading, spacing: size * 0.55) {
            ForEach(Array(MarkdownText.blocks(markdown).enumerated()), id: \.offset) { _, b in
                switch b {
                case .para(let s): Text(MarkdownText.inline(s, size: size, hair: t.hair2)).fixedSize(horizontal: false, vertical: true)
                case .heading(let s): Text(MarkdownText.inline(s, size: size, hair: t.hair2)).fontWeight(.semibold).fixedSize(horizontal: false, vertical: true)
                case .bullet(let s):
                    HStack(alignment: .firstTextBaseline, spacing: size * 0.6) {
                        Text("\u{2013}").foregroundStyle(t.fg3)
                        Text(MarkdownText.inline(s, size: size, hair: t.hair2)).fixedSize(horizontal: false, vertical: true)
                    }
                case .number(let n, let s):
                    HStack(alignment: .firstTextBaseline, spacing: size * 0.4) {
                        Text("\(n).").monospacedDigit().foregroundStyle(t.ink2)
                        Text(MarkdownText.inline(s, size: size, hair: t.hair2)).fixedSize(horizontal: false, vertical: true)
                    }
                case .code(let c):
                    if expanded {
                        Text(c).font(.system(size: size * 0.72, design: .monospaced)).foregroundStyle(t.ink2).fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text("(code)").foregroundStyle(t.fg3)
                    }
                }
            }
        }
        .font(HybridTheme.serif(size))
        .lineSpacing(spacing)
        .foregroundStyle(t.ink)
    }
}

/// The markdown parser (unchanged from 0.3.2) plus the page's inline styling.
enum MarkdownText {
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

    /// Inline markdown styled for the page: strong in Semibold, code spans in SF Mono at
    /// 0.84 em with a hairline underline.
    static func inline(_ s: String, size: CGFloat, hair: Color) -> AttributedString {
        var a = inline(s)
        for run in a.runs {
            guard let intent = run.inlinePresentationIntent else { continue }
            if intent.contains(.code) {
                a[run.range].font = .system(size: size * 0.84, design: .monospaced)
                a[run.range].underlineStyle = .single
                a[run.range].underlineColor = NSColor(hair)
            } else if intent.contains(.stronglyEmphasized) {
                a[run.range].font = HybridTheme.serif(size, weight: .semibold)
            }
        }
        return a
    }
}

// MARK: - Approval

/// The question (IMPLEMENTATION.md §3 ApprovalBody): the command in bare mono, where it
/// runs, Claude's own reason in serif, then "Claude will not continue until you answer in
/// <terminal>." and a full-width "Show terminal". Each part rises 10 pt into place, 60 ms
/// apart; the zone itself never moves.
struct ApprovalBody: View {
    let model: StateModel
    let layout: HybridLayout
    /// Seconds into the eclipse (the rise starts at 1.0 s).
    let age: Double
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast

    /// "Bash: rm -rf x" -> "rm -rf x"; a sentence (a background agent's) is not a command.
    static func split(_ text: String?) -> (command: String?, sentence: String?) {
        guard let raw = text?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return (nil, nil) }
        if let r = raw.range(of: "^[A-Z][A-Za-z]{1,20}:\\s+", options: .regularExpression) { return (String(raw[r.upperBound...]), nil) }
        if raw.range(of: "^(A|An|The|Claude|One)\\s", options: .regularExpression) != nil { return (nil, raw) }
        return (raw, nil)
    }

    static func tilde(_ path: String?) -> String? {
        guard let p = path, !p.isEmpty else { return nil }
        let home = NSHomeDirectory()
        return p.hasPrefix(home) ? "~" + p.dropFirst(home.count) : p
    }

    private func rise(_ i: Int) -> Double { Ease.out((age - 1.0 - Double(i) * 0.06) / 0.32) }

    var body: some View {
        let t = HybridTheme.of(scheme, increaseContrast: contrast == .increased)
        let card = model.claudeCard
        let parts = Self.split(card.command)
        let reason = parts.sentence ?? (model.claudeSays.isEmpty ? nil : ViewText.truncate(ViewText.stripMarkdown(model.claudeSays), 240))
        let term = model.terminalName ?? "the terminal"
        // A short panel keeps the command and the action; the reason and the note give way.
        let compact = layout.pageBottom - layout.pageTop < 230
        VStack(alignment: .leading, spacing: 0) {
            if let cmd = parts.command {
                Text(verbatim: cmd).font(.system(size: (layout.serif * 0.9).rounded(), weight: .medium, design: .monospaced))
                    .foregroundStyle(t.ink).lineSpacing(4).lineLimit(compact ? 2 : 6).fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .padding(.bottom, 10)
                    .modifier(Rise(r: rise(0)))
            }
            if !compact, let cwd = Self.tilde(model.status?.owner?.cwd) {
                (Text("in ") + Text(cwd).font(.system(size: 12.5, design: .monospaced)))
                    .font(.system(size: 12.5)).foregroundStyle(t.ink2).lineLimit(1).truncationMode(.middle)
                    .padding(.bottom, 22)
                    .modifier(Rise(r: rise(1)))
            }
            if !compact, let why = reason {
                Text(MarkdownText.inline(why, size: layout.serif - 2, hair: t.hair2)).font(HybridTheme.serif(layout.serif - 2))
                    .foregroundStyle(t.ink2).lineSpacing(max(0, layout.lineHeight - 4 - (layout.serif - 2) * 1.19))
                    .truncationMode(.tail)
                    .frame(minHeight: 0, alignment: .topLeading)
                    .layoutPriority(-1)
                    .modifier(Rise(r: rise(2)))
            }
            if compact, parts.command == nil, let why = reason {
                Text(why).font(HybridTheme.serif(layout.serif - 2)).foregroundStyle(t.ink2).lineLimit(2).modifier(Rise(r: rise(2)))
            }
            Spacer(minLength: compact ? 6 : 12)
            VStack(alignment: .leading, spacing: 12) {
                if !compact {
                (Text("Claude will not continue until you answer in ") + Text(term).fontWeight(.semibold).foregroundColor(t.needInk) + Text("."))
                    .font(.system(size: 12.5)).foregroundStyle(t.ink2).fixedSize(horizontal: false, vertical: true)
                    .modifier(Rise(r: rise(3)))
                }
                if let show = model.showTerminal {
                    Button(action: show) {
                        Text("Show terminal").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(QuietCapsuleStyle(height: 44, tone: t.needInk, lineWidth: 1.5))
                    .overlay(Capsule().strokeBorder(t.need, lineWidth: 1.5).allowsHitTesting(false))
                    .background(PanelFrames.reader("show-terminal"))
                    .modifier(Rise(r: rise(4)))
                }
            }
        }
        .padding(.top, 2)
        .padding(.bottom, 4)
        .frame(minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }
}

/// Opacity and a 10 pt lift: the rise. Transform only, so layout never moves.
struct Rise: ViewModifier {
    let r: Double
    func body(content: Content) -> some View {
        content.opacity(r).offset(y: (1 - r) * 10)
    }
}

// MARK: - State body (key, microphone, off, lost...)

/// A state card's text set on the page: the title, the body in serif, numbered steps, and
/// actions as quiet capsules. No box, no tint: the tone is in the words.
struct StateBody: View {
    let model: StateModel
    let card: ViewText.Card
    let layout: HybridLayout
    @Environment(\.sottoStill) private var still
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    @State private var keyText = ""
    @State private var keyError: String?
    @State private var saving = false

    var body: some View {
        let t = HybridTheme.of(scheme, increaseContrast: contrast == .increased)
        VStack(alignment: .leading, spacing: 12) {
            Text(card.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(card.tone == "err" ? t.err : t.ink)
                .fixedSize(horizontal: false, vertical: true)
            Text(card.body).font(HybridTheme.serif(layout.serif - 2)).foregroundStyle(t.ink2)
                .lineSpacing(4).fixedSize(horizontal: false, vertical: true)
            if let steps = card.steps {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(steps.enumerated()), id: \.offset) { i, s in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("\(i + 1).").monospacedDigit().foregroundStyle(t.fg3)
                            Text(s).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .font(.system(size: 13)).foregroundStyle(t.ink)
            }
            if let link = card.link {
                Button(link.label) { if let u = URL(string: link.href) { NSWorkspace.shared.open(u) } }
                    .buttonStyle(QuietCapsuleStyle(height: 32))
            }
            if let note = card.note { Text(note).font(.system(size: 12)).foregroundStyle(t.fg3).fixedSize(horizontal: false, vertical: true) }
            if card.keyInput { keyInput(t) }
            if let b = card.button {
                HStack(spacing: 10) {
                    Button(b) { model.perform(card.action) }
                        .buttonStyle(QuietCapsuleStyle(height: 36))
                        .keyboardShortcut(card.kbd ? KeyboardShortcut(.space, modifiers: []) : nil)
                    if card.kbd { Text("or press Space").font(.system(size: 12)).foregroundStyle(t.fg3) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private func keyInput(_ t: HybridTheme) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Group {
                    if still {
                        // ImageRenderer cannot draw AppKit fields; a look-alike for the still frame.
                        Text("Paste your key (sk-...)").font(.system(size: 13)).foregroundStyle(t.fg3)
                            .padding(.horizontal, 10).frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
                            .overlay(Capsule().strokeBorder(t.hair2))
                    } else {
                        SecureField("Paste your key (sk-...)", text: $keyText).textFieldStyle(.roundedBorder)
                    }
                }
                .accessibilityLabel("OpenAI API key")
                .onSubmit(save)
                Button(saving ? "Checking\u{2026}" : "Save key", action: save)
                    .buttonStyle(QuietCapsuleStyle(height: 30))
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
}

// MARK: - Connect steps

struct StepsView: View {
    let steps: [ViewText.Step]
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    var body: some View {
        let t = HybridTheme.of(scheme, increaseContrast: contrast == .increased)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(steps, id: \.key) { s in
                HStack(spacing: 10) {
                    Group {
                        switch s.state {
                        case "done": Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(t.ink2)
                        case "active": Spinner(color: t.ink2)
                        default: Circle().strokeBorder(t.ink3, lineWidth: 1).frame(width: 10, height: 10)
                        }
                    }
                    .frame(width: 14, height: 14)
                    Text(s.label).font(.system(size: 13)).foregroundStyle(s.state == "pending" ? t.fg3 : t.ink)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(s.label): \(s.state == "done" ? "done" : s.state == "active" ? "in progress" : "waiting")")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
