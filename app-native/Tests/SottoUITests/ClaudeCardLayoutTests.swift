// No layout shift (the user's standing complaint; docs/NATIVE.md parity table): the real
// PanelView is laid out in an off-screen window for the canned states, and every zone
// (the caption line, Claude's column and its row, the footer) must sit in exactly the same
// place whatever the panel shows: listening, speaking, working, the eclipse approval at any
// instant, finished with long output (collapsed or expanded), can't hear, sleeping. Claude's
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
                         "26-claude-finished-long-expanded", "27-agent-approval-crowded", "28-persona-switch"]

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
