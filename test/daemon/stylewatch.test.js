// Style watch on the voice's own speech (SPEC §8.1 "How you talk").
// Replays of what the voice said live on 2026-09-24.
import { test } from "node:test";
import assert from "node:assert/strict";
import { StyleWatch, findings, repeatedPhrase, closingKey, openerKey, isBannedOpener, correction, UTTERANCE_GAP_MS, CORRECTION_GAP_MS } from "../../daemon/stylewatch.js";
import { createFakeClock } from "../helpers/fake-clock.js";
import { makeHarness } from "../helpers/daemon-harness.js";

// Verbatim output transcripts, 22:01 to 22:31 (daemon log), one per utterance.
const LIVE_TAGS = [
  "Another agent finished. Still no action needed.",
  "Another two are done: a flaky test rerun and a PR description tweak. No action for you on those.",
  "One more: it just finished finding a stale check in the voice code. No action for you.",
  "And a quick CI check finished for PR 15. That's behind the scenes, no action on your side.",
  "And the AirPods capture rate fix report just went through. No action for you.",
  "Two more are done: a version bump check and native snapshots. Still no action from you.",
  "And another background test fix just finished. Nothing for you to do.",
];
const LIVE_REPEAT = "No input needed from you. No input needed from you. No input needed from yo-";
const LIVE_OPENERS = ["You're right, I did say that, and it was wrong of me.", "You're right, that line was repeated again.", "Right, that's fair, I'll keep it shorter from now on."];

/** Feed utterances as output deltas, a pause between them; returns the corrections sent. */
async function replay(lines, { gap = 3000 } = {}) {
  const clock = createFakeClock();
  const sent = [];
  const w = new StyleWatch({ clock, correct: (text, f) => sent.push({ text, ...f }) });
  for (const line of lines) {
    for (const word of line.split(/(?<= )/)) { w.onOutput(word); await clock.advance(50); }
    await clock.advance(gap);
  }
  return { sent, w, clock };
}

test("replay: the stock tag line after every background update gets one correction, then at most one reminder", async () => {
  const { sent } = await replay(LIVE_TAGS, { gap: 20000 });
  assert.equal(sent.length, 2, JSON.stringify(sent.map((s) => s.phrase)));
  assert.deepEqual(sent.map((s) => s.why), ["tagline", "tagline"]);
  assert.equal(sent[0].why, "tagline");
  assert.match(sent[0].text, /You keep adding tag lines like "no action needed"\. Stop: never close an update with a reassurance, and if nothing is needed from the user, say nothing about it\./);
  assert.match(sent[0].text, /don't answer it or mention it/);
});

test("replay: \"No input needed from you\" three times in one breath is a repeat and a tag line", async () => {
  const f = findings(LIVE_REPEAT);
  assert.deepEqual(f.map((x) => x.why).sort(), ["repeat", "tagline"]);
  assert.equal(repeatedPhrase(LIVE_REPEAT), "No input needed from you");
  const { sent, clock, w } = await replay([LIVE_REPEAT]);
  assert.equal(sent.length, 1, "one correction now; the other waits for the gap");
  await clock.advance(CORRECTION_GAP_MS);
  w.onOutput("Okay. ");
  await clock.advance(UTTERANCE_GAP_MS + 10);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((s) => s.why).sort(), ["repeat", "tagline"]);
});

test("replay: reflexive agreement openers are banned; a repeated opener is caught", async () => {
  for (const o of LIVE_OPENERS) assert.ok(isBannedOpener(o), o);
  for (const o of ["You're absolutely right.", "Sorry, my mistake.", "Great question.", "Claude Code's answer: done.", "Update: the tests pass.", "That's fair.", "Fair point, I'll change it.", "Certainly, here it is."]) assert.ok(isBannedOpener(o), o);
  for (const o of ["The tests pass.", "Oh nice, all green.", "Hm, that's annoying.", "Right now Claude's on the parser.", "Yes, I can hear you."]) assert.ok(!isBannedOpener(o), o);
  const { sent } = await replay(LIVE_OPENERS, { gap: 20000 });
  assert.equal(sent[0].why, "opener");
  assert.match(sent[0].text, /You started a reply with "You're right"\. Don't open with reflexive agreement, apology or a stock phrase, and don't start two replies the same way: acknowledge feedback at most once per topic/);
  // Same opener twice (not banned): caught once.
  const f = findings("Okay so the parser tests pass and it's merged.", ["Okay so the build is green now and the app is signed."]);
  assert.deepEqual(f, [{ why: "opener", phrase: "okay so" }]);
});

test("a natural conversation gets no corrections", async () => {
  const { sent } = await replay([
    "Hey, I'm connected to Claude in sotto.",
    "Sure, I'll pass that to Claude.",
    "Oh nice, the parser tests pass now, and it's merged.",
    "Hm, that's annoying. Two tests failed on the date parsing.",
    "Claude wants to run a shell command. It needs your approval in the terminal.",
    "Yes, I can hear you.",
    "We fixed the wake bug, so normal speech wakes it now. Want the details?",
  ], { gap: 20000 });
  assert.deepEqual(sent, []);
});

test("closing and opener keys", () => {
  assert.equal(closingKey("Two more are done. Still no action from you."), "no action from you");
  assert.equal(closingKey("That's behind the scenes, no action on your side."), "no action on your side");
  assert.equal(openerKey("You're right, I did."), "", "too short to judge");
  assert.equal(openerKey("You're right, I did say that."), "you're right");
  assert.match(correction({ why: "repeat", phrase: "x y z" }), /Say each thing once/);
});

test("voice: a tag line in the output transcript sends one silent instructions append", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  const n0 = ws.sent.filter((e) => e.type === "session.instructions.append").length;
  let at = 1000;
  for (const line of LIVE_TAGS.slice(0, 3)) {
    for (const w of line.split(" ")) { ws.receive({ type: "session.output_transcript.delta", delta: w + " ", start_ms: at, end_ms: at + 200 }); at += 200; await h.clock.advance(100); }
    await h.clock.advance(20000);
  }
  const ins = ws.sent.filter((e) => e.type === "session.instructions.append").slice(n0);
  assert.equal(ins.length, 1);
  assert.match(ins[0].content, /You keep adding tag lines like "no action needed"/);
  assert.ok(h.log.find("style.correction").length === 1);
  assert.equal(ws.sent.filter((e) => e.type === "session.commentary.append").length, 0, "a correction is never spoken");
});
