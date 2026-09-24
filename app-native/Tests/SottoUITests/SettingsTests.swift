import XCTest
@testable import SottoUI
@testable import SottoClient

// Silent: no devices, no network, no TCC prompts, no login items. Commands go to a recorder.

private func key(_ o: [String: Any]) -> PageStatus.Key {
    var base: [String: Any] = ["present": false, "source": NSNull(), "file": NSNull(), "hint": NSNull(), "label": NSNull(),
                               "can_change": true, "can_remove": false, "keychain": true, "setup": false]
    for (k, v) in o { base[k] = v }
    let d = try! JSONSerialization.data(withJSONObject: base)
    return try! JSONDecoder().decode(PageStatus.Key.self, from: d)
}

private func fixtureURL(_ name: String) -> URL {
    // app-native/Tests/SottoUITests/<file> -> repo root/test/fixtures/native/<name>
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("test/fixtures/native/\(name)")
}

@MainActor
final class SettingsTextTests: XCTestCase {
    // Same inputs and expectations as test/web/view.test.js "keySettingsView".
    func testKeyRowMatchesPage() {
        XCTAssertEqual(SettingsText.keyRow(nil).text, "Checking…")
        let none = SettingsText.keyRow(key([:]))
        XCTAssertEqual([none.text, none.changeLabel], ["No key yet", "Add key"])
        XCTAssertEqual([none.change, none.remove], [true, false])
        let kc = SettingsText.keyRow(key(["present": true, "source": "keychain", "hint": "wxyz", "label": "the macOS Keychain", "can_remove": true]))
        XCTAssertEqual(kc.text, "Key ending in wxyz")
        XCTAssertEqual([kc.change, kc.remove], [true, true])
        XCTAssertEqual(kc.help, "Saved in your macOS Keychain.")
        let env = SettingsText.keyRow(key(["present": true, "source": "env", "hint": "abcd", "label": "the OPENAI_API_KEY environment variable", "can_change": false]))
        XCTAssertEqual([env.change, env.remove], [false, false])
        XCTAssertTrue(env.help.contains("Change it there"))
        let uc = SettingsText.keyRow(key(["present": true, "source": "user_config", "hint": "abcd", "label": "the plugin settings"]))
        XCTAssertTrue(uc.help.contains("replaces it"))
    }

    // Same cases as test/web/view.test.js "keyCardView" (page phase -> daemon state).
    func testKeyCardMatchesPage() {
        XCTAssertNil(SettingsText.keyCard(state: "live", key: key(["setup": true]), lastErrorCode: nil))
        XCTAssertNil(SettingsText.keyCard(state: "paused", key: key([:]), lastErrorCode: nil))
        let first = SettingsText.keyCard(state: "paused", key: key(["setup": true]), lastErrorCode: nil)
        XCTAssertEqual(first?.title, "Add your OpenAI API key to start")
        XCTAssertEqual(first?.keyInput, true)
        XCTAssertTrue(first?.body.contains("platform.openai.com/api-keys") ?? false)
        let replace = SettingsText.keyCard(state: "off", key: key(["setup": true, "present": true, "source": "keychain", "hint": "wxyz", "label": "the macOS Keychain", "can_remove": true]), lastErrorCode: nil)
        XCTAssertEqual(replace?.title, "Replace your OpenAI API key")
        XCTAssertTrue(replace?.body.contains("ending in wxyz") ?? false)
        let rejected = SettingsText.keyCard(state: "paused", key: key(["present": true, "source": "keychain", "hint": "wxyz"]), lastErrorCode: "openai_auth")
        XCTAssertEqual(rejected?.title, "OpenAI rejected your API key")
        XCTAssertEqual(rejected?.keyInput, true)
        XCTAssertNil(SettingsText.keyCard(state: "paused", key: key(["present": true, "source": "dotenv", "can_change": false]), lastErrorCode: "openai_auth"))
        let outside = SettingsText.keyCard(state: "off", key: key(["setup": true, "present": true, "source": "dotenv", "file": "/p/.env", "hint": "abcd", "can_change": false]), lastErrorCode: nil)
        XCTAssertEqual(outside?.keyInput, false)
        XCTAssertTrue(outside?.body.contains("/p/.env") ?? false)
        let noKc = SettingsText.keyCard(state: "paused", key: key(["keychain": false, "can_change": false]), lastErrorCode: "no_api_key")
        XCTAssertEqual(noKc?.keyInput, false)
        XCTAssertTrue(noKc?.body.contains("OPENAI_API_KEY") ?? false)
    }

    func testKeyInputShape() {
        XCTAssertNotNil(SettingsText.keyInputProblem("   "))
        XCTAssertNotNil(SettingsText.keyInputProblem("hello"))
        XCTAssertNotNil(SettingsText.keyInputProblem("sk-abc def ghi jkl mno pqr"))
        XCTAssertNil(SettingsText.keyInputProblem("  sk-test-0123456789abcdefghij \n"))
    }

    // web/echo.js echoTestVerdict strings.
    func testEchoVerdicts() {
        XCTAssertEqual(SettingsText.echoVerdict("high").title, "Heavy echo")
        XCTAssertEqual(SettingsText.echoVerdict("heavy").level, "heavy")
        XCTAssertEqual(SettingsText.echoVerdict("some").advice, "Echo cancellation catches most of it and Sotto filters the rest. Headphones are best.")
        XCTAssertEqual(SettingsText.echoVerdict("low").title, "Good")
        XCTAssertEqual(SettingsText.echoVerdict(nil).title, "Not sure")
        XCTAssertEqual(SettingsText.echoSummary(running: false, verdict: nil, error: nil, headphones: true), "Headphones: no echo to worry about.")
        XCTAssertEqual(SettingsText.echoSummary(running: false, verdict: nil, error: nil, headphones: false), "Not tested on this speaker yet.")
        XCTAssertEqual(SettingsText.echoSummary(running: true, verdict: nil, error: nil, headphones: false), "Listening for the speaker…")
        XCTAssertEqual(SettingsText.echoGuard(mode: "off", heardMsAgo: nil), "Echo guard: off.")
        XCTAssertEqual(SettingsText.echoGuard(mode: "on", heardMsAgo: nil), "Echo guard: always on.")
        XCTAssertEqual(SettingsText.echoGuard(mode: "auto", heardMsAgo: nil), "Echo guard: automatic, not needed now.")
        XCTAssertTrue(SettingsText.echoGuard(mode: "auto", heardMsAgo: 3000).hasPrefix("Echo guard: on"))
    }

    // web/app.js POLICY_HELP.
    func testPolicyHelp() {
        XCTAssertEqual(SettingsText.policyHelp("quiet"), "Speaks only when you talk to it.")
        XCTAssertEqual(SettingsText.policyHelp("milestones"), "Mentions finished work, approvals and errors.")
        XCTAssertEqual(SettingsText.policyHelp("walkthrough"), "Narrates Claude's progress as it goes.")
    }

    func testOnboardingOrder() {
        let needsKey = SettingsSnapshots.decodeStatus(["state": "paused", "key": ["present": false, "keychain": true, "can_change": true, "setup": true]])
        let fine = SettingsSnapshots.decodeStatus(["state": "live"])
        XCTAssertEqual(SettingsText.onboardingStep(mic: .notDetermined, status: needsKey), .microphone)
        XCTAssertEqual(SettingsText.onboardingStep(mic: .denied, status: fine), .microphone)
        XCTAssertEqual(SettingsText.onboardingStep(mic: .granted, status: needsKey), .apiKey)
        XCTAssertEqual(SettingsText.onboardingStep(mic: .unknown, status: needsKey), .apiKey)
        XCTAssertNil(SettingsText.onboardingStep(mic: .granted, status: fine))
        XCTAssertNil(SettingsText.micCard(.granted))
        XCTAssertEqual(SettingsText.micCard(.notDetermined)?.button, "Allow Microphone")
        XCTAssertEqual(SettingsText.micCard(.denied)?.button, "Open System Settings")
    }

    func testMeterCurve() {
        XCTAssertEqual(LevelMeter.litSegments(level: 0, segments: 10), 0)
        XCTAssertEqual(LevelMeter.litSegments(level: 1, segments: 10), 10)
        XCTAssertEqual(LevelMeter.litSegments(level: 0.0005, segments: 10), 0)
        let mid = LevelMeter.litSegments(level: 0.05, segments: 10)
        XCTAssertTrue((4...7).contains(mid), "speech-level RMS lights about half: \(mid)")
    }

    // The page's persona picker words (web/app.js personaLabel, renderPersonas, choosePersona).
    func testPersonaCopyMatchesPage() {
        typealias P = Settings.Personas.Persona
        XCTAssertEqual(SettingsText.personaLabel(P(id: "moss", name: "Moss", source: "builtin")), "Moss")
        XCTAssertEqual(SettingsText.personaLabel(P(id: "r", name: "Reviewer", source: "project")), "Reviewer (project)")
        XCTAssertEqual(SettingsText.personaLabel(P(id: "p", name: "Pirate", source: "user")), "Pirate (yours)")
        XCTAssertEqual(SettingsText.personaHelp(P(id: "moss", name: "Moss", description: "Dry wit.", voice: "cedar")), "Dry wit. Voice: Cedar.")
        XCTAssertEqual(SettingsText.personaHelp(P(id: "p", name: "Pirate", description: "Arr.", voice: nil)), "Arr.")
        XCTAssertEqual(SettingsText.personaHelp(P(id: "x", name: "X", description: "")), SettingsText.personaDefaultHelp)
        XCTAssertEqual(SettingsText.personaHelp(nil), "How the voice talks: its tone, humor and opinions. What Claude does stays the same.")
        XCTAssertEqual(SettingsText.personaVoiceToggle, "Switch to the persona's own voice")
        XCTAssertEqual(SettingsText.personaSwitched("June"), "Switching to June. The conversation carries over.")
    }

    func testBluetoothMicWarning() {
        let airpods = DeviceChoice(id: "bt", name: "AirPods Max", bluetooth: true, headphones: true)
        let builtIn = DeviceChoice(id: "bi", name: "MacBook Pro Microphone")
        XCTAssertEqual(SettingsText.bluetoothMicWarning(selected: airpods, active: builtIn), SettingsText.bluetoothMicHelp)
        XCTAssertEqual(SettingsText.bluetoothMicWarning(selected: nil, active: airpods), SettingsText.bluetoothMicHelp, "Automatic resolved to a Bluetooth mic")
        XCTAssertNil(SettingsText.bluetoothMicWarning(selected: builtIn, active: airpods), "the chosen mic wins")
        XCTAssertNil(SettingsText.bluetoothMicWarning(selected: nil, active: builtIn))
        XCTAssertNil(SettingsText.bluetoothMicWarning(selected: nil, active: nil))
        XCTAssertTrue(SettingsText.bluetoothMicHelp.contains("MacBook mic works better"))
    }

    func testNoEmojiInCopy() {
        let strings = [SettingsText.personaDefaultHelp, SettingsText.personaVoiceToggle, SettingsText.personaSwitching, SettingsText.voiceHelp, SettingsText.voiceSamplesHelp, SettingsText.wakeHelp, SettingsText.echoHelp,
                       SettingsText.keyIntro, SettingsText.keyKeep, SettingsText.micCompareHelp, SettingsText.bluetoothMicHelp]
            + ["quiet", "milestones", "walkthrough"].map(SettingsText.policyHelp)
            + ["auto", "app", "chrome", "default"].map(SettingsText.windowHelp)
            + [MicPermission.notDetermined, .denied, .restricted].compactMap { SettingsText.micCard($0) }.flatMap { [$0.title, $0.body] + $0.steps }
            + [LoginItemState.unavailable, .off, .on, .requiresApproval].map(SettingsText.loginHelp)
        for s in strings { XCTAssertFalse(s.unicodeScalars.contains { $0.properties.isEmojiPresentation }, s) }
    }
}

@MainActor
final class SettingsModelTests: XCTestCase {
    final class Recorder {
        var calls: [(String, [String: JSONValue])] = []
        var reply: (String, [String: JSONValue]) -> Result<JSONValue, CommandError> = { _, _ in .success(.object([:])) }
    }

    private func make(_ status: PageStatus? = SettingsSnapshots.fixtureStatus()) -> (SettingsModel, Recorder) {
        let rec = Recorder()
        let state = StateModel()
        state.status = status
        state.sendCommand = { name, args in rec.calls.append((name, args)); return rec.reply(name, args) }
        return (SettingsModel(state: state), rec)
    }

    private func settle() async { for _ in 0..<20 { await Task.yield() } }

    func testIngestWelcomeFixture() throws {
        let data = try Data(contentsOf: fixtureURL("welcome.json"))
        guard case .object(let raw) = try JSONDecoder().decode(JSONValue.self, from: data) else { return XCTFail("fixture") }
        let (m, _) = make()
        m.ingest(.welcome(protocolVersion: 1, version: "0.3.0", status: nil, raw: raw))
        XCTAssertEqual(m.settings?.voices?.voices, ["alloy", "marin", "cedar"])
        XCTAssertEqual(m.settings?.window, "auto")
        XCTAssertEqual(m.wakeLevels, ["off", "low", "medium", "high"])
        XCTAssertEqual(m.settings?.data_dir, "/tmp/sotto-data")
        XCTAssertEqual(m.personas.map(\.name), ["Sotto", "Moss", "Pirate"])
        XCTAssertEqual(m.settings?.personas?.current, "sotto")
        XCTAssertTrue(m.personaUseVoice)
        m.ingest(.other(type: "settings", raw: ["type": .string("settings"), "window": .string("chrome"),
                                                 "voices": .object(["voices": .array([.string("ash")]), "current": .string("ash")])]))
        XCTAssertEqual(m.window, "chrome")
        XCTAssertEqual(m.voice, "ash")
        // The wire form: SottoClient decodes `settings` to the typed case.
        let typed = ServerMessage.decode(#"{"type":"settings","window":"app","voices":{"voices":["sage"],"current":"sage"}}"#)
        guard case .settings = typed else { return XCTFail("typed settings case") }
        m.ingest(typed)
        XCTAssertEqual(m.window, "app")
        XCTAssertEqual(m.voice, "sage")
    }

    func testDaemonSettingsSendCommands() async {
        let (m, rec) = make()
        m.setPolicy("quiet")
        XCTAssertEqual(m.policy, "quiet", "shows the choice while the command is in flight")
        m.setWake("high")
        m.setWindow("chrome")
        await settle()
        XCTAssertEqual(rec.calls.map(\.0), ["set_policy", "set_wake", "set_window"])
        XCTAssertEqual(rec.calls[0].1["policy"], .string("quiet"))
        XCTAssertEqual(rec.calls[1].1["sensitivity"], .string("high"))
        XCTAssertEqual(rec.calls[2].1["mode"], .string("chrome"))
        XCTAssertEqual(m.policy, "milestones", "after the result, status is the truth again")
        XCTAssertEqual(m.window, "chrome")
    }

    func testVoiceSwitchShowsDaemonMessageAndErrors() async {
        let (m, rec) = make()
        m.settings = NativeSettings(voices: .init(voices: ["marin", "cedar"], current: "marin"))
        rec.reply = { _, _ in .success(.object(["voice": .string("cedar"), "switching": .bool(true), "message": .string("sotto: switching to cedar.")])) }
        m.setVoice("marin")
        XCTAssertTrue(rec.calls.isEmpty, "same voice: no command")
        m.setVoice("cedar")
        await settle()
        XCTAssertEqual(rec.calls.first?.1["voice"], .string("cedar"))
        XCTAssertEqual(m.voiceMessage, "sotto: switching to cedar.")
        XCTAssertEqual(m.voice, "cedar")
        rec.reply = { _, _ in .failure(CommandError(code: "bad_voice", message: "sotto: unknown voice")) }
        m.setPolicy("walkthrough")
        await settle()
        XCTAssertEqual(m.error("policy"), "sotto: unknown voice")
    }

    private func personaSettings(current: String = "sotto", useVoice: Bool = true) -> NativeSettings {
        NativeSettings(voices: .init(voices: ["marin", "cedar", "coral"], current: "marin"),
                       personas: .init(personas: [
                           .init(id: "sotto", name: "Sotto", description: "Balanced and friendly.", voice: "marin", source: "builtin"),
                           .init(id: "moss", name: "Moss", description: "Dry-witted senior engineer.", voice: "cedar", source: "builtin"),
                           .init(id: "pirate", name: "Pirate", description: "Talks like a ship's captain.", voice: nil, source: "user"),
                       ], current: current, use_voice: useVoice, live: true, live_persona: current))
    }

    func testPersonaPickerSendsSetPersonaAndFollowsTheResult() async {
        let (m, rec) = make()
        m.settings = personaSettings()
        XCTAssertEqual(m.persona, "sotto")
        XCTAssertEqual(m.personas.map(\.id), ["sotto", "moss", "pirate"])
        XCTAssertEqual(m.personaHelp, "Balanced and friendly. Voice: Marin.")
        XCTAssertTrue(m.personaUseVoice)
        m.setPersona("sotto")
        XCTAssertTrue(rec.calls.isEmpty, "same persona: no command")
        rec.reply = { _, _ in .success(.object(["persona": .string("moss"), "voice": .string("cedar"), "switching": .bool(true),
                                                "message": .string("sotto: persona set to moss with the cedar voice. Switching the live session now."),
                                                "use_voice": .bool(true)])) }
        m.setPersona("moss")
        XCTAssertEqual(m.persona, "moss", "shows the choice while the command is in flight")
        XCTAssertEqual(m.personaHelp, SettingsText.personaSwitching)
        await settle()
        XCTAssertEqual(rec.calls.map(\.0), ["set_persona"])
        XCTAssertEqual(rec.calls[0].1, ["persona": .string("moss")], "only the persona; the toggle is its own command")
        XCTAssertEqual(m.persona, "moss")
        XCTAssertEqual(m.voice, "cedar", "the persona's voice came along")
        XCTAssertEqual(m.personaHelp, "Switching to Moss. The conversation carries over.")
        // The new session runs in Moss: the help goes back to the description.
        var live = personaSettings(current: "moss")
        live.voices?.current = "cedar"
        m.ingest(.settings({ var s = Settings(); s.personas = live.personas; s.voices = .init(voices: ["marin", "cedar"], current: "cedar"); return s }()))
        XCTAssertEqual(m.personaHelp, "Dry-witted senior engineer. Voice: Cedar.")
        // A failure shows the daemon's words and leaves the daemon's choice.
        rec.reply = { _, _ in .failure(CommandError(code: "bad_persona", message: "sotto: unknown persona \"pirate\".")) }
        m.setPersona("pirate")
        await settle()
        XCTAssertEqual(m.error("persona"), "sotto: unknown persona \"pirate\".")
        XCTAssertEqual(m.persona, "moss")
    }

    func testPersonaVoiceToggle() async {
        let (m, rec) = make()
        m.settings = personaSettings()
        rec.reply = { _, args in .success(.object(["use_voice": args["use_voice"] ?? .null])) }
        m.setPersonaUseVoice(false)
        XCTAssertFalse(m.personaUseVoice, "shows the choice while the command is in flight")
        await settle()
        XCTAssertEqual(rec.calls.map(\.0), ["set_persona"])
        XCTAssertEqual(rec.calls[0].1, ["use_voice": .bool(false)])
        XCTAssertFalse(m.personaUseVoice)
        XCTAssertEqual(m.settings?.personas?.use_voice, false)
        rec.reply = { _, _ in .failure(CommandError(code: "not_connected", message: "Sotto is not connected to its daemon.")) }
        m.setPersonaUseVoice(true)
        await settle()
        XCTAssertFalse(m.personaUseVoice, "a failed toggle keeps the saved value")
        XCTAssertEqual(m.error("persona_voice"), "Sotto is not connected to its daemon.")
    }

    func testPersonaFromTerminalAndOlderDaemon() {
        let (m, _) = make(SettingsSnapshots.decodeStatus(["state": "live", "persona": "moss"]))
        XCTAssertTrue(m.personas.isEmpty, "no personas in settings: the row is hidden")
        XCTAssertEqual(m.personaHelp, SettingsText.personaDefaultHelp)
        m.settings = personaSettings(current: "sotto")
        XCTAssertEqual(m.persona, "moss", "status carries a /talk persona switch first")
    }

    func testKeySaveSendsOnlyThroughCommandAndKeepsNothing() async {
        let secret = "sk-test-SECRET-0123456789abcdef"
        let (m, rec) = make()
        rec.reply = { _, _ in .success(.object(["ok": .bool(true), "message": .string("Key saved.")])) }
        let bad = await m.saveKey("not a key")
        XCTAssertFalse(bad)
        XCTAssertTrue(rec.calls.isEmpty, "malformed keys never leave the app")
        XCTAssertNotNil(m.keyError)
        let ok = await m.saveKey("  \(secret)\n")
        XCTAssertTrue(ok)
        XCTAssertEqual(rec.calls.map(\.0), ["key_save"])
        XCTAssertEqual(rec.calls[0].1["key"], .string(secret))
        XCTAssertEqual(m.keyMessage, "Key saved.")
        XCTAssertFalse(String(reflecting: Mirror(reflecting: m).children.map { "\($0.label ?? ""): \($0.value)" }).contains("SECRET"),
                       "the model holds no copy of the key")
        rec.reply = { _, _ in .failure(CommandError(code: "openai_auth", message: "OpenAI rejected this key.")) }
        let rejected = await m.saveKey(secret)
        XCTAssertFalse(rejected)
        XCTAssertEqual(m.keyError, "OpenAI rejected this key.")
        XCTAssertFalse(m.keyBusy)
    }

    func testKeyRemove() async {
        let (m, rec) = make()
        rec.reply = { _, _ in .success(.object(["message": .string("Key removed.")])) }
        await m.removeKey()
        XCTAssertEqual(rec.calls.map(\.0), ["key_remove"])
        XCTAssertEqual(m.keyMessage, "Key removed.")
    }

    func testEchoTest() async {
        let (m, rec) = make()
        rec.reply = { _, _ in .success(.object(["verdict": .string("some"), "level": .string("some"), "leak_db": .number(-28), "corr": .number(0.4)])) }
        await m.runEchoTest()
        XCTAssertEqual(rec.calls.map(\.0), ["echo_test"])
        XCTAssertEqual(m.echoResult?.title, "Some echo")
        XCTAssertTrue(m.echoSummary.hasPrefix("Some echo. "))
        rec.reply = { _, _ in .failure(CommandError(code: "timeout", message: "No answer.")) }
        await m.runEchoTest()
        XCTAssertEqual(m.echoSummary, "Could not test. No answer.")
        m.chooseOutput("x")
        XCTAssertEqual(m.echoSummary, "Not tested on this speaker yet.", "a new speaker forgets the old result")
    }

    func testAppLocalHooks() async {
        let (m, rec) = make()
        var input: String?? = .none, ec: String?, metering: [Bool] = [], login: [Bool] = []
        m.hooks.selectInput = { input = .some($0) }
        m.hooks.setEchoCancellation = { ec = $0 }
        m.hooks.setInputMetering = { metering.append($0) }
        m.hooks.setLaunchAtLogin = { login.append($0); return $0 ? .on : .off }
        m.hooks.requestMicAccess = { .granted }
        m.chooseInput("usb")
        XCTAssertEqual(input, .some("usb"))
        m.chooseInput(nil)
        XCTAssertEqual(input, .some(nil))
        m.chooseEchoCancellation("never")
        XCTAssertEqual(ec, "never")
        m.metering = true; m.metering = true; m.metering = false
        XCTAssertEqual(metering, [true, false])
        m.setLaunchAtLogin(true)
        XCTAssertEqual(m.loginItem, .on)
        m.hooks.setLaunchAtLogin = { _ in throw CommandError(code: "x", message: "denied") }
        m.setLaunchAtLogin(false)
        XCTAssertEqual(m.loginItem, .on)
        XCTAssertNotNil(m.error("login"))
        m.micPermission = .notDetermined
        await m.requestMic()
        XCTAssertEqual(m.micPermission, .granted)
        var opened = false
        m.hooks.openMicPrivacySettings = { opened = true }
        m.micPermission = .denied
        await m.requestMic()
        XCTAssertTrue(opened)
        XCTAssertTrue(rec.calls.isEmpty, "app-local rows send no daemon commands")
    }

    func testPreviewToggle() async {
        let (m, _) = make()
        var played: [String] = [], stopped = 0
        m.hooks.playVoicePreview = { v in played.append(v); try await Task.sleep(nanoseconds: 50_000_000) }
        m.hooks.stopVoicePreview = { stopped += 1 }
        m.togglePreview("cedar")
        XCTAssertEqual(m.previewing, "cedar")
        m.togglePreview("cedar")
        XCTAssertNil(m.previewing)
        XCTAssertGreaterThanOrEqual(stopped, 1)
        await settle()
        XCTAssertEqual(played, ["cedar"])
    }

    func testNoCommandHookMeansNotConnected() {
        let state = StateModel()
        let m = SettingsModel(state: state)
        m.setPolicy("quiet")
        XCTAssertEqual(m.error("policy"), "Not connected to sotto.")
    }
}

@MainActor
final class SettingsSnapshotTests: XCTestCase {
    /// Renders the settings/onboarding PNGs offscreen. SOTTO_SNAPSHOT_DIR=design/native keeps them.
    func testRenderSnapshots() throws {
        let env = ProcessInfo.processInfo.environment["SOTTO_SNAPSHOT_DIR"]
        let dir = env.map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.temporaryDirectory.appendingPathComponent("sotto-settings-snap-\(UUID().uuidString)")
        let files = try SettingsSnapshots.render(to: dir)
        XCTAssertEqual(files.count, SettingsSnapshots.shots().count * 2)
        for f in files {
            let size = (try? FileManager.default.attributesOfItem(atPath: f.path)[.size] as? Int) ?? 0
            XCTAssertGreaterThan(size ?? 0, 2_000, f.lastPathComponent)
        }
        if env == nil { try? FileManager.default.removeItem(at: dir) }
    }
}
