// OpenAI Live API: WebRTC session creation (SDP proxy, SPEC §6.6) and the
// sideband WebSocket (SPEC §6.7).
import { EventEmitter } from "node:events";
import { LIVE_MODEL, MAX_APPEND_CHARS } from "./config.js";
import { truncate } from "./log.js";
import { estTokens } from "./speech.js";

/** The documented hard limit per append (our budget, MAX_APPEND_TOKENS, sits below it). */
const API_APPEND_TOKEN_LIMIT = 500;

export const DATA_CHANNEL_CONFIG = Object.freeze({
  allowed_client_events: ["session.input_audio.mute", "session.input_audio.unmute", "session.close"],
  allowed_server_events: [
    { type: "session.started" }, { type: "session.closed" },
    { type: "session.input_transcript.delta" }, { type: "session.output_transcript.delta" },
    { type: "session.input_audio.muted" }, { type: "session.input_audio.unmuted" },
    { type: "session.usage.updated" }, { type: "error" }, { type: "info" },
  ],
});

/** Build the POST /live/sessions body. Never includes audio.format or session.start. */
/** `seed`: one developer text, or [{role, text}] messages (prompt.js buildSeedInput). */
export function seedMessages(seed) {
  const list = Array.isArray(seed) ? seed : [{ role: "developer", text: seed }];
  // Assistant history uses output_text; developer and user messages input_text.
  return list.map((m) => ({ type: "message", role: m.role, content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.text }] }));
}

export function buildSessionBody({ instructions, seed, voice, sdp }) {
  return {
    session: {
      model: LIVE_MODEL,
      instructions,
      input: seedMessages(seed),
      audio: { output: { voice } },
      delegation: { type: "client" },
      store: false,
      client: { data_channel: structuredClone(DATA_CHANNEL_CONFIG) },
    },
    transport: { type: "webrtc", sdp },
  };
}

/**
 * POST the session to OpenAI. Returns
 *   {ok:true, id, sdp, ms}  or  {ok:false, httpStatus, code, message, ms}
 * where httpStatus/code follow SPEC §6.4 /api/session errors.
 * Error messages never contain the API key.
 */
export async function createLiveSession({ base, apiKey, body, fetchImpl = globalThis.fetch, clock, timeoutMs = 15000 }) {
  const t0 = clock.now();
  const ac = new AbortController();
  const timer = clock.setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/live/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const ms = clock.now() - t0;
    let text = "";
    try { text = await res.text(); } catch { /* ignore */ }
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    if (res.status >= 200 && res.status < 300) {
      const id = json?.session?.id;
      const sdp = json?.transport?.sdp;
      if (!id || !sdp) return { ok: false, httpStatus: 502, code: "openai_error", message: `OpenAI returned ${res.status} without a session id or SDP answer`, ms, status: res.status };
      return { ok: true, id, sdp, ms, status: res.status };
    }
    const apiMsg = json?.error?.message ? truncate(String(json.error.message), 300) : "";
    if (res.status === 401 || res.status === 403) return { ok: false, httpStatus: 502, code: "openai_auth", message: `OpenAI rejected the API key (${res.status})${apiMsg ? ": " + apiMsg : ""}`, ms, status: res.status };
    if (res.status === 429) return { ok: false, httpStatus: 502, code: "openai_rate_limit", message: `OpenAI rate limit (429)${apiMsg ? ": " + apiMsg : ""}`, ms, status: res.status };
    return { ok: false, httpStatus: 502, code: "openai_error", message: `OpenAI error ${res.status}${apiMsg ? ": " + apiMsg : ""}`, ms, status: res.status };
  } catch (e) {
    const ms = clock.now() - t0;
    if (ac.signal.aborted) return { ok: false, httpStatus: 504, code: "openai_timeout", message: `OpenAI did not answer within ${Math.round(timeoutMs / 1000)} s`, ms };
    return { ok: false, httpStatus: 502, code: "openai_error", message: `Could not reach OpenAI: ${truncate(String(e && e.message), 200)}`, ms };
  } finally {
    clock.clearTimeout(timer);
  }
}

const AUDIO_TYPES = new Set(["session.output_audio.delta", "session.input_audio.append"]);
const APPEND_KINDS = new Set(["instructions", "thinking", "commentary"]);
const READY_FALLBACK_MS = 1500;
const REATTACH_MS = 1000;
const MAX_QUEUED_THINKING = 50;

/**
 * Sideband connection to one Live session.
 *
 * Events:
 *   "open"                         socket open
 *   "ready"   {started:boolean, expires_at}
 *   "event"   parsed non-audio server event (every one)
 *   "ack"     {kind, event_id}
 *   "append_failed" {kind, event_id, error}
 *   "session_closed" {reason, seconds}   (server session.closed)
 *   "lost"                         unexpected close and the one re-attach failed
 *   "socket_closed" {code}
 */
export class Sideband extends EventEmitter {
  constructor({ id, url, apiKey, WebSocketImpl, clock, log, counters, debug = false }) {
    super();
    Object.assign(this, { id, url, clock, log, counters, debug });
    this._apiKey = apiKey; // memory only
    this.WS = WebSocketImpl;
    this.ws = null;
    this.state = "idle"; // idle | connecting | open | closed
    this.ready = false;
    this.readyTimer = null;
    this.seq = 0;
    this.pending = new Map(); // event_id → {type, kind, sent_at}
    this.queue = []; // events waiting for ready
    this.sawClosed = false; // server session.closed received
    this.closing = false; // we asked to close
    this.reattached = false;
    this.audioBytes = 0;
    this.lastOutputAudioAt = null; // wall time of the last output audio chunk
    this.expiresAt = null;
    this.startedEvent = null;
  }

  connect() {
    this.state = "connecting";
    let ws;
    try {
      ws = new this.WS(this.url, { headers: { Authorization: `Bearer ${this._apiKey}` } });
    } catch (e) {
      this.log.warn("sideband.error", { live_id: this.id, message: truncate(String(e && e.message), 200) });
      this.clock.setTimeout(() => this.onSocketClose(1006, true), 0);
      return;
    }
    this.ws = ws;
    try { ws.binaryType = "arraybuffer"; } catch { /* ignore */ }
    let opened = false;
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      opened = true;
      this.state = "open";
      this.log.info("sideband.open", { live_id: this.id, reattach: this.reattached });
      this.emit("open");
      if (!this.ready) this.readyTimer = this.clock.setTimeout(() => this.markReady(false), READY_FALLBACK_MS);
      else this.flush();
    });
    ws.addEventListener("message", (ev) => { if (this.ws === ws) this.onMessage(ev.data); });
    ws.addEventListener("error", (ev) => {
      if (this.ws !== ws) return;
      this.log.warn("sideband.error", { live_id: this.id, message: truncate(String(ev && (ev.message || ev.error?.message) || "error"), 200) });
    });
    ws.addEventListener("close", (ev) => {
      if (this.ws !== ws) return;
      this.onSocketClose(ev && ev.code, !opened);
    });
  }

  onMessage(data) {
    let s = data;
    if (typeof s !== "string") {
      try { s = Buffer.from(data).toString("utf8"); } catch { return; }
    }
    // Cheap early drop for reflected audio (≈100 KB/s): never parse/log/store it.
    const head = s.length > 1024 ? s.slice(0, 256) : s;
    if (s.length > 1024 && (head.includes('"session.output_audio.delta"') || head.includes('"session.input_audio.append"'))) {
      this.audioBytes += s.length;
      // Diagnostics only (status/debug): the speech queue uses the transcript.
      if (head.includes('"session.output_audio.delta"')) this.lastOutputAudioAt = this.clock.now();
      return;
    }
    let evt;
    try { evt = JSON.parse(s); } catch { this.log.warn("sideband.bad_json", { live_id: this.id, bytes: s.length }); return; }
    if (!evt || typeof evt.type !== "string") return;
    if (AUDIO_TYPES.has(evt.type)) {
      this.audioBytes += s.length;
      if (evt.type === "session.output_audio.delta") this.lastOutputAudioAt = this.clock.now();
      return;
    }
    this.handleEvent(evt);
  }

  /** One parsed non-audio server event (shared with the primary WebSocket, live-ws.js). */
  handleEvent(evt) {
    this.logServerEvent(evt);
    const t = evt.type;
    if (t === "session.started") {
      this.startedEvent = evt;
      if (evt.session && evt.session.expires_at) this.expiresAt = Number(evt.session.expires_at);
      this.markReady(true);
    } else if (/^session\.(instructions|thinking|commentary)\.appended$/.test(t)) {
      const p = evt.client_event_id && this.pending.get(evt.client_event_id);
      if (p) {
        this.pending.delete(evt.client_event_id);
        this.counters.appends_acked++;
        this.log.info("append.ack", { live_id: this.id, event_id: evt.client_event_id, kind: p.kind, start_ms: evt.start_ms });
        this.emit("ack", { kind: p.kind, event_id: evt.client_event_id });
      }
    } else if (t === "error") {
      const cid = evt.error?.client_event_id || evt.client_event_id;
      const p = cid && this.pending.get(cid);
      if (p) {
        this.pending.delete(cid);
        const code = evt.error?.code;
        if (p.kind) {
          this.counters.appends_failed++;
          const lvl = code === "context_injection_incomplete" && this.closing ? "debug" : "warn";
          this.log[lvl]("append.failed", { live_id: this.id, event_id: cid, kind: p.kind, code, message: truncate(evt.error?.message, 300) });
          this.emit("append_failed", { kind: p.kind, event_id: cid, error: evt.error, content: p.content, delegation_id: p.delegation_id ?? null });
        }
      }
    } else if (t === "session.closed") {
      this.sawClosed = true;
      const seconds = Number(evt.usage?.seconds);
      this.emit("session_closed", { reason: evt.reason || "unknown", seconds: Number.isFinite(seconds) ? seconds : null });
    }
    this.emit("event", evt);
  }

  logServerEvent(evt) {
    if (this.debug) { this.log.debug("sideband.event", { live_id: this.id, event: evt }); }
    const f = { live_id: this.id, type: evt.type };
    if (evt.client_event_id) f.client_event_id = evt.client_event_id;
    switch (evt.type) {
      case "session.input_transcript.delta":
      case "session.output_transcript.delta":
        Object.assign(f, { delta: truncate(evt.delta, 500), start_ms: evt.start_ms, end_ms: evt.end_ms }); break;
      case "session.delegation.created":
        Object.assign(f, { delegation_id: evt.delegation?.id, target: evt.delegation?.target, offset_ms: evt.offset_ms }); break;
      case "session.usage.updated":
        Object.assign(f, { seconds: evt.usage?.seconds, usage_ratio: evt.context_window?.usage_ratio }); break;
      case "session.closed":
        Object.assign(f, { reason: evt.reason, seconds: evt.usage?.seconds }); break;
      case "session.started":
        Object.assign(f, { model: evt.session?.model, expires_at: evt.session?.expires_at }); break;
      case "error":
        Object.assign(f, { code: evt.error?.code, message: truncate(evt.error?.message, 500), error_client_event_id: evt.error?.client_event_id }); break;
      case "info":
        Object.assign(f, { code: evt.code, message: truncate(evt.message, 500) }); break;
      default: break;
    }
    // Transcript deltas arrive every ~200 ms; they are still info per SPEC §10.
    this.log.info(evt.type, f);
  }

  markReady(started) {
    if (this.readyTimer) { this.clock.clearTimeout(this.readyTimer); this.readyTimer = null; }
    if (this.ready) return;
    this.ready = true;
    this.emit("ready", { started, expires_at: this.expiresAt });
    this.flush();
  }

  isOpen() { return this.state === "open" && this.ws && this.ws.readyState === 1; }

  /** Send a client event; assigns event_id "clv_<n>". Queues while not ready. */
  send(type, fields = {}) {
    const event_id = `clv_${++this.seq}`;
    const evt = { type, event_id, ...fields };
    const kind = /^session\.(instructions|thinking|commentary)\.append$/.exec(type)?.[1];
    if (!this.ready || !this.isOpen()) {
      if (this.state === "closed") return null;
      this.queue.push({ evt, kind });
      const thinking = this.queue.filter((q) => q.kind === "thinking");
      if (thinking.length > MAX_QUEUED_THINKING) this.queue.splice(this.queue.indexOf(thinking[0]), 1);
      return event_id;
    }
    this.transmit(evt, kind);
    return event_id;
  }

  transmit(evt, kind) {
    // content/delegation_id are kept so an append the server rejects can be retried.
    this.pending.set(evt.event_id, { type: evt.type, kind, sent_at: this.clock.now(), content: kind ? evt.content : undefined, delegation_id: kind ? evt.delegation_id : undefined });
    if (this.pending.size > 500) this.pending.delete(this.pending.keys().next().value);
    const f = { live_id: this.id, type: evt.type, event_id: evt.event_id };
    if (kind) Object.assign(f, { delegation_id: evt.delegation_id, content: truncate(evt.content, 500) });
    this.log.info("client.send", f);
    if (kind === "thinking") this.counters.thinking_sent++;
    else if (kind === "commentary") this.counters.commentary_sent++;
    else if (kind === "instructions") this.counters.instructions_sent++;
    try { this.ws.send(JSON.stringify(evt)); } catch (e) { this.log.warn("sideband.send_error", { live_id: this.id, message: truncate(String(e && e.message), 200) }); }
  }

  flush() {
    if (!this.ready || !this.isOpen()) return;
    const q = this.queue;
    this.queue = [];
    for (const { evt, kind } of q) this.transmit(evt, kind);
  }

  /** append(kind, content, delegationId): delegation_id is always present. */
  append(kind, content, delegationId = null) {
    if (!APPEND_KINDS.has(kind)) throw new Error(`bad append kind ${kind}`);
    if (typeof content !== "string" || content.length > MAX_APPEND_CHARS || estTokens(content) > API_APPEND_TOKEN_LIMIT) {
      throw new Error(`append content must be a string ≤ ${MAX_APPEND_CHARS} chars and ≤ ${API_APPEND_TOKEN_LIMIT} tokens (got ${content && content.length} chars)`);
    }
    return this.send(`session.${kind}.append`, { delegation_id: delegationId ?? null, content });
  }

  /** Ask the server to close; resolves when session.closed arrives or the socket closes (≤ timeoutMs). */
  close(timeoutMs = 15000) {
    this.closing = true;
    return new Promise((resolve) => {
      if (this.sawClosed || this.state === "closed") { this.shutdownSocket(); return resolve({ confirmed: this.sawClosed }); }
      let done = false;
      const finish = (confirmed) => {
        if (done) return;
        done = true;
        this.clock.clearTimeout(timer);
        this.off("session_closed", onClosed);
        this.off("socket_closed", onSock);
        this.shutdownSocket();
        resolve({ confirmed });
      };
      const onClosed = () => finish(true);
      const onSock = () => finish(this.sawClosed);
      const timer = this.clock.setTimeout(() => {
        this.log.warn("sideband.close_timeout", { live_id: this.id, message: "finalization unconfirmed" });
        finish(false);
      }, timeoutMs);
      this.on("session_closed", onClosed);
      this.on("socket_closed", onSock);
      if (this.isOpen()) {
        // Bypass the ready queue: close must go out now.
        this.queue = [];
        this.transmit({ type: "session.close", event_id: `clv_${++this.seq}` }, undefined);
      } else if (this.state === "connecting") {
        this.once("open", () => this.transmit({ type: "session.close", event_id: `clv_${++this.seq}` }, undefined));
      } else {
        finish(false);
      }
    });
  }

  shutdownSocket() {
    if (this.readyTimer) { this.clock.clearTimeout(this.readyTimer); this.readyTimer = null; }
    const ws = this.ws;
    this.state = "closed";
    this.ws = null;
    if (ws) try { ws.close(); } catch { /* ignore */ }
  }

  onSocketClose(code, neverOpened) {
    this.log.info("sideband.close", { live_id: this.id, code, audio_bytes: this.audioBytes });
    if (this.readyTimer) { this.clock.clearTimeout(this.readyTimer); this.readyTimer = null; }
    this.ws = null;
    const expected = this.closing || this.sawClosed;
    if (expected) {
      this.state = "closed";
      this.emit("socket_closed", { code });
      return;
    }
    // Unexpected: re-attach once after 1 s; if that fails, report "lost".
    if (!this.reattached) {
      this.reattached = true;
      this.state = "connecting";
      this.log.warn("sideband.reattach", { live_id: this.id, code });
      this.clock.setTimeout(() => { if (!this.closing) this.connect(); }, REATTACH_MS);
      return;
    }
    this.state = "closed";
    this.emit("socket_closed", { code });
    this.emit("lost", { code, neverOpened });
  }
}
