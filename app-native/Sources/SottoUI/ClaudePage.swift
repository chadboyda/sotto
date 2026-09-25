// Claude's page (SPEC-DEVIATIONS "scrolling page"; the page's panel.js pageFollow): a
// fixed region between the Claude row and the footer that holds Claude's messages for
// this turn and the recent ones, in New York with rendered markdown. Its frame never
// changes with its content. It scrolls with the system overlay scroller (invisible at
// rest, shown while scrolling or when the pointer nears the right edge, then fading),
// inset into a 12 pt gutter so it never covers text; a soft fade at an edge says there is
// more past it. It follows the newest words like a chat; scrolling up stops that and
// shows "Jump to latest"; scrolling back to the latest resumes it; a new turn follows again.
import SwiftUI
import AppKit

struct ClaudePage: View {
    let entries: [ViewText.PageEntry]
    let finished: Bool
    let layout: HybridLayout
    /// StateModel.pageTurnSeq: a new turn follows the latest again.
    var turn = 0
    @State private var follow = PageFollow()
    @Environment(\.colorScheme) private var scheme
    @Environment(\.sottoStill) private var still

    /// The scroller's gutter on the right: text never runs under it.
    static let gutter: CGFloat = 12
    /// The fade at an edge with more past it.
    static let fade: CGFloat = 28

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottom) {
                if still {
                    // ImageRenderer draws no AppKit views: the same text at the same place, clipped.
                    StillPage(entries: entries, finished: finished, layout: layout, size: geo.size)
                } else {
                    ClaudeScroll(entries: entries, finished: finished, layout: layout, turn: turn, scheme: scheme, follow: follow)
                }
                if !still && follow.showJump {
                    JumpPill { follow.jump() }
                        .padding(.bottom, 8)
                        .transition(.opacity)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .animation(.easeOut(duration: 0.2), value: follow.showJump)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Claude's messages")
    }
}

/// The messages, newest last, at their tone's opacity.
struct PageMessages: View {
    let entries: [ViewText.PageEntry]
    let layout: HybridLayout
    /// Room under the last line, so the fade never sits on it.
    static let bottomPad: CGFloat = 6

    var body: some View {
        VStack(alignment: .leading, spacing: layout.lineHeight * 0.55) {
            ForEach(Array(entries.enumerated()), id: \.offset) { _, e in
                MarkdownPage(markdown: e.text, layout: layout, expanded: true)
                    .opacity(e.opacity)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.trailing, ClaudePage.gutter)
        .padding(.bottom, Self.bottomPad)
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }

    /// The content's height at `width`, and the top of the latest message when the page
    /// is finished and that message is taller than the viewport (it reads from its start).
    @MainActor static func metrics(_ entries: [ViewText.PageEntry], layout: HybridLayout, width: CGFloat, viewport: CGFloat,
                                   finished: Bool, scheme: ColorScheme) -> (total: CGFloat, latestTop: CGFloat?) {
        guard width > 0, !entries.isEmpty else { return (0, nil) }
        let total = height(PageMessages(entries: entries, layout: layout), width: width, scheme: scheme)
        guard finished, let last = entries.last else { return (total, nil) }
        let latest = height(PageMessages(entries: [last], layout: layout), width: width, scheme: scheme)
        // Its first line sits just under the top fade (the fade falls on the message before it).
        return latest - bottomPad > viewport ? (total, max(0, total - latest - ClaudePage.fade)) : (total, nil)
    }

    @MainActor static func height<V: View>(_ v: V, width: CGFloat, scheme: ColorScheme) -> CGFloat {
        let h = NSHostingView(rootView: v.environment(\.colorScheme, scheme).frame(width: width).fixedSize(horizontal: false, vertical: true))
        return ceil(h.fittingSize.height)
    }
}

/// A soft fade at the edges that have more past them (a mask: opaque = shown).
struct PageFade: View {
    let above: Bool
    let below: Bool
    let height: CGFloat
    var body: some View {
        let f = min(0.45, ClaudePage.fade / max(1, height))
        LinearGradient(stops: [.init(color: above ? .clear : .black, location: 0), .init(color: .black, location: above ? f : 0),
                               .init(color: .black, location: below ? 1 - f : 1), .init(color: below ? .clear : .black, location: 1)],
                       startPoint: .top, endPoint: .bottom)
    }
}

/// The still frame (snapshots, layout tests): the page where following would put it.
struct StillPage: View {
    let entries: [ViewText.PageEntry]
    let finished: Bool
    let layout: HybridLayout
    let size: CGSize
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let m = PageMessages.metrics(entries, layout: layout, width: size.width, viewport: size.height, finished: finished, scheme: scheme)
        let target = ViewText.followTarget(scrollHeight: m.total, clientHeight: size.height, latestTop: m.latestTop.map(Double.init))
        let over = max(0, m.total - size.height)
        PageMessages(entries: entries, layout: layout)
            .fixedSize(horizontal: false, vertical: true)
            .frame(width: size.width, alignment: .topLeading)
            .offset(y: -target)
            .frame(width: size.width, height: size.height, alignment: .topLeading)
            .clipped()
            .mask(PageFade(above: target > 1, below: target < over - 1, height: size.height))
    }
}

/// "Jump to latest": a small capsule over the bottom of the page while the reader is
/// scrolled away from the newest words.
struct JumpPill: View {
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    var body: some View {
        let t = HybridTheme.of(scheme, increaseContrast: contrast == .increased)
        Button(action: action) {
            HStack(spacing: 6) {
                Text("Jump to latest")
                Image(systemName: "arrow.down").font(.system(size: 10, weight: .semibold))
            }
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(t.ink)
            .padding(.horizontal, 12)
            .frame(height: 28)
            .background(Capsule().fill(t.dark ? Color.hex(0x161B26) : Color.white))
            .overlay(Capsule().strokeBorder(t.hair2))
            .shadow(color: .black.opacity(t.dark ? 0.4 : 0.12), radius: 5, y: 2)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .background(PanelFrames.reader("jump-latest"))
        .accessibilityLabel("Jump to latest")
        .accessibilityHint("Scrolls to Claude's newest words")
    }
}

/// What the scroll view reports to SwiftUI (the pill), and the way back to the latest.
@MainActor @Observable final class PageFollow {
    var following = true
    var overflow = false
    var showJump: Bool { !following && overflow }
    @ObservationIgnored weak var coordinator: ClaudeScroll.Coordinator?
    func jump() { coordinator?.jump() }
}

/// An NSScrollView with the macOS overlay scroller (auto-hiding), hosting the messages.
struct ClaudeScroll: NSViewRepresentable {
    let entries: [ViewText.PageEntry]
    let finished: Bool
    let layout: HybridLayout
    let turn: Int
    let scheme: ColorScheme
    let follow: PageFollow

    func makeCoordinator() -> Coordinator { Coordinator(follow: follow) }

    func makeNSView(context: Context) -> FollowScrollView {
        let c = context.coordinator
        let s = FollowScrollView()
        s.drawsBackground = false
        s.contentView.drawsBackground = false
        s.hasVerticalScroller = true
        s.hasHorizontalScroller = false
        // Overlay style: invisible at rest, shown while scrolling, then it fades (auto-hide).
        s.scrollerStyle = .overlay
        s.autohidesScrollers = true
        s.scrollerKnobStyle = scheme == .dark ? .light : .dark
        // Inset from the page's top and bottom edges, in the gutter at the right.
        s.automaticallyAdjustsContentInsets = false
        s.scrollerInsets = NSEdgeInsets(top: 6, left: 0, bottom: 6, right: 0)
        s.verticalScrollElasticity = .allowed
        s.horizontalScrollElasticity = .none
        s.wantsLayer = true
        c.doc.addSubview(c.host)
        s.documentView = c.doc
        s.coordinator = c
        c.scroll = s
        s.onLayout = { [weak c] in c?.relayout() }
        s.contentView.postsBoundsChangedNotifications = true
        c.observe(s.contentView)
        follow.coordinator = c
        return s
    }

    func updateNSView(_ s: FollowScrollView, context: Context) {
        let c = context.coordinator
        s.scrollerKnobStyle = scheme == .dark ? .light : .dark
        if turn != c.turn {
            if c.turn != Int.min { c.following = true; c.jumping = false }
            c.turn = turn
        }
        c.set(entries: entries, finished: finished, layout: layout, scheme: scheme)
    }

    static func dismantleNSView(_ s: FollowScrollView, coordinator: Coordinator) {
        coordinator.stop()
    }

    @MainActor final class Coordinator {
        let follow: PageFollow
        let host = NSHostingView<AnyView>(rootView: AnyView(EmptyView()))
        let doc = FlippedView()
        weak var scroll: FollowScrollView?
        var entries: [ViewText.PageEntry] = []
        var finished = false
        var layout: HybridLayout?
        var scheme: ColorScheme = .light
        var width: CGFloat = -1
        var total: CGFloat = 0
        var latestTop: CGFloat?
        var following = true
        var jumping = false
        var turn = Int.min
        private var auto = false
        private var hadOverflow = false
        private var observer: NSObjectProtocol?
        private let mask = CALayer()
        private let textMask = CAGradientLayer()
        private let gutterMask = CALayer()

        init(follow: PageFollow) {
            self.follow = follow
            textMask.startPoint = CGPoint(x: 0.5, y: 0)
            textMask.endPoint = CGPoint(x: 0.5, y: 1)
            gutterMask.backgroundColor = NSColor.black.cgColor
            mask.addSublayer(textMask)
            mask.addSublayer(gutterMask)
        }

        func observe(_ clip: NSClipView) {
            observer = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: clip, queue: nil) { [weak self] _ in
                MainActor.assumeIsolated { self?.boundsChanged() }
            }
        }

        func stop() { if let o = observer { NotificationCenter.default.removeObserver(o) }; observer = nil }

        var viewport: CGFloat { scroll?.contentView.bounds.height ?? 0 }
        var offset: CGFloat { scroll?.contentView.bounds.origin.y ?? 0 }
        var maxOffset: CGFloat { max(0, total - viewport) }
        func target() -> CGFloat {
            CGFloat(ViewText.followTarget(scrollHeight: Double(total), clientHeight: Double(viewport), latestTop: latestTop.map(Double.init)))
        }

        func set(entries: [ViewText.PageEntry], finished: Bool, layout: HybridLayout, scheme: ColorScheme) {
            let changed = entries != self.entries || finished != self.finished || layout != self.layout || scheme != self.scheme
            guard changed else { return chrome() }
            let grew = entries != self.entries || finished != self.finished
            self.entries = entries; self.finished = finished; self.layout = layout; self.scheme = scheme
            measure()
            if grew && following { jumping = false; setOffset(target()) }
            chrome()
        }

        /// Lay the messages out at the clip view's width (the document is exactly as tall as they are).
        func measure() {
            guard let s = scroll, let layout else { return }
            let w = s.contentView.bounds.width
            width = w
            guard w > 0 else { return }
            host.rootView = AnyView(PageMessages(entries: entries, layout: layout).environment(\.colorScheme, scheme)
                .frame(width: w, alignment: .topLeading).fixedSize(horizontal: false, vertical: true))
            let m = PageMessages.metrics(entries, layout: layout, width: w, viewport: viewport, finished: finished, scheme: scheme)
            total = entries.isEmpty ? 0 : max(m.total, ceil(host.fittingSize.height))
            latestTop = m.latestTop
            doc.frame = NSRect(x: 0, y: 0, width: w, height: max(total, 1))
            host.frame = doc.bounds
        }

        /// A new size: re-measure, and keep following without pulling the reader above where they read.
        func relayout() {
            guard let s = scroll else { return }
            if abs(s.contentView.bounds.width - width) > 0.5 { measure() }
            if following && !jumping { setOffset(max(offset, target())) }
            chrome()
        }

        func setOffset(_ y: CGFloat) {
            guard let s = scroll else { return }
            let y = min(max(0, y), maxOffset)
            guard abs(offset - y) >= 0.5 else { return }
            auto = true
            s.contentView.scroll(to: NSPoint(x: 0, y: y))
            s.reflectScrolledClipView(s.contentView)
            auto = false
        }

        /// The reader scrolled (wheel, trackpad, scroller, keys): follow only while at the latest.
        func boundsChanged() {
            if !auto {
                let on = ViewText.isFollowing(Double(offset), target: Double(target()))
                if jumping { if on { jumping = false } } else { following = on }
            }
            chrome()
        }

        func jump() {
            guard let s = scroll else { return }
            following = true
            let y = min(max(0, target()), maxOffset)
            if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion || abs(offset - y) < 1 {
                setOffset(y)
            } else {
                jumping = true
                NSAnimationContext.runAnimationGroup({ ctx in
                    ctx.duration = 0.28
                    ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                    s.contentView.animator().setBoundsOrigin(NSPoint(x: 0, y: y))
                }, completionHandler: { [weak self] in
                    MainActor.assumeIsolated {
                        guard let self, let s = self.scroll else { return }
                        s.reflectScrolledClipView(s.contentView)
                        self.jumping = false
                        self.following = true
                        self.chrome()
                    }
                })
            }
            chrome()
        }

        /// The fades, the pill, and one flash of the scroller when the text first overflows.
        func chrome() {
            guard let s = scroll else { return }
            let overflow = maxOffset > 1
            let above = offset > 1
            let below = offset < maxOffset - 1
            let b = s.bounds
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            mask.frame = b
            let g = ClaudePage.gutter
            textMask.frame = CGRect(x: 0, y: 0, width: max(0, b.width - g), height: b.height)
            gutterMask.frame = CGRect(x: max(0, b.width - g), y: 0, width: g, height: b.height)
            let f = Double(min(0.45, ClaudePage.fade / max(1, b.height)))
            // The layer's y runs up unless the scroll view's layer is flipped.
            let flipped = s.layer?.isGeometryFlipped ?? false
            let (top, bottom) = flipped ? (above, below) : (below, above)
            textMask.colors = [(top ? NSColor.clear : .black).cgColor, NSColor.black.cgColor, NSColor.black.cgColor, (bottom ? NSColor.clear : .black).cgColor]
            textMask.locations = [0, NSNumber(value: top ? f : 0), NSNumber(value: bottom ? 1 - f : 1), 1]
            if s.layer?.mask !== mask { s.layer?.mask = mask }
            CATransaction.commit()
            if overflow && !hadOverflow { s.flashScrollers() }
            hadOverflow = overflow
            let f0 = following
            if follow.following != f0 || follow.overflow != overflow {
                // Never write observable state inside a SwiftUI update.
                DispatchQueue.main.async { [follow] in
                    if follow.following != f0 { follow.following = f0 }
                    if follow.overflow != overflow { follow.overflow = overflow }
                }
            }
        }
    }
}

final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// The scroll view: reports layout, and shows the overlay scroller when the pointer nears the right edge.
final class FollowScrollView: NSScrollView {
    var onLayout: (() -> Void)?
    weak var coordinator: ClaudeScroll.Coordinator?
    private var area: NSTrackingArea?
    private var lastFlash = Date.distantPast

    override func layout() {
        super.layout()
        onLayout?()
    }

    /// Always the overlay scroller, which hides itself at rest. NSScrollView re-applies the
    /// system's preferred style (legacy, an always-visible bar, with "Show scroll bars:
    /// Always" or a mouse attached) whenever that preference changes or the view moves to
    /// a window; the page never wants the permanent bar the user reported.
    override var scrollerStyle: NSScroller.Style {
        get { .overlay }
        set { super.scrollerStyle = .overlay }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let a = area { removeTrackingArea(a) }
        // Always active: the panel is non-activating and rarely key.
        let a = NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(a)
        area = a
    }

    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        let p = convert(event.locationInWindow, from: nil)
        guard p.x >= bounds.width - 16, let doc = documentView, doc.frame.height > contentView.bounds.height + 1,
              Date().timeIntervalSince(lastFlash) > 0.6 else { return }
        lastFlash = Date()
        flashScrollers()
    }
}

/// Test mode only (the app's `page_scroll` and `snapshot` actions): move the live page as a
/// reader would, and render the panel's own window content to a PNG (no screen-recording
/// permission: the view draws itself).
public enum PanelTestSupport {
    static func findScroll(_ v: NSView) -> FollowScrollView? {
        if let s = v as? FollowScrollView { return s }
        for sub in v.subviews { if let s = findScroll(sub) { return s } }
        return nil
    }

    /// "top" / "up" scroll as a reader would (following stops); "bottom" scrolls to the end;
    /// "latest" is the Jump to latest pill. Returns what the page reports afterwards.
    @MainActor public static func scrollPage(in view: NSView, to: String) -> [String: Any] {
        guard let s = findScroll(view), let c = s.coordinator else { return ["ok": false] }
        switch to {
        case "latest": c.jump()
        default:
            let y: CGFloat = to == "bottom" ? c.maxOffset : to == "up" ? max(0, c.offset - c.viewport * 0.6) : 0
            s.contentView.scroll(to: NSPoint(x: 0, y: y))
            s.reflectScrolledClipView(s.contentView)
            s.flashScrollers()
        }
        return ["ok": true, "following": c.following, "offset": Double(c.offset), "max": Double(c.maxOffset), "viewport": Double(c.viewport)]
    }

    /// What the page's scroller is doing (style, visibility), for the capture log.
    @MainActor public static func pageState(in view: NSView) -> [String: Any] {
        guard let s = findScroll(view), let c = s.coordinator else { return [:] }
        return ["following": c.following, "offset": Double(c.offset), "max": Double(c.maxOffset),
                "overlay": s.scrollerStyle == .overlay, "preferred_overlay": NSScroller.preferredScrollerStyle == .overlay,
                "scroller_alpha": Double(s.verticalScroller?.alphaValue ?? -1), "scroller_hidden": s.verticalScroller?.isHidden ?? true]
    }

    /// The view's own drawing at `scale` (2x by default, whatever the display), as PNG data.
    @MainActor public static func png(of view: NSView, scale: CGFloat = 2) -> Data? {
        view.layoutSubtreeIfNeeded()
        let b = view.bounds
        guard b.width > 0, b.height > 0,
              let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(b.width * scale), pixelsHigh: Int(b.height * scale),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        rep.size = b.size
        view.cacheDisplay(in: b, to: rep)
        return rep.representation(using: .png, properties: [:])
    }
}
