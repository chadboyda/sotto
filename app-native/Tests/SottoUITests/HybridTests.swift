// The Filament + Orrery panel (design/concepts-v2/hybrid): the words (against the shared
// fixture test/fixtures/native/hybrid.json), the tunings, the engine's redraw rate (0 fps
// idle, 10 fps while only the bead moves), the eclipse freeze, the tides cap, and the
// model's event clocks and milestone stars.
import XCTest
import SwiftUI
@testable import SottoUI
@testable import SottoClient

final class HybridTextTests: XCTestCase {
    func testMoonPhasesFromClaudeHead() {
        XCTAssertEqual(HybridText.Phase(head: "new"), .idle)
        XCTAssertEqual(HybridText.Phase(head: "waxing"), .work)
        XCTAssertEqual(HybridText.Phase(head: "eclipse"), .need)
        XCTAssertEqual(HybridText.Phase(head: "full"), .done)
    }

    func testBeadAndStars() {
        XCTAssertEqual(HybridText.beadS(elapsed: 0), 0.05, accuracy: 1e-9)
        XCTAssertLessThanOrEqual(HybridText.beadS(elapsed: 3600), 0.9 + 1e-9, "the bead never reaches the bridge while Claude works")
        XCTAssertEqual(HybridText.beadS(elapsed: 10), ViewText.beadPosition(10_000), accuracy: 1e-4, "the same curve as lib.beadPosition")
        XCTAssertEqual(HybridText.starAlpha(age: 1200), 0.46, accuracy: 1e-9, "half-life 20 minutes")
        XCTAssertEqual(HybridText.starAlpha(age: 100_000), 0.3, "never below 0.3")
    }

    func testApprovalCommandSplit() {
        XCTAssertEqual(ApprovalBody.split("Bash: rm -rf node_modules && npm ci").command, "rm -rf node_modules && npm ci")
        XCTAssertEqual(ApprovalBody.split("A background agent needs approval to run a shell command").sentence, "A background agent needs approval to run a shell command")
        XCTAssertEqual(ApprovalBody.split("git push origin main").command, "git push origin main")
        XCTAssertNil(ApprovalBody.split(nil).command)
    }
}

final class TuningTests: XCTestCase {
    func testBuiltinsAreDistinctShapes() {
        let ids = ["sotto", "june", "moss", "tempo", "koan", "vic", "pip", "fern", "lark", "vela"]
        let envs = ids.map { Tuning.of($0).envelope(points: 24) }
        for i in 0..<envs.count { for j in (i + 1)..<envs.count { XCTAssertNotEqual(envs[i], envs[j], "\(ids[i]) and \(ids[j]) look the same with the sound off") } }
        XCTAssertEqual(Set(ids.map { Tuning.of($0).detent }).count, 10, "one detent per persona")
    }

    func testCustomPersonaGetsAStableTuning() {
        let a = Tuning.of("my-reviewer"), b = Tuning.of("my-reviewer")
        XCTAssertEqual(a, b)
        XCTAssertTrue((0.8...1.8).contains(a.f))
        XCTAssertTrue((1.1...1.6).contains(a.width))
        XCTAssertEqual(a.w[1], 0, "odd harmonics only")
    }

    func testEnvelopeIsNormalized() {
        let e = Tuning.of("koan").envelope(points: 96)
        XCTAssertEqual(e.count, 96)
        XCTAssertEqual(e.max()!, 1, accuracy: 0.02)
        XCTAssertEqual(e.first!, 0, accuracy: 1e-9)
    }
}

final class FilamentEngineTests: XCTestCase {
    func live(_ f: (inout FilamentInput) -> Void = { _ in }) -> FilamentInput { var i = FilamentInput(); f(&i); return i }

    func testIdleIsZeroFPS() {
        // Anything but live listening is a still image: off, paused, muted.
        let e = FilamentEngine()
        for i in [live { $0.mode = .off }, live { $0.mode = .paused }, live { $0.muted = true }, live { $0.cantHear = true }] {
            e.advance(i, to: 1000, sc: 1)
            XCTAssertEqual(e.rate(i, now: 1002), .paused, "\(i.mode) muted=\(i.muted) is a still image")
        }
        // Stars and a finished Claude long ago change nothing.
        let j = live { $0.mode = .off; $0.stars = [.init(s: 0.3, born: 100)]; $0.finishedAt = 10 }
        XCTAssertEqual(e.rate(j, now: 1000), .paused)
    }

    func testListeningBreathesCalmly() {
        // v0.4.1: live and listening, the string breathes at 12 fps (alive, not a rule).
        let e = FilamentEngine()
        let i = live()
        e.advance(i, to: 1000, sc: 1)
        XCTAssertEqual(e.rate(i, now: 1000), .breathe)
        XCTAssertEqual(FilamentEngine.Rate.breathe.interval!, 1.0 / 12, accuracy: 1e-9)
        XCTAssertTrue(FilamentEngine.breathing(i, now: 1000))
        XCTAssertFalse(FilamentEngine.breathing(live { $0.reduced = true }, now: 1000), "Reduce Motion: still")
        XCTAssertFalse(FilamentEngine.breathing(live { $0.attention = true; $0.attentionAt = 990 }, now: 1000), "the approval holds its own stillness")
    }

    func testLevelsAreOnTheMeterScale() {
        // The audio layer reports raw RMS; the string and the floor need lib.levelFromRms.
        XCTAssertEqual(ViewText.levelFromRms(0.001), 0, accuracy: 1e-9)       // -60 dBFS
        XCTAssertEqual(ViewText.levelFromRms(0.0316), 0.6, accuracy: 0.001)   // -30 dBFS: ordinary speech
        XCTAssertEqual(ViewText.levelFromRms(1), 1)
        XCTAssertEqual(ViewText.levelFromRms(ViewText.rmsFromLevel(0.62)), 0.62, accuracy: 1e-9)
        XCTAssertEqual(ViewText.gateLevel(0.1), 0)
        XCTAssertEqual(ViewText.gateLevel(0.56), 0.5, accuracy: 1e-9)
    }

    func testWorkingSilentIsTenFPS() {
        let e = FilamentEngine()
        let i = live { $0.busy = true; $0.workSince = 900 }
        e.advance(i, to: 1000, sc: 1)
        XCTAssertEqual(e.rate(i, now: 1000), .work)
        XCTAssertEqual(FilamentEngine.Rate.work.interval, 0.1)
    }

    func testSpeechRunsThenSettlesToPaused() {
        let e = FilamentEngine()
        let speaking = live { $0.floor = "you"; $0.mic = 0.8 }
        var t = 1000.0
        while t < 1003 { t += 1.0 / 60; e.advance(speaking, to: t, sc: 1) }
        XCTAssertEqual(e.rate(speaking, now: t), .full)
        XCTAssertFalse(e.waveAtRest, "your voice plucked the string")
        let quiet = live()
        let stop = t
        while t < stop + 12 && e.rate(quiet, now: t) != .breathe { t += 1.0 / 60; e.advance(quiet, to: t, sc: 1) }
        XCTAssertEqual(e.rate(quiet, now: t), .breathe, "the string comes back to its resting breath after speech")
        XCTAssertLessThan(t - stop, 10, "and quickly: \(t - stop) s")
    }

    func testVoiceTidesAtMostThree() {
        let e = FilamentEngine()
        let v = live { $0.floor = "voice"; $0.voice = 0.9 }
        var t = 500.0
        for _ in 0..<600 { t += 1.0 / 60; e.advance(v, to: t, sc: 1); XCTAssertLessThanOrEqual(e.tides.count, 3) }
        XCTAssertGreaterThan(e.tides.count, 0)
        // No tides while Claude waits for you.
        let w = live { $0.floor = "voice"; $0.voice = 0.9; $0.attention = true; $0.attentionAt = t }
        let e2 = FilamentEngine()
        var t2 = t
        for _ in 0..<300 { t2 += 1.0 / 60; e2.advance(w, to: t2, sc: 1) }
        XCTAssertEqual(e2.tides.count, 0)
    }

    func testEclipseFreezeHoldsTheString() {
        let e = FilamentEngine()
        let speaking = live { $0.floor = "you"; $0.mic = 0.9 }
        var t = 100.0
        while t < 101 { t += 1.0 / 60; e.advance(speaking, to: t, sc: 1) }
        let before = e.u
        let asked = live { $0.floor = "you"; $0.mic = 0.9; $0.attention = true; $0.attentionAt = t }
        e.advance(asked, to: t + 0.25, sc: 1)
        XCTAssertEqual(e.u, before, "for 300 ms nothing integrates: the string holds its shape mid-motion")
        XCTAssertEqual(e.rate(asked, now: t + 0.25), .full)
        // Once the corona has bloomed the canvas rests; only the corona quad shimmers.
        let held = live { $0.attention = true; $0.attentionAt = t }
        var t2 = t + 0.3
        while t2 < t + 6 { t2 += 1.0 / 60; e.advance(held, to: t2, sc: 1) }
        XCTAssertEqual(e.rate(held, now: t2), .paused)
    }

    func testMomentTimingTable() {
        let e = FilamentEngine()
        let at = 100.0
        let i = live { $0.attention = true; $0.attentionAt = at; $0.busy = false; $0.workSince = 40 }
        e.observe(i, now: at)
        let freeze = FilamentMoment.at(i, now: at + 0.2, sc: 1, engine: e)
        XCTAssertEqual(freeze.eclipse, 0); XCTAssertEqual(freeze.frame, 0); XCTAssertEqual(freeze.dim, 0)
        XCTAssertNotNil(freeze.bead, "the bead holds where it was")
        let crossing = FilamentMoment.at(i, now: at + 0.5, sc: 1, engine: e)
        XCTAssertGreaterThan(crossing.dim, 0); XCTAssertEqual(crossing.eclipse, 0)
        let totality = FilamentMoment.at(i, now: at + 0.76, sc: 1, engine: e)
        XCTAssertEqual(totality.eclipse, 1); XCTAssertNil(totality.bead)
        XCTAssertGreaterThan(totality.flash, 0, "the diamond ring at contact")
        let held = FilamentMoment.at(i, now: at + 3, sc: 1, engine: e)
        XCTAssertEqual(held.frame, 1, accuracy: 0.01); XCTAssertEqual(held.corona, 1, accuracy: 0.01); XCTAssertEqual(held.flash, 0)
        var rm = i; rm.reduced = true
        let reduced = FilamentMoment.at(rm, now: at + 0.01, sc: 1, engine: e)
        XCTAssertEqual(reduced.eclipse, 1); XCTAssertEqual(reduced.frame, 1); XCTAssertEqual(reduced.flash, 0, "Reduce Motion: complete at once, no flash")
    }

    func testReduceMotionNeverAnimates() {
        let e = FilamentEngine()
        let i = live { $0.floor = "you"; $0.mic = 0.9; $0.reduced = true; $0.busy = true; $0.workSince = 1 }
        e.advance(i, to: 50, sc: 1)
        XCTAssertEqual(e.rate(i, now: 50), .paused)
        XCTAssertTrue(e.waveAtRest || e.u.allSatisfy { $0 == 0 })
    }
}

@MainActor
final class HybridModelTests: XCTestCase {
    func connected(_ m: StateModel, busy: Bool = false) {
        m.linkState = .connected
        m.apply(object: UISnapshot.status("live", busy: busy))
    }

    func testMilestoneStarsFromClaudesWords() {
        let m = StateModel()
        var t = Date(timeIntervalSinceReferenceDate: 1_000)
        m.now = { t }
        connected(m, busy: true)
        m.apply(object: ["type": .string("activity"), "kind": .string("turn_start"), "text": .string("")])
        t += 5
        m.apply(object: ["type": .string("activity"), "kind": .string("text"), "text": .string("I read the auth spec and the helpers.")])
        XCTAssertEqual(m.milestones.count, 1)
        t += 5
        m.apply(object: ["type": .string("activity"), "kind": .string("text"), "text": .string("Found the race in withSession().")])
        XCTAssertEqual(m.milestones.count, 1, "at most one star per 20 s")
        t += 25
        m.apply(object: ["type": .string("activity"), "kind": .string("text"), "text": .string("The auth suite passes 40 times in a row.")])
        XCTAssertEqual(m.milestones.count, 2)
        XCTAssertGreaterThan(m.milestones[1].s, m.milestones[0].s, "each star sits where the bead was")
        // A tool label is never a star and never on the page.
        m.apply(object: ["type": .string("activity"), "kind": .string("tool"), "text": .string("Running the tests")])
        XCTAssertFalse(m.pageMessages.contains("Running the tests"))
        XCTAssertEqual(m.pageMessages.count, 3)
        for _ in 0..<20 {
            t += 21
            m.apply(object: ["type": .string("activity"), "kind": .string("text"), "text": .string("Step \(t.timeIntervalSinceReferenceDate) is done now.")])
        }
        XCTAssertEqual(m.milestones.count, ViewText.starMax, "capped at 12, oldest out first")
        m.apply(object: UISnapshot.status("off"))
        XCTAssertTrue(m.milestones.isEmpty, "stars end with the voice session")
    }

    func testEventClocks() {
        let m = StateModel()
        var t = Date(timeIntervalSinceReferenceDate: 2_000)
        m.now = { t }
        connected(m, busy: true)
        m.apply(object: ["type": .string("activity"), "kind": .string("turn_start"), "text": .string("")])
        m.apply(object: ["type": .string("activity"), "kind": .string("permission"), "text": .string("Bash: npm ci")])
        XCTAssertEqual(m.attentionAt, t)
        XCTAssertFalse(m.attentionShown(at: t.addingTimeInterval(0.5)), "the words change at totality")
        XCTAssertTrue(m.attentionShown(at: t.addingTimeInterval(0.8)))
        XCTAssertEqual(m.headline(at: t.addingTimeInterval(0.5)).word, "Claude is working")
        XCTAssertEqual(m.headline(at: t.addingTimeInterval(0.8)).word, "Approve in the terminal")
        XCTAssertEqual(ViewText.statusWord(m.pageView(at: t.addingTimeInterval(0.5))), "Live", "the header waits for totality too")
        XCTAssertEqual(ViewText.statusWord(m.pageView(at: t.addingTimeInterval(0.8))), "Needs you")
        t += 4
        m.apply(object: ["type": .string("activity"), "kind": .string("approval_cleared"), "text": .string(""), "busy": .bool(true)])
        XCTAssertEqual(m.attentionClearedAt, t)
        t += 10
        m.apply(object: ["type": .string("activity"), "kind": .string("turn_end"), "text": .string(""), "summary": .string("All green.")])
        XCTAssertEqual(m.finishedAt, t)
        XCTAssertEqual(m.headline(at: t.addingTimeInterval(3)).word, "Claude finished")
        XCTAssertEqual(m.headline(at: t.addingTimeInterval(40)).word, "Listening")
        XCTAssertEqual(m.pageMessages.last, "All green.")
        // Sleep, then the sunrise.
        m.apply(object: UISnapshot.status("sleeping"))
        t += 1
        m.apply(object: UISnapshot.status("live"))
        XCTAssertEqual(m.wokeAt, t)
    }

    func testPersonaSwitchIsNamed() {
        let m = StateModel()
        let t = Date(timeIntervalSinceReferenceDate: 3_000)
        m.now = { t }
        m.linkState = .connected
        m.apply(object: ["type": .string("welcome"), "protocol": .number(1), "status": UISnapshot.status("live", persona: "sotto")["status"]!,
                         "settings": .object(["personas": UISnapshot.personas])])
        m.apply(object: UISnapshot.status("live", persona: "koan", voice: "sage"))
        XCTAssertEqual(m.personaSwitch?.from, "sotto")
        XCTAssertEqual(m.personaSwitch?.to, "koan")
        XCTAssertEqual(m.switchingTo(at: t.addingTimeInterval(1)), "Koan")
        XCTAssertNil(m.switchingTo(at: t.addingTimeInterval(3)))
        XCTAssertEqual(m.personaName("june"), "June")
        XCTAssertEqual(m.personaName("custom-one"), "Custom-one")
    }

    func testCaptionLineOneFactEach() {
        let m = StateModel()
        let t = Date(timeIntervalSinceReferenceDate: 4_000)
        m.now = { t }
        connected(m)
        m.apply(object: ["type": .string("caption"), "role": .string("user"), "text": .string("Hi"), "start_ms": .number(0), "end_ms": .number(1), "session": .string("sess_snap")])
        if case .said(let role, let who, let text, _) = CaptionLine.line(m, at: t) { XCTAssertEqual([role, who, text], ["user", "You", "Hi"]) } else { XCTFail("said") }
        m.apply(object: ["type": .string("notice"), "level": .string("warn"), "code": .string("cant_hear"), "text": .string("I can't hear you.")])
        XCTAssertTrue(m.cantHear)
        if case .banner(let b, _) = CaptionLine.line(m, at: t) { XCTAssertEqual(b.action, .switchMic) } else { XCTFail("banner") }
        m.apply(object: ["type": .string("notice_clear"), "code": .string("cant_hear")])
        m.apply(object: UISnapshot.status("live", muted: true))
        XCTAssertEqual(CaptionLine.line(m, at: t), .muted)
    }
}

/// Text contrast (WCAG 2.x, composited over `ground` in sRGB as the page's CSS is): text
/// tokens >= 4.5:1 in both themes; `ink3` is for glyphs and lines (>= 3:1); Increase
/// Contrast raises every quiet token.
final class HybridContrastTests: XCTestCase {
    private func srgb(_ c: Color) -> (r: Double, g: Double, b: Double, a: Double) {
        let r = c.resolve(in: EnvironmentValues())
        // The tokens are extended-sRGB colours; Resolved reports their encoded components.
        return (Double(r.red), Double(r.green), Double(r.blue), Double(r.opacity))
    }
    private func luminance(_ r: Double, _ g: Double, _ b: Double) -> Double {
        func lin(_ x: Double) -> Double { x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4) }
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    }
    private func ratio(_ fg: Color, on bg: Color) -> Double {
        let f = srgb(fg), b = srgb(bg)
        let r = f.r * f.a + b.r * (1 - f.a), g = f.g * f.a + b.g * (1 - f.a), bl = f.b * f.a + b.b * (1 - f.a)
        let l1 = luminance(r, g, bl), l2 = luminance(b.r, b.g, b.b)
        return (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)
    }

    func testTextTokensMeetAA() {
        for scheme in [ColorScheme.light, .dark] {
            for more in [false, true] {
                let t = HybridTheme.of(scheme, increaseContrast: more)
                for (name, c) in [("ink", t.ink), ("ink2", t.ink2), ("fg3", t.fg3), ("needInk", t.needInk), ("mutedInk", t.mutedInk), ("youInk", t.youInk), ("voiceInk", t.voiceInk)] {
                    XCTAssertGreaterThanOrEqual(ratio(c, on: t.ground), 4.5, "\(name) in \(scheme) (increase contrast \(more))")
                }
                XCTAssertGreaterThanOrEqual(ratio(t.ink3, on: t.ground), 3, "ink3 (glyphs) in \(scheme)")
            }
        }
    }

    func testIncreaseContrastRaisesQuietTokens() {
        for scheme in [ColorScheme.light, .dark] {
            let a = HybridTheme.of(scheme), b = HybridTheme.of(scheme, increaseContrast: true)
            for (name, x, y) in [("ink2", a.ink2, b.ink2), ("ink3", a.ink3, b.ink3), ("fg3", a.fg3, b.fg3), ("hair", a.hair, b.hair), ("hair2", a.hair2, b.hair2), ("string", a.string, b.string)] {
                XCTAssertGreaterThan(ratio(y, on: b.ground), ratio(x, on: a.ground), "\(name) in \(scheme)")
            }
        }
    }
}
