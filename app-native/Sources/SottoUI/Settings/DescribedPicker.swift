// A picker whose open list shows every option's description under its name while you
// browse (a SwiftUI menu Picker shows one line per item). Port of the page's
// panel.paintListPicker: a button with the current option's name over its short line,
// and a popover list of two-line rows, grouped under headings, the current one checked.
// Keyboard: arrows move the highlight, Home/End jump, Return or Space chooses, Escape
// closes. Moving the highlight never chooses (a voice change restarts the session).
import SwiftUI
import SottoClient

public struct DescribedOption: Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    /// The list row's second line.
    public var desc: String
    /// The button's second line when it differs from `desc` (a persona shows just its voice).
    public var short: String?
    public init(id: String, name: String, desc: String, short: String? = nil) {
        self.id = id; self.name = name; self.desc = desc; self.short = short
    }
}

public struct DescribedGroup: Identifiable, Equatable, Sendable {
    public var id: String
    /// "" for an untitled group (no heading).
    public var title: String
    public var options: [DescribedOption]
    public init(id: String, title: String, options: [DescribedOption]) { self.id = id; self.title = title; self.options = options }
}

struct DescribedPicker: View {
    let title: String
    let groups: [DescribedGroup]
    let selection: String
    var disabled = false
    let onChoose: (String) -> Void
    @State private var open = false

    private var current: DescribedOption? { groups.lazy.flatMap(\.options).first { $0.id == selection } }

    var body: some View {
        LabeledContent(title) {
            Button { open.toggle() } label: {
                HStack(spacing: 8) {
                    VStack(alignment: .trailing, spacing: 1) {
                        Text(current?.name ?? SettingsText.voiceLabel(selection)).lineLimit(1).foregroundStyle(.primary)
                        Text(current.map { $0.short ?? $0.desc } ?? " ")
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Image(systemName: "chevron.up.chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(disabled)
            .accessibilityLabel("\(title): \(current?.name ?? selection)")
            .accessibilityValue(current?.desc ?? "")
            .accessibilityHint("Opens the list")
            .popover(isPresented: $open, arrowEdge: .bottom) {
                DescribedPickerList(groups: groups, selection: selection) { id in
                    open = false
                    if let id, id != selection { onChoose(id) }
                }
            }
        }
    }
}

/// The open list (also rendered on its own by SettingsSnapshots). `onDone(nil)` closes without a choice.
struct DescribedPickerList: View {
    let groups: [DescribedGroup]
    let selection: String
    var height: CGFloat = 400
    let onDone: (String?) -> Void
    @State private var active: String?
    @FocusState private var focused: Bool

    private var ids: [String] { groups.flatMap { $0.options.map(\.id) } }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(groups) { g in
                        if !g.title.isEmpty {
                            Text(g.title)
                                .font(.caption).fontWeight(.semibold).foregroundStyle(.secondary)
                                .padding(.horizontal, 10).padding(.top, 8).padding(.bottom, 3)
                                .accessibilityAddTraits(.isHeader)
                        }
                        ForEach(g.options) { o in row(o).id(o.id) }
                    }
                }
                .padding(5)
            }
            .frame(width: 330, height: height)
            .focusable()
            .focused($focused)
            .focusEffectDisabled()
            .onKeyPress(.downArrow) { move(1, proxy); return .handled }
            .onKeyPress(.upArrow) { move(-1, proxy); return .handled }
            .onKeyPress(.home) { jump(ids.first, proxy); return .handled }
            .onKeyPress(.end) { jump(ids.last, proxy); return .handled }
            .onKeyPress(.return) { onDone(active); return .handled }
            .onKeyPress(.space) { onDone(active); return .handled }
            .onKeyPress(.escape) { onDone(nil); return .handled }
            .onAppear {
                active = ids.contains(selection) ? selection : ids.first
                focused = true
                if let a = active { proxy.scrollTo(a, anchor: .center) }
            }
        }
    }

    private func move(_ d: Int, _ proxy: ScrollViewProxy) {
        guard !ids.isEmpty else { return }
        let i = active.flatMap { ids.firstIndex(of: $0) } ?? -1
        jump(ids[max(0, min(ids.count - 1, i + d))], proxy)
    }

    private func jump(_ id: String?, _ proxy: ScrollViewProxy) {
        guard let id else { return }
        active = id
        proxy.scrollTo(id)
    }

    private func row(_ o: DescribedOption) -> some View {
        let chosen = o.id == selection
        return HStack(alignment: .firstTextBaseline, spacing: 7) {
            Image(systemName: "checkmark").font(.caption.weight(.semibold)).opacity(chosen ? 1 : 0).frame(width: 12)
            VStack(alignment: .leading, spacing: 1) {
                Text(o.name).fontWeight(chosen ? .semibold : .regular)
                if !o.desc.isEmpty {
                    Text(o.desc).font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 6).fill(active == o.id ? Color.primary.opacity(0.08) : .clear))
        .contentShape(Rectangle())
        .onTapGesture { onDone(o.id) }
        .onHover { if $0 { active = o.id } }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { onDone(o.id) }
    }
}

extension SettingsText {
    /// The voice list for DescribedPicker (port of web/panel.js voicePickerModel): grouped by
    /// presentation, each row the name over "tone · accent".
    public static func voicePickerGroups(_ voices: [String], info: [String: VoiceInfo]) -> [DescribedGroup] {
        voiceGroups(voices, info: info).map { g in
            DescribedGroup(id: g.id, title: g.title, options: g.voices.map { v in
                let i = info[v]
                let desc = [i?.tone, i?.accent].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
                return DescribedOption(id: v, name: voiceLabel(v), desc: desc)
            })
        }
    }

    /// The persona list (port of web/panel.js personaPickerModel): each row the name over its
    /// description and voice; the button's line is just the voice.
    public static func personaPickerGroups(_ personas: [NativeSettings.Persona]) -> [DescribedGroup] {
        [DescribedGroup(id: "personas", title: "", options: personas.map { p in
            var d = p.description ?? ""
            if d.hasSuffix(".") { d.removeLast() }
            let voice = p.voice.flatMap { $0.isEmpty ? nil : "\(voiceLabel($0)) voice" }
            return DescribedOption(id: p.id, name: personaLabel(p), desc: [d.isEmpty ? nil : d, voice].compactMap { $0 }.joined(separator: " · "), short: voice ?? "")
        })]
    }
}
