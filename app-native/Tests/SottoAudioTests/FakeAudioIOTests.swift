import XCTest
@testable import SottoAudio

final class FakeAudioIOTests: XCTestCase {
    final class Sink: @unchecked Sendable {
        let lock = NSLock()
        var frames: [PCMFrame] = []
        func add(_ f: PCMFrame) { lock.lock(); frames.append(f); lock.unlock() }
        var all: [PCMFrame] { lock.lock(); defer { lock.unlock() }; return frames }
    }

    func ramp(_ n: Int, from: Int = 1) -> [Int16] { (0..<n).map { Int16(truncatingIfNeeded: from + $0 * 7) } }

    func testRouteFollowsTheSystemDefaultInputInEveryMode() throws {
        let airpods = AudioDevice(id: "mic-airpods", name: "AirPods Max", bluetooth: true, headphones: false, transport: .bluetooth)
        let builtIn = AudioDevice(id: "mic-builtin", name: "MacBook Pro Microphone", bluetooth: false, headphones: false, transport: .builtIn)
        for listen in [true, false] {
            let fake = FakeAudioIO(options: .init(fixture: []))
            var routes: [AudioRouteInfo] = []
            fake.onRoute = { routes.append($0) }
            try fake.start(listenOnly: listen)
            fake.simulateDefaultInput(airpods.id, inputs: [FakeAudioIO.fakeInput, airpods, builtIn])
            XCTAssertEqual(fake.route?.input, airpods, "a Bluetooth default is used as is")
            XCTAssertEqual(fake.route?.reason, (listen ? "test_listen" : "test") + ",default_changed")
            // Headphones taken off: macOS moves the default to the built-in mic; the route follows at once.
            fake.simulateDefaultInput(builtIn.id, inputs: [builtIn])
            XCTAssertEqual(fake.route?.input, builtIn)
            XCTAssertEqual(fake.route?.reason, (listen ? "test_listen" : "test") + ",device_removed")
            XCTAssertEqual(routes.count, 3)
            // A chosen mic that is still there is kept whatever the default does.
            fake.setPreferredDevices(input: builtIn.id, output: nil)
            fake.simulateDefaultInput(airpods.id, inputs: [airpods, builtIn])
            XCTAssertEqual(fake.route?.input, builtIn)
            XCTAssertEqual(routes.count, 3)
            fake.stop()
        }
    }

    func testRealTimePacing() throws {
        let fake = FakeAudioIO(options: .init(fixture: ramp(24_000 * 3)))
        let sink = Sink()
        fake.onMicFrame = sink.add
        let t0 = Date()
        try fake.start(listenOnly: false)
        Thread.sleep(forTimeInterval: 2.0)
        let elapsed = Date().timeIntervalSince(t0)
        fake.stop()
        let frames = sink.all
        let rate = Double(frames.count - 1) / elapsed
        XCTAssertEqual(rate, 50, accuracy: 1, "frames per second")
        XCTAssertTrue(frames.allSatisfy { $0.samples.count == 960 })
        // Host timestamps advance exactly 20 ms per frame.
        for (a, b) in zip(frames, frames.dropFirst()) { XCTAssertEqual(b.hostTimeNs - a.hostTimeNs, 20_000_000) }
        XCTAssertEqual(fake.route?.mode, nil, "stopped")
    }

    func testFixtureInOrderAfterLead() {
        let fx = ramp(480 * 5, from: 100)
        let fake = FakeAudioIO(options: .init(fixture: fx, leadMs: 40))
        let sink = Sink()
        fake.onMicFrame = sink.add
        for i in 0..<9 { fake.tick(hostNs: UInt64(i) * 20_000_000) }
        let got = sink.all.flatMap { int16Array($0.samples) }
        XCTAssertEqual(Array(got[0..<960]), [Int16](repeating: 0, count: 960), "40 ms lead of silence")
        XCTAssertEqual(Array(got[960..<960 + fx.count]), fx, "fixture content in order")
        XCTAssertTrue(got[(960 + fx.count)...].allSatisfy { $0 == 0 }, "then silence")
        XCTAssertTrue(sink.all.allSatisfy { !$0.muted })
    }

    func testToneWithoutFixture() {
        let fake = FakeAudioIO(env: [:])
        let sink = Sink()
        fake.onMicFrame = sink.add
        for i in 0..<5 { fake.tick(hostNs: UInt64(i) * 20_000_000) }
        let got = sink.all.flatMap { int16Array($0.samples) }
        let pk = got.map { abs(Int($0)) }.max() ?? 0
        XCTAssertGreaterThan(pk, 300)
        XCTAssertLessThan(pk, 1_200, "quiet: below the speech threshold")
    }

    func testMutedSendsZerosFlagged() {
        let fake = FakeAudioIO(options: .init(fixture: ramp(480 * 10)))
        let sink = Sink()
        fake.onMicFrame = sink.add
        fake.tick(hostNs: 0)
        fake.muted = true
        fake.tick(hostNs: 20_000_000)
        fake.tick(hostNs: 40_000_000)
        fake.muted = false
        fake.tick(hostNs: 60_000_000)
        let f = sink.all
        XCTAssertEqual(f.map(\.muted), [false, true, true, false])
        XCTAssertEqual(f[1].samples, Data(count: 960))
        XCTAssertEqual(f[2].samples, Data(count: 960))
        // The fixture timeline kept running while muted.
        XCTAssertEqual(int16Array(f[3].samples).first, ramp(480 * 10)[480 * 3])
    }

    func testOutputWavEqualsEnqueued() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("sotto-fake-out-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: url) }
        let fake = FakeAudioIO(options: .init(outWav: url))
        let pcm = (0..<(480 * 10)).map { i -> Int16 in Int16(truncatingIfNeeded: 1 + (i * 131) % 20000) }  // never 0
        for f in 0..<10 { fake.enqueuePlayback(pcmData(Array(pcm[f * 480..<(f + 1) * 480])), seq: UInt32(f), afterFlush: f == 0) }
        for i in 0..<16 { fake.tick(hostNs: UInt64(i) * 20_000_000) }
        fake.writeOutput()
        let w = try WAV.decode(Data(contentsOf: url))
        XCTAssertEqual(w.sampleRate, 24_000)
        let out = w.samples.map(floatToInt16)
        XCTAssertEqual(out.count, 16 * 480)
        let first = out.firstIndex { $0 != 0 }!
        let last = out.lastIndex { $0 != 0 }!
        XCTAssertEqual(Array(out[first...last]), pcm)
        XCTAssertEqual(fake.stats().playoutSeq, 9)
    }

    func testOutputWrittenOnStopAndEverySecond() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("sotto-fake-out-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: url) }
        let fake = FakeAudioIO(options: .init(outWav: url))
        for i in 0..<49 { fake.tick(hostNs: UInt64(i) * 20_000_000) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        fake.tick(hostNs: 49 * 20_000_000)
        XCTAssertEqual(try WAV.decode(Data(contentsOf: url)).samples.count, 50 * 480, "written after 1 s")
        try fake.start(listenOnly: false)
        Thread.sleep(forTimeInterval: 0.1)
        fake.stop()
        XCTAssertGreaterThan(try WAV.decode(Data(contentsOf: url)).samples.count, 50 * 480, "written on stop")
    }

    func testEchoSimMixesAtGainAfter40ms() {
        var o = FakeAudioIO.Options(env: ["SOTTO_APP_ECHO_SIM_DB": "-10"])
        XCTAssertEqual(Double(o.echoGain ?? 0), 0.3162, accuracy: 0.001)
        o.fixture = [Int16](repeating: 0, count: 480 * 20)
        o.noiseFloor = false  // compare exact samples
        let fake = FakeAudioIO(options: o)
        let sink = Sink()
        fake.onMicFrame = sink.add
        for f in 0..<6 { fake.enqueuePlayback(frame(10_000), seq: UInt32(f), afterFlush: false) }
        for i in 0..<10 { fake.tick(hostNs: UInt64(i) * 20_000_000) }
        let out = fake.recordedOutput
        let mic = sink.all.flatMap { int16Array($0.samples) }
        let outStart = out.firstIndex { $0 != 0 }!
        let micStart = mic.firstIndex { $0 != 0 }!
        XCTAssertEqual(micStart - outStart, 960, "40 ms later")
        XCTAssertEqual(Int(mic[micStart + 100]), 3162, accuracy: 1, "-10 dB")
    }

    func testNoiseFloorKeepsTheSilenceDetectorQuietAndSilenceFixtureTripsIt() {
        final class Flag: @unchecked Sendable { var silent: [Bool] = [] }
        for (env, want) in [([String: String](), [Bool]()), (["SOTTO_APP_MIC_FIXTURE": "silence"], [true])] {
            var o = FakeAudioIO.Options(env: env)
            if env.isEmpty { o.fixture = [] }  // no tone: silence with the floor
            let fake = FakeAudioIO(options: o)
            let flag = Flag()
            let sink = Sink()
            fake.onMicFrame = sink.add
            fake.onMicSilence = { flag.silent.append($0) }
            for i in 0..<200 { fake.tick(hostNs: UInt64(i) * 20_000_000) }
            let exp = expectation(description: "main")
            DispatchQueue.main.async { exp.fulfill() }
            wait(for: [exp], timeout: 2)
            XCTAssertEqual(flag.silent, want, "\(env)")
            let zeros = sink.all.flatMap { int16Array($0.samples) }.allSatisfy { $0 == 0 }
            XCTAssertEqual(zeros, !want.isEmpty)
        }
    }

    func testEchoSimOffByDefault() {
        let fake = FakeAudioIO(options: .init(fixture: [Int16](repeating: 0, count: 480 * 20)))
        let sink = Sink()
        fake.onMicFrame = sink.add
        for f in 0..<6 { fake.enqueuePlayback(frame(10_000), seq: UInt32(f), afterFlush: false) }
        for i in 0..<10 { fake.tick(hostNs: UInt64(i) * 20_000_000) }
        XCTAssertTrue(sink.all.allSatisfy { $0.samples == Data(count: 960) })
    }

    func testPlaySampleGoesToOutputAndCompletes() {
        let fake = FakeAudioIO(options: .init())
        let done = expectation(description: "sample done")
        let wav = WAV.encodePCM16([Int16](repeating: 5000, count: 2400), sampleRate: 24_000)
        fake.playSample(wav) { done.fulfill() }
        // playSample hands off on the fake's queue; tick from a background thread like the timer does.
        DispatchQueue.global().async {
            Thread.sleep(forTimeInterval: 0.05)
            for i in 0..<8 { fake.tick(hostNs: UInt64(i) * 20_000_000) }
        }
        wait(for: [done], timeout: 5)
        let out = fake.recordedOutput
        XCTAssertEqual(out.filter { $0 == 5000 }.count, 2400)
    }

    func testStopSampleStopsThePreviewButNotTheSessionPlayout() {
        // Closing Settings (stopVoicePreview) mid-answer must not cut the model's speech.
        let fake = FakeAudioIO(options: .init())
        let done = expectation(description: "sample completion fires on stop")
        fake.playSample(WAV.encodePCM16([Int16](repeating: 1000, count: 24_000), sampleRate: 24_000)) { done.fulfill() }
        for f in 0..<20 { fake.enqueuePlayback(frame(3000), seq: UInt32(f), afterFlush: false) }
        _ = fake.recordedOutput  // the sample is queued
        for i in 0..<5 { fake.tick(hostNs: UInt64(i) * 20_000_000) }
        fake.stopSample()
        _ = fake.recordedOutput
        for i in 5..<20 { fake.tick(hostNs: UInt64(i) * 20_000_000) }
        wait(for: [done], timeout: 5)
        let out = fake.recordedOutput
        XCTAssertTrue(out.contains(4000), "preview mixed over the answer before the stop")
        XCTAssertEqual(Array(out.suffix(480 * 5)).filter { $0 == 3000 }.count, 480 * 5, "the answer keeps playing alone after the stop")
    }

    func testRouteAndDevices() throws {
        let fake = FakeAudioIO(env: [:])
        var routes: [AudioRouteInfo] = []
        fake.onRoute = { routes.append($0) }
        try fake.start(listenOnly: false)
        try fake.start(listenOnly: false)
        fake.stop()
        XCTAssertEqual(routes.count, 1, "start is idempotent")
        XCTAssertEqual(routes.first?.mode, .fake)
        XCTAssertEqual(fake.inputDevices().count, 1)
    }

    func testMicFixtureFromEnvResamples() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("sotto-fx-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: url) }
        let s48 = (0..<48_000).map { Int16(8000 * sin(2 * Double.pi * 500 * Double($0) / 48_000)) }
        var d = WAV.encodePCM16(s48, sampleRate: 48_000)
        _ = d.count
        try d.write(to: url)
        d = Data()
        let o = FakeAudioIO.Options(env: ["SOTTO_APP_MIC_FIXTURE": url.path, "SOTTO_APP_MIC_FIXTURE_LEAD_MS": "250"])
        XCTAssertEqual(o.leadMs, 250)
        XCTAssertEqual(Double(o.fixture?.count ?? 0), 24_000, accuracy: 48)
    }

    func testMicQueueSpeaksDroppedClipsInOrderOverSilence() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("sotto-micq-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let a = [Int16](repeating: 3000, count: 480 * 2), b = [Int16](repeating: -2000, count: 480)
        try WAV.encodePCM16(a).write(to: dir.appendingPathComponent("01-a.wav"))
        try WAV.encodePCM16(b).write(to: dir.appendingPathComponent("02-b.wav"))
        var o = FakeAudioIO.Options(env: ["SOTTO_APP_MIC_QUEUE_DIR": dir.path])
        XCTAssertEqual(o.micQueueDir?.path, dir.path)
        XCTAssertTrue(o.noiseFloor, "the app's test mode never sends exact zeros")
        o.noiseFloor = false  // compare exact samples
        let fake = FakeAudioIO(options: o)
        let sink = Sink()
        fake.onMicFrame = sink.add
        final class Events: @unchecked Sendable { var list: [String] = [] }
        let ev = Events()
        fake.onTestEvent = { name, f in ev.list.append("\(name):\(f["name"] as? String ?? ""):\(f["phase"] as? String ?? "")") }
        for i in 0..<10 { fake.tick(hostNs: UInt64(i) * 20_000_000) }
        let got = sink.all.flatMap { int16Array($0.samples) }
        // Polled on the 5th tick: silence (no tone) before, then a, then b, then silence.
        XCTAssertTrue(got[0..<(480 * 4)].allSatisfy { $0 == 0 }, "silence, not the tone, in queue mode")
        XCTAssertEqual(Array(got[(480 * 4)..<(480 * 6)]), a)
        XCTAssertEqual(Array(got[(480 * 6)..<(480 * 7)]), b)
        XCTAssertTrue(got[(480 * 7)...].allSatisfy { $0 == 0 })
        XCTAssertEqual(ev.list, ["mic_clip:01-a.wav:start", "mic_clip:01-a.wav:end", "mic_clip:02-b.wav:start", "mic_clip:02-b.wav:end"])
        let left = try FileManager.default.contentsOfDirectory(atPath: dir.path).sorted()
        XCTAssertEqual(left, ["01-a.wav.taken", "02-b.wav.taken"], "each clip is taken once")
    }

    func testOutputSpeechEventsAndFlush() {
        let fake = FakeAudioIO(options: .init(fixture: []))
        final class Events: @unchecked Sendable { var list: [(String, [String: Any])] = [] }
        let ev = Events()
        fake.onTestEvent = { name, f in ev.list.append((name, f)) }
        for f in 0..<5 { fake.enqueuePlayback(pcmData([Int16](repeating: 5000, count: 480)), seq: UInt32(f), afterFlush: f == 0) }
        for i in 0..<30 { fake.tick(hostNs: UInt64(i) * 20_000_000) }
        let speech = ev.list.filter { $0.0 == "out_speech" }.map { $0.1["phase"] as? String ?? "" }
        XCTAssertEqual(speech, ["start", "end"], "one onset, ended by 300 ms of quiet")
        fake.flushPlayback()
        _ = fake.recordedOutput  // drains the fake's queue
        XCTAssertEqual(ev.list.last?.0, "playout_flush")
    }
}
