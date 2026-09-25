// Sotto native app (docs/NATIVE.md §5.1): the app delegate and the Controller
// that wires the daemon link (SottoClient), the audio engine (SottoAudio) and
// the UI (SottoUI), plus the menu-bar item, the floating panel, hotkeys and
// the sotto:// URL scheme.
//
// The daemon owns the Live session. This process is audio I/O and UI: mic
// frames go up the link, speaker frames come down it into the playout buffer,
// and every user action is a `cmd` answered by one `result`.
import AppKit
import SottoAudio
import SottoClient
import SottoUI

@MainActor
final class AppController: NSObject, NSApplicationDelegate, PanelControllerDelegate, MenuBarDelegate {
    private let options: Options
    private let log: DebugLog
    private let model = StateModel()
    /// Settings + onboarding (SottoUI/Settings); the panel and the Settings window share it.
    let settings: SettingsModel
    private var settingsWindow: SettingsWindowController?
    private var onboardingShown: OnboardingStep?
    private var link: LinkClient?
    private var pump: AudioPump?
    private var audio: AudioIO?
    private let engine = EngineBox()
    private var panel: PanelController!
    private var menuBar: MenuBar?

    private var request: LaunchRequest?
    private var icon = IconInput()
    private var lastIcon: VoiceIcon?
    private var launched = false
    private var pendingURLs: [URL] = []
    private var quitting = false
    private var dataDir: String?

    // Audio state (main actor).
    private var capture: AudioPump.Capture = .off
    private var decayTimer: Timer?
    private var closedByDaemon = false
    private var mutePending = false
    private var testMuteScheduled = false
    private var testActionTimer: Timer?
    /// `data_dir` from the daemon's settings (for Open Logs after a direct launch without --data-dir).
    private var settingsDataDir: String?

    /// The terminal Claude Code most likely runs in (the last one the user activated).
    private let terminals = TerminalTracker()

    private var muteSpec = HotkeySpec.parse("opt+cmd+m")!
    private var showSpec = HotkeySpec.parse("opt+cmd+t")!

    /// Default: the app quits when the daemon closes the voice window (voice
    /// off), like the Chrome window does. Opt in to staying resident with the
    /// menu item or `defaults write com.chadboyda.sotto StayResident -bool YES`.
    private var stayResident: Bool {
        get { Prefs.store.bool(forKey: "StayResident") }
        set { Prefs.store.set(newValue, forKey: "StayResident") }
    }

    init(options: Options) {
        self.options = options
        Prefs.testMode = options.testMode
        log = DebugLog(path: options.debugLog)
        settings = SettingsModel(state: model)
        super.init()
    }

    nonisolated static var appVersion: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev" }

    /// The sources hash this bundle was built from (build-app.sh writes it), sent in `hello`.
    nonisolated static var sourceHash: String? {
        guard let url = Bundle.main.url(forResource: "sotto-source", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj["hash"] as? String
    }

    // MARK: lifecycle

    func applicationDidFinishLaunching(_ n: Notification) {
        log.log("launch", ["pid": Int(ProcessInfo.processInfo.processIdentifier), "version": AppController.appVersion,
                           "test": options.testMode, "bundle": orNull(Bundle.main.bundleIdentifier),
                           "os": ProcessInfo.processInfo.operatingSystemVersionString])
        model.settingsModel = settings
        panel = PanelController(model: model, log: log)
        panel.delegate = self
        if !options.testMode || options.show {
            // Tests run without a status item: nothing appears in the menu bar.
            let mb = MenuBar()
            mb.delegate = self
            menuBar = mb
        }
        if options.hotkeys { setupHotkeys() }
        menuBar?.setHotkeys(mute: muteSpec, show: showSpec)
        setupAudio()
        wireModel()
        wireSettings()
        observeSleep()
        startTestActions()
        launched = true
        if let req = options.request { open(req, source: "argv") }
        // A LaunchServices launch delivers its URL before didFinishLaunching.
        let queued = pendingURLs
        pendingURLs = []
        for url in queued { handle(url) }
        if let secs = options.exitAfter {
            DispatchQueue.main.asyncAfter(deadline: .now() + secs) { [weak self] in
                self?.log.log("exit_after")
                NSApp.terminate(nil)
                // Test mode must never linger.
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { exit(0) }
            }
        }
        refresh()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard launched else { pendingURLs.append(contentsOf: urls); return }
        for url in urls { handle(url) }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !quitting else { return .terminateNow }
        quitting = true
        log.log("terminate")
        stopAudio(reason: "quit")
        link?.close()
        // Let the close frame go out before the process exits.
        let t = Timer(timeInterval: 0.2, repeats: false) { _ in sender.reply(toApplicationShouldTerminate: true) }
        RunLoop.main.add(t, forMode: .common)
        return .terminateLater
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if request != nil { panel.show() }
        return false
    }

    // MARK: requests

    private func handle(_ url: URL) {
        guard let cmd = parseUrlCommand(url) else { log.log("url_ignored", ["scheme": url.scheme ?? ""]); return }
        switch cmd {
        case .open(let req):
            // URLs are untrusted (see daemonRecordsPort); argv launches are not URLs.
            guard daemonRecordsPort(dataDir: req.dataDir, port: req.port) else {
                log.log("url_rejected", ["port": req.port, "has_data_dir": req.dataDir != nil])
                return
            }
            // The daemon's launch always carries a fresh one-time code. Without
            // one, a URL (any web page can fire it) may not attach the app to a
            // daemon (it would bootstrap with page.secret and take the voice).
            guard req.code != nil else {
                log.log("url_rejected", ["port": req.port, "reason": "no_code"])
                if request?.port == req.port, !options.hidden { panel.show() }
                return
            }
            open(req, source: "url")
        case .close(let port):
            if let p = port, p == request?.port { closeVoiceWindow(reason: "url") }
        case .show:
            if request != nil { panel.show() }
        }
    }

    private func open(_ req: LaunchRequest, source: String) {
        log.log("open", ["port": req.port, "has_code": req.code != nil, "has_data_dir": req.dataDir != nil, "source": source])
        let sameDaemon = request?.port == req.port && link != nil
        request = req
        dataDir = req.dataDir
        closedByDaemon = false
        icon.attached = true
        icon.linkFailed = false
        if !sameDaemon { icon.linkUp = false }
        if link == nil {
            link = makeLink()
            pumpRef = pump
        }
        // A new launch code (a new /talk on) always reconnects: the daemon
        // hands the audio client role to the newest connection.
        link?.connect(req)
        if !options.hidden { panel.show() }
        refresh()
    }

    /// The daemon closed the voice window (voice off): stop audio, hide the
    /// panel, and quit unless the user asked the app to stay in the menu bar.
    private func closeVoiceWindow(reason: String) {
        log.log("close_window", ["reason": reason])
        closedByDaemon = true
        stopAudio(reason: "close_window")
        panel.hide()
        refresh()
        if !stayResident {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { NSApp.terminate(nil) }
        }
    }

    // MARK: link

    private func makeLink() -> LinkClient {
        var cfg = LinkClient.Config(version: AppController.appVersion, build: AppController.sourceHash, test: options.testMode)
        cfg.callbackQueue = .main
        let l = LinkClient(config: cfg)
        l.onLog = { [log] ev, fields in log.log(ev, fields) }
        l.onState = { [weak self] s in MainActor.assumeIsolated { self?.linkState(s) } }
        l.onMessage = { [weak self] m in MainActor.assumeIsolated { self?.message(m) } }
        // The pump owns the protocol rules (seq, MUTED/FAKE, flush ordering,
        // capture demand from the daemon state, audio_stats); the app gives it
        // the engine. play/flush/stats run on the link queue, setCapture on main.
        let box = engine
        pump = AudioPump(link: l, fake: options.testMode, hooks: AudioPump.Hooks(
            setCapture: { [weak self] c in MainActor.assumeIsolated { self?.setCapture(c) } },
            play: { [log] pcm, seq, afterFlush in
                // Test timing (debug log only): the first frame after a gap starts a burst.
                if log.enabled, box.speakerFrameStartsBurst() { log.log("spk_rx", ["seq": Int(seq), "after_flush": afterFlush]) }
                box.io?.enqueuePlayback(pcm, seq: seq, afterFlush: afterFlush)
            },
            flush: { _ in box.io?.flushPlayback() },
            stats: { box.statsMessage() }
        ))
        return l
    }

    private func linkState(_ s: LinkState) {
        model.linkState = s
        switch s {
        case .connected:
            icon.linkFailed = false
        case .failed(let why):
            icon.linkUp = false
            icon.linkFailed = true
            log.log("link_failed", ["reason": why])
        case .idle, .bootstrapping, .connecting, .backoff:
            icon.linkUp = false
        }
        refresh()
    }

    private func message(_ m: ServerMessage) {
        model.apply(m)
        settings.ingest(m)
        switch m {
        case .welcome(_, let version, let status, _):
            icon.linkUp = true
            icon.linkFailed = false
            log.log("welcome", ["version": version, "state": orNull(status?.state)])
            IconModel.input(status: status, into: &icon)
            sendRoute()
        case .status(let s):
            IconModel.input(status: s, into: &icon)
            if s.state == "live", let ms = options.testMuteAfterMs, !testMuteScheduled {
                testMuteScheduled = true
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms)) { [weak self] in
                    self?.log.log("test_mute")
                    self?.toggleMute()
                }
            }
            if closedByDaemon, s.state != "off" { closedByDaemon = false }
            updateLocalMute()
        case .command(let c):
            log.log("command", ["command": c.command, "reason": orNull(c.reason)])
            if c.command == "close_window" { closeVoiceWindow(reason: c.reason ?? "close_window") }
            else if c.command == "play_echo_sample" { playEchoSample() }
        case .audioFlush(let reason):
            log.log("audio_flush", ["reason": reason])
        case .notice(let n):
            log.log("notice", ["code": orNull(n.code)])
            if n.code == "mic_error" { icon.micFailed = true }
        case .noticeClear(let code):
            if code == "mic_error" { icon.micFailed = false }
        default:
            break
        }
        if let d = m.settingsPayload?.data_dir, d.hasPrefix("/") { settingsDataDir = d }
        maybeShowOnboarding()
        refresh()
    }

    /// Test mode only (Options.testActionDir): drive Settings actions from a test, through the same
    /// SettingsModel calls the Settings window makes. Polled; never armed outside `--test`.
    private func startTestActions() {
        guard options.testMode, let dir = options.testActionDir else { return }
        testActionTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.runTestActions(dir: dir) }
        }
    }

    private func runTestActions(dir: String) {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: dir) else { return }
        for name in names.filter({ $0.hasSuffix(".json") }).sorted() {
            let path = (dir as NSString).appendingPathComponent(name)
            let data = fm.contents(atPath: path)
            try? fm.removeItem(atPath: path)
            guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let action = obj["action"] as? String else { log.log("test_action", ["ok": false]); continue }
            switch action {
            case "persona":
                guard let id = obj["persona"] as? String else { continue }
                log.log("test_action", ["action": action, "persona": id])
                settings.setPersona(id)
            case "persona_voice":
                let on = obj["on"] as? Bool ?? true
                log.log("test_action", ["action": action, "on": on])
                settings.setPersonaUseVoice(on)
            case "appearance":
                let choice = obj["appearance"] as? String ?? "system"
                log.log("test_action", ["action": action, "appearance": choice])
                settings.setAppearance(choice)
                // What AppKit resolved, so a test can see the choice took effect.
                log.log("appearance_applied", ["app": NSApp.appearance?.name.rawValue ?? "system",
                                               "effective": NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua])?.rawValue ?? ""])
            case "probe":
                // What the live panel shows now (captions, headline, Claude's words, the
                // string's levels), from the model the daemon link feeds (PanelProbe).
                var o = PanelProbe.describe(model)
                o["tag"] = obj["tag"] as? String ?? ""
                o["panel_visible"] = model.panelVisible
                log.log("panel_probe", o)
            case "page_scroll":
                // Scroll Claude's page as a reader would ("top", "up", "bottom", "latest").
                guard let view = panel.panel.contentView else { continue }
                var o = PanelTestSupport.scrollPage(in: view, to: obj["to"] as? String ?? "top")
                o["action"] = action
                log.log("test_action", o)
            case "panel_size":
                // Resize the panel (small-window captures); the frame rules still apply.
                guard let w = obj["width"] as? Double, let h = obj["height"] as? Double else { continue }
                panel.panel.setContentSize(NSSize(width: w, height: h))
                log.log("test_action", ["action": action, "width": w, "height": h])
            case "device_picker":
                // Open ("input" / "output") or close (anything else) the footer's device picker.
                let kind = obj["kind"] as? String
                model.devicePicker = kind == "input" || kind == "output" ? kind : nil
                log.log("test_action", ["action": action, "kind": orNull(model.devicePicker)])
            case "fake_devices":
                // Extra fake devices that come and go (the picker and its fallback); fake audio only.
                guard let fake = audio as? FakeAudioIO else { continue }
                func devs(_ key: String) -> [AudioDevice] {
                    (obj[key] as? [[String: Any]] ?? []).compactMap { o in
                        guard let id = o["id"] as? String, let name = o["name"] as? String else { return nil }
                        let hp = o["headphones"] as? Bool ?? false
                        return AudioDevice(id: id, name: name, bluetooth: o["bluetooth"] as? Bool ?? false, headphones: hp, transport: .virtual)
                    }
                }
                fake.testDevices = (devs("inputs"), devs("outputs"))
                devicesChanged()
                log.log("test_action", ["action": action, "inputs": settings.inputDevices.count, "outputs": settings.outputDevices.count,
                                        "input": orNull(settings.selectedInput), "output": orNull(settings.selectedOutput)])
            case "choose_device":
                // What a click in the picker does.
                let id = obj["id"] as? String
                if obj["kind"] as? String == "output" { settings.chooseOutput(id) } else { settings.chooseInput(id) }
                model.devicePicker = nil
                log.log("test_action", ["action": action, "input": orNull(settings.selectedInput), "output": orNull(settings.selectedOutput)])
            case "snapshot":
                // The live panel's own window content to a PNG (the real views, no screen capture).
                guard let out = obj["path"] as? String, out.hasPrefix("/"), let view = panel.panel.contentView else { continue }
                let data = PanelTestSupport.png(of: view)
                let ok = data.map { (try? $0.write(to: URL(fileURLWithPath: out))) != nil } ?? false
                var o = PanelTestSupport.pageState(in: view)
                o["action"] = action; o["ok"] = ok; o["path"] = out
                log.log("test_action", o)
            default:
                log.log("test_action", ["action": action, "ok": false])
            }
        }
    }

    private func command(_ name: String, _ args: [String: JSONValue] = [:]) async -> Result<JSONValue, CommandError> {
        guard let l = link else { return .failure(CommandError(code: "not_connected", message: "Sotto is not connected to its daemon.")) }
        let r = await l.command(name, args: args)
        switch r {
        case .success(let v):
            log.log("cmd_result", ["name": name, "ok": true])
            return .success(v)
        case .failure(let f):
            log.log("cmd_result", ["name": name, "ok": false, "code": f.code])
            return .failure(CommandError(code: f.code, message: f.message))
        }
    }

    private func fire(_ name: String, _ args: [String: JSONValue] = [:]) {
        Task { @MainActor in _ = await self.command(name, args) }
    }

    private func wireModel() {
        model.openSettings = { [weak self] in self?.showSettings(activate: true, reason: "panel") }
        model.openMicSwitcher = { [weak self] in self?.showSettings(activate: true, reason: "switch_mic") }
        model.onUserActivity = { [weak self] in self?.link?.send(.activity) }
        model.reducedMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        // Reduce Motion can change while the app runs.
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.model.reducedMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
        }
        terminals.start { [weak self] name in
            MainActor.assumeIsolated { self?.model.terminalName = name }
        }
        model.terminalName = terminals.name
        // "Show terminal" brings the terminal forward; never in test mode (automation must not move focus).
        if !options.testMode { model.showTerminal = { [weak self] in self?.terminals.activate() } }
        model.sendCommand = { [weak self] name, args in
            guard let self = self else { return .failure(CommandError(code: "gone", message: "Sotto is quitting.")) }
            if name == "mute", case .bool(let on)? = args["on"] { return await self.muteCommand(on: on) }
            return await self.command(name, args)
        }
    }

    /// Mute zeroes the uplink at once, before the daemon confirms: the user's
    /// voice never leaves after they asked it not to. Unmute waits for the daemon.
    private func muteCommand(on: Bool) async -> Result<JSONValue, CommandError> {
        if on { setMutePending(true) }
        let r = await command("mute", ["on": .bool(on)])
        if on { setMutePending(false) }
        refresh()
        return r
    }

    private func setMutePending(_ on: Bool) {
        mutePending = on
        updateLocalMute()
        refresh()
    }

    // MARK: audio

    private func setupAudio() {
        let io = makeAudioIO(test: options.testMode)
        audio = io
        engine.io = io
        if let fake = io as? FakeAudioIO, log.enabled {
            // Test timing only: clip start/end, output speech start/end, flushes.
            fake.onTestEvent = { [log] ev, fields in log.log(ev, fields) }
        }
        io.onMicFrame = { [weak self] frame in
            // Capture thread: straight to the pump (it gates, stamps and sends).
            self?.pumpRef?.pushMic(samples: frame.samples, hostTimeNs: frame.hostTimeNs, muted: frame.muted)
        }
        io.onRoute = { [weak self] route in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.routeChanged(route) } }
        }
        io.onLevels = { [weak self] micLevel, speakerLevel in
            MainActor.assumeIsolated { self?.levels(mic: micLevel, speaker: speakerLevel) }
        }
        io.onError = { [weak self] e in
            MainActor.assumeIsolated { self?.audioError(e) }
        }
        io.onMicSilence = { [weak self] silent in
            MainActor.assumeIsolated { self?.micSilence(silent) }
        }
        // The user's saved choices (the app's defaults, docs/NATIVE.md §3.3 "handled in the app").
        let d = Prefs.store
        io.setPreferredDevices(input: d.string(forKey: "InputDevice"), output: d.string(forKey: "OutputDevice"))
        if let ec = d.string(forKey: "EchoCancellation").flatMap(EchoCancellation.init(rawValue:)) { io.echoCancellation = ec }
    }

    /// An asynchronous engine failure (a denied prompt, a lost device): tell the daemon like the page does.
    private func audioError(_ e: AudioIOError) {
        icon.micFailed = true
        model.micFailure = AppController.micFailureKind(e)
        model.micPrompt = false
        log.log("audio_error", ["name": e.name])
        link?.send(.micError(name: e.name, message: e.message))
        if case .micDenied = e { refreshPermissions() }
        refresh()
    }

    /// The pump, readable from the capture thread (set once per link).
    nonisolated(unsafe) private var pumpRef: AudioPump?

    /// States in which the app captures and plays (docs/NATIVE.md §2.2).
    nonisolated static func wantsAudio(state: String) -> Bool {
        AudioPump.capture(for: state, linkUp: true) != .off
    }

    /// The pump's capture demand → the engine (main thread, only on change).
    private func setCapture(_ c: AudioPump.Capture) {
        guard let io = audio else { return }
        let was = capture
        capture = c
        log.log("capture", ["from": was.rawValue, "to": c.rawValue])
        if was != .off { io.stop() }
        guard c != .off, !closedByDaemon else {
            engine.mode = "off"
            levels(mic: 0, speaker: 0)
            return
        }
        // The first start may show the macOS microphone question (B3 prompts when undetermined).
        if !options.testMode, MicAccess.current() == .notDetermined { model.micPrompt = true }
        do {
            try io.start(listenOnly: c == .listen)
            icon.micFailed = false
            model.micFailure = nil
        } catch let e as AudioIOError {
            capture = .off
            icon.micFailed = true
            model.micFailure = AppController.micFailureKind(e)
            model.micPrompt = false
            log.log("audio_start_failed", ["name": e.name])
            link?.send(.micError(name: e.name, message: e.message))
            refreshPermissions()
        } catch {
            capture = .off
            icon.micFailed = true
            let ns = error as NSError
            log.log("audio_start_failed", ["domain": ns.domain, "code": ns.code])
            link?.send(.micError(name: "\(ns.domain).\(ns.code)", message: ns.localizedDescription))
        }
        refresh()
    }

    private func stopAudio(reason: String) {
        guard capture != .off, let io = audio else { return }
        io.flushPlayback()
        io.stop()
        capture = .off
        engine.mode = "off"
        log.log("audio_stop", ["reason": reason])
        levels(mic: 0, speaker: 0)
    }

    private func routeChanged(_ route: AudioRouteInfo) {
        engine.mode = route.mode.rawValue
        lastRoute = route
        model.micName = route.input?.name
        settings.activeInput = route.input.map(AppController.choice)
        settings.activeOutput = route.output.map(AppController.choice)
        devicesChanged()
        log.log("route", ["mode": route.mode.rawValue, "input_bt": route.input?.bluetooth ?? false,
                          "capture_rate": route.captureRate, "device_rate": route.deviceRate,
                          "output_headphones": route.output?.headphones ?? false])
        sendRoute()
    }

    private var lastRoute: AudioRouteInfo?

    /// 3 s of exact digital zeros on the unmuted mic (SPEC §6.16 "Silent mic"): an app
    /// whose bundle was replaced while it ran hears only zeros. The daemon restarts a
    /// stale app once, else moves the voice to Chrome (voice.onMicSilent).
    private func micSilence(_ silent: Bool) {
        log.log("mic_silence", ["silent": silent])
        guard silent else { return }
        link?.send(.other(type: "mic_silent", fields: ["input_label": .string(lastRoute?.input?.name ?? ""), "source": "native", "ms": 3000]))
    }

    private func sendRoute() {
        guard let io = audio, icon.linkUp, let r = lastRoute else { return }
        func dev(_ d: AudioDevice?) -> RouteMessage.Device? {
            d.map { RouteMessage.Device(id: $0.id, name: $0.name, bluetooth: $0.bluetooth, headphones: $0.headphones) }
        }
        link?.send(.route(RouteMessage(mode: r.mode.rawValue, input: dev(r.input), output: dev(r.output),
                                       echoCancellation: io.echoCancellation.rawValue)))
        if r.captureRate > 0 {
            // The route message carries no rates; this lands in the daemon log as page.log (src app).
            link?.send(.log(level: "info", message: "sotto: capture \(r.mode.rawValue) from \(r.input?.name ?? "?") at \(Int(r.captureRate)) Hz (device \(Int(r.deviceRate)) Hz), \(r.reason)"))
        }
    }

    private func levels(mic m: Float, speaker s: Float) {
        model.micLevel = m
        model.speakerLevel = s
        if model.status?.state == "sleeping" { model.wakeLevel = model.wakeMuted ? 0 : m } else if m == 0 { model.wakeLevel = 0 }
        if model.micPrompt && m > 0 { model.micPrompt = false }
        updateLocalMute()
        let now = Date().timeIntervalSince1970
        var changed = false
        if s > IconModel.speechLevel { icon.lastAssistant = now; changed = true }
        if m > IconModel.speechLevel && !(model.effectiveMuted || mutePending) { icon.lastUser = now; changed = true }
        if changed { refresh() }
    }

    private func playEchoSample() {
        guard let l = link, let io = audio else { return }
        let voice = model.status?.voice ?? "marin"
        Task { @MainActor in
            do {
                let wav = try await l.fetchVoicePreview(voice, cachedOnly: true)
                io.playSample(wav) { [weak self] in
                    DispatchQueue.main.async { self?.link?.send(.played(what: "echo_test", voice: voice)) }
                }
                self.log.log("echo_sample", ["bytes": wav.count])
            } catch {
                self.log.log("echo_sample_failed", ["error": "\(error)"])
            }
        }
    }

    // MARK: sleep / wake

    private func observeSleep() {
        let nc = NSWorkspace.shared.notificationCenter
        nc.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self = self else { return }
                self.log.log("system_sleep")
                self.link?.send(.system(event: "sleep"))
                if let io = self.audio, self.capture != .off { io.stop(); self.log.log("audio_stop", ["reason": "system_sleep"]) }
            }
        }
        nc.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self = self else { return }
                self.log.log("system_wake")
                self.link?.send(.system(event: "wake"))
                // The engine was stopped for sleep: restart it for the current demand.
                let c = self.capture
                self.capture = .off
                if c != .off { self.setCapture(c) }
            }
        }
    }

    // MARK: actions

    /// ⌥⌘M, the menu and the pill: the same toggle as the panel's M key
    /// (StateModel shows the wanted value at once; sendCommand → muteCommand).
    private func toggleMute() {
        guard link != nil else { return }
        if model.status?.state == "sleeping" {
            model.wakeMuted.toggle()
            updateLocalMute()
            refresh()
            return
        }
        model.toggleMute()
    }

    /// Frames go out as MUTED zeros while a mute is in flight, and while the
    /// user muted wake listening in the sleeping state.
    private func updateLocalMute() {
        let on = mutePending || (model.wakeMuted && model.status?.state == "sleeping")
        if pump?.localMute != on { pump?.localMute = on }
    }

    private func setupHotkeys() {
        let d = Prefs.store
        if let s = d.string(forKey: "HotkeyMute"), let spec = HotkeySpec.parse(s) { muteSpec = spec }
        if let s = d.string(forKey: "HotkeyShow"), let spec = HotkeySpec.parse(s) { showSpec = spec }
        let m = Hotkeys.shared.register(muteSpec) { [weak self] in MainActor.assumeIsolated { self?.toggleMute() } }
        let t = Hotkeys.shared.register(showSpec) { [weak self] in MainActor.assumeIsolated { self?.menuToggleShow() } }
        log.log("hotkeys", ["mute": muteSpec.display, "mute_ok": m, "show": showSpec.display, "show_ok": t])
    }

    // PanelControllerDelegate
    func panelToggleMute() { toggleMute() }
    func panelVisibilityChanged() { refresh() }

    // MenuBarDelegate
    func menuToggleShow() {
        guard request != nil else { return }
        panel.showOrExpandOrHide()
    }
    func menuToggleCompact() {
        panel.setCompact(!panel.compact)
        if request != nil && !panel.isVisible { panel.show() }
    }
    func menuMute() { toggleMute() }
    func menuPauseResume() {
        switch model.status?.state ?? "off" {
        case "sleeping": fire("wake")
        case "paused", "waiting_page": fire("resume")
        default: fire("pause")
        }
    }

    /// Voice off for every session, like `/talk off`. Over the link when it is
    /// up; otherwise POST /control {action:"off"} with the daemon key from
    /// <data dir>/daemon.key, read at click time, never stored or logged, and
    /// sent only to the port this data dir's daemon records.
    func menuEndVoice() {
        if icon.linkUp { fire("end"); return }
        guard let req = request, let dir = req.dataDir, daemonRecordsPort(dataDir: dir, port: req.port),
              let key = DataDirTrust.readOwnedFile(dataDir: dir, name: "daemon.key"), !key.isEmpty else {
            closeVoiceWindow(reason: "voice_off_unreachable")
            return
        }
        var r = URLRequest(url: URL(string: "http://127.0.0.1:\(req.port)/control")!)
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.setValue(key, forHTTPHeaderField: "X-Sotto-Key")
        r.httpBody = Data("{\"action\":\"off\"}".utf8)
        r.timeoutInterval = 3
        URLSession.shared.dataTask(with: r) { [weak self] _, resp, _ in
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self?.log.log("voice_off", ["status": status])
                    if status != 200 { self?.closeVoiceWindow(reason: "voice_off_unreachable") }
                }
            }
        }.resume()
    }

    func menuOpenBrowser() { fire("open_browser") }

    func menuOpenLogs() {
        guard let dir = dataDir ?? settingsDataDir else { return }
        let file = URL(fileURLWithPath: dir).appendingPathComponent("logs/daemon.log")
        let target = FileManager.default.fileExists(atPath: file.path) ? file : file.deletingLastPathComponent()
        NSWorkspace.shared.open(target)
    }

    func menuSettings() { showSettings(activate: true, reason: "menu") }

    // MARK: settings

    func showSettings(activate: Bool, reason: String) {
        if settingsWindow == nil {
            let w = SettingsWindowController(model: settings, log: log)
            w.onClose = { [weak self] in
                guard let self = self else { return }
                if self.settings.metering { self.settings.metering = false }
            }
            settingsWindow = w
        }
        refreshDevices()
        refreshPermissions()
        settingsWindow?.show(activate: activate, reason: reason)
    }

    /// First run: the microphone question, then the API key, in the Settings
    /// window, once per step (never in test mode, never stealing focus).
    private func maybeShowOnboarding() {
        guard !options.testMode, icon.linkUp else { return }
        let step = settings.onboardingStep
        if let s = step, s != onboardingShown {
            onboardingShown = s
            showSettings(activate: false, reason: "onboarding_\(s.rawValue)")
        } else if step == nil {
            onboardingShown = nil
        }
    }

    /// lib.micFailureKind names for the panel's mic card.
    nonisolated static func micFailureKind(_ e: AudioIOError) -> String {
        switch e {
        case .micDenied, .micRestricted: return "macos"
        case .noInputDevice: return "notfound"
        default: return "other"
        }
    }

    nonisolated static func choice(_ d: AudioDevice) -> DeviceChoice {
        DeviceChoice(id: d.id, name: d.name, bluetooth: d.bluetooth, headphones: d.headphones)
    }

    private func refreshDevices() {
        guard let io = audio else { return }
        let ins = io.inputDevices(), outs = io.outputDevices()
        settings.inputDevices = ins.map(AppController.choice)
        settings.outputDevices = outs.map(AppController.choice)
        let di = io.defaultDeviceID(input: true), dout = io.defaultDeviceID(input: false)
        settings.defaultInputName = ins.first { $0.id == di }?.name
        settings.defaultOutputName = outs.first { $0.id == dout }?.name
    }

    /// The device lists changed (a route change, a device plugged or unplugged): refresh the
    /// footer picker, and when the device the user chose is gone, fall back to the macOS system
    /// default (never another device) and flash its footer icon (SPEC-DEVIATIONS "Devices in the footer").
    private func devicesChanged() {
        refreshDevices()
        if DeviceMenu.lost(selected: settings.selectedInput, devices: settings.inputDevices) {
            log.log("device_lost", ["kind": "input"])
            settings.chooseInput(nil)
            model.flashDevice("input")
        }
        if DeviceMenu.lost(selected: settings.selectedOutput, devices: settings.outputDevices) {
            log.log("device_lost", ["kind": "output"])
            settings.chooseOutput(nil)
            model.flashDevice("output")
        }
    }

    /// Mic and login-item state. Test mode never reads TCC or SMAppService (no prompts, no side effects).
    private func refreshPermissions() {
        if options.testMode {
            settings.micPermission = .granted
            settings.loginItem = .unavailable
            return
        }
        settings.micPermission = MicAccess.current()
        settings.loginItem = LoginItem.current()
    }

    /// Settings > Appearance: System (nil, follows macOS live), Light (.aqua) or Dark (.darkAqua)
    /// for every window of the app. The panel and Settings read it through their colour scheme.
    static func applyAppearance(_ choice: String) {
        switch choice {
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        default: NSApp.appearance = nil
        }
    }

    private func wireSettings() {
        let d = Prefs.store
        settings.appearance = ViewText.normalizeTheme(d.string(forKey: "Appearance"))
        AppController.applyAppearance(settings.appearance)
        settings.selectedInput = d.string(forKey: "InputDevice")
        settings.selectedOutput = d.string(forKey: "OutputDevice")
        settings.echoCancellation = audio?.echoCancellation.rawValue ?? "automatic"
        refreshPermissions()
        var h = SettingsHooks()
        h.selectInput = { [weak self] id in
            guard let self = self else { return }
            Prefs.store.set(id, forKey: "InputDevice")
            self.settings.selectedInput = id
            self.audio?.setPreferredDevices(input: id, output: self.settings.selectedOutput)
            self.log.log("device_pref", ["kind": "input", "automatic": id == nil])
        }
        h.selectOutput = { [weak self] id in
            guard let self = self else { return }
            Prefs.store.set(id, forKey: "OutputDevice")
            self.settings.selectedOutput = id
            self.audio?.setPreferredDevices(input: self.settings.selectedInput, output: id)
            self.log.log("device_pref", ["kind": "output", "automatic": id == nil])
        }
        h.setEchoCancellation = { [weak self] raw in
            guard let self = self, let ec = EchoCancellation(rawValue: raw) else { return }
            Prefs.store.set(raw, forKey: "EchoCancellation")
            self.audio?.echoCancellation = ec
            self.settings.echoCancellation = raw
            self.sendRoute()
        }
        h.playVoicePreview = { [weak self] voice in
            guard let self = self, let l = self.link, let io = self.audio else { return }
            let wav = try await l.fetchVoicePreview(voice)
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                io.playSample(wav) { c.resume() }
            }
            // The echo filter learns the sample's words (docs/NATIVE.md §3.2 `played`).
            l.send(.played(what: "sample", voice: voice))
        }
        h.stopVoicePreview = { [weak self] in self?.audio?.stopSample() }
        h.openLogs = { [weak self] in self?.menuOpenLogs() }
        h.refreshDevices = { [weak self] in self?.refreshDevices() }
        h.openMicPrivacySettings = { MicAccess.openPrivacySettings() }
        h.setAppearance = { [weak self] choice in
            Prefs.store.set(choice == "system" ? nil : choice, forKey: "Appearance")
            AppController.applyAppearance(choice)
            self?.log.log("appearance", ["choice": choice])
        }
        if !options.testMode {
            h.requestMicAccess = { [weak self] in
                let p = await MicAccess.request()
                self?.settings.micPermission = p
                return p
            }
            h.setLaunchAtLogin = { on in try LoginItem.set(on) }
        }
        settings.hooks = h
        NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshPermissions() }
        }
    }

    func menuToggleResident() {
        stayResident.toggle()
        refresh()
    }

    func menuQuit() { NSApp.terminate(nil) }

    // MARK: presentation

    private func refresh() {
        let now = Date().timeIntervalSince1970
        icon.muted = model.effectiveMuted || mutePending
        let ic = IconModel.icon(icon, now: now)
        if ic != lastIcon {
            lastIcon = ic
            log.log("icon", ["state": ic.rawValue])
        }
        let project = model.status?.owner?.project ?? ""
        let muted = model.effectiveMuted || mutePending
        var ms = MenuState()
        ms.icon = ic
        ms.phase = HybridText.Phase(head: ViewText.claudeHead(model.claudeCard).phase)
        panel?.setTitle(ViewText.windowTitle(floor: model.pageView.floor, attention: model.attention))
        ms.project = project
        ms.errorMessage = model.status?.last_error?.message ?? ""
        ms.attached = request != nil
        ms.linkUp = icon.linkUp
        ms.panelVisible = panel?.isVisible ?? false
        ms.compact = panel?.compact ?? false
        ms.muted = muted
        ms.state = model.status?.state ?? "off"
        ms.hasDataDir = (dataDir ?? settingsDataDir) != nil
        ms.stayResident = stayResident
        ms.muteKey = muteSpec.display
        ms.showKey = showSpec.display
        menuBar?.update(ms)
        // Speaking states decay on their own: re-evaluate shortly after.
        decayTimer?.invalidate()
        if ic == .userSpeaking || ic == .assistantSpeaking {
            let t = Timer(timeInterval: 0.4, repeats: false) { [weak self] _ in MainActor.assumeIsolated { self?.refresh() } }
            RunLoop.main.add(t, forMode: .common)
            decayTimer = t
        }
    }
}

/// The engine and its mode, readable from the link queue (stats, playout).
final class EngineBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _io: AudioIO?
    private var _mode = "off"
    private var lastSpeakerRx: UInt64 = 0
    /// Link queue: true when this speaker frame follows a gap of 400 ms or more.
    func speakerFrameStartsBurst() -> Bool {
        let now = DispatchTime.now().uptimeNanoseconds
        lock.lock(); defer { lock.unlock() }
        let starts = now &- lastSpeakerRx >= 400_000_000
        lastSpeakerRx = now
        return starts
    }
    var io: AudioIO? {
        get { lock.lock(); defer { lock.unlock() }; return _io }
        set { lock.lock(); _io = newValue; lock.unlock() }
    }
    var mode: String {
        get { lock.lock(); defer { lock.unlock() }; return _mode }
        set { lock.lock(); _mode = newValue; lock.unlock() }
    }
    /// One audio_stats payload (micSeq is filled in by the pump); nil while the engine is off.
    func statsMessage() -> AudioStatsMessage? {
        let m = mode
        guard m != "off", let io = io else { return nil }
        let s = io.stats()
        return AudioStatsMessage(playoutSeq: s.playoutSeq, playoutHostNs: s.playoutHostNs, bufferMs: s.bufferMs,
                                 underruns: s.underruns, overruns: s.overruns, captureDrops: s.captureDrops, mode: m, micSeq: 0)
    }
}
