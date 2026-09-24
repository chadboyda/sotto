import { test } from "node:test";
import assert from "node:assert/strict";
import { Transcript, groupFragments, normalizeWords } from "../../daemon/transcript.js";
import { createFakeClock } from "../helpers/fake-clock.js";

test("grouping: same role within 1500 ms joins, larger gap or role change splits", () => {
  const f = (role, text, s, e) => ({ role, text, start_ms: s, end_ms: e, at: 0 });
  const lines = groupFragments([
    f("user", " Hey", 0, 200), f("user", " there", 1700, 1900), // gap 1500 → same line
    f("user", " again", 3401, 3600), // gap 1501 → new line
    f("assistant", " Hi", 3700, 3900),
    f("user", " ok", 4000, 4100),
  ]);
  assert.deepEqual(lines.map((l) => [l.role, l.text]), [
    ["user", " Hey there"], ["user", " again"], ["assistant", " Hi"], ["user", " ok"],
  ]);
  assert.equal(lines[0].end_ms, 1900);
});

test("speech timestamps and fragment windows", async () => {
  const clock = createFakeClock();
  const t = new Transcript({ clock });
  t.add("user", " one", 0, 200);
  await clock.advance(100);
  t.add("assistant", " two", 300, 500);
  assert.equal(t.lastAssistantSpeechAt, clock.now());
  assert.equal(t.lastUserSpeechAt, clock.now() - 100);
  t.add("user", " three", 600, 800);
  assert.deepEqual(t.userFragmentsAfter(200).map((x) => x.text), [" three"]);
  assert.equal(t.lastAssistantLine().text, " two");
});

test("fragments cap at 1200 and history rolls across sessions", () => {
  const clock = createFakeClock();
  const t = new Transcript({ clock });
  for (let i = 0; i < 1250; i++) t.add(i % 2 ? "user" : "assistant", ` w${i}`, i * 10000, i * 10000 + 100);
  assert.equal(t.fragments.length, 1200);
  t.newSession();
  assert.equal(t.fragments.length, 0);
  assert.equal(t.history.length, 60);
  t.add("user", " fresh", 0, 100);
  const recent = t.recentLines(30);
  assert.equal(recent.length, 30);
  assert.equal(recent[recent.length - 1].text, "fresh");
});

test("isEcho: true for in-order overlap with recent assistant speech", async () => {
  const clock = createFakeClock();
  const t = new Transcript({ clock });
  for (const w of " Sure, I'll check the current git branch for you.".split(/(?= )/)) t.add("assistant", w, 0, 100);
  assert.equal(t.isEcho("I'll check the current git branch"), true);
  assert.equal(t.isEcho("check the current git branch for you please"), true); // 7/8 words
  assert.equal(t.isEcho("what is the weather in Paris"), false);
  assert.equal(t.isEcho("git branch"), false); // < 3 words
  assert.equal(t.isEcho("branch git current the check"), false); // wrong order
  await clock.advance(21000);
  assert.equal(t.isEcho("I'll check the current git branch"), false); // older than 20 s
});

test("normalizeWords strips punctuation and case", () => {
  assert.deepEqual(normalizeWords("Hey, it's  THE Branch!"), ["hey", "its", "the", "branch"]);
});
