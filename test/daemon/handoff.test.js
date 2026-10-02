// Handoff guard (SPEC §6.20): a spoken handoff with no delegation is sent by
// the daemon (A), wake-clip words that are a request reach Claude (B), the
// voice stays awake while Claude works for it, mirrors included (C), a reply
// wakes a sleeping voice, mirror replies included (D), and "I'll be right
// here" holds the session while Claude is busy (E), and any turn holds it
// while a typed reply wakes it (F). Replays of the live log of
// 2026-09-28 (0.4.7) with a fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "../helpers/daemon-harness.js";
import { isHandoffClaim, isWaitingClaim, clipWantsDelegation } from "../../daemon/handoff.js";
import { MIRROR_TAG, MIRROR_QUIET_MS } from "../../daemon/mirror.js";
import { VOICE_WAIT_MAX_MS } from "../../daemon/delegation.js";
import { WAKE_SOURCES } from "../../daemon/wake.js";

const OWNER = "/tmp/clv-owner-a.sock";
const appends = (ws, kind) => ws.sent.filter((e) => e.type === `session.${kind}.append`);
const requests = (h) => h.inboxSends.filter((m) => m.priority === "next");
const mirrors = (h) => h.inboxSends.filter((m) => m.priority === "later");

function wavB64(ms = 1500) {
  const n = Math.round((16000 * ms) / 1000);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  return b.toString("base64");
}

/** Harness with a listening page (so idle sleeps) and a mocked transcription. */
async function harness(t, { clip = "How's it looking?" } = {}) {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  h.d.sse.clients.add({ write() {}, end() {} });
  let live = 0;
  h.setFetch(async (url, init) => {
    if (String(url).endsWith("/audio/transcriptions")) return { status: 200, text: async () => JSON.stringify({ text: clip }) };
    h.fetchCalls.push({ url, init, body: JSON.parse(init.body) });
    return { status: 201, text: async () => JSON.stringify({ session: { id: `live_h_${++live}` }, transport: { type: "webrtc", sdp: "v=0 answer" } }) };
  });
  return h;
}

/** Words as the Live API streams them: one delta per word, 200 ms apart. */
function say(ws, role, text, startMs) {
  text.split(" ").forEach((w, i) => ws.receive({
    type: role === "user" ? "session.input_transcript.delta" : "session.output_transcript.delta",
    delta: " " + w, start_ms: startMs + i * 200, end_ms: startMs + (i + 1) * 200,
  }));
}

async function sleepNow(h, ws) {
  assert.equal(ws.sentOfType("session.close").length, 1, "session.close sent");
  h.closeReply(ws, "close_requested", 30);
  await h.clock.advance(0);
  assert.equal(h.voice.state, "sleeping");
}

// ---- pure rules ------------------------------------------------------------------------

test("isHandoffClaim: the live log's lines and persona handoff lines; past tense and results are not", () => {
  for (const s of [
    " Mm, yeah. Passing that to Claude now.",
    " Hello. I'm asking Claude about the verdict now. I'll be right here with you.",
    "Mm, I'll pass that to Claude. Stay with me a sec.",
    "Let me check with Claude.",
    "Claude's on it.",
    "Of course. I'm sending it to Claude now; I'll stay right here.",
    "Handed off.",
    "Sending it over. We'll know soon.",
    "[laugh] Yeah, let's check. Tossing that to Claude.", // e2e, 2026-09-28
  ]) assert.equal(isHandoffClaim(s), true, s);
  for (const s of [
    "Claude said the tests pass.", "Claude finished the build.", "I've sent that to Claude.",
    "I asked Claude earlier; it's done.", "Claude is still working on it.", "Yes, I can hear you.", "",
  ]) assert.equal(isHandoffClaim(s), false, s);
});

test("isWaitingClaim: 'I'll be right here' and friends", () => {
  assert.equal(isWaitingClaim("I'll be right here with you."), true);
  assert.equal(isWaitingClaim("Stay with me a sec."), true);
  assert.equal(isWaitingClaim("I'll let you know when it's done."), true);
  assert.equal(isWaitingClaim("Sure, the build is green."), false);
});

test("clipWantsDelegation: questions and requests yes; fillers, mic checks, voice-only no", () => {
  for (const s of ["How's it looking?", "So, what's the verdict?", "Why do you keep falling asleep?", "what files are in this project", "run the tests"]) assert.equal(clipWantsDelegation(s), true, s);
  for (const s of ["Hello?", "hello", "okay", "slow down", "testing one two", "", "Hmm?"]) assert.equal(clipWantsDelegation(s), false, s);
});

test("mirror_result and typed_result wake a sleeping voice (D, F); background work does not", () => {
  assert.ok(WAKE_SOURCES.has("mirror_result"));
  assert.ok(WAKE_SOURCES.has("voice_result"));
  assert.ok(WAKE_SOURCES.has("typed_result"));
  assert.ok(!WAKE_SOURCES.has("background_result"));
});

// ---- A: a spoken handoff with no delegation --------------------------------------------

test("A: 'Passing that to Claude now.' with no delegation: the daemon sends the words as a request, tracks and speaks the answer", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive({ config: { idle_seconds: 20 } });
  say(ws, "user", "can you check the build status", 1000);
  await h.clock.advance(1500);
  say(ws, "assistant", "Mm, yeah. Passing that to Claude now.", 2600);
  await h.clock.advance(1900);
  assert.equal(requests(h).length, 0, "the model gets its grace period first");
  await h.clock.advance(200);
  const sent = requests(h);
  assert.equal(sent.length, 1, "sent as a request, not a background mirror");
  assert.equal(sent[0].content, `[sotto voice ${h.voice.nonce}] can you check the build status`);
  const fb = h.log.find("handoff.fallback");
  assert.equal(fb.length, 1);
  assert.equal(fb[0].reason, "fallback");
  assert.match(fb[0].said, /Passing that to Claude/);
  assert.equal(h.voice.counters.handoff_fallbacks, 1);
  // The model is told the truth, with no delegation id it never issued.
  const note = appends(ws, "thinking").find((e) => /Request sent to Claude Code: "can you check the build status"/.test(e.content));
  assert.ok(note);
  assert.equal(note.delegation_id, null);
  // The mirror does not send the same words again.
  await h.clock.advance(MIRROR_QUIET_MS + 1000);
  assert.equal(mirrors(h).length, 0);

  // Tracked like a delegation: delivered, answered, spoken.
  const rec = h.voice.delegation.records.find((r) => r.synthetic);
  assert.equal(rec.status, "sent");
  h.voice.handleHook("UserPromptSubmit", { prompt: rec.content, prompt_id: "p1" }, OWNER);
  assert.equal(rec.status, "delivered");
  // Claude works longer than the idle timeout: the voice stays awake (C).
  await h.clock.advance(3 * 60_000);
  assert.equal(ws.sentOfType("session.close").length, 0);
  h.voice.handleHook("Stop", { last_assistant_message: "The build is green.", prompt_id: "p1" }, OWNER);
  await h.clock.advance(3000);
  assert.equal(rec.status, "answered");
  const said = appends(ws, "commentary").map((e) => e.content).join(" | ");
  assert.match(said, /build is green/);
  assert.ok(appends(ws, "commentary").every((e) => e.delegation_id === null));
});

test("A: a handoff line said with a real delegation sends nothing extra", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive({ config: { idle_seconds: 20 } });
  say(ws, "user", "run the unit tests please", 1000);
  await h.clock.advance(1100);
  ws.receive({ type: "session.delegation.created", offset_ms: 2000, delegation: { id: "item_1", type: "delegation", target: "client" } });
  say(ws, "assistant", "Sending it to Claude now.", 2200);
  await h.clock.advance(5000);
  assert.equal(requests(h).length, 1);
  assert.equal(h.log.find("handoff.fallback").length, 0);
  assert.equal(h.log.find("handoff.delegated").length, 1);
});

test("A: a handoff line with nothing unsent (already delegated) sends nothing", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive({ config: { idle_seconds: 20 } });
  say(ws, "user", "run the unit tests please", 1000);
  await h.clock.advance(1100);
  ws.receive({ type: "session.delegation.created", offset_ms: 2000, delegation: { id: "item_1", type: "delegation", target: "client" } });
  await h.clock.advance(10_000);
  // Much later the model repeats itself, with no new words from the user.
  say(ws, "assistant", "I'll let Claude know.", 12_000);
  await h.clock.advance(3000);
  assert.equal(requests(h).length, 1);
  assert.equal(h.log.find("handoff.covered").length, 1);
});

test("A: the model delegates after the daemon sent the words: no second send, no 'didn't catch that'", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive({ config: { idle_seconds: 20 } });
  say(ws, "user", "what branch am I on", 1000);
  await h.clock.advance(1000);
  say(ws, "assistant", "Asking Claude now.", 2000);
  await h.clock.advance(2100);
  assert.equal(requests(h).length, 1);
  ws.receive({ type: "session.delegation.created", offset_ms: 4000, delegation: { id: "item_late", type: "delegation", target: "client" } });
  await h.clock.advance(3500);
  assert.equal(requests(h).length, 1, "not sent twice");
  assert.equal(h.voice.delegation.get("item_late").status, "mirrored");
  assert.ok(!appends(ws, "commentary").some((e) => /didn't catch/.test(e.content)));
  assert.ok(appends(ws, "thinking").some((e) => e.delegation_id === "item_late" && /already reached Claude Code/.test(e.content)));
});

// ---- B: the words that woke the voice --------------------------------------------------

test("B: wake clip 'How's it looking?' and no delegation: it reaches Claude as a request", async (t) => {
  const h = await harness(t, { clip: "How's it looking?" });
  const ws = await h.goLive({ reason: "wake" });
  h.voice.handlePage({ type: "wake_audio", session_id: h.voice.live.id, audio: wavB64(), clip_ms: 1500 });
  await h.clock.advance(0);
  assert.equal(h.log.find("wake.inject")[0].route, true);
  // As in the live log (20:04): the model answers in speech, no delegation.
  await h.clock.advance(2800);
  say(ws, "assistant", "Mm, yeah. Passing that to Claude now.", 2800);
  await h.clock.advance(100);
  assert.equal(requests(h).length, 0, "the model gets its chance first");
  await h.clock.advance(200);
  assert.equal(requests(h).length, 1);
  assert.equal(requests(h)[0].content, `[sotto voice ${h.voice.nonce}] How's it looking?`);
  const fb = h.log.find("handoff.fallback");
  assert.equal(fb.length, 1);
  assert.equal(fb[0].reason, "wake_clip");
  assert.equal(h.voice.delegation.records.find((r) => r.synthetic).status, "sent");
  // The spoken handoff line then finds nothing left to send.
  await h.clock.advance(2500);
  assert.equal(requests(h).length, 1);
  assert.equal(h.log.find("handoff.covered").length, 1);
});

test("B: the model says nothing (live log 20:12): the clip is sent at the 8 s cap", async (t) => {
  const h = await harness(t, { clip: "So, what's the verdict?" });
  await h.goLive({ reason: "wake" });
  h.voice.handlePage({ type: "wake_audio", session_id: h.voice.live.id, audio: wavB64(), clip_ms: 1500 });
  await h.clock.advance(7900);
  assert.equal(requests(h).length, 0, "waiting for the model or the cap");
  await h.clock.advance(200);
  assert.equal(requests(h).length, 1);
  assert.match(requests(h)[0].content, /So, what's the verdict\?$/);
});

test("B: the user keeps talking after the clip: wait for them, then send all of it", async (t) => {
  const h = await harness(t, { clip: "So, what's the verdict" });
  const ws = await h.goLive({ reason: "wake" });
  h.voice.handlePage({ type: "wake_audio", session_id: h.voice.live.id, audio: wavB64(), clip_ms: 1500 });
  await h.clock.advance(2000);
  say(ws, "user", "on the flaky test", 2000);
  await h.clock.advance(1200);
  say(ws, "user", "from this morning", 3200);
  await h.clock.advance(1000);
  assert.equal(requests(h).length, 0, "still talking");
  say(ws, "assistant", "Good question.", 4400);
  await h.clock.advance(1600);
  assert.equal(requests(h).length, 1);
  assert.match(requests(h)[0].content, /So, what's the verdict on the flaky test from this morning$/);
});

test("B: a clip the model delegates itself is not sent twice; a mic-check clip is not routed", async (t) => {
  const h = await harness(t, { clip: "run the tests" });
  const ws = await h.goLive({ reason: "wake" });
  h.voice.handlePage({ type: "wake_audio", session_id: h.voice.live.id, audio: wavB64(), clip_ms: 1500 });
  await h.clock.advance(500);
  ws.receive({ type: "session.delegation.created", offset_ms: 1000, delegation: { id: "item_w", type: "delegation", target: "client" } });
  await h.clock.advance(6000);
  assert.equal(requests(h).length, 1);
  assert.equal(h.voice.delegation.get("item_w").status, "sent");
  assert.equal(h.log.find("handoff.fallback").length, 0);

  const h2 = await harness(t, { clip: "Hello?" });
  await h2.goLive({ reason: "wake" });
  h2.voice.handlePage({ type: "wake_audio", session_id: h2.voice.live.id, audio: wavB64(), clip_ms: 1500 });
  await h2.clock.advance(12_000);
  assert.equal(h2.log.find("wake.inject")[0].route, false);
  assert.equal(requests(h2).length, 0);
});

// ---- C/D: mirror turns hold the voice, and their answer wakes it ------------------------

test("C: a mirrored message Claude is answering keeps the voice awake until its Stop (live log 20:12-20:14)", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive({ config: { idle_seconds: 20 } });
  say(ws, "user", "so what's the verdict", 1000);
  await h.clock.advance(MIRROR_QUIET_MS + 1000);
  assert.equal(mirrors(h).length, 1);
  assert.ok(mirrors(h)[0].content.includes(MIRROR_TAG));
  h.voice.handleHook("UserPromptSubmit", { prompt: mirrors(h)[0].content, prompt_id: "m1" }, OWNER);
  await h.clock.advance(4 * 60_000);
  assert.equal(ws.sentOfType("session.close").length, 0, "Claude is answering the user's words: stay awake");
  h.voice.handleHook("Stop", { last_assistant_message: "The verdict: all 874 tests pass.", prompt_id: "m1" }, OWNER);
  await h.clock.advance(3000);
  assert.match(appends(ws, "commentary").map((e) => e.content).join(" "), /874 tests pass/);
  await h.clock.advance(25_000);
  assert.equal(ws.sentOfType("session.close").length, 1, "answered and quiet: sleeps");
});

test("C/D: after the 10 min bound it may sleep, and the mirror's answer wakes it and is spoken", async (t) => {
  const h = await harness(t);
  let ws = await h.goLive({ config: { idle_seconds: 20 } });
  say(ws, "user", "so what's the verdict", 1000);
  await h.clock.advance(MIRROR_QUIET_MS + 1000);
  h.voice.handleHook("UserPromptSubmit", { prompt: mirrors(h)[0].content, prompt_id: "m1" }, OWNER);
  await h.clock.advance(VOICE_WAIT_MAX_MS - 10_000);
  assert.equal(ws.sentOfType("session.close").length, 0);
  await h.clock.advance(15_000);
  await sleepNow(h, ws);
  h.voice.handleHook("Stop", { last_assistant_message: "The verdict: ship it.", prompt_id: "m1" }, OWNER);
  await h.clock.advance(3000);
  assert.ok(h.commands().includes("connect:notify"), h.commands().join(","));
  assert.equal(h.log.find("wake.queue")[0].source, "mirror_result");
  ws = await h.goLive({ reason: "notify" });
  await h.clock.advance(3000);
  assert.match(appends(ws, "commentary").map((e) => e.content).join(" "), /ship it/);
});

test("C: a mirror Claude answers with 'Noted.' does not wake a sleeping voice", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive({ config: { idle_seconds: 20 } });
  say(ws, "user", "I think the blue one looks nicer", 1000);
  await h.clock.advance(MIRROR_QUIET_MS + 1000);
  h.voice.handleHook("UserPromptSubmit", { prompt: mirrors(h)[0].content, prompt_id: "m1" }, OWNER);
  h.voice.handleHook("Stop", { last_assistant_message: "Noted.", prompt_id: "m1" }, OWNER);
  await h.clock.advance(25_000);
  await sleepNow(h, ws);
  assert.ok(!h.commands().includes("connect:notify"));
});

test("D: a fallback request answered while the voice sleeps wakes it (like a delegation)", async (t) => {
  const h = await harness(t);
  let ws = await h.goLive({ config: { idle_seconds: 20 } });
  say(ws, "user", "check the deploy", 1000);
  await h.clock.advance(1000);
  say(ws, "assistant", "Passing that to Claude now.", 2000);
  await h.clock.advance(2500);
  const rec = h.voice.delegation.records.find((r) => r.synthetic);
  h.voice.handleHook("UserPromptSubmit", { prompt: rec.content, prompt_id: "p1" }, OWNER);
  await h.clock.advance(VOICE_WAIT_MAX_MS + 5000);
  await sleepNow(h, ws);
  h.voice.handleHook("Stop", { last_assistant_message: "The deploy finished.", prompt_id: "p1" }, OWNER);
  await h.clock.advance(3000);
  assert.ok(h.commands().includes("connect:notify"));
  ws = await h.goLive({ reason: "notify" });
  await h.clock.advance(3000);
  assert.match(appends(ws, "commentary").map((e) => e.content).join(" "), /deploy finished/);
});

// ---- E: "I'll be right here" ------------------------------------------------------------

test("E: 'I'll be right here with you' while Claude is busy holds the voice until the reply", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive({ config: { idle_seconds: 20 } });
  // Claude is busy with a turn the voice did not start (typed).
  h.voice.handleHook("UserPromptSubmit", { prompt: "refactor the parser", prompt_id: "t1" }, OWNER);
  say(ws, "assistant", "Claude's still on the parser. I'll be right here with you.", 1000);
  await h.clock.advance(2 * 60_000);
  assert.equal(ws.sentOfType("session.close").length, 0, "the voice said it would wait");
  h.voice.handleHook("Stop", { last_assistant_message: "Parser refactored.", prompt_id: "t1" }, OWNER);
  await h.clock.advance(30_000);
  assert.equal(ws.sentOfType("session.close").length, 1);
});

// ---- F: any turn holds the voice; a typed reply wakes it ---------------------------------

test("F: a typed turn holds the voice awake past the idle timeout (live log 2026-10-02 06:58), then it sleeps", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive({ config: { idle_seconds: 20 } });
  h.voice.handleHook("UserPromptSubmit", { prompt: "refactor the parser", prompt_id: "t1" }, OWNER);
  await h.clock.advance(3 * 60_000);
  assert.equal(ws.sentOfType("session.close").length, 0, "Claude is mid-turn: stay awake");
  h.voice.handleHook("Stop", { last_assistant_message: "Parser refactored.", prompt_id: "t1" }, OWNER);
  await h.clock.advance(3000);
  assert.match(appends(ws, "commentary").map((e) => e.content).join(" "), /Parser refactored/);
  await h.clock.advance(25_000);
  assert.equal(ws.sentOfType("session.close").length, 1, "answered and quiet: sleeps");
});

test("F: the mod's turn.start holds the voice like a classic turn; turn.complete releases it", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive({ config: { idle_seconds: 20 } });
  h.voice.onModTurn({ phase: "start" });
  await h.clock.advance(2 * 60_000);
  assert.equal(ws.sentOfType("session.close").length, 0);
  h.voice.onModTurn({ phase: "complete", reason: "completed", ms: 120_000 });
  await h.clock.advance(25_000);
  assert.equal(ws.sentOfType("session.close").length, 1);
});

test("F: the hold is bounded at 10 min from the turn's start (a lost Stop never holds forever)", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive({ config: { idle_seconds: 20 } });
  h.voice.onModTurn({ phase: "start" });
  // More busy signals in the same turn do not restart the bound.
  await h.clock.advance(5 * 60_000);
  h.voice.handleHook("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "u1" }, OWNER);
  await h.clock.advance(VOICE_WAIT_MAX_MS - 5 * 60_000 - 10_000);
  assert.equal(ws.sentOfType("session.close").length, 0);
  assert.equal(h.voice.delegation.claudeBusy, true);
  await h.clock.advance(15_000);
  await sleepNow(h, ws);
});

test("F: a typed reply under milestones wakes a sleeping voice and is spoken briefly", async (t) => {
  const h = await harness(t);
  let ws = await h.goLive({ config: { idle_seconds: 20, speaking_policy: "milestones" } });
  await h.clock.advance(25_000);
  await sleepNow(h, ws);
  h.voice.handleHook("UserPromptSubmit", { prompt: "refactor the parser", prompt_id: "t1" }, OWNER);
  h.voice.handleHook("Stop", { last_assistant_message: "Parser refactored into three modules. Then a long second sentence about `src/parser.ts` that is not spoken.", prompt_id: "t1" }, OWNER);
  await h.clock.advance(3000);
  assert.ok(h.commands().includes("connect:notify"), h.commands().join(","));
  assert.equal(h.log.find("wake.queue")[0].source, "typed_result");
  ws = await h.goLive({ reason: "notify" });
  await h.clock.advance(3000);
  const said = appends(ws, "commentary").map((e) => e.content).join(" ");
  assert.match(said, /Parser refactored into three modules/);
  assert.doesNotMatch(said, /second sentence/);
});

test("F: under the quiet policy a typed reply does not wake the voice (it stays pending)", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive({ config: { idle_seconds: 20, speaking_policy: "quiet" } });
  await h.clock.advance(25_000);
  await sleepNow(h, ws);
  h.voice.handleHook("UserPromptSubmit", { prompt: "refactor the parser", prompt_id: "t1" }, OWNER);
  h.voice.handleHook("Stop", { last_assistant_message: "Parser refactored.", prompt_id: "t1" }, OWNER);
  await h.clock.advance(3000);
  assert.ok(!h.commands().includes("connect:notify"), h.commands().join(","));
  assert.equal(h.log.find("wake.queue").length, 0);
});
