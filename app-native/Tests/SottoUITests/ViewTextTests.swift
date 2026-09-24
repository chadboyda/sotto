// ViewText against web/lib.js: every case in test/fixtures/native/viewtext.json was
// computed by lib.js (test/web/native-viewtext.test.js pins it), and must come out
// identical from the Swift port.
import XCTest
@testable import SottoUI
@testable import SottoClient

final class ViewTextTests: XCTestCase {
    static var fixtureURL: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("test/fixtures/native/viewtext.json")
    }

    func testFixtureMatchesLibJS() throws {
        let data = try Data(contentsOf: Self.fixtureURL)
        guard case .array(let cases) = try JSONDecoder().decode(JSONValue.self, from: data) else { return XCTFail("fixture is not an array") }
        XCTAssertGreaterThan(cases.count, 150)
        var failures = 0
        for c in cases {
            guard case .object(let o) = c, case .string(let fn)? = o["fn"], case .array(let args)? = o["args"] else { continue }
            let want = o["out"] ?? .null
            let got = run(fn, args)
            if !same(normalize(got), normalize(want)) {
                failures += 1
                XCTFail("\(fn)(\(json(.array(args)))):\n  want \(json(want))\n  got  \(json(got))")
            }
        }
        XCTAssertEqual(failures, 0)
    }

    // MARK: dispatch

    func run(_ fn: String, _ a: [JSONValue]) -> JSONValue {
        switch fn {
        case "statusLabel": return .string(ViewText.statusLabel(a[0].str))
        case "formatDuration": return .string(ViewText.formatDuration(a[0].num, long: a[1].boolean ?? false))
        case "formatClock": return .string(ViewText.formatClock(a[0].num))
        case "formatUsage": return .string(ViewText.formatUsage(a[0].num))
        case "usagePills":
            let o = a[0].obj ?? [:]
            let p = ViewText.usagePills(sessionSeconds: o.number("sessionSeconds"), todaySeconds: o.number("todaySeconds") ?? 0, costSeconds: o.number("costSeconds") ?? 0)
            func pill(_ x: ViewText.Pill?) -> JSONValue { x.map { .object(["text": .string($0.text), "wide": .bool($0.wide)]) } ?? .null }
            return .object(["session": pill(p.session), "today": pill(p.today), "cost": pill(p.cost)])
        case "stableUsage":
            let prev = a[0].obj.map { ViewText.UsageReading(seconds: $0.number("seconds") ?? 0, at: $0.number("at") ?? 0) }
            let r = ViewText.stableUsage(prev, seconds: a[1].num, now: a[2].num ?? 0)
            return .object(["seconds": .number(r.seconds), "at": .number(r.at)])
        case "tickingToday":
            let r = a[0].obj.map { ViewText.UsageReading(seconds: $0.number("seconds") ?? 0, at: $0.number("at") ?? 0) }
            let o = a[2].obj ?? [:]
            return .number(ViewText.tickingToday(r, now: a[1].num ?? 0, live: o.bool("live") ?? false, shown: o.number("shown")))
        case "normalizeTheme": return .string(ViewText.normalizeTheme(a[0].str))
        case "formatMoney": return .string(ViewText.formatMoney(a[0].num))
        case "formatElapsed": return .string(ViewText.formatElapsed(a[0].num))
        case "truncate": return .string(ViewText.truncate(a[0].str, Int(a[1].num ?? 160)))
        case "delegationLabel":
            let l = ViewText.delegationLabel(a[0].str)
            return .object(["label": .string(l.label), "tone": .string(l.tone)])
        case "closedReasonMessage": return opt(ViewText.closedReasonMessage(a[0].str))
        case "pausedMessage": return .string(ViewText.pausedMessage(a[0].str, idleMinutes: a[1].num, idleSeconds: a[2].num))
        case "errorBannerText": return opt(ViewText.errorBannerText(a[0].obj ?? [:]))
        case "activityView":
            let o = a[0].obj ?? [:]
            let v = ViewText.activityView(kind: o.string("kind"), text: o.string("text"), summary: o.string("summary"))
            return .object(["text": .string(v.text), "busy": v.busy.map { .bool($0) } ?? .null, "summary": opt(v.summary), "tone": .string(v.tone)])
        case "claudeView":
            let o = a[0].obj ?? [:]
            var input = ViewText.ClaudeInput(busy: o.bool("busy"), kind: o.string("kind"), text: o.string("text"), says: o.string("says"),
                                             saysAt: o.number("saysAt"), now: o.number("now"), tool: o.string("tool"), summary: o.string("summary"),
                                             agents: o.number("agents").map { Int($0) })
            if let r = o.object("request") { input.request = .init(id: "r", status: r.string("status") ?? "", text: r.string("text") ?? "") }
            let v = ViewText.claudeView(input)
            var out: [String: JSONValue] = ["kind": .string(v.kind), "title": .string(v.title), "agents": opt(v.agents)]
            out["request"] = v.request.map { .object(["text": .string($0.text), "label": .string($0.label), "tone": .string($0.tone)]) } ?? .null
            if let s = v.step { out["step"] = .string(s) }
            if let s = v.secondary { out["secondary"] = .bool(s) }
            if v.kind == "approval" { out["command"] = opt(v.command); out["note"] = opt(v.note) }
            if let s = v.summary { out["summary"] = .string(s) }
            return .object(out)
        case "stripMarkdown": return .string(ViewText.stripMarkdown(a[0].str))
        case "keySettingsView":
            let v = ViewText.keySettingsView(key(a[0]))
            return .object(["text": .string(v.text), "help": .string(v.help), "change": .bool(v.change), "remove": .bool(v.remove), "changeLabel": .string(v.changeLabel)])
        case "sleepView":
            let o = a[0].obj ?? [:]
            let v = ViewText.sleepView(muted: o.bool("muted") ?? false, enabled: o.bool("enabled") ?? true, cooldownMs: o.number("cooldownMs") ?? 0, micError: o.string("micError"))
            return sleepJSON(v)
        case "hotkeyAction":
            let ev = a[0].obj ?? [:], ctx = a[1].obj ?? [:]
            let r = ViewText.hotkeyAction(key: ev.string("key") ?? "", repeat_: ev.bool("repeat") ?? false,
                                          modifiers: (ev.bool("meta") ?? false) || (ev.bool("ctrl") ?? false) || (ev.bool("alt") ?? false),
                                          targetTag: ev.string("targetTag") ?? "", live: ctx.bool("live") ?? false, paused: ctx.bool("paused") ?? false,
                                          sleeping: ctx.bool("sleeping") ?? false)
            return opt(r?.rawValue)
        case "reduceCaptions":
            guard case .array(let frags) = a[0] else { return .null }
            var lines: [ViewText.Caption] = []
            for f in frags {
                let o = f.obj ?? [:]
                lines = ViewText.reduceCaptions(lines, role: o.string("role"), text: o.string("text"), startMs: o.number("start_ms"), endMs: o.number("end_ms"),
                                                session: o.string("session"), max: Int(a[1].num ?? 60))
            }
            return .array(lines.map { .object(["role": .string($0.role), "text": .string($0.text), "start_ms": .number($0.startMs), "end_ms": .number($0.endMs), "session": opt($0.session)]) })
        case "upsertDelegation":
            guard case .array(let evs) = a[0] else { return .null }
            var list: [ViewText.Delegation] = []
            for e in evs {
                let o = e.obj ?? [:]
                list = ViewText.upsertDelegation(list, id: o.string("id"), status: o.string("status"), text: o.string("text"), max: Int(a[1].num ?? 3))
            }
            return .array(list.map { .object(["id": .string($0.id), "status": .string($0.status), "text": .string($0.text)]) })
        case "pageView": return pageJSON(ViewText.pageView(pageInput(a[0].obj ?? [:])))
        case "cardAnnouncement":
            let o = a[0].obj ?? [:]
            var card = ViewText.Card(kind: o.string("kind") ?? "", title: o.string("title") ?? "", body: o.string("body") ?? "")
            card.tone = o.string("tone") ?? "neutral"
            guard let r = ViewText.cardAnnouncement(card) else { return .null }
            return .object(["text": .string(r.text), "assertive": .bool(r.assertive)])
        case "windowTitle": return .string(ViewText.windowTitle(floor: a[0].str ?? "", attention: a[1].boolean ?? false))
        default:
            XCTFail("no Swift port for \(fn)")
            return .null
        }
    }

    func pageInput(_ o: [String: JSONValue]) -> ViewText.PageInput {
        var p = ViewText.PageInput()
        p.phase = o.string("phase") ?? "boot"
        p.state = o.string("state") ?? "off"
        p.sseDown = o.bool("sseDown") ?? false
        p.unauthorized = o.bool("unauthorized") ?? false
        p.muted = o.bool("muted") ?? false
        p.floor = o.string("floor")
        p.connectStage = o.string("connectStage")
        p.connectReason = o.string("connectReason")
        p.micPrompt = o.bool("micPrompt") ?? false
        p.micFailure = o.string("micFailure")
        p.errorText = o.string("errorText")
        p.errorCode = o.string("errorCode")
        p.key = o["key"].flatMap(key)
        p.pausedReason = o.string("pausedReason")
        p.idleMinutes = o.number("idleMinutes")
        p.idleSeconds = o.number("idleSeconds")
        p.capMinutes = o.number("capMinutes")
        p.pendingResult = o.string("pendingResult")
        p.lastErrorCode = o.object("lastError")?.string("code")
        p.lastErrorMessage = o.object("lastError")?.string("message")
        p.attention = o.bool("attention") ?? false
        if let s = o.object("sleep") { p.sleep = .init(title: s.string("title") ?? "", body: s.string("body") ?? "", listening: s.bool("listening") ?? false) }
        p.host = o.string("host") ?? "browser"
        return p
    }

    func key(_ v: JSONValue) -> PageStatus.Key? {
        guard case .object = v, let d = try? JSONEncoder().encode(v) else { return nil }
        return try? JSONDecoder().decode(PageStatus.Key.self, from: d)
    }

    func sleepJSON(_ v: ViewText.SleepText) -> JSONValue { .object(["title": .string(v.title), "body": .string(v.body), "listening": .bool(v.listening)]) }

    func pageJSON(_ v: ViewText.PageView) -> JSONValue {
        var card: JSONValue = .null
        if let c = v.card {
            var o: [String: JSONValue] = [
                "kind": .string(c.kind), "title": .string(c.title), "body": .string(c.body), "pending": opt(c.pending), "button": opt(c.button),
                "action": opt(c.action), "kbd": .bool(c.kbd), "steps": c.steps.map { .array($0.map { .string($0) }) } ?? .null, "arrow": .bool(c.arrow),
                "keyInput": .bool(c.keyInput), "tone": .string(c.tone), "secondary": .bool(c.secondary),
            ]
            if let n = c.note { o["note"] = .string(n) }
            if let l = c.listening { o["listening"] = .bool(l) }
            if let l = c.link { o["link"] = .object(["href": .string(l.href), "label": .string(l.label)]) }
            card = .object(o)
        }
        return .object([
            "view": .string(v.view), "dial": .string(v.dial), "floor": .string(v.floor), "word": .string(v.word), "sub": opt(v.sub),
            "wordTone": opt(v.wordTone), "dialHint": opt(v.dialHint),
            "steps": v.steps.map { .array($0.map { .object(["key": .string($0.key), "label": .string($0.label), "state": .string($0.state)]) }) } ?? .null,
            "card": card,
            "header": .object(["key": .string(v.header.key), "label": .string(v.header.label), "detail": opt(v.header.detail)]),
        ])
    }

    // MARK: helpers

    func opt(_ s: String?) -> JSONValue { s.map { .string($0) } ?? .null }

    /// Absent and null are the same (JS drops `undefined` in JSON).
    func normalize(_ v: JSONValue) -> JSONValue {
        switch v {
        case .object(let o): return .object(o.filter { $0.value != .null }.mapValues(normalize))
        case .array(let a): return .array(a.map(normalize))
        default: return v
        }
    }

    func same(_ a: JSONValue, _ b: JSONValue) -> Bool { a == b }

    func json(_ v: JSONValue) -> String {
        let e = JSONEncoder(); e.outputFormatting = [.sortedKeys]
        return (try? String(data: e.encode(v), encoding: .utf8)) ?? "?"
    }
}

extension JSONValue {
    var str: String? { if case .string(let s) = self { return s }; return nil }
    var num: Double? { if case .number(let n) = self { return n }; return nil }
    var boolean: Bool? { if case .bool(let b) = self { return b }; return nil }
    var obj: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
}
