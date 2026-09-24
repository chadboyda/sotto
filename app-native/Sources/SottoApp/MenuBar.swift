// The menu-bar item (docs/NATIVE.md §5.1): an icon that follows the voice
// state, and the menu Show/Hide Panel, Compact, Mute, Pause/Resume, End Voice,
// Open in Browser, Open Logs, Settings, Stay in Menu Bar, Quit.
import AppKit

@MainActor
protocol MenuBarDelegate: AnyObject {
    func menuToggleShow()
    func menuToggleCompact()
    func menuMute()
    func menuPauseResume()
    func menuEndVoice()
    func menuOpenBrowser()
    func menuOpenLogs()
    func menuSettings()
    func menuToggleResident()
    func menuQuit()
}

/// What the menu shows, as plain values (built by the controller).
struct MenuState: Equatable {
    var icon: VoiceIcon = .off
    var project = ""
    var errorMessage = ""
    var attached = false
    var linkUp = false
    var panelVisible = false
    var compact = false
    var muted = false
    var state = "off"
    var hasDataDir = false
    var stayResident = false
    var muteKey = "⌥⌘M"
    var showKey = "⌥⌘T"
}

@MainActor
final class MenuBar: NSObject {
    weak var delegate: MenuBarDelegate?
    private let statusItem: NSStatusItem
    private let headerItem = NSMenuItem(title: "Sotto", action: nil, keyEquivalent: "")
    private let showItem = NSMenuItem(title: "Show Panel", action: #selector(show), keyEquivalent: "")
    private let compactItem = NSMenuItem(title: "Compact Panel", action: #selector(compact), keyEquivalent: "")
    private let muteItem = NSMenuItem(title: "Mute", action: #selector(mute), keyEquivalent: "")
    private let pauseItem = NSMenuItem(title: "Pause", action: #selector(pauseResume), keyEquivalent: "")
    private let endItem = NSMenuItem(title: "End Voice", action: #selector(end), keyEquivalent: "")
    private let browserItem = NSMenuItem(title: "Open in Browser", action: #selector(browser), keyEquivalent: "")
    private let logsItem = NSMenuItem(title: "Open Logs", action: #selector(logs), keyEquivalent: "")
    private let settingsItem = NSMenuItem(title: "Settings…", action: #selector(settings), keyEquivalent: ",")
    private let residentItem = NSMenuItem(title: "Stay in Menu Bar When Voice Is Off", action: #selector(resident), keyEquivalent: "")
    private let quitItem = NSMenuItem(title: "Quit Sotto", action: #selector(quit), keyEquivalent: "q")
    private var last: MenuState?

    override init() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        super.init()
        statusItem.button?.imagePosition = .imageOnly
        let menu = NSMenu()
        menu.autoenablesItems = false
        headerItem.isEnabled = false
        for item in [showItem, compactItem, muteItem, pauseItem, endItem, browserItem, logsItem, settingsItem, residentItem, quitItem] {
            item.target = self
        }
        menu.addItem(headerItem)
        menu.addItem(.separator())
        menu.addItem(showItem)
        menu.addItem(compactItem)
        menu.addItem(.separator())
        menu.addItem(muteItem)
        menu.addItem(pauseItem)
        menu.addItem(endItem)
        menu.addItem(.separator())
        menu.addItem(browserItem)
        menu.addItem(logsItem)
        menu.addItem(settingsItem)
        menu.addItem(residentItem)
        menu.addItem(.separator())
        menu.addItem(quitItem)
        statusItem.menu = menu
        update(MenuState())
    }

    func setHotkeys(mute: HotkeySpec, show: HotkeySpec) {
        muteItem.keyEquivalent = mute.keyEquivalent
        muteItem.keyEquivalentModifierMask = mute.flags
        showItem.keyEquivalent = show.keyEquivalent
        showItem.keyEquivalentModifierMask = show.flags
    }

    func update(_ s: MenuState) {
        guard s != last else { return }
        last = s
        if let b = statusItem.button {
            let img = NSImage(systemSymbolName: s.icon.symbol, accessibilityDescription: "Sotto: \(s.icon.label)")
            img?.isTemplate = true
            b.image = img
            b.contentTintColor = s.icon.tint
            var tip = "Sotto: \(s.icon.label)"
            if !s.project.isEmpty { tip += " (\(s.project))" }
            if s.icon == .error, !s.errorMessage.isEmpty { tip += "\n\(s.errorMessage)" }
            b.toolTip = tip
        }
        headerItem.title = s.project.isEmpty ? "Sotto: \(s.icon.label)" : "Sotto: \(s.icon.label) (\(s.project))"
        showItem.title = !s.panelVisible ? "Show Panel" : s.compact ? "Show Full Panel" : "Hide Panel"
        showItem.isEnabled = s.attached
        compactItem.title = s.compact ? "Expand Panel" : "Compact Panel"
        compactItem.isEnabled = s.attached
        muteItem.title = s.muted ? "Unmute" : "Mute"
        muteItem.isEnabled = s.linkUp && (s.state == "live" || s.state == "sleeping")
        let resumable = s.state == "paused" || s.state == "sleeping" || s.state == "waiting_page"
        pauseItem.title = s.state == "sleeping" ? "Wake Now" : resumable ? "Resume" : "Pause"
        pauseItem.isEnabled = s.linkUp && (resumable || s.state == "live" || s.state == "connecting" || s.state == "reconnecting")
        endItem.isEnabled = s.attached && s.state != "off"
        browserItem.isEnabled = s.linkUp && s.state != "off"
        logsItem.isEnabled = s.hasDataDir
        settingsItem.isEnabled = s.attached
        residentItem.state = s.stayResident ? .on : .off
    }

    @objc private func show() { delegate?.menuToggleShow() }
    @objc private func compact() { delegate?.menuToggleCompact() }
    @objc private func mute() { delegate?.menuMute() }
    @objc private func pauseResume() { delegate?.menuPauseResume() }
    @objc private func end() { delegate?.menuEndVoice() }
    @objc private func browser() { delegate?.menuOpenBrowser() }
    @objc private func logs() { delegate?.menuOpenLogs() }
    @objc private func settings() { delegate?.menuSettings() }
    @objc private func resident() { delegate?.menuToggleResident() }
    @objc private func quit() { delegate?.menuQuit() }
}
