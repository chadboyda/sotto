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

    func testWorkingLineIsOneLine() {
        let working = layout("09-claude-working")["claude"]!.height
        let agents = layout("12-background-agents")["claude"]!.height
        XCTAssertEqual(working, agents, accuracy: 0.5, "the agents chip sits in the head row and adds no height")
    }
}
