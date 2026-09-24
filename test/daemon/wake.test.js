// Idle sleep and automatic wake (SPEC §6.15): the pure decision and governor,
// the voice lifecycle with a fake clock, wake-clip transcription + injection
// (mocked OpenAI), notify wakes, and never sleeping while Claude is busy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, SESSION } from "../helpers/daemon-harness.js";
import { createFakeClock } from "../helpers/fake-clock.js";
import { sleepDecision, WakeGovernor, idleSecondsOf, MIN_AWAKE_MS, COOLDOWNS_MS, BOOST_STEP_DB, MAX_BOOST_DB } from "../../daemon/wake.js";
import { transcribeClip, transcribeWithFallback, cleanTranscript, decodeWavB64, wavDurationMs, wakeInstruction } from "../../daemon/transcribe.js";
import { greeting, buildSeed } from "../../daemon/prompt.js";
import { joinUserFragments } from "../../daemon/transcript.js";

const OWNER = "/tmp/clv-owner-a.sock";
const appends = (ws, kind) => ws.sent.filter((e) => e.type === `session.${kind}.append`);

/** A tiny valid 16 kHz mono PCM16 WAV of `ms` milliseconds, base64. */
function wavB64(ms = 500) {
  const n = Math.round((16000 * ms) / 1000);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  return b.toString("base64");
}

/** Harness with a connected page (sleeping needs someone to listen for the wake). */
async function harness(t, { transcript = "what files are in this project", transcribeStatus = 200 } = {}) {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  h.d.sse.clients.add({ write() {}, end() {} });
  h.transcribeCalls = [];
  let live = 0;
  h.setFetch(async (url, init) => {
    if (String(url).endsWith("/audio/transcriptions")) {
      h.transcribeCalls.push({ url, model: init.body.get("model"), file: init.body.get("file"), prompt: init.body.get("prompt"), auth: init.headers.Authorization });
      return { status: transcribeStatus, text: async () => JSON.stringify(transcribeStatus === 200 ? { text: transcript } : { error: { message: "nope" } }) };
    }
    h.fetchCalls.push({ url, init, body: JSON.parse(init.body) });
    return { status: 201, text: async () => JSON.stringify({ session: { id: `live_w_${++live}` }, transport: { type: "webrtc", sdp: "v=0 answer" } }) };
  });
  return h;
}

/** Let the session idle into sleep and confirm the close. */
async function sleepNow(h, ws, ms) {
  await h.clock.advance(ms);
  assert.equal(ws.sentOfType("session.close").length, 1, "session.close sent");
  h.closeReply(ws, "close_requested", Math.round(ms / 1000));
  await h.clock.advance(0);
}

// ---- pure decision -----------------------------------------------------------------
test("sleepDecision: idle, min awake, speaking grace, busy, disabled, false wake", () => {
  const base = { now: 100_000, idleMs: 60_000, liveStartedAt: 0, lastUserAt: 30_000, lastAssistantAt: 35_000 };
  assert.equal(sleepDecision(base), "idle", "65 s since the last speech");
  assert.equal(sleepDecision({ ...base, lastUserAt: 50_000 }), null, "only 50 s");
  assert.equal(sleepDecision({ ...base, lastPageActivityAt: 45_000 }), null, "local speech counts");
  assert.equal(sleepDecision({ ...base, busy: true }), null, "never while a voice request is pending");
  assert.equal(sleepDecision({ ...base, idleMs: 0 }), null, "0 disables idle sleep");
  assert.equal(sleepDecision({ ...base, idleMs: 1000, liveStartedAt: 90_000, lastUserAt: 0, lastAssistantAt: 0 }), null, "min awake: 15 s are billed anyway");
  assert.equal(sleepDecision({ ...base, lastAssistantAt: 99_000 }), null, "the model is speaking");
  // Woken by voice with no words heard: sleep once the prepaid 15 s are used.
  const fw = { now: MIN_AWAKE_MS, idleMs: 60_000, liveStartedAt: 0, wokeBy: "voice", heardUser: false };
  assert.equal(sleepDecision(fw), "false_wake");
  assert.equal(sleepDecision({ ...fw, now: MIN_AWAKE_MS - 1 }), null);
  assert.equal(sleepDecision({ ...fw, heardUser: true }), null, "words heard: a normal idle period");
  assert.equal(sleepDecision({ ...fw, wokeBy: "notify" }), null, "notify wakes are never false");
  assert.equal(sleepDecision({ ...fw, busy: true }), null);
});

test("WakeGovernor: false wakes raise the bar and back off; a real wake relaxes it", () => {
  const clock = createFakeClock();
  const g = new WakeGovernor({ clock });
  assert.deepEqual(g.pageConfig("medium", true), { enabled: true, sensitivity: "medium", boost_db: 0, not_before: 0 });
  g.onWake("voice");
  assert.equal(g.wokeBy, "voice");
  g.onSleep("false_wake");
  assert.equal(g.boostDb, BOOST_STEP_DB);
  assert.equal(g.pageConfig("medium", true).not_before, clock.now() + COOLDOWNS_MS[1]);
  for (let i = 0; i < 6; i++) { g.onWake("voice"); g.onSleep("false_wake"); }
  assert.equal(g.boostDb, MAX_BOOST_DB, "capped");
  assert.equal(g.pageConfig("medium", true).not_before, clock.now() + COOLDOWNS_MS[COOLDOWNS_MS.length - 1]);
  assert.equal(g.stats.false_wakes, 7);
  g.onWake("voice");
  g.onHeardUser();
  assert.equal(g.consecutiveFalse, 0);
  assert.equal(g.boostDb, MAX_BOOST_DB - BOOST_STEP_DB / 2);
  assert.equal(g.pageConfig("medium", true).not_before, 0);
  g.onSleep("idle");
  assert.equal(g.stats.sleeps, 8);
  assert.equal(g.pageConfig("off", true).enabled, false);
});

test("idleSecondsOf: idle_seconds wins; legacy idle_minutes converts; default 60", () => {
  assert.equal(idleSecondsOf({ idle_seconds: 90, idle_minutes: 5 }), 90);
  assert.equal(idleSecondsOf({ idle_minutes: 5 }), 300);
  assert.equal(idleSecondsOf({}), 60);
  assert.equal(idleSecondsOf({ idle_seconds: 0 }), 0);
});

// ---- lifecycle ---------------------------------------------------------------------
test("idle: sleeps (not paused) when a page is listening, after 60 s of silence", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive();
  await h.clock.advance(58_000);
  assert.equal(ws.sentOfType("session.close").length, 0);
  await sleepNow(h, ws, 2_000);
  assert.equal(h.voice.state, "sleeping");
  assert.ok(h.commands().includes("disconnect:idle"));
  const ps = h.voice.pageStatus();
  assert.equal(ps.state, "sleeping");
  assert.deepEqual(ps.wake, { enabled: true, sensitivity: "medium", boost_db: 0, not_before: 0 });
  assert.equal(ps.idle_seconds, 60);
  assert.equal(h.voice.status().wake.sleeps, 1);
  assert.equal(h.log.find("idle.close")[0].sleep, true);
});

test("idle without a page, or with wake off, is a plain pause", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive({ config: { idle_seconds: 30 } });
  await sleepNow(h, ws, 30_000);
  assert.equal(h.voice.state, "paused");

  const h2 = await harness(t);
  const ws2 = await h2.goLive({ config: { idle_seconds: 30, wake_sensitivity: "off" } });
  await sleepNow(h2, ws2, 30_000);
  assert.equal(h2.voice.state, "paused");
});

test("turning wake off while sleeping pauses; the page can change sensitivity", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive({ config: { idle_seconds: 20 } });
  await sleepNow(h, ws, 20_000);
  h.voice.handlePage({ type: "set_wake", sensitivity: "high" });
  assert.equal(h.voice.pageStatus().wake.sensitivity, "high");
  h.voice.handlePage({ type: "set_wake", sensitivity: "bogus" });
  assert.equal(h.voice.config.wake_sensitivity, "high");
  h.voice.handlePage({ type: "set_wake", sensitivity: "off" });
  assert.equal(h.voice.state, "paused");
});

test("never sleeps while Claude works on a voice request; sleeps once it is answered and quiet", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive({ config: { idle_seconds: 20 } });
  ["what", "branch", "am", "I", "on"].forEach((w, i) => ws.receive({ type: "session.input_transcript.delta", delta: " " + w, start_ms: 1000 + i * 200, end_ms: 1200 + i * 200 }));
  ws.receive({ type: "session.delegation.created", offset_ms: 2000, delegation: { id: "item_1", type: "delegation", target: "client" } });
  await h.clock.advance(700);
  const rec = h.voice.delegation.get("item_1");
  h.voice.handleHook("UserPromptSubmit", { prompt: rec.content, prompt_id: "p1" }, OWNER);
  await h.clock.advance(5 * 60_000);
  assert.equal(ws.sentOfType("session.close").length, 0, "Claude still working: stay awake");
  assert.equal(h.voice.state, "live");
  h.voice.handleHook("Stop", { last_assistant_message: "You are on main.", prompt_id: "p1" }, OWNER);
  await h.clock.advance(3000);
  ws.receive({ type: "session.output_transcript.delta", delta: " You're on main.", start_ms: 1, end_ms: 2 });
  await h.clock.advance(19_000);
  assert.equal(ws.sentOfType("session.close").length, 0, "the answer was just spoken");
  await h.clock.advance(2_000);
  assert.equal(ws.sentOfType("session.close").length, 1);
});

test("no sleep before 15 s even with a tiny idle timeout (the create bills 15 s)", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive({ config: { idle_seconds: 2 } });
  await h.clock.advance(14_000);
  assert.equal(ws.sentOfType("session.close").length, 0);
  await h.clock.advance(2_000);
  assert.equal(ws.sentOfType("session.close").length, 1);
});

// ---- voice wake --------------------------------------------------------------------
test("voice wake: seed says so, no greeting, the clip is transcribed and injected before the model answers", async (t) => {
  const h = await harness(t);
  let ws = await h.goLive({ config: { idle_seconds: 20 } });
  ws.receive({ type: "session.output_transcript.delta", delta: " Hi there.", start_ms: 1, end_ms: 2 });
  await sleepNow(h, ws, 25_000);
  assert.equal(h.voice.state, "sleeping");

  ws = await h.goLive({ reason: "wake" });
  assert.equal(h.voice.state, "live");
  const seed = h.fetchCalls[1].body.session.input[0].content[0].text;
  assert.match(seed, /Voice session: woke from sleep because the user started speaking/);
  assert.match(seed, /The user said|You said: Hi there\./, "earlier voice history is seeded");
  assert.equal(appends(ws, "instructions").length, 0, "no greeting: the user is already talking");

  h.voice.handlePage({ type: "wake_audio", session_id: h.voice.live.id, audio: wavB64(1200), clip_ms: 1200 });
  await h.clock.advance(0);
  assert.equal(h.transcribeCalls.length, 1);
  assert.equal(h.transcribeCalls[0].model, "gpt-transcribe");
  assert.match(h.transcribeCalls[0].prompt, /proj-a/);
  const ins = appends(ws, "instructions");
  assert.equal(ins.length, 1);
  assert.match(ins[0].content, /What they said: "what files are in this project"/);
  assert.equal(ins[0].delegation_id, null);
  assert.ok(h.sse.some((m) => m.type === "wake_heard" && m.text === "what files are in this project"));
  const tr = h.log.find("wake.transcribe")[0];
  assert.equal(tr.ok, true);
  assert.equal(tr.clip_ms, 1200);
  assert.ok(!JSON.stringify(h.log.entries || h.log.find("wake.transcribe")).includes("sk-test-key"), "no key in logs");

  // The model delegates; the request text starts with the words it never heard live.
  ws.receive({ type: "session.input_transcript.delta", delta: " please", start_ms: 300, end_ms: 600 });
  ws.receive({ type: "session.delegation.created", offset_ms: 700, delegation: { id: "item_w", type: "delegation", target: "client" } });
  await h.clock.advance(2100);
  const rec = h.voice.delegation.get("item_w");
  assert.equal(rec.status, "sent");
  assert.equal(rec.text, "what files are in this project please");
  assert.match(h.inboxSends[0].content, /what files are in this project please$/);

  // Words were heard: not a false wake, so it does not sleep at 15 s.
  assert.equal(h.voice.governor.heardUser, true);
  assert.equal(h.voice.status().wake.wakes_voice, 1);
});

test("a second wake_audio, or one for another session, is ignored", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive({ reason: "wake" });
  h.voice.handlePage({ type: "wake_audio", session_id: "live_other", audio: wavB64() });
  await h.clock.advance(0);
  assert.equal(h.transcribeCalls.length, 0);
  h.voice.handlePage({ type: "wake_audio", session_id: h.voice.live.id, audio: wavB64() });
  h.voice.handlePage({ type: "wake_audio", session_id: h.voice.live.id, audio: wavB64() });
  await h.clock.advance(0);
  assert.equal(h.transcribeCalls.length, 1);
  assert.equal(appends(ws, "instructions").length, 1);
});

test("false wake: nothing heard → sleep at 15 s, boost the page threshold, back off", async (t) => {
  const h = await harness(t, { transcript: "" });
  let ws = await h.goLive({ reason: "wake" });
  h.voice.handlePage({ type: "wake_audio", session_id: h.voice.live.id, audio: wavB64() });
  await h.clock.advance(0);
  assert.match(appends(ws, "instructions")[0].content, /Nothing intelligible was captured/);
  assert.equal(h.sse.filter((m) => m.type === "wake_heard").length, 0);
  await h.clock.advance(MIN_AWAKE_MS - 2000);
  assert.equal(ws.sentOfType("session.close").length, 0);
  await sleepNow(h, ws, 3000); // next 2 s idle tick after 15 s
  assert.equal(h.voice.state, "sleeping");
  const w = h.voice.pageStatus().wake;
  assert.equal(w.boost_db, BOOST_STEP_DB);
  assert.equal(w.not_before, h.clock.now() + COOLDOWNS_MS[1]);
  assert.equal(h.voice.status().wake.false_wakes, 1);
  assert.equal(h.log.find("idle.close").at(-1).detail, "false_wake");

  // Next wake hears words: the bar relaxes.
  ws = await h.goLive({ reason: "wake" });
  ws.receive({ type: "session.input_transcript.delta", delta: " hello", start_ms: 1, end_ms: 2 });
  assert.equal(h.voice.pageStatus().wake.boost_db, BOOST_STEP_DB / 2);
  assert.equal(h.voice.pageStatus().wake.not_before, 0);
});

test("the clip never arrives: a 'nothing captured' note after 12 s", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive({ reason: "wake" });
  await h.clock.advance(11_000);
  assert.equal(appends(ws, "instructions").length, 0);
  await h.clock.advance(1_000);
  assert.equal(appends(ws, "instructions").length, 1);
  assert.match(appends(ws, "instructions")[0].content, /Nothing intelligible/);
  assert.equal(h.log.find("wake.inject")[0].via, "timeout");
});

test("transcription failure falls back to the second model, then to the note", async (t) => {
  const h = await harness(t, { transcribeStatus: 404 });
  const ws = await h.goLive({ reason: "wake" });
  h.voice.handlePage({ type: "wake_audio", session_id: h.voice.live.id, audio: wavB64() });
  await h.clock.advance(0);
  assert.deepEqual(h.transcribeCalls.map((c) => c.model), ["gpt-transcribe", "gpt-4o-mini-transcribe"]);
  assert.match(appends(ws, "instructions")[0].content, /Nothing intelligible/);
  h.voice.handlePage({ type: "wake_audio", session_id: "x", audio: "not base64 wav" });
});

test("invalid clip: no transcription call, still a note", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive({ reason: "wake" });
  h.voice.handlePage({ type: "wake_audio", session_id: h.voice.live.id, audio: Buffer.from("hello").toString("base64") });
  await h.clock.advance(0);
  assert.equal(h.transcribeCalls.length, 0);
  assert.equal(appends(ws, "instructions").length, 1);
  assert.equal(h.log.find("wake.audio_invalid").length, 1);
});

test("wake latency report from the page is logged (numbers only)", async (t) => {
  const h = await harness(t);
  h.voice.handlePage({ type: "wake_timing", onset_to_live_ms: 2012.4, live_to_first_output_ms: 900, evil: "x", Bad: 3 });
  assert.deepEqual(h.log.find("wake.timing")[0], { ...h.log.find("wake.timing")[0], onset_to_live_ms: 2012, live_to_first_output_ms: 900 });
  assert.equal(h.log.find("wake.timing")[0].evil, undefined);
  assert.equal(h.log.find("wake.timing")[0].Bad, undefined);
});

// ---- notify wake -------------------------------------------------------------------
test("a permission prompt while sleeping wakes a session that says it (no greeting, no double seed)", async (t) => {
  const h = await harness(t);
  let ws = await h.goLive({ config: { idle_seconds: 20 } });
  await sleepNow(h, ws, 20_000);
  h.voice.handleHook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf build" } }, OWNER);
  assert.ok(h.commands().includes("connect:notify"), h.commands().join(","));
  assert.equal(h.voice.status().wake.queued, 1);
  assert.ok(h.sse.some((m) => m.type === "result_pending"), "also shown on the page");
  // A second event while the wake is pending does not send a second command.
  h.voice.notifyUser("Also: tests finished.");
  assert.equal(h.commands().filter((c) => c === "connect:notify").length, 1);

  ws = await h.goLive({ reason: "notify" });
  await h.clock.advance(6000); // the speech queue (§6.10.2) releases one item at a time
  const seed = h.fetchCalls[1].body.session.input[0].content[0].text;
  assert.match(seed, /woke from sleep to tell the user something/);
  assert.doesNotMatch(seed, /Result that arrived while voice was paused/, "flushed as commentary instead");
  const said = appends(ws, "commentary");
  assert.equal(said.length, 2);
  assert.match(said[0].content, /waiting for your approval in the terminal/);
  assert.equal(said[0].delegation_id, null);
  assert.equal(said[1].content, "Also: tests finished.");
  assert.equal(appends(ws, "instructions").length, 0);
  assert.equal(h.voice.status().wake.queued, 0);
  assert.equal(h.voice.status().wake.wakes_notify, 1);
  // A notify wake is never a false wake: it sleeps after a normal idle period.
  await h.clock.advance(10_000);
  assert.equal(ws.sentOfType("session.close").length, 0);
});

test("notify without a page, or with the cap reached, only leaves the result pending", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive({ config: { idle_seconds: 20 } });
  await sleepNow(h, ws, 20_000);
  h.d.sse.clients.clear();
  assert.equal(h.voice.notifyUser("Build finished."), "queued");
  assert.ok(!h.commands().includes("connect:notify"));
  assert.equal(h.voice.pendingResult.text, "Build finished.");
});

test("a notify wake the page ignores times out and keeps the result pending", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive({ config: { idle_seconds: 20 } });
  await sleepNow(h, ws, 20_000);
  h.voice.notifyUser("Claude has a question for you.");
  await h.clock.advance(30_000);
  assert.equal(h.voice.status().wake.queued, 0);
  assert.equal(h.log.find("wake.request_timeout").length, 1);
  assert.equal(h.voice.pendingResult.text, "Claude has a question for you.");
});

test("typed results while sleeping do not wake (the user is at the terminal)", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive({ config: { idle_seconds: 20 } });
  await sleepNow(h, ws, 20_000);
  h.voice.deliver({ kind: "commentary", content: "Claude Code finished: done.", source: "typed_result" });
  assert.ok(!h.commands().includes("connect:notify"));
  assert.equal(h.voice.status().wake.queued, 0);
  assert.equal(h.voice.pendingResult.text, "Claude Code finished: done.");
});

test("notifyUser while live speaks at once", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive();
  assert.equal(h.voice.notifyUser("Heads up."), "spoken");
  assert.equal(appends(ws, "commentary").at(-1).content, "Heads up.");
  assert.equal(h.voice.notifyUser("  "), "pending");
});

// ---- prompt + transcription helpers ------------------------------------------------
test("prompt: no greeting for wake/notify; seed reason text", () => {
  assert.equal(greeting("wake", "milestones", "p"), null);
  assert.equal(greeting("notify", "quiet", "p"), null);
  assert.match(buildSeed({ project: "p", cwd: "/x/p", reason: "wake" }), /woke from sleep because the user started speaking/);
  assert.match(buildSeed({ project: "p", cwd: "/x/p", reason: "notify" }), /woke from sleep to tell the user/);
});

test("transcribeClip: multipart request, key only in the header, errors mapped", async () => {
  const clock = createFakeClock();
  const wav = decodeWavB64(wavB64(1000));
  assert.equal(wavDurationMs(wav), 1000);
  let seen;
  const ok = await transcribeClip({
    base: "https://api.test/v1", apiKey: "sk-secret", wav, clock, prompt: "ctx",
    fetchImpl: async (url, init) => { seen = { url, init }; return { status: 200, text: async () => '{"text":"  hello   there "}' }; },
  });
  assert.deepEqual([ok.ok, ok.text, ok.model], [true, "hello there", "gpt-transcribe"]);
  assert.equal(seen.url, "https://api.test/v1/audio/transcriptions");
  assert.equal(seen.init.headers.Authorization, "Bearer sk-secret");
  assert.equal(seen.init.body.get("model"), "gpt-transcribe");
  assert.equal(seen.init.body.get("prompt"), "ctx");
  const bad = await transcribeClip({ base: "b", apiKey: "sk-secret", wav, clock, fetchImpl: async () => ({ status: 401, text: async () => '{"error":{"message":"bad key sk-secret"}}' }) });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);
  const net = await transcribeClip({ base: "b", apiKey: "k", wav, clock, fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  assert.equal(net.code, "network");
  const fb = await transcribeWithFallback({ base: "b", apiKey: "k", wav, clock, fetchImpl: async (u, i) => ({ status: i.body.get("model") === "gpt-transcribe" ? 404 : 200, text: async () => '{"text":"hi"}' }) });
  assert.deepEqual([fb.ok, fb.text, fb.model, fb.fallback_from], [true, "hi", "gpt-4o-mini-transcribe", "gpt-transcribe"]);
});

test("transcribeClip times out", async () => {
  const clock = createFakeClock();
  const p = transcribeClip({
    base: "b", apiKey: "k", wav: decodeWavB64(wavB64()), clock, timeoutMs: 1000,
    fetchImpl: (u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))),
  });
  await clock.advance(1000);
  const r = await p;
  assert.equal(r.code, "timeout");
});

test("cleanTranscript, decodeWavB64, wakeInstruction", () => {
  assert.equal(cleanTranscript(" ... "), null);
  assert.equal(cleanTranscript(""), null);
  assert.equal(cleanTranscript(" Hi,  Claude "), "Hi, Claude");
  assert.equal(decodeWavB64("aGVsbG8="), null);
  assert.equal(decodeWavB64(123), null);
  assert.ok(decodeWavB64(wavB64()));
  assert.match(wakeInstruction("run the tests"), /What they said: "run the tests"/);
  assert.match(wakeInstruction("run the tests"), /delegate it to Claude Code/);
  assert.match(wakeInstruction(null), /Nothing intelligible/);
});

test("joinUserFragments drops the words repeated at the clip/live seam", () => {
  const P = (text) => ({ text, prefix: true });
  const L = (text) => ({ text });
  // Measured in the e2e: clip "Hey, can you" + live "Can you ask Claude what files…"
  assert.equal(joinUserFragments([P("Hey, can you "), L(" Can"), L(" you ask Claude"), L(" what files")]), "Hey, can you ask Claude what files");
  assert.equal(joinUserFragments([P("run the"), L(" tests please")]), "run the tests please", "no overlap");
  assert.equal(joinUserFragments([P("run the tests")]), "run the tests");
  assert.equal(joinUserFragments([L(" a"), L(" b")]), " a b", "no prefix: unchanged");
  assert.equal(joinUserFragments([]), "");
});

test("SESSION helper still binds (sanity)", async (t) => {
  const h = await harness(t);
  h.on(SESSION());
  assert.equal(h.voice.owner.project, "proj-a");
});
