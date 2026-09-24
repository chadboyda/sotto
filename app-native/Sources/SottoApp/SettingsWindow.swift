// The Settings window (docs/NATIVE.md §5.4): SottoUI's SettingsView, or the
// onboarding cards (microphone access, then the API key) while
// `SettingsModel.onboardingStep` is set. The app owns the window and the
// app-local hooks (devices, echo cancellation, previews, permissions, login
// item, logs); SottoUI owns the views and the daemon commands.
import AppKit
import SwiftUI
import SottoUI

struct SettingsRoot: View {
    let model: SettingsModel
    var body: some View {
        Group {
            if model.onboardingStep != nil {
                OnboardingView(model: model)
                    .padding(24)
                    .frame(width: 420)
            } else {
                SettingsView(model: model)
            }
        }
    }
}

@MainActor
final class SettingsWindowController: NSObject, NSWindowDelegate {
    private let window: NSWindow
    private let log: DebugLog
    var onClose: () -> Void = {}

    init(model: SettingsModel, log: DebugLog) {
        self.log = log
        let host = NSHostingController(rootView: SettingsRoot(model: model))
        window = NSWindow(contentViewController: host)
        super.init()
        window.title = "Sotto Settings"
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        window.level = .floating
        window.setFrameAutosaveName("SottoSettings")
        window.delegate = self
        if window.frame.width < 200 { window.setContentSize(NSSize(width: 480, height: 640)) }
    }

    var isVisible: Bool { window.isVisible }

    /// `activate`: the user asked (menu, button), so the app comes forward and
    /// the window takes the keyboard. Automatic onboarding never steals focus.
    func show(activate: Bool, reason: String) {
        if !window.isVisible { window.center() }
        if activate {
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
        } else {
            window.orderFrontRegardless()
        }
        log.log("settings_show", ["reason": reason, "activate": activate])
    }

    func close() { window.orderOut(nil) }

    func windowWillClose(_ n: Notification) { onClose() }
}
