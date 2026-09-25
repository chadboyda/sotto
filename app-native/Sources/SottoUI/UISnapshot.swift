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
        /// Seconds from the session start to the still frame.
        var elapsed: TimeInterval = 252
        /// Event clocks set relative to the still frame's time (a transition at any instant).
        var after: (@MainActor @Sendable (StateModel, Date) -> Void)? = nil
        /// Render with Reduce Motion on.
        var reduced = false
    }

    static func status(_ state: String, muted: Bool = false, busy: Bool = false, lastError: [String: JSONValue]? = nil,
                       key: [String: JSONValue]? = nil, todaySeconds: Double = 852, live: Bool? = nil, persona: String = "sotto", voice: String = "marin") -> [String: JSONValue] {
        var s: [String: JSONValue] = [
            "state": .string(state), "owner": .object(["project": .string("claude-live"), "cwd": .string("/tmp/claude-live")]),
            "voice": .string(voice), "persona": .string(persona), "speaking_policy": .string("milestones"), "idle_minutes": .number(5), "idle_seconds": .number(300),
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

    static let personas: JSONValue = .object(["current": .string("sotto"), "personas": .array([
        .object(["id": .string("sotto"), "name": .string("Sotto"), "voice": .string("marin"), "description": .string("Balanced and friendly, with real opinions.")]),
        .object(["id": .string("june"), "name": .string("June"), "voice": .string("coral"), "description": .string("Warm, encouraging, keeps you steady.")]),
        .object(["id": .string("moss"), "name": .string("Moss"), "voice": .string("cedar"), "description": .string("Dry-witted senior engineer.")]),
        .object(["id": .string("koan"), "name": .string("Koan"), "voice": .string("sage"), "description": .string("Calm zen mentor: slow, unflappable.")]),
    ])])

    static func connected(_ m: StateModel, _ st: [String: JSONValue]) {
        m.linkState = .connected
        m.apply(object: ["type": .string("welcome"), "protocol": .number(1), "version": .string("0.3.0"), "status": st["status"]!,
                         "settings": .object(["personas": personas])])
        m.terminalName = "iTerm2"
        m.showTerminal = {}
    }

    /// Two older stars from earlier turns and two from this one (minutes old).
    static func stars(_ m: StateModel, _ t: Date) {
        m.setEventsForPreview(milestones: [
            .init(s: 0.11, born: t.addingTimeInterval(-1900)), .init(s: 0.43, born: t.addingTimeInterval(-1300)),
            .init(s: 0.62, born: t.addingTimeInterval(-160)), .init(s: 0.79, born: t.addingTimeInterval(-70)),
        ])
    }

    static let approval: @MainActor @Sendable (StateModel) -> Void = { m in
        connected(m, status("live", busy: true)); working(m)
        m.apply(object: ev("activity", ["kind": .string("text"), "text": .string("The lockfile and `node_modules` disagree, which is why CI installs a different version. A clean install fixes it.")]))
        m.apply(object: ev("activity", ["kind": .string("permission"), "text": .string("Bash: rm -rf node_modules && npm ci")]))
    }

    /// The eclipse `age` seconds in (IMPLEMENTATION.md §4.1).
    static func eclipse(_ age: Double) -> @MainActor @Sendable (StateModel, Date) -> Void {
        { m, t in stars(m, t); m.setEventsForPreview(attentionAt: t.addingTimeInterval(-age)) }
    }

    static func captions(_ m: StateModel, _ you: String, _ sotto: String? = nil) {
        if let s = sotto { m.apply(object: ev("caption", ["role": .string("assistant"), "text": .string(s), "start_ms": .number(100), "end_ms": .number(900), "session": .string("sess_snap")])) }
        m.apply(object: ev("caption", ["role": .string("user"), "text": .string(you), "start_ms": .number(4000), "end_ms": .number(5200), "session": .string("sess_snap")]))
    }

    static let working: @MainActor @Sendable (StateModel) -> Void = { m in
        m.apply(object: ev("delegation", ["id": .string("d1"), "status": .string("delivered"), "text": .string("Fix the flaky auth test, then run the full suite")]))
        m.apply(object: ev("activity", ["kind": .string("turn_start"), "text": .string("")]))
        m.apply(object: ev("activity", ["kind": .string("text"), "text": .string("I read `auth.spec.ts` and the session helpers. The failure only shows up when the refresh timer fires during the assertion.")]))
        m.apply(object: ev("activity", ["kind": .string("text"), "text": .string("Found the race: the token refresh in `withSession()` resolves **after** the assertion runs.\n\n- Await the refresh instead of sleeping 50 ms\n- Run the auth suite 40 times\n- Then the full suite")]))
        m.apply(object: ev("activity", ["kind": .string("tool"), "text": .string("Running the tests")]))
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
        State(name: "09-claude-working", build: { m in connected(m, status("live", busy: true)); working(m); captions(m, "Also have it run the whole suite once it's done.", "Sure. I'll ask Claude to run the full suite after the fix.") },
              mic: 0, speaker: 0, floor: nil, after: { m, t in stars(m, t); m.setWorkSinceForPreview(t.addingTimeInterval(-100)) }),
        State(name: "10-claude-needs-approval", build: approval, mic: 0, speaker: 0, floor: nil, after: eclipse(6)),
        State(name: "10a-approval-freeze", build: approval, mic: 0, speaker: 0, floor: nil, after: eclipse(0.15)),
        State(name: "10b-approval-moon-crossing", build: approval, mic: 0, speaker: 0, floor: nil, after: eclipse(0.64)),
        State(name: "10c-approval-totality", build: approval, mic: 0, speaker: 0, floor: nil, after: eclipse(0.84)),
        State(name: "11-claude-finished", build: { m in
            connected(m, status("live"))
            m.apply(object: ev("delegation", ["id": .string("d1"), "status": .string("answered"), "text": .string("Fix the flaky auth test")]))
            m.apply(object: ev("activity", ["kind": .string("turn_end"), "text": .string(""), "summary": .string("Fixed the flaky auth test: the **login** and **auth** specs shared a module-level token cache, so the order they ran in mattered.\n\n- Each spec now builds its own cache\n- `npm test` passes: 214 tests\n\nSee [the PR](https://github.com/example/pr/1).")]))
            captions(m, "Nice. Anything else failing?")
        }, mic: 0, speaker: 0, floor: nil, after: { m, t in stars(m, t); m.setEventsForPreview(finishedAt: t.addingTimeInterval(-6)) }),
        State(name: "11a-finished-stars-flash", build: { m in
            connected(m, status("live"))
            m.apply(object: ev("activity", ["kind": .string("turn_end"), "text": .string(""), "summary": .string("**Done.** The auth test is stable across 40 runs, and the full suite passes: 412 tests in 38 s.")]))
            captions(m, "Nice.")
        }, mic: 0, speaker: 0, floor: nil, after: { m, t in stars(m, t); m.setEventsForPreview(finishedAt: t.addingTimeInterval(-1.08)) }),
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
        State(name: "18-sleeping", build: { m in connected(m, status("sleeping")) }, mic: 0, speaker: 0, floor: nil, after: { m, t in stars(m, t) }),
        State(name: "18b-sunrise-wake", build: { m in connected(m, status("sleeping")); m.apply(object: status("live")) }, mic: 0, speaker: 0, floor: nil,
              after: { m, t in stars(m, t); m.setEventsForPreview(wokeAt: t.addingTimeInterval(-0.3)) }),
        State(name: "19-sleeping-muted", build: { m in connected(m, status("sleeping")); m.wakeMuted = true }, mic: 0, speaker: 0, floor: nil),
        State(name: "20-mic-blocked", build: { m in connected(m, status("paused")); m.micFailure = "macos" }, mic: 0, speaker: 0, floor: nil),
        State(name: "21-lost-daemon", build: { m in connected(m, status("live")); m.linkState = .backoff(seconds: 2) }, mic: 0, speaker: 0, floor: nil),
        State(name: "22-voice-off", build: { m in connected(m, status("off")) }, mic: 0, speaker: 0, floor: nil),
        State(name: "23-closed", build: { m in connected(m, status("off")); m.apply(object: ev("command", ["command": .string("close_window"), "reason": .string("off")])) }, mic: 0, speaker: 0, floor: nil),
        State(name: "24-long-session", build: { m in
            connected(m, status("live", todaySeconds: 4 * 3600 + 1234)); captions(m, "How long have we been at this?", "A little over an hour.")
        }, mic: 0, speaker: 0, floor: nil, elapsed: 3600 + 125),
        State(name: "25-claude-finished-long", build: finishedLong(expanded: false), mic: 0, speaker: 0, floor: nil),
        State(name: "26-claude-finished-long-expanded", build: finishedLong(expanded: true), mic: 0, speaker: 0, floor: nil),
        // The 0.3.2 report: a background agent's approval with five agents at work, 7 minutes in.
        State(name: "27-agent-approval-crowded", build: { m in
            connected(m, status("live", busy: true)); working(m)
            m.apply(object: ev("activity", ["kind": .string("agents"), "text": .string("5 background agents working"), "count": .number(5)]))
            m.apply(object: ev("activity", ["kind": .string("permission"), "agent": .bool(true),
                                            "text": .string("A background agent needs approval to run a shell command")]))
        }, mic: 0, speaker: 0, floor: nil, elapsed: 420),
        State(name: "28-persona-switch", build: { m in
            connected(m, status("live", persona: "koan", voice: "sage")); captions(m, "Switch to Koan.")
        }, mic: 0, speaker: 0.5, floor: nil, after: { m, t in m.setEventsForPreview(personaSwitch: ("sotto", "koan", t.addingTimeInterval(-0.9))) }),
        State(name: "29-reduce-motion-approval", build: approval, mic: 0, speaker: 0, floor: nil, after: eclipse(6), reduced: true),
        State(name: "30-reduce-motion-you-speaking", build: { m in connected(m, status("live")); captions(m, "Also have it run the whole suite once it's done.") },
              mic: 0.8, speaker: 0, floor: "you", reduced: true),
    ]

    /// Claude's long final message (the user's report: the card grew and a scroller sat on the text).
    static let longSummary = """
    ## Auth cleanup done

    Fixed the flaky auth test and tidied the session code around it. The **login** and **auth** specs shared a module-level token cache, so the order they ran in decided whether they passed.

    - Each spec now builds its own cache in `beforeEach`
    - `SessionStore` no longer keeps a static instance
    - The retry helper waits on the clock instead of `setTimeout`
    - Removed two dead fixtures (`old-user.json`, `legacy-token.json`)

    ```js
    const store = new SessionStore({ clock });
    ```

    `npm test` passes: 214 tests, 0 failures, in 38 s. I also ran the auth suite 50 times in a loop and it passed every time.

    1. Review the diff in `src/auth/session.ts`
    2. Merge when CI is green

    See [the PR](https://github.com/example/pr/1) for the full list.
    """

    static func finishedLong(expanded: Bool) -> @MainActor @Sendable (StateModel) -> Void {
        { m in
            connected(m, status("live"))
            m.apply(object: ev("delegation", ["id": .string("d1"), "status": .string("answered"), "text": .string("Clean up the auth code")]))
            m.apply(object: ev("activity", ["kind": .string("turn_end"), "text": .string(""), "summary": .string(longSummary)]))
            m.summaryExpanded = expanded
            captions(m, "Great, what changed?")
        }
    }

    /// The states in design/native/parity/ (docs/NATIVE.md "Parity with the page").
    public static let parityNames = ["05-listening", "08-muted", "09-claude-working", "10-claude-needs-approval", "11-claude-finished", "12-background-agents",
                                     "13-cant-hear", "24-long-session", "25-claude-finished-long", "26-claude-finished-long-expanded"]

    /// Render the parity states at the default 420 x 720 panel and a narrow 360 x 640 one.
    @discardableResult
    public static func renderParity(to dir: URL) throws -> [URL] {
        let picked = states.filter { parityNames.contains($0.name) }
        return try render(to: dir, states: picked, size: CGSize(width: 420, height: 720), suffix: "420")
            + render(to: dir, states: picked.filter { ["05-listening", "24-long-session", "09-claude-working"].contains($0.name) }, size: CGSize(width: 360, height: 640), suffix: "360")
    }

    /// The Filament + Orrery screenshots (design/hybrid-impl/native/): every state in the
    /// 420 x 640 panel, the key states in the 640 x 900 large panel and the 320 x 96 strip.
    public static let largeNames = ["05-listening", "07-sotto-speaking", "09-claude-working", "10-claude-needs-approval", "11-claude-finished"]
    public static let miniNames = ["05-listening", "06-you-speaking", "07-sotto-speaking", "08-muted", "09-claude-working", "10-claude-needs-approval", "13-cant-hear", "18-sleeping"]

    @discardableResult
    public static func renderHybrid(to dir: URL) throws -> [URL] {
        var out = try render(to: dir, states: states, size: CGSize(width: 420, height: 640), suffix: nil, prefix: "panel-")
        out += try render(to: dir, states: states.filter { largeNames.contains($0.name) }, size: CGSize(width: 640, height: 900), suffix: nil, prefix: "large-")
        out += try render(to: dir, states: states.filter { miniNames.contains($0.name) }, size: MiniPanelView.size, suffix: nil, prefix: "mini-", mini: true)
        return out
    }

    /// A model in the named state (for previews and tests).
    public static func model(_ s: State) -> StateModel {
        let m = StateModel()
        let t0 = Date(timeIntervalSinceReferenceDate: 780_000_000)
        m.now = { t0 }
        s.build(m)
        // The session and Claude started a little before the frame (fixed, so snapshots are stable).
        m.now = { t0.addingTimeInterval(s.elapsed) }
        // Scenario levels are on the meter scale; the model holds raw RMS like the audio layer.
        m.micLevel = Float(ViewText.rmsFromLevel(Double(s.mic)))
        m.speakerLevel = Float(ViewText.rmsFromLevel(Double(s.speaker)))
        m.setFloorForPreview(s.floor)
        m.reducedMotion = s.reduced
        s.after?(m, t0.addingTimeInterval(s.elapsed))
        return m
    }

    /// Render every state in light and dark to `dir`; returns the files written.
    @discardableResult
    public static func render(to dir: URL, size: CGSize = CGSize(width: 420, height: 720), scale: CGFloat = 2) throws -> [URL] {
        try render(to: dir, states: states, size: size, suffix: nil, scale: scale)
    }

    static func render(to dir: URL, states: [State], size: CGSize, suffix: String?, scale: CGFloat = 2, prefix: String = "", mini: Bool = false) throws -> [URL] {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var out: [URL] = []
        for s in states {
            let still = Date(timeIntervalSinceReferenceDate: 780_000_000 + s.elapsed).timeIntervalSinceReferenceDate
            for scheme in [ColorScheme.light, .dark] {
                let m = model(s)
                let view = Group {
                    if mini { MiniPanelView(model: m, stillAt: still) } else { PanelView(model: m, stillAt: still) }
                }
                    .frame(width: size.width, height: size.height)
                    .environment(\.colorScheme, scheme)
                let r = ImageRenderer(content: view)
                r.scale = scale
                guard let cg = r.cgImage else { throw NSError(domain: "UISnapshot", code: 1, userInfo: [NSLocalizedDescriptionKey: "render failed: \(s.name)"]) }
                let rep = NSBitmapImageRep(cgImage: cg)
                guard let png = rep.representation(using: .png, properties: [:]) else { continue }
                let url = dir.appendingPathComponent("\(prefix)\(s.name)\(suffix.map { "--\($0)" } ?? "")--\(scheme == .dark ? "dark" : "light").png")
                try png.write(to: url)
                out.append(url)
            }
        }
        return out
    }
}
