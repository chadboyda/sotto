// Voice previews (daemon/preview.js, GET /api/voice-preview): a tiny primary
// WebSocket Live session per voice, cached as a WAV; never the live session.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { recordPreview, PreviewCache, pcm16ToWav, trimSilence, previewText, previewInstructions, PREVIEW_RATE } from "../../daemon/preview.js";
import { wavDurationMs } from "../../daemon/transcribe.js";
import { createFakeClock } from "../helpers/fake-clock.js";
import { createFakeWSClass } from "../helpers/fake-ws.js";
import { makeHarness } from "../helpers/daemon-harness.js";

const tone = (ms, amp = 8000) => {
  const n = Math.round((PREVIEW_RATE * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / PREVIEW_RATE)), i * 2);
  return b;
};
const quiet = (ms) => Buffer.alloc(Math.round((PREVIEW_RATE * ms) / 1000) * 2);
const audio = (buf) => ({ type: "session.output_audio.delta", delta: buf.toString("base64") });
const noopLog = { info() {}, warn() {}, debug() {} };

/** Drive a fake session: started, 1 s silence, 2 s speech with its transcript, then silence. */
async function speakSentence(clock, ws, voice, { speechMs = 2000 } = {}) {
  ws.open();
  const start = ws.sent[0];
  ws.receive({ type: "session.started", session: { id: "live_prev_1" } });
  for (let t = 0; t < 1000; t += 100) { ws.receive(audio(quiet(100))); await clock.advance(100); }
  const words = previewText(voice).split(" ");
  for (let t = 0, i = 0; t < speechMs; t += 100, i++) {
    ws.receive(audio(tone(100)));
    if (i < words.length) ws.receive({ type: "session.output_transcript.delta", delta: (i ? " " : "") + words[i] });
    await clock.advance(100);
  }
  return start;
}

test("previewText and WAV helpers", () => {
  assert.equal(previewText("cedar"), "Hi, I'm Cedar. This is how I sound.");
  assert.match(previewInstructions("cedar"), /"Hi, I'm Cedar\. This is how I sound\."/);
  const wav = pcm16ToWav(tone(500));
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wavDurationMs(wav), 500);
  const trimmed = trimSilence(Buffer.concat([quiet(1000), tone(800), quiet(1500)]));
  const ms = (trimmed.length / (PREVIEW_RATE * 2)) * 1000;
  assert.ok(ms >= 800 && ms <= 800 + 80 + 250 + 20, `trimmed to ${ms} ms`);
  assert.equal(trimSilence(quiet(500)).length, 0);
});

test("recordPreview: session.start in the voice, silence streamed, served once the sentence is over, usage from session.closed", async () => {
  const clock = createFakeClock();
  const WS = createFakeWSClass();
  let closed = null;
  const p = recordPreview({ base: "https://api.openai.com/v1", apiKey: "sk-test", voice: "cedar", WebSocketImpl: WS, clock, log: noopLog, onClosed: (c) => { closed = c; } });
  const ws = WS.last();
  assert.equal(ws.url, "wss://api.openai.com/v1/live/sessions");
  assert.equal(ws.opts.headers.Authorization, "Bearer sk-test");
  const start = await speakSentence(clock, ws, "cedar");
  assert.equal(start.type, "session.start");
  assert.equal(start.session.model, "gpt-live-1");
  assert.deepEqual(start.session.audio, { format: { type: "audio/pcm", rate: 24000 }, output: { voice: "cedar" } });
  assert.equal(start.session.store, false);
  assert.ok(ws.sentOfType("session.input_audio.append").length >= 25, "the timeline runs on streamed silence");
  assert.equal(ws.sentOfType("session.close").length, 0, "still speaking");
  for (let t = 0; t < 900; t += 100) { ws.receive(audio(quiet(100))); await clock.advance(100); }
  assert.equal(ws.sentOfType("session.close").length, 1, "closed after 700 ms of quiet");
  const r = await p; // served before session.closed
  assert.equal(r.ok, true);
  assert.equal(r.transcript, "Hi, I'm Cedar. This is how I sound.");
  assert.equal(r.live_id, "live_prev_1");
  assert.equal(closed, null);
  ws.receive({ type: "session.closed", reason: "close_requested", usage: { seconds: 4 } });
  assert.deepEqual(closed, { live_id: "live_prev_1", seconds: 4 });
  const n = ws.sentOfType("session.input_audio.append").length;
  await clock.advance(1000);
  assert.equal(ws.sentOfType("session.input_audio.append").length, n, "silence stops at close");
  assert.equal(clock.pending(), 0, "no timers left");
});

test("recordPreview: an error before start and a silent session both fail without hanging", async () => {
  const clock = createFakeClock();
  const WS = createFakeWSClass();
  const p = recordPreview({ base: "https://api.openai.com/v1", apiKey: "k", voice: "sage", WebSocketImpl: WS, clock, log: noopLog });
  const ws = WS.last();
  ws.open();
  ws.receive({ type: "error", error: { code: "invalid_api_key", message: "bad key" } });
  assert.equal(ws.sentOfType("session.close").length, 1);
  ws.serverClose(1000);
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.code, "openai_error");
  assert.ok(!JSON.stringify(r).includes("\"k\""));

  const WS2 = createFakeWSClass();
  const p2 = recordPreview({ base: "https://api.openai.com/v1", apiKey: "k", voice: "sage", WebSocketImpl: WS2, clock, log: noopLog, timeoutMs: 3000 });
  const ws2 = WS2.last();
  ws2.open();
  ws2.receive({ type: "session.started", session: { id: "live_x" } });
  for (let t = 0; t < 3000; t += 100) { ws2.receive(audio(quiet(100))); await clock.advance(100); }
  assert.equal(ws2.sentOfType("session.close").length, 1);
  await clock.advance(3000); // no session.closed: give up waiting
  const r2 = await p2;
  assert.equal(r2.code, "preview_timeout");
  assert.equal(clock.pending(), 0);
});

test("PreviewCache: records a voice once (concurrent requests share it), then serves the file", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "clv-prev-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const cache = new PreviewCache({ dir, log: noopLog, record: async () => { calls++; return { ok: true, pcm: Buffer.concat([quiet(300), tone(1000), quiet(300)]), ms: 4000, live_id: "l1" }; } });
  const [a, b] = await Promise.all([cache.get("cedar"), cache.get("cedar")]);
  assert.equal(calls, 1);
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.cached, false);
  assert.ok(fs.existsSync(path.join(dir, "cedar.wav")));
  const c = await cache.get("cedar");
  assert.equal(c.cached, true);
  assert.equal(calls, 1);
  assert.deepEqual(c.wav, a.wav);
  // Failures are not cached.
  const bad = new PreviewCache({ dir, log: noopLog, record: async () => { calls++; return { ok: false, code: "openai_error", message: "x" }; } });
  assert.equal((await bad.get("sage")).ok, false);
  assert.equal((await bad.get("sage")).ok, false);
  assert.equal(fs.existsSync(path.join(dir, "sage.wav")), false);
});

test("GET /api/voice-preview: page token, WAV, cached, booked to usage, live session untouched", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  await h.d.listen();
  const ws = await h.goLive({ config: { voice: "marin" } });
  const token = h.d.pageToken;
  const base = `http://127.0.0.1:${h.port}`;
  assert.equal((await fetch(`${base}/api/voice-preview?voice=cedar`)).status, 403);
  assert.equal((await fetch(`${base}/api/voice-preview?voice=nope`, { headers: { "X-Sotto-Page": token } })).status, 400);

  const before = h.WS.instances.length;
  const resP = fetch(`${base}/api/voice-preview?voice=cedar`, { headers: { "X-Sotto-Page": token } });
  let pws = null;
  for (let i = 0; i < 100 && !pws; i++) { await new Promise((r) => setTimeout(r, 5)); if (h.WS.instances.length > before) pws = h.WS.last(); }
  assert.ok(pws, "a preview socket was opened");
  assert.match(pws.url, /\/live\/sessions$/);
  await speakSentence(h.clock, pws, "cedar");
  for (let t2 = 0; t2 < 900; t2 += 100) { pws.receive(audio(quiet(100))); await h.clock.advance(100); }
  const res = await resP;
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "audio/wav");
  const wav = Buffer.from(await res.arrayBuffer());
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  pws.receive({ type: "session.closed", reason: "close_requested", usage: { seconds: 4 } });
  assert.ok(h.voice.todaySeconds() >= 4, "preview seconds count toward today's usage");

  // Cached: no new socket.
  const n = h.WS.instances.length;
  const again = await fetch(`${base}/api/voice-preview?voice=cedar`, { headers: { "X-Sotto-Page": token } });
  assert.equal(again.status, 200);
  assert.equal(h.WS.instances.length, n);
  // The live session is untouched.
  assert.equal(h.voice.state, "live");
  assert.equal(h.voice.live.voice, "marin");
  assert.equal(ws.sentOfType("session.close").length, 0);
});

test("GET /api/voice-preview without a key: 503 no_api_key, nothing opened", async (t) => {
  const h = await makeHarness({ env: {} });
  t.after(() => h.cleanup());
  const r = await h.voice.voicePreview("cedar");
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, "no_api_key");
  assert.equal(h.WS.instances.length, 0);
});

test("a session still silent 5.5 s after start is closed (after one nudge) and PreviewCache tries one new session", async (t) => {
  const clock = createFakeClock();
  const WS = createFakeWSClass();
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "clv-prev-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cache = new PreviewCache({ dir, log: noopLog, record: (voice) => recordPreview({ base: "https://api.openai.com/v1", apiKey: "k", voice, WebSocketImpl: WS, clock, log: noopLog }) });
  const p = cache.get("delta");
  const ws1 = WS.last();
  ws1.open();
  ws1.receive({ type: "session.started", session: { id: "live_stuck" } });
  for (let i = 0; i < 54; i++) { ws1.receive(audio(quiet(100))); await clock.advance(100); }
  assert.equal(ws1.sentOfType("session.instructions.append").length, 1, "nudged once at 3 s");
  assert.match(ws1.sentOfType("session.instructions.append")[0].content, /Say exactly: "Hi, I'm Delta\. This is how I sound\."/);
  assert.equal(ws1.sentOfType("session.close").length, 0);
  await clock.advance(200);
  assert.equal(ws1.sentOfType("session.close").length, 1, "stuck session closed");
  ws1.receive({ type: "session.closed", reason: "close_requested", usage: { seconds: 3 } });
  await clock.advance(0);
  const ws2 = WS.last();
  assert.notEqual(ws2, ws1, "a second session");
  await speakSentence(clock, ws2, "delta");
  for (let i = 0; i < 9; i++) { ws2.receive(audio(quiet(100))); await clock.advance(100); }
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(WS.instances.length, 2, "only one retry");
});
