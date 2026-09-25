// One GraphicsContext pass for the hero (IMPLEMENTATION.md §3 FilamentCanvas): umbra,
// string plus bloom, tides, persona ghost, stars, bead, frame, peg, eclipse, arriving
// moon. The corona's streamers are the one layer drawn elsewhere (CoronaLayer), so the
// only motion held during an approval is a small quad, not this whole canvas.
import SwiftUI
import AppKit

/// A colour as components, for mixing along the string.
struct RGBA: Equatable {
    var r, g, b, a: Double
    init(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) { self.r = r; self.g = g; self.b = b; self.a = a }
    init(_ c: Color) {
        let ns = NSColor(c).usingColorSpace(.sRGB) ?? .black
        self.init(Double(ns.redComponent), Double(ns.greenComponent), Double(ns.blueComponent), Double(ns.alphaComponent))
    }
    func color(_ alpha: Double = 1) -> Color { Color(.sRGB, red: r, green: g, blue: b, opacity: max(0, min(1, a * alpha))) }
    static func mix(_ x: RGBA, _ y: RGBA, _ t: Double) -> RGBA {
        let t = max(0, min(1, t))
        return RGBA(x.r + (y.r - x.r) * t, x.g + (y.g - x.g) * t, x.b + (y.b - x.b) * t, x.a + (y.a - x.a) * t)
    }
}

struct Palette {
    var ground, ink, string, bead, you, voice, need, muted, star, night, pale, dawn: RGBA
    var glow: Double
    /// The live string's opacity at rest (its colour is you -> voice).
    var restAlpha: Double
    var dark: Bool
    var increaseContrast: Bool

    static let darkP = Palette(HybridTheme.darkTheme)
    static let lightP = Palette(HybridTheme.lightTheme)

    static func of(_ t: HybridTheme) -> Palette {
        if t.increaseContrast { return Palette(t) }
        return t.dark ? darkP : lightP
    }

    init(_ t: HybridTheme) {
        ground = RGBA(t.ground); ink = RGBA(t.ink); string = RGBA(t.string); bead = RGBA(t.bead); you = RGBA(t.you)
        voice = RGBA(t.voice); need = RGBA(t.need); muted = RGBA(t.muted); star = RGBA(t.star); night = RGBA(t.night)
        pale = RGBA(HybridTheme.coronaPale); dawn = RGBA(HybridTheme.dawn)
        glow = t.glow; restAlpha = t.restAlpha; dark = t.dark; increaseContrast = t.increaseContrast
    }
}

enum FilamentPainter {
    static let n = FilamentEngine.n

    /// Tide envelopes per tuning id (computed once).
    nonisolated(unsafe) private static var envCache: [String: [Double]] = [:]
    static func envelope(_ t: Tuning, exact: Bool) -> [Double] {
        if exact { return t.envelope(points: n) }
        if let e = envCache[t.id] { return e }
        let e = t.envelope(points: n)
        envCache[t.id] = e
        return e
    }

    /// Reduce Motion: a frozen pluck decaying from the peg.
    static func rmPluck(_ i: Int) -> Double {
        let s = Double(i) / Double(n - 1)
        guard s < 0.55 else { return 0 }
        let h = hash(Double(i))
        return -sin(Double(i) * 1.7) * sin(Double(i) * 0.43 + 1) * 9 * (1 - s / 0.55) * (0.6 + h * 0.6)
    }

    static func hash(_ x: Double) -> Double { let v = sin(x * 127.1 + 311.7) * 43758.5453; return v - v.rounded(.down) }
    static func valueNoise(_ x: Double) -> Double {
        let i = x.rounded(.down), f = x - i, u = f * f * (3 - 2 * f)
        return Ease.lerp(hash(i), hash(i + 1), u)
    }

    static func circle(_ c: CGPoint, _ r: Double) -> Path { Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)) }

    // MARK: - The whole pass

    static func draw(_ g: GraphicsContext, layout L: HybridLayout, input i: FilamentInput, engine e: FilamentEngine, palette P: Palette, now: Double) {
        let sc = Double(L.sc), sc7 = max(sc, 0.7), sc8 = max(sc, 0.8)
        let m = FilamentMoment.at(i, now: now, sc: sc, engine: e)
        let x0 = Double(L.x0), x1 = Double(L.x1), y = Double(L.y), R = Double(L.pegR), px = Double(L.pegX)
        let rm = i.reduced
        let tn = m.tuning

        umbra(g, L, m, P)

        // ---- geometry: plucks (you), harmonics (voice), bead sag, slack, droop.
        let muted = i.muted && i.mode == .live
        var startX = x0, droop = 0.0
        if muted {
            startX = x0 + 16 * sc7
            let t = e.mutedAt.map { now - $0 } ?? 10
            droop = rm ? 20 * sc : 20 * sc * (1 - exp(-t / 0.09) * cos(t * 16))
        }
        var reveal = 1.0
        if i.mode == .connecting, !rm, let c = e.connectingAt { reveal = Ease.inOut((now - c) / 1.4) }
        let slackOn = i.mode == .sleeping || i.mode == .paused || i.mode == .off || m.slackFront != nil
        let A = e.voice * 34 * sc * tn.amp
        let voiceNow = i.floor == "voice" || i.voice > 0.05
        // Listening at rest: the string breathes (FilamentEngine.breathing). A slow standing
        // wave in the persona's own shape plus a faint travelling ripple, under 2 pt: calm,
        // but plainly a live line and not a rule. Never under Reduce Motion.
        let breathing = FilamentEngine.breathing(i, now: now)
        let breathA = breathing ? 1.6 * sc * sin(2 * .pi * FilamentEngine.breathHz * now) : 0
        let shapeMax = max(0.001, (1..<24).map { abs(tn.shape(Double($0) / 24)) }.max() ?? 1)
        var xs = [Double](repeating: 0, count: n), ys = xs, wy = xs, wv = xs, hh = xs
        for k in 0..<n {
            let s = Double(k) / Double(n - 1)
            xs[k] = Ease.lerp(startX, x1, s)
            var h = tn.wave(s, phase: e.phase) * (A + m.gliss)
            var uu = e.u[k]
            if rm {
                uu = i.floor == "you" ? rmPluck(k) * sc : 0
                h = voiceNow ? tn.shape(s) * 14 * sc * tn.amp : 0
            }
            if muted { h *= s }
            if breathing {
                h += breathA * tn.shape(s) / shapeMax
                h += 0.55 * sc * sin(2 * .pi * (2.2 * s - 0.11 * now)) * sin(.pi * s)
            }
            h += m.ring * sin(m.ringK * .pi * s)
            var b = 0.0
            if let bd = m.bead, bd.peg == 0, bd.s > 0, bd.s < 1 {
                let d = 3.6 * sc
                b += (s < bd.s ? d * s / bd.s : d * (1 - s) / (1 - bd.s)) * bd.a
            }
            if slackOn {
                var slack = 1.0
                if let f = m.slackFront { slack = Ease.clamp((s - f) / 0.12) }
                if i.mode == .sleeping || i.mode == .paused || i.mode == .off || m.slackFront != nil { b += 8 * sc * 4 * s * (1 - s) * slack }
            }
            var d = (uu + h) * (1 - m.need)
            let lim = (d > 0 ? 14 : 30) * sc
            d = lim * tanh(d / lim)
            ys[k] = y + d + b + droop * (1 - s) * (1 - s)
            wy[k] = Ease.clamp(abs(uu) / (5 * sc))
            wv[k] = Ease.clamp(abs(h) / (7 * sc))
            hh[k] = h
        }
        let nPts = max(2, Int((Double(n) * reveal).rounded()))
        func path(_ dy: (Int) -> Double = { _ in 0 }, count: Int? = nil) -> Path {
            var p = Path()
            let c = count ?? nPts
            p.move(to: CGPoint(x: xs[0], y: ys[0] + dy(0)))
            for k in 1..<c { p.addLine(to: CGPoint(x: xs[k], y: ys[k] + dy(k))) }
            return p
        }

        // ---- the string, coloured toward you or the voice where it moves, gold at totality.
        let alpha = m.alpha
        var stops: [Gradient.Stop] = []
        // Colour-coded while live: the string runs from you (teal, at the peg) to the voice
        // (periwinkle, at the bridge); whoever holds the floor pulls the whole line to their
        // hue. Muted, asleep, paused and connecting keep the neutral line, so colour means
        // "live and listening".
        let liveColour = i.mode == .live && !muted
        let youFull = RGBA(P.you.r, P.you.g, P.you.b, 1), voiceFull = RGBA(P.voice.r, P.voice.g, P.voice.b, 1)
        let floorPull = i.floor == "you" ? -0.75 : i.floor == "voice" ? 0.75 : 0
        func restColour(_ s: Double) -> RGBA {
            guard liveColour else { return P.string }
            let base = s * s * (3 - 2 * s)
            let t = floorPull < 0 ? base * (1 + floorPull) : base + (1 - base) * floorPull
            let c = RGBA.mix(youFull, voiceFull, t)
            return RGBA(c.r, c.g, c.b, P.restAlpha)
        }
        for j in 0...16 {
            let k = Int((Double(j) / 16 * Double(n - 1)).rounded())
            var c = RGBA.mix(restColour(Double(j) / 16), youFull, wy[k])
            c = RGBA.mix(c, RGBA(P.voice.r, P.voice.g, P.voice.b, 1), wv[k])
            c = RGBA.mix(c, RGBA(P.need.r, P.need.g, P.need.b, 1), m.need)
            stops.append(.init(color: c.color(alpha), location: Double(j) / 16))
        }
        let shading = GraphicsContext.Shading.linearGradient(Gradient(stops: stops), startPoint: CGPoint(x: startX, y: y), endPoint: CGPoint(x: x1, y: y))
        let lw = Ease.lerp(tn.width, 2, m.need) * sc8
        var style = StrokeStyle(lineWidth: lw, lineCap: .round, lineJoin: .round)
        if i.cantHear && i.mode == .live && !muted { style.dash = [2 * sc8, 6 * sc8] }
        let energy = max(e.you * 1.2, e.voice, m.need, i.busy ? 0.35 : 0)
        let restBloom = liveColour ? restColour(i.floor == "you" ? 0 : i.floor == "voice" ? 1 : 0.5) : P.ink
        let bloom: RGBA = m.need > 0.5 ? P.need : e.voice > e.you ? P.voice : e.you > 0.05 ? P.you : restBloom
        let body = path()
        // The resting glow breathes with the line (0.8...1).
        let breathGlow = breathing ? 0.9 + 0.1 * sin(2 * .pi * FilamentEngine.breathHz * now) : 1
        let bloomA = ((liveColour ? 0.34 : 0.25) + 0.6 * energy) * P.glow * alpha * tn.bloom * breathGlow
        if bloomA > 0.01 {
            g.drawLayer { l in
                l.clip(to: Path(CGRect(x: 0, y: y - 60 * sc7, width: Double(L.size.width), height: 120 * sc7)))
                l.addFilter(.shadow(color: bloom.color(bloomA), radius: (8 + 14 * energy) * sc7 / 2))
                l.stroke(body, with: shading, style: style)
            }
        }
        g.stroke(body, with: shading, style: style)
        if tn.doubled > 0.01 {
            // Fern: a doubled string, two fine lines that shimmer against each other.
            var l = g
            l.opacity = 0.55 * tn.doubled
            let p2 = path({ k in let s = Double(k) / Double(n - 1); return 3 * sc * sin(.pi * s) + hh[k] * 0.18 * sin(e.phase * 1.5) })
            l.stroke(p2, with: shading, style: StrokeStyle(lineWidth: lw * 0.8, lineCap: .round, lineJoin: .round))
        }

        // ---- voice tides: symmetric contours in the persona's harmonic envelope.
        if m.need < 0.5 {
            let env0 = envelope(tn, exact: m.fromTuning != nil)
            let env = muted ? env0.enumerated().map { $0.element * Double($0.offset) / Double(n - 1) } : env0
            func tide(_ d: Double, _ a: Double) {
                guard a > 0.005 else { return }
                for sgn in [-1.0, 1.0] {
                    g.stroke(path({ k in sgn * d * env[k] }), with: .color(P.voice.color(a)), lineWidth: sc8)
                }
            }
            if rm {
                if voiceNow { tide(8 * sc, 0.32); tide(15 * sc, 0.14) }
            } else {
                for t in e.tides {
                    let q = (now - t.t) / FilamentEngine.tideLife
                    guard q >= 0, q <= 1 else { continue }
                    tide((4 + 14 * (1 - (1 - q) * (1 - q))) * sc, t.level * pow(1 - q, 1.8) * (P.dark ? 0.5 : 0.4) * alpha)
                }
            }
        }

        // ---- persona switch: the old tuning's shape lifts off the string and drifts away.
        if let q = m.ghost, let from = m.fromTuning {
            var p = Path()
            for k in 0..<n {
                let s = Double(k) / Double(n - 1)
                var hv = 0.0
                for (kk, w) in from.w.enumerated() { hv += w * sin(Double(kk + 1) * .pi * s) * cos(Double(kk) * 0.9) }
                let pt = CGPoint(x: xs[k], y: y - Ease.out(q) * 20 * sc - hv * 11 * sc)
                if k == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
            }
            g.stroke(p, with: .color(P.voice.color(0.6 * pow(1 - q, 1.4))), lineWidth: sc8)
        }

        // ---- milestone stars: fixed on the string, riding its motion; they flash when Claude finishes.
        for (j, st) in i.stars.sorted(by: { $0.s < $1.s }).enumerated() {
            let fi = st.s * Double(n - 1), i0 = min(n - 2, max(0, Int(fi))), f = fi - Double(i0)
            let sx = Ease.lerp(xs[i0], xs[i0 + 1], f), sy = Ease.lerp(ys[i0], ys[i0 + 1], f)
            let age = now - st.born
            let pop = rm ? 1 : (age < 0.45 ? 1 + 0.9 * (1 - age / 0.45) : 1)
            let born = rm ? 1 : Ease.clamp(age / 0.12)
            let fl = m.starFlash(j)
            let r = 3.3 * sc7 * pop * (1 + 1.1 * fl) * born
            guard r > 0.05 else { continue }
            let a = HybridText.starAlpha(age: age) * (1 - 0.55 * m.dim) * max(alpha, 0.45) * (P.increaseContrast ? 1.3 : 1)
            let c = CGPoint(x: sx, y: sy)
            if P.dark && (fl > 0 || pop > 1) {
                var l = g
                l.blendMode = .plusLighter
                l.fill(circle(c, r * 3), with: .radialGradient(Gradient(colors: [P.star.color(0.4 * max(fl, pop - 1)), P.star.color(0)]), center: c, startRadius: 0, endRadius: r * 3))
            }
            // A small gap of ground around each star, so it reads as a knot on the line.
            g.fill(circle(c, r * 0.55), with: .color(P.ground.color(0.9 * Ease.clamp(a * 1.4))))
            g.fill(sparkle(c, r), with: .color(P.star.color(Ease.clamp(a + 0.3 * fl))))
        }

        // ---- sunrise glint: the tension front carries a point of light out from the peg.
        if let fr = m.glint, let w = i.wakeAge(now) {
            let gi = min(n - 1, Int((fr * Double(n - 1)).rounded()))
            let a = sin(.pi * Ease.clamp(w / 0.45)), c = CGPoint(x: xs[gi], y: ys[gi]), rr = 16 * sc
            var l = g
            if P.dark { l.blendMode = .plusLighter }
            let col = P.dark ? P.star : P.voice
            l.fill(circle(c, rr), with: .radialGradient(Gradient(colors: [col.color(0.8 * a), col.color(0)]), center: c, startRadius: 0, endRadius: rr))
        }

        // ---- muted: a short stub stays on the peg; the gap between it and the string is the cut.
        if muted {
            var p = Path(); p.move(to: CGPoint(x: x0 - 4, y: y)); p.addLine(to: CGPoint(x: x0 + 2, y: y))
            g.stroke(p, with: .color(P.muted.color()), style: StrokeStyle(lineWidth: lw, lineCap: .round))
            g.fill(circle(CGPoint(x: startX, y: ys[0]), 1.6 * sc8), with: .color(P.string.color()))
        }
        // The bridge (right anchor).
        g.fill(circle(CGPoint(x: x1, y: y), 2 * sc8), with: .color(RGBA.mix(P.string, P.need, m.need).color(alpha)))

        // ---- Claude's bead, with a short comet of light behind it.
        if let bd = m.bead, bd.peg == 0, bd.a > 0.01 {
            let k = min(n - 1, Int((bd.s * Double(n - 1)).rounded()))
            let bx = Ease.lerp(startX, x1, bd.s), by = ys[k]
            let br = 3.2 * max(sc, 0.75)
            g.drawLayer { l in
                l.addFilter(.shadow(color: P.bead.color(0.9 * max(P.glow, 0.5)), radius: 7 * sc7))
                l.fill(circle(CGPoint(x: bx, y: by), br), with: .color(P.bead.color(bd.a)))
            }
            let k0 = max(0, k - 14)
            if k > k0 {
                var p = Path()
                p.move(to: CGPoint(x: xs[k0], y: ys[k0]))
                for kk in (k0 + 1)...k { p.addLine(to: CGPoint(x: xs[kk], y: ys[kk])) }
                g.stroke(p, with: .linearGradient(Gradient(colors: [P.bead.color(0), P.bead.color(0.55 * bd.a)]), startPoint: CGPoint(x: bx - 46 * sc, y: by), endPoint: CGPoint(x: bx, y: by)),
                         style: StrokeStyle(lineWidth: lw + 0.6, lineCap: .round))
            }
        }

        // ---- persona switch: the new tuning's harmonic nodes appear along the string like frets.
        if m.frets > 0.01 {
            var nodes = Set<Double>()
            for (k, w) in Tuning.of(i.persona).w.enumerated() where w >= 0.2 && k > 0 {
                for j in 1...k { nodes.insert((Double(j) / Double(k + 1) * 10_000).rounded() / 10_000) }
            }
            if nodes.isEmpty { nodes.insert(0.5) }
            var p = Path()
            let hgt = 7 * sc7
            for s in nodes {
                let x = Ease.lerp(startX, x1, s)
                p.move(to: CGPoint(x: x, y: y - hgt - 6)); p.addLine(to: CGPoint(x: x, y: y - 6))
                p.move(to: CGPoint(x: x, y: y + 6)); p.addLine(to: CGPoint(x: x, y: y + hgt + 6))
            }
            g.stroke(p, with: .color(P.voice.color(0.85 * m.frets)), lineWidth: 1.2 * sc8)
        }

        // ---- approval: the string's light runs out of the corona and around, framing the question.
        if m.frame > 0.001 {
            frame(g, L, m, P)
        }

        peg(g, L, i, e, m, P, now: now)

        // ---- the arriving moon: off the end of the string and onto the peg, it swells into the dark disc.
        if let bd = m.bead, bd.peg > 0 {
            let h = Ease.inOut(bd.peg)
            let bx = Ease.lerp(startX, px, h), rr = Ease.lerp(3.2 * max(sc, 0.75), R * 1.03, h * h)
            g.drawLayer { l in
                l.addFilter(.shadow(color: P.bead.color((1 - h) * 0.9 * max(P.glow, 0.5)), radius: 7 * sc7))
                l.fill(circle(CGPoint(x: bx, y: y), rr), with: .color(RGBA.mix(P.bead, P.night, h).color()))
            }
        }
    }

    static func sparkle(_ c: CGPoint, _ r: Double) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: c.x, y: c.y - r))
        p.addQuadCurve(to: CGPoint(x: c.x + r, y: c.y), control: c)
        p.addQuadCurve(to: CGPoint(x: c.x, y: c.y + r), control: c)
        p.addQuadCurve(to: CGPoint(x: c.x - r, y: c.y), control: c)
        p.addQuadCurve(to: CGPoint(x: c.x, y: c.y - r), control: c)
        p.closeSubpath()
        return p
    }

    // MARK: - Umbra

    /// At totality the world goes dark around the peg. It stays inside 2.45 peg radii, clear of
    /// the headline and the caption. Light mode draws a crisp printed disc (a soft dark gradient
    /// on white read as a smudge) and waits for contact.
    static func umbra(_ g: GraphicsContext, _ L: HybridLayout, _ m: FilamentMoment, _ P: Palette) {
        let U = max(m.eclipse, m.corona, m.contact, P.dark ? m.dim * 0.6 : 0)
        guard U > 0.001 else { return }
        let c = CGPoint(x: L.pegX, y: L.y), R = Double(L.pegR)
        let uu = P.increaseContrast ? 1 : U
        if P.dark {
            let ro = R * 2.45
            g.fill(circle(c, ro), with: .radialGradient(Gradient(stops: [
                .init(color: P.night.color((P.increaseContrast ? 1 : 0.75) * uu), location: 0), .init(color: P.night.color(0.4 * uu), location: 0.5),
                .init(color: P.night.color(0), location: 1)]), center: c, startRadius: R * 0.9, endRadius: ro))
        } else {
            let ro = R * 1.62
            g.fill(circle(c, ro), with: .radialGradient(Gradient(stops: [
                .init(color: P.night.color(U), location: 0), .init(color: P.night.color(U), location: 0.86), .init(color: P.night.color(0), location: 1)]),
                center: c, startRadius: R * 0.9, endRadius: ro))
        }
    }

    // MARK: - Frame

    static func frame(_ g: GraphicsContext, _ L: HybridLayout, _ m: FilamentMoment, _ P: Palette) {
        let sc = Double(L.sc)
        let top = Double(L.y) + Double(L.pegR) + 6 * max(sc, 0.7), B = Double(L.frameBottom), r = 12 * max(sc, 0.6)
        let px = Double(L.pegX), x1 = Double(L.x1), y = Double(L.y)
        let poly = roundedPoly([CGPoint(x: px, y: top), CGPoint(x: px, y: B), CGPoint(x: x1, y: B), CGPoint(x: x1, y: y)], r)
        let total = polyLength(poly)
        let half = total / 2 * m.frame + (m.frame >= 0.999 ? 2 : 0)
        let left = trim(poly, half), right = trim(poly.reversed(), half)
        // Dark only: a faint wash of the same light inside the frame. On white any gold wash reads as peach.
        if P.dark {
            g.fill(Path(CGRect(x: px + 1, y: y, width: x1 - px - 2, height: B - y)),
                   with: .linearGradient(Gradient(colors: [P.need.color(0.07 * m.frame), P.need.color(0)]), startPoint: CGPoint(x: 0, y: y), endPoint: CGPoint(x: 0, y: B)))
        }
        g.drawLayer { l in
            l.addFilter(.shadow(color: P.need.color(P.dark ? 0.75 : 0.35), radius: (P.dark ? 8 : 3) * max(sc, 0.6)))
            for pts in [left, right] where pts.count > 1 {
                var p = Path(); p.addLines(pts)
                l.stroke(p, with: .color(P.need.color(0.96)), style: StrokeStyle(lineWidth: 2 * max(sc, 0.75), lineCap: .round, lineJoin: .round))
            }
        }
    }

    /// A dense polyline with rounded corners.
    static func roundedPoly(_ pts: [CGPoint], _ r: Double) -> [CGPoint] {
        var out = [pts[0]]
        for k in 1..<(pts.count - 1) {
            let a = pts[k - 1], b = pts[k], c = pts[k + 1]
            let d1 = hypot(b.x - a.x, b.y - a.y), d2 = hypot(c.x - b.x, c.y - b.y), rr = min(r, d1 / 2, d2 / 2)
            let p1 = CGPoint(x: b.x - (b.x - a.x) / d1 * rr, y: b.y - (b.y - a.y) / d1 * rr)
            let p2 = CGPoint(x: b.x + (c.x - b.x) / d2 * rr, y: b.y + (c.y - b.y) / d2 * rr)
            out.append(p1)
            for j in 1..<8 {
                let t = Double(j) / 8
                out.append(CGPoint(x: (1 - t) * (1 - t) * p1.x + 2 * (1 - t) * t * b.x + t * t * p2.x, y: (1 - t) * (1 - t) * p1.y + 2 * (1 - t) * t * b.y + t * t * p2.y))
            }
            out.append(p2)
        }
        out.append(pts[pts.count - 1])
        return out
    }

    static func polyLength(_ p: [CGPoint]) -> Double {
        var a = 0.0
        for k in 1..<p.count { a += hypot(p[k].x - p[k - 1].x, p[k].y - p[k - 1].y) }
        return a
    }

    static func trim<C: Collection>(_ pts: C, _ len: Double) -> [CGPoint] where C.Element == CGPoint {
        let arr = Array(pts)
        var out = [arr[0]]
        var acc = 0.0
        for k in 1..<arr.count {
            let d = hypot(arr[k].x - arr[k - 1].x, arr[k].y - arr[k - 1].y)
            if acc + d >= len {
                let t = d > 0 ? (len - acc) / d : 0
                out.append(CGPoint(x: Ease.lerp(arr[k - 1].x, arr[k].x, t), y: Ease.lerp(arr[k - 1].y, arr[k].y, t)))
                return out
            }
            acc += d
            out.append(arr[k])
        }
        return out
    }

    // MARK: - Peg

    static func peg(_ g: GraphicsContext, _ L: HybridLayout, _ i: FilamentInput, _ e: FilamentEngine, _ m: FilamentMoment, _ P: Palette, now: Double) {
        let sc = max(Double(L.sc), 0.75), x = Double(L.pegX), y = Double(L.y), R = Double(L.pegR)
        let c = CGPoint(x: x, y: y)
        let muted = i.muted && i.mode == .live
        let cant = i.cantHear && i.mode == .live && !muted
        let sleeping = i.mode == .sleeping
        // Tick ring: the meter for your mic, lit clockwise from the top; the peak tick lingers 1.2 s.
        let nT = 36, r1 = R + 4.5 * sc, r2 = R + 8.5 * sc
        var lvl = i.reduced ? (i.floor == "you" ? 0.62 : 0) : Ease.clamp(e.you * 1.35)
        var peak = i.reduced ? lvl : Ease.clamp(e.peak * 1.35)
        if sleeping { lvl = i.reduced ? 0 : Ease.clamp(i.wake * 2); peak = lvl }
        if !muted && m.need < 0.5 && i.mode != .off {
            var rest = Path(), lit = Path(), pk = Path(), dots = Path()
            for k in 0..<nT {
                let a = -Double.pi / 2 + Double(k) / Double(nT) * 2 * .pi, ca = cos(a), sa = sin(a)
                if cant { dots.addPath(circle(CGPoint(x: x + ca * (r1 + 2 * sc), y: y + sa * (r1 + 2 * sc)), 0.9 * sc)); continue }
                let isLit = Double(k) < lvl * Double(nT)
                let isPeak = !isLit && abs(Double(k) - (peak * Double(nT)).rounded(.down)) < 1 && peak > 0.05
                let rr2 = isLit ? r2 + 1 : r2
                let seg = { (p: inout Path) in p.move(to: CGPoint(x: x + ca * r1, y: y + sa * r1)); p.addLine(to: CGPoint(x: x + ca * rr2, y: y + sa * rr2)) }
                if isLit { seg(&lit) } else if isPeak { seg(&pk) } else { seg(&rest) }
            }
            if cant { g.fill(dots, with: .color(P.ink.color(0.5))) } else {
                g.stroke(rest, with: .color(P.ink.color(sleeping ? 0.07 : (P.increaseContrast ? 0.3 : 0.13))), lineWidth: sc)
                g.stroke(lit, with: .color(sleeping ? P.ink.color(0.5) : P.you.color()), lineWidth: 1.6 * sc)
                g.stroke(pk, with: .color(P.you.color(0.7)), lineWidth: sc)
            }
        }
        // The peg body: flat, with a knurled rim.
        let bodyPath = circle(c, R)
        g.fill(bodyPath, with: .color(P.ground.color()))
        let rim: RGBA = muted ? P.muted : m.need > 0.5 ? P.need : P.ink
        g.stroke(bodyPath, with: .color(rim.color(muted || m.need > 0.5 ? 0.95 : (P.increaseContrast ? 0.5 : 0.22))), lineWidth: (muted || m.need > 0.5 ? 1.5 : 1) * sc)
        let rot = m.detent * .pi / 4
        var knurl = Path()
        for k in 0..<28 {
            let a = rot + Double(k) / 28 * 2 * .pi
            knurl.move(to: CGPoint(x: x + cos(a) * (R - 3.2 * sc), y: y + sin(a) * (R - 3.2 * sc)))
            knurl.addLine(to: CGPoint(x: x + cos(a) * (R - 0.8), y: y + sin(a) * (R - 0.8)))
        }
        g.stroke(knurl, with: .color(P.ink.color(0.16)), lineWidth: 0.9 * sc)
        // Tuning mark: which persona the string is tuned to (8 detents, 45 degrees each).
        let ma = rot - .pi / 2
        g.fill(circle(CGPoint(x: x + cos(ma) * (R - 7 * sc), y: y + sin(ma) * (R - 7 * sc)), 1.9 * sc), with: .color((muted ? P.muted : P.ink).color(0.9)))
        // Asleep, the peg shows its night side with a thin lit limb; the sunrise sweeps it away.
        if m.night > 0.001 {
            var l = g
            l.clip(to: circle(c, R - 0.5))
            let edge = x - R * 0.7 + 2.1 * R * (1 - m.night)
            l.fill(Path(CGRect(x: edge - 5 * sc, y: y - R, width: x + R - edge + 5 * sc, height: 2 * R)),
                   with: .linearGradient(Gradient(colors: [P.night.color(0), P.night.color(P.dark ? 0.72 : 0.14)]),
                                         startPoint: CGPoint(x: edge - 5 * sc, y: y), endPoint: CGPoint(x: edge + 3 * sc, y: y)))
            var limb = Path()
            limb.addArc(center: c, radius: R - 0.6, startAngle: .radians(.pi * 0.62), endAngle: .radians(.pi * 1.38), clockwise: false)
            g.stroke(limb, with: .color((P.dark ? P.star : P.ink).color(P.dark ? 0.55 : 0.5)), lineWidth: 1.2 * sc)
        }
        if let w = m.dawn {
            let rr = R * (1.1 + 2.1 * Ease.out(w)), a = sin(.pi * w)
            if P.dark {
                var l = g
                l.blendMode = .plusLighter
                l.fill(circle(c, rr), with: .radialGradient(Gradient(colors: [P.dawn.color(0.26 * a), P.dawn.color(0)]), center: c, startRadius: R, endRadius: rr))
            } else {
                g.stroke(circle(c, rr), with: .color(P.voice.color(0.45 * (1 - w))), lineWidth: 1.2)
            }
        }
        eclipse(g, L, m, P)
        // Mic glyph (drawn, so it can turn gold on the dark disc and stay findable at the loudest moment).
        let ecl = m.eclipse > 0.5
        let k = sc * (L.mini ? 0.82 : 1)
        let gc: RGBA = muted ? P.muted : ecl ? P.need : P.ink
        let ga = ecl ? 0.9 : m.night > 0.5 ? 0.45 : 0.8
        var mic = Path()
        mic.addRoundedRect(in: CGRect(x: x - 2.8 * k, y: y + k - 8 * k, width: 5.6 * k, height: 9.5 * k), cornerSize: CGSize(width: 2.8 * k, height: 2.8 * k))
        mic.addArc(center: CGPoint(x: x, y: y + k - 1.6 * k), radius: 5.4 * k, startAngle: .radians(0.15 * .pi), endAngle: .radians(0.85 * .pi), clockwise: false)
        mic.move(to: CGPoint(x: x, y: y + k + 3.8 * k)); mic.addLine(to: CGPoint(x: x, y: y + k + 6.4 * k))
        g.stroke(mic, with: .color(gc.color(ga)), style: StrokeStyle(lineWidth: 1.4 * k, lineCap: .round))
        if muted {
            var sl = Path(); sl.move(to: CGPoint(x: x - 6 * k, y: y + k - 8 * k)); sl.addLine(to: CGPoint(x: x + 6 * k, y: y + k + 6 * k))
            g.stroke(sl, with: .color(P.muted.color()), style: StrokeStyle(lineWidth: 1.4 * k, lineCap: .round))
        }
    }

    // MARK: - Eclipse (glow, inner ring, disc, diamond ring; the streamers are CoronaLayer's)

    static func eclipse(_ g: GraphicsContext, _ L: HybridLayout, _ m: FilamentMoment, _ P: Palette) {
        let E = m.eclipse, co = m.corona
        guard E > 0.001 || co > 0.001 || m.flash > 0 else { return }
        let c = CGPoint(x: L.pegX, y: L.y), R = Double(L.pegR), sc = max(Double(L.sc), 0.75)
        var l = g
        if P.dark { l.blendMode = .plusLighter }
        if co > 0 {
            l.fill(circle(c, R * 2.35), with: .radialGradient(Gradient(stops: [
                .init(color: P.need.color(0.95 * co), location: 0), .init(color: P.need.color(0.5 * co), location: 0.12),
                .init(color: P.need.color(0.14 * co), location: 0.42), .init(color: P.need.color(0), location: 1)]),
                center: c, startRadius: R * 0.96, endRadius: R * 2.35))
            l.stroke(circle(c, R * 1.03), with: .color(P.pale.color(0.95 * co)), lineWidth: (P.increaseContrast ? 2 : 1.5) * sc)
        }
        // The moon's disc.
        if E > 0 { g.fill(circle(c, R * 1.02), with: .color(P.night.color(E))) }
        // Diamond ring: the last bead of light at second contact.
        let b = m.flash
        if b > 0 {
            let ba = -0.72, bc = CGPoint(x: c.x + cos(ba) * R * 1.02, y: c.y + sin(ba) * R * 1.02)
            var f = g
            f.blendMode = .plusLighter
            f.fill(circle(bc, R * 1.3 * b), with: .radialGradient(Gradient(stops: [
                .init(color: Color.white.opacity(b), location: 0), .init(color: P.pale.color(0.8 * b), location: 0.25), .init(color: P.need.color(0), location: 1)]),
                center: bc, startRadius: 0, endRadius: R * 1.3 * b))
            var p = Path()
            p.move(to: CGPoint(x: bc.x - R * 2.2 * b, y: bc.y)); p.addLine(to: CGPoint(x: bc.x + R * 2.2 * b, y: bc.y))
            p.move(to: CGPoint(x: bc.x, y: bc.y - R * 1.2 * b)); p.addLine(to: CGPoint(x: bc.x, y: bc.y + R * 1.2 * b))
            f.stroke(p, with: .color(Color(.sRGB, red: 1, green: 244 / 255, blue: 222 / 255, opacity: 0.7 * b)), lineWidth: 1)
        }
    }

    /// The corona's streamers: 120 hairline rays whose lengths come from slow value noise that
    /// drifts once per 3.2 s (the shimmer, the only motion held while Claude waits).
    static func streamers(_ g: GraphicsContext, center c: CGPoint, R: Double, amount co: Double, phase: Double, mini: Bool, palette P: Palette) {
        guard co > 0.001 else { return }
        let nS = mini ? 70 : 120
        var p = Path()
        let r0 = R * 1.02
        for k in 0..<nS {
            let a = Double(k) / Double(nS) * 2 * .pi + 0.013 * sin(Double(k) * 1.7)
            let len = R * (0.1 + 1.2 * pow(valueNoise(Double(k) * 0.61 + phase), 2.3)) * co
            p.move(to: CGPoint(x: c.x + cos(a) * r0, y: c.y + sin(a) * r0))
            p.addLine(to: CGPoint(x: c.x + cos(a) * (r0 + len), y: c.y + sin(a) * (r0 + len)))
        }
        var l = g
        if P.dark { l.blendMode = .plusLighter }
        l.stroke(p, with: .radialGradient(Gradient(colors: [P.pale.color(0.6 * co), P.need.color(0)]), center: c, startRadius: r0, endRadius: r0 + R * 1.3),
                 lineWidth: mini ? 0.6 : 0.8)
    }
}
