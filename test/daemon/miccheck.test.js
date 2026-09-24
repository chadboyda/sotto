// Mic checks, "can't hear you" and repeated greetings (SPEC §7.5, §8.1, §8.3, §6.18).
// Seen live 2026-09-24: the page used a webcam mic across the room, the user
// said "Hello? Hello? ... it's like barely working", and the voice handed that
// to Claude and waited instead of answering; each reopen greeted with the same
// full sentence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderForPolicy, greeting, cantHearInstruction, CANT_HEAR_LINE, RECENT_GREETINGS } from "../../daemon/prompt.js";
import { classifyLine, mirrorWants } from "../../daemon/mirror.js";
import { makeHarness } from "../helpers/daemon-harness.js";

const appends = (ws, kind) => ws.sent.filter((e) => e.type === `session.${kind}.append`);

test("instructions: mic checks are answered by the voice, never delegated", () => {
  const t = renderForPolicy("sotto", "milestones");
  assert.match(t, /Mic checks are yours to answer, right away/);
  assert.match(t, /"Yes, I can hear you\."/);
  assert.match(t, /Never hand a mic check to Claude Code, and never say you will check with Claude\./);
  const dont = t.slice(t.indexOf("Do not delegate to the backend when:"));
  assert.match(dont, /checks the mic or the connection: "hello\?", "can you hear me\?", "testing", "is this working\?", "are you there\?"/);
  const del = t.slice(t.indexOf("Delegate to the backend when:"), t.indexOf("Do not delegate to the backend when:"));
  // The round-2 guarantees stay: feedback and doubt still go to Claude.
  assert.match(del, /gives feedback, reports a bug/);
  assert.match(del, /When in doubt, delegate\. Greetings and mic checks are never in doubt: answer them yourself\./);
});

test("mirror: pure mic checks and greetings are not mirrored; project feedback still is", () => {
  for (const t of [
    "Hello? Hello? Hello? Hello? Wow, it's like barely working",
    "Can you hear me?",
    "Is this thing on?",
    "Testing, testing, one two three",
    "It's not hearing my voice at all",
  ]) {
    assert.equal(classifyLine(t), "mic_check", t);
    for (const m of ["all", "decisions"]) assert.equal(mirrorWants("mic_check", m), false);
  }
  assert.equal(classifyLine("Hello"), "filler");
  assert.equal(classifyLine("Hello, can you fix the failing tests"), "decision");
  assert.equal(classifyLine("the build is barely working, can you hear me"), "decision", "project words keep it a real line");
});

test("greeting: a start within minutes of the last one is short and varied", () => {
  assert.match(greeting("start", "milestones", "dev"), /connected to Claude Code in dev/);
  assert.equal(greeting("start", "milestones", "dev", { recent: 1 }), `Say only "${RECENT_GREETINGS[0]}" Then stop and listen.`);
  assert.equal(greeting("start", "milestones", "dev", { recent: 2 }), `Say only "${RECENT_GREETINGS[1]}" Then stop and listen.`);
  assert.notEqual(greeting("start", "walkthrough", "dev", { recent: 1 }), greeting("start", "walkthrough", "dev", { recent: 2 }));
  assert.equal(greeting("start", "quiet", "dev", { recent: 3 }), 'Say only "Ready." Then stop and listen.');
  assert.equal(greeting("reconnect", "milestones", "dev", { recent: 1 }), null);
});

async function startAgain(h, ws) {
  const p = h.voice.pause("pause");
  h.closeReply(ws);
  await p;
  const r = await h.voice.createSession({ sdp: "x", reason: "start" });
  assert.equal(r.status, 201);
  const ws2 = h.WS.last();
  ws2.open();
  ws2.receive({ type: "session.started", session: {} });
  return ws2;
}

test("daemon: reopening within 5 minutes does not repeat the full greeting", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive({ config: { idle_seconds: 0 } });
  assert.match(appends(ws, "instructions")[0].content, /Greet the user in one short sentence/);
  await h.clock.advance(60_000);
  const ws2 = await startAgain(h, ws);
  assert.equal(appends(ws2, "instructions")[0].content, `Say only "${RECENT_GREETINGS[0]}" Then stop and listen.`);
  await h.clock.advance(60_000);
  const ws3 = await startAgain(h, ws2);
  assert.equal(appends(ws3, "instructions")[0].content, `Say only "${RECENT_GREETINGS[1]}" Then stop and listen.`);
  await h.clock.advance(6 * 60_000);
  const ws4 = await startAgain(h, ws3);
  assert.match(appends(ws4, "instructions")[0].content, /Greet the user in one short sentence/, "after a real break, the full greeting again");
});

test("daemon: cant_hear is logged and spoken once", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive({ config: { idle_seconds: 0 } });
  const before = appends(ws, "instructions").length;
  h.voice.handlePage({ type: "cant_hear", kind: "silent", input_label: "OBSBOT Meet 2 Microphone", peak_rms: 0.001, speech_ms: 0, since_ms: 20000 });
  const logged = h.log.find("page.cant_hear");
  assert.equal(logged.length, 1);
  assert.equal(logged[0].lvl, "warn");
  assert.equal(logged[0].input, "OBSBOT Meet 2 Microphone");
  assert.equal(logged[0].kind, "silent");
  const said = appends(ws, "instructions").slice(before);
  assert.equal(said.length, 1);
  assert.equal(said[0].content, cantHearInstruction());
  assert.ok(said[0].content.includes(CANT_HEAR_LINE));
  // Again in the same session (or a new one within 10 minutes): logged, not spoken.
  h.voice.handlePage({ type: "cant_hear", kind: "no_transcript", input_label: "OBSBOT Meet 2 Microphone" });
  assert.equal(h.log.find("page.cant_hear").length, 2);
  assert.equal(appends(ws, "instructions").length, before + 1);
  await h.clock.advance(60_000);
  const ws2 = await startAgain(h, ws);
  const n2 = appends(ws2, "instructions").length;
  h.voice.handlePage({ type: "cant_hear", kind: "silent", input_label: "x" });
  assert.equal(appends(ws2, "instructions").length, n2, "at most once per 10 minutes");
  await h.clock.advance(11 * 60_000);
  h.voice.handlePage({ type: "cant_hear", kind: "silent", input_label: "x" });
  assert.equal(appends(ws2, "instructions").length, n2 + 1);
});

test("daemon: cant_hear while not live is only logged", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  h.voice.handlePage({ type: "cant_hear", kind: "silent", input_label: "x" });
  assert.equal(h.log.find("page.cant_hear").length, 1);
});
