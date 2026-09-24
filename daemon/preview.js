// Voice previews for the settings drawer's voice picker (SPEC §6.4
// GET /api/voice-preview). A preview must not touch the live session: the
// voice is fixed per Live session, so hearing another voice needs a session of
// its own. The first preview of a voice opens a tiny primary-WebSocket Live
// session in that voice, has it say one sentence, captures the output PCM16,
// closes, and caches a WAV in the data dir; later previews are a file read.
//
// Measured (2026-09-24, gpt-live-1, primary WebSocket, 24 kHz PCM16):
//  - With no input audio the session timeline never runs and the model says
//    nothing (7 s, zero output audio). Streaming silence as input, paced in
//    real time, lets the start instructions play: speech starts ~1.0 s after
//    the socket opens and the sentence is done ~3.3 s in.
//  - Output audio arrives paced in real time and keeps coming (silence) after
//    the sentence, so the end is "transcript complete + quiet audio".
//  - The start instructions alone are not always enough: in 2 of 21 sessions
//    the model stayed silent for 10 s. Speech otherwise started 0.9-2.9 s in.
//    If there is no speech and no transcript NUDGE_MS (3 s) after
//    session.started, one instructions.append repeats the sentence. (An
//    append-only trigger worked 10 of 10 but took 4.6-8.8 s; a nudge at 1.5 s
//    made a slow start say the sentence twice.) The silent sessions ignored
//    the nudge too (3 of 3 over 34 sessions), so a session still silent
//    STUCK_MS after session.started is closed and one new session is tried
//    (PreviewCache); a retry spoke normally.
//  - Primary WebSocket sessions are billed per second with no 15 s minimum
//    (that applies to WebRTC creation), so one preview bills ~4 s ($0.003).
import fs from "node:fs";
import path from "node:path";
import { LIVE_MODEL } from "./config.js";
import { truncate } from "./log.js";

export const PREVIEW_RATE = 24000;
/** Input silence chunk: 100 ms of 24 kHz mono PCM16. */
const SILENCE_CHUNK_MS = 100;
/** Output sample peak above this counts as speech (PCM16 full scale 32767). */
export const LOUD_PEAK = 1200;
/** The sentence is over when the transcript is complete and the audio has been quiet this long. */
const QUIET_AFTER_MS = 700;
/** Hard cap on a preview session's wall time. */
export const PREVIEW_TIMEOUT_MS = 12000;
const CLOSE_WAIT_MS = 3000;
/** No speech this long after session.started: ask again, once. */
export const NUDGE_MS = 3000;
/** Still no speech this long after session.started (after the nudge): give up on this session (retry). */
export const STUCK_MS = 5500;

const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const previewText = (voice) => `Hi, I'm ${cap1(voice)}. This is how I sound.`;
export const previewNudge = (voice) => `Say exactly: "${previewText(voice)}" Then stop.`;
export const previewInstructions = (voice) =>
  `You are a voice sample for a settings screen. As soon as the session starts, say exactly this sentence and nothing else: "${previewText(voice)}" Then stop talking. Never say anything more, even if you hear something.`;

/** A mono PCM16 WAV file around `pcm`. */
export function pcm16ToWav(pcm, rate = PREVIEW_RATE) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16); // fmt chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); // byte rate
  h.writeUInt16LE(2, 32); // block align
  h.writeUInt16LE(16, 34); // bits
  h.write("data", 36, "ascii");
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Peak absolute sample of a PCM16 LE buffer. */
export function peakOf(pcm) {
  let p = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i));
    if (v > p) p = v;
  }
  return p;
}

/**
 * Cut leading and trailing silence, keeping `padMs` of lead-in and `tailMs` of
 * tail (a hard cut at the last loud sample clips the release). Works in 10 ms
 * frames. Returns an empty buffer when nothing is loud.
 */
export function trimSilence(pcm, { rate = PREVIEW_RATE, threshold = LOUD_PEAK, padMs = 80, tailMs = 250 } = {}) {
  const frame = Math.round(rate / 100) * 2;
  let first = -1, last = -1;
  for (let off = 0; off < pcm.length; off += frame) {
    if (peakOf(pcm.subarray(off, off + frame)) >= threshold) {
      if (first < 0) first = off;
      last = off + frame;
    }
  }
  if (first < 0) return Buffer.alloc(0);
  const bytesPerMs = (rate * 2) / 1000;
  const start = Math.max(0, (first - Math.round(padMs * bytesPerMs)) & ~1);
  const end = Math.min(pcm.length, (last + Math.round(tailMs * bytesPerMs)) & ~1);
  return pcm.subarray(start, end);
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z]+/g, " ").trim();

/**
 * Record one preview. Resolves {ok:true, pcm, ms, first_audio_ms, transcript,
 * live_id} as soon as the sentence is captured (the close handshake goes on in
 * the background, ~0.5-2 s), or {ok:false, code, message, ms, seconds,
 * live_id} once the session is over. `onClosed({live_id, seconds})` reports
 * the billed seconds from session.closed (null when unconfirmed). Never
 * rejects; the key never appears in results or logs.
 */
export function recordPreview({ base, apiKey, voice, WebSocketImpl = globalThis.WebSocket, clock, log, timeoutMs = PREVIEW_TIMEOUT_MS, onClosed }) {
  const url = `${String(base).replace(/^http/, "ws")}/live/sessions`;
  const t0 = clock.now();
  const want = norm(previewText(voice));
  return new Promise((resolve) => {
    let ws;
    const chunks = [];
    let transcript = "";
    let firstAudioAt = null, lastLoudAt = null, liveId = null, seconds = null;
    let silence = null, deadline = null, closeWait = null, poll = null, nudge = null, stuck = null;
    let closing = false, done = false, result = null, resolved = false;
    const answer = (r) => {
      if (resolved) return;
      resolved = true;
      resolve({ ...r, ms: clock.now() - t0, seconds, live_id: liveId });
    };

    const finish = (r) => {
      if (done) return;
      done = true;
      for (const t of [deadline, closeWait, nudge, stuck]) if (t) clock.clearTimeout(t);
      for (const t of [silence, poll]) if (t) clock.clearInterval(t);
      try { ws && ws.close(); } catch { /* ignore */ }
      answer(r);
      if (liveId) { try { onClosed?.({ live_id: liveId, seconds }); } catch { /* ignore */ } }
    };
    const close = (r) => {
      if (closing) return;
      closing = true;
      result = r;
      // A captured sentence is served right away; the close finishes behind it.
      if (r.ok) answer(r);
      if (silence) { clock.clearInterval(silence); silence = null; }
      if (nudge) { clock.clearTimeout(nudge); nudge = null; }
      if (stuck) { clock.clearTimeout(stuck); stuck = null; }
      if (poll) { clock.clearInterval(poll); poll = null; }
      try { ws.send(JSON.stringify({ type: "session.close", event_id: "sotto_preview_close" })); } catch { finish(r); return; }
      // Usage arrives with session.closed; do not wait for it forever.
      closeWait = clock.setTimeout(() => finish(r), CLOSE_WAIT_MS);
    };
    const complete = () => {
      const pcm = Buffer.concat(chunks);
      return { ok: true, pcm, transcript: transcript.trim(), first_audio_ms: firstAudioAt == null ? null : firstAudioAt - t0, last_loud_ms: lastLoudAt == null ? null : lastLoudAt - t0 };
    };

    try {
      ws = new WebSocketImpl(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    } catch (e) {
      finish({ ok: false, code: "openai_error", message: `Could not reach OpenAI: ${truncate(String(e && e.message), 200)}` });
      return;
    }
    try { ws.binaryType = "arraybuffer"; } catch { /* ignore */ }
    deadline = clock.setTimeout(() => {
      // Something was said: keep it even if the end was not detected.
      if (chunks.length && lastLoudAt != null) close(complete());
      else close({ ok: false, code: "preview_timeout", message: "The voice sample did not arrive in time." });
    }, timeoutMs);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        type: "session.start", event_id: "sotto_preview_start",
        session: {
          model: LIVE_MODEL,
          instructions: previewInstructions(voice),
          audio: { format: { type: "audio/pcm", rate: PREVIEW_RATE }, output: { voice } },
          store: false,
        },
      }));
    });
    ws.addEventListener("message", (ev) => {
      let e;
      try { e = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8")); } catch { return; }
      const now = clock.now();
      switch (e.type) {
        case "session.started": {
          liveId = e.session?.id || null;
          // The session timeline runs on input audio: stream silence in real time.
          const zero = Buffer.alloc((PREVIEW_RATE / 1000) * SILENCE_CHUNK_MS * 2).toString("base64");
          const tick = () => { try { if (!closing) ws.send(JSON.stringify({ type: "session.input_audio.append", audio: zero })); } catch { /* closed */ } };
          tick();
          silence = clock.setInterval(tick, SILENCE_CHUNK_MS);
          stuck = clock.setTimeout(() => {
            stuck = null;
            if (!closing && lastLoudAt == null && !transcript) close({ ok: false, code: "preview_stuck", message: "The voice sample session stayed silent." });
          }, STUCK_MS);
          nudge = clock.setTimeout(() => {
            nudge = null;
            if (closing || lastLoudAt != null || transcript) return;
            log?.info?.("preview.nudge", { voice });
            try { ws.send(JSON.stringify({ type: "session.instructions.append", event_id: "sotto_preview_nudge", delegation_id: null, content: previewNudge(voice) })); } catch { /* closed */ }
          }, NUDGE_MS);
          poll = clock.setInterval(() => {
            if (closing || lastLoudAt == null) return;
            const said = norm(transcript);
            const whole = said.endsWith(want.split(" ").slice(-2).join(" ")) || said.length >= want.length;
            if (whole && clock.now() - lastLoudAt >= QUIET_AFTER_MS) close(complete());
          }, 100);
          break;
        }
        case "session.output_audio.delta": {
          if (closing || typeof e.delta !== "string") break;
          const b = Buffer.from(e.delta, "base64");
          if (firstAudioAt == null) firstAudioAt = now;
          if (peakOf(b) >= LOUD_PEAK) lastLoudAt = now;
          chunks.push(b);
          break;
        }
        case "session.output_transcript.delta":
          if (typeof e.delta === "string") transcript += e.delta;
          break;
        case "session.usage.updated": {
          const s = Number(e.usage?.seconds);
          if (Number.isFinite(s)) seconds = s;
          break;
        }
        case "session.closed": {
          const s = Number(e.usage?.seconds);
          if (Number.isFinite(s)) seconds = s;
          finish(result || { ok: false, code: "preview_closed", message: `The voice sample session ended early (${truncate(String(e.reason || "unknown"), 40)}).` });
          break;
        }
        case "error":
          log?.warn?.("preview.error", { voice, code: e.error?.code || null, message: truncate(String(e.error?.message || ""), 300) });
          if (!liveId) close({ ok: false, code: "openai_error", message: `OpenAI error: ${truncate(String(e.error?.message || e.error?.code || "unknown"), 200)}` });
          break;
        default: break;
      }
    });
    ws.addEventListener("close", (ev) => {
      if (done) return;
      finish(result || { ok: false, code: "openai_error", message: `The voice sample connection closed (${ev?.code ?? "?"}).` });
    });
  });
}

/**
 * Cached previews in `<dir>` (D/voice-previews). get(voice) resolves
 * {ok, wav, cached, ...measurements} and records a voice at most once at a
 * time; a failure is not cached.
 */
export class PreviewCache {
  constructor({ dir, record, log }) {
    Object.assign(this, { dir, record, log });
    this.inflight = new Map();
  }

  file(voice) { return path.join(this.dir, `${voice}.wav`); }

  has(voice) {
    try { return fs.statSync(this.file(voice)).size > 44; } catch { return false; }
  }

  async get(voice) {
    try {
      const wav = fs.readFileSync(this.file(voice));
      if (wav.length > 44) return { ok: true, wav, cached: true };
    } catch { /* not cached yet */ }
    if (this.inflight.has(voice)) return this.inflight.get(voice);
    const p = this.make(voice).finally(() => this.inflight.delete(voice));
    this.inflight.set(voice, p);
    return p;
  }

  async make(voice) {
    let r = await this.record(voice);
    if (!r.ok && r.code === "preview_stuck") {
      this.log?.info?.("preview.retry", { voice, live_id: r.live_id || null });
      r = await this.record(voice);
    }
    const f = { voice, ok: r.ok, ms: r.ms, first_audio_ms: r.first_audio_ms ?? null, seconds: r.seconds ?? null, live_id: r.live_id || null };
    if (!r.ok) {
      this.log?.warn?.("preview.failed", { ...f, code: r.code });
      return { ok: false, code: r.code, message: r.message, seconds: r.seconds ?? null, live_id: r.live_id || null };
    }
    const pcm = trimSilence(r.pcm);
    if (!pcm.length) {
      this.log?.warn?.("preview.failed", { ...f, code: "preview_silent" });
      return { ok: false, code: "preview_silent", message: "The voice sample came back silent.", seconds: r.seconds ?? null, live_id: r.live_id || null };
    }
    const wav = pcm16ToWav(pcm);
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file(voice)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, wav, { mode: 0o600 });
      fs.renameSync(tmp, this.file(voice));
    } catch (e) {
      this.log?.warn?.("preview.cache_error", { voice, message: truncate(String(e && e.message), 200) });
    }
    this.log?.info?.("preview.recorded", { ...f, audio_ms: Math.round(pcm.length / (PREVIEW_RATE * 2) * 1000), transcript: truncate(r.transcript || "", 120) });
    return { ok: true, wav, cached: false, seconds: r.seconds ?? null, live_id: r.live_id || null };
  }
}
