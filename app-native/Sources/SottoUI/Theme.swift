// Colours for the native panel: the page's tokens (web/styles.css, both themes), so the
// app and the Chrome fallback read as one product. Resolved from the SwiftUI colour
// scheme (not dynamic NSColors) so ImageRenderer snapshots honour a forced scheme.
import SwiftUI

public struct Theme: Sendable {
    public var bg, surface1, surface2, sunken, line, edge, fg, fg2, fg3, tickRest: Color
    public var live, liveTint, work, workTint, attn, attnTint, attnEdge, err, errTint, mute, muteTint: Color
    public var voice, voiceRest, bloomYou, bloomVoice, bloomMute, bloomAttn: Color
    public var dark: Bool

    public static func of(_ scheme: ColorScheme) -> Theme { scheme == .dark ? .darkTheme : .lightTheme }

    public static let lightTheme = Theme(
        bg: .hex(0xF5F6F8), surface1: .hex(0xFFFFFF), surface2: .hex(0xECEEF2), sunken: .hex(0xE4E7EC), line: .hex(0xDCE0E6),
        edge: .hex(0x7A8391), fg: .hex(0x0F1217), fg2: .hex(0x434B57), fg3: .hex(0x5B6472), tickRest: .hex(0xB7BEC8),
        live: .hex(0x2F7A12), liveTint: .hex(0xE6F2DF), work: .hex(0x2352C4), workTint: .hex(0xE4EBFA),
        attn: .hex(0x8A5700), attnTint: .hex(0xFBF0D9), attnEdge: .hex(0xB07A12), err: .hex(0xBE2B1D), errTint: .hex(0xFBE5E2),
        mute: .hex(0x6A3FD0), muteTint: .hex(0xECE5FB), voice: .hex(0x3B5170), voiceRest: .hex(0x9AA3B0),
        bloomYou: .hex(0xDCEFD2), bloomVoice: .hex(0xDCE4F0), bloomMute: .hex(0xE4DBFA), bloomAttn: .hex(0xF8E6BF), dark: false)

    public static let darkTheme = Theme(
        bg: .hex(0x0B0D10), surface1: .hex(0x14171C), surface2: .hex(0x1C2027), sunken: .hex(0x07080A), line: .hex(0x252A32),
        edge: .hex(0x626C7B), fg: .hex(0xECEFF4), fg2: .hex(0xAAB2BF), fg3: .hex(0x8B94A3), tickRest: .hex(0x333A45),
        live: .hex(0x8BD96B), liveTint: .hex(0x16241A), work: .hex(0x7FA8FF), workTint: .hex(0x141E33),
        attn: .hex(0xF0B43C), attnTint: .hex(0x2A2110), attnEdge: .hex(0xB8871F), err: .hex(0xFF7A6B), errTint: .hex(0x2E1614),
        mute: .hex(0xB9A2FF), muteTint: .hex(0x1F1A33), voice: .hex(0xECEFF4), voiceRest: .hex(0x4A5361),
        bloomYou: .hex(0x8BD96B).opacity(0.18), bloomVoice: .hex(0xECEFF4).opacity(0.12), bloomMute: .hex(0xB9A2FF).opacity(0.16),
        bloomAttn: .hex(0xF0B43C).opacity(0.16), dark: true)

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

extension Color {
    static func hex(_ v: UInt32) -> Color {
        Color(.sRGB, red: Double((v >> 16) & 255) / 255, green: Double((v >> 8) & 255) / 255, blue: Double(v & 255) / 255, opacity: 1)
    }
}
