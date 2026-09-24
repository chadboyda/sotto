// The instrument dial (native port of web/dial.js), around the mute button.
//
// Rings, from the centre out, each voice with its own FORM, not only its own colour:
//   inner ring  - you: 48 short capsules driven by the mic level, jagged, with peak dots.
//                 Muted: violet dots. Sleeping: the wake detector's level plus a slow breath.
//   channel     - an empty band so the two voices never merge.
//   outer ring  - Sotto: 144 hairlines under a mirror-symmetric envelope driven by the
//                 speaker level.
//   bezel       - 120 fine ticks, majors every 30 degrees. While Claude Code works a blue
//                 chase of 16 ticks travels round (the bezel is Claude Code's ring).
//   rim         - a grey comet while connecting; a dashed amber pulse while Claude waits
//                 for approval.
//   bloom       - a soft halo following the loudest talker.
//
// Cost: TimelineView(.animation) runs only while something moves (sound, the chase,
// the sweep, the approval pulse, a morph); a quiet listening panel is paused, and
// sleeping breathes at 5 fps. Reduce Motion: levels snap to rest / mid / full and
// nothing moves on its own; every state keeps its own static shape.
import SwiftUI

/// What the dial shows; a pure function of the model (tests and snapshots build it directly).
public struct DialInput: Equatable, Sendable {
    public var floor: String          // listening | you | voice | muted | connecting | reconnecting | sleeping | paused | off | error | starting
    public var working: Bool
    public var attention: Bool
    public var mic: Double
    public var voice: Double
    public init(floor: String, working: Bool = false, attention: Bool = false, mic: Double = 0, voice: Double = 0) {
        self.floor = floor; self.working = working; self.attention = attention; self.mic = mic; self.voice = voice
    }
    var live: Bool { ["listening", "you", "voice", "muted"].contains(floor) }
    var linking: Bool { floor == "connecting" || floor == "reconnecting" }
    var sleeping: Bool { floor == "sleeping" }
    /// Motion that needs frames even without sound.
    var selfMoving: Bool { working || attention || linking }
}

/// Smoothing state carried between frames (a reference so Canvas can advance it).
final class DialEngine {
    static let nIn = 48, nOut = 72, nHair = 144, nBezel = 120, nChase = 16
    var mic = 0.0, voice = 0.0
    var inLen = [Double](repeating: 0, count: nIn)
    var inPeak = [Double](repeating: 0, count: nIn)
    var inPeakAt = [Double](repeating: 0, count: nIn)
    var outLen = [Double](repeating: 0, count: nOut)
    var shape = (inVis: 0.55, outVis: 0.55, dots: 0.0, dormant: 1.0, attn: 0.0)
    var last: Double = 0
    var settled = true

    static func smooth(_ p: Double, _ t: Double, _ dt: Double, _ attack: Double, _ release: Double) -> Double {
        let tt = min(1, max(0, t))
        let tau = tt > p ? attack : release
        return tau <= 0 ? tt : p + (tt - p) * (1 - exp(-dt / tau))
    }

    static func quantize(_ v: Double) -> Double { v > 0.15 ? (v < 0.6 ? 0.5 : 1) : 0 }

    /// Deterministic per-capsule roughness (the page uses the mic spectrum; the app has one level).
    static func band(_ i: Int, _ t: Double) -> Double {
        let a = sin(Double(i) * 12.9898 + t * 7.3) * 43758.5453
        let n = a - floor(a)
        return 0.35 + 0.65 * n
    }

    /// The outer envelope's calm, mirrored profile: 4 lobes that drift slowly.
    static func lobe(_ i: Int, _ t: Double) -> Double {
        let x = Double(i) / Double(nOut) * 2 * .pi
        return 0.55 + 0.45 * pow(abs(cos(2 * x + 0.35 * sin(t * 0.9))), 1.5)
    }

    func step(_ d: DialInput, now: Double, reduced: Bool) {
        let dt = last == 0 ? 16 : min(250, (now - last) * 1000)
        last = now
        let tg = (inVis: d.live ? 1.0 : d.linking ? 0.7 : d.sleeping ? 0.8 : 0.55,
                  outVis: d.live ? 1.0 : d.linking ? 0.8 : d.sleeping ? 0.35 : 0.55,
                  dots: d.floor == "muted" ? 1.0 : 0, dormant: d.live ? 0.0 : d.sleeping ? 0.6 : 1, attn: d.attention ? 1.0 : 0)
        let k = reduced ? 1 : 1 - exp(-dt / 70)
        var moving = false
        func ap(_ c: Double, _ t: Double) -> Double { let n = c + (t - c) * k; if abs(n - t) <= 0.002 { return t }; moving = true; return n }
        shape = (ap(shape.inVis, tg.inVis), ap(shape.outVis, tg.outVis), ap(shape.dots, tg.dots), ap(shape.dormant, tg.dormant), ap(shape.attn, tg.attn))
        let micT = d.floor == "muted" ? 0 : d.mic
        if reduced { mic = Self.quantize(micT); voice = Self.quantize(d.voice) }
        else { mic = Self.smooth(mic, micT, dt, 40, 220); voice = Self.smooth(voice, d.voice, dt, 60, 320) }
        if mic < 0.002 { mic = 0 }
        if voice < 0.002 { voice = 0 }
        if mic > 0 || voice > 0 { moving = true }
        let t = now
        for i in 0..<Self.nIn {
            let want = reduced ? mic : mic * (0.22 + 0.78 * pow(Self.band(i, t), 1.4))
            inLen[i] = reduced ? want : Self.smooth(inLen[i], want, dt, 30, 200)
            if inLen[i] < 0.002 { inLen[i] = 0 }
            if inLen[i] >= inPeak[i] { inPeak[i] = inLen[i]; inPeakAt[i] = now }
            else if (now - inPeakAt[i]) * 1000 > 520 { inPeak[i] = max(inLen[i], inPeak[i] - 1.4 * dt / 1000) }
            if inLen[i] > 0 || inPeak[i] > 0.002 { moving = true }
        }
        for i in 0..<Self.nOut {
            let want = reduced ? voice : voice * (0.12 + 0.88 * pow(Self.lobe(i, t), 1.8))
            outLen[i] = reduced ? want : Self.smooth(outLen[i], want, dt, 70, 300)
            if outLen[i] < 0.002 { outLen[i] = 0 }
            if outLen[i] > 0 { moving = true }
        }
        settled = !moving
    }

    func envelope(_ j: Int) -> Double {
        let x = Double(j) * Double(Self.nOut) / Double(Self.nHair)
        let i0 = Int(x) % Self.nOut, i1 = (i0 + 1) % Self.nOut
        let f = (1 - cos((x - x.rounded(.down)) * .pi)) / 2
        return outLen[i0] * (1 - f) + outLen[i1] * f
    }
}

public struct DialView: View {
    let input: DialInput
    let muteLabel: String
    let muteAction: () -> Void
    let muteEnabled: Bool
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotionEnv
    @State private var engine = DialEngine()
    /// Forces a still frame at a fixed time (snapshots).
    var stillAt: Double?
    var reducedOverride: Bool?
    /// Changes when the container wants `needsFrames` re-evaluated (sound stopped).
    var settleTick: Int

    public init(input: DialInput, muteLabel: String, muteEnabled: Bool = true, stillAt: Double? = nil, reduced: Bool? = nil, settleTick: Int = 0,
                muteAction: @escaping () -> Void) {
        self.input = input; self.muteLabel = muteLabel; self.muteEnabled = muteEnabled; self.stillAt = stillAt; self.settleTick = settleTick
        self.reducedOverride = reduced; self.muteAction = muteAction
    }

    private var reduced: Bool { reducedOverride ?? reduceMotionEnv }

    /// Frames are needed while sound or a self-moving layer is on screen.
    private var needsFrames: Bool {
        if stillAt != nil { return false }
        if reduced { return !engine.settled || input.mic > 0.01 || input.voice > 0.01 }
        return input.selfMoving || input.mic > 0.01 || input.voice > 0.01 || !engine.settled
    }

    public var body: some View {
        let theme = Theme.of(scheme)
        GeometryReader { geo in
            let size = min(geo.size.width, geo.size.height)
            ZStack {
                timeline(theme: theme)
                muteButton(theme: theme, size: size)
            }
            .frame(width: size, height: size)
            .position(x: geo.size.width / 2, y: geo.size.height / 2)
        }
        .aspectRatio(1, contentMode: .fit)
    }

    @ViewBuilder private func timeline(theme: Theme) -> some View {
        if let t = stillAt {
            canvas(theme: theme, now: t, warm: true)
        } else if input.sleeping && !reduced && !needsFrames {
            TimelineView(.periodic(from: .now, by: 0.2)) { ctx in canvas(theme: theme, now: ctx.date.timeIntervalSinceReferenceDate, warm: false) }
        } else {
            TimelineView(.animation(minimumInterval: nil, paused: !needsFrames)) { ctx in
                canvas(theme: theme, now: ctx.date.timeIntervalSinceReferenceDate, warm: false)
            }
        }
    }

    private func canvas(theme: Theme, now: Double, warm: Bool) -> some View {
        let input = self.input, reduced = self.reduced, engine = self.engine
        return Canvas(rendersAsynchronously: false) { g, sz in
            if warm {
                // A still frame: settle the smoothing as if the levels had held for a while.
                for i in 0..<40 { engine.step(input, now: now - Double(40 - i) * 0.033, reduced: reduced) }
            }
            engine.step(input, now: now, reduced: reduced)
            DialPainter.draw(g, size: sz, input: input, engine: engine, theme: theme, now: now, reduced: reduced)
        }
        .accessibilityHidden(true)
    }

    private func muteButton(theme: Theme, size: CGFloat) -> some View {
        let d = size * 0.405 * 2 * 0.5
        let muted = input.floor == "muted"
        let ringColor: Color = muted ? theme.mute : input.live ? theme.live : theme.edge
        let icon = muted ? "mic.slash.fill" : input.sleeping ? "moon.zzz" : "mic"
        return Button(action: muteAction) {
            ZStack {
                Circle().fill(muted ? theme.muteTint : theme.surface2)
                Circle().strokeBorder(ringColor, lineWidth: input.live ? 2 : 1)
                Image(systemName: icon)
                    .font(.system(size: d * 0.3, weight: .regular))
                    .foregroundStyle(muted ? theme.mute : theme.fg)
                    .contentTransition(.symbolEffect(.replace))
            }
            .frame(width: d, height: d)
            .shadow(color: .black.opacity(theme.dark ? 0.4 : 0.1), radius: 6, y: 3)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!muteEnabled)
        .accessibilityLabel(muteLabel)
        .accessibilityHint(muted ? "Sotto can't hear you. Still billing." : "")
        .help(muteLabel + " (M)")
    }
}

enum DialPainter {
    static let inR = 0.48, inRest = 0.04, inMax = 0.12, outR = 0.72, outRest = 0.028, outMax = 0.165
    static let bezelR = 0.975, bezelTick = 0.028, bezelMajor = 0.05, rimR = 0.992

    static func point(_ c: CGPoint, _ r: Double, _ a: Double) -> CGPoint { CGPoint(x: c.x + cos(a) * r, y: c.y + sin(a) * r) }

    static func draw(_ g: GraphicsContext, size sz: CGSize, input d: DialInput, engine e: DialEngine, theme t: Theme, now: Double, reduced: Bool) {
        let size = min(sz.width, sz.height)
        let R = size / 2
        let c = CGPoint(x: sz.width / 2, y: sz.height / 2)
        let scale = size / 208
        let top = -Double.pi / 2, tau = Double.pi * 2
        let every = size < 160 ? 2 : 1

        // Bloom.
        let glow = max(e.mic, e.voice) * 0.9 + (d.floor == "muted" ? 0.3 : 0) + (d.attention ? 0.35 : 0)
        if glow > 0.02 {
            let bc = d.attention ? t.bloomAttn : d.floor == "muted" ? t.bloomMute : (d.floor == "voice" || e.voice > e.mic) ? t.bloomVoice : t.bloomYou
            let a = reduced ? (glow > 0.05 ? 0.6 : 0) : min(1, glow)
            var gg = g
            gg.opacity = a
            gg.fill(Path(ellipseIn: CGRect(x: c.x - R, y: c.y - R, width: size, height: size)),
                    with: .radialGradient(Gradient(stops: [.init(color: bc, location: 0), .init(color: bc.opacity(0.4), location: 0.55), .init(color: bc.opacity(0), location: 1)]),
                                          center: c, startRadius: 0.4 * R, endRadius: R))
        }

        // Bezel: hairline circle + 120 ticks.
        g.stroke(Path(ellipseIn: CGRect(x: c.x - bezelR * R, y: c.y - bezelR * R, width: 2 * bezelR * R, height: 2 * bezelR * R)), with: .color(t.line), lineWidth: 1)
        var bez = Path()
        for i in stride(from: 0, to: DialEngine.nBezel, by: 1) {
            let a = top + Double(i) / Double(DialEngine.nBezel) * tau
            let r1 = bezelR * R, r2 = r1 - (i % 10 == 0 ? bezelMajor : bezelTick) * R
            bez.move(to: point(c, r1, a)); bez.addLine(to: point(c, r2, a))
        }
        let dormantA = 1 - e.shape.dormant * 0.4
        g.stroke(bez, with: .color(t.fg3.opacity(0.45 * dormantA)), lineWidth: max(0.75, 0.9 * scale))

        // Work chase: 16 blue ticks, head advancing one tick per 1/30 s * 3 (a turn every 4 s), tail fading.
        if d.working && !d.attention {
            let headTick = reduced ? 0 : Int((now / 4).truncatingRemainder(dividingBy: 1) * Double(DialEngine.nBezel))
            for k in 0..<DialEngine.nChase {
                let i = headTick - (DialEngine.nChase - 1 - k)
                let a = top + Double(i) / Double(DialEngine.nBezel) * tau
                let r1 = bezelR * R, r2 = r1 - bezelMajor * 1.35 * R
                var p = Path(); p.move(to: point(c, r1, a)); p.addLine(to: point(c, r2, a))
                let alpha = 0.18 + 0.82 * pow(Double(k + 1) / Double(DialEngine.nChase), 1.6)
                g.stroke(p, with: .color(t.work.opacity(alpha)), style: StrokeStyle(lineWidth: 2.5 * scale, lineCap: .round))
            }
        }

        // Outer ring (Sotto): hairlines under a mirrored envelope.
        let outerColor: Color = d.floor == "voice" || e.voice > 0.05 ? t.voice : d.live ? t.voiceRest : t.tickRest
        var hair = Path(), envTip = Path()
        for j in stride(from: 0, to: DialEngine.nHair, by: every) {
            let a = top + Double(j) / Double(DialEngine.nHair) * tau
            let len = (outRest + e.envelope(j) * outMax) * e.shape.outVis
            let r1 = outR * R, r2 = r1 + len * R
            hair.move(to: point(c, r1, a)); hair.addLine(to: point(c, r2, a))
            if j == 0 { envTip.move(to: point(c, r2, a)) } else { envTip.addLine(to: point(c, r2, a)) }
        }
        envTip.closeSubpath()
        g.stroke(hair, with: .color(outerColor.opacity(0.45 * dormantA + min(0.25, e.voice * 0.3))), lineWidth: max(0.5, 0.6 * scale))
        if e.voice > 0.01 {
            g.stroke(envTip, with: .color(outerColor.opacity(min(0.9, 0.35 + e.voice * 0.6))), lineWidth: 1.1 * scale)
        }

        // Inner ring (you): capsules, or violet dots when muted.
        let muted = d.floor == "muted"
        let innerColor: Color = muted ? t.mute : (d.live || d.sleeping) ? t.live : t.tickRest
        let breath = (d.sleeping && !reduced) ? 0.5 - 0.5 * cos(now / 6.4 * tau) : 0
        for i in stride(from: 0, to: DialEngine.nIn, by: every) {
            let a = top + Double(i) / Double(DialEngine.nIn) * tau
            let r1 = inR * R
            if e.shape.dots > 0.5 {
                let p = point(c, r1 + inRest * R * 0.5, a)
                let rr = 1.6 * scale
                g.fill(Path(ellipseIn: CGRect(x: p.x - rr, y: p.y - rr, width: 2 * rr, height: 2 * rr)), with: .color(innerColor))
                continue
            }
            let len = (inRest * (1 + 0.5 * breath) + e.inLen[i] * inMax) * e.shape.inVis
            var p = Path(); p.move(to: point(c, r1, a)); p.addLine(to: point(c, r1 + len * R, a))
            g.stroke(p, with: .color(innerColor.opacity(dormantA * (0.75 + 0.25 * min(1, e.inLen[i] * 3)))), style: StrokeStyle(lineWidth: 3.2 * scale, lineCap: .round))
            if e.inPeak[i] > e.inLen[i] + 0.02 && !reduced {
                let pp = point(c, r1 + (inRest + e.inPeak[i] * inMax) * R + 2.5 * scale, a)
                let rr = 1.1 * scale
                g.fill(Path(ellipseIn: CGRect(x: pp.x - rr, y: pp.y - rr, width: 2 * rr, height: 2 * rr)), with: .color(innerColor.opacity(0.7)))
            }
        }

        // Rim: connecting comet, approval dashed pulse.
        let rimRadius = rimR * R - 1.5 * scale
        if d.linking {
            let head = reduced ? 0.3 : (now / 1.4).truncatingRemainder(dividingBy: 1)
            let span = 0.3
            let segs = 24
            for s in 0..<segs {
                let f0 = Double(s) / Double(segs), f1 = Double(s + 1) / Double(segs)
                var p = Path()
                p.addArc(center: c, radius: rimRadius, startAngle: .radians(top + (head - span + span * f0) * tau),
                         endAngle: .radians(top + (head - span + span * f1) * tau), clockwise: false)
                g.stroke(p, with: .color(t.fg3.opacity(pow(f1, 1.5))), lineWidth: 1.8 * scale)
            }
            let hp = point(c, rimRadius, top + head * tau), hr = 1.8 * scale * 0.9
            g.fill(Path(ellipseIn: CGRect(x: hp.x - hr, y: hp.y - hr, width: 2 * hr, height: 2 * hr)), with: .color(t.fg3))
        }
        if d.attention {
            let pulse = reduced ? 1 : 0.55 + 0.45 * (0.5 + 0.5 * sin(now * tau / 1.6))
            var p = Path()
            p.addEllipse(in: CGRect(x: c.x - rimRadius, y: c.y - rimRadius, width: 2 * rimRadius, height: 2 * rimRadius))
            g.stroke(p, with: .color(t.attn.opacity(pulse * e.shape.attn)), style: StrokeStyle(lineWidth: 3 * scale, dash: [10 * scale, 5 * scale]))
        }
    }
}
