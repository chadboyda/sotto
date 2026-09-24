// A Node client that speaks the native app protocol (docs/NATIVE.md) to a
// daemon: bootstrap, hello/welcome, 20 ms mic frames from a WAV (or silence),
// speaker frames collected into a Buffer (never played), JSON recorded, and
// `cmd`/`result` correlation. Used by the daemon tests and the daemon e2e.
// Uses Node's global WebSocket (undici), which sends no Origin header.
import fs from "node:fs";
import {
  NATIVE_PATH, SUBPROTOCOL, PROTOCOL, KIND, FLAG, FRAME_BYTES, FRAME_MS, SAMPLE_RATE,
  encodeFrame, decodeFrame,
} from "../../daemon/native-proto.js";

/**
 * PCM16 mono at 24 kHz from a WAV file or buffer (any rate/channels of
 * 16-bit PCM; linear resampling). Tolerates streaming WAVs whose sizes are 0xFFFFFFFF.
 */
export function readWavPcm24k(src) {
  const buf = Buffer.isBuffer(src) ? src : fs.readFileSync(src);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (size > buf.length - body) size = buf.length - body;
    if (id === "fmt ") fmt = { channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    else if (id === "data") { data = buf.subarray(body, body + size); break; }
    off = body + size + (size & 1);
  }
  if (!fmt || !data || fmt.bits !== 16) throw new Error("need a 16-bit PCM WAV");
  const frames = Math.floor(data.length / (2 * fmt.channels));
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) s += data.readInt16LE((i * fmt.channels + c) * 2);
    mono[i] = s / fmt.channels;
  }
  if (fmt.rate === SAMPLE_RATE) {
    const out = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) out.writeInt16LE(Math.round(mono[i]), i * 2);
    return out;
  }
  const n = Math.floor((frames * SAMPLE_RATE) / fmt.rate);
  const out = Buffer.alloc(n * 2);
  const ratio = fmt.rate / SAMPLE_RATE;
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const a = Math.floor(p);
    const b = Math.min(frames - 1, a + 1);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mono[a] + (mono[b] - mono[a]) * (p - a)))), i * 2);
  }
  return out;
}

/** Peak absolute sample of PCM16 LE. */
export function pcmPeak(pcm) {
  let p = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) { const v = Math.abs(pcm.readInt16LE(i)); if (v > p) p = v; }
  return p;
}

/** GET /api/bootstrap with the page secret (X-Sotto-Boot) or a launch code. */
export async function bootstrap({ port, secret, launch }) {
  const headers = {};
  if (secret) headers["X-Sotto-Boot"] = secret;
  if (launch) headers["X-Sotto-Launch"] = launch;
  const r = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { headers });
  if (r.status !== 200) throw new Error(`bootstrap ${r.status}`);
  return r.json();
}

export class FakeNativeApp {
  constructor({ port, pageToken, version = "0.3.0-test", test = true, protocol = PROTOCOL, headers = {} } = {}) {
    Object.assign(this, { port, pageToken, version, test, protocol, extraHeaders: headers });
    this.ws = null;
    this.messages = [];
    this.speaker = []; // Buffers, in arrival order
    this.speakerMeta = []; // {seq, flags}
    this.results = new Map();
    this.waiters = [];
    this.closeInfo = null;
    this.seq = 0;
    this.micTimer = null;
    this.micSource = null;
    this.micOffset = 0;
    this.micSent = 0;
    this.muted = false;
    this.nextId = 0;
    this.autoPong = true;
  }

  /** Open the socket and send hello. Resolves with the welcome (or rejects on close). */
  connect({ hello = {} } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}${NATIVE_PATH}`, {
        protocols: [SUBPROTOCOL],
        headers: { "X-Sotto-Page": this.pageToken, ...this.extraHeaders },
      });
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      let welcomed = false;
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({
          type: "hello", protocol: this.protocol, client: "app", version: this.version, build: null, test: this.test,
          capabilities: ["native_audio"], audio: { rate: SAMPLE_RATE, frame_ms: FRAME_MS, format: "pcm16le" }, ...hello,
        }));
      });
      ws.addEventListener("message", (ev) => {
        if (typeof ev.data === "string") {
          let m;
          try { m = JSON.parse(ev.data); } catch { return; }
          this.messages.push(m);
          if (m.type === "welcome" && !welcomed) { welcomed = true; resolve(m); }
          if (m.type === "ping" && this.autoPong) this.sendJson({ type: "pong", t: m.t });
          if (m.type === "result" && this.results.has(m.id)) { const r = this.results.get(m.id); this.results.delete(m.id); r(m); }
        } else {
          const f = decodeFrame(Buffer.from(ev.data));
          if (f && f.kind === KIND.SPEAKER) { this.speaker.push(Buffer.from(f.pcm)); this.speakerMeta.push({ seq: f.seq, flags: f.flags }); }
        }
        this.poke();
      });
      ws.addEventListener("close", (ev) => {
        this.closeInfo = { code: ev.code, reason: ev.reason };
        this.stopMic();
        this.poke();
        if (!welcomed) reject(Object.assign(new Error(`closed ${ev.code}`), { code: ev.code }));
      });
      ws.addEventListener("error", () => {});
    });
  }

  poke() {
    const w = this.waiters;
    this.waiters = [];
    for (const x of w) { if (!x.check()) this.waiters.push(x); }
  }

  /** Resolves when pred() is truthy (checked on every message), rejects after timeoutMs. */
  waitFor(pred, timeoutMs = 5000, what = "condition") {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error(`timeout waiting for ${what}`)); }, timeoutMs);
      const w = { check: () => { let v; try { v = pred(); } catch { v = null; } if (v) { clearTimeout(t); resolve(v); return true; } return false; } };
      if (!w.check()) this.waiters.push(w);
    });
  }

  waitType(type, timeoutMs = 5000, filter = () => true) {
    return this.waitFor(() => this.messages.find((m) => m.type === type && filter(m)), timeoutMs, type);
  }

  sendJson(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  /** One mic frame now. */
  sendMicFrame(pcm = Buffer.alloc(FRAME_BYTES), flags = 0) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(encodeFrame({ kind: KIND.MIC, flags: flags | (this.test ? FLAG.FAKE : 0) | (this.muted ? FLAG.MUTED : 0), seq: this.seq++, tsNs: process.hrtime.bigint(), pcm: this.muted ? Buffer.alloc(FRAME_BYTES) : pcm }));
    this.micSent++;
  }

  /**
   * Stream mic frames every 20 ms from `pcm` (after `leadMs` of silence),
   * then silence. Real time (setInterval, catching up from a start stamp).
   */
  startMic({ pcm = null, leadMs = 0 } = {}) {
    this.stopMic();
    const lead = Buffer.alloc(Math.round((leadMs / 1000) * SAMPLE_RATE) * 2);
    this.micSource = pcm ? Buffer.concat([lead, pcm]) : null;
    this.micOffset = 0;
    const t0 = Date.now();
    let n = 0;
    const tick = () => {
      const due = Math.floor((Date.now() - t0) / FRAME_MS) + 1;
      while (n < due) {
        n++;
        let frame = Buffer.alloc(FRAME_BYTES);
        if (this.micSource && this.micOffset < this.micSource.length) {
          const part = this.micSource.subarray(this.micOffset, this.micOffset + FRAME_BYTES);
          part.copy(frame);
          this.micOffset += FRAME_BYTES;
        }
        this.sendMicFrame(frame);
      }
    };
    this.micTimer = setInterval(tick, 10);
    tick();
  }

  stopMic() { if (this.micTimer) { clearInterval(this.micTimer); this.micTimer = null; } }

  get micDone() { return !this.micSource || this.micOffset >= this.micSource.length; }

  /** Send a command; resolves with its `result` message. */
  cmd(name, args = {}, timeoutMs = 10_000) {
    const id = `c${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.results.delete(id); reject(new Error(`cmd ${name} timed out`)); }, timeoutMs);
      this.results.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.sendJson({ type: "cmd", id, name, args });
    });
  }

  speakerPcm() { return Buffer.concat(this.speaker); }
  ofType(type) { return this.messages.filter((m) => m.type === type); }

  close(code = 1000) {
    this.stopMic();
    try { this.ws?.close(code); } catch { /* ignore */ }
  }

  waitClosed(timeoutMs = 3000) { return this.waitFor(() => this.closeInfo, timeoutMs, "close"); }
}
