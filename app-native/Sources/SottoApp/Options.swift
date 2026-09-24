// Launch options, preferences, the JSONL debug log (docs/NATIVE.md §5.1).
import AppKit
import Foundation
import SottoClient

/// User defaults: the app's own domain, or a separate suite in test mode so
/// automated runs never touch the user's panel position or preferences.
enum Prefs {
    static let testSuite = "com.chadboyda.sotto.test"
    nonisolated(unsafe) static var testMode = false
    static var store: UserDefaults {
        testMode ? (UserDefaults(suiteName: testSuite) ?? .standard) : .standard
    }
}

/// Command line + environment. LaunchServices launches (`open -a … --env …`)
/// pass no arguments, so test mode and the test fixtures also come from the
/// environment (daemon/window.js APP_TEST_ENV).
struct Options: Equatable {
    var request: LaunchRequest?
    var debugLog: String?
    var hidden = false
    /// Test mode only: keep the panel on screen (screenshots).
    var show = false
    var hotkeys = true
    var exitAfter: Double?
    var testMode = false
    /// Test mode only: toggle mute this long after the session first goes live (the mute round trip in test:app).
    var testMuteAfterMs: Int?
    var selftest: String?
    var selftestArg: String?
    var version = false

    static func parse(_ argv: [String], env: [String: String] = ProcessInfo.processInfo.environment) -> Options {
        var o = Options()
        var port: Int?
        var code: String?
        var data: String?
        var i = 1
        func next() -> String? { i += 1; return i < argv.count ? argv[i] : nil }
        while i < argv.count {
            switch argv[i] {
            case "--port": port = AppURL.validPort(next())
            case "--k": code = AppURL.validCode(next())
            case "--data-dir": data = next()
            case "--debug-log": o.debugLog = next()
            case "--hidden": o.hidden = true
            case "--no-hotkeys": o.hotkeys = false
            case "--exit-after": o.exitAfter = next().flatMap(Double.init)
            case "--test": o.testMode = true
            case "--show": o.show = true
            case "--version": o.version = true
            case "--selftest":
                o.selftest = next()
                // Optional JSON argument (anything not starting with "--").
                if i + 1 < argv.count, !argv[i + 1].hasPrefix("--") { o.selftestArg = next() }
            default: break // LaunchServices adds -psn_… and friends
            }
            i += 1
        }
        if let p = port { o.request = LaunchRequest(port: p, code: code, dataDir: data.flatMap { $0.hasPrefix("/") ? $0 : nil }) }
        if o.debugLog == nil, let v = env["SOTTO_APP_DEBUG_LOG"], !v.isEmpty { o.debugLog = v }
        if env["SOTTO_APP_TEST"] == "1" { o.testMode = true }
        if env["SOTTO_APP_SHOW"] == "1" { o.show = true }
        if o.testMode, let v = env["SOTTO_APP_TEST_MUTE_AFTER_MS"].flatMap(Int.init), v >= 0 { o.testMuteAfterMs = v }
        if o.testMode {
            // Automated tests: invisible, no global hotkeys, fake audio (no
            // CoreAudio unit, no microphone prompt), separate defaults.
            o.hidden = !o.show
            o.hotkeys = false
        }
        return o
    }
}

/// JSONL debug log (tests and diagnostics). Never receives the launch code,
/// page token, API key or captions: callers pass state only.
final class DebugLog: @unchecked Sendable {
    private let handle: FileHandle?
    private let lock = NSLock()
    init(path: String?) {
        guard let path = path else { handle = nil; return }
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
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
        lock.lock(); defer { lock.unlock() }
        h.write(data)
    }
}

func jsonString(_ obj: Any) -> String {
    guard JSONSerialization.isValidJSONObject(obj),
          let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
          let s = String(data: d, encoding: .utf8) else { return "{}" }
    return s
}

/// A hidden main menu with the standard Edit items. An accessory app shows no
/// menu bar, but AppKit still routes key equivalents through `NSApp.mainMenu`:
/// without it Cmd+V does nothing in the key field (SPEC §4.3).
enum EditMenu {
    @MainActor static func install() {
        let main = NSMenu()
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)
        NSApp.mainMenu = main
    }
}

/// JSON-friendly optional: the value, or NSNull.
func orNull<T>(_ v: T?) -> Any { v.map { $0 as Any } ?? NSNull() }
