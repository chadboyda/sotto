// `--selftest <name> [json]`: pure checks with JSON on stdout, driven from
// node:test (test/app/app.test.mjs). No UI, no audio, no network.
import AppKit
import Foundation
import SottoAudio
import SottoClient
import SottoUI

private final class ResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: [String: JSONValue]?
    func set(_ v: [String: JSONValue]) { lock.lock(); value = v; lock.unlock() }
    func get() -> [String: JSONValue]? { lock.lock(); defer { lock.unlock() }; return value }
}

enum SelfTest {
    /// nil when `name` is not an app self-test (another target may own it).
    static func run(_ name: String, _ arg: String?) -> String? {
        switch name {
        case "panel-frame": return PanelGeometry.evaluate(json: arg ?? "{}")
        case "url": return AppURL.evaluate(json: arg ?? "{}")
        case "icon": return IconModel.evaluate(json: arg ?? "{}")
        case "hotkey": return hotkey(arg ?? "{}")
        case "options": return options(arg ?? "{}")
        case "bundle": return bundle()
        // Manual only: the CoreAudio device lists and the automatic plan (never opens a device).
        case "audio-devices": return AudioSelfTest.devicesJSON()
        case "ui-snapshot": return uiSnapshot(arg)
        default: return nil
        }
    }

    /// `--selftest link --port P --data-dir D` (docs/NATIVE.md B4): bootstrap with
    /// page.secret, hello/welcome, a status, clean close. Runs off the main thread.
    static func link(port: Int?, dataDir: String?) -> String {
        guard let port = port else { return jsonString(["selftest": "link", "ok": false, "error": "no_port"]) }
        let box = ResultBox()
        DispatchQueue.global().async {
            box.set(LinkSelfTest.run(port: port, dataDir: dataDir, version: AppController.appVersion, build: AppController.sourceHash))
        }
        // Keep the main run loop turning: URLSession and the link may deliver on main.
        while box.get() == nil { _ = RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05)) }
        let out = box.get() ?? [:]
        guard let d = try? JSONEncoder().encode(JSONValue.object(out)), let s = String(data: d, encoding: .utf8) else { return "{}" }
        return s
    }

    /// {"spec":"opt+cmd+m"} → {"ok","display","key"}.
    static func hotkey(_ json: String) -> String {
        let o = (try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]) ?? [:]
        guard let spec = (o["spec"] as? String).flatMap(HotkeySpec.parse) else { return jsonString(["ok": false]) }
        return jsonString(["ok": true, "display": spec.display, "key": spec.keyEquivalent])
    }

    /// `--selftest ui-snapshot [dir]`: PanelView in every canned state (light and dark) as PNGs,
    /// rendered offscreen with ImageRenderer (no window). Default dir: a new temp dir.
    static func uiSnapshot(_ arg: String?) -> String {
        let dir = arg.map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.temporaryDirectory.appendingPathComponent("sotto-ui-snapshot-\(ProcessInfo.processInfo.processIdentifier)")
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let files = try MainActor.assumeIsolated { try UISnapshot.render(to: dir) }
            return jsonString(["ok": true, "dir": dir.path, "files": files.map(\.lastPathComponent)])
        } catch {
            return jsonString(["ok": false, "error": "\(error)"])
        }
    }

    /// {"argv":[...],"env":{...}} → the parsed options (no code, only whether one was given).
    static func options(_ json: String) -> String {
        let o = (try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]) ?? [:]
        let argv = ["Sotto"] + (o["argv"] as? [String] ?? [])
        let env = o["env"] as? [String: String] ?? [:]
        let p = Options.parse(argv, env: env)
        return jsonString([
            "test": p.testMode, "hidden": p.hidden, "hotkeys": p.hotkeys, "show": p.show,
            "exit_after": orNull(p.exitAfter), "debug_log": orNull(p.debugLog), "test_action_dir": orNull(p.testActionDir),
            "port": orNull(p.request?.port), "has_code": p.request?.code != nil, "data": orNull(p.request?.dataDir),
            "wants_audio": ["off", "waiting_page", "connecting", "live", "reconnecting", "sleeping", "paused", "closing"]
                .filter { AppController.wantsAudio(state: $0) },
        ])
    }

    /// What this bundle says about itself (Info.plist keys the daemon and LaunchServices rely on).
    static func bundle() -> String {
        let info = Bundle.main.infoDictionary ?? [:]
        let schemes = ((info["CFBundleURLTypes"] as? [[String: Any]])?.first?["CFBundleURLSchemes"] as? [String]) ?? []
        return jsonString([
            "id": orNull(Bundle.main.bundleIdentifier),
            "version": info["CFBundleShortVersionString"] ?? NSNull(),
            "ui_element": info["LSUIElement"] ?? NSNull(),
            "schemes": schemes,
            "mic_usage": (info["NSMicrophoneUsageDescription"] as? String) != nil,
            "source_hash": orNull(AppController.sourceHash),
            "protocol": NativeProtocol.version,
        ])
    }
}
