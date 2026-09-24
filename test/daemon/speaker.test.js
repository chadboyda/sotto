// Speech queue (SPEC §6.10.2): a spoken update never cuts off the assistant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SpeechQueue, priorityOf, PRIORITY, SPEAK_HANGOVER_MS, COMMENTARY_PREROLL_MS, HOLD_MAX_MS, URGENT_WAIT_MS } from "../../daemon/speaker.js";
import { createFakeClock } from "../helpers/fake-clock.js";

function makeQ({ audioAt } = {}) {
  const clock = createFakeClock();
  const sent = [], demoted = [];
  const q = new SpeechQueue({ clock, send: (a) => sent.push(a), demote: (a) => demoted.push(a), audioAt });
  return { clock, q, sent, demoted };
}
const c = (source, content = source) => ({ kind: "commentary", content, delegationId: null, source });
/** The assistant says `text` for `ms` of session timeline (deltas every 200 ms, in real time). */
async function speak(clock, q, text, ms, t0 = 0) {
  const words = text.split(" ");
  const step = 200;
  for (let t = 0, i = 0; t < ms; t += step, i++) {
    q.onOutput((i ? " " : "") + (words[i % words.length] || ""), t0 + t, t0 + t + step);
    await clock.advance(step);
  }
}

test("priorities: answers/questions/approvals high, completions/progress low", () => {
  for (const s of ["voice_result", "background_voice", "question", "permission", "attention", "voice_notice"]) assert.equal(priorityOf(s), PRIORITY.high, s);
  for (const s of ["typed_result", "background_result", "progress_text", "completion", "idle", "tool_failure"]) assert.equal(priorityOf(s), PRIORITY.low, s);
  assert.equal(priorityOf(undefined), PRIORITY.normal);
  assert.equal(priorityOf("notice"), PRIORITY.normal);
});

test("quiet assistant: a commentary goes out at once", () => {
  const { q, sent } = makeQ();
  q.enqueue(c("typed_result"));
  assert.equal(sent.length, 1);
  assert.equal(q.size, 0);
});

test("the observed bug: an unrelated summary waits until the voice answer has been spoken", async () => {
  const { clock, q, sent } = makeQ();
  q.enqueue({ ...c("voice_result", "Claude Code's answer: long answer"), delegationId: "item_1" });
  assert.equal(sent.length, 1);
  await clock.advance(600);
  // The answer is being spoken (3 s later, an unrelated turn finishes).
  const speaking = speak(clock, q, "Here is what Claude found in the project files today", 6000);
  await clock.advance(0);
  q.enqueue(c("typed_result", "Claude Code finished: unrelated."));
  assert.equal(sent.length, 1, "held while the answer is spoken");
  await speaking;
  assert.equal(sent.length, 1, "still inside the hangover");
  await clock.advance(SPEAK_HANGOVER_MS + 300);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].content, "Claude Code finished: unrelated.");
});

test("pre-roll: a second commentary right after the first waits for the first to be spoken", async () => {
  const { clock, q, sent } = makeQ();
  q.enqueue(c("voice_result", "answer"));
  q.enqueue(c("completion", "done"));
  assert.equal(sent.length, 1);
  await clock.advance(COMMENTARY_PREROLL_MS - 300);
  assert.equal(sent.length, 1);
  await clock.advance(600);
  assert.equal(sent.length, 2, "no speech followed: released after the pre-roll");
});

test("held items are released highest priority first, FIFO within a priority", async () => {
  const { clock, q, sent } = makeQ();
  q.onOutput("Talking", 0, 400);
  q.enqueue(c("completion", "c1"));
  q.enqueue(c("typed_result", "t1"));
  q.enqueue(c("voice_result", "answer"));
  assert.equal(sent.length, 0);
  await clock.advance(400 + SPEAK_HANGOVER_MS + 300);
  assert.deepEqual(sent.map((a) => a.content), ["answer"]);
  await clock.advance(COMMENTARY_PREROLL_MS + 300);
  await clock.advance(COMMENTARY_PREROLL_MS + 300);
  assert.deepEqual(sent.map((a) => a.content), ["answer", "c1", "t1"]);
});

test("a question cuts in only at a sentence boundary", async () => {
  const { clock, q, sent } = makeQ();
  q.onOutput("So the build is", 0, 1000);
  q.enqueue(c("question", "Claude's asking: which layout?"));
  await clock.advance(300);
  assert.equal(sent.length, 0, "mid-sentence: wait");
  q.onOutput(" green.", 1000, 1400);
  await clock.advance(300);
  assert.equal(sent.length, 1, "sentence ended: the question goes out while speech continues");
});

test("a question waits at most URGENT_WAIT_MS for a boundary", async () => {
  const { clock, q, sent } = makeQ();
  const talk = speak(clock, q, "and then and then and then", 8000);
  await clock.advance(0);
  q.enqueue(c("permission", "approve?"));
  await clock.advance(URGENT_WAIT_MS - 400);
  assert.equal(sent.length, 0);
  await clock.advance(800);
  assert.equal(sent.length, 1);
  await talk;
});

test("an answer is not an urgent cut-in: it waits for quiet", async () => {
  const { clock, q, sent } = makeQ();
  q.onOutput("Sure.", 0, 500);
  q.enqueue(c("voice_result", "answer"));
  await clock.advance(300);
  assert.equal(sent.length, 0, "boundary alone does not release a non-urgent item");
  await clock.advance(500 + SPEAK_HANGOVER_MS);
  assert.equal(sent.length, 1);
});

test("low-priority items held over HOLD_MAX_MS become silent thinking; answers are never demoted", async () => {
  const { clock, q, sent, demoted } = makeQ();
  q.enqueue(c("voice_result", "first")); // occupies the voice (pre-roll)
  const talk = speak(clock, q, "a long monologue about nothing", HOLD_MAX_MS + 6000);
  await clock.advance(0);
  q.enqueue(c("completion", "agent done"));
  q.enqueue(c("voice_result", "second answer"));
  await clock.advance(HOLD_MAX_MS + 500);
  assert.deepEqual(demoted.map((a) => a.content), ["agent done"]);
  await talk;
  await clock.advance(SPEAK_HANGOVER_MS + 300);
  assert.deepEqual(sent.map((a) => a.content), ["first", "second answer"]);
});

test("transcript running ahead of playback: end_ms keeps the hold until the audio ends", async () => {
  const { clock, q, sent } = makeQ();
  // 8 s of speech transcribed within 400 ms of wall time.
  q.onOutput("One.", 0, 4000);
  await clock.advance(200);
  q.onOutput(" Two.", 4000, 8000);
  q.enqueue(c("typed_result"));
  await clock.advance(5000);
  assert.equal(sent.length, 0, "the audio is still playing");
  await clock.advance(3000 + SPEAK_HANGOVER_MS + 300);
  assert.equal(sent.length, 1);
});

test("output audio activity alone counts as speaking", async () => {
  let at = null;
  const { clock, q, sent } = makeQ({ audioAt: () => at });
  at = clock.now();
  q.enqueue(c("completion"));
  assert.equal(sent.length, 0);
  await clock.advance(SPEAK_HANGOVER_MS + 300);
  assert.equal(sent.length, 1);
});

test("drain returns held actions in arrival order and stops the timer", async () => {
  const { clock, q, sent } = makeQ();
  q.onOutput("Talking", 0, 400);
  q.enqueue(c("completion", "a"));
  q.enqueue(c("voice_result", "b"));
  assert.deepEqual(q.drain().map((a) => a.content), ["a", "b"]);
  await clock.advance(10000);
  assert.equal(sent.length, 0);
  assert.equal(clock.pending(), 0);
});

// ---- session swaps (voice switch, reconnect, expiry) ------------------------------------

test("swap: a commentary the old session already spoke is not queued again", async () => {
  const { clock, q, sent } = makeQ();
  q.enqueue(c("voice_result", "Claude Code's answer: the branch is banana."));
  assert.equal(sent.length, 1);
  await clock.advance(600);
  await speak(clock, q, "You're on the banana branch.", 1600); // the old session said it
  q.suspend();
  q.enqueue(c("voice_result", "Claude Code's answer: the branch is  banana.")); // same text again (e.g. re-routed)
  q.resume();
  await clock.advance(5000);
  assert.equal(sent.length, 1, "not re-spoken by the new session");
  assert.equal(q.size, 0);
});

test("swap: the last commentary is carried when the old session never spoke it", async () => {
  const { clock, q, sent } = makeQ();
  q.enqueue(c("voice_result", "Claude Code's answer: done."));
  assert.equal(sent.length, 1);
  await clock.advance(300); // session closed before any output
  q.suspend();
  assert.equal(q.size, 1, "carried");
  await clock.advance(3000);
  assert.equal(sent.length, 1, "held while suspended");
  q.resume({ prerollMs: COMMENTARY_PREROLL_MS }); // the greeting goes first
  assert.equal(sent.length, 1);
  await clock.advance(COMMENTARY_PREROLL_MS + 300);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].content, "Claude Code's answer: done.");
});

test("swap: items queued while suspended wait for the new session, in order, once each", async () => {
  const { clock, q, sent, demoted } = makeQ();
  q.suspend();
  q.enqueue(c("typed_result", "Claude finished: tests pass."));
  q.enqueue(c("typed_result", "Claude finished: tests pass."));
  q.enqueue(c("question", "Claude's asking: red or blue?"));
  await clock.advance(HOLD_MAX_MS + 1000); // no demotion while waiting for a session
  assert.equal(sent.length + demoted.length, 0);
  assert.equal(q.size, 2, "the duplicate was dropped");
  q.resume();
  assert.equal(sent[0].content, "Claude's asking: red or blue?");
  await clock.advance(COMMENTARY_PREROLL_MS + 300);
  assert.deepEqual(sent.map((a) => a.content), ["Claude's asking: red or blue?", "Claude finished: tests pass."]);
});

test("outside a swap, a repeated text is a new event and is spoken again", async () => {
  const { clock, q, sent } = makeQ();
  q.enqueue(c("permission", "Claude needs approval to run npm test."));
  await clock.advance(600);
  await speak(clock, q, "Claude needs approval.", 1000);
  await clock.advance(30000);
  q.enqueue(c("permission", "Claude needs approval to run npm test."));
  assert.equal(sent.length, 2);
});
