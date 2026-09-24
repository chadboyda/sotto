// Offscreen PNG renders of the settings + onboarding views for review (design/native/).
// Silent: no audio, no daemon, no windows on screen (a borderless window far off-screen,
// never ordered front). Used by SottoUITests (SOTTO_SNAPSHOT_DIR) and can back a
// `--selftest settings-snapshot` in SottoApp.
import AppKit
import SwiftUI
import SottoClient

@MainActor
public enum SettingsSnapshots {
    public struct Shot { public var name: String; public var size: CGSize; public var view: AnyView }

    /// Canned models. Commands answer instantly and never leave the process.
    public static func fixtureModel(status: PageStatus, mic: MicPermission = .granted) -> SettingsModel {
        let state = StateModel()
        state.status = status
        state.micLevel = 0.08
        state.sendCommand = { _, _ in .success(.object([:])) }
        let m = SettingsModel(state: state)
        m.settings = NativeSettings(
            voices: .init(voices: ["alloy", "ash", "ballad", "cedar", "coral", "echo", "marin", "sage", "shimmer", "verse"], current: status.voice, live: true),
            personas: .init(personas: [
                .init(id: "sotto", name: "Sotto", description: "Balanced and friendly, with real opinions and a light touch of humor.", voice: "marin", source: "builtin"),
                .init(id: "june", name: "June", description: "Warm, encouraging partner who celebrates progress and keeps you steady.", voice: "coral", source: "builtin"),
                .init(id: "moss", name: "Moss", description: "Dry-witted senior engineer: understated, seen-it-all, quietly funny.", voice: "cedar", source: "builtin"),
                .init(id: "reviewer", name: "Reviewer", description: "Our team's code-review voice.", voice: nil, source: "project"),
            ], current: "sotto", use_voice: true, live: true, live_persona: "sotto"),
            window: "auto", policies: ["quiet", "milestones", "walkthrough"], wake_sensitivities: ["off", "low", "medium", "high"],
            data_dir: "/tmp/sotto-data", version: "0.3.0")
        m.inputDevices = [DeviceChoice(id: "builtin-mic", name: "MacBook Pro Microphone"),
                          DeviceChoice(id: "airpods-in", name: "AirPods Pro", bluetooth: true, headphones: true),
                          DeviceChoice(id: "usb-mic", name: "Shure MV7")]
        m.outputDevices = [DeviceChoice(id: "builtin-out", name: "MacBook Pro Speakers"),
                           DeviceChoice(id: "airpods-out", name: "AirPods Pro", bluetooth: true, headphones: true)]
        m.activeInput = m.inputDevices[0]
        m.activeOutput = m.outputDevices[0]
        m.inputLevels = ["builtin-mic": 0.12, "airpods-in": 0.004, "usb-mic": 0.03]
        m.micPermission = mic
        m.loginItem = .on
        m.hooks.selectInput = { _ in }
        m.hooks.selectOutput = { _ in }
        m.hooks.setEchoCancellation = { _ in }
        m.hooks.setInputMetering = { _ in }
        m.hooks.playVoicePreview = { _ in }
        m.hooks.setLaunchAtLogin = { $0 ? .on : .off }
        m.hooks.openLogs = {}
        m.hooks.requestMicAccess = { .granted }
        m.hooks.openMicPrivacySettings = {}
        return m
    }

    /// A PageStatus built through its Codable form (it has no public memberwise init).
    nonisolated public static func fixtureStatus(state: String = "live", key: [String: Any]? = nil, lastError: String? = nil) -> PageStatus {
        var o: [String: Any] = [
            "state": state, "voice": "marin", "speaking_policy": "milestones", "echo_guard": "auto",
            "wake": ["enabled": true, "sensitivity": "medium", "boost_db": 0, "not_before": 0],
            "key": key ?? ["present": true, "source": "keychain", "hint": "ab12", "label": "the macOS Keychain",
                           "can_change": true, "can_remove": true, "keychain": true, "setup": false],
            "audio_client": "app",
        ]
        if let lastError { o["last_error"] = ["code": lastError, "message": lastError] }
        return decodeStatus(o)!
    }

    nonisolated public static func decodeStatus(_ o: [String: Any]) -> PageStatus? {
        guard let d = try? JSONSerialization.data(withJSONObject: o) else { return nil }
        return try? JSONDecoder().decode(PageStatus.self, from: d)
    }

    public static func shots() -> [Shot] {
        let noKey: [String: Any] = ["present": false, "can_change": true, "can_remove": false, "keychain": true, "setup": true]
        let badKey: [String: Any] = ["present": true, "source": "keychain", "hint": "wxyz", "label": "the macOS Keychain",
                                     "can_change": true, "can_remove": true, "keychain": true, "setup": false]

        let settings = fixtureModel(status: fixtureStatus())
        settings.metering = true
        settings.echoResultForSnapshot(SettingsText.echoVerdict("low"))

        let micAsk = fixtureModel(status: fixtureStatus(state: "paused"), mic: .notDetermined)
        let micDenied = fixtureModel(status: fixtureStatus(state: "paused"), mic: .denied)
        let keyFirst = fixtureModel(status: fixtureStatus(state: "paused", key: noKey))
        let keyRejected = fixtureModel(status: fixtureStatus(state: "paused", key: badKey, lastError: "openai_auth"))

        return [
            Shot(name: "settings", size: CGSize(width: 480, height: 1180), view: AnyView(SettingsView(model: settings))),
            Shot(name: "onboarding-mic", size: CGSize(width: 420, height: 320), view: AnyView(OnboardingView(model: micAsk))),
            Shot(name: "onboarding-mic-denied", size: CGSize(width: 420, height: 380), view: AnyView(OnboardingView(model: micDenied))),
            Shot(name: "onboarding-key", size: CGSize(width: 420, height: 360), view: AnyView(OnboardingView(model: keyFirst))),
            Shot(name: "onboarding-key-rejected", size: CGSize(width: 420, height: 330), view: AnyView(OnboardingView(model: keyRejected))),
        ]
    }

    /// Render every shot in light and dark to `<dir>/<name>--<appearance>.png`. Returns the paths.
    @discardableResult
    public static func render(to dir: URL) throws -> [URL] {
        _ = NSApplication.shared
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var out: [URL] = []
        for shot in shots() {
            for (suffix, name) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
                let url = dir.appendingPathComponent("\(shot.name)--\(suffix).png")
                try png(shot.view, size: shot.size, appearance: NSAppearance(named: name)!).write(to: url)
                out.append(url)
            }
        }
        return out
    }

    static func png(_ view: AnyView, size: CGSize, appearance: NSAppearance) throws -> Data {
        let root = view.frame(width: size.width, height: size.height)
            .background(Color(nsColor: .windowBackgroundColor))
        let host = NSHostingView(rootView: root)
        host.frame = CGRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: CGRect(x: -20_000, y: -20_000, width: size.width, height: size.height),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = appearance
        window.contentView = host
        host.appearance = appearance
        // Let SwiftUI lay out and its AppKit controls draw.
        for _ in 0..<3 {
            host.layoutSubtreeIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { throw SnapshotError.render }
        host.cacheDisplay(in: host.bounds, to: rep)
        window.close()
        guard let data = rep.representation(using: .png, properties: [:]) else { throw SnapshotError.render }
        return data
    }

    enum SnapshotError: Error { case render }
}

extension SettingsModel {
    /// Snapshot/test seam: show an echo result without running the test.
    func echoResultForSnapshot(_ v: SettingsText.EchoVerdict?) { setEchoResult(v) }
}
