// The floating voice panel (docs/NATIVE.md §5.1): a non-activating,
// always-on-top NSPanel on every Space hosting SottoUI's PanelView, which
// collapses to the compact strip (SottoUI.MiniPanelView: peg, string, word, caption,
// and an Expand button). The frame rules
// (PanelGeometry) and the defaults keys (PanelFrame, PanelCompact) are the
// WKWebView app's, so a user's saved position carries over.
//
// Unlike the WKWebView panel, hiding really orders the panel out: there is no
// page whose getUserMedia stalls when hidden, the audio lives in SottoAudio.
// M / Space inside the panel are PanelView's (StateModel.handleKey).
import AppKit
import SwiftUI
import SottoUI

final class VoicePanel: NSPanel {
    // Borderless (compact) panels refuse key status by default; the key field
    // and the pickers need it. Never main: the terminal keeps its window.
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
protocol PanelControllerDelegate: AnyObject {
    func panelToggleMute()
    func panelVisibilityChanged()
}

@MainActor
final class PanelController: NSObject, NSWindowDelegate {
    private static let frameKey = "PanelFrame"
    private static let compactKey = "PanelCompact"
    static let expandedStyle: NSWindow.StyleMask = [.titled, .closable, .resizable, .nonactivatingPanel, .fullSizeContentView, .utilityWindow]
    static let compactStyle: NSWindow.StyleMask = [.borderless, .nonactivatingPanel]

    let panel: VoicePanel
    private let model: StateModel
    private let log: DebugLog
    private let fullView: NSView
    private let pillView: NSView
    weak var delegate: PanelControllerDelegate?
    private(set) var compact: Bool
    private var restoringFrame = false
    private(set) var lastFrameReason = "default"

    init(model: StateModel, log: DebugLog) {
        self.log = log
        self.model = model
        compact = Prefs.store.bool(forKey: PanelController.compactKey)
        panel = VoicePanel(contentRect: NSRect(origin: .zero, size: PanelGeometry.defaultSize),
                           styleMask: PanelController.expandedStyle, backing: .buffered, defer: true)
        let host = NSHostingView(rootView: PanelView(model: model))
        host.autoresizingMask = [.width, .height]
        fullView = host
        var expand: () -> Void = {}
        pillView = NSHostingView(rootView: MiniPanelView(model: model, onExpand: { expand() }))
        super.init()
        expand = { [weak self] in self?.setCompact(false) }
        panel.title = "Sotto"
        panel.titlebarAppearsTransparent = true
        panel.titleVisibility = .hidden
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.minSize = PanelGeometry.minSize
        panel.animationBehavior = .utilityWindow
        panel.delegate = self
        restoreFrame()
        // The hero's timelines pause while the panel is hidden or fully covered (0 fps).
        NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: panel, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.updateVisibility() }
        }
        updateVisibility()
    }

    var isVisible: Bool { panel.isVisible }

    // MARK: show / hide / compact

    func show() {
        if compact { applyCompactFrame() }
        panel.orderFrontRegardless() // never activates: the terminal keeps focus
        updateVisibility()
        log.log("panel_show", ["compact": compact])
        delegate?.panelVisibilityChanged()
    }

    func hide() {
        guard panel.isVisible else { return }
        panel.orderOut(nil)
        updateVisibility()
        log.log("panel_hide")
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
        applyMode()
        if on {
            applyCompactFrame()
        } else {
            restoringFrame = true
            let e = expandedFrame()
            panel.setFrame(e, display: true)
            restoringFrame = false
            log.log("panel_frame", ["compact": false, "frame": [e.minX, e.minY, e.width, e.height], "reason": lastFrameReason])
        }
        delegate?.panelVisibilityChanged()
    }

    /// "Sotto — Approve in the terminal" while Claude waits (VoiceOver and Mission Control read it).
    func setTitle(_ title: String) {
        if panel.title != title { panel.title = title }
    }

    private func updateVisibility() {
        let v = panel.isVisible && panel.occlusionState.contains(.visible)
        if model.panelVisible != v { model.panelVisible = v }
    }

    private func applyMode() {
        if compact {
            panel.styleMask = PanelController.compactStyle
            panel.isMovableByWindowBackground = true
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.hasShadow = true
            pillView.frame = NSRect(origin: .zero, size: PanelGeometry.pillSize)
            panel.contentView = pillView
        } else {
            panel.styleMask = PanelController.expandedStyle
            panel.isMovableByWindowBackground = false
            panel.backgroundColor = .windowBackgroundColor
            panel.isOpaque = true
            panel.contentView = fullView
        }
    }

    private func applyCompactFrame() {
        restoringFrame = true
        panel.setFrame(PanelGeometry.pillFrame(expanded: expandedFrame()), display: true)
        restoringFrame = false
    }

    /// The saved expanded frame when it is usable, else the full default. A
    /// frame that had to be replaced is dropped from the defaults, so a tiny
    /// frame never comes back.
    private func expandedFrame() -> NSRect {
        let saved = Prefs.store.string(forKey: PanelController.frameKey)
        let (f, reason) = PanelGeometry.expandedFrame(saved: saved, screens: NSScreen.screens.map { $0.visibleFrame },
                                                      main: NSScreen.main?.visibleFrame)
        lastFrameReason = reason
        if reason == "too_small" || reason == "offscreen" { Prefs.store.set(NSStringFromRect(f), forKey: PanelController.frameKey) }
        return f
    }

    private func restoreFrame() {
        applyMode()
        if compact { applyCompactFrame() } else {
            restoringFrame = true
            panel.setFrame(expandedFrame(), display: false)
            restoringFrame = false
        }
        let f = panel.frame
        log.log("panel_frame", ["compact": compact, "frame": [f.minX, f.minY, f.width, f.height], "reason": lastFrameReason])
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
        // The close button hides the panel; voice keeps running (the menu-bar
        // icon shows it). End Voice in the menu, or /talk off, ends it.
        hide()
        return false
    }

    func windowDidMove(_ n: Notification) { compact ? saveCompactPosition() : saveFrame() }
    func windowDidResize(_ n: Notification) { saveFrame() }
}
