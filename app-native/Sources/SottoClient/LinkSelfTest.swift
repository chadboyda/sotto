// `Sotto --selftest link --port P --data-dir D` (docs/NATIVE.md §6 B4): bootstrap
// with page.secret, hello/welcome, one status, clean close. JSON result for
// node:test (test/app/native-link.test.mjs). No audio is opened.
import Foundation

public enum LinkSelfTest {
    /// Blocks the calling thread (not the main thread) up to `timeout` seconds.
    public static func run(port: Int, dataDir: String?, version: String, build: String?, timeout: Double = 10) -> [String: JSONValue] {
        var out: [String: JSONValue] = ["selftest": "link", "port": .number(Double(port))]
        guard daemonRecordsPort(dataDir: dataDir, port: port) else {
            out["ok"] = false; out["error"] = "port_not_recorded"
            return out
        }
        var cfg = LinkClient.Config(version: version, build: build, test: true)
        cfg.callbackQueue = DispatchQueue(label: "sotto.selftest")
        cfg.policy = ReconnectPolicy(steps: [0.05, 0.25, 0.5], steady: 1, window: timeout)
        let link = LinkClient(config: cfg)
        let done = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var states: [String] = []
        var welcome = false, statusState: String?, gotStatus = false, protocolVersion = 0, settings = false
        var finished = false
        func finish() { if !finished { finished = true; done.signal() } }
        link.onState = { s in
            lock.lock(); defer { lock.unlock() }
            states.append("\(s)")
            if case .failed = s { finish() }
        }
        link.onMessage = { m in
            lock.lock(); defer { lock.unlock() }
            switch m {
            case .welcome(let p, _, let st, _):
                welcome = true; protocolVersion = p; statusState = st?.state; settings = m.settingsPayload != nil
                // The welcome carries the first full status snapshot; a later `status` also counts.
                if st != nil { gotStatus = true; finish() }
            case .status(let st):
                statusState = st.state; gotStatus = true; finish()
            default: break
            }
        }
        link.connect(LaunchRequest(port: port, code: nil, dataDir: dataDir))
        let timedOut = done.wait(timeout: .now() + timeout) == .timedOut
        link.close()
        Thread.sleep(forTimeInterval: 0.2)  // let the close frame go out
        lock.lock(); defer { lock.unlock() }
        out["ok"] = .bool(welcome && gotStatus && !timedOut)
        out["welcome"] = .bool(welcome)
        out["protocol"] = .number(Double(protocolVersion))
        out["status_state"] = statusState.map { .string($0) } ?? .null
        out["settings"] = .bool(settings)
        out["states"] = .array(states.map { .string($0) })
        let c = link.counters
        out["connects"] = .number(Double(c.connects))
        if timedOut { out["error"] = "timeout" }
        return out
    }

    public static func json(_ o: [String: JSONValue]) -> String {
        let enc = JSONEncoder(); enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? String(data: enc.encode(JSONValue.object(o)), encoding: .utf8)) ?? "{\"ok\":false}"
    }
}
