// The floating voice panel: a non-activating, always-on-top NSPanel on every
// Space that hosts the daemon's voice page in a WKWebView, and collapses to a
// compact native pill (the web view stays loaded and live underneath).
import AppKit
import WebKit

final class VoicePanel: NSPanel {
    // Borderless (compact) panels refuse key status by default; the page needs
    // key status for its own hotkeys and the device pickers.
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// Weak proxy: WKUserContentController retains its script message handlers.
final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ t: WKScriptMessageHandler) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}

protocol PanelControllerDelegate: AnyObject {
    func panelBridgeMessage(_ m: [String: Any])
    func panelPageLoaded(_ ok: Bool, detail: String)
    func panelPageClosedByScript()
    func panelToggleMute()
    func panelVisibilityChanged()
}

final class PanelController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    /// web/lib.js MIC_SETTINGS_URL: System Settings > Privacy & Security > Microphone.
    static let micSettingsURL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
    static let expandedSize = PanelGeometry.defaultSize
    static let pillSize = NSSize(width: 290, height: 44)
    private static let frameKey = "PanelFrame"
    private static let compactKey = "PanelCompact"

    let panel: VoicePanel
    private(set) var webView: WKWebView?
    private let pill = PillView()
    private let bridgeSource: String
    private let micSource: String
    /// Native mic (MicBridge.swift); nil keeps WebKit's capture only.
    let mic: MicController?
    private let log: DebugLog
    private let mockCapture: Bool
    weak var delegate: PanelControllerDelegate?
    private(set) var request: LaunchRequest?
    private(set) var compact: Bool
    private var restoringFrame = false

    init(bridgeSource: String, micSource: String, mic: MicController?, log: DebugLog, mockCapture: Bool) {
        self.bridgeSource = bridgeSource
        self.micSource = micSource
        self.mic = mic
        self.log = log
        self.mockCapture = mockCapture
        compact = Prefs.store.bool(forKey: PanelController.compactKey)
        panel = VoicePanel(contentRect: NSRect(origin: .zero, size: PanelController.expandedSize),
                           styleMask: PanelController.expandedStyle, backing: .buffered, defer: true)
        super.init()
        panel.title = "Sotto"
        panel.titlebarAppearsTransparent = true
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.minSize = PanelGeometry.minSize
        panel.delegate = self
        panel.contentView = NSView(frame: NSRect(origin: .zero, size: PanelController.expandedSize))
        panel.contentView?.wantsLayer = true
        pill.onExpand = { [weak self] in self?.setCompact(false) }
        pill.onMute = { [weak self] in self?.delegate?.panelToggleMute() }
        mic?.evaluate = { [weak self] js in self?.evaluate(js) }
        mic?.isOurs = { [weak self] o in self?.isOurs(o) ?? false }
        restoreFrame()
    }

    static let expandedStyle: NSWindow.StyleMask = [.titled, .closable, .resizable, .nonactivatingPanel, .fullSizeContentView, .utilityWindow]
    static let compactStyle: NSWindow.StyleMask = [.borderless, .nonactivatingPanel]

    /// Shown to the user (a hidden panel stays ordered in, fully transparent).
    var isVisible: Bool { panel.isVisible && panel.alphaValue > 0 }

    // MARK: page

    /// Load the voice page for a launch request in a fresh web view (clean
    /// history, so the page's window.close() is allowed; new launch code).
    func load(_ req: LaunchRequest) {
        request = req
        destroyWebView()
        let cfg = WKWebViewConfiguration()
        cfg.mediaTypesRequiringUserActionForPlayback = [] // the page autoplays the remote voice track
        // Persistent store keeps the page's device choices (localStorage); tests use a throwaway one.
        cfg.websiteDataStore = Prefs.testMode ? .nonPersistent() : .default()
        let ucc = WKUserContentController()
        // mic.js first: bridge.js then observes the getUserMedia that mic.js provides.
        if let m = mic, !micSource.isEmpty {
            ucc.addUserScript(WKUserScript(source: m.pageConfigScript + micSource, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            ucc.addScriptMessageHandler(WeakReplyHandler(m), contentWorld: .page, name: "sottoMic")
        }
        ucc.addUserScript(WKUserScript(source: bridgeSource, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.addUserScript(WKUserScript(source: PanelController.hostChromeSource(inset: PanelController.titlebarInset),
                                       injectionTime: .atDocumentStart, forMainFrameOnly: true))
        if Prefs.testMode { ucc.addUserScript(WKUserScript(source: PanelController.testSilenceSource, injectionTime: .atDocumentEnd, forMainFrameOnly: true)) }
        ucc.add(WeakScriptHandler(self), name: "sottoHost")
        cfg.userContentController = ucc
        PanelController.setSPI(cfg.preferences, "_setGetUserMediaRequiresFocus:", false)
        PanelController.setSPI(cfg.preferences, "_setInterruptAudioOnPageVisibilityChangeEnabled:", false)
        if mockCapture { PanelController.setSPI(cfg.preferences, "_setMockCaptureDevicesEnabled:", true) }
        let wv = WKWebView(frame: contentBounds(forExpanded: true), configuration: cfg)
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.autoresizingMask = compact ? [] : [.width, .height]
        wv.setValue(false, forKey: "drawsBackground") // no white flash before the page paints
        // A panel covered by other windows stays a "visible" page, so capture
        // and playback are never throttled while the user works elsewhere.
        PanelController.setSPI(wv, "_setWindowOcclusionDetectionEnabled:", false)
        if #available(macOS 13.3, *) { wv.isInspectable = log.enabled }
        // Test mode never plays the model's voice out loud (the user may be
        // in a voice session on the same speakers): _WKMediaAudioMuted.
        if Prefs.testMode { PanelController.setSPIUInt(wv, "_setPageMuted:", 1) }
        wv.alphaValue = compact ? 0 : 1
        panel.contentView?.addSubview(wv, positioned: .below, relativeTo: nil)
        webView = wv
        layoutPill()
        log.log("load_start", ["url": "http://127.0.0.1:\(req.port)/", "has_code": req.code != nil])
        wv.load(URLRequest(url: req.pageURL))
    }

    /// Unload the page. Navigating away fires the page's pagehide handler,
    /// which sends session.close + the unload beacon (SPEC §7.3), so the paid
    /// Live session ends even if the app then quits.
    func unload() {
        mic?.stopAll()
        guard let wv = webView else { return }
        wv.loadHTMLString("", baseURL: nil)
        let old = wv
        webView = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            old.removeFromSuperview()
        }
    }

    private func destroyWebView() {
        mic?.stopAll()
        guard let wv = webView else { return }
        wv.stopLoading()
        wv.loadHTMLString("", baseURL: nil)
        wv.removeFromSuperview()
        webView = nil
    }

    func evaluate(_ js: String) {
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    func callAsync(_ js: String, completion: @escaping (Result<Any, Error>) -> Void) {
        guard let wv = webView else {
            completion(.failure(NSError(domain: "Sotto", code: 1, userInfo: [NSLocalizedDescriptionKey: "no page"])))
            return
        }
        wv.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { r in
            switch r {
            case .success(let v): completion(.success(v))
            case .failure(let e): completion(.failure(e))
            }
        }
    }

    /// Height of the expanded panel's title bar. The page is drawn under it
    /// (transparent full-size title bar), so the page pads its header by this
    /// much and the window buttons never sit on the status line.
    static var titlebarInset: CGFloat {
        let r = NSRect(x: 0, y: 0, width: 420, height: 640)
        let f = NSWindow.frameRect(forContentRect: r, styleMask: expandedStyle.subtracting(.fullSizeContentView))
        return max(0, min(64, (f.height - r.height).rounded()))
    }

    /// Host chrome for the page (SPEC §6.16 "Title bar"): class `host-app` on
    /// <html> and `--host-inset-top` = the title bar height; web/styles.css
    /// pads the header by it. A page without the rule is unaffected.
    static func hostChromeSource(inset: CGFloat) -> String {
        """
        (() => { const d = document.documentElement; if (!d) return;
          d.classList.add("host-app"); d.style.setProperty("--host-inset-top", "\(Int(inset))px"); })();
        """
    }

    /// Set a BOOL WebKit SPI if this WebKit has it (checked at run time, so a
    /// WebKit without it just keeps its default). Used for:
    ///  - _setGetUserMediaRequiresFocus: NO, so a reconnect while the panel is
    ///    hidden or unfocused does not wait for focus (verified: without it
    ///    getUserMedia never resolves in a hidden panel);
    ///  - _setInterruptAudioOnPageVisibilityChangeEnabled: NO;
    ///  - _setWindowOcclusionDetectionEnabled: NO (on the web view);
    ///  - _setMockCaptureDevicesEnabled: YES, only for the automated launch
    ///    test (--mock-capture), which then needs no microphone permission.
    /// Test mode only: the page's media elements never reach the speakers. A
    /// live voice session on the same Mac would hear the test's model voice
    /// through its microphone and take it as the user speaking. The remote
    /// voice track still flows (the dial meters an unplayed clone of it), and
    /// production is unchanged: this script is only added when `--test` or
    /// SOTTO_APP_TEST=1 is set. Reports {kind:"silenced"} so tests can assert it.
    static let testSilenceSource = """
    (() => {
      const hush = (el) => { el.muted = true; el.volume = 0; };
      const all = () => Array.from(document.querySelectorAll("audio, video"));
      all().forEach(hush);
      document.addEventListener("volumechange", (e) => { if (e.target instanceof HTMLMediaElement && !(e.target.muted && e.target.volume === 0)) hush(e.target); }, true);
      document.addEventListener("play", (e) => { if (e.target instanceof HTMLMediaElement) hush(e.target); }, true);
      const els = all();
      try { window.webkit.messageHandlers.sottoHost.postMessage({ kind: "silenced", ok: els.length > 0 && els.every((el) => el.muted && el.volume === 0) }); } catch {}
    })();
    """

    static func setSPI(_ obj: NSObject, _ selector: String, _ value: Bool) {
        let sel = NSSelectorFromString(selector)
        guard obj.responds(to: sel), let m = class_getInstanceMethod(type(of: obj), sel) else { return }
        typealias Fn = @convention(c) (AnyObject, Selector, Bool) -> Void
        unsafeBitCast(method_getImplementation(m), to: Fn.self)(obj, sel, value)
    }

    static func setSPIUInt(_ obj: NSObject, _ selector: String, _ value: UInt) {
        let sel = NSSelectorFromString(selector)
        guard obj.responds(to: sel), let m = class_getInstanceMethod(type(of: obj), sel) else { return }
        typealias Fn = @convention(c) (AnyObject, Selector, UInt) -> Void
        unsafeBitCast(method_getImplementation(m), to: Fn.self)(obj, sel, value)
    }

    // MARK: show / hide / compact

    func show() {
        if compact { applyCompactFrame() }
        panel.alphaValue = 1
        panel.ignoresMouseEvents = false
        panel.orderFrontRegardless() // never activates: the terminal keeps focus
        delegate?.panelVisibilityChanged()
    }

    /// Hide without ordering the panel out. WebKit treats an ordered-out
    /// window as a hidden page, and a hidden page's getUserMedia never resolves
    /// (verified on macOS 26: it timed out even with the focus requirement
    /// off), so a reconnect or resume while hidden would hang. A transparent,
    /// click-through panel keeps the page "visible" and the voice working.
    func hide() {
        if panel.isKeyWindow { panel.resignKey() }
        panel.alphaValue = 0
        panel.ignoresMouseEvents = true
        delegate?.panelVisibilityChanged()
    }

    /// Really take the panel off screen (no page loaded).
    func orderOut() {
        panel.orderOut(nil)
        panel.alphaValue = 1
        panel.ignoresMouseEvents = false
        delegate?.panelVisibilityChanged()
    }

    func toggleVisible() { isVisible ? hide() : show() }

    /// ⌥⌘T: hidden → shown; compact → the full panel; expanded → hidden.
    func showOrExpandOrHide() {
        if !isVisible { show() } else if compact { setCompact(false) } else { hide() }
    }

    func setCompact(_ on: Bool) {
        guard on != compact else { return }
        if on { saveFrame() }
        compact = on
        Prefs.store.set(on, forKey: PanelController.compactKey)
        if on {
            panel.styleMask = PanelController.compactStyle
            panel.isMovableByWindowBackground = true
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.hasShadow = true
            // Keep the page at full size (clipped, invisible) so it keeps
            // running as a visible page; only the native pill shows.
            webView?.autoresizingMask = []
            webView?.alphaValue = 0
            applyCompactFrame()
        } else {
            panel.styleMask = PanelController.expandedStyle
            panel.isMovableByWindowBackground = false
            panel.backgroundColor = .windowBackgroundColor
            panel.isOpaque = true
            restoringFrame = true
            let e = expandedFrame()
            panel.setFrame(e, display: true)
            restoringFrame = false
            log.log("panel_frame", ["compact": false, "frame": [e.minX, e.minY, e.width, e.height], "reason": lastFrameReason])
            webView?.frame = contentBounds(forExpanded: true)
            webView?.autoresizingMask = [.width, .height]
            webView?.alphaValue = 1
        }
        layoutPill()
        delegate?.panelVisibilityChanged()
    }

    func updatePill(icon: VoiceIcon, project: String, muted: Bool) {
        pill.update(icon: icon, project: project, muted: muted)
    }

    private func layoutPill() {
        guard let cv = panel.contentView else { return }
        if compact {
            pill.frame = NSRect(origin: .zero, size: PanelController.pillSize)
            if pill.superview == nil { cv.addSubview(pill) }
            // Web view parked below/behind the pill at its expanded size.
            if let wv = webView {
                let size = expandedFrame().size
                wv.frame = NSRect(x: 0, y: PanelController.pillSize.height - size.height, width: size.width, height: size.height)
            }
        } else {
            pill.removeFromSuperview()
        }
    }

    private func contentBounds(forExpanded: Bool) -> NSRect {
        if compact && forExpanded { return NSRect(origin: .zero, size: expandedFrame().size) }
        return panel.contentView?.bounds ?? NSRect(origin: .zero, size: PanelController.expandedSize)
    }

    private func applyCompactFrame() {
        let e = expandedFrame()
        let f = NSRect(x: e.maxX - PanelController.pillSize.width, y: e.maxY - PanelController.pillSize.height,
                       width: PanelController.pillSize.width, height: PanelController.pillSize.height)
        restoringFrame = true
        panel.setFrame(f, display: true)
        restoringFrame = false
    }

    private var lastFrameReason = "default"

    /// The saved expanded frame when it is usable, else the full default
    /// (PanelGeometry). A frame that had to be replaced is dropped from the
    /// defaults, so a tiny frame never comes back.
    private func expandedFrame() -> NSRect {
        let saved = Prefs.store.string(forKey: PanelController.frameKey)
        let (f, reason) = PanelGeometry.expandedFrame(saved: saved, screens: NSScreen.screens.map { $0.visibleFrame },
                                                      main: NSScreen.main?.visibleFrame)
        lastFrameReason = reason
        if reason == "too_small" || reason == "offscreen" { Prefs.store.set(NSStringFromRect(f), forKey: PanelController.frameKey) }
        return f
    }

    private func restoreFrame() {
        if compact {
            panel.styleMask = PanelController.compactStyle
            panel.isMovableByWindowBackground = true
            panel.backgroundColor = .clear
            panel.isOpaque = false
            applyCompactFrame()
            layoutPill()
        } else {
            panel.setFrame(expandedFrame(), display: false)
        }
        let f = panel.frame
        log.log("panel_frame", ["compact": compact, "frame": [f.minX, f.minY, f.width, f.height], "reason": lastFrameReason,
                                "titlebar_inset": PanelController.titlebarInset])
    }

    private func saveFrame() {
        guard !compact, !restoringFrame, panel.styleMask.contains(.titled),
              panel.frame.width >= PanelGeometry.minSize.width, panel.frame.height >= PanelGeometry.minSize.height else { return }
        Prefs.store.set(NSStringFromRect(panel.frame), forKey: PanelController.frameKey)
    }

    private func saveCompactPosition() {
        // Moving the pill moves the expanded frame with it (anchored top-right).
        guard compact, !restoringFrame else { return }
        let e = expandedFrame()
        let p = panel.frame
        let moved = NSRect(x: p.maxX - e.width, y: p.maxY - e.height, width: e.width, height: e.height)
        Prefs.store.set(NSStringFromRect(moved), forKey: PanelController.frameKey)
    }

    // MARK: NSWindowDelegate

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard webView != nil else { orderOut(); return false }
        // The close button hides the panel; voice keeps running (menu bar icon
        // shows it). "Voice Off" in the menu, or /talk off, ends it.
        hide()
        return false
    }

    func windowDidMove(_ n: Notification) { compact ? saveCompactPosition() : saveFrame() }
    func windowDidResize(_ n: Notification) { saveFrame() }

    // MARK: WKScriptMessageHandler

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "sottoHost", let body = message.body as? [String: Any] else { return }
        guard isOurs(message.frameInfo.securityOrigin) else { return }
        delegate?.panelBridgeMessage(body)
    }

    // MARK: WKUIDelegate

    private func isOurs(_ origin: WKSecurityOrigin) -> Bool {
        guard let req = request else { return false }
        return origin.protocol == "http" && (origin.host == "127.0.0.1" || origin.host == "localhost") && origin.port == req.port
    }

    @available(macOS 12.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        // Microphone only, and only for our own loopback page on our port.
        let ok = isOurs(origin) && frame.isMainFrame && type == .microphone
        log.log("media_permission", ["type": type == .microphone ? "microphone" : "other", "granted": ok,
                                     "origin": "\(origin.protocol)://\(origin.host):\(origin.port)"])
        decisionHandler(ok ? .grant : .deny)
    }

    func webViewDidClose(_ webView: WKWebView) {
        guard webView === self.webView else { return }
        log.log("page_window_close")
        delegate?.panelPageClosedByScript()
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, url.scheme == "https" || url.scheme == "http" { NSWorkspace.shared.open(url) }
        return nil
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.scheme == "about" { return decisionHandler(.allow) }
        if url.scheme == "http", url.host == "127.0.0.1" || url.host == "localhost", url.port == request?.port {
            return decisionHandler(.allow)
        }
        // Anything else leaves the panel and opens in the default browser.
        if action.navigationType == .linkActivated, url.scheme == "https" || url.scheme == "http" { NSWorkspace.shared.open(url) }
        // The mic-blocked card's "Open System Settings" (Privacy & Security >
        // Microphone), and only that pane.
        if action.navigationType == .linkActivated, url.absoluteString == PanelController.micSettingsURL {
            log.log("open_mic_settings")
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView, webView.url?.scheme == "http" else { return }
        log.log("load_finish", ["url": (webView.url?.absoluteString ?? "").components(separatedBy: "#")[0],
                                "title": webView.title ?? ""])
        delegate?.panelPageLoaded(true, detail: "")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard webView === self.webView else { return }
        log.log("load_fail", ["error": error.localizedDescription])
        delegate?.panelPageLoaded(false, detail: error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard webView === self.webView else { return }
        log.log("load_fail", ["error": error.localizedDescription])
        delegate?.panelPageLoaded(false, detail: error.localizedDescription)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === self.webView, let req = request else { return }
        // The page's sessionStorage secret died with the process; the launch
        // code was single-use. Reload without it: the page shows its
        // "not connected" card and the daemon reopens the window on /talk on.
        log.log("webcontent_terminated")
        mic?.stopAll()
        load(LaunchRequest(port: req.port, code: nil, dataDir: req.dataDir))
    }
}

/// Compact pill: status glyph, label, mute and expand buttons.
final class PillView: NSVisualEffectView {
    var onExpand: (() -> Void)?
    var onMute: (() -> Void)?
    private let icon = NSImageView()
    private let label = NSTextField(labelWithString: "Sotto")
    private let muteButton = NSButton()
    private let expandButton = NSButton()

    override init(frame: NSRect) {
        super.init(frame: frame)
        material = .hudWindow
        blendingMode = .behindWindow
        state = .active
        wantsLayer = true
        layer?.cornerRadius = 12
        layer?.masksToBounds = true
        autoresizingMask = [.width, .height]

        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 15, weight: .medium)
        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.lineBreakMode = .byTruncatingTail
        for (b, sym, tip) in [(muteButton, "mic.fill", "Mute or unmute"), (expandButton, "arrow.up.left.and.arrow.down.right", "Show the full panel (⌥⌘T)")] {
            b.bezelStyle = .regularSquare
            b.isBordered = false
            b.image = NSImage(systemSymbolName: sym, accessibilityDescription: tip)
            b.toolTip = tip
            b.setAccessibilityLabel(tip)
        }
        // The way back to the full panel must be obvious: a labelled button,
        // not just a glyph (double-click on the pill and ⌥⌘T also expand).
        expandButton.title = "Expand"
        expandButton.imagePosition = .imageLeading
        expandButton.isBordered = true
        expandButton.bezelStyle = .recessed
        expandButton.controlSize = .small
        expandButton.font = .systemFont(ofSize: 11, weight: .semibold)
        expandButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        muteButton.target = self
        muteButton.action = #selector(muteTapped)
        expandButton.target = self
        expandButton.action = #selector(expandTapped)
        let stack = NSStackView(views: [icon, label, muteButton, expandButton])
        stack.orientation = .horizontal
        stack.distribution = .fill // the label takes the slack; the buttons sit at the right edge
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 0, left: 12, bottom: 0, right: 10)
        stack.translatesAutoresizingMaskIntoConstraints = false
        icon.setContentHuggingPriority(.required, for: .horizontal)
        muteButton.setContentHuggingPriority(.required, for: .horizontal)
        expandButton.setContentHuggingPriority(.required, for: .horizontal)
        label.setContentHuggingPriority(.defaultLow, for: .horizontal)
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        update(icon: .off, project: "", muted: false)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 { onExpand?() } else { super.mouseDown(with: event) }
    }

    func update(icon state: VoiceIcon, project: String, muted: Bool) {
        icon.image = NSImage(systemSymbolName: state.symbol, accessibilityDescription: state.label)
        icon.contentTintColor = state.tint ?? .labelColor
        label.stringValue = project.isEmpty ? state.label : "\(state.label) · \(project)"
        muteButton.image = NSImage(systemSymbolName: muted ? "mic.slash.fill" : "mic.fill", accessibilityDescription: muted ? "Unmute" : "Mute")
        muteButton.isEnabled = state != .off
    }

    @objc private func muteTapped() { onMute?() }
    @objc private func expandTapped() { onExpand?() }
}
