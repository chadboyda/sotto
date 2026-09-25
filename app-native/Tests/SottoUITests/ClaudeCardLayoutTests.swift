// No layout shift (the user's standing complaint; docs/NATIVE.md parity table): the real
// PanelView is laid out in an off-screen window for the canned states, and every zone
// (the caption line, Claude's column and its row, the footer) must sit in exactly the same
// place whatever the panel shows: listening, speaking, working, the eclipse approval at any
// instant, finished with long output, a long turn, can't hear, sleeping. Claude's
// column stays inside the panel and above the footer at every width, and long output never
// grows it (it clips under a fade or scrolls inside it).
import XCTest
import SwiftUI
import AppKit
@testable import SottoUI

@MainActor
final class ClaudeCardLayoutTests: XCTestCase {
    final class Box { var frames: [String: CGRect] = [:] }

    func layout(_ name: String, size: CGSize = CGSize(width: 420, height: 640), scheme: NSAppearance.Name = .aqua) -> [String: CGRect] {
        let state = UISnapshot.states.first { $0.name == name }!
        let m = UISnapshot.model(state)
        let box = Box()
        let still = Date(timeIntervalSinceReferenceDate: 780_000_000 + state.elapsed).timeIntervalSinceReferenceDate
        let root = PanelView(model: m, stillAt: still)
            .onPreferenceChange(PanelFrames.self) { v in MainActor.assumeIsolated { box.frames = v } }
            .frame(width: size.width, height: size.height)
        let host = NSHostingView(rootView: root)
        host.frame = CGRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: CGRect(x: -20_000, y: -20_000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: scheme)
        window.contentView = host
        for _ in 0..<3 {
            host.layoutSubtreeIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }
        window.close()
        return box.frames
    }

    static let states = ["05-listening", "06-you-speaking", "07-sotto-speaking", "08-muted", "09-claude-working", "10a-approval-freeze",
                         "10b-approval-moon-crossing", "10c-approval-totality", "10-claude-needs-approval", "11-claude-finished",
                         "11a-finished-stars-flash", "12-background-agents", "13-cant-hear", "25-claude-finished-long",
                         "26-claude-working-long", "27-agent-approval-crowded", "28-persona-switch"]

    func testZonesNeverMoveBetweenStates() {
        for size in [CGSize(width: 420, height: 640), CGSize(width: 420, height: 720), CGSize(width: 360, height: 560), CGSize(width: 640, height: 900)] {
            var base: [String: CGRect]?
            var baseName = ""
            for name in Self.states {
                let f = layout(name, size: size)
                for k in ["captions", "claude", "claude-head", "footer"] { XCTAssertNotNil(f[k], "\(name) at \(size): no \(k) frame") }
                guard let b = base else { base = f; baseName = name; continue }
                for k in ["captions", "claude", "claude-head", "footer"] {
                    guard let a = f[k], let bb = b[k] else { continue }
                    XCTAssertEqual(a.minX, bb.minX, accuracy: 0.5, "\(k) moved between \(baseName) and \(name) at \(size)")
                    XCTAssertEqual(a.minY, bb.minY, accuracy: 0.5, "\(k) moved between \(baseName) and \(name) at \(size)")
                    XCTAssertEqual(a.width, bb.width, accuracy: 0.5, "\(k) resized between \(baseName) and \(name) at \(size)")
                    XCTAssertEqual(a.height, bb.height, accuracy: 0.5, "\(k) resized between \(baseName) and \(name) at \(size)")
                }
            }
        }
    }

    /// Claude's page is one fixed region: wherever it shows (listening, working, finished,
    /// a long turn, a long reply), it is the same box, and it fills the column below the row.
    func testPageRegionIsFixed() {
        for size in [CGSize(width: 420, height: 640), CGSize(width: 360, height: 420), CGSize(width: 640, height: 900)] {
            var base: CGRect?
            for name in ["05-listening", "09-claude-working", "11-claude-finished", "25-claude-finished-long", "26-claude-working-long", "13-cant-hear"] {
                let f = layout(name, size: size)
                guard let p = f["claude-page"], let col = f["claude"] else { return XCTFail("\(name) at \(size): no page frame") }
                XCTAssertEqual(p.maxY, col.maxY, accuracy: 0.5, "\(name) at \(size): the page does not reach the column's end")
                XCTAssertGreaterThanOrEqual(p.height, 40, "\(name) at \(size): the page keeps a few lines")
                guard let b = base else { base = p; continue }
                XCTAssertEqual(p, b, "\(name) at \(size): the page region moved or resized")
            }
        }
    }

    // MARK: The live scroll view (not a still frame)

    @MainActor final class Live {
        let window: NSWindow
        let host: NSView
        let model: StateModel
        init(_ state: String, size: CGSize, scheme: NSAppearance.Name = .aqua) {
            model = UISnapshot.model(UISnapshot.states.first { $0.name == state }!)
            host = NSHostingView(rootView: PanelView(model: model).frame(width: size.width, height: size.height))
            host.frame = CGRect(origin: .zero, size: size)
            window = NSWindow(contentRect: CGRect(x: -20_000, y: -20_000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: scheme)
            window.contentView = host
            pump(0.4)
        }
        func pump(_ s: Double = 0.15) {
            let end = Date().addingTimeInterval(s)
            while Date() < end { host.layoutSubtreeIfNeeded(); RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
        }
        var scroll: FollowScrollView? { Self.find(host) }
        static func find(_ v: NSView) -> FollowScrollView? {
            if let s = v as? FollowScrollView { return s }
            for sub in v.subviews { if let s = find(sub) { return s } }
            return nil
        }
        var frame: CGRect { scroll.map { $0.convert($0.bounds, to: nil) } ?? .null }
        func text(_ t: String) { model.apply(object: ["type": .string("activity"), "kind": .string("text"), "text": .string(t)]); pump() }
        func userScroll(to y: CGFloat) {
            guard let s = scroll else { return }
            s.contentView.scroll(to: NSPoint(x: 0, y: y))
            s.reflectScrolledClipView(s.contentView)
            pump()
        }
        func close() { window.close() }
    }

    func testLongReplyScrollsInAFixedRegionAndFollows() throws {
        let live = Live("26-claude-working-long", size: CGSize(width: 420, height: 640))
        defer { live.close() }
        let s = try XCTUnwrap(live.scroll, "the page is a scroll view")
        let c = try XCTUnwrap(s.coordinator)
        let frame0 = live.frame
        XCTAssertEqual(s.scrollerStyle, .overlay, "the overlay scroller: hidden at rest, shown while scrolling")
        XCTAssertTrue(s.hasVerticalScroller)
        XCTAssertGreaterThan(c.total, c.viewport * 1.3, "the long turn overflows the page (\(c.total) in \(c.viewport))")
        // Following: at the newest words.
        XCTAssertTrue(c.following)
        XCTAssertEqual(c.offset, c.target(), accuracy: 1)
        XCTAssertFalse(c.follow.showJump)

        // The reader scrolls up (a real wheel event where the system allows one, else the clip view).
        if let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: 400, wheel2: 0, wheel3: 0), let e = NSEvent(cgEvent: cg) {
            s.scrollWheel(with: e)
            live.pump(0.3)
        }
        if c.offset > c.target() - 100 { live.userScroll(to: 0) }
        XCTAssertLessThan(c.offset, c.target() - 100)
        XCTAssertFalse(c.following, "scrolling up stops following")
        XCTAssertTrue(c.follow.showJump, "Jump to latest shows")
        let up = c.offset

        // New words while the reader is up there: their place is kept, the frame never moves.
        let total0 = c.total
        live.text("The auth suite passed 50 times in a row. Pushing the branch now, then I will open the pull request with the summary.")
        XCTAssertGreaterThan(c.total, total0)
        XCTAssertEqual(c.offset, up, accuracy: 1, "the reader's place is kept")
        XCTAssertEqual(live.frame, frame0, "the region never moves or resizes with its content")

        // Back to the bottom by hand: following again.
        live.userScroll(to: c.maxOffset)
        XCTAssertTrue(c.following)
        XCTAssertFalse(c.follow.showJump)
        live.text("Opened the pull request.")
        XCTAssertEqual(c.offset, c.target(), accuracy: 1, "new words scroll into view while following")

        // Up again, then the pill.
        live.userScroll(to: 0)
        XCTAssertTrue(c.follow.showJump)
        c.follow.jump()
        live.pump(0.6)
        XCTAssertTrue(c.following)
        XCTAssertEqual(c.offset, c.target(), accuracy: 1, "Jump to latest lands on the newest words")
        XCTAssertFalse(c.follow.showJump)

        // A new turn follows again even if the reader had scrolled away.
        live.userScroll(to: 0)
        XCTAssertFalse(c.following)
        live.model.apply(object: ["type": .string("activity"), "kind": .string("turn_start"), "text": .string("")])
        live.text("Looking at the release notes.")
        XCTAssertTrue(c.following)
        XCTAssertEqual(c.offset, c.target(), accuracy: 1)
        XCTAssertEqual(live.frame, frame0)
    }

    /// A finished reply taller than the page reads from its first line (still following).
    func testLongFinishedReplyReadsFromItsStart() throws {
        let live = Live("25-claude-finished-long", size: CGSize(width: 420, height: 640))
        defer { live.close() }
        let s = try XCTUnwrap(live.scroll)
        let c = try XCTUnwrap(s.coordinator)
        XCTAssertNotNil(c.latestTop)
        XCTAssertTrue(c.following)
        XCTAssertEqual(c.offset, c.target(), accuracy: 1)
        XCTAssertLessThan(c.offset, c.maxOffset - 1, "more below: the reply shows from its start")
    }

    /// At 360 x 420 the page shrinks first: a few lines still scroll, and the approval takes the region and fits.
    func testSmallPanelKeepsThePageAndTheApproval() throws {
        let live = Live("26-claude-working-long", size: CGSize(width: 360, height: 420))
        defer { live.close() }
        let s = try XCTUnwrap(live.scroll)
        let c = try XCTUnwrap(s.coordinator)
        XCTAssertGreaterThanOrEqual(c.viewport, 40)
        XCTAssertTrue(c.following)
        XCTAssertEqual(c.offset, c.target(), accuracy: 1)
        for name in ["10-claude-needs-approval", "27-agent-approval-crowded"] {
            let f = layout(name, size: CGSize(width: 360, height: 420))
            let col = try XCTUnwrap(f["claude"]), go = try XCTUnwrap(f["show-terminal"])
            XCTAssertNil(f["claude-page"], "\(name): the question takes the page's region")
            XCTAssertLessThanOrEqual(go.maxY, col.maxY + 0.5, "\(name): Show terminal fits at 360 x 420")
        }
    }

    /// The column stays inside the panel's reading column and above the footer at every
    /// width; its row never runs past it (the 0.3.2 report: a crowded approval head was clipped).
    func testColumnStaysInsideThePanelAtEveryWidth() {
        for width in [360, 400, 420, 480, 560, 640] as [CGFloat] {
            let size = CGSize(width: width, height: 720)
            for name in ["27-agent-approval-crowded", "10-claude-needs-approval", "09-claude-working", "12-background-agents", "11-claude-finished", "25-claude-finished-long"] {
                let f = layout(name, size: size)
                guard let col = f["claude"], let head = f["claude-head"], let footer = f["footer"], let cap = f["captions"] else { return XCTFail("\(name): no frames \(f)") }
                XCTAssertGreaterThanOrEqual(col.minX, 16 - 0.5, "\(name) at \(width): column starts left of the content edge")
                XCTAssertLessThanOrEqual(col.maxX, width - 16 - 20 + 0.5, "\(name) at \(width): column runs past the reading column (\(col))")
                XCTAssertLessThanOrEqual(head.maxX, col.maxX + 0.5, "\(name) at \(width): row runs past the column (\(head) in \(col))")
                XCTAssertLessThanOrEqual(col.maxY, footer.minY - 12 + 0.5, "\(name) at \(width): column reaches the footer")
                XCTAssertLessThanOrEqual(cap.maxY, col.minY + 0.5, "\(name) at \(width): the caption overlaps Claude's row")
            }
        }
    }

    /// The question fits its frame at every size: "Show terminal" is never clipped or pushed
    /// into the footer, however long Claude's reason is (the reason gives way first).
    func testApprovalActionAlwaysFits() {
        for size in [CGSize(width: 360, height: 420), CGSize(width: 360, height: 560), CGSize(width: 420, height: 640), CGSize(width: 640, height: 900)] {
            for name in ["10-claude-needs-approval", "27-agent-approval-crowded"] {
                let f = layout(name, size: size)
                guard let col = f["claude"], let go = f["show-terminal"] else { return XCTFail("\(name) at \(size): no frames \(f.keys)") }
                XCTAssertLessThanOrEqual(go.maxY, col.maxY + 0.5, "\(name) at \(size): Show terminal is clipped (\(go) in \(col))")
                XCTAssertGreaterThanOrEqual(go.height, 44 - 0.5, "\(name) at \(size): the action is a full 44 pt target")
            }
        }
    }

    func testCrowdedApprovalKeepsTheTitle() {
        let m = UISnapshot.model(UISnapshot.states.first { $0.name == "27-agent-approval-crowded" }!)
        XCTAssertEqual(m.claudeCard.kind, "approval")
        XCTAssertEqual(m.claudeCard.title, "A background agent needs your approval")
        XCTAssertEqual(m.claudeCard.agents, "5 background agents working")
        XCTAssertEqual(m.workingTime(at: m.now()), "7 min 0 sec")
    }

    func testAgentsAddNoHeight() {
        let working = layout("09-claude-working")["claude-head"]!.height
        let agents = layout("12-background-agents")["claude-head"]!.height
        XCTAssertEqual(working, agents, accuracy: 0.5, "the agents note sits in the row and adds no height")
    }
}
