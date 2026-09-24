// Canned panel states rendered to PNG with ImageRenderer (docs/NATIVE.md §6 B5:
// `--selftest ui-snapshot`). Silent: no audio, no network, no window. SottoApp's
// selftest calls `UISnapshot.render(to:)`; the XCTest writes design/native/.
import SwiftUI
import AppKit
import SottoClient

@MainActor
public enum UISnapshot {
    public struct State: Sendable {
        public let name: String
        let build: @MainActor @Sendable (StateModel) -> Void
        let mic: Float
        let speaker: Float
        let floor: String?
    }

    static func status(_ state: String, muted: Bool = false, busy: Bool = false, lastError: [String: JSONValue]? = nil,
                       key: [String: JSONValue]? = nil, todaySeconds: Double = 852, live: Bool? = nil) -> [String: JSONValue] {
        var s: [String: JSONValue] = [
            "state": .string(state), "owner": .object(["project": .string("claude-live"), "cwd": .string("/tmp/claude-live")]),
            "voice": .string("marin"), "speaking_policy": .string("milestones"), "idle_minutes": .number(5), "idle_seconds": .number(300),
            "echo_guard": .string("auto"), "wake": .object(["enabled": .bool(true), "sensitivity": .string("medium")]),
            "today": .object(["seconds": .number(todaySeconds), "cap_minutes": .number(120)]), "claude": .object(["busy": .bool(busy)]),
            "key": .object(["present": .bool(true), "source": .string("keychain"), "hint": .string("wxyz"), "label": .string("the macOS Keychain"),
                            "can_change": .bool(true), "can_remove": .bool(true), "keychain": .bool(true), "setup": .bool(false)]),
            "audio_client": .string("app"),
        ]
        if live ?? (state == "live") {
            s["live"] = .object(["session_id": .string("sess_snap"), "expires_at": .number(1_790_000_000), "usage_seconds": .number(60), "muted": .bool(muted)])
        }
        if let e = lastError { s["last_error"] = .object(e) }
        if let k = key { s["key"] = .object(k) }
        return ["type": .string("status"), "status": .object(s)]
    }

    static func ev(_ type: String, _ fields: [String: JSONValue]) -> [String: JSONValue] {
        var o = fields; o["type"] = .string(type); return o
    }

    static func connected(_ m: StateModel, _ st: [String: JSONValue]) {
        m.linkState = .connected
        m.apply(object: ["type": .string("welcome"), "protocol": .number(1), "version": .string("0.3.0"), "status": st["status"]!])
    }

    static func captions(_ m: StateModel, _ you: String, _ sotto: String? = nil) {
        if let s = sotto { m.apply(object: ev("caption", ["role": .string("assistant"), "text": .string(s), "start_ms": .number(100), "end_ms": .number(900), "session": .string("sess_snap")])) }
        m.apply(object: ev("caption", ["role": .string("user"), "text": .string(you), "start_ms": .number(4000), "end_ms": .number(5200), "session": .string("sess_snap")]))
    }

    static let working: @MainActor @Sendable (StateModel) -> Void = { m in
        m.apply(object: ev("delegation", ["id": .string("d1"), "status": .string("delivered"), "text": .string("Fix the flaky auth test, then run the full suite")]))
        m.apply(object: ev("activity", ["kind": .string("turn_start"), "text": .string("")]))
        m.apply(object: ev("activity", ["kind": .string("text"), "text": .string("The auth spec shares a token cache with login. I'll isolate it, then run the suite.")]))
        m.apply(object: ev("activity", ["kind": .string("tool"), "text": .string("Running npm test -- auth.spec.ts")]))
    }

    /// Every state the panel can show that the page's design/final covers.
    public static let states: [State] = [
        State(name: "01-starting", build: { m in m.linkState = .bootstrapping }, mic: 0, speaker: 0, floor: nil),
        State(name: "02-allow-microphone", build: { m in connected(m, status("connecting")); m.micPrompt = true }, mic: 0, speaker: 0, floor: nil),
        State(name: "03-api-key-needed", build: { m in
            connected(m, status("off", key: ["present": .bool(false), "can_change": .bool(true), "keychain": .bool(true), "setup": .bool(true)]))
        }, mic: 0, speaker: 0, floor: nil),
        State(name: "04-connecting", build: { m in connected(m, status("connecting")) }, mic: 0, speaker: 0, floor: nil),
        State(name: "05-listening", build: { m in connected(m, status("live")); captions(m, "Can you check the tests?", "Hi, I'm listening.") }, mic: 0.05, speaker: 0, floor: nil),
        State(name: "06-you-speaking", build: { m in connected(m, status("live")); captions(m, "Also have it run the whole suite once it's done.") }, mic: 0.8, speaker: 0, floor: "you"),
        State(name: "07-sotto-speaking", build: { m in connected(m, status("live")); captions(m, "What's failing?", "Two specs fail: login and auth. Want me to ask Claude to fix them?") }, mic: 0, speaker: 0.75, floor: "voice"),
        State(name: "08-muted", build: { m in connected(m, status("live", muted: true)) }, mic: 0, speaker: 0, floor: nil),
        State(name: "09-claude-working", build: { m in connected(m, status("live", busy: true)); working(m); captions(m, "Also have it run the whole suite once it's done.") }, mic: 0.1, speaker: 0, floor: nil),
        State(name: "10-claude-needs-approval", build: { m in
            connected(m, status("live", busy: true)); working(m)
            m.apply(object: ev("activity", ["kind": .string("permission"), "text": .string("Bash: rm -rf node_modules && npm ci")]))
        }, mic: 0, speaker: 0, floor: nil),
        State(name: "11-claude-finished", build: { m in
            connected(m, status("live"))
            m.apply(object: ev("delegation", ["id": .string("d1"), "status": .string("answered"), "text": .string("Fix the flaky auth test")]))
            m.apply(object: ev("activity", ["kind": .string("turn_end"), "text": .string(""), "summary": .string("Fixed the flaky auth test: the **login** and **auth** specs shared a module-level token cache, so the order they ran in mattered.\n\n- Each spec now builds its own cache\n- `npm test` passes: 214 tests\n\nSee [the PR](https://github.com/example/pr/1).")]))
            captions(m, "Nice. Anything else failing?")
        }, mic: 0, speaker: 0, floor: nil),
        State(name: "12-background-agents", build: { m in
            connected(m, status("live", busy: true)); working(m)
            m.apply(object: ev("activity", ["kind": .string("agents"), "text": .string("2 background agents"), "count": .number(2)]))
        }, mic: 0, speaker: 0, floor: nil),
        State(name: "13-cant-hear", build: { m in
            connected(m, status("live"))
            m.apply(object: ev("notice", ["level": .string("warn"), "code": .string("cant_hear"), "text": .string("I can't hear you — using MacBook Pro Microphone.")]))
        }, mic: 0, speaker: 0, floor: nil),
        State(name: "14-echo-and-error", build: { m in
            connected(m, status("live"))
            m.apply(object: ev("notice", ["level": .string("warn"), "code": .string("echo_detected"), "text": .string("Sotto heard its own voice. Use headphones, or turn on echo cancellation in Settings.")]))
            m.apply(object: ev("live", ["event": .object(["type": .string("error"), "error": .object(["code": .string("rate_limited"), "message": .string("The voice service is busy. Try again in a moment.")])])]))
        }, mic: 0, speaker: 0, floor: nil),
        State(name: "15-reconnecting", build: { m in connected(m, status("reconnecting", live: false)) }, mic: 0, speaker: 0, floor: nil),
        State(name: "16-paused-idle-pending", build: { m in
            connected(m, status("paused"))
            m.apply(object: ev("command", ["command": .string("disconnect"), "reason": .string("idle")]))
            m.apply(object: ev("result_pending", ["text": .string("All 214 tests pass. The flaky auth spec is fixed.")]))
        }, mic: 0, speaker: 0, floor: nil),
        State(name: "17-paused-daily-cap", build: { m in connected(m, status("paused", lastError: ["code": .string("daily_cap"), "message": .string("cap")])) }, mic: 0, speaker: 0, floor: nil),
        State(name: "18-sleeping", build: { m in connected(m, status("sleeping")) }, mic: 0, speaker: 0, floor: nil),
        State(name: "19-sleeping-muted", build: { m in connected(m, status("sleeping")); m.wakeMuted = true }, mic: 0, speaker: 0, floor: nil),
        State(name: "20-mic-blocked", build: { m in connected(m, status("paused")); m.micFailure = "macos" }, mic: 0, speaker: 0, floor: nil),
        State(name: "21-lost-daemon", build: { m in connected(m, status("live")); m.linkState = .backoff(seconds: 2) }, mic: 0, speaker: 0, floor: nil),
        State(name: "22-voice-off", build: { m in connected(m, status("off")) }, mic: 0, speaker: 0, floor: nil),
        State(name: "23-closed", build: { m in connected(m, status("off")); m.apply(object: ev("command", ["command": .string("close_window"), "reason": .string("off")])) }, mic: 0, speaker: 0, floor: nil),
    ]

    /// A model in the named state (for previews and tests).
    public static func model(_ s: State) -> StateModel {
        let m = StateModel()
        let t0 = Date(timeIntervalSinceReferenceDate: 780_000_000)
        m.now = { t0 }
        s.build(m)
        // The session and Claude started a little before the frame (fixed, so snapshots are stable).
        m.now = { t0.addingTimeInterval(252) }
        m.micLevel = s.mic
        m.speakerLevel = s.speaker
        m.setFloorForPreview(s.floor)
        return m
    }

    /// Render every state in light and dark to `dir`; returns the files written.
    @discardableResult
    public static func render(to dir: URL, size: CGSize = CGSize(width: 420, height: 720), scale: CGFloat = 2) throws -> [URL] {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var out: [URL] = []
        let still = Date(timeIntervalSinceReferenceDate: 780_000_000 + 252).timeIntervalSinceReferenceDate
        for s in states {
            for scheme in [ColorScheme.light, .dark] {
                let m = model(s)
                let view = PanelView(model: m, stillAt: still)
                    .frame(width: size.width, height: size.height)
                    .environment(\.colorScheme, scheme)
                let r = ImageRenderer(content: view)
                r.scale = scale
                guard let cg = r.cgImage else { throw NSError(domain: "UISnapshot", code: 1, userInfo: [NSLocalizedDescriptionKey: "render failed: \(s.name)"]) }
                let rep = NSBitmapImageRep(cgImage: cg)
                guard let png = rep.representation(using: .png, properties: [:]) else { continue }
                let url = dir.appendingPathComponent("\(s.name)--\(scheme == .dark ? "dark" : "light").png")
                try png.write(to: url)
                out.append(url)
            }
        }
        return out
    }
}
