// The Filament + Orrery panel's shared rules (web/lib.js "The Filament + Orrery panel",
// docs/NATIVE.md "Hybrid panel"): the headline, the header word, the caption note, the
// Claude row's moon, the bead and the milestone stars. Ports of lib.js, pinned by
// test/fixtures/native/viewtext.json (ViewTextTests), so the page and the app say the same.
import Foundation

extension ViewText {
    /// lib.FINISHED_HEADLINE_MS: "Claude finished" stays the headline for 30 s.
    public static let finishedHeadlineMs: Double = 30_000
    /// lib.ECLIPSE_TOTALITY_MS: an approval becomes the words at totality.
    public static let eclipseTotalityMs: Double = 750

    /// lib.VERBS: the daemon's plain-words tool lines as one quiet verb.
    static let verbs: [(String, String)] = [
        ("^Running the tests\\b", "testing"), ("^Editing\\b", "editing"), ("^(?:Looking through|Reading)\\b", "reading"),
        ("^Searching\\b", "searching"), ("^Building\\b", "building"), ("^Installing\\b", "installing"),
        ("^Checking the code\\b", "checking"), ("^Committing\\b", "committing"), ("^Pushing\\b", "pushing"),
        ("^Fetching\\b", "fetching"), ("^Validating\\b", "validating"), ("^Updating\\b", "updating"), ("^Downloading\\b", "downloading"),
    ]

    /// lib.claudeVerb: "Claude is <verb>", "working" when there is no known tool line.
    public static func claudeVerb(_ tool: String?) -> String {
        let t = (tool ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        for (p, v) in verbs where t.range(of: p, options: [.regularExpression, .caseInsensitive]) != nil { return v }
        return "working"
    }

    public struct Headline: Equatable, Sendable {
        public var word: String
        /// attn | muted | you | err | nil
        public var tone: String?
        /// Claude's news (the approval, "Claude is testing", "Claude finished").
        public var news: Bool
    }

    public struct HeadlineContext: Equatable, Sendable {
        public var attention = false
        public var question = false
        public var busy = false
        public var tool: String?
        public var finishedAt: Double?
        public var now: Double = 0
        public init(attention: Bool = false, question: Bool = false, busy: Bool = false, tool: String? = nil, finishedAt: Double? = nil, now: Double = 0) {
            self.attention = attention; self.question = question; self.busy = busy; self.tool = tool; self.finishedAt = finishedAt; self.now = now
        }
    }

    /// lib.headline: the floor wins while someone is talking; then an approval; then Muted
    /// (never hidden behind Claude's news); then Claude's news; else "Listening". A card view
    /// names its state in its short header label.
    public static func headline(_ v: PageView, _ c: HeadlineContext) -> Headline {
        let floor = v.floor
        if v.view != "live" {
            let w = v.header.label.isEmpty ? v.word : v.header.label
            return Headline(word: w, tone: v.card?.tone == "err" ? "err" : nil, news: false)
        }
        if !["listening", "you", "voice", "muted"].contains(floor) { return Headline(word: v.word, tone: v.wordTone, news: false) }
        if floor == "you" { return Headline(word: stageWords["you"]!.0, tone: "you", news: false) }
        if floor == "voice" { return Headline(word: stageWords["voice"]!.0, tone: nil, news: false) }
        if c.attention { return Headline(word: approvalWord, tone: "attn", news: true) }
        if c.question && c.busy { return Headline(word: "Answer in the terminal", tone: "attn", news: true) }
        if floor == "muted" { return Headline(word: stageWords["muted"]!.0, tone: "muted", news: false) }
        if c.busy { return Headline(word: "Claude is \(claudeVerb(c.tool))", tone: nil, news: true) }
        if let f = c.finishedAt, c.now >= f, c.now - f < finishedHeadlineMs { return Headline(word: "Claude finished", tone: nil, news: true) }
        return Headline(word: stageWords["listening"]!.0, tone: nil, news: false)
    }

    /// lib.statusWord: the header's word; an approval reads "Needs you".
    public static func statusWord(_ v: PageView) -> String {
        v.header.key == "attention" && v.view == "live" ? "Needs you" : v.header.label
    }

    /// lib.captionNote: the line under the string when the state has one (muted, connecting).
    public static func captionNote(_ v: PageView) -> String? {
        guard v.view == "live" else { return nil }
        if v.floor == "muted" { return "Sotto can't hear you. Still billing. Press M to listen." }
        if v.floor == "connecting" || v.floor == "reconnecting" { return v.sub }
        return nil
    }

    public struct ClaudeHead: Equatable, Sendable {
        /// new | waxing | eclipse | full
        public var phase: String
        public var label: String
        public var detail: String?
        public var need: Bool
    }

    /// lib.claudeHead: a moon phase and "Claude · Working" instead of a title.
    public static func claudeHead(_ m: ClaudeCard) -> ClaudeHead {
        switch m.kind {
        case "approval":
            return ClaudeHead(phase: "eclipse", label: m.title.hasPrefix("A background agent") ? "A background agent is waiting for you" : "Claude is waiting for you", detail: nil, need: true)
        case "working": return ClaudeHead(phase: "waxing", label: "Claude", detail: "Working", need: false)
        case "finished": return ClaudeHead(phase: "full", label: "Claude", detail: "Done", need: false)
        default: return ClaudeHead(phase: "new", label: "Claude", detail: "Idle", need: false)
        }
    }

    // lib.STAR_GAP_MS, STAR_MAX, STAR_HALF_LIFE_MS, BEAD_TAU_MS
    public static let starGapMs: Double = 20_000
    public static let starMax = 12
    public static let starHalfLifeMs: Double = 20 * 60_000
    public static let beadTauMs: Double = 60_000

    /// lib.beadPosition: where Claude's bead is (0 = the peg, 1 = the bridge) after `ms` of work.
    public static func beadPosition(_ ms: Double?) -> Double {
        let t = max(0, ms ?? 0)
        return ((0.05 + 0.85 * (1 - exp(-t / beadTauMs))) * 10_000).rounded() / 10_000
    }

    /// lib.starAlpha: halves every 20 minutes, never below 0.3.
    public static func starAlpha(_ ageMs: Double?) -> Double {
        let a = max(0, ageMs ?? 0)
        return (max(0.3, 0.92 * pow(2, -a / starHalfLifeMs)) * 1000).rounded() / 1000
    }

    public struct Star: Equatable, Sendable { public var s: Double; public var born: Double }
    public struct Stars: Equatable, Sendable {
        public var stars: [Star] = []
        public var lastAt: Double?
        public init(stars: [Star] = [], lastAt: Double? = nil) { self.stars = stars; self.lastAt = lastAt }
    }

    /// lib.milestoneStars: a star is born where the bead is when Claude reports a step in its
    /// own words (kind "text" while busy), at most one per 20 s, at most 12 (oldest out first).
    public static func milestoneStars(_ st: Stars, kind: String?, text: String?, busy: Bool, now: Double, workSince: Double?) -> Stars {
        guard kind == "text", !(text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, busy else { return st }
        if let l = st.lastAt, now - l < starGapMs { return st }
        let s = beadPosition(workSince.map { now - $0 } ?? 0)
        return Stars(stars: Array((st.stars + [Star(s: s, born: now)]).suffix(starMax)), lastAt: now)
    }
}
