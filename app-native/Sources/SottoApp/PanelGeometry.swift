// Where the expanded panel goes (pure; `--selftest panel-frame` tests it).
// Unchanged rules from the WKWebView app (SPEC §6.16): the first launch, and
// any saved frame smaller than `minSize` or off every screen, open at the full
// default 420x640 near the top right of the main screen. A saved frame taller
// or wider than its screen is fitted to it. Reasons: default, saved,
// too_small, offscreen, fitted.
import AppKit

enum PanelGeometry {
    static let defaultSize = NSSize(width: 420, height: 640)
    static let minSize = NSSize(width: 360, height: 420)
    static let pillSize = NSSize(width: 320, height: 96)
    static let margin: CGFloat = 24

    static func expandedFrame(saved: String?, screens: [NSRect], main: NSRect?) -> (frame: NSRect, reason: String) {
        let vf = main ?? screens.first ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        func placed(_ size: NSSize, in r: NSRect) -> NSRect {
            NSRect(x: r.maxX - size.width - margin, y: r.maxY - size.height - margin, width: size.width, height: size.height)
        }
        let fallback = placed(fitted(defaultSize, to: vf), in: vf)
        guard let s = saved, !s.isEmpty else { return (fallback, "default") }
        let r = NSRectFromString(s)
        guard r.width.isFinite, r.height.isFinite, let screen = screens.first(where: { $0.intersects(r) }) else {
            return (fallback, r.width > 0 ? "offscreen" : "default")
        }
        if r.width < minSize.width || r.height < minSize.height {
            // Keep the spot the user chose (its top-right corner), at the full default size.
            let size = fitted(defaultSize, to: screen)
            return (clampInto(NSRect(x: r.maxX - size.width, y: r.maxY - size.height, width: size.width, height: size.height), screen), "too_small")
        }
        let size = fitted(r.size, to: screen)
        if size != r.size { return (clampInto(NSRect(origin: NSPoint(x: r.minX, y: r.maxY - size.height), size: size), screen), "fitted") }
        return (r, "saved")
    }

    /// The compact pill sits at the expanded frame's top-right corner.
    static func pillFrame(expanded e: NSRect) -> NSRect {
        NSRect(x: e.maxX - pillSize.width, y: e.maxY - pillSize.height, width: pillSize.width, height: pillSize.height)
    }

    /// No larger than the screen, no smaller than minSize.
    static func fitted(_ s: NSSize, to screen: NSRect) -> NSSize {
        NSSize(width: max(minSize.width, min(s.width, screen.width)), height: max(minSize.height, min(s.height, screen.height)))
    }

    static func clampInto(_ r: NSRect, _ screen: NSRect) -> NSRect {
        var f = r
        f.origin.x = min(max(f.minX, screen.minX), max(screen.minX, screen.maxX - f.width))
        f.origin.y = min(max(f.minY, screen.minY), max(screen.minY, screen.maxY - f.height))
        return f
    }

    /// {"saved":"{{x,y},{w,h}}"|null,"screens":[[x,y,w,h],...]} (first = main).
    static func evaluate(json: String) -> String {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return "{\"error\":\"bad json\"}" }
        let screens = (obj["screens"] as? [[Double]] ?? []).compactMap { a in a.count == 4 ? NSRect(x: a[0], y: a[1], width: a[2], height: a[3]) : nil }
        let (f, reason) = expandedFrame(saved: obj["saved"] as? String, screens: screens, main: screens.first)
        return jsonString(["frame": [f.minX, f.minY, f.width, f.height], "reason": reason])
    }
}
