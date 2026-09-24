// Reconnect schedule (docs/NATIVE.md §1 "App reconnect"). Pure.
import Foundation

public struct ReconnectPolicy: Equatable, Sendable {
    /// First delays, then `steady` repeated until `window` seconds have passed since the link was lost.
    public var steps: [Double]
    public var steady: Double
    public var window: Double

    public static let standard = ReconnectPolicy(steps: [0.05, 0.25, 0.5, 1, 2], steady: 2, window: 60)

    public init(steps: [Double], steady: Double, window: Double) {
        self.steps = steps; self.steady = steady; self.window = window
    }

    /// Delay before retry number `attempt` (0-based), or nil to give up.
    /// `elapsed`: seconds since the link was lost (or the first connect failed).
    public func delay(attempt: Int, elapsed: Double) -> Double? {
        let d = attempt < steps.count ? steps[max(0, attempt)] : steady
        return elapsed + d > window ? nil : d
    }

    /// Close codes after which the app does not retry (4001 protocol_mismatch, 4002 replaced).
    public static func retries(afterClose code: Int) -> Bool {
        code != 4001 && code != 4002
    }

    /// The whole schedule for a link that never comes back (for tests and logs).
    public func schedule() -> [Double] {
        var out: [Double] = []
        var t = 0.0
        while let d = delay(attempt: out.count, elapsed: t) { out.append(d); t += d }
        return out
    }
}
