// Global hotkeys via Carbon RegisterEventHotKey: works from a background
// (LSUIElement) app and needs no Accessibility permission. Ported unchanged
// from the WKWebView app; defaults ⌥⌘M (mute) and ⌥⌘T (show / expand / hide),
// overridable with the HotkeyMute / HotkeyShow defaults (e.g. "ctrl+opt+m").
import AppKit
import Carbon.HIToolbox

struct HotkeySpec: Equatable {
    var keyCode: UInt32
    var modifiers: UInt32   // Carbon modifier mask (cmdKey | optionKey | ...)
    var display: String     // e.g. "⌥⌘M"
    var keyEquivalent: String
    var flags: NSEvent.ModifierFlags

    /// Parse "opt+cmd+m", "ctrl+shift+f5", "cmd+option+space". nil if invalid.
    static func parse(_ text: String) -> HotkeySpec? {
        let parts = text.lowercased().split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let keyName = parts.last, !keyName.isEmpty else { return nil }
        var mods: UInt32 = 0
        var flags: NSEvent.ModifierFlags = []
        var glyphs = ""
        for p in parts.dropLast() {
            switch p {
            case "ctrl", "control": mods |= UInt32(controlKey); flags.insert(.control)
            case "opt", "option", "alt": mods |= UInt32(optionKey); flags.insert(.option)
            case "shift": mods |= UInt32(shiftKey); flags.insert(.shift)
            case "cmd", "command": mods |= UInt32(cmdKey); flags.insert(.command)
            default: return nil
            }
        }
        // Require at least one of cmd/ctrl/opt so a bare letter is never stolen system-wide.
        guard mods & UInt32(cmdKey | controlKey | optionKey) != 0 else { return nil }
        if flags.contains(.control) { glyphs += "⌃" }
        if flags.contains(.option) { glyphs += "⌥" }
        if flags.contains(.shift) { glyphs += "⇧" }
        if flags.contains(.command) { glyphs += "⌘" }
        guard let (code, label, equiv) = HotkeySpec.keys[keyName] else { return nil }
        return HotkeySpec(keyCode: code, modifiers: mods, display: glyphs + label, keyEquivalent: equiv, flags: flags)
    }

    static let keys: [String: (UInt32, String, String)] = {
        var k: [String: (UInt32, String, String)] = [:]
        let letters: [(String, Int)] = [
            ("a", kVK_ANSI_A), ("b", kVK_ANSI_B), ("c", kVK_ANSI_C), ("d", kVK_ANSI_D), ("e", kVK_ANSI_E),
            ("f", kVK_ANSI_F), ("g", kVK_ANSI_G), ("h", kVK_ANSI_H), ("i", kVK_ANSI_I), ("j", kVK_ANSI_J),
            ("k", kVK_ANSI_K), ("l", kVK_ANSI_L), ("m", kVK_ANSI_M), ("n", kVK_ANSI_N), ("o", kVK_ANSI_O),
            ("p", kVK_ANSI_P), ("q", kVK_ANSI_Q), ("r", kVK_ANSI_R), ("s", kVK_ANSI_S), ("t", kVK_ANSI_T),
            ("u", kVK_ANSI_U), ("v", kVK_ANSI_V), ("w", kVK_ANSI_W), ("x", kVK_ANSI_X), ("y", kVK_ANSI_Y),
            ("z", kVK_ANSI_Z), ("0", kVK_ANSI_0), ("1", kVK_ANSI_1), ("2", kVK_ANSI_2), ("3", kVK_ANSI_3),
            ("4", kVK_ANSI_4), ("5", kVK_ANSI_5), ("6", kVK_ANSI_6), ("7", kVK_ANSI_7), ("8", kVK_ANSI_8),
            ("9", kVK_ANSI_9),
        ]
        for (name, code) in letters { k[name] = (UInt32(code), name.uppercased(), name) }
        k["space"] = (UInt32(kVK_Space), "Space", " ")
        let fkeys = [kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10, kVK_F11, kVK_F12]
        for (i, code) in fkeys.enumerated() { k["f\(i + 1)"] = (UInt32(code), "F\(i + 1)", "") }
        return k
    }()
}

final class Hotkeys: @unchecked Sendable {
    static let shared = Hotkeys()
    private var refs: [EventHotKeyRef] = []
    private var actions: [UInt32: () -> Void] = [:]
    private var handlerInstalled = false
    private var nextId: UInt32 = 1

    /// Returns false if the combination is taken by another app (or invalid).
    @discardableResult
    func register(_ spec: HotkeySpec, action: @escaping () -> Void) -> Bool {
        installHandler()
        let id = nextId
        nextId += 1
        var ref: EventHotKeyRef?
        let hkid = EventHotKeyID(signature: OSType(0x434C_5645), id: id) // 'CLVE'
        let status = RegisterEventHotKey(spec.keyCode, spec.modifiers, hkid, GetApplicationEventTarget(), 0, &ref)
        guard status == noErr, let r = ref else { return false }
        refs.append(r)
        actions[id] = action
        return true
    }

    func unregisterAll() {
        for r in refs { UnregisterEventHotKey(r) }
        refs.removeAll()
        actions.removeAll()
    }

    fileprivate func fire(_ id: UInt32) {
        guard let a = actions[id] else { return }
        DispatchQueue.main.async(execute: a)
    }

    private func installHandler() {
        guard !handlerInstalled else { return }
        handlerInstalled = true
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            var hk = EventHotKeyID()
            let err = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                        nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
            if err == noErr { Hotkeys.shared.fire(hk.id) }
            return noErr
        }, 1, &spec, nil, nil)
    }
}
