// The native side of app/Resources/mic.js (SPEC §6.16, "native mic"): the
// `sottoMic` reply handler (device list, capture plan, start/stop, stats) and
// the sample feed into the page.
import AVFoundation
import CoreAudio
import WebKit

/// Weak proxy: WKUserContentController retains its reply handlers.
final class WeakReplyHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: WKScriptMessageHandlerWithReply?
    init(_ t: WKScriptMessageHandlerWithReply) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let t = target else { return replyHandler(nil, "gone") }
        t.userContentController(c, didReceive: m, replyHandler: replyHandler)
    }
}

final class MicController: NSObject, WKScriptMessageHandlerWithReply {
    static let prefKey = "MicCapture"
    /// "auto" (native on headphones, WebKit on speakers), "native" or "webkit".
    let pref: String
    private let log: DebugLog
    private let testMode: Bool
    private let fixturePath: String?
    private let fixtureLeadMs: Int
    /// Test only: mic.js mixes the remote voice back into the native mic at
    /// this gain, to measure what gpt-live-1 does with an uncancelled echo.
    let echoSimDb: Double?
    /// Evaluate JS in the page (set by the panel controller).
    var evaluate: ((String) -> Void)?
    /// Origin check for the message sender (set by the panel controller).
    var isOurs: ((WKSecurityOrigin) -> Bool)?
    private var captures: [Int: MicSource] = [:]
    private var chunks: [Int: Int] = [:]
    private var routeTimer: Timer?
    private var listening = false

    init(log: DebugLog, testMode: Bool, env: [String: String] = ProcessInfo.processInfo.environment) {
        self.log = log
        self.testMode = testMode
        let valid = ["auto", "native", "webkit"]
        let fromEnv = env["SOTTO_APP_MIC"].map { $0.lowercased() }
        let fromPrefs = Prefs.store.string(forKey: MicController.prefKey)?.lowercased()
        pref = [fromEnv, fromPrefs].compactMap { $0 }.first(where: valid.contains) ?? "auto"
        fixturePath = testMode ? env["SOTTO_APP_MIC_FIXTURE"].flatMap { $0.isEmpty ? nil : $0 } : nil
        fixtureLeadMs = Int(env["SOTTO_APP_MIC_FIXTURE_LEAD_MS"] ?? "") ?? 1500
        echoSimDb = testMode ? env["SOTTO_APP_ECHO_SIM_DB"].flatMap(Double.init) : nil
        super.init()
    }

    /// Prepended to mic.js (document start). Only test settings; empty otherwise.
    var pageConfigScript: String {
        guard let db = echoSimDb else { return "" }
        return "window.__sottoMicConfig = Object.freeze({ echoSimDb: \(db), echoDelayMs: 40 });\n"
    }

    // MARK: route

    func startRouteWatch() {
        guard !listening else { return }
        listening = true
        for sel in [kAudioHardwarePropertyDefaultInputDevice, kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyDevices] {
            var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, DispatchQueue.main) { [weak self] _, _ in
                self?.routeChanged()
            }
        }
    }

    /// Debounced: plugging in AirPods changes the device list, the default
    /// output and the default input within a few hundred ms.
    private func routeChanged() {
        routeTimer?.invalidate()
        routeTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            self.log.log("mic_route", AudioRoute.current().dictionary)
            self.evaluate?("window.__sottoMicRoute && window.__sottoMicRoute()")
        }
    }

    // MARK: messages

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard m.name == "sottoMic", m.frameInfo.isMainFrame, isOurs?(m.frameInfo.securityOrigin) == true,
              let body = m.body as? [String: Any], let op = body["op"] as? String else { return replyHandler(nil, "refused") }
        switch op {
        case "devices": replyHandler(devices(), nil)
        case "plan": replyHandler(plan(requested: body["device"] as? String), nil)
        case "permission": replyHandler(permission(), nil)
        case "start": start(id: (body["id"] as? NSNumber)?.intValue ?? 0, requested: body["device"] as? String, reply: replyHandler)
        case "stop":
            stop(id: (body["id"] as? NSNumber)?.intValue ?? 0)
            replyHandler(true, nil)
        case "stats":
            var f = body.filter { ["id", "transportMs", "transportP95Ms", "queueMs", "underruns", "drops", "trims", "chunks", "echoSim", "echoDb"].contains($0.key) }
            f["source"] = captures[(body["id"] as? NSNumber)?.intValue ?? 0]?.label == nil ? "stopped" : "native"
            log.log("native_mic_stats", f)
            replyHandler(true, nil)
        default: replyHandler(nil, "unknown op")
        }
    }

    private func devices() -> [String: Any] {
        let inputs = Devices.inputs().filter { !$0.name.isEmpty }
        let def = Devices.defaultDevice(input: true)
        var out: [String: Any] = ["inputs": inputs.map { $0.pageDictionary }]
        if testMode { out["inputs"] = [["id": "sotto-test", "label": "Test fixture", "bluetooth": false]] }
        if let d = inputs.first(where: { $0.id == def }), !testMode { out["default"] = d.pageDictionary }
        return out
    }

    private func currentPlan(requested: String?) -> MicPlan? {
        if testMode {
            // The fixture stands in for every device; the mode follows the pref.
            let fake = InputDevice(id: 1, uid: "test", name: "Test fixture", transport: kAudioDeviceTransportTypeBuiltIn)
            let mode: MicPlan.Mode = pref == "native" ? .native : .webkit
            return MicPlan(mode: mode, device: fake, reason: "test_\(pref)")
        }
        return MicPlan.decide(pref: pref, output: Devices.output(), inputs: Devices.inputs(),
                              defaultInput: Devices.defaultDevice(input: true), requested: requested)
    }

    private func plan(requested: String?) -> [String: Any] {
        guard let p = currentPlan(requested: requested) else { return ["error": "NotFoundError"] }
        var d = p.dictionary
        if testMode { d["device"] = ["id": "sotto-test", "label": "Test fixture", "bluetooth": false] }
        return d
    }

    private func permission() -> String {
        if testMode { return "granted" }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return "granted"
        case .notDetermined: return "prompt"
        default: return "denied"
        }
    }

    private func start(id: Int, requested: String?, reply: @escaping (Any?, String?) -> Void) {
        guard id > 0 else { return reply(["error": "TypeError", "message": "bad id"], nil) }
        guard let p = currentPlan(requested: requested), let dev = p.device else {
            return reply(["error": "NotFoundError", "message": "Requested device not found"], nil)
        }
        let go = { [weak self] in
            guard let self = self else { return }
            self.stop(id: id)
            let src: MicSource = self.testMode ? FixtureMicSource(path: self.fixturePath, leadMs: self.fixtureLeadMs) : HALMicSource(device: dev)
            do {
                try src.start { [weak self, weak src] data, wall in
                    let b64 = data.base64EncodedString()
                    DispatchQueue.main.async {
                        guard let self = self, let s = src, self.captures[id] === s else { return }
                        self.chunks[id, default: 0] += 1
                        self.evaluate?("window.__sottoMicFeed && window.__sottoMicFeed(\(id),\(Int(wall)),\"\(b64)\")")
                    }
                }
            } catch {
                src.stop()
                self.log.log("native_mic_error", ["message": error.localizedDescription])
                return reply(["error": "NotReadableError", "message": "Could not start the microphone"], nil)
            }
            self.captures[id] = src
            self.log.log("native_mic_start", ["id": id, "device": src.label, "bluetooth": dev.bluetooth, "reason": p.reason])
            reply(["ok": true, "sampleRate": micRate, "label": src.label, "device": self.testMode ? "sotto-test" : dev.pageId], nil)
        }
        if testMode { return go() }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: go()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { ok in
                DispatchQueue.main.async { ok ? go() : reply(["error": "NotAllowedError", "message": "Permission denied by system"], nil) }
            }
        default: reply(["error": "NotAllowedError", "message": "Permission denied by system"], nil)
        }
    }

    func stop(id: Int) {
        guard let s = captures.removeValue(forKey: id) else { return }
        s.stop()
        log.log("native_mic_stop", ["id": id, "chunks": chunks.removeValue(forKey: id) ?? 0])
    }

    /// The page went away (reload, unload, web content crash).
    func stopAll() { for id in Array(captures.keys) { stop(id: id) } }
}
