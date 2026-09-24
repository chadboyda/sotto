// Colours for the native panel: the page's tokens (web/styles.css, both themes), so the
// app and the Chrome fallback read as one product. Resolved from the SwiftUI colour
// scheme (not dynamic NSColors) so ImageRenderer snapshots honour a forced scheme.
// Light is cool neutral (feat/ui-polish): no cream, sand or beige surface anywhere.
import SwiftUI

public struct Theme: Sendable {
    public var bg, surface1, surface2, sunken, line, edge, fg, fg2, fg3, tickRest: Color
    public var live, liveTint, work, workTint, attn, attnTint, attnEdge, err, errTint, mute, muteTint: Color
    public var voice, voiceRest, bloomYou, bloomVoice, bloomMute, bloomAttn: Color
    /// Amber glyphs on neutral surfaces (the page's --attn-icon, >= 3:1).
    public var attnIcon: Color
    /// The page's --shadow-border: a 1 px ring (light: black 7%, dark: white 8%) plus,
    /// in light only, a soft drop. Raised surfaces use it instead of a border.
    public var ring, drop: Color
    /// The dial at rest (--dial-bezel-alpha, --dial-rest-alpha): quieter on a light page.
    public var dialBezelAlpha, dialRestAlpha: Double
    public var dark: Bool

    public static func of(_ scheme: ColorScheme) -> Theme { scheme == .dark ? .darkTheme : .lightTheme }

    public static let lightTheme = Theme(
        bg: .hex(0xF4F5F7), surface1: .hex(0xFFFFFF), surface2: .hex(0xECEEF2), sunken: .hex(0xE6E9ED), line: .hex(0xE0E3E8),
        edge: .hex(0x7A8391), fg: .hex(0x0F1217), fg2: .hex(0x434B57), fg3: .hex(0x5B6472), tickRest: .hex(0xBFC5CE),
        live: .hex(0x2F7A12), liveTint: .hex(0xE6F2DF), work: .hex(0x2352C4), workTint: .hex(0xE4EBFA),
        // Light: no amber wash (it read as beige); the amber ring, ink and icon carry the tone.
        attn: .hex(0x8A5700), attnTint: .hex(0xFFFFFF), attnEdge: .hex(0xA8740E), err: .hex(0xBE2B1D), errTint: .hex(0xFDECEA),
        mute: .hex(0x6A3FD0), muteTint: .hex(0xECE5FB), voice: .hex(0x3B5170), voiceRest: .hex(0xA9B1BC),
        // No warm bloom behind the dial on a light page: attention fades to the page colour.
        bloomYou: .hex(0xDCEFD2), bloomVoice: .hex(0xDCE4F0), bloomMute: .hex(0xE4DBFA), bloomAttn: .hex(0xF4F5F7),
        attnIcon: .hex(0xA8740E), ring: .black.opacity(0.07), drop: .black.opacity(0.08), dialBezelAlpha: 0.26, dialRestAlpha: 0.62, dark: false)

    public static let darkTheme = Theme(
        bg: .hex(0x0B0D10), surface1: .hex(0x14171C), surface2: .hex(0x1C2027), sunken: .hex(0x07080A), line: .hex(0x252A32),
        edge: .hex(0x626C7B), fg: .hex(0xECEFF4), fg2: .hex(0xAAB2BF), fg3: .hex(0x8B94A3), tickRest: .hex(0x333A45),
        live: .hex(0x8BD96B), liveTint: .hex(0x16241A), work: .hex(0x7FA8FF), workTint: .hex(0x141E33),
        attn: .hex(0xF0B43C), attnTint: .hex(0x211B10), attnEdge: .hex(0xB8871F), err: .hex(0xFF7A6B), errTint: .hex(0x2E1614),
        mute: .hex(0xB9A2FF), muteTint: .hex(0x1F1A33), voice: .hex(0xECEFF4), voiceRest: .hex(0x4A5361),
        bloomYou: .hex(0x8BD96B).opacity(0.18), bloomVoice: .hex(0xECEFF4).opacity(0.12), bloomMute: .hex(0xB9A2FF).opacity(0.16),
        bloomAttn: .hex(0xF0B43C).opacity(0.16),
        // Dark: one white ring; depth shadows vanish on a dark page.
        attnIcon: .hex(0xF0B43C), ring: .white.opacity(0.08), drop: .clear, dialBezelAlpha: 0.45, dialRestAlpha: 0.9, dark: true)

    /// The page's --fill: a flat wash for quiet groups (the header's usage capsule).
    public var fill: Color { dark ? .white.opacity(0.06) : .black.opacity(0.05) }
    /// The page's --hairline: the usage readout's slot dividers.
    public var hairline: Color { dark ? .white.opacity(0.12) : .black.opacity(0.12) }

    /// Colour for a header key (live | muted | attention | connecting | sleeping | paused | error | off).
    public func headerColor(_ key: String) -> Color {
        switch key {
        case "live": return live
        case "muted": return mute
        case "attention": return attn
        case "error": return err
        case "connecting": return fg2
        default: return fg3
        }
    }

    /// Tone (card / delegation) to a colour.
    public func toneColor(_ tone: String?) -> Color {
        switch tone {
        case "err", "error": return err
        case "attn", "warn", "attention": return attn
        case "work", "active": return work
        case "done": return live
        default: return fg3
        }
    }
}

/// The page's --shadow-border on a rounded surface: a 1 px ring drawn just outside the
/// shape (so it never changes the layout) and, in light, a soft drop. No border.
struct RaisedSurface: ViewModifier {
    let theme: Theme
    var radius: CGFloat
    var fill: Color?
    /// A tone ring instead of the neutral one (working: the work colour at 40%; approval: amber 1.5 px).
    var ringColor: Color?
    var ringWidth: CGFloat = 1
    /// --shadow-raised: a deeper drop (banners).
    var lifted = false
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .background(
                shape.fill(fill ?? theme.surface1)
                    .shadow(color: theme.dark ? .clear : (lifted ? .black.opacity(0.12) : theme.drop), radius: lifted ? 6 : 1.5, y: lifted ? 4 : 1)
                    .shadow(color: theme.dark && lifted ? .black.opacity(0.7) : .clear, radius: 10, y: 6)
            )
            .overlay(shape.inset(by: -ringWidth / 2).stroke(ringColor ?? theme.ring, lineWidth: ringWidth).allowsHitTesting(false))
    }
}

extension View {
    func raised(_ theme: Theme, radius: CGFloat, fill: Color? = nil, ring: Color? = nil, ringWidth: CGFloat = 1, lifted: Bool = false) -> some View {
        modifier(RaisedSurface(theme: theme, radius: radius, fill: fill, ringColor: ring, ringWidth: ringWidth, lifted: lifted))
    }
}

extension Color {
    static func hex(_ v: UInt32) -> Color {
        Color(.sRGB, red: Double((v >> 16) & 255) / 255, green: Double((v >> 8) & 255) / 255, blue: Double(v & 255) / 255, opacity: 1)
    }
}
