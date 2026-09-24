// Small helpers: launch options, debug log, voice-state model.
import AppKit
import Foundation

/// How a window request reaches the app (SPEC §6.16):
///   sotto://open?port=<n>&k=<launch code>&data=<data dir>   (daemon, via `open -g -a <bundle> <url>`)
///   sotto://close?port=<n>                                  (daemon close_window fallback)
///   Sotto --port <n> --k <code> [--data-dir <D>] [test flags]  (direct exec, tests)
struct LaunchRequest: Equatable {
    var port: Int
    var code: String?
    var dataDir: String?

    /// Loopback page URL. The launch code rides in the fragment, which is never sent over HTTP.
    var pageURL: URL {
        var s = "http://127.0.0.1:\(port)/"
        if let c = code, !c.isEmpty { s += "#k=\(c)" }
        return URL(string: s)!
    }

    static func validPort(_ s: String?) -> Int? {
        guard let s = s, let n = Int(s), n >= 1024, n <= 65535 else { return nil }
        return n
    }

    static func validCode(_ s: String?) -> String? {
        guard let s = s, s.count >= 16, s.count <= 128,
              s.allSatisfy({ $0.isASCII && $0.isHexDigit }) else { return nil }
        return s
    }
}

enum UrlCommand: Equatable {
    case open(LaunchRequest)
    case close(port: Int?)
    case show
}

func parseUrlCommand(_ url: URL) -> UrlCommand? {
    guard url.scheme?.lowercased() == "sotto" else { return nil }
    let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
    var q: [String: String] = [:]
    for item in comps?.queryItems ?? [] { q[item.name] = item.value ?? "" }
    let verb = (url.host ?? "").lowercased()
    switch verb {
    case "open":
        guard let port = LaunchRequest.validPort(q["port"]) else { return nil }
        let data = q["data"].flatMap { $0.hasPrefix("/") ? $0 : nil }
        return .open(LaunchRequest(port: port, code: LaunchRequest.validCode(q["k"]), dataDir: data))
    case "close":
        return .close(port: LaunchRequest.validPort(q["port"]))
    case "show":
        return .show
    default:
        return nil
    }
}

/// Any web page can fire a sotto:// URL (the browser asks first, but one
/// click is enough), so the port in an `open` request is not trusted as is: the
/// panel would load whatever listens there and grant it this app's microphone
/// permission, and Voice Off would send it the daemon key. Accept it only when
/// this user's daemon records that port in <data dir>/daemon.port: a regular
/// file (not a symlink) owned by us, in a directory owned by us.
func daemonRecordsPort(dataDir: String?, port: Int) -> Bool {
    guard let dir = dataDir, dir.hasPrefix("/") else { return false }
    let fm = FileManager.default
    let uid = getuid()
    // attributesOfItem does not follow a symlink in the last component.
    func owned(_ p: String, _ type: FileAttributeType) -> Bool {
        guard let a = try? fm.attributesOfItem(atPath: p) else { return false }
        return (a[.type] as? FileAttributeType) == type && (a[.ownerAccountID] as? NSNumber)?.uint32Value == uid
    }
    let file = (dir as NSString).appendingPathComponent("daemon.port")
    guard owned(dir, .typeDirectory), owned(file, .typeRegular),
          let text = try? String(contentsOfFile: file, encoding: .utf8) else { return false }
    return Int(text.trimmingCharacters(in: .whitespacesAndNewlines)) == port
}

/// User defaults: the app's own domain, or a separate suite in test mode so
/// automated runs never touch the user's panel position or preferences.
enum Prefs {
    static var testMode = false
    static var store: UserDefaults {
        testMode ? (UserDefaults(suiteName: "com.chadboyda.sotto.test") ?? .standard) : .standard
    }
}

struct Options {
    var request: LaunchRequest?
    var debugLog: String?
    var probeMedia = false
    var mockCapture = false
    var hidden = false
    /// Test mode only: keep the panel on screen (screenshots). Still muted,
    /// mock mic, no hotkeys, own defaults suite.
    var show = false
    var hotkeys = true
    var exitAfter: Double?
    var testMode = false

    static func parse(_ argv: [String]) -> Options {
        var o = Options()
        var port: Int?
        var code: String?
        var data: String?
        var i = 1
        func next() -> String? { i += 1; return i < argv.count ? argv[i] : nil }
        while i < argv.count {
            switch argv[i] {
            case "--port": port = LaunchRequest.validPort(next())
            case "--k": code = LaunchRequest.validCode(next())
            case "--data-dir": data = next()
            case "--debug-log": o.debugLog = next()
            case "--probe-media": o.probeMedia = true
            case "--mock-capture": o.mockCapture = true
            case "--hidden": o.hidden = true
            case "--no-hotkeys": o.hotkeys = false
            case "--exit-after": o.exitAfter = next().flatMap(Double.init)
            case "--test": o.testMode = true
            case "--show": o.show = true
            default: break // LaunchServices adds -psn_… and friends
            }
            i += 1
        }
        if let p = port { o.request = LaunchRequest(port: p, code: code, dataDir: data) }
        // Test mode can also come from the environment, for launches through
        // LaunchServices (`open --env ...`), which pass no arguments.
        let env = ProcessInfo.processInfo.environment
        if o.debugLog == nil, let v = env["SOTTO_APP_DEBUG_LOG"], !v.isEmpty { o.debugLog = v }
        if env["SOTTO_APP_TEST"] == "1" { o.testMode = true }
        if env["SOTTO_APP_SHOW"] == "1" { o.show = true }
        if o.testMode {
            // Automated tests: invisible, no global hotkeys, WebKit's mock mic
            // (no microphone permission), separate defaults and web storage.
            o.hidden = !o.show
            o.hotkeys = false
            o.mockCapture = true
        }
        return o
    }
}

/// JSONL debug log (test mode only). Never receives the launch code, page
/// token or captions: callers pass URLs without fragments and state only.
final class DebugLog {
    private let handle: FileHandle?
    init(path: String?) {
        guard let path = path else { handle = nil; return }
        FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600])
        handle = FileHandle(forWritingAtPath: path)
        handle?.seekToEndOfFile()
    }
    var enabled: Bool { handle != nil }
    func log(_ ev: String, _ fields: [String: Any] = [:]) {
        guard let h = handle else { return }
        var obj = fields
        obj["ev"] = ev
        obj["t"] = Date().timeIntervalSince1970
        guard JSONSerialization.isValidJSONObject(obj),
              var data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
        data.append(0x0A)
        h.write(data)
    }
}

/// What the menu-bar icon shows.
enum VoiceIcon: String {
    case off, connecting, paused, sleeping, listening, userSpeaking, assistantSpeaking, working, muted, error

    var symbol: String {
        switch self {
        case .off: return "waveform.slash"
        case .connecting: return "ellipsis.circle"
        case .paused: return "pause.circle"
        case .sleeping: return "moon.zzz"
        case .listening: return "waveform"
        case .userSpeaking: return "mic.fill"
        case .assistantSpeaking: return "speaker.wave.2.fill"
        case .working: return "gearshape.2"
        case .muted: return "mic.slash.fill"
        case .error: return "exclamationmark.triangle.fill"
        }
    }

    var label: String {
        switch self {
        case .off: return "Voice off"
        case .connecting: return "Connecting"
        case .paused: return "Paused"
        case .sleeping: return "Sleeping, listening for your voice"
        case .listening: return "Listening"
        case .userSpeaking: return "You are speaking"
        case .assistantSpeaking: return "Sotto is speaking"
        case .working: return "Claude is working"
        case .muted: return "Muted"
        case .error: return "Needs attention"
        }
    }

    var tint: NSColor? {
        switch self {
        case .error: return .systemRed
        case .muted: return .systemOrange
        case .userSpeaking, .assistantSpeaking: return .controlAccentColor
        default: return nil
        }
    }
}

/// Voice state as seen through the page bridge (bridge.js). Pure; the
/// controller feeds it messages and a clock and asks for the icon.
struct VoiceModel {
    var pageLoaded = false
    var state = "off"          // daemon PageStatus.state
    var project = ""
    var statusMuted = false
    var dcMuted: Bool?         // from session.input_audio.muted/unmuted (fresher than status)
    var busy = false
    var errorCode = ""
    var errorMessage = ""
    var micFailed = false
    var lastUser: TimeInterval = 0
    var lastAssistant: TimeInterval = 0

    static let speakingHold: TimeInterval = 1.2

    var muted: Bool { dcMuted ?? statusMuted }

    func icon(now: TimeInterval) -> VoiceIcon {
        if !pageLoaded { return .off }
        switch state {
        case "off", "closing", "": return .off
        case "waiting_page", "connecting", "reconnecting": return micFailed ? .error : .connecting
        case "paused": return (!errorCode.isEmpty && errorCode != "idle") || micFailed ? .error : .paused
        case "sleeping": return micFailed ? .error : .sleeping
        case "live":
            if muted { return .muted }
            if now - lastAssistant < VoiceModel.speakingHold { return .assistantSpeaking }
            if now - lastUser < VoiceModel.speakingHold { return .userSpeaking }
            if busy { return .working }
            return .listening
        default:
            return .connecting
        }
    }

    mutating func apply(_ m: [String: Any], now: TimeInterval) {
        switch m["kind"] as? String {
        case "status":
            state = m["state"] as? String ?? state
            project = m["project"] as? String ?? project
            statusMuted = m["muted"] as? Bool ?? false
            busy = m["busy"] as? Bool ?? false
            errorCode = m["error"] as? String ?? ""
            errorMessage = m["error_message"] as? String ?? ""
            if state != "live" { dcMuted = nil }
        case "muted":
            dcMuted = m["muted"] as? Bool
        case "speaking":
            if (m["role"] as? String) == "assistant" { lastAssistant = now } else { lastUser = now }
        case "live":
            if (m["live"] as? Bool) == false { dcMuted = nil; lastUser = 0; lastAssistant = 0 }
        case "mic":
            micFailed = (m["ok"] as? Bool) == false
        default:
            break
        }
    }
}

/// Where the expanded panel goes (pure; `Sotto --panel-frame-eval` tests it).
/// The first launch, and any saved frame smaller than `minSize` (the web
/// page's no-scroll range) or off every screen, open at the full default
/// 420x640 near the top right of the main screen. A saved frame taller or
/// wider than its screen is fitted to it. Reasons: default, saved, too_small,
/// offscreen, fitted.
enum PanelGeometry {
    static let defaultSize = NSSize(width: 420, height: 640)
    static let minSize = NSSize(width: 360, height: 420)
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

    /// Tests: {"saved":"{{x,y},{w,h}}"|null,"screens":[[x,y,w,h],...]} (first = main).
    static func evaluate(json: String) -> String {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return "{\"error\":\"bad json\"}" }
        let screens = (obj["screens"] as? [[Double]] ?? []).compactMap { a in a.count == 4 ? NSRect(x: a[0], y: a[1], width: a[2], height: a[3]) : nil }
        let (f, reason) = expandedFrame(saved: obj["saved"] as? String, screens: screens, main: screens.first)
        return jsonString(["frame": [f.minX, f.minY, f.width, f.height], "reason": reason])
    }
}
