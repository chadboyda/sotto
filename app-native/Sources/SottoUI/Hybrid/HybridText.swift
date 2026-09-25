// Native glue for the Filament + Orrery panel's words. The rules themselves are the
// lib.js ports in ViewText+Hybrid.swift (headline, statusWord, captionNote, claudeHead,
// beadPosition, starAlpha, milestoneStars), pinned by test/fixtures/native/viewtext.json,
// so the page and the app say the same words. This file only maps them onto native types.
import Foundation

public enum HybridText {
    /// Claude's glyph is a moon phase: new (idle), waxing (working), eclipsed (needs you), full (done).
    public enum Phase: String, Sendable, CaseIterable {
        case idle, work, need, done
        /// From lib.claudeHead's phase names.
        public init(head: String) {
            switch head {
            case "waxing": self = .work
            case "eclipse": self = .need
            case "full": self = .done
            default: self = .idle
            }
        }
    }

    /// Where Claude's bead is, `elapsed` seconds into a turn: lib.beadPosition without its
    /// 4-digit rounding, so the bead glides between frames instead of stepping.
    public static func beadS(elapsed: Double) -> Double { 0.05 + 0.85 * (1 - exp(-max(0, elapsed) / 60)) }

    /// A milestone star's alpha after `age` seconds (lib.starAlpha).
    public static func starAlpha(age: Double) -> Double { ViewText.starAlpha(age * 1000) }
}
