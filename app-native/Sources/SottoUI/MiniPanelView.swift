// The compact strip (IMPLEMENTATION.md §1 "Mini", 320 x 96): the peg, the string, the
// word and one caption line, with Claude's moon glyph and timer on the word row (fixed, so
// nothing moves). The eclipse, the stars, the tides and the sunrise all play here too, at
// the strip's scale. Double-click or the expand button returns to the full panel.
import SwiftUI
import SottoClient

public struct MiniPanelView: View {
    let model: StateModel
    var onExpand: () -> Void
    var stillAt: Double?
    @Environment(\.colorScheme) private var scheme

    public init(model: StateModel, onExpand: @escaping () -> Void) { self.model = model; self.onExpand = onExpand }
    init(model: StateModel, stillAt: Double?) { self.model = model; self.onExpand = {}; self.stillAt = stillAt }

    public static let size = CGSize(width: 320, height: 96)
    /// Claude's moon and timer: a fixed 78 pt slot left of the expand button.
    static let slotX: CGFloat = 206

    public var body: some View {
        let L = HybridLayout.mini(Self.size)
        let t = HybridTheme.of(scheme)
        let now = stillAt.map { Date(timeIntervalSinceReferenceDate: $0) } ?? Date()
        ZStack(alignment: .topLeading) {
            PanelBackground(layout: L)
            FilamentStage(model: model, layout: L, stillAt: stillAt)
            HeadlineView(model: model, layout: L, stillAt: stillAt, mini: true)
                .place(CGRect(x: L.textX, y: L.wordY, width: Self.slotX - L.textX - 6, height: L.wordH))
            // Claude's moon and timer sit right of the word, in a fixed slot.
            Group {
                if stillAt == nil && (model.claudeBusy || model.attention) {
                    TimelineView(.periodic(from: .now, by: 1)) { ctx in claudeSlot(t, now: ctx.date) }
                } else {
                    claudeSlot(t, now: now)
                }
            }
            .place(CGRect(x: Self.slotX, y: L.wordY, width: 78, height: L.wordH), alignment: .trailing)
            PegButton(model: model)
                .scaleEffect(0.8)
                .place(CGRect(x: L.pegX - 32, y: L.y - 32, width: 64, height: 64))
            CaptionLine(model: model, layout: L, stillAt: stillAt)
                .place(CGRect(x: L.textX, y: L.capY, width: L.x1 - L.textX, height: L.capH))
            Button(action: onExpand) {
                Image(systemName: "arrow.up.left.and.arrow.down.right").font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(t.ink3).frame(width: 26, height: 26).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Show the full panel (\u{2325}\u{2318}T)")
            .accessibilityLabel("Expand")
            .place(CGRect(x: Self.size.width - 28, y: 2, width: 26, height: 26))
        }
        .frame(width: Self.size.width, height: Self.size.height, alignment: .topLeading)
        .background(t.ground)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(t.hair2, lineWidth: 0.5))
        .foregroundStyle(t.ink)
        .contentShape(Rectangle())
        .onTapGesture(count: 2, perform: onExpand)
        .environment(\.sottoStill, stillAt != nil)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Sotto")
    }

    private func claudeSlot(_ t: HybridTheme, now: Date) -> some View {
        var card = model.claudeCard
        if card.kind == "approval" && !model.attentionShown(at: now) { card.kind = "working" }
        let head = ViewText.claudeHead(card)
        let phase = HybridText.Phase(head: head.phase)
        return HStack(spacing: 6) {
            MoonGlyph(phase: phase).foregroundStyle(phase == .need ? t.needInk : phase == .idle ? t.ink3 : t.ink2)
                .accessibilityLabel(head.need ? head.label : "\(head.label) \(head.detail ?? "")")
            ClaudeTimer(text: phase == .need ? model.waitingTime(at: now) : model.workingClock(at: now), need: phase == .need)
        }
    }
}
