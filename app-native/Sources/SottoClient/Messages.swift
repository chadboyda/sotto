// JSON messages (docs/NATIVE.md §3). Builder B4 (client) owns this file.
// Renaming or removing a public member needs a NATIVE.md change; members were
// only added over the contract stub (typed cases for every §3.1/§3.2 type).
import Foundation

// MARK: - JSONValue

/// Minimal JSON value for loosely typed payloads (activity extras, live events, cmd args/results).
public enum JSONValue: Codable, Equatable, Sendable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n):
            // Whole numbers go out without a fraction ("7", not "7.0") so the
            // daemon's integer fields (seq, ns, counts) read naturally.
            if n.rounded() == n, abs(n) < 9.0e15 { try c.encode(Int64(n)) } else { try c.encode(n) }
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }
    public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    public var doubleValue: Double? { if case .number(let n) = self { return n }; return nil }
    public var intValue: Int? { doubleValue.flatMap { $0.isFinite ? Int(exactly: $0.rounded()) : nil } }
    public var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var objectValue: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
    public var arrayValue: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    public var isNull: Bool { self == .null }

    /// Decode a typed value out of this JSON (re-encodes; fine at message rates).
    public func decode<T: Decodable>(_ type: T.Type) -> T? {
        guard let data = try? JSONEncoder().encode(self) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
    public init<T: Encodable>(encoding value: T) throws {
        self = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral,
    ExpressibleByBooleanLiteral, ExpressibleByNilLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral {
    public init(stringLiteral v: String) { self = .string(v) }
    public init(integerLiteral v: Int) { self = .number(Double(v)) }
    public init(floatLiteral v: Double) { self = .number(v) }
    public init(booleanLiteral v: Bool) { self = .bool(v) }
    public init(nilLiteral: ()) { self = .null }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        self = .object(Dictionary(elements, uniquingKeysWith: { _, b in b }))
    }
}

// MARK: - Status and settings

/// The status snapshot: exactly voice.pageStatus() (same object the SSE `status` carries),
/// plus `audio_client`. Always a full replacement, never a patch.
public struct PageStatus: Codable, Equatable, Sendable {
    public struct Owner: Codable, Equatable, Sendable { public var project: String?; public var cwd: String? }
    public struct Wake: Codable, Equatable, Sendable {
        public var enabled: Bool?; public var sensitivity: String?; public var boost_db: Double?; public var not_before: Double?
    }
    public struct Live: Codable, Equatable, Sendable {
        public var session_id: String?; public var expires_at: Double?; public var usage_seconds: Double?; public var muted: Bool?
    }
    public struct Today: Codable, Equatable, Sendable { public var seconds: Double?; public var cap_minutes: Double? }
    public struct Claude: Codable, Equatable, Sendable {
        /// The approval Claude Code waits on (SPEC §6.10.4): the newest of `pending`.
        public struct Approval: Codable, Equatable, Sendable {
            public var label: String?; public var agent: Bool?; public var since: String?; public var pending: Double?
        }
        public var busy: Bool?
        public var approval: Approval?
        /// The daemon reports approvals: `approval` null then means none is pending
        /// (an older daemon leaves the key out).
        public var reportsApproval = false
        enum CodingKeys: String, CodingKey { case busy, approval }
        public init(busy: Bool? = nil, approval: Approval? = nil, reportsApproval: Bool = false) {
            self.busy = busy; self.approval = approval; self.reportsApproval = reportsApproval || approval != nil
        }
        public init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            busy = try c.decodeIfPresent(Bool.self, forKey: .busy)
            reportsApproval = c.contains(.approval)
            approval = try? c.decodeIfPresent(Approval.self, forKey: .approval)
        }
        public func encode(to e: Encoder) throws {
            var c = e.container(keyedBy: CodingKeys.self)
            try c.encodeIfPresent(busy, forKey: .busy)
            if let a = approval { try c.encode(a, forKey: .approval) } else if reportsApproval { try c.encodeNil(forKey: .approval) }
        }
    }
    public struct LastError: Codable, Equatable, Sendable { public var code: String?; public var message: String? }
    public struct Key: Codable, Equatable, Sendable {
        public var present: Bool?; public var source: String?; public var file: String?; public var hint: String?
        public var label: String?; public var can_change: Bool?; public var can_remove: Bool?; public var keychain: Bool?
        public var setup: Bool?
    }
    public var state: String
    public var owner: Owner?
    public var voice: String?
    /// The persona in effect (SPEC §4.6), also set from the terminal (`/talk persona`).
    public var persona: String?
    public var speaking_policy: String?
    public var idle_minutes: Double?
    public var idle_seconds: Double?
    public var echo_guard: String?
    public var echo_heard_ms_ago: Double?
    public var wake: Wake?
    public var live: Live?
    public var today: Today?
    public var claude: Claude?
    public var last_error: LastError?
    public var key: Key?
    public var audio_client: String?

    public init(state: String) { self.state = state }
}

/// `settings` (docs/NATIVE.md §3.1): voice list, window pref, pickers, data dir.
public struct Settings: Codable, Equatable, Sendable {
    public struct Voices: Codable, Equatable, Sendable {
        public var voices: [String]?; public var current: String?; public var live: Bool?; public var live_voice: String?
        public init(voices: [String]? = nil, current: String? = nil, live: Bool? = nil, live_voice: String? = nil) {
            self.voices = voices; self.current = current; self.live = live; self.live_voice = live_voice
        }
    }
    /// The persona picker (SPEC §4.6, `voice.personas()`): summaries only, never a persona's text.
    public struct Personas: Codable, Equatable, Sendable {
        public struct Persona: Codable, Equatable, Sendable, Identifiable {
            public var id: String; public var name: String; public var description: String?
            /// The persona's own voice, if it names one.
            public var voice: String?
            /// "builtin" | "user" (D/personas) | "project" (<project>/.claude/sotto-personas).
            public var source: String?
            public init(id: String, name: String, description: String? = nil, voice: String? = nil, source: String? = nil) {
                self.id = id; self.name = name; self.description = description; self.voice = voice; self.source = source
            }
        }
        public var personas: [Persona]
        public var current: String?
        /// "Switch to the persona's own voice" (default on).
        public var use_voice: Bool?
        public var live: Bool?
        public var live_persona: String?
        public init(personas: [Persona], current: String? = nil, use_voice: Bool? = nil, live: Bool? = nil, live_persona: String? = nil) {
            self.personas = personas; self.current = current; self.use_voice = use_voice; self.live = live; self.live_persona = live_persona
        }
    }
    public var voices: Voices?
    public var personas: Personas?
    public var window: String?
    public var policies: [String]?
    public var wake_sensitivities: [String]?
    public var data_dir: String?
    public var version: String?
    public init() {}
}

// MARK: - Daemon -> app payloads

public struct Activity: Equatable, Sendable {
    public var kind: String
    public var text: String
    /// The whole message (`kind`, `text` and any extras such as `count`).
    public var raw: [String: JSONValue]
    public var count: Int? { raw["count"]?.intValue }
}

public struct Delegation: Codable, Equatable, Sendable { public var id: String; public var status: String?; public var text: String? }

public struct Notice: Codable, Equatable, Sendable { public var level: String?; public var code: String?; public var text: String? }

public struct Caption: Codable, Equatable, Sendable {
    public var role: String
    public var text: String
    public var start_ms: Double?
    public var end_ms: Double?
    public var session: String?
}

public struct DaemonCommand: Codable, Equatable, Sendable { public var command: String; public var reason: String? }

/// One Live server event forwarded verbatim (`session.started`, `session.closed`, ...).
public struct LiveEvent: Equatable, Sendable {
    public var type: String
    public var raw: [String: JSONValue]
}

/// Error body of a failed `result`.
public struct CommandFailure: Error, Codable, Equatable, Sendable {
    public var code: String
    public var message: String
    public init(code: String, message: String) { self.code = code; self.message = message }
}

public struct CommandResult: Equatable, Sendable {
    public var id: String
    public var ok: Bool
    public var data: JSONValue?
    public var error: CommandFailure?
}

// MARK: - ServerMessage

/// Daemon -> app. Unknown `type`s decode to `.other` (forward compatibility); undecodable text to `.unknown`.
public enum ServerMessage: Equatable, Sendable {
    case welcome(protocolVersion: Int, version: String, status: PageStatus?, raw: [String: JSONValue])
    case status(PageStatus)
    case settings(Settings)
    case activity(Activity)
    case delegation(Delegation)
    case notice(Notice)
    case noticeClear(code: String)
    case resultPending(text: String)
    case wakeHeard(text: String)
    case command(DaemonCommand)
    case caption(Caption)
    case live(LiveEvent)
    case audioFlush(reason: String)
    case ping(t: Double)
    case result(CommandResult)
    case other(type: String, raw: [String: JSONValue])   // a type this build does not know, or a malformed known one
    case unknown

    /// The `type` string this message arrived with ("" for `.unknown`).
    public var type: String {
        switch self {
        case .welcome: return "welcome"
        case .status: return "status"
        case .settings: return "settings"
        case .activity: return "activity"
        case .delegation: return "delegation"
        case .notice: return "notice"
        case .noticeClear: return "notice_clear"
        case .resultPending: return "result_pending"
        case .wakeHeard: return "wake_heard"
        case .command: return "command"
        case .caption: return "caption"
        case .live: return "live"
        case .audioFlush: return "audio_flush"
        case .ping: return "ping"
        case .result: return "result"
        case .other(let t, _): return t
        case .unknown: return ""
        }
    }

    /// `settings` of a `welcome` or a `settings` message.
    public var settingsPayload: Settings? {
        switch self {
        case .settings(let s): return s
        case .welcome(_, _, _, let raw): return raw["settings"]?.decode(Settings.self)
        default: return nil
        }
    }

    /// `build` (web build hash) of a `welcome`.
    public var welcomeBuild: String? {
        if case .welcome(_, _, _, let raw) = self { return raw["build"]?.stringValue }
        return nil
    }

    public static func decode(_ text: String) -> ServerMessage {
        guard let data = text.data(using: .utf8) else { return .unknown }
        return decode(data)
    }

    public static func decode(_ data: Data) -> ServerMessage {
        guard let raw = try? JSONDecoder().decode([String: JSONValue].self, from: data),
              let type = raw["type"]?.stringValue else { return .unknown }
        let dec = JSONDecoder()
        func str(_ k: String) -> String? { raw[k]?.stringValue }
        switch type {
        case "welcome":
            guard let p = raw["protocol"]?.intValue else { break }
            let status = raw["status"].flatMap { $0.isNull ? nil : $0.decode(PageStatus.self) }
            return .welcome(protocolVersion: p, version: str("version") ?? "", status: status, raw: raw)
        case "status":
            if let s = raw["status"]?.decode(PageStatus.self) { return .status(s) }
        case "settings":
            // Accept both `{type, ...Settings}` (contract) and `{type, settings:{...}}`.
            if let inner = raw["settings"], inner.objectValue != nil, let s = inner.decode(Settings.self) { return .settings(s) }
            if let s = try? dec.decode(Settings.self, from: data) { return .settings(s) }
        case "activity":
            if let k = str("kind") { return .activity(Activity(kind: k, text: str("text") ?? "", raw: raw)) }
        case "delegation":
            if let d = try? dec.decode(Delegation.self, from: data) { return .delegation(d) }
        case "notice":
            if let n = try? dec.decode(Notice.self, from: data) { return .notice(n) }
        case "notice_clear":
            if let c = str("code") { return .noticeClear(code: c) }
        case "result_pending":
            return .resultPending(text: str("text") ?? "")
        case "wake_heard":
            return .wakeHeard(text: str("text") ?? "")
        case "command":
            if let c = try? dec.decode(DaemonCommand.self, from: data) { return .command(c) }
        case "caption":
            if let c = try? dec.decode(Caption.self, from: data) { return .caption(c) }
        case "live":
            if let ev = raw["event"]?.objectValue, let t = ev["type"]?.stringValue { return .live(LiveEvent(type: t, raw: ev)) }
        case "audio_flush":
            return .audioFlush(reason: str("reason") ?? "")
        case "ping":
            return .ping(t: raw["t"]?.doubleValue ?? 0)
        case "result":
            guard let id = str("id") else { break }
            let ok = raw["ok"]?.boolValue ?? false
            var failure: CommandFailure?
            if !ok {
                let e = raw["error"]
                failure = CommandFailure(code: e?["code"]?.stringValue ?? "error",
                                         message: e?["message"]?.stringValue ?? "The command failed.")
            }
            let data = raw["data"].flatMap { $0.isNull ? nil : $0 }
            return .result(CommandResult(id: id, ok: ok, data: data, error: failure))
        default:
            break
        }
        return .other(type: type, raw: raw)
    }
}

// MARK: - ClientMessage

public struct RouteMessage: Equatable, Sendable {
    public struct Device: Equatable, Sendable {
        public var id: String; public var name: String; public var bluetooth: Bool; public var headphones: Bool?
        public init(id: String, name: String, bluetooth: Bool, headphones: Bool? = nil) {
            self.id = id; self.name = name; self.bluetooth = bluetooth; self.headphones = headphones
        }
    }
    public var mode: String
    public var input: Device?
    public var output: Device?
    public var echoCancellation: String
    public init(mode: String, input: Device?, output: Device?, echoCancellation: String) {
        self.mode = mode; self.input = input; self.output = output; self.echoCancellation = echoCancellation
    }
}

/// `audio_stats` (docs/NATIVE.md §2.5), about once a second.
public struct AudioStatsMessage: Equatable, Sendable {
    public var playoutSeq: UInt32
    public var playoutHostNs: UInt64
    public var bufferMs: Double
    public var underruns: Int
    public var overruns: Int
    public var captureDrops: Int
    public var mode: String
    public var micSeq: UInt32
    public init(playoutSeq: UInt32, playoutHostNs: UInt64, bufferMs: Double, underruns: Int, overruns: Int,
                captureDrops: Int, mode: String, micSeq: UInt32) {
        self.playoutSeq = playoutSeq; self.playoutHostNs = playoutHostNs; self.bufferMs = bufferMs
        self.underruns = underruns; self.overruns = overruns; self.captureDrops = captureDrops
        self.mode = mode; self.micSeq = micSeq
    }
}

/// App -> daemon.
public enum ClientMessage: Equatable, Sendable {
    case hello(version: String, build: String?, test: Bool)
    case cmd(id: String, name: String, args: [String: JSONValue])
    case route(RouteMessage)
    case audioStats(AudioStatsMessage)
    case pong(t: Double)
    case played(what: String, voice: String?)
    case log(level: String, message: String)
    case system(event: String)
    case micError(name: String, message: String)
    case activity
    case other(type: String, fields: [String: JSONValue])

    public var type: String {
        switch self {
        case .hello: return "hello"
        case .cmd: return "cmd"
        case .route: return "route"
        case .audioStats: return "audio_stats"
        case .pong: return "pong"
        case .played: return "played"
        case .log: return "log"
        case .system: return "system"
        case .micError: return "mic_error"
        case .activity: return "activity"
        case .other(let t, _): return t
        }
    }

    /// The JSON object sent on the wire.
    public var json: [String: JSONValue] {
        var o: [String: JSONValue]
        switch self {
        case .hello(let version, let build, let test):
            o = ["protocol": .number(Double(NativeProtocol.version)), "client": "app", "version": .string(version),
                 "build": build.map { .string($0) } ?? .null, "test": .bool(test),
                 "capabilities": ["native_audio"],
                 "audio": ["rate": .number(Double(NativeProtocol.sampleRate)), "frame_ms": .number(Double(NativeProtocol.frameMs)),
                           "format": "pcm16le"]]
        case .cmd(let id, let name, let args):
            o = ["id": .string(id), "name": .string(name), "args": .object(args)]
        case .route(let r):
            func dev(_ d: RouteMessage.Device?, headphones: Bool) -> JSONValue {
                guard let d else { return .null }
                var x: [String: JSONValue] = ["id": .string(d.id), "name": .string(d.name), "bluetooth": .bool(d.bluetooth)]
                if headphones { x["headphones"] = .bool(d.headphones ?? false) }
                return .object(x)
            }
            o = ["mode": .string(r.mode), "input": dev(r.input, headphones: false), "output": dev(r.output, headphones: true),
                 "echo_cancellation": .string(r.echoCancellation)]
        case .audioStats(let s):
            o = ["playout_seq": .number(Double(s.playoutSeq)), "playout_host_ns": .number(Double(s.playoutHostNs)),
                 "buffer_ms": .number(s.bufferMs), "underruns": .number(Double(s.underruns)),
                 "overruns": .number(Double(s.overruns)), "capture_drops": .number(Double(s.captureDrops)),
                 "mode": .string(s.mode), "mic_seq": .number(Double(s.micSeq))]
        case .pong(let t):
            o = ["t": .number(t)]
        case .played(let what, let voice):
            o = ["what": .string(what)]
            if let voice { o["voice"] = .string(voice) }
        case .log(let level, let message):
            o = ["level": .string(level), "message": .string(message)]
        case .system(let event):
            o = ["event": .string(event)]
        case .micError(let name, let message):
            o = ["name": .string(name), "message": .string(message)]
        case .activity:
            o = [:]
        case .other(_, let fields):
            o = fields
        }
        o["type"] = .string(type)
        return o
    }

    public func encode() -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? enc.encode(JSONValue.object(json)), let s = String(data: data, encoding: .utf8) else {
            return "{\"type\":\"\(type)\"}"
        }
        return s
    }

    /// Text safe to log: `key_save` args are replaced (the key is never logged).
    public var redactedDescription: String {
        if case .cmd(let id, let name, _) = self, name == "key_save" {
            return ClientMessage.cmd(id: id, name: name, args: ["key": "[redacted]"]).encode()
        }
        return encode()
    }
}
