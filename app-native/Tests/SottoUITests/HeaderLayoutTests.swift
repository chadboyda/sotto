// The header pills hold still while they tick (SPEC-DEVIATIONS "header pills", the
// native twin of test/web/header.test.js): the real HeaderContent is laid out in an
// off-screen window at the panel's widths, the clocks tick through 0:09, 0:10, 9:59,
// 10:00, 59:59 and 1:00:00, and every pill's frame must stay the same except for the
// one widening at the hour. Narrow rows hide Today first, then Session; Cost stays.
import XCTest
import SwiftUI
import AppKit
@testable import SottoUI

@MainActor
final class HeaderLayoutTests: XCTestCase {
    final class Box { var frames: [String: CGRect] = [:] }

    /// Lay out the header at `width` and return where each shown pill sits.
    func layout(width: CGFloat, pills: ViewText.UsagePills, detail: String? = nil, project: String? = "claude-live",
                scheme: NSAppearance.Name = .aqua) -> [String: CGRect] {
        let box = Box()
        let root = HeaderContent(key: "live", label: "Live", detail: detail, project: project, pills: pills, openSettings: {})
            .onPreferenceChange(PillFrames.self) { v in MainActor.assumeIsolated { box.frames = v } }
            .frame(width: width, height: 44)
        let host = NSHostingView(rootView: root)
        host.frame = CGRect(x: 0, y: 0, width: width, height: 44)
        let window = NSWindow(contentRect: CGRect(x: -20_000, y: -20_000, width: width, height: 44), styleMask: [.borderless], backing: .buffered, defer: false)
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

    static let ticks: [Double] = [9, 10, 599, 600, 3599, 3600]

    func pills(_ s: Double, cost: Double = 852) -> ViewText.UsagePills {
        ViewText.usagePills(sessionSeconds: s, todaySeconds: s + 1800, costSeconds: cost)
    }

    func testTickingNeverMovesAPillExceptTheHourWidening() {
        for width in [420.0, 560.0] {
            for scheme in [NSAppearance.Name.aqua, .darkAqua] {
                var first: [String: CGRect]?
                var beforeHour: [String: CGRect]?
                for s in Self.ticks {
                    // Today runs 30 min ahead of the session, so it crosses the hour at 30:00;
                    // tick it separately below. Here it stays under the hour until s = 1800.
                    let p = ViewText.usagePills(sessionSeconds: s, todaySeconds: min(s, 1799), costSeconds: 852)
                    let f = layout(width: width, pills: p, scheme: scheme)
                    XCTAssertEqual(Set(f.keys), ["Session", "Today", "Cost"], "\(width) \(s): all three pills fit")
                    guard let base = first else { first = f; continue }
                    if s < 3600 {
                        for k in ["Session", "Today", "Cost"] {
                            XCTAssertEqual(f[k], base[k], "\(k) moved at \(ViewText.formatClock(s)) (\(width) pt, \(scheme.rawValue))")
                        }
                        beforeHour = f
                    } else {
                        let b = beforeHour!
                        XCTAssertGreaterThan(f["Session"]!.width, b["Session"]!.width, "the session box widens once, at the hour")
                        XCTAssertEqual(f["Session"]!.height, b["Session"]!.height)
                        XCTAssertEqual(f["Today"]!.size, b["Today"]!.size, "today is still under the hour")
                        XCTAssertEqual(f["Cost"], b["Cost"], "the cost pill never moves")
                    }
                }
            }
        }
    }

    func testEachPillHoldsItsWidthWithinAMagnitude() {
        func size(_ name: String, _ pill: ViewText.Pill, _ kind: UsagePill.Kind) -> CGSize {
            NSHostingView(rootView: UsagePill(name: name, pill: pill, kind: kind)).fittingSize
        }
        var widths: [Bool: Set<CGFloat>] = [:]
        for s in Self.ticks + [35_999] {
            let p = ViewText.usagePills(sessionSeconds: s, todaySeconds: s, costSeconds: 0)
            let sz = size("Session", p.session!, .clock)
            XCTAssertEqual(sz.height, 16, "16 pt tall: a slot in the 24 pt capsule")
            widths[p.session!.wide, default: []].insert(sz.width)
        }
        XCTAssertEqual(widths[false]?.count, 1, "m:ss and mm:ss share one width: \(widths)")
        XCTAssertEqual(widths[true]?.count, 1, "h:mm:ss and hh:mm:ss share one width: \(widths)")
        XCTAssertGreaterThan(widths[true]!.first!, widths[false]!.first!)

        var cost: [Bool: Set<CGFloat>] = [:]
        for secs: Double in [0, 1, 852, 72_000, 119_999, 120_000, 1_000_000] {
            let p = ViewText.usagePills(sessionSeconds: nil, todaySeconds: 0, costSeconds: secs).cost
            cost[p.wide, default: []].insert(size("Cost", p, .cost).width)
        }
        XCTAssertEqual(cost[false]?.count, 1, "$0.00, <$0.01 and $99.99 share one width: \(cost)")
        XCTAssertEqual(cost[true]?.count, 1, "$100 and up share one width: \(cost)")
    }

    func testFiguresFitTheirBoxes() {
        let font = NSFont.monospacedDigitSystemFont(ofSize: UsagePill.figureSize, weight: .medium)
        func w(_ s: String) -> CGFloat { (s as NSString).size(withAttributes: [.font: font]).width }
        for t in ["0:09", "9:59", "59:59", "00:00"] { XCTAssertLessThanOrEqual(w(t), UsagePill.figureWidth(.clock, wide: false)) }
        for t in ["1:00:00", "23:59:59"] { XCTAssertLessThanOrEqual(w(t), UsagePill.figureWidth(.clock, wide: true)) }
        for t in ["$0.00", "<$0.01", "$99.99"] { XCTAssertLessThanOrEqual(w(t), UsagePill.figureWidth(.cost, wide: false)) }
        for t in ["$100.00", "$999.99"] { XCTAssertLessThanOrEqual(w(t), UsagePill.figureWidth(.cost, wide: true)) }
    }

    func testShortRowsHideTodayThenSessionAndKeepCost() {
        let p = pills(600)
        let wide = layout(width: 420, pills: p)
        XCTAssertEqual(Set(wide.keys), ["Session", "Today", "Cost"])
        var seen: [Set<String>] = []
        for width in stride(from: 400.0, through: 150, by: -10) {
            let keys = Set(layout(width: width, pills: p, project: "a-very-long-project-name").keys)
            XCTAssertTrue(keys.contains("Cost"), "Cost always stays (\(width) pt)")
            if seen.last != keys { seen.append(keys) }
        }
        XCTAssertEqual(seen.last, ["Cost"], "the narrowest row keeps only Cost: \(seen)")
        XCTAssertTrue(seen.contains(["Session", "Cost"]), "Today goes before Session: \(seen)")
        XCTAssertFalse(seen.contains(["Today", "Cost"]), "Session never goes before Today: \(seen)")
    }

    func testNotLiveHasNoSessionPill() {
        let p = ViewText.usagePills(sessionSeconds: nil, todaySeconds: 600, costSeconds: 600)
        XCTAssertEqual(Set(layout(width: 420, pills: p).keys), ["Today", "Cost"])
    }
}
