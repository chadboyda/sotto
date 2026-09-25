// Wake-clip transcription and injection text (SPEC §6.15).
//
// WebRTC cannot replay audio that was spoken before the session existed, so
// the page records the utterance from speech onset until the new session is
// live and posts it here; we transcribe it and hand the words to the model.
//
// Model choice (probe 2026-09-23, 4.3 s TTS clip, 16 kHz WAV, this machine):
//   gpt-transcribe          median 0.81 s, $0.0045/min, pink noise -> ""   (default)
//   gpt-4o-mini-transcribe  median 0.67 s, $0.003/min,  pink noise -> ""   (fallback)
//   gpt-4o-transcribe       median 0.56 s, $0.006/min,  pink noise -> "Seja bem." (hallucinates)
//   whisper-1               ~1.24 s
//   gpt-live-transcribe     404: streaming only, not on /v1/audio/transcriptions
// gpt-transcribe is the documented default for bounded clips and stays silent
// on noise, which matters because a false wake must not invent a request.
import { truncate } from "./log.js";

export const WAKE_TRANSCRIBE_MODEL = "gpt-transcribe";
export const WAKE_TRANSCRIBE_FALLBACK = "gpt-4o-mini-transcribe";
/** Largest clip we accept: 15 s of 16 kHz 16-bit mono plus slack. */
export const MAX_CLIP_BYTES = 2 * 1024 * 1024;

/** Decode and sanity-check a base64 WAV from the page. Returns a Buffer or null. */
export function decodeWavB64(b64) {
  if (typeof b64 !== "string" || !b64 || b64.length > Math.ceil(MAX_CLIP_BYTES / 3) * 4 + 8) return null;
  let buf;
  try { buf = Buffer.from(b64, "base64"); } catch { return null; }
  if (buf.length < 44 || buf.length > MAX_CLIP_BYTES) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  return buf;
}

/** Duration in ms of a PCM WAV buffer (from its header), or 0. */
export function wavDurationMs(buf) {
  try {
    const rate = buf.readUInt32LE(24);
    const bytesPerSec = buf.readUInt32LE(28);
    const dataLen = buf.length - 44;
    return rate > 0 && bytesPerSec > 0 ? Math.round((dataLen / bytesPerSec) * 1000) : 0;
  } catch {
    return 0;
  }
}

/** Trim a transcript; null when it carries no words (noise, punctuation only). */
export function cleanTranscript(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(t)) return null;
  return t.slice(0, 1000);
}

/**
 * POST the clip to /v1/audio/transcriptions.
 * @returns {Promise<{ok:boolean, text?:string|null, ms:number, status?:number, code?:string, message?:string, model:string}>}
 * Never includes the API key in any returned field.
 */
export async function transcribeClip({ base, apiKey, wav, model = WAKE_TRANSCRIBE_MODEL, prompt, fetchImpl = globalThis.fetch, clock, timeoutMs = 8000 }) {
  const t0 = clock.now();
  const ac = new AbortController();
  const timer = clock.setTimeout(() => ac.abort(), timeoutMs);
  try {
    const fd = new FormData();
    fd.append("file", new Blob([wav], { type: "audio/wav" }), "wake.wav");
    fd.append("model", model);
    fd.append("response_format", "json");
    if (prompt) fd.append("prompt", prompt);
    const res = await fetchImpl(`${base}/audio/transcriptions`, {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: fd, signal: ac.signal,
    });
    const ms = clock.now() - t0;
    let json = null;
    try { json = JSON.parse(await res.text()); } catch { /* not json */ }
    if (res.status >= 200 && res.status < 300) return { ok: true, text: cleanTranscript(json?.text), ms, status: res.status, model };
    return { ok: false, ms, status: res.status, code: "openai_error", message: truncate(String(json?.error?.message || `HTTP ${res.status}`), 200), model };
  } catch (e) {
    const ms = clock.now() - t0;
    if (ac.signal.aborted) return { ok: false, ms, code: "timeout", message: `no answer within ${Math.round(timeoutMs / 1000)} s`, model };
    return { ok: false, ms, code: "network", message: truncate(String(e && e.message), 200), model };
  } finally {
    clock.clearTimeout(timer);
  }
}

/** Transcribe with the default model, falling back once on a non-timeout failure. */
export async function transcribeWithFallback(o) {
  const first = await transcribeClip(o);
  if (first.ok || first.code === "timeout" || o.model) return first;
  const second = await transcribeClip({ ...o, model: WAKE_TRANSCRIBE_FALLBACK });
  return second.ok ? { ...second, fallback_from: first.model, first_status: first.status } : first;
}

/** instructions.append text that hands the missed opening words to the model. */
export function wakeInstruction(text) {
  if (!text) {
    // Not "stay silent": the user spoke to wake the voice and hears nothing
    // back otherwise (live log 2026-09-25: four wakes, each silent, each then
    // slept as a false wake). A short answer shows the voice is listening.
    return "[sotto] The user started speaking just before this voice session connected, but their first words were not captured. If they are still talking, listen and respond to what they say. If they are quiet, say only a short \"Yes?\" so they know you are listening. Do not mention that anything was missed.";
  }
  const words = truncate(text, 900);
  return `[sotto] The user started speaking just before this voice session connected, so you missed their first words. What they said: "${words}". They may still be finishing the sentence. Treat it as the start of their turn: when they are done, respond to everything they said as one request, and delegate it to Claude Code if it is a request for Claude Code. Do not mention that you missed anything.`;
}

