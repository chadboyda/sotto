// Which terminal Claude Code runs in, for the approval ("In iTerm2 · project", "Show
// terminal"; design/concepts-v2/hybrid §3 ApprovalBody). The daemon does not know the
// terminal app, so the app remembers the last known terminal the user activated, and
// falls back to the first one running. Read-only: it only activates an app when the user
// clicks "Show terminal".
import AppKit

@MainActor
final class TerminalTracker {
    /// Known terminal apps, in the fallback order.
    static let known: [(id: String, name: String)] = [
        ("com.googlecode.iterm2", "iTerm2"), ("com.apple.Terminal", "Terminal"), ("com.mitchellh.ghostty", "Ghostty"),
        ("dev.warp.Warp-Stable", "Warp"), ("com.github.wez.wezterm", "WezTerm"), ("net.kovidgoyal.kitty", "kitty"),
        ("org.alacritty", "Alacritty"), ("com.microsoft.VSCode", "VS Code"), ("com.todesktop.230313mzl4w4u92", "Cursor"),
        ("dev.zed.Zed", "Zed"), ("co.zeit.hyper", "Hyper"),
    ]

    private(set) var bundleId: String?
    var name: String? { bundleId.flatMap { id in Self.known.first { $0.id == id }?.name } }
    private var observer: NSObjectProtocol?

    func start(onChange: @escaping @Sendable (String?) -> Void) {
        let running = Set(NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier))
        if let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier, Self.known.contains(where: { $0.id == front }) { bundleId = front }
        else { bundleId = Self.known.first { running.contains($0.id) }?.id }
        observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] n in
            guard let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  let id = app.bundleIdentifier, Self.known.contains(where: { $0.id == id }) else { return }
            MainActor.assumeIsolated {
                guard let self, self.bundleId != id else { return }
                self.bundleId = id
                onChange(self.name)
            }
        }
    }

    /// Bring the terminal forward (the user clicked "Show terminal").
    func activate() {
        guard let id = bundleId, let app = NSRunningApplication.runningApplications(withBundleIdentifier: id).first else { return }
        app.activate()
    }
}
