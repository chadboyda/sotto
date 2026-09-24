import XCTest
@testable import SottoClient

/// Decoding every §3.1 message from the shared fixtures and encoding every §3.2/§3.3 message.
final class MessageTests: XCTestCase {
    static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("test/fixtures/native")

    func lines(_ name: String) throws -> [String] {
        try String(contentsOf: Self.fixtures.appendingPathComponent(name), encoding: .utf8)
            .split(separator: "\n").map(String.init).filter { !$0.isEmpty }
    }

    func testWelcomeFixture() throws {
        let text = try String(contentsOf: Self.fixtures.appendingPathComponent("welcome.json"), encoding: .utf8)
        let m = ServerMessage.decode(text)
        guard case .welcome(let p, let v, let status, _) = m else { return XCTFail("not welcome: \(m)") }
        XCTAssertEqual(p, 1)
        XCTAssertEqual(v, "0.3.0")
        XCTAssertEqual(status?.state, "connecting")
        XCTAssertEqual(status?.owner?.project, "sotto")
        XCTAssertEqual(status?.key?.hint, "ab12")
        XCTAssertEqual(status?.audio_client, "app")
        XCTAssertNil(status?.live)
        XCTAssertEqual(m.welcomeBuild?.count, 64)
        let s = m.settingsPayload
        XCTAssertEqual(s?.voices?.voices, ["alloy", "marin", "cedar"])
        XCTAssertEqual(s?.voices?.current, "marin")
        XCTAssertEqual(s?.window, "auto")
        XCTAssertEqual(s?.data_dir, "/tmp/sotto-data")
        XCTAssertEqual(s?.wake_sensitivities?.count, 4)
    }

    func testSessionFixture() throws {
        let msgs = try lines("session.jsonl").map(ServerMessage.decode)
        XCTAssertEqual(msgs.count, 21)
        for m in msgs {
            if case .other = m { XCTFail("fixture line decoded as .other: \(m)") }
            if case .unknown = m { XCTFail("fixture line decoded as .unknown") }
        }
        XCTAssertEqual(msgs[0], .live(LiveEvent(type: "session.started",
            raw: ["type": "session.started", "session": ["id": "sess_test_1", "expires_at": 1790000000]])))
        XCTAssertEqual(msgs[1], .caption(Caption(role: "assistant", text: "Hi, ", start_ms: 100, end_ms: 300, session: "sess_test_1")))
        XCTAssertEqual(msgs[5], .delegation(Delegation(id: "del_1", status: "sent", text: "List the files in the daemon folder.")))
        guard case .activity(let a) = msgs[8] else { return XCTFail() }
        XCTAssertEqual(a.kind, "agents"); XCTAssertEqual(a.count, 1); XCTAssertEqual(a.text, "1 background agent")
        XCTAssertEqual(msgs[9], .notice(Notice(level: "warn", code: "cant_hear", text: "Sotto can't hear you. Check the microphone.")))
        XCTAssertEqual(msgs[10], .noticeClear(code: "cant_hear"))
        XCTAssertEqual(msgs[14], .resultPending(text: "There are 34 files in daemon/."))
        XCTAssertEqual(msgs[15], .audioFlush(reason: "session_end"))
        guard case .live(let closed) = msgs[16] else { return XCTFail() }
        XCTAssertEqual(closed.type, "session.closed"); XCTAssertEqual(closed.raw["reason"], "close_requested")
        XCTAssertEqual(msgs[17], .command(DaemonCommand(command: "close_window", reason: "off")))
        XCTAssertEqual(msgs[18], .ping(t: 1790000000000))
        XCTAssertEqual(msgs[19], .result(CommandResult(id: "c1", ok: true, data: ["muted": true], error: nil)))
        XCTAssertEqual(msgs[20], .result(CommandResult(id: "c2", ok: false, data: nil,
                                                       error: CommandFailure(code: "bad_voice", message: "Unknown voice"))))
        XCTAssertEqual(msgs.map(\.type).filter { $0 == "caption" }.count, 4)
    }

    func testExtraFixture() throws {
        let msgs = try lines("server-extra.jsonl").map(ServerMessage.decode)
        guard case .status(let s) = msgs[0] else { return XCTFail("\(msgs[0])") }
        XCTAssertEqual(s.state, "live"); XCTAssertEqual(s.live?.muted, false); XCTAssertEqual(s.claude?.busy, true)
        XCTAssertEqual(s.echo_heard_ms_ago, 1200); XCTAssertEqual(s.live?.usage_seconds, 3.5)
        guard case .settings(let st) = msgs[1] else { return XCTFail("\(msgs[1])") }
        XCTAssertEqual(st.voices?.live_voice, "marin"); XCTAssertEqual(st.window, "app")
        XCTAssertEqual(msgs[1].settingsPayload, st)
        XCTAssertEqual(msgs[2], .wakeHeard(text: "hey are you there"))
        XCTAssertEqual(msgs[3], .command(DaemonCommand(command: "play_echo_sample", reason: "echo_test")))
        guard case .live(let e) = msgs[4] else { return XCTFail() }
        XCTAssertEqual(e.type, "error"); XCTAssertEqual(e.raw["error"]?["code"], "rate_limited")
        XCTAssertEqual(msgs[5], .notice(Notice(level: "info", code: "app_took_over", text: "Voice is in the Sotto app")))
        guard case .other(let t, let raw) = msgs[6] else { return XCTFail() }
        XCTAssertEqual(t, "future_thing"); XCTAssertEqual(raw["x"], 1)
    }

    func testMalformed() {
        XCTAssertEqual(ServerMessage.decode("not json"), .unknown)
        XCTAssertEqual(ServerMessage.decode("[1,2]"), .unknown)
        XCTAssertEqual(ServerMessage.decode("{\"no\":\"type\"}"), .unknown)
        // A known type with a broken payload stays visible as .other, never crashes.
        guard case .other(let t, _) = ServerMessage.decode("{\"type\":\"status\",\"status\":{\"state\":5}}") else { return XCTFail() }
        XCTAssertEqual(t, "status")
        guard case .other = ServerMessage.decode("{\"type\":\"welcome\"}") else { return XCTFail() }
        // result with no data -> nil data; error with no body -> generic failure.
        XCTAssertEqual(ServerMessage.decode("{\"type\":\"result\",\"id\":\"x\",\"ok\":false}"),
                       .result(CommandResult(id: "x", ok: false, data: nil, error: CommandFailure(code: "error", message: "The command failed."))))
    }

    func testJSONValueBoolsAndNumbers() throws {
        let v = try JSONDecoder().decode(JSONValue.self, from: Data("{\"a\":true,\"b\":1,\"c\":0,\"d\":1.5,\"e\":null}".utf8))
        XCTAssertEqual(v["a"], .bool(true))
        XCTAssertEqual(v["b"], .number(1))
        XCTAssertEqual(v["c"], .number(0))
        XCTAssertEqual(v["d"]?.doubleValue, 1.5)
        XCTAssertEqual(v["e"], .null)
    }

    /// Parse the encoded text back to JSONValue so key order and number spelling don't matter.
    func obj(_ m: ClientMessage) throws -> JSONValue {
        let text = m.encode()
        XCTAssertFalse(text.contains("\n"))
        return try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    func testEncodeHello() throws {
        let o = try obj(.hello(version: "0.3.0", build: "abc", test: true))
        XCTAssertEqual(o, ["type": "hello", "protocol": 1, "client": "app", "version": "0.3.0", "build": "abc", "test": true,
                           "capabilities": ["native_audio"], "audio": ["rate": 24000, "frame_ms": 20, "format": "pcm16le"]])
        XCTAssertEqual(try obj(.hello(version: "0.3.0", build: nil, test: false))["build"], .null)
        // Integers are sent without a fraction.
        XCTAssertTrue(ClientMessage.hello(version: "v", build: nil, test: false).encode().contains("\"protocol\":1,"))
    }

    func testEncodeEveryClientMessage() throws {
        XCTAssertEqual(try obj(.cmd(id: "c1", name: "mute", args: ["on": true])),
                       ["type": "cmd", "id": "c1", "name": "mute", "args": ["on": true]])
        XCTAssertEqual(try obj(.route(RouteMessage(mode: "split",
            input: .init(id: "BuiltInMic", name: "MacBook Pro Microphone", bluetooth: false),
            output: .init(id: "AirPods", name: "AirPods Pro", bluetooth: true, headphones: true), echoCancellation: "automatic"))),
            ["type": "route", "mode": "split", "input": ["id": "BuiltInMic", "name": "MacBook Pro Microphone", "bluetooth": false],
             "output": ["id": "AirPods", "name": "AirPods Pro", "bluetooth": true, "headphones": true], "echo_cancellation": "automatic"])
        XCTAssertEqual(try obj(.audioStats(AudioStatsMessage(playoutSeq: 12, playoutHostNs: 123_456_789_000, bufferMs: 60,
            underruns: 1, overruns: 0, captureDrops: 2, mode: "fake", micSeq: 99))),
            ["type": "audio_stats", "playout_seq": 12, "playout_host_ns": 123_456_789_000, "buffer_ms": 60, "underruns": 1,
             "overruns": 0, "capture_drops": 2, "mode": "fake", "mic_seq": 99])
        XCTAssertEqual(try obj(.pong(t: 1790000000000)), ["type": "pong", "t": 1790000000000])
        XCTAssertEqual(try obj(.played(what: "sample", voice: "cedar")), ["type": "played", "what": "sample", "voice": "cedar"])
        XCTAssertEqual(try obj(.played(what: "echo_test", voice: nil)), ["type": "played", "what": "echo_test"])
        XCTAssertEqual(try obj(.log(level: "warn", message: "x")), ["type": "log", "level": "warn", "message": "x"])
        XCTAssertEqual(try obj(.system(event: "sleep")), ["type": "system", "event": "sleep"])
        XCTAssertEqual(try obj(.micError(name: "NotAllowedError", message: "denied")),
                       ["type": "mic_error", "name": "NotAllowedError", "message": "denied"])
        XCTAssertEqual(try obj(.activity), ["type": "activity"])
        XCTAssertEqual(try obj(.other(type: "x_new", fields: ["a": 1])), ["type": "x_new", "a": 1])
        // pong echoes t exactly, even when it is not a whole number.
        XCTAssertEqual(try obj(.pong(t: 12.25))["t"], .number(12.25))
    }

    func testEveryCommandNameEncodes() throws {
        let names = ["mute", "pause", "resume", "wake", "end", "set_voice", "set_policy", "set_wake", "set_window",
                     "key_save", "key_remove", "get_voices", "echo_test", "open_browser"]
        for n in names {
            XCTAssertEqual(try obj(.cmd(id: "i", name: n, args: [:]))["name"], .string(n))
        }
    }

    func testKeySaveRedaction() {
        let m = ClientMessage.cmd(id: "k", name: "key_save", args: ["key": "sk-test-DO-NOT-LOG"])
        XCTAssertTrue(m.encode().contains("sk-test-DO-NOT-LOG"))  // the wire carries it
        XCTAssertFalse(m.redactedDescription.contains("sk-test-DO-NOT-LOG"))
        XCTAssertTrue(m.redactedDescription.contains("[redacted]"))
    }
}
