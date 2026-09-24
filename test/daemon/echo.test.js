// Transcript echo filter (daemon/echo.js, SPEC §6.8.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeEcho, sameWord, soundKey } from "../../daemon/echo.js";
import { Transcript, joinUserFragments } from "../../daemon/transcript.js";
import { collectRequest } from "../../daemon/delegation.js";
import { createFakeClock } from "../helpers/fake-clock.js";

/** Fragments of `text`, one word per 200 ms from session time `startMs`, wall time following. */
function frags(text, startMs, t0 = 0) {
  let t = startMs;
  return text.split(" ").map((w) => { const f = { text: " " + w, start_ms: t, end_ms: t + 200, at: t0 + t + 200 }; t += 200; return f; });
}
const said = (r) => joinUserFragments(r.frags).replace(/\s+/g, " ").trim();

test("sameWord: ASR spellings of the same word", () => {
  assert.equal(soundKey("claude"), soundKey("cloud"));
  assert.ok(sameWord("claude", "cloud"));
  assert.ok(sameWord("two", "2"));
  assert.ok(sameWord("migration", "migrations"));
  assert.ok(!sameWord("cat", "cut"));
  assert.ok(!sameWord("tests", "rest"));
});

test("a word-for-word echo, 300 ms behind the assistant, is echo", () => {
  const a = frags("I'll check the current git branch for you", 0);
  const r = analyzeEcho(frags("I'll check the current git branch", 300), { session: a });
  assert.equal(r.verdict, "echo");
  assert.equal(r.runs[0].src, "session");
  assert.ok(r.runs[0].delay_ms >= 200 && r.runs[0].delay_ms <= 400, String(r.runs[0].delay_ms));
});

test("echo with ASR differences (cloud/Claude, a dropped word) is still echo", () => {
  const a = frags("Claude Code finished the database migration and all tests pass", 1000);
  const r = analyzeEcho(frags("cloud code finished the migration and all the tests pass", 1400), { session: a });
  assert.equal(r.verdict, "echo");
});

test("quote-back: the user repeating the assistant's words after it spoke is kept", () => {
  const a = frags("Should I use the blue one or the red one?", 0); // ends at 2000
  assert.equal(analyzeEcho(frags("the red one", 2700), { session: a }).verdict, "clean");
  assert.equal(analyzeEcho(frags("use the blue one please", 3300), { session: a }).verdict, "clean");
  // …but the same words heard while it said them are echo.
  assert.equal(analyzeEcho(frags("or the red one", 1600), { session: a }).verdict, "echo");
});

test("double talk: echo words are cut, the user's words over the assistant stay", () => {
  const a = frags("I'll check the current git branch for you and then run the whole test suite", 0);
  // The ASR hears both: echo, then the user's barge-in, then more echo.
  const u = [
    ...frags("I'll check the current", 300),
    ...frags("wait stop", 1100),
    ...frags("git branch for you", 1500),
    ...frags("use main instead", 2300),
  ];
  const r = analyzeEcho(u, { session: a });
  assert.equal(r.verdict, "partial");
  assert.equal(said(r), "wait stop use main instead");
});

test("genuine barge-in words never match: 'stop, that's wrong' while it talks", () => {
  const a = frags("The build finished and I opened the pull request for the new parser", 0);
  const r = analyzeEcho(frags("stop that's the wrong branch", 900), { session: a });
  assert.equal(r.verdict, "clean");
  assert.equal(analyzeEcho(frags("stop", 900), { session: a }).verdict, "clean");
});

test("the real case (2026-09-24): other sotto voices in the room are dropped", () => {
  // The session's own greeting ("Hey! I'm here and connected to Claude Code in
  // dev.") at 1.6-3.6 s; then the mic heard e2e test sessions greeting through
  // the laptop speakers, 6 s later: not an echo of this session, but sotto's
  // own fixed sentences.
  const a = [
    { text: " Hey!", start_ms: 1600, end_ms: 1800 }, { text: " I'm here", start_ms: 1800, end_ms: 2000 },
    { text: " and connected", start_ms: 2200, end_ms: 2400 }, { text: " to Claude", start_ms: 2600, end_ms: 2800 },
    { text: " Code", start_ms: 3000, end_ms: 3200 }, { text: " in", start_ms: 3200, end_ms: 3400 }, { text: " dev.", start_ms: 3400, end_ms: 3600 },
  ];
  const line1 = [
    [" Hi. I'm", 7800], [" connected to", 8000], [" Claude Code", 8200], [" in the plugin", 8400], [" project", 8600],
    [". Hey", 9000], [", I'm", 9200], [" here", 9400], [" with", 9600], [" Claude", 10000], [" Code", 10400], [" in", 10800], [" Forward", 11400],
  ].map(([text, s]) => ({ text, start_ms: s, end_ms: s + 200 }));
  const line2 = [[". I", 16400], [" just", 16600], [" updated", 17200], [" my... Okay", 18600], [", I'll", 18800], [" pass", 19000], [" that", 19200], [" on", 19400]]
    .map(([text, s]) => ({ text, start_ms: s, end_ms: s + 200 }));
  assert.equal(analyzeEcho(line1, { session: a }).verdict, "echo");
  assert.equal(analyzeEcho(line2, { session: a }).verdict, "echo");
  // The same request collected by the delegation engine: nothing is left to send.
  const clock = createFakeClock();
  const t = new Transcript({ clock });
  for (const f of a) t.add("assistant", f.text, f.start_ms, f.end_ms);
  for (const f of [...line1, ...line2]) t.add("user", f.text, f.start_ms, f.end_ms);
  const req = collectRequest(t, 0, 19800);
  assert.equal(req.text, "");
  assert.equal(req.echoLines, 2);
});

test("sotto phrases inside real speech: only the phrase goes", () => {
  const r = analyzeEcho(frags("I'm connected to Claude Code in dev can you run the linter", 0), {});
  assert.equal(r.verdict, "partial");
  assert.equal(said(r), "can you run the linter");
  // A user's own "I just updated my branch" is theirs.
  assert.equal(analyzeEcho(frags("I just updated my branch please rebase it", 0), {}).verdict, "clean");
});

test("ledger: a voice sample played while the user talks, no shared timeline", () => {
  const clock = createFakeClock();
  const t = new Transcript({ clock });
  t.addSpoken("Hi, I'm Cedar. This is how I sound.", "preview");
  const now = clock.now();
  const u = frags("Hi I'm cedar this is how I sound", 5000, now - 5000);
  assert.equal(t.filterEcho(u).verdict, "echo");
  // The wake clip (text only) against what was played aloud.
  assert.equal(t.filterEchoText("Hi, I'm Cedar. This is how I sound.").verdict, "echo");
  assert.equal(t.filterEchoText("Hey can you check the build").verdict, "clean");
});

test("earlier sessions' assistant speech stays in the ledger across newSession", async () => {
  const clock = createFakeClock();
  const t = new Transcript({ clock });
  for (const f of frags("The deploy finished and the site is live again", 0)) t.add("assistant", f.text, f.start_ms, f.end_ms);
  t.newSession();
  await clock.advance(2000);
  assert.equal(t.filterEchoText("the deploy finished and the site is live").verdict, "echo");
  await clock.advance(60000);
  assert.equal(t.filterEchoText("the deploy finished and the site is live").verdict, "clean", "forgotten after a minute");
});

test("transcript.filterEcho uses only assistant speech near the line (15 s window)", () => {
  const clock = createFakeClock();
  const t = new Transcript({ clock });
  for (const f of frags("run the tests and report back", 0)) t.add("assistant", f.text, f.start_ms, f.end_ms);
  // 20 s later the user asks for the same thing: not echo.
  assert.equal(t.filterEcho(frags("run the tests and report back", 20000)).verdict, "clean");
  assert.equal(t.filterEcho(frags("run the tests and report back", 250)).verdict, "echo");
});
