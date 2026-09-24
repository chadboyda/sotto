// Transcript mirror (SPEC §6.18), "Claude is waiting" (§6.10.3) and the
// delegation instructions (§8.1), replayed against real fragments from a
// session in which gpt-live-1 answered decisions itself instead of
// delegating them (test/fixtures/voice-decisions.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyLine, mirrorWants, Mirror, MIRROR_TAG, MIRROR_QUIET_MS } from "../../daemon/mirror.js";
import { awaitingQuestion } from "../../daemon/speech.js";
import { route, isAck } from "../../daemon/policy.js";
import { renderForPolicy, buildSeed } from "../../daemon/prompt.js";
import { delegationHarness } from "../helpers/delegation-harness.js";
import { makeHarness } from "../helpers/daemon-harness.js";

const FIX = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../fixtures/voice-decisions.json", import.meta.url)), "utf8"));
const OWNER = "/tmp/clv-owner-a.sock";

// ---- classifier ----------------------------------------------------------------
test("classifyLine: the undelegated lines of the real session are decisions or requests", () => {
  for (const t of [
    "Sotto is a clever name. I think it's gonna probably mean everyone",
    "And I agree with you, okay, the public repo is fine, then I guess we make like private uh, get-ignored folder with... the",
    "I'm fine keeping the... Private repo, but it'd be great to make this available to other... People...",
    "Awesome. Thanks. Let me know when you auto restart",
    "Why did that get cut off? Like, that, that seems like a bug that we need to fix",
    "I thought we picked Sotto",
    "Well, so, did we not agree on that",
    "It is repeated the last update twice. So that might be a bug",
  ]) assert.equal(classifyLine(t), "decision", t);
});

test("classifyLine: filler, noise and voice-only commands are never mirrored", () => {
  for (const t of ["Mm", "Awesome. Thanks.", "Hello", "Cool.", "What was", "Okay, yeah.", "Thank you so much"]) {
    assert.equal(classifyLine(t), "filler", t);
  }
  for (const t of ["我ん", "</", "...", ""]) assert.equal(classifyLine(t), "noise", JSON.stringify(t));
  for (const t of ["Can you say something, so I can hear the voice again", "could you slow down a bit", "say that again", "Hold on", "be quiet", "what did you just say"]) {
    assert.equal(classifyLine(t), "voice_only", t);
  }
  assert.equal(classifyLine("Excited to see your design updates"), "other");
  assert.equal(classifyLine("Should the"), "fragment", "a thought cut by a pause");
  for (const cls of ["noise", "filler", "voice_only", "fragment"]) for (const m of ["all", "decisions", "off"]) assert.equal(mirrorWants(cls, m), false);
  assert.equal(mirrorWants("other", "all"), true);
  assert.equal(mirrorWants("other", "decisions"), false);
  assert.equal(mirrorWants("decision", "decisions"), true);
  assert.equal(mirrorWants("decision", "off"), false);
});

test("classifyLine: a bare yes is filler, unless Claude is waiting for an answer", () => {
  assert.equal(classifyLine("Yeah."), "filler");
  assert.equal(classifyLine("Yeah.", { awaiting: true }), "decision");
  assert.equal(classifyLine("No"), "decision", "a no is never filler");
});

// ---- Mirror engine (pure, with the delegation harness) --------------------------------
function mirrorHarness({ mode = "all", awaiting = false } = {}) {
  const h = delegationHarness();
  h.mirrorSends = [];
  h.mirrorDone = [];
  h.mode = mode;
  h.awaiting = awaiting;
  h.mirror = new Mirror({
    clock: h.clock, transcript: h.transcript, delegation: h.engine,
    effects: {
      mode: () => h.mode, live: () => true, marker: () => "[sotto voice abc123]", awaiting: () => h.awaiting,
      send: async (m) => { h.mirrorSends.push(m); return { ok: true }; },
      sent: (r) => h.mirrorDone.push(r),
    },
  });
  h.engine.fx.claimMirror = () => h.mirror.claimRecent();
  /** Words as 200 ms fragments at session time startMs, with the clock following. */
  h.speak = async (text, startMs) => {
    let t = startMs;
    for (const w of text.split(" ")) {
      const due = t + 200 - (h.clock.now() - h.t0);
      if (due > 0) await h.clock.advance(due);
      h.transcript.add("user", " " + w, t, t + 200);
      h.mirror.onUserSpeech();
      t += 200;
    }
    return t;
  };
  h.t0 = h.clock.now();
  return h;
}

test("mirror: undelegated words go to Claude 6 s after the user stops, tagged, once", async () => {
  const h = mirrorHarness();
  const end = await h.speak("Sotto is a clever name, let's use it", 0);
  await h.clock.advance(MIRROR_QUIET_MS - 100);
  assert.equal(h.mirrorSends.length, 0, "not before 6 s of quiet");
  await h.clock.advance(200);
  assert.equal(h.mirrorSends.length, 1);
  assert.equal(h.mirrorSends[0].content, `[sotto voice abc123] ${MIRROR_TAG} Sotto is a clever name, let's use it`);
  assert.match(h.mirrorSends[0].msgId, /^clv-mirror-\d+$/);
  assert.equal(h.engine.consumedThroughMs, end, "consumed: a later delegation never re-sends them");
  await h.clock.advance(20000);
  assert.equal(h.mirrorSends.length, 1, "nothing is sent twice");
  // The next request carries only new words.
  await h.speak("what is failing in the tests", 30000);
  h.create("item_next", 31400);
  await h.clock.advance(700);
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].content, "[sotto voice] what is failing in the tests");
});

test("mirror: utterances within the quiet window are batched into one message", async () => {
  const h = mirrorHarness();
  await h.speak("I agree with you", 0);
  await h.speak("the public repo is fine", 4000); // 3.2 s later: timer re-armed
  await h.clock.advance(MIRROR_QUIET_MS + 100);
  assert.equal(h.mirrorSends.length, 1);
  assert.match(h.mirrorSends[0].content, /I agree with you the public repo is fine$/);
});

test("mirror: filler is not sent and stays for the next request's context", async () => {
  const h = mirrorHarness();
  await h.speak("Okay, cool.", 0);
  await h.clock.advance(MIRROR_QUIET_MS + 100);
  assert.equal(h.mirrorSends.length, 0);
  assert.equal(h.engine.consumedThroughMs, 0, "not consumed");
});

test("mirror: a delegation in progress takes the words; the mirror sends nothing", async () => {
  const h = mirrorHarness();
  await h.speak("rename the helper to parse config", 0);
  // The model delegates 5.5 s later and keeps collecting (quiet timer fires at 6 s).
  await h.clock.advance(5500);
  h.create("item_1", 1400);
  await h.clock.advance(3000);
  assert.equal(h.sends.length, 1);
  assert.match(h.sends[0].content, /rename the helper to parse config$/);
  await h.clock.advance(10000);
  assert.equal(h.mirrorSends.length, 0);
});

test("mirror: a delegation that arrives after the words were mirrored sends them as the request", async () => {
  const h = mirrorHarness();
  await h.speak("what's the idle timeout", 0);
  await h.clock.advance(MIRROR_QUIET_MS + 100);
  assert.equal(h.mirrorSends.length, 1);
  h.create("item_late", 1000);
  await h.clock.advance(700);
  assert.equal(h.sends.length, 1, "not dropped as empty");
  assert.equal(h.sends[0].content, `[sotto voice] Please act on and answer what I just said to the voice assistant: "what's the idle timeout"`);
  assert.equal(h.engine.get("item_late").status, "sent");
  assert.ok(!h.appends.some((a) => /didn't catch/.test(a.content)));
  // Claimed once: another empty delegation is a plain dropped_empty.
  h.create("item_again", 1000);
  await h.clock.advance(700);
  assert.equal(h.engine.get("item_again").status, "dropped_empty");
});

test("mirror: a late delegation of words Claude is already answering is closed quietly, not re-sent", async () => {
  const h = mirrorHarness();
  h.engine.fx.marker = () => "[sotto voice abc123]";
  await h.speak("what's the idle timeout", 0);
  await h.clock.advance(MIRROR_QUIET_MS + 100);
  // Claude picks the mirror up (its turn starts) before the model's late delegation.
  h.engine.onHook("UserPromptSubmit", { prompt: h.mirrorSends[0].content, prompt_id: "pm" });
  h.create("item_late", 1000);
  await h.clock.advance(700);
  assert.equal(h.sends.length, 0, "no second copy");
  assert.equal(h.engine.get("item_late").status, "mirrored");
  const note = h.appends.find((a) => a.id === "item_late");
  assert.equal(note.kind, "thinking");
  assert.match(note.content, /already reached Claude Code a moment ago/);
});

test("mirror: decisions mode sends only decisions; off sends nothing", async () => {
  const h = mirrorHarness({ mode: "decisions" });
  await h.speak("Excited to see your design updates", 0);
  await h.clock.advance(MIRROR_QUIET_MS + 100);
  assert.equal(h.mirrorSends.length, 0);
  await h.speak("Let me know when you auto restart", 20000);
  await h.clock.advance(MIRROR_QUIET_MS + 100);
  assert.equal(h.mirrorSends.length, 1);
  assert.match(h.mirrorSends[0].content, /\(said to the voice assistant, not delegated\) Let me know when you auto restart$/, "the earlier non-decision was judged once and not re-sent");
  const off = mirrorHarness({ mode: "off" });
  await off.speak("Let me know when you auto restart", 0);
  await off.clock.advance(MIRROR_QUIET_MS + 100);
  assert.equal(off.mirrorSends.length, 0);
});

test("mirror: an echo of the assistant is not sent", async () => {
  const h = mirrorHarness();
  let t = 0;
  for (const w of "The build is done and its pull request is open".split(" ")) { h.transcript.add("assistant", " " + w, t, t + 200); t += 200; }
  await h.speak("the build is done and its pull request is open", 300);
  await h.clock.advance(MIRROR_QUIET_MS + 100);
  assert.equal(h.mirrorSends.length, 0);
});

test("mirror: a reply quotes what the assistant had just said", async () => {
  const h = mirrorHarness();
  h.transcript.add("assistant", " The others are Viva, Roger and Sato. Tell me what you like.", 0, 3000);
  await h.clock.advance(3000);
  await h.speak("Sotto is a clever name", 6000);
  await h.clock.advance(MIRROR_QUIET_MS + 100);
  assert.equal(h.mirrorSends[0].content, `[sotto voice abc123] ${MIRROR_TAG} Sotto is a clever name\n(The voice assistant had just said: "The others are Viva, Roger and Sato. Tell me what you like.")`);
});

// ---- replays through the whole daemon (voice.js wiring) ---------------------------------
/** Feed fixture rows with the fake clock following the session timeline. */
async function replay(h, ws, rows) {
  const t0 = h.clock.now();
  for (const [role, text, start, end] of rows) {
    const due = end - (h.clock.now() - t0);
    if (due > 0) await h.clock.advance(due);
    if (role === "d") ws.receive({ type: "session.delegation.created", offset_ms: start, delegation: { id: text, type: "delegation", target: "client" } });
    else ws.receive({ type: role === "u" ? "session.input_transcript.delta" : "session.output_transcript.delta", delta: text, start_ms: start, end_ms: end });
  }
}

test("replay (naming decision): 'I agree…' and 'Sotto is a clever name' reach Claude, tagged, priority later", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  await replay(h, ws, FIX.naming);
  await h.clock.advance(MIRROR_QUIET_MS + 500);
  const nonce = h.voice.nonce;
  const requests = h.inboxSends.filter((m) => m.priority === "next");
  const mirrors = h.inboxSends.filter((m) => m.priority === "later");
  assert.equal(requests.length, 1, "the refract request was delegated by the model");
  assert.match(requests[0].content, /refract skill/);
  assert.equal(mirrors.length, 2, JSON.stringify(mirrors.map((m) => m.content)));
  assert.ok(mirrors[0].content.startsWith(`[sotto voice ${nonce}] ${MIRROR_TAG} And I agree with you`));
  assert.ok(mirrors[1].content.startsWith(`[sotto voice ${nonce}] ${MIRROR_TAG} Sotto is a clever name.`));
  assert.match(mirrors[1].content, /\(The voice assistant had just said: ".*Sato\. Tell me what you like\./, "context of the choice");
  for (const m of mirrors) assert.match(m.msgId, /^clv-mirror-/);
  assert.equal(h.voice.counters.mirror_sent, 2);
  // The voice model is told, so it can truthfully say Claude has it.
  const notes = ws.sent.filter((e) => e.type === "session.thinking.append" && /also passed to Claude Code as background/.test(e.content));
  assert.equal(notes.length, 2);
  assert.ok(h.log.entries.some((l) => l.ev === "mirror.send" && l.ok === true));
});

test("replay (restart request): 'Let me know when you auto restart' goes alone, the next request does not repeat it", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  await replay(h, ws, FIX.restart);
  await h.clock.advance(3500);
  const mirrors = h.inboxSends.filter((m) => m.priority === "later");
  const requests = h.inboxSends.filter((m) => m.priority === "next");
  assert.equal(mirrors.length, 1);
  assert.match(mirrors[0].content, /\) Awesome\. Thanks\. Let me know when you auto restart/);
  assert.equal(requests.length, 1);
  assert.match(requests[0].content, /API key/);
  assert.ok(!/auto restart/.test(requests[0].content), "never re-sent");
});

test("replay (bug report): 'Why did that get cut off…' is mirrored before the next request", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  await replay(h, ws, FIX.cutoff);
  await h.clock.advance(3500);
  const kinds = h.inboxSends.map((m) => m.priority);
  const mirror = h.inboxSends.find((m) => m.priority === "later");
  assert.ok(mirror, kinds.join(","));
  assert.match(mirror.content, /Why did that get cut off\? Like, that, that seems like a bug that we need to fix/);
  const last = h.inboxSends[h.inboxSends.length - 1];
  assert.equal(last.priority, "next");
  assert.match(last.content, /full duplex/);
  assert.ok(!/cut off\?/.test(last.content), "the bug report is not repeated in the duplex request");
});

test("mirror turn: its prompt marks no request delivered; its Stop is a mirror_result", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  const nonce = h.voice.nonce;
  const d = h.voice.delegation;
  // A voice request is in flight (sent, not yet delivered).
  ws.receive({ type: "session.input_transcript.delta", delta: " run the tests", start_ms: 0, end_ms: 800 });
  ws.receive({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "item_1", target: "client" } });
  await h.clock.advance(700);
  assert.equal(d.get("item_1").status, "sent");
  h.voice.handleHook("UserPromptSubmit", { prompt: `[sotto voice ${nonce}] ${MIRROR_TAG} I like the blue one`, prompt_id: "pm" }, OWNER);
  assert.equal(d.get("item_1").status, "sent", "a mirror is not the request's delivery");
  assert.equal(d.turns.get("pm").origin, "mirror");
});

test("mirror turn: 'Noted.' stays silent, an answer is spoken", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  const nonce = h.voice.nonce;
  h.voice.handleHook("UserPromptSubmit", { prompt: `[sotto voice ${nonce}] ${MIRROR_TAG} I like the blue one`, prompt_id: "pm" }, OWNER);
  h.voice.handleHook("Stop", { prompt_id: "pm", last_assistant_message: "Noted." }, OWNER);
  await h.clock.advance(100);
  const think = ws.sent.filter((e) => e.type === "session.thinking.append").map((e) => e.content);
  assert.ok(think.some((c) => /Claude Code has seen what the user just told you and had nothing to add/.test(c)));
  assert.ok(!ws.sent.some((e) => e.type === "session.commentary.append" && /Noted/.test(e.content)), "Noted is never spoken");
  h.voice.handleHook("UserPromptSubmit", { prompt: `[sotto voice ${nonce}] ${MIRROR_TAG} why did that get cut off, seems like a bug`, prompt_id: "pm2" }, OWNER);
  h.voice.handleHook("Stop", { prompt_id: "pm2", last_assistant_message: "Found it: the request window started too late. I fixed it and added a test." }, OWNER);
  await h.clock.advance(5000);
  assert.ok(ws.sent.some((e) => e.type === "session.commentary.append" && /^Claude Code, on what you just said: Found it/.test(e.content)));
});

// ---- routing -----------------------------------------------------------------------------
test("mirror_result: 'Noted.' is silent; a real answer is spoken briefly under every policy", () => {
  assert.equal(isAck("Noted."), true);
  assert.equal(isAck("Noted. I also filed the bug."), false);
  for (const p of ["quiet", "milestones", "walkthrough"]) {
    const a = route("mirror_result", p, { text: "Noted." });
    assert.deepEqual(a.map((x) => x.kind), ["thinking"]);
    const b = route("mirror_result", p, { text: "I recorded Sotto as the project name. I will use it in the new repo." });
    assert.equal(b[0].kind, "commentary");
    assert.match(b[0].content, /^Claude Code, on what you just said: I recorded Sotto as the project name/);
  }
});

// ---- Claude awaiting the user's answer (§6.10.3) ----------------------------------------
test("awaitingQuestion: trailing questions and option lists", () => {
  assert.equal(awaitingQuestion("Done. All tests pass."), null);
  assert.equal(awaitingQuestion("All green. Want me to open a PR?"), "Want me to open a PR?");
  assert.equal(awaitingQuestion("Which layout should I use:\n- A: dial\n- B: ring"), "Which layout should I use? Options: A: dial; B: ring.");
  assert.equal(awaitingQuestion("Names:\n\n1. **Hark**\n2. Sotto\n\nWhich do you like?"), "Which do you like?");
  assert.equal(awaitingQuestion("Here is code:\n```js\nif (a?) b\n```"), null);
  assert.equal(awaitingQuestion("| a | b? |"), null);
  assert.equal(awaitingQuestion(null), null);
});

test("Stop ending in a question: silent 'waiting for the answer' note, status, seed; the next prompt clears it", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  h.voice.handleHook("UserPromptSubmit", { prompt: "fix it", prompt_id: "p1" }, OWNER);
  h.voice.handleHook("Stop", { prompt_id: "p1", last_assistant_message: "Fixed. Should I also bump the version?" }, OWNER);
  await h.clock.advance(100);
  const note = ws.sent.find((e) => e.type === "session.thinking.append" && /waiting for the user's answer/.test(e.content));
  assert.ok(note);
  assert.match(note.content, /"Should I also bump the version\?".*delegate it/);
  assert.equal(h.voice.status().claude.awaiting_input, true);
  const seed = buildSeed({ project: "p", cwd: "/p", branch: "main", awaiting: h.voice.awaiting.text });
  assert.match(seed, /Claude Code is waiting for the user's answer to: Should I also bump the version\?/);
  h.voice.handleHook("UserPromptSubmit", { prompt: "yes", prompt_id: "p2" }, OWNER);
  assert.equal(h.voice.status().claude.awaiting_input, false);
  assert.ok(ws.sent.some((e) => e.type === "session.thinking.append" && /no longer waiting for an answer/.test(e.content)));
});

test("AskUserQuestion also marks Claude as waiting", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  await h.goLive();
  h.voice.handleHook("PreToolUse", { prompt_id: "p1", tool_name: "AskUserQuestion", tool_use_id: "tu1", tool_input: { questions: [{ question: "Which color?", options: [{ label: "Red" }, { label: "Blue" }] }] } }, OWNER);
  assert.equal(h.voice.awaiting.via, "ask");
  assert.match(h.voice.awaiting.text, /^Which color\? Options: Red or Blue\.$/);
});

// ---- instructions (§8.1) and the voice switch guard ----------------------------------------
test("instructions: decisions, feedback and casual requests are delegated; no false promises", () => {
  const t = renderForPolicy("sotto", "milestones");
  const del = t.slice(t.indexOf("Delegate to the backend when:"), t.indexOf("Do not delegate to the backend when:"));
  for (const re of [/makes a decision, states a preference, agrees or disagrees, approves or rejects something, picks an option or a name, or answers a question Claude Code asked/,
    /gives feedback, reports a bug/, /even casually or in passing/, /When in doubt, delegate\./]) assert.match(del, re);
  assert.match(t, /Never say you have noted, recorded, marked, saved, scheduled or started something, or that you told or asked Claude Code something, unless you delegated it just now\./);
  assert.match(t, /Never promise to tell the user something later unless you delegated it\./);
  assert.match(t, /"I'll pass that to Claude"/);
  assert.match(t, /never delegate a change you merely suggested, or after silence or noise/);
  const dont = t.slice(t.indexOf("Do not delegate to the backend when:"));
  assert.match(dont, /The user only greets you, makes small talk, or thanks you\./);
});

test("voice switch guard (replay): an offer the user never answered sends nothing; the explicit request is sent", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  // 23:03:22 the assistant offered Gleam; at 23:03:39 it delegated with no user words.
  ws.receive({ type: "session.output_transcript.delta", delta: "Want me to try Gleam?", start_ms: 0, end_ms: 1500 });
  await h.clock.advance(12000);
  ws.receive({ type: "session.delegation.created", offset_ms: 13000, delegation: { id: "item_offer", target: "client" } });
  await h.clock.advance(3500);
  assert.equal(h.voice.delegation.get("item_offer").status, "dropped_empty");
  assert.equal(h.inboxSends.length, 0, "no voice switch reaches Claude from the model's own offer");
  await h.clock.advance(10000);
  assert.equal(h.inboxSends.length, 0, "the mirror has nothing to send either");
  // 23:03:46 "I didn't say anything. Switch to claim" (gleam, misheard): the user's own request.
  let at = 30000;
  for (const w of "I didn't say anything. Switch to claim".split(" ")) { ws.receive({ type: "session.input_transcript.delta", delta: " " + w, start_ms: at, end_ms: at + 200 }); at += 200; }
  ws.receive({ type: "session.delegation.created", offset_ms: at, delegation: { id: "item_switch", target: "client" } });
  await h.clock.advance(3500);
  assert.equal(h.inboxSends.length, 1);
  assert.match(h.inboxSends[0].content, /Switch to claim/);
  assert.equal(h.inboxSends[0].priority, "next");
});
