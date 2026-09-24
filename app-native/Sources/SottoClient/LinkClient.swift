// LinkClient: the DaemonLink over URLSessionWebSocketTask (docs/NATIVE.md §1, §5.2).
//
// Threading: all link state lives on one serial queue (`queue`). onState and
// onMessage are delivered on `config.callbackQueue` (main by default);
// onSpeakerFrame and message taps run synchronously on the link queue, in
// socket order, so an `audio_flush` is always seen before the frames that
// follow it (AudioPump relies on this).
import Foundation

public final class LinkClient: NSObject, DaemonLink, @unchecked Sendable {
    public struct Config: @unchecked Sendable {
        public var version: String
        public var build: String?
        public var test: Bool
        public var policy: ReconnectPolicy = .standard
        /// No `welcome` this long after the socket was created: close and retry.
        public var welcomeTimeout: Double = 5
        /// Nothing at all from the daemon this long (it pings every 5 s): the link is dead.
        public var silenceTimeout: Double = 15
        public var commandTimeout: Double = 15
        /// Unsent mic frames kept; past this the oldest is dropped (counted).
        public var micQueueCap: Int = 10
        public var micInFlight: Int = 4
        public var callbackQueue: DispatchQueue = .main
        /// Host for bootstrap + socket. Always loopback; overridable only for tests of the Host rule.
        public var host: String = "127.0.0.1"
        public init(version: String, build: String?, test: Bool) { self.version = version; self.build = build; self.test = test }
    }

    public struct Counters: Equatable, Sendable {
        public var micSent = 0, micDropped = 0, micNotConnected = 0, speakerFrames = 0, badFrames = 0
        public var connects = 0, retries = 0, lastRttMs: Double? = nil
    }

    // DaemonLink
    public var onState: ((LinkState) -> Void)?
    public var onMessage: ((ServerMessage) -> Void)?
    public var onSpeakerFrame: ((WireFrame) -> Void)?
    /// Debug log lines (event name + fields). Never carries a token, secret or key.
    public var onLog: ((String, [String: String]) -> Void)?

    public let config: Config
    public let queue = DispatchQueue(label: "sotto.link", qos: .userInteractive)

    // Link-queue state.
    private var launch: LaunchRequest?
    private var port = 0
    private var launchCode: String?
    private var pageSecret: String?
    private var pageToken: String?
    private var generation = 0
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var welcomed = false
    private var attempt = 0
    private var lostAt: Date?
    private var lastRx = Date()
    private var welcomeTimer: DispatchWorkItem?
    private var livenessTimer: DispatchSourceTimer?
    private var micQueue: [Data] = []
    private var micInFlight = 0
    private var pending: [String: (DispatchWorkItem, (Result<JSONValue, CommandFailure>) -> Void)] = [:]
    private var taps: [(ServerMessage) -> Void] = []
    private var stateTaps: [(LinkState) -> Void] = []
    private var _state: LinkState = .idle
    private var _counters = Counters()
    private var _welcome: ServerMessage?
    private var lastCloseCode: Int?

    public init(config: Config) {
        self.config = config
        super.init()
    }

    deinit { session?.invalidateAndCancel() }

    // MARK: public surface

    public var state: LinkState { queue.sync { _state } }
    public var counters: Counters { queue.sync { _counters } }
    public var isConnected: Bool { queue.sync { welcomed } }
    /// The last `welcome` of the current connection.
    public var welcome: ServerMessage? { queue.sync { _welcome } }
    public var currentPort: Int { queue.sync { port } }

    /// Run `tap` on the link queue for every message, before onMessage (in socket order).
    public func addMessageTap(_ tap: @escaping (ServerMessage) -> Void) { queue.async { self.taps.append(tap) } }
    /// Run `tap` on the link queue for every state change.
    public func addStateTap(_ tap: @escaping (LinkState) -> Void) { queue.async { self.stateTaps.append(tap) } }

    public func connect(_ launch: LaunchRequest) {
        queue.async {
            // Already connected to this daemon: any web page can fire a
            // sotto://open with a made-up code, so prove the new code before
            // dropping a working link (a refused code leaves it alone).
            if self.welcomed, self.task != nil, launch.port == self.port, let code = launch.code {
                self.verifyThenReconnect(launch, code: code)
                return
            }
            self.reset(launch)
            self.startAttempt()
        }
    }

    private func reset(_ launch: LaunchRequest) {
        teardown(code: .normalClosure)
        generation += 1
        self.launch = launch
        port = launch.port
        launchCode = launch.code
        attempt = 0
        lostAt = nil
        log("link.connect", ["port": "\(launch.port)", "code": launch.code == nil ? "no" : "yes",
                             "data": launch.dataDir == nil ? "no" : "yes"])
    }

    private func verifyThenReconnect(_ launch: LaunchRequest, code: String) {
        let gen = generation
        let s = Bootstrap.makeSession()
        var req = Bootstrap.request(port: launch.port, credential: .launchCode(code))
        if config.host != "127.0.0.1" { req.url = URL(string: "http://\(config.host):\(launch.port)/api/bootstrap") }
        s.dataTask(with: req) { [weak self] data, resp, err in
            let result: Result<BootstrapResult, BootstrapError>
            if let err { result = .failure(.unreachable((err as NSError).localizedDescription)) }
            else if let http = resp as? HTTPURLResponse { result = Bootstrap.parse(status: http.statusCode, body: data ?? Data()) }
            else { result = .failure(.badResponse) }
            self?.queue.async {
                guard let self, gen == self.generation else { return }
                guard case .success = result else {
                    if case .failure(let e) = result { self.log("link.launch_ignored", ["error": e.code]) }
                    return
                }
                var l = launch
                l.code = nil  // spent
                self.reset(l)
                self.bootstrapped(result, gen: self.generation, usedMemorySecret: false, usedCode: false)
            }
        }.resume()
        s.finishTasksAndInvalidate()
    }

    public func send(_ message: ClientMessage) {
        queue.async { self.sendText(message) }
    }

    public func sendMicFrame(_ frame: WireFrame) {
        let data = frame.encode()
        queue.async {
            guard self.welcomed, self.task != nil else { self._counters.micNotConnected += 1; return }
            self.micQueue.append(data)
            if self.micQueue.count > self.config.micQueueCap {
                self.micQueue.removeFirst(self.micQueue.count - self.config.micQueueCap)
                self._counters.micDropped += 1
            }
            self.pumpMic()
        }
    }

    /// `cmd` with one `result` (docs/NATIVE.md §3.3). Completion on the callback queue.
    public func command(_ name: String, args: [String: JSONValue] = [:],
                        completion: @escaping (Result<JSONValue, CommandFailure>) -> Void) {
        let id = UUID().uuidString.lowercased()
        let cbq = config.callbackQueue
        let done: (Result<JSONValue, CommandFailure>) -> Void = { r in cbq.async { completion(r) } }
        queue.async {
            guard self.welcomed, self.task != nil else {
                done(.failure(CommandFailure(code: "not_connected", message: "Sotto is not connected to its daemon.")))
                return
            }
            let timer = DispatchWorkItem { [weak self] in
                guard let self, let p = self.pending.removeValue(forKey: id) else { return }
                p.1(.failure(CommandFailure(code: "timeout", message: "The daemon did not answer in time.")))
            }
            self.pending[id] = (timer, done)
            self.queue.asyncAfter(deadline: .now() + self.config.commandTimeout, execute: timer)
            self.sendText(.cmd(id: id, name: name, args: args))
        }
    }

    public func command(_ name: String, args: [String: JSONValue] = [:]) async -> Result<JSONValue, CommandFailure> {
        await withCheckedContinuation { cont in command(name, args: args) { cont.resume(returning: $0) } }
    }

    public func fetchVoicePreview(_ voice: String) async throws -> Data {
        try await fetchVoicePreview(voice, cachedOnly: false)
    }

    /// GET /api/voice-preview?voice=<v>[&cached=1] with the page token.
    public func fetchVoicePreview(_ voice: String, cachedOnly: Bool) async throws -> Data {
        let (port, token, host) = queue.sync { (self.port, self.pageToken, self.config.host) }
        guard let token else { throw CommandFailure(code: "not_connected", message: "Sotto is not connected to its daemon.") }
        var comps = URLComponents()
        comps.scheme = "http"; comps.host = host; comps.port = port; comps.path = "/api/voice-preview"
        comps.queryItems = [URLQueryItem(name: "voice", value: voice)] + (cachedOnly ? [URLQueryItem(name: "cached", value: "1")] : [])
        var r = URLRequest(url: comps.url!)
        r.setValue(token, forHTTPHeaderField: "X-Sotto-Page")
        r.timeoutInterval = 30
        let s = Bootstrap.makeSession()
        defer { s.finishTasksAndInvalidate() }
        let (data, resp) = try await s.data(for: r)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if status == 200 { return data }
        let e = (try? JSONDecoder().decode(JSONValue.self, from: data))?["error"]
        throw CommandFailure(code: e?["code"]?.stringValue ?? "http_\(status)",
                             message: e?["message"]?.stringValue ?? "The voice sample failed.")
    }

    public func close() {
        queue.async {
            self.generation += 1
            self.teardown(code: .normalClosure)
            self.launch = nil
            self.setState(.idle)
        }
    }

    // Link-queue-only helpers (AudioPump runs its taps and timers on `queue`).
    var isConnectedOnQueue: Bool { welcomed && task != nil }
    func sendOnQueue(_ m: ClientMessage) { sendText(m) }

    // MARK: attempts

    private func startAttempt() {
        guard let launch else { return }
        // A restarted daemon may be on another port: follow daemon.port when it is trusted.
        if let p = DataDirTrust.recordedPort(dataDir: launch.dataDir), p != port, launchCode == nil {
            log("link.port_moved", ["from": "\(port)", "to": "\(p)"])
            port = p
        }
        // Credentials go only to the port this user's daemon records right now:
        // after the daemon exits (daemon.port removed) or moves, whatever
        // listens on the old port next (any local process, any user) must not
        // be handed the page secret.
        if launch.dataDir != nil, DataDirTrust.recordedPort(dataDir: launch.dataDir) != port {
            log("link.daemon_gone", ["port": "\(port)"])
            scheduleRetry(reason: "daemon_gone")
            return
        }
        let cred: BootCredential
        var usedMemorySecret = false
        let usedCode = launchCode != nil
        if let k = launchCode {
            // One-time; kept until the daemon answers (it may not listen yet).
            cred = .launchCode(k)
        } else if let s = pageSecret {
            cred = .pageSecret(s); usedMemorySecret = true
        } else if let s = DataDirTrust.pageSecret(dataDir: launch.dataDir) {
            cred = .pageSecret(s)
        } else {
            log("link.no_credential", [:])
            scheduleRetry(reason: "no_credential")
            return
        }
        setState(.bootstrapping)
        let gen = generation
        let port = self.port
        var req = Bootstrap.request(port: port, credential: cred)
        if config.host != "127.0.0.1" { req.url = URL(string: "http://\(config.host):\(port)/api/bootstrap") }
        let s = Bootstrap.makeSession()
        s.dataTask(with: req) { [weak self] data, resp, err in
            let result: Result<BootstrapResult, BootstrapError>
            if let err { result = .failure(.unreachable((err as NSError).localizedDescription)) }
            else if let http = resp as? HTTPURLResponse { result = Bootstrap.parse(status: http.statusCode, body: data ?? Data()) }
            else { result = .failure(.badResponse) }
            self?.queue.async { self?.bootstrapped(result, gen: gen, usedMemorySecret: usedMemorySecret, usedCode: usedCode) }
        }.resume()
        s.finishTasksAndInvalidate()
    }

    private func bootstrapped(_ result: Result<BootstrapResult, BootstrapError>, gen: Int, usedMemorySecret: Bool, usedCode: Bool) {
        guard gen == generation else { return }
        if usedCode {
            if case .failure(.unreachable) = result {} else { launchCode = nil }  // the daemon answered: spent
            // A refused launch code is final: never fall back to page.secret for
            // it, or a web page's sotto://open with a made-up code would attach
            // the app (and take the voice) without the daemon asking for it.
            if case .failure(.refused) = result {
                log("link.bootstrap", ["ok": "false", "error": "launch_refused"])
                setState(.failed("launch_refused"))
                return
            }
        }
        switch result {
        case .success(let b):
            pageToken = b.pageToken
            if let s = b.pageSecret, !s.isEmpty { pageSecret = s }
            log("link.bootstrap", ["ok": "true", "version": b.version ?? ""])
            openSocket()
        case .failure(let e):
            // 403: the secret is stale (the daemon restarted with a new one); re-read page.secret next time.
            if e == .refused, usedMemorySecret { pageSecret = nil }
            log("link.bootstrap", ["ok": "false", "error": e.code])
            scheduleRetry(reason: e.code)
        }
    }

    private func openSocket() {
        guard let token = pageToken else { scheduleRetry(reason: "no_token"); return }
        setState(.connecting)
        var r = URLRequest(url: URL(string: "ws://\(config.host):\(port)\(NativeProtocol.path)")!)
        r.setValue(token, forHTTPHeaderField: "X-Sotto-Page")
        r.setValue(NativeProtocol.subprotocol, forHTTPHeaderField: "Sec-WebSocket-Protocol")
        r.timeoutInterval = 10
        let c = URLSessionConfiguration.ephemeral
        c.connectionProxyDictionary = [:]
        c.httpCookieStorage = nil
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        let s = URLSession(configuration: c, delegate: DelegateProxy(self), delegateQueue: delegateQueue)
        let t = s.webSocketTask(with: r)
        t.maximumMessageSize = NativeProtocol.maxMessageBytes
        session = s
        task = t
        welcomed = false
        lastRx = Date()
        micQueue.removeAll()
        micInFlight = 0
        t.resume()
        // The daemon waits for hello first (≤ 5 s); URLSession queues it until the upgrade completes.
        sendText(.hello(version: config.version, build: config.build, test: config.test), force: true)
        receive(on: t)
        let gen = generation
        let w = DispatchWorkItem { [weak self] in
            guard let self, gen == self.generation, self.task === t, !self.welcomed else { return }
            self.log("link.welcome_timeout", [:])
            self.closed(task: t, code: 4003, reason: "welcome_timeout")
        }
        welcomeTimer = w
        queue.asyncAfter(deadline: .now() + config.welcomeTimeout, execute: w)
        startLiveness(for: t)
    }

    private func startLiveness(for t: URLSessionWebSocketTask) {
        livenessTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        let period = max(0.05, min(1, config.silenceTimeout / 5))
        timer.schedule(deadline: .now() + period, repeating: period)
        timer.setEventHandler { [weak self] in
            guard let self, self.task === t, self.welcomed else { return }
            if Date().timeIntervalSince(self.lastRx) > self.config.silenceTimeout {
                self.log("link.silent", [:])
                self.closed(task: t, code: 1001, reason: "daemon_silent")
            }
        }
        timer.resume()
        livenessTimer = timer
    }

    private func receive(on t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self else { return }
            self.queue.async {
                guard self.task === t else { return }
                switch result {
                case .success(let m):
                    self.lastRx = Date()
                    switch m {
                    case .string(let s): self.handleText(s, task: t)
                    case .data(let d): self.handleBinary(d)
                    @unknown default: break
                    }
                    if self.task === t { self.receive(on: t) }
                case .failure(let err):
                    let code = t.closeCode.rawValue
                    let reason = t.closeReason.flatMap { String(data: $0, encoding: .utf8) }
                    let http = (t.response as? HTTPURLResponse)?.statusCode
                    if code != 0 || http != nil && http != 101 {
                        self.closed(task: t, code: code == 0 ? 1006 : code,
                                    reason: reason ?? (http.map { "http_\($0)" } ?? (err as NSError).localizedDescription))
                    } else {
                        // The close code usually lands with the delegate callback just after this
                        // failure; wait for it (4001/4002 must not be retried), with a fallback.
                        let msg = (err as NSError).localizedDescription
                        self.queue.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                            guard let self, self.task === t else { return }
                            let c = t.closeCode.rawValue
                            self.closed(task: t, code: c == 0 ? 1006 : c, reason: msg)
                        }
                    }
                }
            }
        }
    }

    private func handleText(_ s: String, task t: URLSessionWebSocketTask) {
        let msg = ServerMessage.decode(s)
        switch msg {
        case .welcome(let p, _, _, _):
            guard p == NativeProtocol.version else {
                log("link.protocol_mismatch", ["daemon": "\(p)"])
                closed(task: t, code: 4001, reason: "protocol_mismatch")
                return
            }
            welcomed = true
            _welcome = msg
            welcomeTimer?.cancel()
            attempt = 0
            lostAt = nil
            _counters.connects += 1
            log("link.welcome", ["version": ServerMessageField.version(msg)])
            setState(.connected)
        case .ping(let t):
            sendText(.pong(t: t))
        case .result(let r):
            if let p = pending.removeValue(forKey: r.id) {
                p.0.cancel()
                p.1(r.ok ? .success(r.data ?? .object([:])) : .failure(r.error ?? CommandFailure(code: "error", message: "The command failed.")))
            }
        default:
            break
        }
        guard welcomed else { return }  // nothing is valid before welcome
        for tap in taps { tap(msg) }
        if let cb = onMessage { config.callbackQueue.async { cb(msg) } }
    }

    private func handleBinary(_ d: Data) {
        guard welcomed, let f = WireFrame.decode(d), f.kind == .speaker else { _counters.badFrames += 1; return }
        _counters.speakerFrames += 1
        onSpeakerFrame?(f)
    }

    fileprivate func delegateClosed(task t: URLSessionTask, code: Int, reason: String?) {
        queue.async {
            guard let ws = t as? URLSessionWebSocketTask, ws === self.task else { return }
            self.closed(task: ws, code: code, reason: reason ?? "")
        }
    }

    fileprivate func delegateCompleted(task t: URLSessionTask, error: Error?) {
        queue.async {
            guard let ws = t as? URLSessionWebSocketTask, ws === self.task else { return }
            let http = (t.response as? HTTPURLResponse)?.statusCode
            if http == 403 { self.pageToken = nil }  // stale token: the next attempt re-bootstraps anyway
            let code = ws.closeCode.rawValue
            self.closed(task: ws, code: code == 0 ? 1006 : code,
                        reason: http.map { "http_\($0)" } ?? (error.map { ($0 as NSError).localizedDescription } ?? "completed"))
        }
    }

    /// The current socket ended (any cause). Runs once per socket.
    private func closed(task t: URLSessionWebSocketTask, code: Int, reason: String) {
        guard task === t else { return }
        log("link.closed", ["code": "\(code)", "reason": reason])
        lastCloseCode = code
        teardown(code: code >= 4000 ? .normalClosure : .goingAway)
        switch code {
        case 4001: setState(.failed("protocol_mismatch"))
        case 4002: setState(.failed("replaced"))
        default: scheduleRetry(reason: "closed_\(code)")
        }
    }

    private func teardown(code: URLSessionWebSocketTask.CloseCode) {
        welcomeTimer?.cancel(); welcomeTimer = nil
        livenessTimer?.cancel(); livenessTimer = nil
        if let t = task { task = nil; t.cancel(with: code, reason: nil) }
        session?.invalidateAndCancel(); session = nil
        welcomed = false
        _welcome = nil
        micQueue.removeAll()
        micInFlight = 0
        let failed = pending
        pending.removeAll()
        for (_, p) in failed {
            p.0.cancel()
            p.1(.failure(CommandFailure(code: "link_lost", message: "The connection to the daemon dropped.")))
        }
    }

    private func scheduleRetry(reason: String) {
        if lostAt == nil { lostAt = Date() }
        let elapsed = Date().timeIntervalSince(lostAt!)
        guard let d = config.policy.delay(attempt: attempt, elapsed: elapsed) else {
            log("link.give_up", ["reason": reason])
            setState(.failed("unreachable"))
            return
        }
        attempt += 1
        _counters.retries += 1
        setState(.backoff(seconds: d))
        let gen = generation
        queue.asyncAfter(deadline: .now() + d) { [weak self] in
            guard let self, gen == self.generation, self.task == nil else { return }
            self.startAttempt()
        }
    }

    // MARK: sending

    private func sendText(_ m: ClientMessage, force: Bool = false) {
        guard let t = task, welcomed || force else {
            if case .cmd = m {} else { log("link.send_dropped", ["type": m.type]) }
            return
        }
        t.send(.string(m.encode())) { [weak self] err in
            if let err { self?.queue.async { self?.log("link.send_error", ["type": m.type, "error": (err as NSError).localizedDescription]) } }
        }
    }

    private func pumpMic() {
        guard let t = task else { return }
        while micInFlight < config.micInFlight, !micQueue.isEmpty {
            let d = micQueue.removeFirst()
            micInFlight += 1
            _counters.micSent += 1
            t.send(.data(d)) { [weak self] _ in
                self?.queue.async {
                    guard let self, self.task === t else { return }
                    self.micInFlight -= 1
                    self.pumpMic()
                }
            }
        }
    }

    private func setState(_ s: LinkState) {
        guard s != _state else { return }
        _state = s
        for tap in stateTaps { tap(s) }
        if let cb = onState { config.callbackQueue.async { cb(s) } }
    }

    private func log(_ ev: String, _ fields: [String: String]) {
        if let l = onLog { l(ev, fields) }
    }
}

private enum ServerMessageField {
    static func version(_ m: ServerMessage) -> String {
        if case .welcome(_, let v, _, _) = m { return v }
        return ""
    }
}

/// URLSession retains its delegate; the proxy holds the client weakly so the client can be freed.
private final class DelegateProxy: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    weak var client: LinkClient?
    init(_ c: LinkClient) { client = c }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        client?.delegateClosed(task: webSocketTask, code: closeCode.rawValue, reason: reason.flatMap { String(data: $0, encoding: .utf8) })
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        client?.delegateCompleted(task: task, error: error)
    }
}
