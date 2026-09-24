// ViewText: the page's pure view models (web/lib.js, web/wake.js sleepView) ported to
// Swift for the native app (docs/NATIVE.md §5.4). Every string and branch here mirrors
// lib.js; test/fixtures/native/viewtext.json is generated from lib.js by
// test/web/native-viewtext.test.js and checked against this file by ViewTextTests, so a
// change on either side fails a test until the other follows.
import Foundation
import SottoClient

public enum ViewText {
    public static let captionGapMs: Double = 1500
    public static let maxCaptionLines = 60
    public static let pricePerMinute: Double = 0.05
    /// The hero word while Claude Code waits for an approval (AUDIT #5).
    public static let approvalWord = "Approve in the terminal"

    // MARK: - Labels and numbers

    static let statusLabels: [String: String] = [
        "off": "Off", "waiting_page": "Opening", "connecting": "Connecting", "live": "Live",
        "paused": "Paused", "sleeping": "Sleeping", "reconnecting": "Reconnecting", "closing": "Closing",
    ]

    /// Human label for a daemon state. Unknown states are title-cased, never blank.
    public static func statusLabel(_ state: String?) -> String {
        guard let state, !state.isEmpty else { return "Unknown" }
        if let l = statusLabels[state] { return l }
        let words = replace(state, "[_-]+", " ").trimmingCharacters(in: .whitespaces)
        guard let first = words.first else { return "Unknown" }
        return first.uppercased() + words.dropFirst()
    }

    private static func money(_ x: Double) -> String {
        let v = (((x + Double.ulpOfOne) * 100 + 1e-7).rounded(.toNearestOrAwayFromZero)) / 100
        return String(format: "%.2f", v)
    }

    private static func plural(_ n: Int, _ one: String) -> String { "\(n) \(n == 1 ? one : one + "s")" }

    /// "0 min", "under a minute", "14 min", "1 hr 5 min"; long: "5 minutes", "1 hour 5 minutes".
    public static func formatDuration(_ seconds: Double?, long: Bool = false) -> String {
        let s = (seconds.map { $0.isFinite && $0 > 0 ? $0 : 0 }) ?? 0
        if s == 0 { return long ? "0 minutes" : "0 min" }
        if s < 60 { return "under a minute" }
        let total = Int((s / 60 + 1e-9).rounded(.down))
        let h = total / 60, m = total % 60
        let mins = long ? plural(m, "minute") : "\(m) min"
        if h == 0 { return mins }
        let hrs = long ? plural(h, "hour") : "\(h) hr"
        return m == 0 ? hrs : "\(hrs) \(mins)"
    }

    /// "$0.71"; a non-zero amount under half a cent reads "<$0.01".
    public static func formatMoney(_ dollars: Double?) -> String {
        let d = (dollars.map { $0.isFinite && $0 > 0 ? $0 : 0 }) ?? 0
        if d > 0 && d < 0.005 { return "<$0.01" }
        return "$" + money(d)
    }

    public static func formatCost(_ seconds: Double?) -> String {
        let s = (seconds.map { $0.isFinite && $0 > 0 ? $0 : 0 }) ?? 0
        return formatMoney(s / 60 * pricePerMinute)
    }

    /// "14 min · $0.71".
    public static func formatUsage(_ seconds: Double?) -> String { "\(formatDuration(seconds)) · \(formatCost(seconds))" }

    /// "0:05", "14:02", "1:05:09".
    public static func formatClock(_ seconds: Double?) -> String {
        let s = seconds ?? 0
        let t = Int((s.isFinite && s > 0 ? s + 1e-9 : 0).rounded(.down))
        let h = t / 3600, m = (t % 3600) / 60, sec = t % 60
        let ss = String(format: "%02d", sec)
        return h > 0 ? "\(h):\(String(format: "%02d", m)):\(ss)" : "\(m):\(ss)"
    }

    /// One header pill's figure (lib.usagePills): the text, and whether its fixed box
    /// needs its one wider size (a clock from the hour on, the cost from $100).
    public struct Pill: Equatable, Sendable {
        public var text: String
        public var wide: Bool
        public init(text: String, wide: Bool) { self.text = text; self.wide = wide }
    }

    public struct UsagePills: Equatable, Sendable {
        /// nil when not live (the Session pill is hidden).
        public var session: Pill?
        public var today: Pill
        public var cost: Pill
        public init(session: Pill?, today: Pill, cost: Pill) { self.session = session; self.today = today; self.cost = cost }
    }

    /// lib.usagePills: Session (only while live), Today and Cost (SPEC-DEVIATIONS "header pills").
    public static func usagePills(sessionSeconds: Double?, todaySeconds: Double, costSeconds: Double) -> UsagePills {
        func clock(_ s: Double) -> Pill { let t = formatClock(s); return Pill(text: t, wide: t.count > 5) }
        let cost = formatCost(costSeconds)
        return UsagePills(session: sessionSeconds.map(clock), today: clock(todaySeconds), cost: Pill(text: cost, wide: cost.count > 6))
    }

    /// A throttled usage reading (lib.stableUsage): seconds and when it was taken (ms).
    public struct UsageReading: Equatable, Sendable {
        public var seconds: Double
        public var at: Double
        public init(seconds: Double, at: Double) { self.seconds = seconds; self.at = at }
    }

    /// lib.stableUsage: a new reading when the whole minute changes, the day rolls over, or every `everyMs`.
    public static func stableUsage(_ prev: UsageReading?, seconds: Double?, now: Double, everyMs: Double = 10_000) -> UsageReading {
        let s = (seconds.map { $0.isFinite && $0 > 0 ? $0 : 0 }) ?? 0
        guard let prev else { return UsageReading(seconds: s, at: now) }
        if s == prev.seconds { return prev }
        let minuteChanged = (s / 60).rounded(.down) != (prev.seconds / 60).rounded(.down)
        if minuteChanged || s < prev.seconds || now - prev.at >= everyMs { return UsageReading(seconds: s, at: now) }
        return prev
    }

    /// lib.tickingToday: the reading advanced by wall time while live (at most `maxAheadS`), never backwards within a day.
    public static func tickingToday(_ reading: UsageReading?, now: Double, live: Bool, shown: Double?, maxAheadS: Double = 15) -> Double {
        guard let reading else { return 0 }
        let ahead = live ? min(maxAheadS, max(0, (now - reading.at) / 1000)) : 0
        let v = reading.seconds + ahead
        if let shown, v < shown, shown - v < 60 { return shown }
        return v
    }

    /// Settings > Appearance (lib.THEMES / normalizeTheme): "system" (default), "light", "dark".
    public static let themes = ["system", "light", "dark"]
    public static func normalizeTheme(_ v: String?) -> String {
        let s = (v ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return themes.contains(s) ? s : "system"
    }

    /// Claude's working time: "42 sec", "3 min 12 sec", "1 hr 2 min".
    public static func formatElapsed(_ ms: Double?) -> String {
        let t = max(0, Int(((ms ?? 0).isFinite ? (ms ?? 0) : 0) / 1000))
        if t < 60 { return "\(t) sec" }
        if t < 3600 { return "\(t / 60) min \(t % 60) sec" }
        return formatDuration(Double(t))
    }

    /// Shorten to `n` UTF-16 units on a word boundary where possible, with an ellipsis.
    public static func truncate(_ text: String?, _ n: Int = 160) -> String {
        let s = replace(text ?? "", "\\s+", " ").trimmingCharacters(in: .whitespacesAndNewlines) as NSString
        if s.length <= n { return s as String }
        let cut = s.substring(to: n - 1) as NSString
        let sp = cut.range(of: " ", options: .backwards).location
        let base = (sp != NSNotFound && Double(sp) > Double(n) * 0.6) ? cut.substring(to: sp) : cut as String
        return replace(base, "[\\s,;:.]+$", "") + "…"
    }

    // MARK: - Captions and delegations

    public struct Caption: Equatable, Sendable, Identifiable {
        public var id: Int
        public var role: String
        public var text: String
        public var startMs: Double
        public var endMs: Double
        public var session: String?
        public init(id: Int = 0, role: String, text: String, startMs: Double, endMs: Double, session: String?) {
            self.id = id; self.role = role; self.text = text; self.startMs = startMs; self.endMs = endMs; self.session = session
        }
    }

    /// lib.reduceCaptions: same role + same session + gap <= 1500 ms joins the last line.
    public static func reduceCaptions(_ lines: [Caption], role rawRole: String?, text: String?, startMs: Double?, endMs: Double?,
                                      session: String?, max: Int = maxCaptionLines, nextId: Int = 0) -> [Caption] {
        guard let text, !text.isEmpty else { return lines }
        let role = rawRole == "assistant" ? "assistant" : "user"
        let start = (startMs?.isFinite == true ? startMs! : 0)
        let end = (endMs?.isFinite == true ? endMs! : start)
        var next = lines
        if let last = lines.last, last.role == role, last.session == session, start - last.endMs <= captionGapMs {
            var merged = last
            merged.text += text
            merged.endMs = Swift.max(last.endMs, end)
            next[next.count - 1] = merged
        } else {
            next.append(Caption(id: nextId, role: role, text: replace(text, "^\\s+", ""), startMs: start, endMs: end, session: session))
        }
        return next.count > max ? Array(next.suffix(max)) : next
    }

    public static func speakerLabel(_ role: String) -> String { role == "assistant" ? "Sotto" : "You" }

    public struct Delegation: Equatable, Sendable, Identifiable {
        public var id: String; public var status: String; public var text: String
        public init(id: String, status: String, text: String) { self.id = id; self.status = status; self.text = text }
    }

    static let delegationLabels: [String: (String, String)] = [
        "collecting": ("Listening", "active"), "sent": ("Sent to Claude", "active"), "delivered": ("Claude is on it", "active"),
        "held_suspected": ("Not picked up yet", "warn"), "answered": ("Answered", "done"),
        "answered_stale": ("Answered (earlier request)", "done"), "superseded": ("Replaced by a newer request", "muted"),
        "dropped_echo": ("Ignored (echo)", "muted"), "dropped_empty": ("Didn't catch that", "muted"),
        "mirrored": ("Already with Claude", "active"), "failed": ("Couldn't reach Claude", "error"), "orphaned": ("Dropped", "muted"),
    ]

    /// (label, tone); tone is active|warn|done|muted|error.
    public static func delegationLabel(_ status: String?) -> (label: String, tone: String) {
        if let s = status, let hit = delegationLabels[s] { return (hit.0, hit.1) }
        return (statusLabel(status), "muted")
    }

    /// Newest `max` delegations, updated in place by id (newest first).
    public static func upsertDelegation(_ list: [Delegation], id: String?, status: String?, text: String?, max: Int = 3) -> [Delegation] {
        guard let id, !id.isEmpty else { return list }
        let old = list.first { $0.id == id }
        let t = (text?.isEmpty == false ? text : nil) ?? (old?.text.isEmpty == false ? old?.text : nil) ?? ""
        let merged = Delegation(id: id, status: status ?? old?.status ?? "collecting", text: t)
        return Array(([merged] + list.filter { $0.id != id }).prefix(max))
    }

    // MARK: - Messages

    /// Text for a Live `session.closed` reason, or nil when nothing needs saying.
    public static func closedReasonMessage(_ reason: String?) -> String? {
        switch reason {
        case "close_requested": return nil
        case "content": return "The voice session was ended by a safety filter."
        case "expired": return "The voice session reached its time limit."
        case "remote_hangup": return "The voice service hung up."
        case "connection_lost": return "The voice connection was lost."
        default:
            if let r = reason, !r.isEmpty { return "The voice session ended (\(r))." }
            return "The voice session ended."
        }
    }

    /// Headline for the paused card. `idleSeconds` wins over `idleMinutes`.
    public static func pausedMessage(_ reason: String?, idleMinutes: Double?, idleSeconds: Double?) -> String {
        if reason == "idle" {
            if let s = idleSeconds, s.isFinite, s > 0, s < 120, Int(s.rounded()) % 60 != 0 {
                return "Paused after \(Int(s.rounded())) seconds of silence"
            }
            var min = 0
            if let s = idleSeconds, s.isFinite, s > 0 { min = Int((s / 60).rounded()) }
            else if let m = idleMinutes, m > 0 { min = Int(m.rounded()) }
            return min > 0 ? "Paused after \(formatDuration(Double(min * 60), long: true)) of silence" : "Paused after a stretch of silence"
        }
        if reason == "daily_cap" { return "Paused: today's voice limit is reached" }
        if reason == nil || reason == "" || reason == "user" || reason == "pause" { return "Paused" }
        if reason == "error" { return "Voice stopped" }
        return "Paused (\(reason!.replacingOccurrences(of: "_", with: " ")))"
    }

    /// Banner text for a Live `error` event, or nil (errors tied to a client event are logged only).
    public static func errorBannerText(_ ev: [String: JSONValueLike]) -> String? {
        guard ev.string("type") == "error" else { return nil }
        let inner = ev.object("error")
        if ev.string("client_event_id") != nil || inner?.string("client_event_id") != nil { return nil }
        return nonEmpty(inner?.string("message")) ?? nonEmpty(ev.string("message")) ?? "The voice service reported an error."
    }

    // MARK: - Activity and the Claude card

    public struct ActivityLine: Equatable, Sendable {
        public var text: String; public var busy: Bool?; public var summary: String?; public var tone: String
    }

    /// lib.activityView: an SSE `activity` message to the activity line.
    public static func activityView(kind: String?, text rawText: String?, summary rawSummary: String?) -> ActivityLine {
        let text = truncate(rawText ?? "", 180)
        switch kind {
        case "turn_start": return .init(text: text.isEmpty ? "Claude is working" : "Claude is working: \(text)", busy: true, summary: nil, tone: "work")
        case "tool": return .init(text: text.isEmpty ? "Claude is working" : "Claude: \(text)", busy: true, summary: nil, tone: "work")
        case "text": return .init(text: text.isEmpty ? "Claude is writing" : "Claude: \(text)", busy: true, summary: nil, tone: "work")
        case "permission":
            return .init(text: text.isEmpty ? "Waiting for your approval in the terminal" : "Waiting for your approval in the terminal: \(text)",
                         busy: true, summary: nil, tone: "attention")
        case "turn_end":
            var summary: String?
            if let s = rawSummary, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { summary = prefixUTF16(s, 4000) }
            else if let t = rawText, !t.isEmpty { summary = truncate(t, 420) }
            return .init(text: "Claude finished", busy: false, summary: summary, tone: "done")
        case "agents": return .init(text: "", busy: nil, summary: nil, tone: "info")
        default: return .init(text: text, busy: nil, summary: nil, tone: "info")
        }
    }

    public struct ClaudeInput: Equatable, Sendable {
        public var busy: Bool?
        public var kind: String?
        public var text: String?
        public var says: String?
        public var saysAt: Double?
        public var now: Double?
        public var tool: String?
        public var summary: String?
        public var request: Delegation?
        public var agents: Int?
        public init(busy: Bool? = nil, kind: String? = nil, text: String? = nil, says: String? = nil, saysAt: Double? = nil, now: Double? = nil,
                    tool: String? = nil, summary: String? = nil, request: Delegation? = nil, agents: Int? = nil) {
            self.busy = busy; self.kind = kind; self.text = text; self.says = says; self.saysAt = saysAt; self.now = now
            self.tool = tool; self.summary = summary; self.request = request; self.agents = agents
        }
    }

    public struct ClaudeRequest: Equatable, Sendable { public var text: String; public var label: String; public var tone: String }

    public struct ClaudeCard: Equatable, Sendable {
        public var kind: String          // idle | working | approval | finished
        public var title: String
        public var step: String?
        public var secondary: Bool?
        public var command: String?
        public var note: String?
        public var summary: String?
        public var request: ClaudeRequest?
        public var agents: String?
    }

    /// lib.claudeView.
    public static func claudeView(_ s: ClaudeInput) -> ClaudeCard {
        let text = (s.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var request: ClaudeRequest?
        if let r = s.request, !r.text.isEmpty {
            let l = delegationLabel(r.status)
            request = ClaudeRequest(text: truncate(r.text, 140), label: l.label, tone: l.tone)
        }
        var agents: String?
        if let n = s.agents, n > 0 { agents = n == 1 ? "1 background agent working" : "\(n) background agents working" }
        if s.kind == "permission" && s.busy != false {
            return ClaudeCard(kind: "approval", title: "Claude needs your approval", command: text.isEmpty ? nil : text,
                              note: "Waiting for your approval in the terminal", request: request, agents: agents)
        }
        if s.busy == true {
            // Claude's own latest words, however old; never a tool label (lib.claudeView).
            let says = stripMarkdown(s.says ?? "")
            let step = says.isEmpty ? "Thinking" : says
            return ClaudeCard(kind: "working", title: "Claude is working", step: truncate(step, 180), secondary: false, request: request, agents: agents)
        }
        if let sum = s.summary, !sum.isEmpty { return ClaudeCard(kind: "finished", title: "Claude finished", summary: sum, request: request, agents: agents) }
        return ClaudeCard(kind: "idle", title: "Claude is idle", request: request, agents: agents)
    }

    /// Markdown to plain one-line text (lib.stripMarkdown).
    public static func stripMarkdown(_ md: String?) -> String {
        var t = replace(md ?? "", "\\r\\n?", "\n")
        t = replace(t, "^[ \\t]*(```|~~~)[^\\n]*\\n[\\s\\S]*?(?:^[ \\t]*\\1[ \\t]*$|(?![\\s\\S]))", " ", multiline: true)
        t = replace(t, "`([^`\\n]+)`", "$1")
        t = replace(t, "!?\\[([^\\]\\n]*)\\]\\([^)\\s]*\\)", "$1")
        t = replace(t, "(\\*\\*|__)(?=\\S)([^\\n]*?\\S)\\1", "$2")
        t = replace(t, "(^|[^\\w*])\\*(?=\\S)([^*\\n]*?\\S)\\*(?!\\w)", "$1$2")
        t = replace(t, "(^|[^\\w])_(?=\\S)([^_\\n]*?\\S)_(?!\\w)", "$1$2")
        t = replace(t, "~~(?=\\S)([^\\n]*?\\S)~~", "$1")
        t = replace(t, "^\\s{0,3}#{1,6}\\s+", "", multiline: true)
        t = replace(t, "^\\s*>\\s?", "", multiline: true)
        t = replace(t, "^\\s*(?:[-*+•]|\\d{1,3}[.)])\\s+", "", multiline: true)
        return replace(t, "\\s+", " ").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Key

    public struct KeyCard: Equatable, Sendable { public var title: String; public var body: String; public var keyInput: Bool }

    /// lib.keyCardView: the API key card, or nil.
    public static func keyCardView(_ s: PageInput) -> KeyCard? {
        let phase = s.phase
        if ["live", "connecting", "boot", "replaced", "closed", "lost"].contains(phase) { return nil }
        let st = s.state
        let key = s.key
        let lastCode = s.lastErrorCode
        let missing = s.errorCode == "no_api_key" || (lastCode == "no_api_key" && st != "off")
        let rejected = (key?.can_change ?? false) && (s.errorCode == "openai_auth" || (lastCode == "openai_auth" && st != "off"))
        if !(key?.setup ?? false) && !missing && !rejected { return nil }
        let where_ = (key?.source == "dotenv" && nonEmpty(key?.file) != nil) ? key?.file : key?.label
        let hint = nonEmpty(key?.hint) ?? "????"
        if let key, key.present == true, !(key.can_change ?? false), !rejected, !missing {
            return KeyCard(title: "Your OpenAI API key is set outside Sotto",
                           body: "The key in use (ending in \(hint)) comes from \(where_ ?? "undefined"). Change it there, then run /talk on again.", keyInput: false)
        }
        if let key, key.keychain == false {
            return KeyCard(title: "Add your OpenAI API key to start",
                           body: "Export OPENAI_API_KEY before starting Claude Code, or add it to the plugin's .env file, then run /talk on again.", keyInput: false)
        }
        let intro = "Sotto talks through OpenAI's gpt-live-1 voice model, billed to your OpenAI account at about $0.05 a minute. Paste a key from platform.openai.com/api-keys."
        let keep = "Sotto checks it with OpenAI, then keeps it in your macOS Keychain. It is never shown again."
        if rejected { return KeyCard(title: "OpenAI rejected your API key", body: "The key ending in \(hint) no longer works. Paste a new one. \(keep)", keyInput: true) }
        if key?.present == true {
            return KeyCard(title: "Replace your OpenAI API key",
                           body: "Sotto uses the key ending in \(hint), from \(where_ ?? "undefined"). Paste a new one to replace it. \(keep)", keyInput: true)
        }
        return KeyCard(title: "Add your OpenAI API key to start", body: "\(intro) \(keep)", keyInput: true)
    }

    public struct KeySettings: Equatable, Sendable {
        public var text: String; public var help: String; public var change: Bool; public var remove: Bool; public var changeLabel: String
    }

    /// lib.keySettingsView: the settings row for the API key.
    public static func keySettingsView(_ key: PageStatus.Key?) -> KeySettings {
        guard let key else { return KeySettings(text: "Checking…", help: "", change: false, remove: false, changeLabel: "Change") }
        let where_ = (key.source == "dotenv" && nonEmpty(key.file) != nil ? key.file : key.label) ?? "undefined"
        if key.present != true {
            return KeySettings(text: "No key yet",
                               help: key.keychain == true ? "Add one to start talking. It is checked with OpenAI and kept in your macOS Keychain."
                                   : "Export OPENAI_API_KEY before starting Claude Code, or add it to the plugin's .env file.",
                               change: key.can_change ?? false, remove: false, changeLabel: "Add key")
        }
        let help = key.source == "keychain" ? "Saved in your macOS Keychain."
            : (key.can_change ?? false) ? "From \(where_). A key saved here replaces it." : "From \(where_). Change it there."
        return KeySettings(text: "Key ending in \(nonEmpty(key.hint) ?? "????")", help: help, change: key.can_change ?? false, remove: key.can_remove ?? false, changeLabel: "Change")
    }

    // MARK: - Microphone and sleep

    public struct MicFailure: Equatable, Sendable {
        public var title: String; public var body: String; public var steps: [String]?; public var button: String?; public var header: String
        public var link: Link? = nil
    }
    /// lib.js MIC_SETTINGS_URL: System Settings > Privacy & Security > Microphone.
    public static let micSettingsURL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
    public struct Link: Equatable, Sendable { public var href: String; public var label: String }

    /// Mic failure copy inside the app (lib.micFailureView with host "app").
    public static func micFailureView(_ kind: String) -> MicFailure {
        switch kind {
        case "macos":
            return .init(title: "Sotto can't use the microphone", body: "Allow it in System Settings > Privacy & Security > Microphone. Voice is paused and not billing.",
                         steps: ["Click Open System Settings (or open System Settings, then Privacy & Security, then Microphone).", "Turn on Sotto.", "Quit Sotto from its menu-bar icon, then run /talk on."],
                         button: "Try again", header: "Mic blocked", link: Link(href: micSettingsURL, label: "Open System Settings"))
        case "unsupported":
            return .init(title: "This window can't use the microphone", body: "Run /talk on again, or set window to chrome in /config (sotto).", steps: nil, button: nil, header: "Mic error")
        case "dismissed":
            return .init(title: "The microphone prompt closed", body: "Chrome asked for the microphone, but the prompt closed before you chose. Ask again, then click Allow.",
                         steps: nil, button: "Ask again", header: "Allow mic")
        case "chrome":
            return .init(title: "Chrome is blocking the microphone", body: "This window is not allowed to use the microphone. Voice is paused and not billing.",
                         steps: ["Open this window's menu (the three dots at the top right) and choose Site settings.", "Set Microphone to Allow.", "Come back here and click Try again."],
                         button: "Try again", header: "Mic blocked")
        case "notfound":
            return .init(title: "No microphone found", body: "Connect a microphone or headset, then try again.", steps: nil, button: "Try again", header: "No mic")
        case "busy":
            return .init(title: "The microphone is busy", body: "Another app may be using it. Close apps that use the microphone, then try again.", steps: nil, button: "Try again", header: "Mic busy")
        default:
            return .init(title: "The microphone could not be opened", body: "Check that a microphone is connected, then try again.", steps: nil, button: "Try again", header: "Mic error")
        }
    }

    public struct MicPrompt: Equatable, Sendable { public var title: String; public var body: String; public var note: String; public var arrow: Bool }

    public static func micPromptView(host: String = "app") -> MicPrompt {
        if host == "app" {
            return .init(title: "Allow microphone access",
                         body: "macOS is asking whether Sotto can use the microphone. Click Allow so Sotto can hear you. Voice starts once the mic is on.",
                         note: "Don't see it? It may be behind this panel, or check System Settings, then Privacy & Security, then Microphone.", arrow: false)
        }
        return .init(title: "Allow microphone access",
                     body: "Chrome is asking at the top left of this window: click Allow so Sotto can hear you. Voice starts once the mic is on.",
                     note: "Don't see it? The prompt closes if you click elsewhere; you can ask again.", arrow: true)
    }

    public struct SleepText: Equatable, Sendable { public var title: String; public var body: String; public var listening: Bool }

    /// web/wake.js sleepView.
    public static func sleepView(muted: Bool = false, enabled: Bool = true, cooldownMs: Double = 0, micError: String? = nil) -> SleepText {
        if !enabled { return .init(title: "Sleeping", body: "Voice wake is off. Press Space or Wake now to continue.", listening: false) }
        if let e = micError { return .init(title: "Sleeping", body: "The microphone is unavailable (\(e)). Press Space to resume.", listening: false) }
        if muted { return .init(title: "Sleeping (muted)", body: "Not listening for your voice. Press M to listen again, or Space to resume.", listening: false) }
        if cooldownMs > 0 {
            let s = Int((cooldownMs / 1000).rounded(.up))
            return .init(title: "Sleeping", body: "Heard only noise a few times, so listening again in \(s) s. Press Space to resume now.", listening: false)
        }
        return .init(title: "Sleeping — just start talking", body: "Voice wakes up when you speak. Nothing is sent or billed until then.", listening: true)
    }

    // MARK: - Hotkeys

    public enum HotkeyAction: String, Sendable { case mute, resume }

    /// lib.hotkeyAction: M toggles mute while live or sleeping; Space resumes while paused, toggles mute while live.
    public static func hotkeyAction(key: String, repeat_: Bool = false, modifiers: Bool = false, targetTag: String = "",
                                    live: Bool, paused: Bool, sleeping: Bool) -> HotkeyAction? {
        if repeat_ || modifiers { return nil }
        let tag = targetTag.uppercased()
        if ["SELECT", "INPUT", "TEXTAREA"].contains(tag) { return nil }
        if key == " " {
            if ["BUTTON", "SUMMARY", "A"].contains(tag) { return nil }
            if paused { return .resume }
            if live { return .mute }
            return nil
        }
        if (key == "m" || key == "M") && (live || sleeping) { return .mute }
        return nil
    }

    // MARK: - pageView

    public struct Step: Equatable, Sendable { public var key: String; public var label: String; public var state: String }

    /// The connect checklist.
    public static func connectSteps(_ stage: String?) -> [Step] {
        let order = ["mic", "network", "session"]
        let labels = ["mic": "Microphone on", "network": "Reaching the voice service", "session": "Starting the session"]
        let at = stage.flatMap { order.firstIndex(of: $0) } ?? -1
        return order.enumerated().map { i, k in
            Step(key: k, label: labels[k]!, state: at < 0 ? "pending" : i < at ? "done" : i == at ? "active" : "pending")
        }
    }

    public struct PageInput: Equatable, Sendable {
        public var phase: String = "boot"
        public var state: String = "off"
        public var sseDown = false
        public var unauthorized = false
        public var muted = false
        public var floor: String?
        public var connectStage: String?
        public var connectReason: String?
        public var micPrompt = false
        public var micFailure: String?
        public var errorText: String?
        public var errorCode: String?
        public var key: PageStatus.Key?
        public var pausedReason: String?
        public var idleMinutes: Double?
        public var idleSeconds: Double?
        public var capMinutes: Double?
        public var pendingResult: String?
        public var lastErrorCode: String?
        public var lastErrorMessage: String?
        public var attention = false
        public var sleep: SleepText?
        public var host = "app"
        public init() {}
    }

    public struct Card: Equatable, Sendable {
        public var kind: String
        public var title: String
        public var body: String
        public var pending: String?
        public var button: String?
        public var action: String?
        public var kbd = false
        public var steps: [String]?
        public var arrow = false
        public var keyInput = false
        public var tone = "neutral"
        public var secondary = false
        public var note: String?
        public var listening: Bool?
        public var link: Link?
    }

    public struct Header: Equatable, Sendable { public var key: String; public var label: String; public var detail: String? }

    public struct PageView: Equatable, Sendable {
        public var view = "card"          // live | card
        public var dial = "small"         // full | small | hidden
        public var floor = "off"
        public var word = ""
        public var sub: String?
        public var wordTone: String?
        public var dialHint: String?
        public var steps: [Step]?
        public var card: Card?
        public var header: Header
    }

    static let stageWords: [String: (String, String?)] = [
        "starting": ("Starting", "Looking for sotto…"),
        "connecting": ("Connecting", "Connecting to the voice service…"),
        "reconnecting": ("Reconnecting…", "Your mute setting is kept."),
        "listening": ("Listening", nil), "you": ("Hearing you", nil), "voice": ("Speaking", nil),
        "muted": ("Muted", "Sotto can't hear you. Still billing."),
        "paused": ("Paused", nil), "sleeping": ("Sleeping", "Speak to wake it"),
        "off": ("Voice is off", nil), "error": ("Stopped", nil),
    ]

    /// Everything the panel shows for one snapshot (lib.pageView).
    public static func pageView(_ s: PageInput) -> PageView {
        let st = s.state
        let phase = s.phase
        let lastCode = s.lastErrorCode
        var out = PageView(header: Header(key: "off", label: statusLabel(st), detail: nil))
        func card(_ c: Card, _ floor: String, _ header: Header, _ dial: String = "small") -> PageView {
            out.card = c; out.floor = floor; out.header = header; out.dial = dial
            let w = stageWords[floor] ?? ("", nil)
            out.word = w.0; out.sub = w.1
            return out
        }
        if s.unauthorized && phase != "live" && phase != "connecting" {
            return card(Card(kind: "unauthorized", title: "This window is not connected", body: "Open the voice window from Claude Code with /talk on."),
                        "off", Header(key: "off", label: "Not connected"), "hidden")
        }
        if phase == "replaced" {
            return card(Card(kind: "replaced", title: "Voice moved to another window", body: "Another sotto window took over. This one is inactive.", button: "Use this window", action: "reload"),
                        "off", Header(key: "off", label: "Inactive"))
        }
        if phase == "boot" { return card(Card(kind: "starting", title: "Starting sotto", body: "Looking for the voice daemon…"), "starting", Header(key: "connecting", label: "Starting")) }
        if phase == "lost" {
            return card(Card(kind: "lost", title: "Lost contact with the sotto daemon", body: "The voice session was closed to stop billing. Waiting for the daemon to come back…", tone: "warn"),
                        "off", Header(key: "error", label: "Disconnected"))
        }
        if phase == "closed" {
            return card(Card(kind: "closed", title: "Voice is off", body: "It's safe to close this window; start again from Claude Code with /talk on."), "off", Header(key: "off", label: "Off"))
        }
        if s.micPrompt && phase == "connecting" {
            let v = micPromptView(host: s.host)
            out = card(Card(kind: "permission", title: v.title, body: v.body, arrow: v.arrow, tone: "attn", note: v.note), "off", Header(key: "attention", label: "Allow mic"))
            out.dialHint = v.arrow ? "prompt" : "attn"
            return out
        }
        if let kc = keyCardView(s) {
            return card(Card(kind: "apikey", title: kc.title, body: kc.body, keyInput: kc.keyInput, tone: "attn"), "off", Header(key: "attention", label: "Key needed"))
        }
        if phase == "error" {
            if let mf = s.micFailure {
                let v = s.host == "app" ? micFailureView(mf) : micFailureView(mf)
                return card(Card(kind: "mic-\(mf)", title: v.title, body: v.body, button: st == "off" ? nil : v.button, action: "resume",
                                 kbd: st != "off" && v.button != nil, steps: v.steps, tone: "err", link: v.link),
                            "error", Header(key: "error", label: v.header))
            }
            return card(Card(kind: "error", title: "Voice could not start", body: nonEmpty(s.errorText) ?? "Something went wrong.",
                             button: st == "off" ? nil : "Try again", action: "resume", kbd: st != "off", tone: "err"),
                        "error", Header(key: "error", label: "Error"))
        }
        if phase == "live" || phase == "connecting" {
            out.view = "live"; out.dial = "full"
            let reconnecting = st == "reconnecting" || (phase == "connecting" && s.connectReason == "reconnect")
            if phase == "connecting" {
                out.floor = reconnecting ? "reconnecting" : "connecting"
                out.steps = reconnecting ? nil : connectSteps(s.connectStage ?? "mic")
                out.header = Header(key: "connecting", label: reconnecting ? "Reconnecting" : "Connecting")
            } else if s.muted {
                out.floor = "muted"
                out.header = Header(key: "muted", label: "Muted", detail: "Still billing")
            } else {
                out.floor = (s.floor == "you" || s.floor == "voice") ? s.floor! : "listening"
                out.header = Header(key: "live", label: "Live")
            }
            let w = stageWords[out.floor]!
            out.word = w.0; out.sub = w.1
            if s.attention {
                out.header = Header(key: "attention", label: "Approval needed", detail: out.header.key == "muted" ? "Muted" : nil)
                if phase == "live" {
                    out.sub = out.floor == "muted" ? "Muted · Sotto can't hear you" : out.word
                    out.word = approvalWord
                    out.wordTone = "attn"
                }
            }
            return out
        }
        if s.sseDown {
            return card(Card(kind: "disconnected", title: "Disconnected", body: "Waiting for the sotto daemon…", tone: "warn"), "off", Header(key: "error", label: "Disconnected"))
        }
        if st == "off" { return card(Card(kind: "off", title: "Voice is off", body: "Turn it on from Claude Code with /talk on."), "off", Header(key: "off", label: "Off")) }
        if st == "closing" { return card(Card(kind: "closing", title: "Closing…", body: "Finishing the voice session."), "off", Header(key: "off", label: "Closing")) }
        if st == "sleeping" {
            let v = s.sleep ?? SleepText(title: "Sleeping", body: "Voice wakes up when you speak. Nothing is sent or billed until then.", listening: false)
            return card(Card(kind: "sleeping", title: v.title, body: v.body, pending: nonEmpty(s.pendingResult), button: "Wake now", action: "resume", kbd: true,
                             secondary: true, listening: v.listening),
                        "sleeping", Header(key: "sleeping", label: statusLabel(st)))
        }
        if st == "paused" {
            let reason = nonEmpty(s.pausedReason) ?? (lastCode == "daily_cap" ? "daily_cap" : nil)
            let cap = reason == "daily_cap"
            var body = "Resume to keep talking with Claude Code."
            if cap {
                let used = (s.capMinutes ?? 0) > 0 ? "You've used today's \(formatDuration(s.capMinutes! * 60, long: true)) of voice. " : ""
                body = "\(used)Raise daily_cap_minutes in /config (sotto) to continue today."
            } else if lastCode == "mic_denied" || lastCode == "mic_error" {
                body = nonEmpty(s.lastErrorMessage) ?? body
            }
            return card(Card(kind: cap ? "cap" : "paused", title: pausedMessage(reason, idleMinutes: s.idleMinutes, idleSeconds: s.idleSeconds),
                             body: cap ? body : "\(body) Nothing is billed while paused.", pending: nonEmpty(s.pendingResult),
                             button: cap ? nil : "Resume", action: "resume", kbd: !cap, tone: cap ? "attn" : "neutral"),
                        "paused", Header(key: cap ? "attention" : "paused", label: cap ? "Limit reached" : statusLabel(st)))
        }
        out.view = "live"; out.dial = "full"
        out.floor = st == "reconnecting" ? "reconnecting" : "connecting"
        out.steps = st == "reconnecting" ? nil : connectSteps(nil)
        out.header = Header(key: "connecting", label: statusLabel(st))
        let w = stageWords[out.floor]!
        out.word = w.0; out.sub = w.1
        if st != "reconnecting" { out.sub = "Waiting for Claude Code…" }
        return out
    }

    /// What VoiceOver hears when the card changes (lib.cardAnnouncement).
    public static func cardAnnouncement(_ card: Card?) -> (text: String, assertive: Bool)? {
        guard let card, !card.title.isEmpty else { return nil }
        let first = firstMatch(card.body, "^.*?[.!?](?=\\s|$)") ?? card.body
        var text = first.isEmpty ? "\(card.title)." : "\(card.title). \(first)"
        if let r = text.range(of: ".. ") { text.replaceSubrange(r, with: ". ") }
        let assertive = card.tone == "err" || card.kind == "cap" || card.kind.hasPrefix("mic-") || card.kind == "lost"
        return (text.replacingOccurrences(of: "….", with: "…"), assertive)
    }

    /// Panel title (lib.windowTitle).
    public static func windowTitle(floor: String, attention: Bool) -> String {
        if attention { return "Approval needed · Sotto" }
        if floor == "muted" { return "Muted · Sotto" }
        return "Sotto"
    }

    // MARK: - Regex helpers (NSRegularExpression: the ICU syntax matches the JS patterns used here)

    nonisolated(unsafe) private static var cache: [String: NSRegularExpression] = [:]
    private static let cacheLock = NSLock()

    static func regex(_ p: String, multiline: Bool = false) -> NSRegularExpression {
        let k = (multiline ? "m:" : "s:") + p
        cacheLock.lock(); defer { cacheLock.unlock() }
        if let r = cache[k] { return r }
        let r = try! NSRegularExpression(pattern: p, options: multiline ? [.anchorsMatchLines] : [])
        cache[k] = r
        return r
    }

    static func replace(_ s: String, _ p: String, _ template: String, multiline: Bool = false) -> String {
        let r = regex(p, multiline: multiline)
        return r.stringByReplacingMatches(in: s, range: NSRange(location: 0, length: (s as NSString).length), withTemplate: template)
    }

    static func firstMatch(_ s: String, _ p: String) -> String? {
        let r = regex(p)
        guard let m = r.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) else { return nil }
        return (s as NSString).substring(with: m.range)
    }

    static func nonEmpty(_ s: String?) -> String? { (s?.isEmpty ?? true) ? nil : s }

    static func prefixUTF16(_ s: String, _ n: Int) -> String {
        let ns = s as NSString
        return ns.length <= n ? s : ns.substring(to: n)
    }
}

/// Read helpers over a loosely typed JSON object.
public typealias JSONValueLike = JSONValue

public extension Dictionary where Key == String, Value == JSONValue {
    func string(_ k: String) -> String? { if case .string(let s)? = self[k] { return s }; return nil }
    func number(_ k: String) -> Double? { if case .number(let n)? = self[k] { return n }; return nil }
    func bool(_ k: String) -> Bool? { if case .bool(let b)? = self[k] { return b }; return nil }
    func object(_ k: String) -> [String: JSONValue]? { if case .object(let o)? = self[k] { return o }; return nil }
}
