// Tokens for the Filament + Orrery panel (design/concepts-v2/hybrid/IMPLEMENTATION.md §2,
// on top of concept-3's table). One meaning per hue in both themes: `you` teal, `voice`
// periwinkle, Claude white (dark) or ink (light), `need` star gold, `muted` rose,
// `error` red. Can't hear is never red. Resolved from the SwiftUI colour scheme (not
// dynamic NSColors) so ImageRenderer snapshots honour a forced scheme.
import SwiftUI

public struct HybridTheme: Sendable {
    public var dark: Bool
    /// Deep space in dark (`#05070C`), a printed page in light.
    public var ground: Color
    /// The static radial lift behind the string (dark only; light = ground).
    public var lift: Color
    /// `ink3` is for glyphs and lines only (3:1); `fg3` is its text-safe twin (>= 4.5:1 on
    /// `ground`, as the page's --fg-3).
    public var ink, ink2, ink3, fg3, hair, hair2, cap: Color
    public var string, bead, star, night: Color
    public var you, youInk, voice, voiceInk: Color
    /// Star gold: light and line only, never a fill. Light mode splits line and text.
    public var need, needInk: Color
    public var muted, mutedInk, err, focus: Color
    /// Bloom strength (1 in dark, 0.35 on a white page).
    public var glow: Double
    /// The live string's opacity at rest, where it runs teal (you) to periwinkle (voice).
    public var restAlpha: Double
    public var increaseContrast = false

    /// The corona's inner ring and the roots of its streamers.
    public static let coronaPale = Color(.sRGB, red: 255 / 255, green: 222 / 255, blue: 168 / 255, opacity: 1)
    /// The dawn bloom's cool light (dark only; additive).
    public static let dawn = Color(.sRGB, red: 200 / 255, green: 216 / 255, blue: 255 / 255, opacity: 1)

    public static func of(_ scheme: ColorScheme, increaseContrast: Bool = false) -> HybridTheme {
        var t = scheme == .dark ? darkTheme : lightTheme
        if increaseContrast {
            // System Settings > Accessibility > Display > Increase contrast (the page's
            // `prefers-contrast: more`): every quiet token steps up, text and lines alike.
            t.increaseContrast = true
            t.ink2 = t.ink.opacity(0.85)
            t.ink3 = t.ink.opacity(0.72)
            t.fg3 = t.ink.opacity(0.78)
            t.string = t.dark ? Color.white.opacity(0.85) : Color.hex(0x0C0D12).opacity(0.85)
            t.hair = t.ink.opacity(0.24)
            t.hair2 = t.ink.opacity(0.4)
            t.cap = t.ink.opacity(0.12)
            t.restAlpha = 1
        }
        return t
    }

    public static let darkTheme = HybridTheme(
        dark: true, ground: .hex(0x05070C), lift: .hex(0x0C1222),
        ink: .hex(0xF2F4F8), ink2: .hex(0xF2F4F8).opacity(0.66), ink3: .hex(0xF2F4F8).opacity(0.46), fg3: .hex(0x8A91A0),
        hair: .white.opacity(0.07), hair2: .white.opacity(0.15), cap: .white.opacity(0.065),
        string: Color(.sRGB, red: 236 / 255, green: 242 / 255, blue: 1, opacity: 0.55), bead: .white, star: .hex(0xE6EDF7), night: .hex(0x03050A),
        you: .hex(0x5EEAD4), youInk: .hex(0x5EEAD4), voice: .hex(0xA5B4FC), voiceInk: .hex(0xA5B4FC),
        need: .hex(0xFFB547), needInk: .hex(0xFFC56E), muted: .hex(0xFF6FAE), mutedInk: .hex(0xFF8FC0), err: .hex(0xFF453A), focus: .hex(0x0A84FF),
        glow: 1, restAlpha: 0.8)

    // v0.4.1: a crisp white page. #FBFCFD with neutral-grey hairlines and a 5% ink capsule
    // read as grey-beige ("greige") on a real display; the ground is now pure white and the
    // quiet tokens lean slightly cool (slate, not grey).
    public static let lightTheme = HybridTheme(
        dark: false, ground: .hex(0xFFFFFF), lift: .hex(0xFFFFFF),
        ink: .hex(0x0B0D14), ink2: .hex(0x0B0D14).opacity(0.66), ink3: .hex(0x0B0D14).opacity(0.5), fg3: .hex(0x5F6778),
        hair: .hex(0x23345A).opacity(0.09), hair2: .hex(0x23345A).opacity(0.18), cap: .hex(0x2B4170).opacity(0.055),
        string: .hex(0x0B0D14).opacity(0.62), bead: .hex(0x0B0D14), star: .hex(0x1A2A44), night: .hex(0x070B16),
        // Gold line #C4800E is 3.2:1 on white (a component boundary); gold text #A55200 is 5.4:1.
        // The live string's teal and periwinkle are line colours (3:1 or better with the glow).
        you: .hex(0x0FA896), youInk: .hex(0x0A7568), voice: .hex(0x5B63E6), voiceInk: .hex(0x4A51D6),
        need: .hex(0xC4800E), needInk: .hex(0xA55200), muted: .hex(0xE0357A), mutedInk: .hex(0xB81A5C), err: .hex(0xD70015), focus: .hex(0x0064E1),
        glow: 0.7, restAlpha: 0.95)

    /// The serif for Claude's words (New York).
    public static func serif(_ size: CGFloat, weight: Font.Weight = .regular) -> Font { .system(size: size, weight: weight, design: .serif) }
}

/// Where every zone sits, per panel size (IMPLEMENTATION.md §1, concept-3 §1). The zones
/// are fixed boxes: content changes inside a zone with a cross-fade and no zone ever
/// resizes. The panel scales between the 420 x 640 "panel" and the 640 x 900 "large"
/// geometry by width; extra height goes to Claude's page.
public struct HybridLayout: Equatable, Sendable {
    public var size: CGSize
    public var mini = false
    public var sc: CGFloat
    public var pegX, pegR, y: CGFloat
    public var headerH: CGFloat
    public var wordY, wordSize: CGFloat
    public var capY, capH, capSize: CGFloat
    public var rowY: CGFloat
    public var serif, lineHeight: CGFloat
    public var footerH: CGFloat

    public init(size: CGSize) {
        self.size = size
        let large = size.width >= 600 && size.height >= 820
        sc = large ? 1.35 : 1
        pegX = large ? 52 : 40
        pegR = large ? 28 : 22
        y = large ? 164 : 124
        headerH = large ? 54 : 46
        wordY = large ? 84 : 62
        wordSize = large ? 26 : 20
        capY = large ? 192 : 146
        capH = large ? 26 : 22
        capSize = large ? 15 : 13
        rowY = large ? 236 : 178
        serif = large ? 22 : 19
        lineHeight = large ? 32 : 28
        footerH = large ? 64 : 54
    }

    /// The compact strip (320 x 96): peg, string, word and caption only.
    public static func mini(_ size: CGSize = CGSize(width: 320, height: 96)) -> HybridLayout {
        var l = HybridLayout(size: size)
        l.mini = true
        l.sc = 0.55; l.pegX = 34; l.pegR = 17; l.y = 52
        l.headerH = 0; l.wordY = 9; l.wordSize = 13; l.capY = 66; l.capH = 20; l.capSize = 12.5
        l.rowY = size.height; l.footerH = 0
        return l
    }

    /// The string's left end: just clear of the peg's tick ring.
    public var x0: CGFloat { pegX + pegR + 10 * max(sc, 0.7) }
    /// The bridge (right anchor).
    public var x1: CGFloat { size.width - 16 }
    /// Text hangs from the string: its left edge is the string's start + 1 pt.
    public var textX: CGFloat { (x0 + 1).rounded() }
    /// The reading column ends 20 pt inside the bridge, so the approval frame has an inset on both sides.
    public var columnRight: CGFloat { x1 - 20 }
    public var footerTop: CGFloat { size.height - footerH }
    /// The approval frame's bottom edge (concept-3 §1: 12 pt above the footer).
    public var frameBottom: CGFloat { mini ? size.height - 4 : footerTop - 12 }
    public var wordH: CGFloat { (wordSize * 1.3).rounded() }
    public var pageTop: CGFloat { rowY + 20 + 8 }
    public var pageBottom: CGFloat { frameBottom - 14 }
}
