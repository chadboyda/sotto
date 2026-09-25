// Claude's scrolling page (SPEC-DEVIATIONS "scrolling page"): the port of web/lib.js
// pushPage / pageTurn / pageEntries / followTarget / isFollowing / scrollThumb, pinned
// to lib.js by test/fixtures/native/viewtext.json (ViewTextTests).
import Foundation

extension ViewText {
    /// How many of Claude's messages the page keeps: this turn's and the recent ones before it.
    public static let pageMax = 12
    /// Within this many points of the latest text still counts as "at the latest" (follow on).
    public static let followSlack: Double = 24

    /// The messages kept and where the current turn starts in them.
    public struct Page: Equatable, Sendable {
        public var msgs: [String] = []
        public var turnStart = 0
        public init(msgs: [String] = [], turnStart: Int = 0) { self.msgs = msgs; self.turnStart = turnStart }
    }

    public struct PageEntry: Equatable, Sendable {
        public enum Tone: String, Sendable { case latest, turn, past }
        public var text: String
        public var tone: Tone
        /// The newest message at full ink, the rest of this turn at half, earlier turns quieter.
        public var opacity: Double { tone == .latest ? 1 : tone == .turn ? 0.5 : 0.36 }
    }

    /// A new turn: the messages so far become the earlier turns.
    public static func pageTurn(_ p: Page) -> Page { Page(msgs: p.msgs, turnStart: p.msgs.count) }

    /// Add one of Claude's messages. A message that repeats or extends the last one of this
    /// turn replaces it; at most `pageMax` are kept, the oldest out first.
    public static func pushPage(_ p: Page, _ text: String) -> Page {
        var turnStart = min(p.msgs.count, max(0, p.turnStart))
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return Page(msgs: p.msgs, turnStart: turnStart) }
        if p.msgs.count > turnStart, let last = p.msgs.last {
            let a = stripMarkdown(last), b = stripMarkdown(t)
            if a == b || b.hasPrefix(a) { return Page(msgs: p.msgs.dropLast() + [t], turnStart: turnStart) }
        }
        var next = p.msgs + [t]
        let drop = max(0, next.count - pageMax)
        if drop > 0 { next.removeFirst(drop); turnStart = max(0, turnStart - drop) }
        return Page(msgs: next, turnStart: turnStart)
    }

    /// The page's messages with their tone: the newest of this turn, earlier this turn, earlier turns.
    public static func pageEntries(_ p: Page) -> [PageEntry] {
        let start = max(0, p.turnStart)
        return p.msgs.enumerated().map { i, text in
            PageEntry(text: text, tone: i < start ? .past : i == p.msgs.count - 1 ? .latest : .turn)
        }
    }

    /// Where "the latest" is: the end of the text, or, for a finished reply taller than the
    /// page (`latestTop` given), the top of that reply, so it reads from its first line.
    public static func followTarget(scrollHeight: Double, clientHeight: Double, latestTop: Double? = nil) -> Double {
        let mx = max(0, scrollHeight - clientHeight)
        guard let top = latestTop else { return mx }
        return max(0, min(mx, top))
    }

    /// Following: the reader is at (or past) the latest text.
    public static func isFollowing(_ scrollTop: Double, target: Double, slack: Double = followSlack) -> Bool {
        scrollTop >= target - slack
    }

    /// The scroller thumb in the page's own box (the web draws this one; the app uses the
    /// system overlay scroller with the same insets). Nil when nothing overflows.
    public static func scrollThumb(scrollTop: Double, scrollHeight: Double, clientHeight: Double, inset: Double = 6, min minH: Double = 24) -> (top: Double, height: Double)? {
        let over = scrollHeight - clientHeight
        guard over > 1, clientHeight > 0 else { return nil }
        let track = max(0, clientHeight - 2 * inset)
        let height = min(track, max(minH, track * clientHeight / scrollHeight))
        let f = max(0, min(1, scrollTop / over))
        func r1(_ x: Double) -> Double { (x * 10).rounded() / 10 }
        return (r1(inset + (track - height) * f), r1(height))
    }
}
