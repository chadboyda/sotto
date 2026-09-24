// An in-process mock daemon for LinkClient tests: loopback TCP (Network.framework)
// speaking just enough HTTP for /api/bootstrap and /api/voice-preview and a
// minimal RFC 6455 server for /api/native. It enforces the same Host / Origin /
// token rules as daemon/native.js (docs/NATIVE.md §1). No hardware, no internet.
import CryptoKit
import Foundation
import Network
@testable import SottoClient

final class MockDaemon: @unchecked Sendable {
    struct Upgrade { var headers: [String: String] }
    struct Bootstrap { var headers: [String: String] }

    let queue = DispatchQueue(label: "mock.daemon")
    private var listener: NWListener!
    private(set) var port: Int = 0
    private let lock = NSLock()

    // Config (set before or during a test; read on `queue`).
    var pageToken = "tok-" + UUID().uuidString
    var pageSecret = "sec-" + UUID().uuidString
    var launchCodes: Set<String> = []
    var autoWelcome = true
    var welcomeProtocol = 1
    var welcomeStatus: [String: Any] = ["state": "connecting", "live": NSNull()]
    var onCmd: ((_ id: String, _ name: String, _ args: [String: Any]) -> [String: Any]?)?
    var previewWav = Data("RIFFxxxxWAVE".utf8)

    // Records.
    private var _texts: [[String: Any]] = []
    private var _mic: [WireFrame] = []
    private var _upgrades: [Upgrade] = []
    private var _boots: [Bootstrap] = []
    private var _rejections: [String] = []
    private var conns: [Conn] = []

    var texts: [[String: Any]] { lock.lock(); defer { lock.unlock() }; return _texts }
    var mic: [WireFrame] { lock.lock(); defer { lock.unlock() }; return _mic }
    var upgrades: [Upgrade] { lock.lock(); defer { lock.unlock() }; return _upgrades }
    var boots: [Bootstrap] { lock.lock(); defer { lock.unlock() }; return _boots }
    var rejections: [String] { lock.lock(); defer { lock.unlock() }; return _rejections }
    func texts(ofType t: String) -> [[String: Any]] { texts.filter { $0["type"] as? String == t } }

    init() throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: 0)
        params.allowLocalEndpointReuse = true
        listener = try NWListener(using: params)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { s in if case .ready = s { ready.signal() } }
        listener.newConnectionHandler = { [weak self] c in self?.accept(c) }
        listener.start(queue: queue)
        _ = ready.wait(timeout: .now() + 5)
        port = Int(listener.port?.rawValue ?? 0)
    }

    func stop() {
        queue.sync {
            for c in conns { c.nw.cancel() }
            conns.removeAll()
            listener.cancel()
        }
    }

    // MARK: server -> client

    var hasClient: Bool { queue.sync { conns.contains { $0.ws && !$0.closed } } }

    func sendJSON(_ o: [String: Any]) {
        let d = try! JSONSerialization.data(withJSONObject: o)
        queue.async { for c in self.conns where c.ws && !c.closed { c.sendFrame(op: 1, payload: d) } }
    }

    func sendRaw(_ s: String) {
        queue.async { for c in self.conns where c.ws && !c.closed { c.sendFrame(op: 1, payload: Data(s.utf8)) } }
    }

    func sendSpeaker(_ f: WireFrame) {
        let d = f.encode()
        queue.async { for c in self.conns where c.ws && !c.closed { c.sendFrame(op: 2, payload: d) } }
    }

    func closeClient(code: UInt16, reason: String = "") {
        queue.async {
            for c in self.conns where c.ws && !c.closed {
                var p = Data([UInt8(code >> 8), UInt8(code & 0xff)]); p.append(Data(reason.utf8))
                c.sendFrame(op: 8, payload: p)
                c.closed = true
                self.queue.asyncAfter(deadline: .now() + 0.2) { c.nw.cancel() }
            }
        }
    }

    /// Drop the TCP connection with no close frame (crash / sleep).
    func killClient() {
        queue.async { for c in self.conns where c.ws { c.closed = true; c.nw.cancel() } }
    }

    // MARK: connections

    private func accept(_ nw: NWConnection) {
        let c = Conn(nw: nw, owner: self)
        conns.append(c)
        nw.start(queue: queue)
        c.read()
    }

    fileprivate func record(text: [String: Any]) { lock.lock(); _texts.append(text); lock.unlock() }
    fileprivate func record(mic f: WireFrame) { lock.lock(); _mic.append(f); lock.unlock() }
    fileprivate func reject(_ why: String) { lock.lock(); _rejections.append(why); lock.unlock() }

    fileprivate func handleHTTP(_ c: Conn, method: String, path: String, headers h: [String: String]) {
        let host = h["host"] ?? ""
        guard host == "127.0.0.1:\(port)" || host == "localhost:\(port)" else {
            reject("bad_host"); c.respond(421, json: ["error": ["code": "bad_host"]]); return
        }
        let url = URLComponents(string: "http://x\(path)")
        switch url?.path ?? "" {
        case "/api/bootstrap":
            lock.lock(); _boots.append(Bootstrap(headers: h)); lock.unlock()
            let boot = h["x-sotto-boot"], launch = h["x-sotto-launch"]
            var ok = boot == pageSecret || launch == pageSecret
            if let l = launch, launchCodes.remove(l) != nil { ok = true }
            guard ok else { reject("bad_secret"); c.respond(403, json: ["error": ["code": "bad_secret"]]); return }
            c.respond(200, json: ["page_token": pageToken, "page_secret": pageSecret, "version": "0.3.0",
                                  "build": "b1", "port": port, "status": welcomeStatus])
        case "/api/voice-preview":
            guard h["x-sotto-page"] == pageToken else { c.respond(403, json: ["error": ["code": "bad_token"]]); return }
            let voice = url?.queryItems?.first { $0.name == "voice" }?.value ?? ""
            if voice == "nope" { c.respond(400, json: ["error": ["code": "bad_voice", "message": "Unknown voice"]]); return }
            c.respond(200, body: previewWav, type: "audio/wav")
        case NativeProtocol.path:
            guard h["upgrade"]?.lowercased() == "websocket", let key = h["sec-websocket-key"] else {
                c.respond(400, json: [:]); return
            }
            if h["origin"] != nil { reject("bad_origin"); c.respond(403, json: ["error": ["code": "bad_origin"]]); return }
            guard h["x-sotto-page"] == pageToken else { reject("bad_token"); c.respond(403, json: ["error": ["code": "bad_token"]]); return }
            lock.lock(); _upgrades.append(Upgrade(headers: h)); lock.unlock()
            // One client: a new one replaces the old (4002).
            for o in conns where o !== c && o.ws && !o.closed {
                o.sendFrame(op: 8, payload: Data([0x0f, 0xa2]))
                o.closed = true
            }
            let accept = Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
            var resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n"
            if (h["sec-websocket-protocol"] ?? "").contains(NativeProtocol.subprotocol) {
                resp += "Sec-WebSocket-Protocol: \(NativeProtocol.subprotocol)\r\n"
            }
            resp += "\r\n"
            c.ws = true
            c.nw.send(content: Data(resp.utf8), completion: .idempotent)
        default:
            c.respond(404, json: [:])
        }
    }

    fileprivate func handleWS(_ c: Conn, op: UInt8, payload: Data) {
        switch op {
        case 1:
            guard let o = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any] else {
                c.closeWith(4004); return
            }
            record(text: o)
            let type = o["type"] as? String
            if type == "hello", autoWelcome {
                if (o["protocol"] as? Int) != 1 { c.closeWith(4001); return }
                let w: [String: Any] = ["type": "welcome", "protocol": welcomeProtocol, "version": "0.3.0", "build": "b1",
                                        "status": welcomeStatus,
                                        "settings": ["voices": ["voices": ["marin", "cedar"], "current": "marin", "live": false, "live_voice": NSNull()],
                                                     "window": "auto", "data_dir": "/tmp/x", "version": "0.3.0"]]
                c.sendFrame(op: 1, payload: try! JSONSerialization.data(withJSONObject: w))
            } else if type == "cmd", let id = o["id"] as? String, let name = o["name"] as? String {
                if let r = onCmd?(id, name, o["args"] as? [String: Any] ?? [:]) {
                    c.sendFrame(op: 1, payload: try! JSONSerialization.data(withJSONObject: r))
                }
            }
        case 2:
            guard let f = WireFrame.decode(payload), f.kind == .mic, f.pcm.count == NativeProtocol.frameBytes else {
                c.closeWith(4004); return
            }
            record(mic: f)
        case 8:
            if !c.closed { c.sendFrame(op: 8, payload: payload.prefix(2)); c.closed = true }
            c.nw.cancel()
        case 9:
            c.sendFrame(op: 10, payload: payload)
        default:
            break
        }
    }
}

private final class Conn {
    let nw: NWConnection
    weak var owner: MockDaemon?
    var buf = Data()
    var ws = false
    var closed = false
    var headerDone = false

    init(nw: NWConnection, owner: MockDaemon) { self.nw = nw; self.owner = owner }

    func read() {
        nw.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, done, err in
            guard let self else { return }
            if let data { self.buf.append(data); self.process() }
            if done || err != nil { self.closed = true; return }
            self.read()
        }
    }

    private func process() {
        if !headerDone {
            guard let r = buf.range(of: Data("\r\n\r\n".utf8)) else { return }
            let head = String(decoding: buf[buf.startIndex..<r.lowerBound], as: UTF8.self)
            buf = Data(buf[r.upperBound...])
            headerDone = true
            var lines = head.components(separatedBy: "\r\n")
            let first = lines.removeFirst().split(separator: " ")
            var h: [String: String] = [:]
            for l in lines {
                guard let i = l.firstIndex(of: ":") else { continue }
                h[l[..<i].lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)
            }
            owner?.handleHTTP(self, method: String(first.first ?? ""), path: first.count > 1 ? String(first[1]) : "/", headers: h)
        }
        while ws, let (op, payload, used) = parseFrame(buf) {
            buf = Data(buf.dropFirst(used))
            owner?.handleWS(self, op: op, payload: payload)
        }
    }

    /// Client frames are masked. No fragmentation from URLSession at these sizes.
    private func parseFrame(_ d: Data) -> (UInt8, Data, Int)? {
        let b = [UInt8](d)
        guard b.count >= 2 else { return nil }
        let op = b[0] & 0x0f
        let masked = b[1] & 0x80 != 0
        var len = Int(b[1] & 0x7f)
        var i = 2
        if len == 126 { guard b.count >= 4 else { return nil }; len = Int(b[2]) << 8 | Int(b[3]); i = 4 }
        else if len == 127 {
            guard b.count >= 10 else { return nil }
            len = 0; for k in 0..<8 { len = len << 8 | Int(b[2 + k]) }; i = 10
        }
        var mask: [UInt8] = [0, 0, 0, 0]
        if masked { guard b.count >= i + 4 else { return nil }; mask = Array(b[i..<i + 4]); i += 4 }
        guard b.count >= i + len else { return nil }
        var p = Array(b[i..<i + len])
        if masked { for k in 0..<p.count { p[k] ^= mask[k % 4] } }
        return (op, Data(p), i + len)
    }

    func sendFrame(op: UInt8, payload: Data) {
        var f = Data([0x80 | op])
        if payload.count < 126 { f.append(UInt8(payload.count)) }
        else if payload.count < 65536 { f.append(126); f.append(UInt8(payload.count >> 8)); f.append(UInt8(payload.count & 0xff)) }
        else { f.append(127); for k in (0..<8).reversed() { f.append(UInt8((payload.count >> (8 * k)) & 0xff)) } }
        f.append(payload)
        nw.send(content: f, completion: .idempotent)
    }

    func closeWith(_ code: UInt16) {
        sendFrame(op: 8, payload: Data([UInt8(code >> 8), UInt8(code & 0xff)]))
        closed = true
        let n = nw
        owner?.queue.asyncAfter(deadline: .now() + 0.2) { n.cancel() }
    }

    func respond(_ status: Int, json: [String: Any]) {
        respond(status, body: try! JSONSerialization.data(withJSONObject: json), type: "application/json")
    }

    func respond(_ status: Int, body: Data, type: String) {
        let r = "HTTP/1.1 \(status) X\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        var d = Data(r.utf8); d.append(body)
        nw.send(content: d, completion: .contentProcessed { [nw] _ in nw.cancel() })
    }
}
