// UI state (docs/NATIVE.md §3, §5.4). Builder B5 owns SottoUI.
//
// StateModel is the native twin of the page's `S` object in web/app.js: it reduces the
// daemon's messages (status snapshots, activity, delegations, captions, notices, Live
// events, commands) into what PanelView shows. Everything visible derives from
// `pageView` (ViewText.pageView, the port of lib.pageView) and `claudeCard`
// (ViewText.claudeView). The app (SottoApp.Controller) feeds it: `apply(_:)` for every
// daemon message, `linkState` from the link, `micLevel`/`speakerLevel` from the audio
// engine, and the closures for commands and app-local actions.
import SwiftUI
import Observation
import SottoClient

@MainActor
@Observable
public final class StateModel {
    // MARK: Daemon state
    public var status: PageStatus?
    /// The last `settings` message (docs/NATIVE.md §3.1 Settings), raw.
    public var settings: [String: JSONValue]?
    public var linkState: LinkState = .idle { didSet { linkChanged(oldValue) } }

    // MARK: Levels: raw linear RMS (0..1) as the audio layer measures it, written by the app
    // at ~25-50 Hz. Everything that shows them converts with ViewText.levelFromRms first
    // (v0.4.0 fed raw RMS straight to the floor tracker and the string, which expect the
    // meter scale: speech at RMS 0.03 never crossed the 0.36 floor threshold, so the string
    // stayed flat and the headline never said "Hearing you" or "Speaking").
    // Only a visible change (> 0.01 on the meter scale, or reaching 0) is published, so a
    // silent panel does not re-render.
    public var micLevel: Float {
        get { access(keyPath: \.micLevel); return shownMic }
        set { if Self.visible(newValue, shownMic) { withMutation(keyPath: \.micLevel) { shownMic = newValue } }; levelsChanged(mic: newValue) }
    }
    public var speakerLevel: Float {
        get { access(keyPath: \.speakerLevel); return shownSpeaker }
        set { if Self.visible(newValue, shownSpeaker) { withMutation(keyPath: \.speakerLevel) { shownSpeaker = newValue } }; levelsChanged(speaker: newValue) }
    }
    /// The wake detector's level while sleeping (drives the inner ring).
    public var wakeLevel: Float {
        get { access(keyPath: \.wakeLevel); return shownWake }
        set { if Self.visible(newValue, shownWake) { withMutation(keyPath: \.wakeLevel) { shownWake = newValue } } }
    }
    @ObservationIgnored private var shownMic: Float = 0
    @ObservationIgnored private var shownSpeaker: Float = 0
    @ObservationIgnored private var shownWake: Float = 0
    @ObservationIgnored private var rawMic: Float = 0
    @ObservationIgnored private var rawSpeaker: Float = 0
    nonisolated static func visible(_ new: Float, _ old: Float) -> Bool {
        abs(ViewText.levelFromRms(Double(new)) - ViewText.levelFromRms(Double(old))) > 0.01 || (new == 0 && old != 0)
    }
    /// The mic and speaker on the meter scale (lib.levelFromRms), for the views.
    public var micMeter: Double { ViewText.levelFromRms(Double(micLevel)) }
    public var speakerMeter: Double { ViewText.levelFromRms(Double(speakerLevel)) }
    public var wakeMeter: Double { ViewText.levelFromRms(Double(wakeLevel)) }

    // MARK: Captions, Claude, banners
    public private(set) var captions: [ViewText.Caption] = []
    public private(set) var delegations: [ViewText.Delegation] = []
    public private(set) var claudeBusy = false
    public private(set) var claudeKind: String?
    /// The approval shown is a background agent's (SPEC §6.10.4).
    public private(set) var claudeAgent = false
    public private(set) var claudeText = ""
    public private(set) var claudeSays = ""
    public private(set) var claudeSaysAt: Date?
    public private(set) var claudeTool = ""
    public private(set) var summary: String?
    public var summaryExpanded = false
    public private(set) var agents = 0
    public private(set) var workSince: Date?
    public private(set) var activityLine: ViewText.ActivityLine?
    public private(set) var pendingResult: String?
    public private(set) var banners: [Banner] = []

    // MARK: Session facts the page kept client-side
    public private(set) var pausedReason: String?
    public private(set) var liveSessionId: String?
    public private(set) var sessionStartedAt: Date?
    /// The freshest billed seconds of this session from `session.usage.updated`.
    public private(set) var liveUsageSeconds: Double = 0
    /// True after `command close_window` until the next status that is not off.
    public private(set) var closed = false
    /// A mute toggle sent but not yet acknowledged: the UI shows the wanted value.
    public private(set) var mutePending: Bool?
    /// The floor word currently shown (after the 1.3 s hold): "you" | "voice" | nil.
    public private(set) var floor: String?
    /// A spoken announcement for VoiceOver (polite unless assertive).
    public private(set) var announcement: (text: String, assertive: Bool, seq: Int)?

    // MARK: App-local facts (set by the app, not the daemon)
    /// Microphone failure kind from the audio engine (lib.micFailureKind names): macos | notfound | busy | other.
    public var micFailure: String?
    /// The macOS microphone prompt is on screen.
    public var micPrompt = false
    /// The mic name in use, for the "can't hear you" banner.
    public var micName: String?
    /// Reduce Motion (the app mirrors NSWorkspace.accessibilityDisplayShouldReduceMotion; views also read the environment).
    public var reducedMotion = false
    /// The user muted local wake listening while sleeping.
    public var wakeMuted = false
    /// The panel is on screen and not occluded (the app sets it from NSWindow's occlusion
    /// state): the hero's timelines pause when it is false.
    public var panelVisible = true
    /// The terminal Claude Code runs in, when the app knows it (the last terminal app the
    /// user activated). Shown in the approval caption ("In iTerm2 · project").
    public var terminalName: String?

    // MARK: Wiring (set by the app)
    /// Send a command, get the result (docs/NATIVE.md §3.3).
    public var sendCommand: ((_ name: String, _ args: [String: JSONValue]) async -> Result<JSONValue, CommandError>)?
    /// Open the app's settings (swift-settings owns that window).
    public var openSettings: (() -> Void)?
    /// Show the mic picker ("Switch mic" on the can't-hear banner).
    public var openMicSwitcher: (() -> Void)?
    /// The user touched the UI (sent as `activity {}`).
    public var onUserActivity: (() -> Void)?
    /// Bring the terminal forward ("Show terminal" in the approval); nil hides the button.
    public var showTerminal: (() -> Void)?
    /// Last command error, shown as a banner.
    public private(set) var lastCommandError: CommandError?

    /// Injectable clock for tests.
    public var now: () -> Date = { Date() }

    // MARK: Filament + Orrery (design/concepts-v2/hybrid): event clocks and milestones
    /// When Claude started waiting for you (the eclipse's t = 0), and when it stopped.
    public private(set) var attentionAt: Date?
    public private(set) var attentionClearedAt: Date?
    /// When Claude last finished a turn ("Claude finished", the finish ring and star flash).
    public private(set) var finishedAt: Date?
    /// When the panel woke from sleep (the sunrise).
    public private(set) var wokeAt: Date?
    /// A persona switch in flight: the tuning glissando and "Switching to <Name>".
    public private(set) var personaSwitch: (from: String, to: String, at: Date)?
    /// Milestone stars on the string: where the bead was when Claude finished a step.
    public struct Milestone: Equatable, Sendable { public var s: Double; public var born: Date }
    /// lib.milestoneStars' state (ms since 1970), kept as the page keeps it.
    @ObservationIgnored private var starState = ViewText.Stars()
    public private(set) var milestones: [Milestone] = []
    /// Claude's own words on the page: the latest message and up to two before it.
    public private(set) var pageMessages: [String] = []
    @ObservationIgnored private var attentionWas = false
    /// Bumped to make time-based views re-read the clock once (the end of a one-shot).
    public private(set) var redrawTick = 0
    public func touchForRedraw() { redrawTick &+= 1 }

    private var everConnected = false
    private var wordHold = WordHold()
    private var floorTracker = FloorTracker()
    private var captionSeq = 0
    private var announceSeq = 0

    public init() {}

    // MARK: - Derived views

    /// Everything the panel shows for this snapshot (ViewText.pageView over the model).
    public var pageView: ViewText.PageView { ViewText.pageView(pageInput) }

    public var pageInput: ViewText.PageInput {
        var p = ViewText.PageInput()
        p.phase = phase
        p.state = status?.state ?? "off"
        p.muted = effectiveMuted
        p.floor = floor
        p.connectStage = connectStage
        p.connectReason = status?.state == "reconnecting" ? "reconnect" : nil
        p.micPrompt = micPrompt
        p.micFailure = micFailure
        p.key = status?.key
        p.pausedReason = pausedReason ?? (status?.state == "paused" && status?.last_error?.code == "daily_cap" ? "daily_cap" : nil)
        p.idleMinutes = status?.idle_minutes
        p.idleSeconds = status?.idle_seconds
        p.capMinutes = status?.today?.cap_minutes
        p.pendingResult = pendingResult
        p.lastErrorCode = status?.last_error?.code
        p.lastErrorMessage = status?.last_error?.message
        p.attention = attention
        p.host = "app"
        if p.state == "sleeping" {
            let enabled = (status?.wake?.enabled ?? true) && status?.wake?.sensitivity != "off"
            p.sleep = ViewText.sleepView(muted: wakeMuted, enabled: enabled, micError: micFailure)
        }
        return p
    }

    /// The page's `phase`, derived: the daemon owns the session, so live/connecting
    /// follow its state; boot/lost follow the link; closed follows close_window.
    public var phase: String {
        switch linkState {
        case .connected: break
        case .idle, .bootstrapping, .connecting:
            if !everConnected { return "boot" }
            return "lost"
        case .backoff, .failed:
            return everConnected ? "lost" : "boot"
        }
        guard let st = status?.state else { return "boot" }
        if closed && st == "off" { return "closed" }
        if micFailure != nil && st != "sleeping" { return "error" }
        switch st {
        case "live": return "live"
        case "connecting", "reconnecting", "waiting_page": return "connecting"
        default: return "idle"
        }
    }

    /// The connect checklist stage: the app's mic is already open, so the daemon is reaching OpenAI.
    private var connectStage: String? {
        guard let st = status?.state else { return nil }
        if micPrompt { return "mic" }
        if st == "waiting_page" { return "network" }
        return st == "connecting" ? "session" : nil
    }

    public var effectiveMuted: Bool { mutePending ?? (status?.live?.muted ?? false) }
    public var attention: Bool { claudeKind == "permission" && claudeBusy }
    public var isLive: Bool { phase == "live" }
    public var isPaused: Bool { status?.state == "paused" }
    public var isSleeping: Bool { status?.state == "sleeping" }

    /// The Claude card (ViewText.claudeView over the model).
    public var claudeCard: ViewText.ClaudeCard {
        let t = now()
        return ViewText.claudeView(.init(
            busy: claudeBusy, kind: claudeKind, text: claudeText, agent: claudeAgent, says: claudeSays,
            saysAt: claudeSaysAt.map { $0.timeIntervalSince1970 * 1000 }, now: t.timeIntervalSince1970 * 1000,
            tool: claudeTool, summary: summary, request: delegations.first, agents: agents))
    }

    static let requestActive: Set<String> = ["collecting", "sent", "delivered", "held_suspected", "failed"]

    /// The "Asked: ..." line under the card, or nil.
    public var requestLine: (text: String, tone: String)? {
        let card = claudeCard
        guard let req = card.request else { return nil }
        let active = card.kind == "working" || card.kind == "approval" || Self.requestActive.contains(delegations.first?.status ?? "")
        guard active else { return nil }
        let lead = (req.tone == "error" || req.tone == "warn") ? req.label : "Asked"
        return ("\(lead): \u{201C}\(req.text)\u{201D}", req.tone)
    }

    /// "42 sec" while Claude works.
    public func workingTime(at t: Date) -> String? {
        guard claudeBusy, let since = workSince else { return nil }
        return ViewText.formatElapsed(t.timeIntervalSince(since) * 1000)
    }

    /// The approval's wait so far ("0:14"), while Claude waits.
    public func waitingTime(at t: Date) -> String? {
        guard attention, let since = attentionAt else { return nil }
        return ViewText.formatClock(max(0, t.timeIntervalSince(since)))
    }

    /// Claude's elapsed time as a clock ("4:17"), while it works.
    public func workingClock(at t: Date) -> String? {
        guard claudeBusy, let since = workSince else { return nil }
        return ViewText.formatClock(max(0, t.timeIntervalSince(since)))
    }

    /// The can't-hear notice is up (the string is drawn broken, the word says so).
    public var cantHear: Bool { banners.contains { $0.key == "cant_hear" } }

    /// The persona in effect: the daemon's status (a terminal switch updates it first), then settings.
    public var personaId: String {
        if let p = status?.persona, !p.isEmpty { return p }
        if case .object(let o)? = settings?["personas"], case .string(let c)? = o["current"] { return c }
        return "sotto"
    }

    /// The personas the daemon offers (id, name, voice), for the footer chip.
    public var personaList: [(id: String, name: String, voice: String?)] {
        guard case .object(let o)? = settings?["personas"], case .array(let list)? = o["personas"] else { return [] }
        return list.compactMap { item in
            guard case .object(let p) = item, case .string(let id)? = p["id"] else { return nil }
            let name: String = { if case .string(let n)? = p["name"] { return n }; return id.capitalized }()
            let voice: String? = { if case .string(let v)? = p["voice"] { return v }; return nil }()
            return (id, name, voice)
        }
    }

    public func personaName(_ id: String) -> String { personaList.first { $0.id == id }?.name ?? id.prefix(1).uppercased() + id.dropFirst() }

    /// "Switching to <Name>" while a persona switch runs (at most 2.5 s, or until the new session is live).
    public func switchingTo(at t: Date) -> String? {
        guard let sw = personaSwitch else { return nil }
        let st = status?.state ?? "off"
        let age = t.timeIntervalSince(sw.at)
        guard age >= 0, age < 2.5 || ((st == "connecting" || st == "reconnecting") && age < 20) else { return nil }
        return personaName(sw.to)
    }

    /// Claude needing you, as the words show it: at totality (0.75 s into the eclipse), or at
    /// once under Reduce Motion. Until then the headline and caption still say what Claude was doing.
    public func attentionShown(at t: Date) -> Bool {
        guard attention else { return false }
        if reducedMotion { return true }
        guard let a = attentionAt else { return true }
        return t.timeIntervalSince(a) * 1000 >= ViewText.eclipseTotalityMs
    }

    /// The headline (lib.headline over the model) at `t`: the approval only from totality.
    public func headline(at t: Date) -> ViewText.Headline {
        ViewText.headline(pageView(at: t), .init(attention: attentionShown(at: t), question: claudeKind == "question", busy: claudeBusy,
                                                  tool: claudeTool, finishedAt: finishedAt.map { $0.timeIntervalSince1970 * 1000 },
                                                  now: t.timeIntervalSince1970 * 1000))
    }

    /// The page view at `t`: as `pageView`, with an approval shown only from totality (lib.ECLIPSE_TOTALITY_MS).
    public func pageView(at t: Date) -> ViewText.PageView {
        var p = pageInput
        p.attention = attentionShown(at: t)
        return ViewText.pageView(p)
    }

    /// Today's billed seconds: the daemon's figure plus fresher usage from this session's events.
    public func todaySeconds(at t: Date) -> Double {
        let base = status?.today?.seconds ?? 0
        guard let live = status?.live, let sid = liveSessionId, live.session_id == sid else { return base }
        let extra = liveUsageSeconds - (live.usage_seconds ?? 0)
        return extra > 0 ? base + extra : base
    }

    /// "4:12" while live (the Session pill), nil otherwise.
    public func sessionClock(at t: Date) -> String? {
        sessionSeconds(at: t).map { ViewText.formatClock($0) }
    }

    public func sessionSeconds(at t: Date) -> Double? {
        guard phase == "live", let s = sessionStartedAt else { return nil }
        return max(0, t.timeIntervalSince(s))
    }

    // The header's usage reading, throttled like the page's (lib.stableUsage) and ticked
    // by wall time while live (lib.tickingToday). Written while a frame is drawn, so it
    // is not observed: the header's own 1 s timeline redraws it.
    @ObservationIgnored private var usageShown: ViewText.UsageReading?
    @ObservationIgnored private var todayShown: Double?

    /// The header pills at `t` (web/app.js renderUsage): Session (live only), Today, Cost.
    public func usagePills(at t: Date) -> ViewText.UsagePills {
        let ms = t.timeIntervalSince1970 * 1000
        let reading = ViewText.stableUsage(usageShown, seconds: todaySeconds(at: t), now: ms)
        usageShown = reading
        let session = sessionSeconds(at: t)
        let today = ViewText.tickingToday(reading, now: ms, live: session != nil, shown: todayShown)
        todayShown = today
        return ViewText.usagePills(sessionSeconds: session, todaySeconds: today, costSeconds: reading.seconds)
    }

    public var project: String? {
        if let p = status?.owner?.project, !p.isEmpty { return p }
        if let c = status?.owner?.cwd, !c.isEmpty { return (c as NSString).lastPathComponent }
        return nil
    }

    public var voices: [String] {
        guard case .object(let v)? = settings?["voices"], case .array(let list)? = v["voices"] else { return [] }
        return list.compactMap { item in
            if case .string(let s) = item { return s }
            if case .object(let o) = item, case .string(let s)? = o["name"] ?? o["id"] { return s }
            return nil
        }
    }

    // MARK: - Reducer

    /// Apply one daemon message (status replaces; everything else is an event).
    public func apply(_ message: ServerMessage) {
        switch message {
        case .status(let s): applyStatus(s)
        case .welcome(_, _, let s, let raw):
            everConnected = true
            if case .object(let o)? = raw["settings"] { settings = o }
            if let s { applyStatus(s) }
        case .settings(let s): if case .object(let o)? = Self.json(s) { settings = o }
        case .activity(let a):
            var o = a.raw; o["kind"] = .string(a.kind); o["text"] = .string(a.text)
            apply(type: "activity", o)
        case .delegation(let d):
            apply(type: "delegation", ["id": .string(d.id), "status": d.status.map { .string($0) } ?? .null, "text": d.text.map { .string($0) } ?? .null])
        case .notice(let n):
            apply(type: "notice", ["level": n.level.map { .string($0) } ?? .null, "code": n.code.map { .string($0) } ?? .null, "text": n.text.map { .string($0) } ?? .null])
        case .noticeClear(let code): apply(type: "notice_clear", ["code": .string(code)])
        case .resultPending(let text): apply(type: "result_pending", ["text": .string(text)])
        case .wakeHeard(let text): apply(type: "wake_heard", ["text": .string(text)])
        case .command(let c): applyCommand(c.command, reason: c.reason)
        case .caption(let c):
            addCaption(role: c.role, text: c.text, start: c.start_ms, end: c.end_ms, session: c.session)
        case .live(let ev):
            var o = ev.raw; o["type"] = .string(ev.type)
            applyLive(o)
        case .other(let type, let raw): apply(type: type, raw)
        case .audioFlush, .ping, .result, .unknown: break
        }
    }

    private static func json<T: Encodable>(_ v: T) -> JSONValue? {
        guard let d = try? JSONEncoder().encode(v) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: d)
    }

    /// Apply one daemon message given as its JSON object (the `type` field inside).
    /// Every §3.1 type is handled here, so the app may feed raw objects directly.
    public func apply(object: [String: JSONValue]) {
        guard let type = object.string("type") else { return }
        apply(type: type, object)
    }

    public func apply(type: String, _ m: [String: JSONValue]) {
        switch type {
        case "welcome":
            everConnected = true
            if let o = m.object("settings") { settings = o }
            if let s = decodeStatus(m["status"]) { applyStatus(s) }
        case "status":
            if let s = decodeStatus(m["status"]) { applyStatus(s) }
        case "settings":
            settings = m
        case "activity": applyActivity(m)
        case "delegation":
            delegations = ViewText.upsertDelegation(delegations, id: m.string("id"), status: m.string("status"), text: m.string("text"))
        case "notice":
            let code = m.string("code")
            var action: Banner.Action?
            if code == "cant_hear" { action = .switchMic }
            let text = nonEmpty(m.string("text")) ?? code ?? "Notice"
            showBanner(level: m.string("level") ?? "info", text: text, key: code ?? text, action: action, sticky: code == "cant_hear")
        case "notice_clear":
            if let code = m.string("code") { dismissBanner(key: code) }
        case "result_pending":
            pendingResult = nonEmpty(m.string("text"))
            if let t = pendingResult { summary = ViewText.truncate(t, 420) }
        case "wake_heard":
            if let t = nonEmpty(m.string("text")) {
                addCaption(role: "user", text: t, start: 0, end: 1, session: liveSessionId)
            }
        case "caption":
            addCaption(role: m.string("role"), text: m.string("text"), start: m.number("start_ms"), end: m.number("end_ms"), session: m.string("session"))
        case "live":
            if let ev = m.object("event") { applyLive(ev) }
        case "command":
            applyCommand(m.string("command"), reason: m.string("reason"))
        case "audio_flush", "ping", "result":
            break  // audio and link concerns (SottoApp / SottoClient)
        default:
            break
        }
    }

    private func decodeStatus(_ v: JSONValue?) -> PageStatus? {
        guard let v, let data = try? JSONEncoder().encode(v) else { return nil }
        return try? JSONDecoder().decode(PageStatus.self, from: data)
    }

    private func applyStatus(_ s: PageStatus) {
        let prev = status
        status = s
        if let b = s.claude?.busy { setBusy(b) }
        // The daemon tracks pending approvals (SPEC §6.10.4): none pending means the card
        // cannot still ask for one, even if the activity that cleared it was missed.
        if let c = s.claude, c.reportsApproval, c.approval == nil, claudeKind == "permission" { claudeKind = "approval_cleared"; claudeAgent = false }
        if s.state == "paused" && s.last_error?.code == "daily_cap" { pausedReason = "daily_cap" }
        if s.state != "off" { closed = false }
        if let p = mutePending, s.live?.muted == p { mutePending = nil }
        if s.live == nil { mutePending = nil }
        // A new Live session starts the session clock.
        let sid = s.live?.session_id
        if sid != prev?.live?.session_id {
            if let sid {
                if sid != liveSessionId { liveSessionId = sid; sessionStartedAt = now(); liveUsageSeconds = 0 }
            } else { sessionStartedAt = nil }
        }
        if ["live", "connecting", "reconnecting", "waiting_page"].contains(s.state) { pausedReason = nil }
        if s.state == "live" && prev?.state != "live" { dismissBanner(key: "lost") }
        if s.state != prev?.state { announceState(s.state) }
        // The sunrise: sleeping to awake.
        if prev?.state == "sleeping" && ["live", "connecting", "reconnecting"].contains(s.state) { wokeAt = now() }
        // A persona switch (from the panel, Settings or the terminal).
        if let p = s.persona, let old = prev?.persona, p != old { personaSwitch = (old, p, now()) }
        // Milestones belong to the voice session: cleared when voice ends.
        if s.state == "off" { milestones = []; starState = ViewText.Stars() }
        noteAttention()
    }

    private func applyActivity(_ m: [String: JSONValue]) {
        let kind = m.string("kind")
        if kind == "agents" {
            agents = max(0, Int(m.number("count") ?? 0))
            return
        }
        let v = ViewText.activityView(kind: kind, text: m.string("text"), summary: m.string("summary"), busy: m.bool("busy"))
        activityLine = v
        if kind == "turn_start" || kind == "turn_end" { claudeSays = ""; claudeSaysAt = nil; claudeTool = "" }
        if kind == "text" { claudeSays = m.string("text") ?? ""; claudeSaysAt = now() }
        if kind == "turn_start" { pageMessages = []; finishedAt = nil }
        if kind == "text" { pushPage(claudeSays) }
        if kind == "tool" { claudeTool = m.string("text") ?? "" }
        if let b = v.busy { setBusy(b) }
        if let s = v.summary { summary = s; summaryExpanded = false }
        claudeKind = kind
        claudeText = m.string("text") ?? ""
        claudeAgent = kind == "permission" && m.bool("agent") == true
        noteMilestone(kind: kind, text: m.string("text"))
        if kind == "turn_end" {
            finishedAt = now()
            if let s = v.summary { pushPage(s) }
        }
        noteAttention()
        switch kind {
        case "turn_start": announce("Claude is working.")
        case "permission":
            let t = m.string("text").map { ": " + ViewText.truncate($0, 120) } ?? ""
            announce("Claude needs your approval in the terminal\(t).", assertive: true)
        case "turn_end": announce("Claude finished.")
        default: break
        }
    }

    private func applyLive(_ ev: [String: JSONValue]) {
        switch ev.string("type") {
        case "session.started":
            if let sid = ev.object("session")?.string("id") {
                if sid != liveSessionId { liveSessionId = sid; liveUsageSeconds = 0 }
                sessionStartedAt = sessionStartedAt ?? now()
            }
        case "session.input_audio.muted": if mutePending == true { mutePending = nil }
        case "session.input_audio.unmuted": if mutePending == false { mutePending = nil }
        case "session.usage.updated":
            if let s = ev.object("usage")?.number("seconds") { liveUsageSeconds = s }
        case "session.closed":
            if let s = ev.object("usage")?.number("seconds") { liveUsageSeconds = s }
            let reason = ev.string("reason")
            if let text = ViewText.closedReasonMessage(reason) {
                if reason == "content" { showBanner(level: "error", text: text, key: "content") }
                else if reason != "expired" { showBanner(level: "info", text: text, key: "closed_\(reason ?? "")") }
            }
        case "error":
            if let text = ViewText.errorBannerText(ev) {
                showBanner(level: "error", text: text, key: ev.object("error")?.string("code") ?? "live_error")
            }
        default: break
        }
    }

    private func applyCommand(_ command: String?, reason: String?) {
        switch command {
        case "disconnect": pausedReason = reason ?? "pause"
        case "close_window": closed = true
        default: break
        }
    }

    /// The eclipse clocks: when Claude started and stopped waiting for you.
    private func noteAttention() {
        let a = attention
        if a && !attentionWas { attentionAt = now(); attentionClearedAt = nil }
        if !a && attentionWas { attentionClearedAt = now() }
        attentionWas = a
    }

    /// A step Claude reports in its own words leaves a star where the bead is (lib.milestoneStars).
    private func noteMilestone(kind: String?, text: String?) {
        let t = now()
        let next = ViewText.milestoneStars(starState, kind: kind, text: text, busy: claudeBusy, now: t.timeIntervalSince1970 * 1000,
                                           workSince: workSince.map { $0.timeIntervalSince1970 * 1000 })
        guard next != starState else { return }
        let born = next.stars.count > starState.stars.count || next.lastAt != starState.lastAt
        starState = next
        milestones = next.stars.map { Milestone(s: $0.s, born: Date(timeIntervalSince1970: $0.born / 1000)) }
        if born { announce("Claude: step done.") }
    }

    /// Claude's page: the latest message and two before it (never a tool label).
    private func pushPage(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        if let last = pageMessages.last, ViewText.stripMarkdown(last) == ViewText.stripMarkdown(t) || ViewText.stripMarkdown(t).hasPrefix(ViewText.stripMarkdown(last)) {
            pageMessages[pageMessages.count - 1] = t
            return
        }
        pageMessages.append(t)
        if pageMessages.count > 3 { pageMessages.removeFirst(pageMessages.count - 3) }
    }

    private func setBusy(_ busy: Bool) {
        if busy && !claudeBusy { workSince = now() }
        if !busy { workSince = nil }
        claudeBusy = busy
    }

    private func addCaption(role: String?, text: String?, start: Double?, end: Double?, session: String?) {
        captionSeq += 1
        if let text, !text.isEmpty { lastCaptionAt = now() }
        captions = ViewText.reduceCaptions(captions, role: role, text: text, startMs: start, endMs: end, session: session, nextId: captionSeq)
    }

    // MARK: - Banners

    public struct Banner: Equatable, Identifiable, Sendable {
        public enum Action: String, Sendable { case switchMic, tryAgain, turnOnAudio }
        public var key: String
        public var level: String      // info | warn | error
        public var text: String
        public var action: Action?
        public var sticky: Bool
        public var shownAt: Date
        public var id: String { key }
    }

    public static let bannerSeconds: TimeInterval = 8

    /// lib/app.js showBanner: one per key, errors first, at most 5.
    public func showBanner(level: String, text: String, key: String? = nil, action: Banner.Action? = nil, sticky: Bool = false) {
        guard !text.isEmpty else { return }
        let k = key ?? text
        banners.removeAll { $0.key == k }
        var act = action
        if act == nil, text.range(of: "try again", options: .caseInsensitive) != nil, phase != "live", phase != "connecting" { act = .tryAgain }
        let b = Banner(key: k, level: level, text: text, action: act, sticky: sticky, shownAt: now())
        if level == "error" { banners.insert(b, at: 0) } else { banners.append(b) }
        if banners.count > 5 { banners.removeLast(banners.count - 5) }
        if level == "error" { announce(text, assertive: true) }
        // Nothing else ever expired these in v0.4.0 (the old view's timeline that called
        // expireBanners was replaced), so one "Switching to Moss." notice covered the
        // caption line for the rest of the session. Each timed banner schedules its own expiry.
        if level != "error" && !sticky && bannerTimers {
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(Self.bannerSeconds + 0.05))
                guard let self else { return }
                self.expireBanners(at: self.now())
            }
        }
    }

    public func dismissBanner(key: String) { banners.removeAll { $0.key == key } }

    /// Timed banners expire on their own (off only for still snapshots with a fixed clock).
    @ObservationIgnored public var bannerTimers = true

    /// Drop non-error, non-sticky banners older than 8 s (scheduled by showBanner).
    public func expireBanners(at t: Date) {
        let stale = banners.contains { $0.level != "error" && !$0.sticky && t.timeIntervalSince($0.shownAt) >= Self.bannerSeconds }
        if stale { banners.removeAll { $0.level != "error" && !$0.sticky && t.timeIntervalSince($0.shownAt) >= Self.bannerSeconds } }
    }

    /// What was said since a timed banner appeared wins the caption line: a notice is a
    /// passing note, the conversation is the point. Errors and sticky notices (can't hear)
    /// keep the line until they clear.
    public func bannerYieldsToCaption(_ b: Banner) -> Bool {
        guard b.level != "error", !b.sticky, b.key != "cmd_error", let at = lastCaptionAt else { return false }
        return at > b.shownAt
    }
    public private(set) var lastCaptionAt: Date?

    /// The top banner (only one shows; the rest count as "+N").
    public var topBanner: Banner? {
        if let e = lastCommandError, banners.first?.level != "error" {
            return Banner(key: "cmd_error", level: "error", text: e.message, action: nil, sticky: false, shownAt: now())
        }
        return banners.first
    }

    // MARK: - Link

    private func linkChanged(_ old: LinkState) {
        if linkState == .connected { everConnected = true; dismissBanner(key: "lost") }
    }

    // MARK: - Levels and floor

    private func levelsChanged(mic: Float? = nil, speaker: Float? = nil) {
        if let mic { rawMic = mic }
        if let speaker { rawSpeaker = speaker }
        let t = now().timeIntervalSince1970 * 1000
        let raw = floorTracker.update(mic: effectiveMuted ? 0 : ViewText.levelFromRms(Double(rawMic)), voice: ViewText.levelFromRms(Double(rawSpeaker)), now: t)
        let shown = wordHold.update(raw, now: t)
        if shown != floor { floor = shown }
    }

    // MARK: - Actions

    public func toggleMute() {
        let want = !effectiveMuted
        mutePending = want
        levelsChanged()
        onUserActivity?()
        Task { [weak self] in
            guard let self else { return }
            let r = await self.run("mute", ["on": .bool(want)])
            if case .failure = r { self.mutePending = nil }
        }
    }

    public func pause() { command("pause") }
    public func resume() {
        micFailure = nil
        pausedReason = nil
        command(status?.state == "sleeping" ? "wake" : "resume")
    }
    public func end() { command("end") }
    public func openInBrowser() { command("open_browser") }

    /// Save a pasted API key. It goes only into `cmd key_save`; the model never stores it.
    public func saveKey(_ key: String) async -> CommandError? {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return CommandError(code: "empty", message: "Paste a key first.") }
        if case .failure(let e) = await run("key_save", ["key": .string(trimmed)]) { return e }
        return nil
    }

    /// Run a card or banner action.
    public func perform(_ action: String?) {
        switch action {
        case "resume": resume()
        case "reload": resume()
        default: break
        }
    }

    public func perform(_ action: Banner.Action, banner key: String) {
        switch action {
        case .switchMic: openMicSwitcher?()
        case .tryAgain: dismissBanner(key: key); resume()
        case .turnOnAudio: dismissBanner(key: key)
        }
    }

    /// M / Space in the panel (lib.hotkeyAction). Returns true when handled.
    @discardableResult
    public func handleKey(_ key: String, repeat_: Bool = false, modifiers: Bool = false, inTextField: Bool = false, onButton: Bool = false) -> Bool {
        let tag = inTextField ? "INPUT" : onButton ? "BUTTON" : ""
        guard let a = ViewText.hotkeyAction(key: key, repeat_: repeat_, modifiers: modifiers, targetTag: tag,
                                            live: isLive, paused: isPaused, sleeping: isSleeping) else { return false }
        switch a {
        case .mute:
            if isSleeping { wakeMuted.toggle() } else { toggleMute() }
        case .resume: resume()
        }
        return true
    }

    private func command(_ name: String, _ args: [String: JSONValue] = [:]) {
        onUserActivity?()
        Task { [weak self] in _ = await self?.run(name, args) }
    }

    @discardableResult
    private func run(_ name: String, _ args: [String: JSONValue]) async -> Result<JSONValue, CommandError> {
        guard let send = sendCommand else { return .failure(CommandError(code: "no_link", message: "sotto: not connected to the daemon.")) }
        let r = await send(name, args)
        switch r {
        case .success: lastCommandError = nil
        case .failure(let e): lastCommandError = e
        }
        return r
    }

    public func clearCommandError() { lastCommandError = nil }

    // MARK: - Announcements

    private func announce(_ text: String, assertive: Bool = false) {
        announceSeq += 1
        announcement = (text, assertive, announceSeq)
    }

    private func announceState(_ state: String) {
        if let a = ViewText.cardAnnouncement(pageView.card) { announce(a.text, assertive: a.assertive) }
        else if state == "live" { announce("Live. Listening.") }
    }

    private func nonEmpty(_ s: String?) -> String? { (s?.isEmpty ?? true) ? nil : s }

    // MARK: - Test and preview support

    /// Reset the transient UI (captions, card, banners); used between canned snapshot states.
    public func resetForPreview() {
        captions = []; delegations = []; claudeBusy = false; claudeKind = nil; claudeAgent = false; claudeText = ""; claudeSays = ""
        claudeSaysAt = nil; claudeTool = ""; summary = nil; agents = 0; workSince = nil; banners = []; pendingResult = nil
        floor = nil; wordHold = WordHold(); floorTracker = FloorTracker(); usageShown = nil; todayShown = nil
        attentionAt = nil; attentionClearedAt = nil; finishedAt = nil; wokeAt = nil; personaSwitch = nil; milestones = []
        starState = ViewText.Stars(); pageMessages = []; attentionWas = false
    }

    /// Canned event clocks for snapshots (a still frame at any instant of a transition).
    public func setEventsForPreview(attentionAt: Date? = nil, clearedAt: Date? = nil, finishedAt: Date? = nil, wokeAt: Date? = nil,
                                    personaSwitch: (from: String, to: String, at: Date)? = nil, milestones: [Milestone]? = nil) {
        if let a = attentionAt { self.attentionAt = a }
        if let c = clearedAt { attentionClearedAt = c }
        if let f = finishedAt { self.finishedAt = f }
        if let w = wokeAt { self.wokeAt = w }
        if let p = personaSwitch { self.personaSwitch = p }
        if let m = milestones { self.milestones = m }
    }

    /// Move the work clock (snapshots: a turn that started minutes ago).
    public func setWorkSinceForPreview(_ d: Date) { workSince = d }

    /// Force the shown floor (previews/snapshots, where the 1.3 s hold would never elapse).
    public func setFloorForPreview(_ f: String?) { floor = f }
}

public struct CommandError: Error, Equatable, Sendable {
    public var code: String; public var message: String
    public init(code: String, message: String) { self.code = code; self.message = message }
}

/// lib.createWordHold: a new floor shows only once it has held for 1.3 s.
struct WordHold {
    var holdMs: Double = 1300
    private var shown: String??
    private var cand: String?
    private var since: Double = 0
    mutating func update(_ floor: String?, now: Double) -> String? {
        guard let s = shown else { shown = .some(floor); cand = floor; return floor }
        if floor == s { cand = floor; return s }
        if floor != cand { cand = floor; since = now }
        if now - since >= holdMs { shown = .some(cand) }
        return shown!
    }
}

/// lib.createFloorTracker: who has the floor, with hysteresis in level and time.
struct FloorTracker {
    struct Channel { var active = false; var since: Double? }
    var onLevel = 0.36, offLevel = 0.2, attackMs = 90.0, releaseMs = 500.0
    private var you = Channel(), voice = Channel()
    private func step(_ c: inout Channel, _ level: Double, _ now: Double) {
        if !c.active {
            if level > onLevel {
                if c.since == nil { c.since = now }
                if now - c.since! >= attackMs { c.active = true; c.since = nil }
            } else { c.since = nil }
        } else if level < offLevel {
            if c.since == nil { c.since = now }
            if now - c.since! >= releaseMs { c.active = false; c.since = nil }
        } else { c.since = nil }
    }
    mutating func update(mic: Double, voice v: Double, now: Double) -> String? {
        step(&you, mic, now)
        step(&voice, v, now)
        if voice.active && you.active { return mic > v + 0.08 ? "you" : "voice" }
        if voice.active { return "voice" }
        if you.active { return "you" }
        return nil
    }
}
