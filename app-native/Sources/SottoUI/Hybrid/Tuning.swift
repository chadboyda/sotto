// Personas as tunings of the one string (concept-3 IMPLEMENTATION.md §5 "Personas as
// tunings"): each persona rings the string in its own harmonic shape, so you can tell
// them apart with the sound off. The tide envelope (IMPLEMENTATION.md §3 VoiceTides) is
// computed once per tuning, not per frame.
import Foundation

public struct Tuning: Equatable, Sendable {
    public var id: String
    /// Harmonic weights, k = 1...
    public var w: [Double]
    /// Fundamental (Hz): how fast the standing wave swings.
    public var f: Double
    /// Line width at rest (pt).
    public var width: Double
    /// Sustain (damping per second).
    public var damp: Double
    public var amp: Double
    public var bloom: Double = 1
    /// Fern: a second line 3 pt below with a shimmer.
    public var doubled: Double = 0
    /// Pip: a 7 Hz, +-6% vibrato on f1.
    public var flutter: Double = 0
    /// The persona's position on the peg (45 degrees per detent).
    public var detent: Double = 0

    public static let builtins: [Tuning] = [
        Tuning(id: "sotto", w: [1, 0, 0.38, 0, 0.14], f: 1.25, width: 1.3, damp: 1.7, amp: 1, detent: 0),
        Tuning(id: "june", w: [0.55, 0, 0.55, 0, 0.42, 0, 0.3], f: 1.45, width: 1.2, damp: 1.5, amp: 1, bloom: 1.6, detent: 1),
        Tuning(id: "moss", w: [1, 0, 0.16], f: 0.82, width: 2.4, damp: 2.3, amp: 0.9, detent: 2),
        Tuning(id: "tempo", w: [0.45, 0.2, 0.6, 0, 0.55, 0, 0.35], f: 2.1, width: 1.25, damp: 1.4, amp: 1.1, detent: 3),
        Tuning(id: "koan", w: [1], f: 0.62, width: 1.0, damp: 1.1, amp: 0.85, detent: 4),
        Tuning(id: "vic", w: [1, 0, 0.22], f: 1.6, width: 1.6, damp: 5, amp: 0.7, detent: 5),
        Tuning(id: "pip", w: [0.8, 0, 0.42], f: 1.75, width: 1.25, damp: 1.6, amp: 1, flutter: 1, detent: 6),
        Tuning(id: "fern", w: [0.9, 0, 0.3, 0, 0.2], f: 1.08, width: 1.0, damp: 1.6, amp: 1, doubled: 1, detent: 7),
        Tuning(id: "lark", w: [0.7, 0, 0.5, 0, 0.3], f: 1.9, width: 1.1, damp: 1.5, amp: 1, bloom: 1.2, detent: 3.5),
        Tuning(id: "vela", w: [0.8, 0, 0.3, 0, 0, 0, 0.25], f: 0.95, width: 1.15, damp: 1.3, amp: 0.95, bloom: 1.3, detent: 7.5),
    ]

    /// The tuning for a persona id. Custom personas get one derived from a hash of their
    /// id: odd harmonics only, f1 between 0.8 and 1.8, width between 1.1 and 1.6.
    public static func of(_ id: String?) -> Tuning {
        let key = (id ?? "sotto").lowercased()
        if let t = builtins.first(where: { $0.id == key }) { return t }
        var h: UInt64 = 1469598103934665603
        for b in key.utf8 { h = (h ^ UInt64(b)) &* 1099511628211 }
        func unit(_ shift: UInt64) -> Double { Double((h >> shift) & 0xFFFF) / 65535 }
        let w: [Double] = [1, 0, 0.1 + 0.4 * unit(8), 0, 0.3 * unit(24)]
        return Tuning(id: key, w: w, f: 0.8 + unit(40), width: 1.1 + 0.5 * unit(48), damp: 1.6, amp: 1, detent: Double(h % 8))
    }

    /// The harmonic sum at s (0...1) with phase `phase` (the standing wave).
    @inline(__always)
    public func wave(_ s: Double, phase: Double) -> Double {
        var v = 0.0
        for k in 0..<w.count where w[k] != 0 {
            let n = Double(k + 1)
            v += w[k] * sin(n * .pi * s) * cos(n * phase + Double(k) * 0.9)
        }
        return v
    }

    /// The static shape (no phase), for the persona ghost, Reduce Motion and the chip.
    public func shape(_ s: Double) -> Double {
        var v = 0.0
        for k in 0..<w.count where w[k] != 0 { v += w[k] * sin(Double(k + 1) * .pi * s) }
        return v
    }

    /// The normalized harmonic envelope |sum w_k sin(k pi s)| / max over 24 samples:
    /// the shape the voice's tides take, sampled at `n` points along the string.
    public func envelope(points n: Int) -> [Double] {
        var mx = 0.0
        for j in 1..<24 { mx = max(mx, abs(shape(Double(j) / 24))) }
        if mx == 0 { mx = 1 }
        return (0..<n).map { i in abs(shape(Double(i) / Double(n - 1))) / mx }
    }
}
