// OpenAI Live PRIMARY WebSocket session (wss://api.openai.com/v1/live/sessions)
// for native app clients (docs/NATIVE.md §4).
//
// PrimarySession has the SAME public surface as live.js Sideband (it extends
// it), so voice.js keeps calling this.sideband.append/send/close unchanged:
//   constructor({ url, apiKey, start, WebSocketImpl, clock, log, counters, debug })
//   connect(); send(type, fields); append(kind, content, delegationId); close(timeoutMs) -> Promise
//   fields: id (from session.started), state ("connecting"|"open"|"closed"), ready, expiresAt
//   events: "ready" {started, expires_at}, "event" evt, "ack", "append_failed", "session_closed" {reason, seconds},
//           "lost" {code, neverOpened, started, error}, "socket_closed" {code}
// plus the audio path:
//   pushAudio(pcm Buffer)   -> session.input_audio.append (base64); dropped before ready; never logged
//   event "audio" (pcm Buffer) for each session.output_audio.delta (decoded); never logged
// Differences from the sideband, all from the Live API reference for the
// primary WebSocket:
//  - the first message is session.start and nothing else goes out before
//    session.started (so `ready` means session.started; no 1.5 s fallback);
//  - the session id is only known from session.started;
//  - there is no re-attach: the socket IS the session, so a lost socket is a
//    lost session (voice.reconnect("primary_lost")).
import { LIVE_MODEL } from "./config.js";
import { Sideband, seedMessages } from "./live.js";
import { SAMPLE_RATE } from "./native-proto.js";
import { truncate } from "./log.js";

/** The session.start event: buildSessionBody() minus client/transport, plus audio.format. */
export function buildPrimaryStart({ instructions, seed, voice }) {
  return {
    type: "session.start",
    session: {
      model: LIVE_MODEL,
      instructions,
      input: seedMessages(seed),
      audio: { format: { type: "audio/pcm", rate: SAMPLE_RATE }, output: { voice } },
      delegation: { type: "client" },
      store: false,
    },
  };
}

const DELTA_KEY = '"delta":"';

export class PrimarySession extends Sideband {
  constructor({ url, apiKey, start, WebSocketImpl, clock, log, counters, debug = false }) {
    super({ id: null, url, apiKey, WebSocketImpl, clock, log, counters, debug });
    this.startEvent = start;
    this.started = false;
    this.lastServerError = null;
    this.inputFrames = 0;
    this.outputBytes = 0;
  }

  connect() {
    this.state = "connecting";
    let ws;
    try {
      ws = new this.WS(this.url, { headers: { Authorization: `Bearer ${this._apiKey}` } });
    } catch (e) {
      this.log.warn("live.error", { message: truncate(String(e && e.message), 200) });
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
      this.log.info("live.open", { model: this.startEvent?.session?.model, voice: this.startEvent?.session?.audio?.output?.voice });
      try { ws.send(JSON.stringify({ event_id: "clv_start", ...this.startEvent })); } catch (e) {
        this.log.warn("live.send_error", { message: truncate(String(e && e.message), 200) });
      }
      this.emit("open");
    });
    ws.addEventListener("message", (ev) => { if (this.ws === ws) this.onMessage(ev.data); });
    ws.addEventListener("error", (ev) => {
      if (this.ws !== ws) return;
      this.log.warn("live.error", { live_id: this.id, message: truncate(String(ev && (ev.message || ev.error?.message) || "error"), 200) });
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
    // Output audio (~64 KB/s of base64): decode without parsing or logging it.
    if (s.length > 256 && s.slice(0, 200).includes('"session.output_audio.delta"')) {
      const i = s.indexOf(DELTA_KEY);
      const j = i < 0 ? -1 : s.indexOf('"', i + DELTA_KEY.length);
      if (j > i) { this.onAudio(s.slice(i + DELTA_KEY.length, j)); return; }
    }
    let evt;
    try { evt = JSON.parse(s); } catch { this.log.warn("live.bad_json", { live_id: this.id, bytes: s.length }); return; }
    if (!evt || typeof evt.type !== "string") return;
    if (evt.type === "session.output_audio.delta") { if (typeof evt.delta === "string") this.onAudio(evt.delta); return; }
    if (evt.type === "session.input_audio.append") return;
    if (evt.type === "session.started") {
      this.started = true;
      if (evt.session?.id) this.id = String(evt.session.id);
    } else if (evt.type === "error" && !this.started) {
      this.lastServerError = { code: evt.error?.code || null, message: truncate(String(evt.error?.message || ""), 300) };
    }
    this.handleEvent(evt);
  }

  onAudio(b64) {
    if (this.closing) return;
    const pcm = Buffer.from(b64, "base64");
    this.audioBytes += b64.length;
    this.outputBytes += pcm.length;
    this.lastOutputAudioAt = this.clock.now();
    this.emit("audio", pcm);
  }

  /** One mic frame (PCM16 24 kHz mono) as session.input_audio.append. Never before session.started. */
  pushAudio(pcm) {
    if (!this.ready || this.closing || this.sawClosed || !this.isOpen()) return false;
    try {
      this.ws.send(`{"type":"session.input_audio.append","audio":"${Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length).toString("base64")}"}`);
      this.inputFrames++;
      return true;
    } catch { return false; }
  }

  onSocketClose(code, neverOpened) {
    this.log.info("live.close", { live_id: this.id, code, never_opened: !!neverOpened, started: this.started, input_frames: this.inputFrames, output_bytes: this.outputBytes });
    if (this.readyTimer) { this.clock.clearTimeout(this.readyTimer); this.readyTimer = null; }
    this.ws = null;
    this.state = "closed";
    const expected = this.closing || this.sawClosed;
    this.emit("socket_closed", { code });
    if (!expected) this.emit("lost", { code, neverOpened: !!neverOpened, started: this.started, error: this.lastServerError });
  }
}
