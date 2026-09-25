// The footer's microphone and speaker controls (SPEC-DEVIATIONS "Devices in the footer";
// the page's #mic-btn / #speaker-btn): two 40 pt icon buttons next to the persona chip that
// say which devices are in use (tooltip and accessibility label), and a quick picker over
// the panel to switch. The choice is the Settings window's own (SettingsModel.chooseInput /
// chooseOutput: the same defaults key, the same precedence): exactly the device the user
// chose, else the macOS system default. Settings stays the full view.
import SwiftUI
import AppKit

/// What the picker lists, in order: "System default (<name>)" first, then every device.
public enum DeviceMenu {
    public struct Item: Equatable, Sendable, Identifiable {
        /// "" = the system default.
        public var id: String
        public var label: String
        public var checked: Bool
    }

    public static func items(devices: [DeviceChoice], selected: String?, defaultName: String?) -> [Item] {
        let sel = selected.flatMap { id in devices.contains { $0.id == id } ? id : nil }
        var out = [Item(id: "", label: defaultName.map { "System default (\($0))" } ?? "System default", checked: sel == nil)]
        out += devices.map { Item(id: $0.id, label: $0.name, checked: $0.id == sel) }
        return out
    }

    /// The chosen device is gone (unplugged, headphones off): the choice falls back to the
    /// system default. Never another device. An empty list (not read yet) loses nothing.
    public static func lost(selected: String?, devices: [DeviceChoice]) -> Bool {
        guard let s = selected, !devices.isEmpty else { return false }
        return !devices.contains { $0.id == s }
    }

    /// The button's words: "Microphone: MacBook Pro Microphone".
    public static func label(_ kind: String, active: DeviceChoice?) -> String {
        let what = kind == "input" ? "Microphone" : "Speaker"
        guard let n = active?.name, !n.isEmpty else { return "\(what): none" }
        return "\(what): \(n)"
    }

    public static func symbol(_ kind: String, active: DeviceChoice?) -> String {
        kind == "input" ? "mic" : active?.headphones == true ? "headphones" : "speaker.wave.2"
    }
}

/// A footer device button: the icon for what is in use; it opens the picker.
struct DeviceButton: View {
    let model: StateModel
    let kind: String
    @State private var flashing = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        let t = HybridTheme.of(scheme, increaseContrast: contrast == .increased)
        let s = model.settingsModel
        let active = kind == "input" ? s?.activeInput : s?.activeOutput
        let label = DeviceMenu.label(kind, active: active)
        let open = model.devicePicker == kind
        let flash = model.deviceFlash?.kind == kind ? model.deviceFlash?.seq ?? 0 : 0
        IconButton(symbol: DeviceMenu.symbol(kind, active: active), label: label, help: label, selected: open,
                   tint: flashing ? t.needInk : nil, bounce: flash) {
            model.devicePicker = open ? nil : kind
        }
        .accessibilityHint(kind == "input" ? "Choose the microphone" : "Choose the speaker")
        .accessibilityAddTraits(open ? .isSelected : [])
        .background(PanelFrames.reader(kind == "input" ? "mic-button" : "speaker-button"))
        .disabled(s == nil)
        .task(id: flash) {
            // The device went away: the icon flashes gold for a moment.
            guard flash > 0 else { return }
            flashing = true
            try? await Task.sleep(for: .milliseconds(1600))
            flashing = false
        }
    }
}

/// The quick picker, over the panel above the footer: the devices, a check on the one in
/// use (System default first), the live level on the microphone in use.
struct DevicePicker: View {
    let model: StateModel
    let kind: String
    let settings: SettingsModel
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast

    static let width: CGFloat = 280

    var body: some View {
        let t = HybridTheme.of(scheme, increaseContrast: contrast == .increased)
        let input = kind == "input"
        let items = DeviceMenu.items(devices: input ? settings.inputDevices : settings.outputDevices,
                                     selected: input ? settings.selectedInput : settings.selectedOutput,
                                     defaultName: input ? settings.defaultInputName : settings.defaultOutputName)
        let activeID = (input ? settings.activeInput : settings.activeOutput)?.id
        VStack(alignment: .leading, spacing: 0) {
            Text(input ? "Microphone" : "Speaker")
                .font(.system(size: 11, weight: .semibold)).foregroundStyle(t.fg3)
                .padding(.horizontal, 10).padding(.top, 6).padding(.bottom, 4)
                .accessibilityAddTraits(.isHeader)
            ForEach(items) { item in
                // The level shows on the row of the microphone really in use.
                let live = input && (item.checked && (item.id.isEmpty || item.id == activeID))
                Button {
                    if input { settings.chooseInput(item.id.isEmpty ? nil : item.id) } else { settings.chooseOutput(item.id.isEmpty ? nil : item.id) }
                    model.devicePicker = nil
                } label: {
                    DevicePickerRow(label: item.label, checked: item.checked, level: live ? model.micLevel : nil)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(item.label)
                .accessibilityAddTraits(item.checked ? [.isButton, .isSelected] : .isButton)
            }
            Divider().padding(.vertical, 4)
            Button {
                model.devicePicker = nil
                model.openSettings?()
            } label: {
                Text("Sound settings\u{2026}").font(.system(size: 12.5)).foregroundStyle(t.ink2)
                    .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading).padding(.horizontal, 10).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(model.openSettings == nil)
        }
        .padding(4)
        .frame(width: Self.width)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(t.dark ? Color.hex(0x121722) : Color.white))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(t.hair2))
        .shadow(color: .black.opacity(t.dark ? 0.5 : 0.16), radius: 14, y: 6)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(input ? "Microphones" : "Speakers")
        .background(PanelFrames.reader("device-picker"))
    }
}

struct DevicePickerRow: View {
    let label: String
    let checked: Bool
    var level: Float?
    @State private var hover = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        let t = HybridTheme.of(scheme, increaseContrast: contrast == .increased)
        HStack(spacing: 8) {
            Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(t.ink)
                .frame(width: 14).opacity(checked ? 1 : 0)
            Text(label).font(.system(size: 13, weight: checked ? .semibold : .regular)).foregroundStyle(t.ink)
                .lineLimit(1).truncationMode(.tail).help(label)
            Spacer(minLength: 6)
            if let level { LevelMeter(level: level, segments: 6).frame(width: 40, height: 8).accessibilityHidden(true) }
        }
        .padding(.horizontal, 8)
        .frame(minHeight: 32)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(hover ? t.hair : Color.clear))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
    }
}
