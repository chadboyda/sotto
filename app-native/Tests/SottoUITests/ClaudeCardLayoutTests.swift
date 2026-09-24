// The Claude card never pushes the captions or the footer (the user's report on 0.3.1:
// long output made the card grow, with a scroll bar over the text). The real PanelView
// is laid out in an off-screen window for the canned states; the captions must end in
// the same place whatever the card shows, the card must end above them, and its height
// is bounded: a three-line summary collapsed, a capped scroller expanded.
import XCTest
import SwiftUI
import AppKit
@testable import SottoUI

@MainActor
final class ClaudeCardLayoutTests: XCTestCase {
    final class Box { var frames: [String: CGRect] = [:] }

    func layout(_ name: String, size: CGSize = CGSize(width: 420, height: 720), scheme: NSAppearance.Name = .aqua) -> [String: CGRect] {
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

    func testLongOutputNeverPushesTheCaptions() {
        for size in [CGSize(width: 420, height: 720), CGSize(width: 420, height: 640), CGSize(width: 360, height: 560)] {
            var captionsBottom: CGFloat?
            for name in ["05-listening", "09-claude-working", "11-claude-finished", "25-claude-finished-long", "26-claude-finished-long-expanded", "10-claude-needs-approval"] {
                let f = layout(name, size: size)
                guard let claude = f["claude"], let captions = f["captions"] else { return XCTFail("\(name): no frames \(f)") }
                XCTAssertLessThanOrEqual(claude.maxY, captions.minY + 0.5, "\(name) at \(size): the card overlaps the captions")
                if let b = captionsBottom { XCTAssertEqual(captions.maxY, b, accuracy: 0.5, "\(name) at \(size): the captions moved") }
                captionsBottom = captions.maxY
            }
        }
    }

    func testCardHeightIsBounded() {
        let short = layout("11-claude-finished")["claude"]!.height
        let long = layout("25-claude-finished-long")["claude"]!.height
        let expanded = layout("26-claude-finished-long-expanded")["claude"]!.height
        // Collapsed: head, three summary lines, More, the request line, padding.
        XCTAssertLessThanOrEqual(long, 12 + 20 + 4 + ClaudeCardView.collapsedSummary + 4 + 24 + 4 + 18 + 12 + 2, "collapsed long output is clamped")
        XCTAssertLessThanOrEqual(short, long + 0.5)
        // Expanded: the summary scrolls inside a capped box.
        XCTAssertLessThanOrEqual(expanded, 12 + 20 + 4 + ClaudeCardView.expandedCap + 4 + 24 + 4 + 18 + 12 + 2, "expanded output scrolls inside the card")
        XCTAssertGreaterThan(expanded, long, "More shows more")
    }

    /// The card never runs past the panel's content edge (16 pt each side) at any panel
    /// width, in any state; its head never runs past the card's own padding. The 0.3.2
    /// report: the crowded approval head (title, agents chip, "7 min 0 sec") was clipped.
    func testCardStaysInsideThePanelAtEveryWidth() {
        for width in [360, 400, 420, 480, 560, 640] as [CGFloat] {
            let size = CGSize(width: width, height: 720)
            for name in ["27-agent-approval-crowded", "10-claude-needs-approval", "09-claude-working", "12-background-agents", "11-claude-finished", "25-claude-finished-long"] {
                let f = layout(name, size: size)
                guard let card = f["claude"], let head = f["claude-head"] else { return XCTFail("\(name): no frames \(f)") }
                XCTAssertGreaterThanOrEqual(card.minX, 16 - 0.5, "\(name) at \(width): card starts left of the content edge")
                XCTAssertLessThanOrEqual(card.maxX, width - 16 + 0.5, "\(name) at \(width): card runs past the panel (\(card))")
                XCTAssertLessThanOrEqual(head.maxX, card.maxX - 12 + 0.5, "\(name) at \(width): head runs past the card's padding (\(head) in \(card))")
                XCTAssertGreaterThanOrEqual(head.minX, card.minX + 12 - 0.5, "\(name) at \(width): head")
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

    func testWorkingLineIsOneLine() {
        let working = layout("09-claude-working")["claude"]!.height
        let agents = layout("12-background-agents")["claude"]!.height
        XCTAssertEqual(working, agents, accuracy: 0.5, "the agents chip sits in the head row and adds no height")
    }
}
