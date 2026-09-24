// StateModel.apply over the shared fixture sequence (test/fixtures/native/session.jsonl)
// and targeted sequences (docs/NATIVE.md §6 B5 acceptance).
import XCTest
@testable import SottoUI
@testable import SottoClient

@MainActor
final class StateModelTests: XCTestCase {
    static var fixtures: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("test/fixtures/native")
    }

    func objects(_ file: String) throws -> [[String: JSONValue]] {
        let text = try String(contentsOf: Self.fixtures.appendingPathComponent(file), encoding: .utf8)
        return try text.split(separator: "\n").filter { !$0.isEmpty }.map {
            guard case .object(let o) = try JSONDecoder().decode(JSONValue.self, from: Data($0.utf8)) else { throw NSError(domain: "t", code: 1) }
            return o
        }
    }

    final class Clock { var t = Date(timeIntervalSince1970: 1_790_000_000) }

    func model(_ clock: Clock = Clock()) -> StateModel {
        let m = StateModel()
        m.now = { clock.t }
        return m
    }

    func status(_ state: String, muted: Bool? = nil, busy: Bool = false, sid: String? = "sess_test_1", lastError: String? = nil) -> [String: JSONValue] {
        var s: [String: JSONValue] = ["state": .string(state), "today": .object(["seconds": .number(600), "cap_minutes": .number(120)]),
                                      "claude": .object(["busy": .bool(busy)]), "owner": .object(["project": .string("sotto"), "cwd": .string("/x/sotto")])]
        if let muted, let sid { s["live"] = .object(["session_id": .string(sid), "usage_seconds": .number(10), "muted": .bool(muted)]) }
        if let lastError { s["last_error"] = .object(["code": .string(lastError), "message": .string(lastError)]) }
        return ["type": .string("status"), "status": .object(s)]
    }

    func testWelcomeFixtureDecodes() throws {
        let data = try Data(contentsOf: Self.fixtures.appendingPathComponent("welcome.json"))
        guard case .object(let o) = try JSONDecoder().decode(JSONValue.self, from: data) else { return XCTFail() }
        let m = model()
        m.linkState = .connected
        m.apply(object: o)
        XCTAssertNotNil(m.status)
        XCTAssertNotNil(m.settings)
        XCTAssertNotEqual(m.phase, "boot")
    }

    func testSessionFixtureSequence() throws {
        let clock = Clock()
        let m = model(clock)
        m.linkState = .connected
        m.apply(object: status("live", muted: false))
        XCTAssertEqual(m.phase, "live")
        for o in try objects("session.jsonl") {
            clock.t.addTimeInterval(0.5)
            m.apply(object: o)
        }
        // Captions merged like lib.reduceCaptions.
        XCTAssertEqual(m.captions.map(\.text), ["Hi, I'm listening.", "List the files in the daemon folder."])
        XCTAssertEqual(m.captions.map(\.role), ["assistant", "user"])
        // Delegation upserted; activity reduced to the card.
        XCTAssertEqual(m.delegations.first?.id, "del_1")
        XCTAssertEqual(m.agents, 1)
        XCTAssertEqual(m.claudeCard.kind, "finished")
        XCTAssertEqual(m.claudeCard.summary, "There are 34 files in daemon/.")
        XCTAssertEqual(m.pendingResult, "There are 34 files in daemon/.")
        // cant_hear came and went.
        XCTAssertNil(m.banners.first { $0.key == "cant_hear" })
        // Live usage followed session.usage.updated / session.closed.
        XCTAssertEqual(m.liveUsageSeconds, 15)
        // close_window: once the daemon says off, the closed card shows.
        m.apply(object: status("off"))
        XCTAssertEqual(m.phase, "closed")
        XCTAssertEqual(m.pageView.card?.kind, "closed")
    }

    /// The same sequence through SottoClient's typed decoder (what the Controller feeds).
    func testSessionFixtureViaTypedMessages() throws {
        let clock = Clock()
        let m = model(clock)
        m.linkState = .connected
        let welcome = try String(contentsOf: Self.fixtures.appendingPathComponent("welcome.json"), encoding: .utf8)
        m.apply(ServerMessage.decode(welcome))
        XCTAssertEqual(m.voices, ["alloy", "marin", "cedar"])
        m.apply(object: status("live", muted: false))
        let text = try String(contentsOf: Self.fixtures.appendingPathComponent("session.jsonl"), encoding: .utf8)
        for line in text.split(separator: "\n") where !line.isEmpty {
            clock.t.addTimeInterval(0.5)
            m.apply(ServerMessage.decode(String(line)))
        }
        XCTAssertEqual(m.captions.map(\.text), ["Hi, I'm listening.", "List the files in the daemon folder."])
        XCTAssertEqual(m.delegations.first?.id, "del_1")
        XCTAssertEqual(m.agents, 1)
        XCTAssertEqual(m.claudeCard.kind, "finished")
        XCTAssertEqual(m.pendingResult, "There are 34 files in daemon/.")
        XCTAssertNil(m.banners.first { $0.key == "cant_hear" })
        XCTAssertEqual(m.liveUsageSeconds, 15)
        m.apply(ServerMessage.decode(#"{"type":"notice","level":"warn","code":"echo_detected","text":"Echo."}"#))
        XCTAssertEqual(m.topBanner?.key, "echo_detected")
        m.apply(object: status("off"))
        XCTAssertEqual(m.phase, "closed")
    }

    func testActivityDrivesClaudeCard() {
        let clock = Clock()
        let m = model(clock)
        m.linkState = .connected
        m.apply(object: status("live", muted: false))
        m.apply(object: ["type": .string("delegation"), "id": .string("a"), "status": .string("sent"), "text": .string("Run the tests")])
        m.apply(object: ["type": .string("activity"), "kind": .string("turn_start"), "text": .string("")])
        XCTAssertEqual(m.claudeCard.kind, "working")
        XCTAssertEqual(m.claudeCard.step, "Thinking")
        XCTAssertEqual(m.requestLine?.text, "Asked: \u{201C}Run the tests\u{201D}")
        m.apply(object: ["type": .string("activity"), "kind": .string("text"), "text": .string("Running the **suite** now.")])
        XCTAssertEqual(m.claudeCard.step, "Running the suite now.")
        m.apply(object: ["type": .string("activity"), "kind": .string("tool"), "text": .string("Bash: npm test")])
        XCTAssertEqual(m.claudeCard.step, "Running the suite now.", "Claude's words win while fresh")
        clock.t.addTimeInterval(21)
        XCTAssertEqual(m.claudeCard.step, "Bash: npm test")
        XCTAssertEqual(m.claudeCard.secondary, true)
        XCTAssertEqual(m.workingTime(at: clock.t), "21 sec")
        m.apply(object: ["type": .string("activity"), "kind": .string("permission"), "text": .string("rm -rf build")])
        XCTAssertTrue(m.attention)
        XCTAssertEqual(m.claudeCard.kind, "approval")
        XCTAssertEqual(m.pageView.word, ViewText.approvalWord)
        XCTAssertEqual(m.pageView.header.label, "Approval needed")
        m.apply(object: ["type": .string("activity"), "kind": .string("turn_end"), "text": .string("Done."), "summary": .string("## Done\n- all green")])
        XCTAssertFalse(m.attention)
        XCTAssertEqual(m.claudeCard.kind, "finished")
        XCTAssertEqual(m.claudeCard.summary, "## Done\n- all green")
        XCTAssertNil(m.workingTime(at: clock.t))
    }

    func testDelegationsKeepLastThree() {
        let m = model()
        for (i, id) in ["a", "b", "c", "d"].enumerated() {
            m.apply(object: ["type": .string("delegation"), "id": .string(id), "status": .string("sent"), "text": .string("t\(i)")])
        }
        m.apply(object: ["type": .string("delegation"), "id": .string("c"), "status": .string("answered")])
        XCTAssertEqual(m.delegations.map(\.id), ["c", "d", "b"])
        XCTAssertEqual(m.delegations.first?.text, "t2")
    }

    func testNoticesAndClears() {
        let m = model()
        m.linkState = .connected
        m.apply(object: status("live", muted: false))
        m.apply(object: ["type": .string("notice"), "level": .string("warn"), "code": .string("cant_hear"), "text": .string("I can't hear you.")])
        XCTAssertEqual(m.topBanner?.action, .switchMic)
        XCTAssertTrue(m.topBanner?.sticky ?? false)
        m.apply(object: ["type": .string("notice"), "level": .string("error"), "code": .string("x"), "text": .string("Broken.")])
        XCTAssertEqual(m.topBanner?.key, "x", "errors go first")
        m.apply(object: ["type": .string("notice_clear"), "code": .string("cant_hear")])
        XCTAssertEqual(m.banners.map(\.key), ["x"])
    }

    func testLiveClosedAndErrorBanners() {
        let m = model()
        m.linkState = .connected
        m.apply(object: status("live", muted: false))
        m.apply(object: ["type": .string("live"), "event": .object(["type": .string("session.closed"), "reason": .string("connection_lost")])])
        XCTAssertEqual(m.topBanner?.text, "The voice connection was lost.")
        m.apply(object: ["type": .string("live"), "event": .object(["type": .string("session.closed"), "reason": .string("expired")])])
        XCTAssertNil(m.banners.first { $0.key == "closed_expired" }, "expiry is routine")
        m.apply(object: ["type": .string("live"), "event": .object(["type": .string("error"), "client_event_id": .string("c1"), "error": .object(["message": .string("x")])])])
        XCTAssertEqual(m.banners.count, 1, "errors tied to a client event are not shown")
        m.apply(object: ["type": .string("live"), "event": .object(["type": .string("session.closed"), "reason": .string("content")])])
        XCTAssertEqual(m.topBanner?.level, "error")
    }

    func testMutePendingAndAck() async {
        let m = model()
        m.linkState = .connected
        m.apply(object: status("live", muted: false))
        var sent: [(String, [String: JSONValue])] = []
        m.sendCommand = { name, args in sent.append((name, args)); return .success(.object(["muted": .bool(true)])) }
        m.toggleMute()
        XCTAssertTrue(m.effectiveMuted, "the wanted value shows at once")
        XCTAssertEqual(m.pageView.floor, "muted")
        await Task.yield(); await Task.yield()
        XCTAssertEqual(sent.first?.0, "mute")
        XCTAssertEqual(sent.first?.1["on"], .bool(true))
        m.apply(object: status("live", muted: true))
        XCTAssertNil(m.mutePending)
        XCTAssertTrue(m.effectiveMuted)
        XCTAssertEqual(m.pageView.header.detail, "Still billing")
    }

    func testMuteFailureRevertsAndShowsError() async {
        let m = model()
        m.linkState = .connected
        m.apply(object: status("live", muted: false))
        m.sendCommand = { _, _ in .failure(CommandError(code: "not_live", message: "sotto: no live session.")) }
        m.toggleMute()
        for _ in 0..<5 { await Task.yield() }
        XCTAssertNil(m.mutePending)
        XCTAssertFalse(m.effectiveMuted)
        XCTAssertEqual(m.topBanner?.text, "sotto: no live session.")
    }

    func testPhases() {
        let m = model()
        XCTAssertEqual(m.phase, "boot")
        XCTAssertEqual(m.pageView.card?.kind, "starting")
        m.linkState = .connected
        m.apply(object: status("connecting"))
        XCTAssertEqual(m.phase, "connecting")
        XCTAssertEqual(m.pageView.steps?.map(\.state), ["done", "done", "active"])
        m.apply(object: status("live", muted: false))
        XCTAssertEqual(m.pageView.word, "Listening")
        m.linkState = .backoff(seconds: 1)
        XCTAssertEqual(m.pageView.card?.kind, "lost")
        m.linkState = .connected
        m.apply(object: status("paused"))
        m.apply(object: ["type": .string("command"), "command": .string("disconnect"), "reason": .string("idle")])
        XCTAssertEqual(m.pageView.card?.title, "Paused after a stretch of silence", "no idle figures in this status")
        m.apply(object: status("paused", lastError: "daily_cap"))
        m.apply(object: ["type": .string("command"), "command": .string("disconnect"), "reason": .string("daily_cap")])
        XCTAssertEqual(m.pageView.card?.kind, "cap")
        m.apply(object: status("sleeping"))
        XCTAssertEqual(m.pageView.card?.kind, "sleeping")
        XCTAssertEqual(m.pageView.card?.title, "Sleeping — just start talking")
        m.wakeMuted = true
        XCTAssertEqual(m.pageView.card?.title, "Sleeping (muted)")
        m.micFailure = "macos"
        m.apply(object: status("paused"))
        XCTAssertEqual(m.pageView.card?.kind, "mic-macos")
        XCTAssertEqual(m.pageView.card?.steps?.count, 3)
    }

    func testHotkeys() {
        let m = model()
        m.linkState = .connected
        m.apply(object: status("live", muted: false))
        var names: [String] = []
        m.sendCommand = { n, _ in names.append(n); return .success(.null) }
        XCTAssertTrue(m.handleKey("m"))
        XCTAssertTrue(m.effectiveMuted)
        XCTAssertFalse(m.handleKey("m", modifiers: true))
        XCTAssertFalse(m.handleKey("m", inTextField: true))
        m.apply(object: status("paused"))
        XCTAssertTrue(m.handleKey(" "))
        XCTAssertFalse(m.handleKey("m"))
        m.apply(object: status("sleeping"))
        XCTAssertTrue(m.handleKey("m"))
        XCTAssertTrue(m.wakeMuted, "M while sleeping mutes local wake listening")
    }

    func testWordHoldHoldsForOnePointThreeSeconds() {
        var h = WordHold()
        XCTAssertNil(h.update(nil, now: 0))
        XCTAssertNil(h.update("you", now: 100))
        XCTAssertNil(h.update("you", now: 1300))
        XCTAssertEqual(h.update("you", now: 1400), "you")
        XCTAssertEqual(h.update(nil, now: 1500), "you")
        XCTAssertEqual(h.update("voice", now: 1600), "you")
        XCTAssertEqual(h.update("voice", now: 2900), "voice")
    }

    func testUsageAndSessionClock() {
        let clock = Clock()
        let m = model(clock)
        m.linkState = .connected
        m.apply(object: status("live", muted: false))
        clock.t.addTimeInterval(125)
        XCTAssertEqual(m.sessionClock(at: clock.t), "2:05")
        m.apply(object: ["type": .string("live"), "event": .object(["type": .string("session.usage.updated"), "usage": .object(["seconds": .number(40)])])])
        XCTAssertEqual(m.todaySeconds(at: clock.t), 630, "today 600 + (40 - 10) fresher seconds")
        XCTAssertEqual(ViewText.formatUsage(m.todaySeconds(at: clock.t)), "10 min · $0.53")
    }

    func testKeySaveNeverKeepsTheKey() async {
        let m = model()
        var got: JSONValue?
        m.sendCommand = { n, a in if n == "key_save" { got = a["key"] }; return .success(.object(["hint": .string("abcd")])) }
        let err = await m.saveKey("  sk-test-123  ")
        XCTAssertNil(err)
        XCTAssertEqual(got, .string("sk-test-123"))
        let mirror = Mirror(reflecting: m).children.compactMap { $0.value as? String }
        XCTAssertFalse(mirror.contains { $0.contains("sk-test") })
    }

    func testNoEmojiInProductStrings() throws {
        let data = try Data(contentsOf: Self.fixtures.appendingPathComponent("viewtext.json"))
        let text = String(decoding: data, as: UTF8.self)
        for s in text.unicodeScalars where s.properties.isEmojiPresentation { XCTFail("emoji in product strings: \(s)") }
        let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/SottoUI")
        let files = FileManager.default.enumerator(atPath: dir.path)?.compactMap { $0 as? String }.filter { $0.hasSuffix(".swift") } ?? []
        XCTAssertFalse(files.isEmpty)
        for f in files {
            let src = try String(contentsOf: dir.appendingPathComponent(f), encoding: .utf8)
            for s in src.unicodeScalars where s.properties.isEmojiPresentation { XCTFail("emoji in \(f): \(s)") }
        }
    }
}

@MainActor
final class SnapshotTests: XCTestCase {
    /// Renders every canned state (light + dark). Writes to design/native/ when
    /// SOTTO_UI_SNAPSHOT_DIR is set (review), else to a temp dir.
    func testRenderAllStates() throws {
        let env = ProcessInfo.processInfo.environment["SOTTO_UI_SNAPSHOT_DIR"]
        let dir = env.map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory.appendingPathComponent("sotto-ui-snap-\(UUID().uuidString)")
        let files = try UISnapshot.render(to: dir)
        XCTAssertEqual(files.count, UISnapshot.states.count * 2)
        for f in files {
            let size = (try FileManager.default.attributesOfItem(atPath: f.path)[.size] as? Int) ?? 0
            XCTAssertGreaterThan(size, 10_000, f.lastPathComponent)
        }
        if env == nil { try? FileManager.default.removeItem(at: dir) }
    }
}
