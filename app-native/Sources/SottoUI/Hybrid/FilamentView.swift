// The hero as views (IMPLEMENTATION.md §3, §5): one Canvas in a TimelineView that is
// paused whenever nothing moves (0 fps idle), 10 fps while only Claude's bead travels,
// at most 15 fps for the sleeping shiver, 60 fps while someone speaks or a one-shot
// (eclipse, sunrise, finish, persona switch) runs. The corona's shimmer has its own
// 30 fps timeline on a quad around the peg, so a held approval redraws only that.
import SwiftUI
import SottoClient

/// Claude's glyph: a moon phase (new, waxing, eclipsed, full). The phases differ in fill,
/// so they read without colour.
public struct MoonGlyph: View {
    public let phase: HybridText.Phase
    public var size: CGFloat = 12
    public init(phase: HybridText.Phase, size: CGFloat = 12) { self.phase = phase; self.size = size }

    public var body: some View {
        Canvas { g, sz in
            let k = min(sz.width, sz.height) / 12
            Self.draw(g, phase, scale: k, origin: .zero)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    /// Draw the phase in a 12 x 12 box scaled by `k`, in the context's foreground style.
    static func draw(_ g: GraphicsContext, _ phase: HybridText.Phase, scale k: CGFloat, origin o: CGPoint, style: GraphicsContext.Shading = .foreground) {
        func circ(_ r: CGFloat) -> Path { Path(ellipseIn: CGRect(x: o.x + (6 - r) * k, y: o.y + (6 - r) * k, width: 2 * r * k, height: 2 * r * k)) }
        switch phase {
        case .idle:
            g.stroke(circ(4.6), with: style, lineWidth: 1.2 * k)
        case .work:
            var l = g
            l.opacity = 0.45
            l.stroke(circ(4.6), with: style, lineWidth: 1.2 * k)
            var right = Path()
            right.addArc(center: CGPoint(x: o.x + 6 * k, y: o.y + 6 * k), radius: 4.6 * k, startAngle: .degrees(-90), endAngle: .degrees(90), clockwise: false)
            right.closeSubpath()
            let terminator = Path(ellipseIn: CGRect(x: o.x + 3.8 * k, y: o.y + 1.4 * k, width: 4.4 * k, height: 9.2 * k))
            g.fill(right.subtracting(terminator), with: style)
        case .need:
            g.stroke(circ(5.2), with: style, lineWidth: 1.3 * k)
            g.fill(circ(3.3), with: style)
        case .done:
            g.fill(circ(4.8), with: style)
        }
    }
}

/// The menu-bar glyph (IMPLEMENTATION.md §3): Claude's moon on the end of a short string,
/// 22 x 16. Needs you is the one non-template frame: a gold ring, eight corona ticks and a
/// gold string.
public struct MenuBarGlyph: View {
    public let phase: HybridText.Phase
    /// The voice is muted: the string is cut near the moon.
    public var cut = false
    public init(phase: HybridText.Phase, cut: Bool = false) { self.phase = phase; self.cut = cut }
    public static let gold = Color.hex(0xFFB547)

    public var body: some View {
        Canvas { g, _ in
            let need = phase == .need
            var str = Path()
            str.move(to: CGPoint(x: cut ? 14.6 : 12.2, y: 8)); str.addLine(to: CGPoint(x: 20.5, y: 8))
            g.stroke(str, with: need ? .color(Self.gold) : .foreground, style: StrokeStyle(lineWidth: 1.4, lineCap: .round))
            if need {
                var rays = Path()
                for i in 0..<8 {
                    let a = Double(i) * .pi / 4 + .pi / 8
                    rays.move(to: CGPoint(x: 6 + cos(a) * 5.4, y: 8 + sin(a) * 5.4))
                    rays.addLine(to: CGPoint(x: 6 + cos(a) * 7, y: 8 + sin(a) * 7))
                }
                g.stroke(rays, with: .color(Self.gold), style: StrokeStyle(lineWidth: 1.1, lineCap: .round))
                let disc = Path(ellipseIn: CGRect(x: 6 - 4.1, y: 8 - 4.1, width: 8.2, height: 8.2))
                g.fill(disc, with: .foreground)
                g.stroke(disc, with: .color(Self.gold), lineWidth: 1.3)
            } else {
                MoonGlyph.draw(g, phase == .idle ? .idle : phase, scale: 7.8 / 9.2, origin: CGPoint(x: 6 - 6 * 7.8 / 9.2, y: 8 - 6 * 7.8 / 9.2))
            }
        }
        .frame(width: 22, height: 16)
    }
}

extension FilamentInput {
    /// The hero's input from the model at `now` (levels included).
    @MainActor
    static func from(_ m: StateModel, reduced: Bool) -> FilamentInput {
        var i = FilamentInput()
        let v = m.pageView
        switch v.floor {
        case "sleeping": i.mode = .sleeping
        case "paused": i.mode = .paused
        case "connecting", "reconnecting", "starting": i.mode = .connecting
        case "listening", "you", "voice", "muted": i.mode = .live
        default: i.mode = .off
        }
        if v.view == "card" && v.card?.kind != "sleeping" && v.card?.kind != "paused" && v.card?.kind != "cap" { i.mode = .off }
        if v.card?.kind == "cap" { i.mode = .paused }
        i.floor = m.floor
        i.muted = m.effectiveMuted
        i.cantHear = m.cantHear
        i.attention = m.attention && v.view == "live"
        i.busy = m.claudeBusy && !m.attention
        i.workSince = m.workSince?.timeIntervalSinceReferenceDate
        i.attentionAt = m.attentionAt?.timeIntervalSinceReferenceDate
        i.clearedAt = m.attentionClearedAt?.timeIntervalSinceReferenceDate
        i.finishedAt = m.finishedAt?.timeIntervalSinceReferenceDate
        i.wokeAt = m.wokeAt?.timeIntervalSinceReferenceDate
        i.persona = m.personaId
        if let sw = m.personaSwitch { i.personaFrom = sw.from; i.personaAt = sw.at.timeIntervalSinceReferenceDate }
        i.mic = Double(m.micLevel)
        i.voice = Double(m.speakerLevel)
        i.wake = Double(m.wakeLevel)
        i.stars = m.milestones.map { .init(s: $0.s, born: $0.born.timeIntervalSinceReferenceDate) }
        i.reduced = reduced
        return i
    }
}

/// The canvas plus the corona quad, covering the whole panel. Reads the levels, so level
/// updates re-render this view alone.
struct FilamentStage: View {
    let model: StateModel
    let layout: HybridLayout
    var stillAt: Double?
    @State private var engine = FilamentEngine()
    @State private var settle = 0
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceMotion) private var reduceMotionEnv

    private var reduced: Bool { reduceMotionEnv || model.reducedMotion }

    var body: some View {
        let theme = HybridTheme.of(scheme, increaseContrast: contrast == .increased)
        let palette = Palette.of(theme)
        let input = FilamentInput.from(model, reduced: reduced)
        let now = stillAt ?? Date().timeIntervalSinceReferenceDate
        let _ = engine.observe(input, now: now)
        let rate: FilamentEngine.Rate = stillAt != nil ? .paused : engine.rate(input, now: now)
        let visible = model.panelVisible
        let L = layout
        ZStack(alignment: .topLeading) {
            if let t = stillAt {
                canvas(input, palette, L, fixed: t, warm: true)
            } else {
                TimelineView(.animation(minimumInterval: rate.interval, paused: rate == .paused || !visible)) { ctx in
                    canvas(input, palette, L, fixed: ctx.date.timeIntervalSinceReferenceDate, warm: false)
                }
            }
            CoronaLayer(input: input, layout: L, palette: palette, stillAt: stillAt, visible: visible)
        }
        .frame(width: L.size.width, height: L.size.height)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        // While frames run, look every 250 ms for the moment nothing moves any more, then
        // re-evaluate `rate` so the timeline pauses (0 fps idle).
        .task(id: RateKey(rate: rate, settle: settle, visible: visible)) {
            guard stillAt == nil, rate != .paused, visible else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                if Task.isCancelled { return }
                let i2 = FilamentInput.from(model, reduced: reduced)
                if engine.rate(i2, now: Date().timeIntervalSinceReferenceDate) != rate { settle &+= 1; return }
            }
        }
    }

    private struct RateKey: Hashable { var rate: FilamentEngine.Rate; var settle: Int; var visible: Bool }

    private func canvas(_ input: FilamentInput, _ palette: Palette, _ L: HybridLayout, fixed now: Double, warm: Bool) -> some View {
        let engine = self.engine
        return Canvas(rendersAsynchronously: false) { g, _ in
            if warm {
                // A still frame: the same simulation, run up to the instant from a quiet start.
                engine.reset()
                engine.settleClocks(now: now)
                engine.advance(input, to: now - 2, sc: Double(L.sc))
                engine.advance(input, to: now - 1.5, sc: Double(L.sc))
                engine.advance(input, to: now - 1, sc: Double(L.sc))
                engine.advance(input, to: now - 0.5, sc: Double(L.sc))
            }
            engine.advance(input, to: now, sc: Double(L.sc))
            FilamentPainter.draw(g, layout: L, input: input, engine: engine, palette: palette, now: now)
        }
    }
}

/// The corona's streamers on a small quad around the peg: 30 fps while an approval holds
/// (paused under Reduce Motion, when hidden, and whenever there is no corona).
struct CoronaLayer: View {
    let input: FilamentInput
    let layout: HybridLayout
    let palette: Palette
    var stillAt: Double?
    var visible = true

    var body: some View {
        let R = Double(layout.pegR)
        let side = R * 2 * 2.5
        let on = input.attention || input.resolveAge(stillAt ?? Date().timeIntervalSinceReferenceDate) != nil
        if on {
            Group {
                if let t = stillAt { quad(t, R: R, side: side) } else {
                    TimelineView(.animation(minimumInterval: 1.0 / 30, paused: input.reduced || !visible)) { ctx in
                        quad(ctx.date.timeIntervalSinceReferenceDate, R: R, side: side)
                    }
                }
            }
            .frame(width: side, height: side)
            .padding(.leading, max(0, layout.pegX - side / 2))
            .padding(.top, max(0, layout.y - side / 2))
        }
    }

    private func quad(_ now: Double, R: Double, side: Double) -> some View {
        let input = self.input, P = palette, mini = layout.mini, L = layout
        // The quad is anchored on the peg; when the peg sits closer than half a side to the
        // edge the quad is clipped there and the centre moves with it.
        let cx = L.pegX - max(0, L.pegX - side / 2), cy = L.y - max(0, L.y - side / 2)
        return Canvas(rendersAsynchronously: false) { g, _ in
            let m = FilamentMoment.at(input, now: now, sc: Double(L.sc), engine: FilamentEngine())
            FilamentPainter.streamers(g, center: CGPoint(x: cx, y: cy), R: R, amount: m.corona, phase: input.reduced ? 0 : now / 3.2, mini: mini, palette: P)
        }
    }
}
