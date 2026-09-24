// Minimal RFC 6455 WebSocket server over node:http `upgrade` (docs/NATIVE.md §1).
// Zero dependencies. Server frames are never masked; client frames must be
// masked (RFC 6455 §5.1: an unmasked client frame is a protocol error, 1002).
// Handles text, binary, fragmentation (continuation), ping/pong and close, and
// rejects any message over `maxBytes` with close 1009.
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";

export const OP = Object.freeze({ CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa });
const DEFAULT_MAX = 1 << 20;
/** How long a close handshake may take before the socket is destroyed. */
const CLOSE_WAIT_MS = 1000;

export function acceptKey(key) {
  // Sec-WebSocket-Accept per RFC 6455 §4.2.2 (implemented: trivial and pinned).
  return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

/** One server frame (FIN set unless `fin` is false; never masked). */
export function encodeServerFrame(opcode, payload = Buffer.alloc(0), fin = true) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const n = body.length;
  let head;
  if (n < 126) {
    head = Buffer.allocUnsafe(2);
    head[1] = n;
  } else if (n < 65536) {
    head = Buffer.allocUnsafe(4);
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.allocUnsafe(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  head[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  return Buffer.concat([head, body]);
}

/** Close frame payload: u16 code + UTF-8 reason (truncated to fit 125 bytes). */
export function closePayload(code, reason = "") {
  if (!code) return Buffer.alloc(0);
  const r = Buffer.from(String(reason || ""), "utf8").subarray(0, 123);
  const b = Buffer.allocUnsafe(2 + r.length);
  b.writeUInt16BE(code, 0);
  r.copy(b, 2);
  return b;
}

/**
 * Incremental parser for client frames. push(chunk) returns nothing; results
 * go to the callbacks:
 *   onMessage(opcode TEXT|BINARY, Buffer)   a whole (reassembled) message
 *   onControl(opcode CLOSE|PING|PONG, Buffer)
 *   onError(code, reason)                   protocol violation; stop reading
 * `requireMask` (default true) enforces masked client frames.
 */
export function createFrameParser({ maxBytes = DEFAULT_MAX, requireMask = true, onMessage = () => {}, onControl = () => {}, onError = () => {} } = {}) {
  let buf = Buffer.alloc(0);
  let frag = null; // {opcode, parts, size}
  let dead = false;
  const fail = (code, reason) => { dead = true; buf = Buffer.alloc(0); frag = null; onError(code, reason); };

  function step() {
    if (buf.length < 2) return false;
    const b0 = buf[0], b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    if (b0 & 0x70) { fail(1002, "reserved bits set"); return false; }
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return false;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return false;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(maxBytes)) { fail(1009, "message too big"); return false; }
      len = Number(big);
      off = 10;
    }
    const control = opcode >= 0x8;
    if (control && (len > 125 || !fin)) { fail(1002, "bad control frame"); return false; }
    if (!control && len > maxBytes) { fail(1009, "message too big"); return false; }
    if (requireMask && !masked) { fail(1002, "client frame not masked"); return false; }
    const maskLen = masked ? 4 : 0;
    if (buf.length < off + maskLen + len) return false;
    let payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
    if (masked) {
      const m = buf.subarray(off, off + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
    }
    buf = buf.subarray(off + maskLen + len);

    if (control) {
      if (![OP.CLOSE, OP.PING, OP.PONG].includes(opcode)) { fail(1002, "unknown opcode"); return false; }
      onControl(opcode, payload);
      return !dead;
    }
    if (opcode === OP.CONT) {
      if (!frag) { fail(1002, "unexpected continuation"); return false; }
      frag.size += payload.length;
      if (frag.size > maxBytes) { fail(1009, "message too big"); return false; }
      frag.parts.push(payload);
      if (fin) {
        const { opcode: op, parts } = frag;
        frag = null;
        onMessage(op, Buffer.concat(parts));
      }
      return !dead;
    }
    if (opcode !== OP.TEXT && opcode !== OP.BINARY) { fail(1002, "unknown opcode"); return false; }
    if (frag) { fail(1002, "interleaved data frame"); return false; }
    if (!fin) { frag = { opcode, parts: [payload], size: payload.length }; return true; }
    onMessage(opcode, payload);
    return !dead;
  }

  return {
    push(chunk) {
      if (dead || !chunk || !chunk.length) return;
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      while (!dead && step()) { /* next frame */ }
    },
  };
}

/**
 * WsConnection (EventEmitter): events "text"(string), "binary"(Buffer),
 * "ping"(Buffer), "pong"(Buffer), "close"({code, reason}), "error"(Error).
 * Methods sendText(str), sendBinary(buf), ping(data), close(code, reason),
 * get bufferedAmount (bytes queued in the socket, for backpressure).
 */
export class WsConnection extends EventEmitter {
  constructor(socket, { maxBytes = DEFAULT_MAX, protocol = null, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout } = {}) {
    super();
    this.socket = socket;
    this.protocol = protocol;
    this.readyState = 1; // OPEN
    this.closeSent = false;
    this.closed = false;
    this._st = st;
    this._ct = ct;
    this._closeTimer = null;
    this.parser = createFrameParser({
      maxBytes,
      onMessage: (op, data) => {
        if (this.closeSent) return; // RFC: ignore data after we started closing
        if (op === OP.TEXT) this.emit("text", data.toString("utf8"));
        else this.emit("binary", data);
      },
      onControl: (op, data) => {
        if (op === OP.PING) { this._write(encodeServerFrame(OP.PONG, data)); this.emit("ping", data); }
        else if (op === OP.PONG) this.emit("pong", data);
        else this._onPeerClose(data);
      },
      onError: (code, reason) => this.close(code, reason),
    });
    socket.setNoDelay?.(true);
    socket.on("data", (c) => this.parser.push(c));
    socket.on("error", (e) => this.emit("error", e));
    socket.on("close", () => this._finish(1006, ""));
    socket.on("end", () => { try { socket.end(); } catch { /* ignore */ } });
  }

  get bufferedAmount() { return this.socket.writableLength || 0; }

  _write(buf) {
    if (this.closed || this.socket.destroyed) return false;
    try { this.socket.write(buf); return true; } catch { return false; }
  }

  sendText(s) { if (this.readyState === 1) this._write(encodeServerFrame(OP.TEXT, Buffer.from(String(s), "utf8"))); }
  sendBinary(b) { if (this.readyState === 1) this._write(encodeServerFrame(OP.BINARY, b)); }
  ping(data = Buffer.alloc(0)) { if (this.readyState === 1) this._write(encodeServerFrame(OP.PING, data)); }

  /** Start the close handshake; the socket is destroyed after the peer answers (or 1 s). */
  close(code = 1000, reason = "") {
    if (this.closed) return;
    if (!this.closeSent) {
      this.closeSent = true;
      this.readyState = 2; // CLOSING
      this._closeInfo = { code, reason: String(reason || "") };
      this._write(encodeServerFrame(OP.CLOSE, closePayload(code, reason)));
      this._closeTimer = this._st(() => { try { this.socket.destroy(); } catch { /* ignore */ } }, CLOSE_WAIT_MS);
      this._closeTimer?.unref?.();
    }
  }

  _onPeerClose(data) {
    let code = 1005, reason = "";
    if (data.length >= 2) { code = data.readUInt16BE(0); reason = data.subarray(2).toString("utf8"); }
    if (!this.closeSent) {
      // Echo the peer's close (RFC 6455 §5.5.1), then end.
      this.closeSent = true;
      this.readyState = 2;
      this._closeInfo = { code, reason };
      this._write(encodeServerFrame(OP.CLOSE, closePayload(code === 1005 ? 1000 : code, "")));
    }
    try { this.socket.end(); } catch { /* ignore */ }
    this._finish(code, reason);
  }

  _finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    if (this._closeTimer) this._ct(this._closeTimer);
    const info = this._closeInfo && code === 1006 ? this._closeInfo : { code, reason };
    try { this.socket.destroy(); } catch { /* ignore */ }
    this.emit("close", info);
  }
}

/**
 * acceptUpgrade(req, socket, head, {protocol, maxBytes}) -> WsConnection | null
 * Writes the 101 response (Sec-WebSocket-Accept, echoing `protocol` when the
 * client offered it). Returns null (after writing a 400) on a bad handshake.
 * Auth and Host/Origin checks happen BEFORE this call (daemon/native.js).
 */
export function acceptUpgrade(req, socket, head, { protocol = null, maxBytes = DEFAULT_MAX, timers } = {}) {
  const key = req.headers["sec-websocket-key"];
  const upgrade = String(req.headers.upgrade || "").toLowerCase();
  const version = String(req.headers["sec-websocket-version"] || "");
  if (req.method !== "GET" || upgrade !== "websocket" || typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key) || version !== "13") {
    rejectUpgrade(socket, 400, "bad_handshake");
    return null;
  }
  const offered = String(req.headers["sec-websocket-protocol"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  const chosen = protocol && offered.includes(protocol) ? protocol : null;
  const lines = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
  ];
  if (chosen) lines.push(`Sec-WebSocket-Protocol: ${chosen}`);
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  const conn = new WsConnection(socket, { maxBytes, protocol: chosen, ...(timers || {}) });
  if (head && head.length) conn.parser.push(head);
  return conn;
}

/** Answer an upgrade request with a plain HTTP error and drop the socket. */
export function rejectUpgrade(socket, status, code) {
  const text = { 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 421: "Misdirected Request", 503: "Service Unavailable" }[status] || "Error";
  const body = JSON.stringify({ error: { code } });
  try {
    // end() flushes the response, then closes; destroy() would cut it off.
    socket.end(`HTTP/1.1 ${status} ${text}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n${body}`);
  } catch { try { socket.destroy(); } catch { /* ignore */ } }
}
