import XCTest
@testable import SottoClient

/// Thread-safe recorder for callbacks.
final class Box<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [T] = []
    func add(_ x: T) { lock.lock(); items.append(x); lock.unlock() }
    var all: [T] { lock.lock(); defer { lock.unlock() }; return items }
    func clear() { lock.lock(); items.removeAll(); lock.unlock() }
}

/// LinkClient + AudioPump against the in-process MockDaemon. No devices, no internet.
final class LinkClientTests: XCTestCase {
    var mock: MockDaemon!
    var dataDir: String!
    let cbq = DispatchQueue(label: "test.callbacks")

    override func setUpWithError() throws {
        mock = try MockDaemon()
        dataDir = FileManager.default.temporaryDirectory.appendingPathComponent("sotto-link-\(UUID().uuidString)").path
        try FileManager.default.createDirectory(atPath: dataDir, withIntermediateDirectories: true)
        try "\(mock.port)\n".write(toFile: dataDir + "/daemon.port", atomically: true, encoding: .utf8)
        try "\(mock.pageSecret)\n".write(toFile: dataDir + "/page.secret", atomically: true, encoding: .utf8)
    }

    override func tearDown() {
        mock.stop()
        try? FileManager.default.removeItem(atPath: dataDir)
    }

    func makeClient(policy: ReconnectPolicy = ReconnectPolicy(steps: [0.05, 0.1], steady: 0.1, window: 5),
                    tweak: (inout LinkClient.Config) -> Void = { _ in }) -> (LinkClient, Box<LinkState>, Box<ServerMessage>) {
        var c = LinkClient.Config(version: "0.3.0", build: "srcHash", test: true)
        c.policy = policy
        c.callbackQueue = cbq
        tweak(&c)
        let link = LinkClient(config: c)
        let states = Box<LinkState>(), msgs = Box<ServerMessage>()
        link.onState = { states.add($0) }
        link.onMessage = { msgs.add($0) }
        addTeardownBlock { link.close() }
        return (link, states, msgs)
    }

    func wait(_ what: String, timeout: Double = 5, _ cond: @escaping () -> Bool) {
        let end = Date().addingTimeInterval(timeout)
        while !cond() {
            if Date() > end { XCTFail("timed out waiting for \(what)"); return }
            Thread.sleep(forTimeInterval: 0.01)
        }
    }

    func launch(code: String? = nil) -> LaunchRequest { LaunchRequest(port: mock.port, code: code, dataDir: dataDir) }

    // MARK: handshake

    func testLaunchCodeBootstrapHelloWelcome() throws {
        let code = "0123456789abcdef0123456789abcdef"
        mock.launchCodes = [code]
        let (link, states, msgs) = makeClient()
        link.connect(launch(code: code))
        wait("connected") { link.isConnected }
        XCTAssertEqual(mock.boots.first?.headers["x-sotto-launch"], code)
        XCTAssertNil(mock.boots.first?.headers["origin"])
        let up = try XCTUnwrap(mock.upgrades.first)
        XCTAssertEqual(up.headers["x-sotto-page"], mock.pageToken)
        XCTAssertEqual(up.headers["sec-websocket-protocol"], "sotto-native.v1")
        XCTAssertEqual(up.headers["host"], "127.0.0.1:\(mock.port)")
        XCTAssertNil(up.headers["origin"], "no Origin: the daemon refuses every browser by it")
        let hello = try XCTUnwrap(mock.texts(ofType: "hello").first)
        XCTAssertEqual(hello["protocol"] as? Int, 1)
        XCTAssertEqual(hello["client"] as? String, "app")
        XCTAssertEqual(hello["build"] as? String, "srcHash")
        XCTAssertEqual(hello["test"] as? Bool, true)
        XCTAssertEqual(hello["capabilities"] as? [String], ["native_audio"])
        XCTAssertEqual(mock.texts.first?["type"] as? String, "hello", "hello is the first text frame")
        wait("state callbacks") { states.all.last == .connected }
        XCTAssertEqual(Array(states.all.prefix(3)), [.bootstrapping, .connecting, .connected])
        wait("welcome delivered") { msgs.all.contains { $0.type == "welcome" } }
        XCTAssertEqual(link.welcome?.settingsPayload?.voices?.current, "marin")

        mock.sendJSON(["type": "status", "status": ["state": "live", "live": ["session_id": "s1", "muted": false]]])
        wait("status") { msgs.all.contains { if case .status(let s) = $0 { return s.state == "live" }; return false } }
    }

    func testPageSecretFromDataDirWhenNoCode() {
        let (link, _, _) = makeClient()
        link.connect(launch())
        wait("connected") { link.isConnected }
        XCTAssertEqual(mock.boots.first?.headers["x-sotto-boot"], mock.pageSecret)
        XCTAssertNil(mock.boots.first?.headers["x-sotto-launch"])
    }

    func testPingPongAutomatic() {
        let (link, _, _) = makeClient()
        link.connect(launch())
        wait("connected") { link.isConnected }
        mock.sendJSON(["type": "ping", "t": 1790000000123])
        wait("pong") { !self.mock.texts(ofType: "pong").isEmpty }
        XCTAssertEqual(mock.texts(ofType: "pong").first?["t"] as? Int, 1790000000123)
    }

    // MARK: commands

    func testCommandRoundTripErrorAndTimeout() async {
        let (link, _, _) = makeClient { $0.commandTimeout = 0.3 }
        mock.onCmd = { id, name, args in
            switch name {
            case "mute": return ["type": "result", "id": id, "ok": true, "data": ["muted": args["on"] as? Bool ?? false]]
            case "set_voice": return ["type": "result", "id": id, "ok": false, "error": ["code": "bad_voice", "message": "Unknown voice"]]
            default: return nil  // never answers
            }
        }
        // Before connect: fails fast.
        let early = await link.command("mute", args: ["on": true])
        XCTAssertEqual(early, .failure(CommandFailure(code: "not_connected", message: "Sotto is not connected to its daemon.")))
        link.connect(launch())
        wait("connected") { link.isConnected }
        let ok = await link.command("mute", args: ["on": true])
        XCTAssertEqual(ok, .success(["muted": true]))
        let bad = await link.command("set_voice", args: ["voice": "nope"])
        XCTAssertEqual(bad, .failure(CommandFailure(code: "bad_voice", message: "Unknown voice")))
        let slow = await link.command("pause")
        guard case .failure(let f) = slow else { return XCTFail() }
        XCTAssertEqual(f.code, "timeout")
        let cmds = mock.texts(ofType: "cmd")
        XCTAssertEqual(cmds.map { $0["name"] as? String }, ["mute", "set_voice", "pause"])
        XCTAssertEqual(Set(cmds.compactMap { $0["id"] as? String }).count, 3, "ids are unique")
    }

    func testPendingCommandFailsWhenLinkDrops() async {
        let (link, _, _) = makeClient()
        link.connect(launch())
        wait("connected") { link.isConnected }
        mock.onCmd = { [mock] _, _, _ in mock!.killClient(); return nil }
        let r = await link.command("pause")
        guard case .failure(let f) = r else { return XCTFail() }
        XCTAssertEqual(f.code, "link_lost")
    }

    func testVoicePreviewUsesPageToken() async throws {
        let (link, _, _) = makeClient()
        do { _ = try await link.fetchVoicePreview("marin"); XCTFail("needs a token") } catch let e as CommandFailure {
            XCTAssertEqual(e.code, "not_connected")
        }
        link.connect(launch())
        wait("connected") { link.isConnected }
        let wav = try await link.fetchVoicePreview("marin")
        XCTAssertEqual(wav, mock.previewWav)
        do { _ = try await link.fetchVoicePreview("nope"); XCTFail() } catch let e as CommandFailure {
            XCTAssertEqual(e, CommandFailure(code: "bad_voice", message: "Unknown voice"))
        }
    }

    // MARK: reconnect policy

    func testDaemonExitReconnectsWithPageSecret() {
        let code = "0123456789abcdef0123456789abcdef"
        mock.launchCodes = [code]
        let (link, _, _) = makeClient()
        link.connect(launch(code: code))
        wait("connected") { link.isConnected }
        mock.closeClient(code: 4005, reason: "daemon_exit")
        wait("reconnected") { self.mock.texts(ofType: "hello").count == 2 && link.isConnected }
        // The one-time launch code is not reused; the page secret from the first bootstrap is.
        XCTAssertEqual(mock.boots.count, 2)
        XCTAssertEqual(mock.boots[1].headers["x-sotto-boot"], mock.pageSecret)
        XCTAssertNil(mock.boots[1].headers["x-sotto-launch"])
        XCTAssertEqual(link.counters.connects, 2)
    }

    func testRestartedDaemonNewSecretRereadsFile() throws {
        let (link, _, _) = makeClient()
        link.connect(launch())
        wait("connected") { link.isConnected }
        // The daemon "restarts": new token and secret, written to page.secret.
        mock.pageSecret = "sec-new"
        mock.pageToken = "tok-new"
        try "sec-new\n".write(toFile: dataDir + "/page.secret", atomically: true, encoding: .utf8)
        mock.killClient()
        wait("reconnected with the new secret", timeout: 8) { link.isConnected && self.mock.upgrades.count == 2 }
        XCTAssertTrue(mock.rejections.contains("bad_secret"), "the stale in-memory secret was tried and refused first")
        XCTAssertEqual(mock.boots.last?.headers["x-sotto-boot"], "sec-new")
        XCTAssertEqual(mock.upgrades.last?.headers["x-sotto-page"], "tok-new")
    }

    // MARK: credential hardening (rev-security)

    func testRefusedLaunchCodeNeverFallsBackToPageSecret() {
        // A made-up code (any web page can fire sotto://open?k=...) must not
        // turn into a page.secret bootstrap.
        let (link, states, _) = makeClient()
        link.connect(launch(code: "deadbeefdeadbeefdeadbeefdeadbeef"))
        wait("failed launch_refused") { states.all.last == .failed("launch_refused") }
        Thread.sleep(forTimeInterval: 0.4)
        XCTAssertEqual(mock.boots.count, 1)
        XCTAssertNil(mock.boots.first?.headers["x-sotto-boot"])
        XCTAssertTrue(mock.upgrades.isEmpty)
    }

    func testBogusCodeDoesNotDropAWorkingLink() {
        let (link, _, _) = makeClient()
        link.connect(launch())
        wait("connected") { link.isConnected }
        link.connect(launch(code: "deadbeefdeadbeefdeadbeefdeadbeef"))
        wait("code tried") { self.mock.boots.count == 2 }
        Thread.sleep(forTimeInterval: 0.4)
        XCTAssertTrue(link.isConnected)
        XCTAssertEqual(mock.upgrades.count, 1, "the working link was kept")
    }

    func testValidCodeWhileConnectedReconnects() {
        let code = "0123456789abcdef0123456789abcdef"
        mock.launchCodes = [code]
        let (link, _, _) = makeClient()
        link.connect(launch())
        wait("connected") { link.isConnected }
        link.connect(launch(code: code))
        wait("reconnected") { link.isConnected && self.mock.upgrades.count == 2 }
        XCTAssertEqual(mock.boots.last?.headers["x-sotto-launch"], code)
    }

    func testNoCredentialsWhenDaemonPortFileGone() throws {
        let (link, _, _) = makeClient()
        link.connect(launch())
        wait("connected") { link.isConnected }
        // The daemon exits (it removes daemon.port); something else may take the port.
        try FileManager.default.removeItem(atPath: dataDir + "/daemon.port")
        mock.killClient()
        Thread.sleep(forTimeInterval: 0.8)
        XCTAssertEqual(mock.boots.count, 1, "no secret sent to a port no daemon records")
        XCTAssertFalse(link.isConnected)
        try "\(mock.port)\n".write(toFile: dataDir + "/daemon.port", atomically: true, encoding: .utf8)
        wait("reconnected once the daemon records the port again") { link.isConnected }
    }

    func testReplacedDoesNotRetry() {
        let (link, states, _) = makeClient()
        link.connect(launch())
        wait("connected") { link.isConnected }
        mock.closeClient(code: 4002, reason: "replaced")
        wait("failed replaced") { states.all.last == .failed("replaced") }
        Thread.sleep(forTimeInterval: 0.5)
        XCTAssertEqual(mock.texts(ofType: "hello").count, 1)
        XCTAssertEqual(link.state, .failed("replaced"))
    }

    func testProtocolMismatchDoesNotRetry() {
        mock.welcomeProtocol = 2
        let (link, states, _) = makeClient()
        link.connect(launch())
        wait("failed protocol") { states.all.last == .failed("protocol_mismatch") }
        Thread.sleep(forTimeInterval: 0.4)
        XCTAssertEqual(mock.texts(ofType: "hello").count, 1)
        XCTAssertFalse(link.isConnected)
    }

    func testWelcomeTimeoutRetries() {
        mock.autoWelcome = false
        let (link, _, _) = makeClient { $0.welcomeTimeout = 0.3 }
        link.connect(launch())
        wait("second hello after welcome timeout") { self.mock.texts(ofType: "hello").count >= 2 }
        mock.autoWelcome = true
        wait("connected eventually") { link.isConnected }
    }

    func testSilentDaemonIsDetected() {
        let (link, _, _) = makeClient { $0.silenceTimeout = 0.4 }
        link.connect(launch())
        wait("connected") { link.isConnected }
        // No pings from the mock: after 0.4 s the client declares the link dead and reconnects.
        wait("reconnect after silence") { self.mock.texts(ofType: "hello").count >= 2 }
    }

    func testGivesUpAfterWindow() {
        let (link, states, _) = makeClient(policy: ReconnectPolicy(steps: [0.05], steady: 0.1, window: 0.5))
        mock.stop()
        link.connect(launch())
        wait("gave up") { states.all.last == .failed("unreachable") }
        XCTAssertTrue(states.all.contains { if case .backoff = $0 { return true }; return false })
        // A new connect (next sotto://open) starts over.
        XCTAssertEqual(link.state, .failed("unreachable"))
    }

    func testCloseStopsEverything() {
        let (link, states, _) = makeClient()
        link.connect(launch())
        wait("connected") { link.isConnected }
        link.close()
        wait("idle") { states.all.last == .idle }
        Thread.sleep(forTimeInterval: 0.3)
        XCTAssertEqual(mock.texts(ofType: "hello").count, 1)
    }

    // MARK: audio pump

    struct Played: Equatable { var seq: UInt32; var afterFlush: Bool; var first: UInt8 }

    func makePump(_ link: LinkClient, stats: AudioStatsMessage? = nil) -> (AudioPump, Box<AudioPump.Capture>, Box<Played>, Box<String>) {
        let caps = Box<AudioPump.Capture>(), played = Box<Played>(), flushes = Box<String>()
        let order = Box<String>()
        let pump = AudioPump(link: link, fake: true, hooks: .init(
            setCapture: { caps.add($0) },
            play: { pcm, seq, af in played.add(Played(seq: seq, afterFlush: af, first: pcm.first ?? 0)); order.add("play\(seq)") },
            flush: { flushes.add($0); order.add("flush") },
            stats: { stats }))
        _ = order
        return (pump, caps, played, flushes)
    }

    func pcm(_ fill: UInt8) -> Data { Data(repeating: fill, count: NativeProtocol.frameBytes) }

    func testUplinkContinuousSeqMutedAndGating() {
        mock.welcomeStatus = ["state": "live", "live": ["session_id": "s1", "muted": false]]
        let (link, _, _) = makeClient()
        let (pump, caps, _, _) = makePump(link)
        pump.pushMic(samples: pcm(1), hostTimeNs: 1, muted: false)   // before connect: gated
        XCTAssertEqual(pump.counters.micGated, 1)
        link.connect(launch())
        wait("connected") { link.isConnected }
        wait("capture full") { caps.all.last == .full }
        for i in 0..<50 {
            pump.pushMic(samples: pcm(7), hostTimeNs: UInt64(1_000 + i), muted: i >= 45)
            Thread.sleep(forTimeInterval: 0.002)
        }
        pump.pushMic(samples: Data(count: 100), hostTimeNs: 0, muted: false)  // wrong size: never sent
        wait("50 frames") { self.mock.mic.count == 50 }
        let f = mock.mic
        XCTAssertEqual(f.map(\.seq), Array(0..<50), "seq from 0, in order")
        XCTAssertEqual(f[0].timestampNs, 1_000)
        XCTAssertTrue(f.allSatisfy { $0.flags.contains(.fake) })
        XCTAssertTrue(f.prefix(45).allSatisfy { !$0.flags.contains(.muted) && $0.pcm == self.pcm(7) })
        XCTAssertTrue(f.suffix(5).allSatisfy { $0.flags.contains(.muted) && $0.pcm == Data(count: 960) }, "muted frames are zeros")
        XCTAssertEqual(pump.counters.micBadSize, 1)

        // Local mute (before the daemon confirms) and daemon-side live.muted both zero the payload.
        pump.localMute = true
        pump.pushMic(samples: pcm(9), hostTimeNs: 0, muted: false)
        pump.localMute = false
        mock.sendJSON(["type": "status", "status": ["state": "live", "live": ["session_id": "s1", "muted": true]]])
        Thread.sleep(forTimeInterval: 0.1)
        pump.pushMic(samples: pcm(9), hostTimeNs: 0, muted: false)
        wait("52 frames") { self.mock.mic.count == 52 }
        XCTAssertTrue(mock.mic.suffix(2).allSatisfy { $0.pcm == Data(count: 960) && $0.flags.contains(.muted) })

        // paused: capture off, frames gated.
        mock.sendJSON(["type": "status", "status": ["state": "paused", "live": NSNull()]])
        wait("capture off") { caps.all.last == .off }
        pump.pushMic(samples: pcm(1), hostTimeNs: 0, muted: false)
        // sleeping: listen-only, frames flow again (the daemon's wake VAD).
        mock.sendJSON(["type": "status", "status": ["state": "sleeping", "live": NSNull()]])
        wait("capture listen") { caps.all.last == .listen }
        pump.pushMic(samples: pcm(3), hostTimeNs: 0, muted: false)
        wait("53 frames") { self.mock.mic.count == 53 }
        XCTAssertEqual(mock.mic.last?.pcm, pcm(3))
        XCTAssertEqual(caps.all, [.full, .off, .listen])
    }

    func testMicSeqRestartsPerConnection() {
        mock.welcomeStatus = ["state": "live"]
        let (link, _, _) = makeClient()
        let (pump, _, _, _) = makePump(link)
        link.connect(launch())
        wait("connected") { link.isConnected }
        for _ in 0..<3 { pump.pushMic(samples: pcm(1), hostTimeNs: 0, muted: false) }
        wait("3 frames") { self.mock.mic.count == 3 }
        mock.closeClient(code: 4005)
        wait("reconnected") { self.mock.texts(ofType: "hello").count == 2 && link.isConnected }
        Thread.sleep(forTimeInterval: 0.05)
        pump.pushMic(samples: pcm(2), hostTimeNs: 0, muted: false)
        wait("4 frames") { self.mock.mic.count == 4 }
        XCTAssertEqual(mock.mic.map(\.seq), [0, 1, 2, 0])
    }

    func testDownlinkOrderAndFlush() {
        mock.welcomeStatus = ["state": "live"]
        let (link, _, _) = makeClient()
        let (pump, _, played, flushes) = makePump(link)
        defer { withExtendedLifetime(pump) {} }
        link.connect(launch())
        wait("connected") { link.isConnected }
        for s in 0..<20 { mock.sendSpeaker(WireFrame(kind: .speaker, seq: UInt32(s), timestampNs: 0, pcm: pcm(UInt8(s)))) }
        mock.sendJSON(["type": "audio_flush", "reason": "voice_change"])
        mock.sendSpeaker(WireFrame(kind: .speaker, flags: [.afterFlush], seq: 20, timestampNs: 0, pcm: pcm(99)))
        // A mic-kind frame from the daemon is ignored (counted), never played.
        mock.sendSpeaker(WireFrame(kind: .mic, seq: 0, timestampNs: 0, pcm: pcm(1)))
        wait("21 frames + flush") { played.all.count == 21 && flushes.all.count == 1 }
        XCTAssertEqual(played.all.map(\.seq), Array(0...20))
        XCTAssertEqual(played.all.map(\.first).prefix(20), ArraySlice((0..<20).map { UInt8($0) }))
        XCTAssertEqual(played.all.last, Played(seq: 20, afterFlush: true, first: 99))
        XCTAssertEqual(flushes.all, ["voice_change"])
        wait("bad frame counted") { link.counters.badFrames == 1 }
    }

    func testFlushIsOrderedBeforeFollowingFrames() {
        mock.welcomeStatus = ["state": "live"]
        let (link, _, _) = makeClient()
        let order = Box<String>()
        let pump = AudioPump(link: link, fake: true, hooks: .init(
            setCapture: { _ in }, play: { _, seq, _ in order.add("p\(seq)") }, flush: { _ in order.add("flush") }, stats: { nil }))
        _ = pump
        link.connect(launch())
        wait("connected") { link.isConnected }
        mock.sendSpeaker(WireFrame(kind: .speaker, seq: 0, timestampNs: 0, pcm: pcm(1)))
        mock.sendJSON(["type": "audio_flush", "reason": "session_end"])
        mock.sendSpeaker(WireFrame(kind: .speaker, flags: [.afterFlush], seq: 1, timestampNs: 0, pcm: pcm(1)))
        wait("3 events") { order.all.count == 3 }
        XCTAssertEqual(order.all, ["p0", "flush", "p1"])
    }

    func testCloseWindowStopsCaptureAndStatsFlow() {
        mock.welcomeStatus = ["state": "live"]
        let (link, _, _) = makeClient()
        let stats = AudioStatsMessage(playoutSeq: 5, playoutHostNs: 42, bufferMs: 60, underruns: 0, overruns: 0,
                                      captureDrops: 0, mode: "fake", micSeq: 0)
        let (pump, caps, _, _) = makePump(link, stats: stats)
        pump.statsInterval = 0.1
        link.connect(launch())
        wait("full") { caps.all.last == .full }
        pump.pushMic(samples: pcm(1), hostTimeNs: 0, muted: false)
        wait("stats") { self.mock.texts(ofType: "audio_stats").count >= 2 }
        let s = mock.texts(ofType: "audio_stats").last!
        XCTAssertEqual(s["playout_seq"] as? Int, 5)
        XCTAssertEqual(s["mode"] as? String, "fake")
        XCTAssertEqual(s["mic_seq"] as? Int, 1)
        mock.sendJSON(["type": "command", "command": "close_window", "reason": "off"])
        wait("off") { caps.all.last == .off }
    }

    func testLinkLossKeepsCaptureDuringBackoffThenReleases() {
        mock.welcomeStatus = ["state": "live"]
        let (link, states, _) = makeClient(policy: ReconnectPolicy(steps: [0.3], steady: 0.3, window: 0.5))
        let (pump, caps, _, _) = makePump(link)
        link.connect(launch())
        wait("full") { caps.all.last == .full }
        mock.stop()
        wait("backoff") { states.all.contains { if case .backoff = $0 { return true }; return false } }
        XCTAssertEqual(caps.all.last, .full, "a short loss keeps the engine for the daemon's grace")
        pump.pushMic(samples: pcm(1), hostTimeNs: 0, muted: false)
        XCTAssertGreaterThanOrEqual(pump.counters.micGated, 1, "no uplink while the link is down")
        wait("gave up") { states.all.last == .failed("unreachable") }
        wait("released") { caps.all.last == .off }
    }
}

final class LinkSelfTestTests: XCTestCase {
    func testSelfTestAgainstMock() throws {
        let mock = try MockDaemon()
        defer { mock.stop() }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("sotto-st-\(UUID().uuidString)").path
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let r0 = LinkSelfTest.run(port: mock.port, dataDir: dir, version: "0.3.0", build: nil, timeout: 2)
        XCTAssertEqual(r0["error"], "port_not_recorded")
        try "\(mock.port)".write(toFile: dir + "/daemon.port", atomically: true, encoding: .utf8)
        try mock.pageSecret.write(toFile: dir + "/page.secret", atomically: true, encoding: .utf8)
        let r = LinkSelfTest.run(port: mock.port, dataDir: dir, version: "0.3.0", build: nil, timeout: 5)
        XCTAssertEqual(r["ok"], true, LinkSelfTest.json(r))
        XCTAssertEqual(r["status_state"], "connecting")
        XCTAssertEqual(r["protocol"], 1)
        XCTAssertEqual(r["settings"], true)
        XCTAssertTrue(LinkSelfTest.json(r).hasPrefix("{\"connects\":1,"))
    }
}
