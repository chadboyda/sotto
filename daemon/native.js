// Native app endpoint: GET /api/native WebSocket upgrade (docs/NATIVE.md §1-§3).
//
// createNativeEndpoint({ port, pageToken, controller, log, clock })
//   -> { handleUpgrade(req, socket, head): boolean,  // true when it owned the request
//        get connected(): boolean,                   // a client finished hello
//        close(code?, reason?) }
// Checks, in order: path === NATIVE_PATH; Host is 127.0.0.1:<port> or
// localhost:<port> (else 421); Origin header ABSENT (else 403, any browser page
// sends one); X-Sotto-Page equals the page token (constant-time; else 403).
// Then acceptUpgrade(); first text message must be `hello` within 5 s
// (else close 4003); protocol mismatch -> `welcome` is not sent, close 4001.
// One client: a new authenticated hello replaces the old one (old gets
// close 4002 "replaced"). Everything after hello is handed to `controller`
// (daemon/native-session.js). Never logs binary payloads or `cmd` args.
import { timingSafeEqual } from "node:crypto";
import { acceptUpgrade, rejectUpgrade } from "./wsserver.js";
import {
  NATIVE_PATH, SUBPROTOCOL, PROTOCOL, CLOSE, KIND, FRAME_BYTES, MAX_MESSAGE_BYTES, CLIENT_TYPES,
  encodeFrame, decodeFrame,
} from "./native-proto.js";
import { truncate } from "./log.js";

export const HELLO_TIMEOUT_MS = 5000;
export const PING_MS = 5000;
export const PONG_TIMEOUT_MS = 15000;
/** Past this many bytes queued on the link, speaker frames are dropped (§2.4). */
export const SPEAKER_BACKPRESSURE_BYTES = 256 * 1024;

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const CLIENT = new Set(CLIENT_TYPES);
const nsNow = () => process.hrtime.bigint();

export function createNativeEndpoint({
  port, pageToken, controller, log, clock,
  helloTimeoutMs = HELLO_TIMEOUT_MS, pingMs = PING_MS, pongTimeoutMs = PONG_TIMEOUT_MS,
}) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  let current = null; // the attached link (after hello)
  let nextId = 0;
  let closedAll = false;
  const conns = new Set();
  const counters = { speaker_dropped: 0 };

  function handleUpgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, "http://127.0.0.1"); } catch { return false; }
    if (url.pathname !== NATIVE_PATH) return false;
    if (!hosts.has(String(req.headers.host || "").toLowerCase())) { log?.warn("native.reject", { code: "bad_host" }); rejectUpgrade(socket, 421, "bad_host"); return true; }
    if (req.headers.origin !== undefined) { log?.warn("native.reject", { code: "bad_origin" }); rejectUpgrade(socket, 403, "bad_origin"); return true; }
    if (!safeEqual(req.headers["x-sotto-page"], pageToken)) { log?.warn("native.reject", { code: "bad_token" }); rejectUpgrade(socket, 403, "bad_token"); return true; }
    if (closedAll) { rejectUpgrade(socket, 503, "daemon_exit"); return true; }
    const ws = acceptUpgrade(req, socket, head, { protocol: SUBPROTOCOL, maxBytes: MAX_MESSAGE_BYTES });
    if (!ws) return true;
    onConnection(ws);
    return true;
  }

  function onConnection(ws) {
    const id = ++nextId;
    conns.add(ws);
    let link = null; // set after hello
    let helloTimer = clock.setTimeout(() => {
      helloTimer = null;
      if (!link) { log?.warn("native.hello_timeout", { conn: id }); ws.close(CLOSE.HELLO_TIMEOUT, "hello_timeout"); }
    }, helloTimeoutMs);
    log?.info("native.connect", { conn: id });

    const bad = (why) => {
      log?.warn("native.bad_message", { conn: id, why });
      ws.close(CLOSE.BAD_MESSAGE, "bad_message");
    };

    ws.on("text", (s) => {
      let msg;
      try { msg = JSON.parse(s); } catch { return bad("json"); }
      if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.type !== "string") return bad("shape");
      if (!link) {
        if (msg.type !== "hello") return bad("expected_hello");
        if (helloTimer) { clock.clearTimeout(helloTimer); helloTimer = null; }
        if (msg.protocol !== PROTOCOL) {
          log?.warn("native.protocol_mismatch", { conn: id, protocol: typeof msg.protocol === "number" ? msg.protocol : null });
          ws.close(CLOSE.PROTOCOL_MISMATCH, "protocol_mismatch");
          return;
        }
        link = makeLink(ws, id, msg);
        attach(link);
        return;
      }
      if (link !== current) return; // replaced: a late message from the old client
      if (!CLIENT.has(msg.type) || msg.type === "hello") { log?.debug("native.unknown", { conn: id, type: truncate(msg.type, 40) }); return; }
      if (msg.type === "pong") link.lastPongAt = clock.now();
      try { controller.onMessage(link, msg); } catch (e) { log?.error("native.handler_error", { type: msg.type, message: String(e && e.message) }); }
    });

    ws.on("binary", (b) => {
      if (!link) return bad("audio_before_hello");
      if (link !== current) return;
      const f = decodeFrame(b);
      if (!f || f.kind !== KIND.MIC || f.pcm.length !== FRAME_BYTES) return bad("frame");
      link.micFrames++;
      try { controller.onMicFrame(link, f); } catch (e) { log?.error("native.handler_error", { type: "mic", message: String(e && e.message) }); }
    });

    ws.on("pong", () => { if (link) link.lastPongAt = clock.now(); });
    ws.on("error", (e) => log?.debug("native.socket_error", { conn: id, message: truncate(String(e && e.message), 200) }));
    ws.on("close", ({ code, reason }) => {
      conns.delete(ws);
      if (helloTimer) { clock.clearTimeout(helloTimer); helloTimer = null; }
      if (link) {
        if (link.pingTimer) clock.clearInterval(link.pingTimer);
        link.closed = true;
      }
      log?.info("native.close", { conn: id, code, reason: truncate(String(reason || ""), 60), attached: !!link && link === current });
      if (link && link === current) {
        current = null;
        try { controller.detach(link, { code, reason }); } catch (e) { log?.error("native.handler_error", { type: "detach", message: String(e && e.message) }); }
      }
    });
  }

  function makeLink(ws, id, hello) {
    let seq = 0;
    const link = {
      id,
      clientInfo: {
        version: typeof hello.version === "string" ? truncate(hello.version, 40) : null,
        build: typeof hello.build === "string" ? truncate(hello.build, 80) : null,
        test: hello.test === true,
        client: typeof hello.client === "string" ? truncate(hello.client, 20) : null,
        capabilities: Array.isArray(hello.capabilities) ? hello.capabilities.filter((c) => typeof c === "string").slice(0, 20) : [],
        audio: hello.audio && typeof hello.audio === "object" ? hello.audio : null,
      },
      closed: false,
      micFrames: 0,
      speakerFrames: 0,
      lastPongAt: clock.now(),
      pingTimer: null,
      sendJson(obj) {
        if (link.closed) return false;
        try { ws.sendText(JSON.stringify(obj)); return true; } catch { return false; }
      },
      /** One 960-byte speaker frame; dropped under backpressure (§2.4). */
      sendAudio(pcm, { flags = 0 } = {}) {
        if (link.closed) return false;
        if (ws.bufferedAmount > SPEAKER_BACKPRESSURE_BYTES) { counters.speaker_dropped++; return false; }
        ws.sendBinary(encodeFrame({ kind: KIND.SPEAKER, flags, seq: seq++, tsNs: nsNow(), pcm }));
        link.speakerFrames++;
        return true;
      },
      close(code = CLOSE.NORMAL, reason = "") { ws.close(code, reason); },
      get bufferedAmount() { return ws.bufferedAmount; },
    };
    return link;
  }

  function attach(link) {
    const old = current;
    current = link;
    if (old) {
      log?.info("native.replaced", { old: old.id, new: link.id });
      old.closed = true;
      if (old.pingTimer) clock.clearInterval(old.pingTimer);
      try { controller.detach(old, { code: CLOSE.REPLACED, reason: "replaced", replaced: true }); } catch (e) { log?.error("native.handler_error", { type: "detach", message: String(e && e.message) }); }
      // closed=true above: nothing else is sent on the old socket but its close.
      old.close(CLOSE.REPLACED, "replaced");
    }
    const ci = link.clientInfo;
    log?.info("native.hello", { conn: link.id, version: ci.version, build: ci.build, test: ci.test, client: ci.client });
    let welcome;
    try { welcome = controller.attach(link, ci); } catch (e) {
      log?.error("native.handler_error", { type: "attach", message: String(e && e.message) });
      current = null;
      link.close(1011, "internal");
      return;
    }
    link.sendJson({ type: "welcome", ...welcome });
    try { controller.afterWelcome?.(link); } catch (e) { log?.error("native.handler_error", { type: "after_welcome", message: String(e && e.message) }); }
    link.pingTimer = clock.setInterval(() => {
      if (link.closed) return;
      if (clock.now() - link.lastPongAt > pongTimeoutMs) {
        log?.warn("native.pong_timeout", { conn: link.id });
        link.close(CLOSE.GOING_AWAY, "pong_timeout");
        return;
      }
      link.sendJson({ type: "ping", t: clock.now() });
    }, pingMs);
  }

  return {
    handleUpgrade,
    get connected() { return !!current; },
    get link() { return current; },
    counters,
    /** Close every client (daemon exit / self-update handover: 4005, the app reconnects). */
    close(code = CLOSE.DAEMON_EXIT, reason = "daemon_exit") {
      closedAll = true;
      for (const ws of conns) { try { ws.close(code, reason); } catch { /* ignore */ } }
    },
  };
}
