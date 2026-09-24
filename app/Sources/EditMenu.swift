import AppKit

/// A hidden main menu with the standard Edit items. The app is an accessory
/// (menu-bar) app, so no menu bar is shown, but AppKit still routes key
/// equivalents through `NSApp.mainMenu`: without it, Cmd+V, Cmd+C, Cmd+X,
/// Cmd+A and Cmd+Z do nothing in the WKWebView, and the API key field on the
/// voice page (SPEC §4.3) could not be pasted into.
enum EditMenu {
    static func install() {
        let main = NSMenu()
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)
        NSApp.mainMenu = main
    }
}
