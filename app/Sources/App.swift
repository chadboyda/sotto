// Sotto: menu-bar app + floating voice panel for the sotto plugin
// (SPEC §6.16). It hosts the SAME voice page the Chrome --app window shows,
// served by the daemon on 127.0.0.1:<port>; everything voice-related (WebRTC,
// SSE, captions, pickers) is the page's job. The app adds: a status icon, a
// floating non-activating panel, global hotkeys, and menu actions.
import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, PanelControllerDelegate {
    private let options: Options
    private let log: DebugLog
    private var statusItem: NSStatusItem!
    private var panel: PanelController!
    private var model = VoiceModel()
    private var request: LaunchRequest?
    private var decayTimer: Timer?
    private var lastIcon: VoiceIcon?
    private var quitting = false
    private var launched = false
    private var pendingURLs: [URL] = []
    private var muteSpec = HotkeySpec.parse("opt+cmd+m")!
    private var showSpec = HotkeySpec.parse("opt+cmd+t")!

    // Menu items updated live.
    private let headerItem = NSMenuItem(title: "Sotto", action: nil, keyEquivalent: "")
    private let showItem = NSMenuItem(title: "Show Panel", action: #selector(menuToggleShow), keyEquivalent: "")
    private let compactItem = NSMenuItem(title: "Compact Panel", action: #selector(menuToggleCompact), keyEquivalent: "")
    private let muteItem = NSMenuItem(title: "Mute", action: #selector(menuMute), keyEquivalent: "")
    private let offItem = NSMenuItem(title: "Voice Off", action: #selector(menuVoiceOff), keyEquivalent: "")
    private let logsItem = NSMenuItem(title: "Open Logs", action: #selector(menuOpenLogs), keyEquivalent: "")
    private let residentItem = NSMenuItem(title: "Stay in Menu Bar When Voice Is Off", action: #selector(menuToggleResident), keyEquivalent: "")

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
        self.log = DebugLog(path: options.debugLog)
        super.init()
    }

    // MARK: lifecycle

    func applicationDidFinishLaunching(_ n: Notification) {
        log.log("launch", ["pid": Int(ProcessInfo.processInfo.processIdentifier), "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev",
                           "os": ProcessInfo.processInfo.operatingSystemVersionString])
        let bridge = Bundle.main.url(forResource: "bridge", withExtension: "js").flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
        if bridge.isEmpty { log.log("bridge_missing") }
        let micJS = Bundle.main.url(forResource: "mic", withExtension: "js").flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
        if micJS.isEmpty { log.log("mic_js_missing") }
        let mic = MicController(log: log, testMode: options.testMode)
        log.log("mic_pref", ["pref": mic.pref, "echo_sim_db": mic.echoSimDb ?? NSNull()])
        panel = PanelController(bridgeSource: bridge, micSource: micJS, mic: mic, log: log, mockCapture: options.mockCapture)
        mic.startRouteWatch()
        panel.delegate = self
        log.log("audio_route", AudioRoute.current().dictionary)
        setupStatusItem()
        if options.hotkeys { setupHotkeys() }
        launched = true
        if let req = options.request { open(req) }
        // A LaunchServices launch delivers its URL before didFinishLaunching.
        let queued = pendingURLs
        pendingURLs = []
        for url in queued { handle(url) }
        if let secs = options.exitAfter {
            DispatchQueue.main.asyncAfter(deadline: .now() + secs) { [weak self] in
                self?.log.log("exit_after")
                NSApp.terminate(nil)
                // Test mode must never linger, whatever the page is doing.
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
        // Unload the page first so its pagehide handler ends the paid Live
        // session (session.close + unload beacon, SPEC §7.3) before we exit.
        guard !quitting, panel?.webView != nil else { return .terminateNow }
        quitting = true
        log.log("terminate", ["unload": true])
        panel.unload()
        // A plain Timer in the common modes: the run loop is in the modal-panel
        // mode while termination is pending.
        let t = Timer(timeInterval: 0.4, repeats: false) { _ in sender.reply(toApplicationShouldTerminate: true) }
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
            open(req)
        case .close(let port): if let p = port, p == request?.port { closeVoiceWindow(reason: "url") }
        case .show: if request != nil { panel.show() }
        }
    }

    private func open(_ req: LaunchRequest) {
        log.log("open", ["port": req.port, "has_code": req.code != nil, "has_data_dir": req.dataDir != nil])
        request = req
        model = VoiceModel()
        panel.load(req)
        panel.show()
        if options.hidden { panel.hide() }
        refresh()
    }

    /// The daemon closed the voice window (voice off): drop the page, hide,
    /// and quit unless the user asked the app to stay in the menu bar.
    private func closeVoiceWindow(reason: String) {
        log.log("close_window", ["reason": reason])
        panel.unload()
        panel.orderOut()
        model = VoiceModel()
        request = request.map { LaunchRequest(port: $0.port, code: nil, dataDir: $0.dataDir) }
        refresh()
        if !stayResident {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { NSApp.terminate(nil) }
        }
    }

    // MARK: PanelControllerDelegate

    func panelBridgeMessage(_ m: [String: Any]) {
        let kind = m["kind"] as? String ?? ""
        if log.enabled && kind != "speaking" {
            // State only: the bridge never sends captions or tokens.
            log.log("bridge", m.filter { ["kind", "state", "command", "muted", "busy", "error", "ok", "name", "live", "reason", "open",
                                          "echoCancellation", "noiseSuppression", "autoGainControl", "sampleRate", "level", "code", "project", "source"].contains($0.key) })
        }
        if kind == "command", (m["command"] as? String) == "close_window" {
            // Let the page tear down (it calls window.close() 150 ms later; that
            // is refused in some cases, so do not depend on it).
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                guard let self = self, self.panel.webView != nil else { return }
                self.closeVoiceWindow(reason: "close_window")
            }
            return
        }
        model.apply(m, now: Date().timeIntervalSince1970)
        refresh()
    }

    func panelPageLoaded(_ ok: Bool, detail: String) {
        model.pageLoaded = ok
        if !ok { model.errorCode = "page_load"; model.errorMessage = detail }
        refresh()
        if ok && options.probeMedia { runMediaProbe() }
    }

    func panelPageClosedByScript() { closeVoiceWindow(reason: "window.close") }
    func panelToggleMute() { toggleMute() }
    func panelVisibilityChanged() { refreshMenu() }

    // MARK: actions

    private func toggleMute() {
        panel.evaluate("window.sottoHost && window.sottoHost.toggleMute()")
    }

    /// Menu item and ⌥⌘T: show a hidden panel, expand a compact one, hide a full one.
    @objc private func menuToggleShow() {
        guard request != nil else { return }
        panel.showOrExpandOrHide()
    }

    @objc private func menuToggleCompact() {
        panel.setCompact(!panel.compact)
        if request != nil && !panel.isVisible { panel.show() }
    }

    @objc private func menuMute() { toggleMute() }

    @objc private func menuToggleResident() {
        stayResident.toggle()
        refreshMenu()
    }

    /// Voice off for every session, exactly like `/talk off`: POST /control
    /// {action:"off"} with the daemon key from <data dir>/daemon.key. The key
    /// is read at click time and never stored or logged, and is sent only to
    /// the port this data dir's daemon records.
    @objc private func menuVoiceOff() {
        guard let req = request, let dir = req.dataDir, daemonRecordsPort(dataDir: dir, port: req.port),
              let key = try? String(contentsOfFile: dir + "/daemon.key", encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
              !key.isEmpty else {
            // No data dir (direct test launch): ask the page to stop instead.
            panel.evaluate("window.sottoHost && window.sottoHost.stopVoice()")
            return
        }
        var r = URLRequest(url: URL(string: "http://127.0.0.1:\(req.port)/control")!)
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.setValue(key, forHTTPHeaderField: "X-Sotto-Key")
        r.httpBody = Data("{\"action\":\"off\"}".utf8)
        r.timeoutInterval = 3
        URLSession.shared.dataTask(with: r) { [weak self] _, resp, err in
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            DispatchQueue.main.async {
                self?.log.log("voice_off", ["status": status])
                if status != 200 { self?.closeVoiceWindow(reason: "voice_off_unreachable") }
            }
        }.resume()
    }

    @objc private func menuOpenLogs() {
        guard let dir = request?.dataDir else { return }
        let logs = URL(fileURLWithPath: dir).appendingPathComponent("logs", isDirectory: true)
        NSWorkspace.shared.open(logs)
    }

    @objc private func menuQuit() { NSApp.terminate(nil) }

    // MARK: status item + menu

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.imagePosition = .imageOnly
        let menu = NSMenu()
        menu.autoenablesItems = false
        headerItem.isEnabled = false
        for item in [showItem, compactItem, muteItem, offItem, logsItem, residentItem] { item.target = self }
        showItem.keyEquivalent = showSpec.keyEquivalent
        showItem.keyEquivalentModifierMask = showSpec.flags
        muteItem.keyEquivalent = muteSpec.keyEquivalent
        muteItem.keyEquivalentModifierMask = muteSpec.flags
        menu.addItem(headerItem)
        menu.addItem(.separator())
        menu.addItem(showItem)
        menu.addItem(compactItem)
        menu.addItem(muteItem)
        menu.addItem(offItem)
        menu.addItem(.separator())
        menu.addItem(logsItem)
        menu.addItem(residentItem)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Sotto", action: #selector(menuQuit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        statusItem.menu = menu
    }

    /// Hotkeys come from user defaults (HotkeyMute / HotkeyShow, e.g. "ctrl+opt+m");
    /// invalid values fall back to the defaults ⌥⌘M and ⌥⌘T.
    private func setupHotkeys() {
        let d = Prefs.store
        if let s = d.string(forKey: "HotkeyMute"), let spec = HotkeySpec.parse(s) { muteSpec = spec }
        if let s = d.string(forKey: "HotkeyShow"), let spec = HotkeySpec.parse(s) { showSpec = spec }
        let m = Hotkeys.shared.register(muteSpec) { [weak self] in self?.toggleMute() }
        let t = Hotkeys.shared.register(showSpec) { [weak self] in self?.menuToggleShow() }
        log.log("hotkeys", ["mute": muteSpec.display, "mute_ok": m, "show": showSpec.display, "show_ok": t])
        showItem.keyEquivalent = showSpec.keyEquivalent
        showItem.keyEquivalentModifierMask = showSpec.flags
        muteItem.keyEquivalent = muteSpec.keyEquivalent
        muteItem.keyEquivalentModifierMask = muteSpec.flags
    }

    private func refresh() {
        let now = Date().timeIntervalSince1970
        let icon = request == nil ? VoiceIcon.off : model.icon(now: now)
        if icon != lastIcon {
            lastIcon = icon
            log.log("icon", ["state": icon.rawValue])
        }
        if let b = statusItem?.button {
            let img = NSImage(systemSymbolName: icon.symbol, accessibilityDescription: "Sotto: \(icon.label)")
            img?.isTemplate = true
            b.image = img
            b.contentTintColor = icon.tint
            var tip = "Sotto: \(icon.label)"
            if !model.project.isEmpty { tip += " (\(model.project))" }
            if icon == .error, !model.errorMessage.isEmpty { tip += "\n\(model.errorMessage)" }
            b.toolTip = tip
        }
        panel?.updatePill(icon: icon, project: model.project, muted: model.muted)
        refreshMenu()
        // Speaking states decay on their own: re-evaluate shortly after.
        decayTimer?.invalidate()
        if icon == .userSpeaking || icon == .assistantSpeaking {
            decayTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { [weak self] _ in self?.refresh() }
        }
    }

    private func refreshMenu() {
        guard panel != nil else { return }
        let icon = lastIcon ?? .off
        headerItem.title = model.project.isEmpty ? "Sotto: \(icon.label)" : "Sotto: \(icon.label) (\(model.project))"
        let hasPage = request != nil && panel.webView != nil
        showItem.title = !panel.isVisible ? "Show Panel" : panel.compact ? "Show Full Panel" : "Hide Panel"
        showItem.isEnabled = hasPage
        compactItem.title = panel.compact ? "Expand Panel" : "Compact Panel"
        muteItem.title = model.muted ? "Unmute" : "Mute"
        muteItem.isEnabled = hasPage && model.state == "live"
        offItem.isEnabled = hasPage && model.state != "off"
        logsItem.isEnabled = request?.dataDir != nil
        residentItem.state = stayResident ? .on : .off
    }

    // MARK: test probe (--probe-media)

    /// Evidence for SPEC §6.16 / ARCHITECTURE §6: does WKWebView give us a mic
    /// track with echo cancellation, and a working RTCPeerConnection?
    private func runMediaProbe() {
        let js = """
        const out = { ua: navigator.userAgent, secure: window.isSecureContext, visibility: document.visibilityState };
        out.supported = navigator.mediaDevices ? navigator.mediaDevices.getSupportedConstraints() : null;
        out.rtc = typeof RTCPeerConnection;
        out.setSinkId = typeof HTMLMediaElement.prototype.setSinkId;
        const pre = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
        out.labelsBeforePermission = pre.some((d) => d.label);

        // Same request the page makes on a first run (default device).
        const grab = async (ec) => {
          const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: ec, noiseSuppression: ec, autoGainControl: ec, channelCount: 1 } });
          const t = s.getAudioTracks()[0];
          return { s, t, r: { label: t.label, settings: t.getSettings(), capabilities: t.getCapabilities ? t.getCapabilities() : null } };
        };
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        try {
          const a = await grab(true);
          out.withAEC = a.r;
          const pc = new RTCPeerConnection();
          pc.addTrack(a.t, a.s);
          pc.createDataChannel("oai-events");
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          out.offer = { opus: /opus\\/48000/i.test(offer.sdp), datachannel: /webrtc-datachannel/.test(offer.sdp), audio: /m=audio/.test(offer.sdp) };
          pc.close();
          await sleep(1500);
          a.s.getTracks().forEach((x) => x.stop());
          const b = await grab(false);
          out.withoutAEC = { label: b.r.label, settings: b.r.settings };
          b.s.getTracks().forEach((x) => x.stop());
        } catch (e) {
          out.error = String(e && e.name) + ": " + String(e && e.message);
        }
        return JSON.stringify(out);
        """
        log.log("probe_start")
        panel.callAsync(js) { [weak self] r in
            self?.logProbe("probe", r)
            self?.runHiddenProbe()
        }
    }

    /// Second probe: hide the panel, then open the mic and measure its level
    /// while hidden (a reconnect can happen while the user has hidden it).
    private func runHiddenProbe() {
        panel.hide()
        let js = """
        const out = { visibility: document.visibilityState, hidden: document.hidden };
        const t0 = performance.now();
        const race = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
        try {
          const s = await race(navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } }), 4000);
          out.gumMs = Math.round(performance.now() - t0);
          const ctx = new AudioContext();
          const an = ctx.createAnalyser();
          ctx.createMediaStreamSource(s).connect(an);
          const buf = new Float32Array(an.fftSize);
          let peak = 0;
          for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 100)); an.getFloatTimeDomainData(buf); let sum = 0; for (const v of buf) sum += v * v; peak = Math.max(peak, Math.sqrt(sum / buf.length)); }
          out.peakRms = peak;
          out.label = s.getAudioTracks()[0].label;
          out.trackState = s.getAudioTracks()[0].readyState;
          out.trackMuted = s.getAudioTracks()[0].muted;
          s.getTracks().forEach((x) => x.stop());
          ctx.close();
        } catch (e) {
          out.error = String(e && e.name) + ": " + String(e && e.message);
        }
        return JSON.stringify(out);
        """
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.panel.callAsync(js) { r in self?.logProbe("probe_hidden", r) }
        }
    }

    private func logProbe(_ ev: String, _ r: Result<Any, Error>) {
        switch r {
        case .success(let v):
            let obj = (v as? String).flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) } ?? ["raw": "\(v)"]
            log.log(ev, ["result": obj])
        case .failure(let e):
            log.log(ev, ["error": e.localizedDescription])
        }
    }
}
