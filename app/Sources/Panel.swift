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
    static let expandedSize = NSSize(width: 420, height: 640)
    static let pillSize = NSSize(width: 250, height: 44)
    private static let frameKey = "PanelFrame"
    private static let compactKey = "PanelCompact"

    let panel: VoicePanel
    private(set) var webView: WKWebView?
    private let pill = PillView()
    private let bridgeSource: String
    private let log: DebugLog
    private let mockCapture: Bool
    weak var delegate: PanelControllerDelegate?
    private(set) var request: LaunchRequest?
    private(set) var compact: Bool
    private var restoringFrame = false

    init(bridgeSource: String, log: DebugLog, mockCapture: Bool) {
        self.bridgeSource = bridgeSource
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
        panel.minSize = NSSize(width: 320, height: 420)
        panel.delegate = self
        panel.contentView = NSView(frame: NSRect(origin: .zero, size: PanelController.expandedSize))
        panel.contentView?.wantsLayer = true
        pill.onExpand = { [weak self] in self?.setCompact(false) }
        pill.onMute = { [weak self] in self?.delegate?.panelToggleMute() }
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
        ucc.addUserScript(WKUserScript(source: bridgeSource, injectionTime: .atDocumentStart, forMainFrameOnly: true))
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
        guard let wv = webView else { return }
        wv.loadHTMLString("", baseURL: nil)
        let old = wv
        webView = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            old.removeFromSuperview()
        }
    }

    private func destroyWebView() {
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

    /// Set a BOOL WebKit SPI if this WebKit has it (checked at run time, so a
    /// WebKit without it just keeps its default). Used for:
    ///  - _setGetUserMediaRequiresFocus: NO, so a reconnect while the panel is
    ///    hidden or unfocused does not wait for focus (verified: without it
    ///    getUserMedia never resolves in a hidden panel);
    ///  - _setInterruptAudioOnPageVisibilityChangeEnabled: NO;
    ///  - _setWindowOcclusionDetectionEnabled: NO (on the web view);
    ///  - _setMockCaptureDevicesEnabled: YES, only for the automated launch
    ///    test (--mock-capture), which then needs no microphone permission.
    static func setSPI(_ obj: NSObject, _ selector: String, _ value: Bool) {
        let sel = NSSelectorFromString(selector)
        guard obj.responds(to: sel), let m = class_getInstanceMethod(type(of: obj), sel) else { return }
        typealias Fn = @convention(c) (AnyObject, Selector, Bool) -> Void
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
            panel.setFrame(expandedFrame(), display: true)
            restoringFrame = false
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

    private func expandedFrame() -> NSRect {
        if let s = Prefs.store.string(forKey: PanelController.frameKey) {
            let r = NSRectFromString(s)
            if r.width >= 320, r.height >= 420, NSScreen.screens.contains(where: { $0.visibleFrame.intersects(r) }) { return r }
        }
        let vf = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let s = PanelController.expandedSize
        return NSRect(x: vf.maxX - s.width - 24, y: vf.maxY - s.height - 24, width: s.width, height: s.height)
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
    }

    private func saveFrame() {
        guard !compact, !restoringFrame else { return }
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
        for (b, sym, tip) in [(muteButton, "mic.fill", "Mute or unmute"), (expandButton, "arrow.up.left.and.arrow.down.right", "Expand")] {
            b.bezelStyle = .regularSquare
            b.isBordered = false
            b.image = NSImage(systemSymbolName: sym, accessibilityDescription: tip)
            b.toolTip = tip
            b.setAccessibilityLabel(tip)
        }
        muteButton.target = self
        muteButton.action = #selector(muteTapped)
        expandButton.target = self
        expandButton.action = #selector(expandTapped)
        let stack = NSStackView(views: [icon, label, muteButton, expandButton])
        stack.orientation = .horizontal
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 0, left: 12, bottom: 0, right: 10)
        stack.translatesAutoresizingMaskIntoConstraints = false
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
