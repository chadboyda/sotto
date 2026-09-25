// The string (design/concepts-v2/hybrid, concept-3 §4): a damped 1D wave equation stepped
// at 240 Hz from the timeline's date (no Timer), plus the event clocks for Orrery's
// grafts (IMPLEMENTATION.md §4): the eclipse, the moon's return, the finish ring and
// star flash, the sunrise wake and the persona glissando.
//
// Everything the painter draws is a function of (FilamentInput, now, the wave state), so
// a still frame at any instant is deterministic (the snapshots rely on it). The engine
// also decides how often the view must redraw (`rate`): 0 fps when nothing moves.
import Foundation

/// What the hero shows; a pure value built from the StateModel (tests and snapshots build it directly).
public struct FilamentInput: Equatable, Sendable {
    public enum Mode: String, Sendable { case live, connecting, sleeping, paused, off }
    public var mode: Mode = .live
    /// Who holds the floor right now (after the word hold): you | voice | nil.
    public var floor: String?
    public var muted = false
    /// Nothing reaches the mic (the can't-hear notice): the string is drawn broken.
    public var cantHear = false
    public var attention = false
    public var busy = false
    /// Reference-date seconds (Date.timeIntervalSinceReferenceDate) for every event clock.
    public var workSince: Double?
    public var attentionAt: Double?
    public var clearedAt: Double?
    public var finishedAt: Double?
    public var wokeAt: Double?
    public var persona = "sotto"
    public var personaFrom: String?
    public var personaAt: Double?
    public var mic = 0.0
    public var voice = 0.0
    public var wake = 0.0
    public var stars: [Star] = []
    public var reduced = false

    public struct Star: Equatable, Sendable {
        public var s: Double
        public var born: Double
        public init(s: Double, born: Double) { self.s = s; self.born = born }
    }
    public init() {}

    // Event windows (seconds): how long each one-shot runs at full rate.
    static let eclipseRun = 1.75, resolveRun = 1.0, finishRun = 2.3, wakeRun = 1.0, personaRun = 2.3

    func age(_ at: Double?, _ now: Double, within: Double) -> Double? {
        guard let at else { return nil }
        let a = now - at
        return a >= 0 && a < within ? a : nil
    }
    /// Seconds into the eclipse (while Claude waits), unbounded.
    func eclipseAge(_ now: Double) -> Double? { attention ? attentionAt.map { max(0, now - $0) } ?? 99 : nil }
    func resolveAge(_ now: Double) -> Double? { attention ? nil : age(clearedAt, now, within: Self.resolveRun) }
    func finishAge(_ now: Double) -> Double? { attention ? nil : age(finishedAt, now, within: Self.finishRun) }
    func wakeAge(_ now: Double) -> Double? { mode == .sleeping ? nil : age(wokeAt, now, within: Self.wakeRun) }
    func personaAge(_ now: Double) -> Double? { personaFrom == nil ? nil : age(personaAt, now, within: Self.personaRun) }
}

/// Easing helpers (all motion uses cubic-bezier(0.2, 0, 0, 1) or these).
enum Ease {
    static func clamp(_ x: Double, _ a: Double = 0, _ b: Double = 1) -> Double { max(a, min(b, x)) }
    static func out(_ t: Double) -> Double { 1 - pow(1 - clamp(t), 3) }
    static func inOut(_ t: Double) -> Double { let t = clamp(t); return t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2 }
    static func expo(_ t: Double) -> Double { t >= 1 ? 1 : 1 - pow(2, -10 * clamp(t)) }
    static func bell(_ x: Double, _ w: Double) -> Double { x <= 0 || x >= w ? 0 : sin(.pi * x / w) }
    static func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }
}

/// The amounts every layer reads, at one instant (IMPLEMENTATION.md §4.1 timing table).
struct FilamentMoment {
    var eclipse = 0.0, corona = 0.0, frame = 0.0, need = 0.0, dim = 0.0, contact = 0.0
    var flash = 0.0
    var night = 0.0          // the peg's night side (sleeping 1, sunrise sweeps it away)
    var dawn: Double?        // 0...1 through the dawn bloom
    var glint: Double?       // the tension front's position (0...1) during the wake
    var ring = 0.0, ringK = 1.0
    var slackFront: Double?  // the wake's tension front (s beyond it is still slack)
    var alpha = 1.0
    var bead: (s: Double, a: Double, peg: Double)?
    var starFlash: ((Int) -> Double) = { _ in 0 }
    var gliss = 0.0
    var ghost: Double?       // persona ghost progress 0...1
    var frets = 0.0
    var tuning: Tuning = .of("sotto")
    var fromTuning: Tuning?
    var detent = 0.0

    static func at(_ i: FilamentInput, now: Double, sc: Double, engine: FilamentEngine) -> FilamentMoment {
        var m = FilamentMoment()
        let rm = i.reduced
        if let e = i.eclipseAge(now) {
            m.eclipse = rm ? 1 : (e >= 0.75 ? 1 : 0)
            m.corona = rm ? 1 : Ease.expo((e - 0.78) / 0.9)
            m.frame = rm ? 1 : Ease.expo((e - 0.95) / 0.75)
            m.need = rm ? 1 : Ease.clamp((e - 0.75) / 0.2)
            m.dim = rm ? 1 : Ease.out((e - 0.3) / 0.45)
            m.contact = rm ? 0 : Ease.clamp((e - 0.62) / 0.13)
            m.flash = rm ? 0 : Ease.bell(e - 0.75 + 0.1, 0.34)
        } else if let r = i.resolveAge(now), !rm {
            m.eclipse = 1 - Ease.clamp((r - 0.15) / 0.2)
            m.corona = 1 - Ease.out(r / 0.45)
            m.frame = 1 - Ease.out(r / 0.4)
            m.need = 1 - Ease.clamp(r / 0.4)
            m.dim = 1 - Ease.out(r / 0.5)
        }
        // The string's opacity per state (concept-3 §5).
        switch i.mode {
        case .sleeping: m.alpha = 0.3
        case .paused: m.alpha = 0.32
        case .connecting: m.alpha = 0.5
        case .off: m.alpha = 0.25
        case .live: m.alpha = i.cantHear ? 0.8 : 1
        }
        if i.mode == .sleeping { m.night = 1 }
        if let w = i.wakeAge(now) {
            m.night = rm ? 0 : 1 - Ease.inOut(w / 0.6)
            if !rm {
                m.alpha = Ease.lerp(0.3, 1, Ease.out(w / 0.35))
                m.slackFront = w / 0.35
                if w < 0.9 { m.dawn = w / 0.9 }
                if w < 0.45 { m.glint = Ease.clamp(w / 0.35) }
                if w > 0.35 { let t = w - 0.35; m.ring = 4 * sc * exp(-t / 0.22) * cos(2 * .pi * 6 * t); m.ringK = 2 }
            }
        }
        // The world dims while the moon crosses; the string comes back as gold light at totality.
        m.alpha *= 1 - 0.62 * m.dim * (1 - m.need)

        // Persona glissando (700 ms), ghost (1.2 s) and frets (to 2.2 s).
        let to = Tuning.of(i.persona)
        m.tuning = to
        m.detent = to.detent
        if let p = i.personaAge(now), let fromId = i.personaFrom {
            let from = Tuning.of(fromId)
            let r = rm ? 1 : Ease.inOut((p - 0.3) / 0.7)
            m.tuning = FilamentMoment.mix(from, to, r)
            m.fromTuning = from
            m.detent = Ease.lerp(from.detent, from.detent + (((to.detent - from.detent) + 8).truncatingRemainder(dividingBy: 8)), r)
            if !rm { m.gliss = sin(.pi * Ease.clamp((p - 0.3) / 0.75)) * 20 * sc }
            if p > 0.3 && p < 1.5 { m.ghost = rm ? 0.35 : (p - 0.3) / 1.2 }
            m.frets = rm ? (p > 0.3 ? 0.8 : 0) : Ease.clamp((p - 0.25) / 0.25) * Ease.clamp((2.2 - p) / 0.5)
        }

        // Claude's bead.
        let busyS = i.workSince.map { HybridText.beadS(elapsed: now - $0) }
        if let e = i.eclipseAge(now) {
            if !rm && e < 0.75 {
                let s0 = engine.beadAtEclipse ?? busyS ?? 0.9
                let g = e < 0.3 ? 0 : Ease.inOut((e - 0.3) / 0.45)
                m.bead = g < 0.8 ? (s0 * (1 - g / 0.8), 1, 0) : (0, 1, (g - 0.8) / 0.2)
            }
        } else if let r = i.resolveAge(now), !rm {
            if r >= 0.15 && r < 0.35 { m.bead = (0, 1, 1 - Ease.out((r - 0.15) / 0.2)) }
            else if r >= 0.35 {
                let target = i.busy ? (busyS ?? 0.5) : 1
                let t = Ease.inOut((r - 0.35) / 0.55)
                m.bead = (t * target, 1, 0)
            }
        } else if let f = i.finishAge(now), (i.resolveAge(now) == nil) {
            let from = engine.lastBeadS ?? 0.9
            if rm { m.bead = (0.999, 1, 0) }
            else if f < 0.55 { m.bead = (Ease.lerp(from, 0.999, Ease.inOut(f / 0.55)), 1, 0) }
            else { m.bead = (0.999, Ease.clamp(1 - (f - 0.9) / 0.5), 0) }
        } else if i.busy, let since = i.workSince {
            m.bead = (rm ? 0.5 : HybridText.beadS(elapsed: now - since), Ease.clamp((now - since) / 0.4), 0)
        }
        if let f = i.finishAge(now), !rm, f > 0.9 {
            let t = f - 0.9
            m.ring += 10 * sc * exp(-t / 0.38) * cos(2 * .pi * 2.6 * t)
            m.ringK = 1
        }
        if let f = i.finishAge(now), !rm { m.starFlash = { j in Ease.bell(f - 0.95 - Double(j) * 0.06, 0.24) } }
        return m
    }

    static func mix(_ a: Tuning, _ b: Tuning, _ r: Double) -> Tuning {
        let n = max(a.w.count, b.w.count)
        var t = b
        t.w = (0..<n).map { k in Ease.lerp(k < a.w.count ? a.w[k] : 0, k < b.w.count ? b.w[k] : 0, r) }
        t.f = Ease.lerp(a.f, b.f, r); t.width = Ease.lerp(a.width, b.width, r); t.damp = Ease.lerp(a.damp, b.damp, r)
        t.amp = Ease.lerp(a.amp, b.amp, r); t.bloom = Ease.lerp(a.bloom, b.bloom, r); t.doubled = Ease.lerp(a.doubled, b.doubled, r)
        t.flutter = Ease.lerp(a.flutter, b.flutter, r)
        return t
    }
}

/// The wave state carried between frames (a reference so the Canvas can advance it).
public final class FilamentEngine {
    public static let n = 96
    static let dt = 1.0 / 240
    var u = [Double](repeating: 0, count: n)
    var v = [Double](repeating: 0, count: n)
    var simT = 0.0
    /// Meter ballistics: fast attack (~20 ms), slow release (~300 ms).
    var you = 0.0, voice = 0.0, peak = 0.0, peakT = 0.0
    var phase = 0.0
    private var seed: UInt32 = 7
    /// Tides in flight: one born per 340 ms of voice, life 1.15 s, at most 3.
    var tides: [(t: Double, level: Double)] = []
    private var tideSlot = -1
    /// Where the bead was when Claude asked, and the last place it was seen working.
    var beadAtEclipse: Double?
    var lastBeadS: Double?
    private var seenAttentionAt: Double?
    /// Local clocks for the muted droop and the connecting reveal.
    var mutedAt: Double?
    var connectingAt: Double?

    public init() {}

    static let tidePeriod = 0.34, tideLife = 1.15

    /// A still frame shows the muted droop and the connecting string at rest.
    func settleClocks(now: Double) { mutedAt = now - 10; connectingAt = now - 10 }

    func reset() {
        u = .init(repeating: 0, count: Self.n); v = .init(repeating: 0, count: Self.n)
        simT = 0; you = 0; voice = 0; peak = 0; phase = 0; seed = 7; tides = []; tideSlot = -1
    }

    private func rnd() -> Double {
        // mulberry32: deterministic, so a still frame is reproducible.
        seed = seed &+ 0x6D2B79F5
        var t = seed
        t = (t ^ (t >> 15)) &* (1 | t)
        t = (t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t
        return Double(t ^ (t >> 14)) / 4_294_967_296
    }

    /// Notes the event state the painter needs before a frame (called from the view body too).
    func observe(_ i: FilamentInput, now: Double) {
        if i.attention, i.attentionAt != seenAttentionAt {
            seenAttentionAt = i.attentionAt
            beadAtEclipse = i.workSince.map { HybridText.beadS(elapsed: (i.attentionAt ?? now) - $0) } ?? lastBeadS
        }
        if !i.attention { seenAttentionAt = nil }
        if i.busy, !i.attention, let w = i.workSince { lastBeadS = HybridText.beadS(elapsed: now - w) }
        if i.muted { if mutedAt == nil { mutedAt = now } } else { mutedAt = nil }
        if i.mode == .connecting { if connectingAt == nil { connectingAt = now } } else { connectingAt = nil }
    }

    /// Step the wave from its last time to `now` in fixed 1/240 s steps (at most 0.5 s of catch-up).
    func advance(_ i: FilamentInput, to now: Double, sc: Double) {
        observe(i, now: now)
        if i.reduced { you = i.muted ? 0 : i.mic; voice = i.voice; simT = now; tides = []; u = .init(repeating: 0, count: Self.n); v = u; return }
        if simT == 0 || now - simT > 0.5 { simT = now - 0.5 }
        if now < simT { simT = now }
        var steps = 0
        while simT + Self.dt <= now && steps < 240 {
            step(i, t: simT, sc: sc)
            simT += Self.dt
            steps += 1
        }
        tides.removeAll { now - $0.t > Self.tideLife }
    }

    private func step(_ i: FilamentInput, t: Double, sc: Double) {
        // The freeze: for 300 ms before the eclipse nothing integrates; the string holds its shape mid-motion.
        if let e = i.eclipseAge(t), e < 0.3 { return }
        let tuning: Tuning = {
            if let p = i.personaAge(t), let from = i.personaFrom { return FilamentMoment.mix(.of(from), .of(i.persona), Ease.inOut((p - 0.3) / 0.7)) }
            return .of(i.persona)
        }()
        let yl = i.muted ? 0 : (i.mode == .sleeping ? 0 : i.mic)
        let vl = i.voice
        you += (yl - you) * (yl > you ? 0.45 : 0.016)
        voice += (vl - voice) * 0.05
        if you < 0.0005 { you = 0 }
        if voice < 0.0005 { voice = 0 }
        if you >= peak { peak = you; peakT = t } else if t - peakT > 1.2 { peak = max(you, peak - 0.004) }
        let flut = tuning.flutter > 0 ? 1 + 0.06 * sin(t * 2 * .pi * 7) * tuning.flutter : 1
        phase += 2 * .pi * tuning.f * flut * Self.dt
        if phase > 2000 { phase = phase.truncatingRemainder(dividingBy: 2 * .pi) }
        // Your voice plucks the string from below, near the peg: irregular, asymmetric kicks.
        if yl > 0.02 && rnd() < yl * 0.24 {
            let k = 2 + Int(rnd() * 9)
            let a = (0.45 + rnd()) * yl * 16 * sc * (rnd() < 0.22 ? -0.55 : 1)
            u[k - 1] -= a * 0.5; u[k] -= a; u[k + 1] -= a * 0.5
        }
        // Room sound while sleeping: the wake meter is the string shivering.
        if i.mode == .sleeping && i.wake > 0.02 && rnd() < 0.05 {
            let k = 4 + Int(rnd() * Double(Self.n - 8))
            u[k] += (rnd() - 0.5) * 2.4 * sc * min(1, i.wake * 4)
        }
        // Tides: sample the voice once per 340 ms slot.
        let slot = Int((t / Self.tidePeriod).rounded(.down))
        if slot != tideSlot {
            tideSlot = slot
            if voice >= 0.05 && !i.attention {
                tides.append((Double(slot) * Self.tidePeriod, voice))
                if tides.count > 3 { tides.removeFirst(tides.count - 3) }
            }
        }
        var damp = i.floor == "you" ? 3.2 : tuning.damp
        if i.attention { damp = 28 }            // pulled taut
        if i.muted || i.cantHear { damp = max(damp, 6) }
        let keep = exp(-damp * Self.dt), c2 = 0.26
        let n = Self.n
        for j in 1..<(n - 1) { v[j] = (v[j] + c2 * (u[j - 1] - 2 * u[j] + u[j + 1])) * keep }
        for j in 1..<(n - 1) { u[j] = max(-40, min(40, u[j] + v[j])) }
        u[0] = 0; u[n - 1] = 0
    }

    /// Nothing is moving in the wave or the meters.
    var waveAtRest: Bool {
        if you > 0.01 || voice > 0.01 { return false }
        for j in 0..<Self.n where abs(u[j]) > 0.01 || abs(v[j]) > 0.01 { return false }
        return true
    }

    /// How often the hero must redraw (IMPLEMENTATION.md §5).
    public enum Rate: Equatable, Sendable {
        case paused, breathe, sleep, work, full
        /// TimelineView's minimum interval (nil: every display frame).
        public var interval: Double? { switch self { case .paused, .full: return nil; case .breathe: return 1.0 / 12; case .sleep: return 1.0 / 15; case .work: return 0.1 } }
    }

    /// The listening breath: 0.16 Hz, under 2 pt. At 12 fps it moves at most 0.2 pt a frame,
    /// so it reads as smooth; the whole-panel cost is one 96-point path a frame.
    static let breathHz = 0.16

    /// The string breathes while it is live and listening with nothing else going on: not
    /// muted, not deaf, no approval, not under Reduce Motion (v0.4.1: the 0 fps idle line
    /// read as a dead rule; the user asked for a line that is alive but calm).
    static func breathing(_ i: FilamentInput, now: Double) -> Bool {
        i.mode == .live && !i.muted && !i.cantHear && !i.reduced && !i.attention && i.resolveAge(now) == nil
    }

    public func rate(_ i: FilamentInput, now: Double) -> Rate {
        if i.reduced {
            // Reduce Motion: every state is a still shape; only the meters follow the levels.
            return .paused
        }
        if let e = i.eclipseAge(now), e < FilamentInput.eclipseRun { return .full }
        if i.resolveAge(now) != nil || i.finishAge(now) != nil || i.wakeAge(now) != nil || i.personaAge(now) != nil { return .full }
        if let m = mutedAt, now - m < 0.6 { return .full }
        if let c = connectingAt, now - c < 1.5 { return .full }
        if i.mic > 0.02 && !i.muted && i.mode != .sleeping { return .full }
        if i.voice > 0.02 || !waveAtRest || tides.contains(where: { now - $0.t < Self.tideLife }) { return .full }
        if i.busy && !i.attention { return .work }
        if Self.breathing(i, now: now) { return .breathe }
        if i.mode == .sleeping && i.wake > 0.02 { return .sleep }
        return .paused
    }
}
