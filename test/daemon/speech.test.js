import { test } from "node:test";
import assert from "node:assert/strict";
import { speakable, summary, chunks, sentences, clip, firstSentences } from "../../daemon/speech.js";

test("code fences are omitted and repeats collapsed", () => {
  const md = "Here is the fix:\n\n```js\nconst a = 1;\n```\n\n```sh\nnpm test\n```\n\nDone.";
  const s = speakable(md);
  assert.ok(!s.includes("const a"));
  assert.ok(!s.includes("npm test"));
  assert.equal((s.match(/code omitted/g) || []).length, 1);
  assert.match(s, /Done\.$/);
});

test("unterminated fence at the end is omitted", () => {
  assert.equal(speakable("Look:\n\n```js\nconst x = 1;"), "Look: (code omitted).");
});

test("tables are omitted", () => {
  const s = speakable("Results:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAll good.");
  assert.ok(s.includes("(table omitted)"));
  assert.ok(!s.includes("|"));
});

test("headings and bullets become sentences; emphasis removed", () => {
  const s = speakable("## Summary\n- **fixed** the bug\n- added _two_ tests\n1. ran them");
  assert.equal(s, "Summary. fixed the bug. added two tests. ran them.");
});

test("links, URLs, paths, ids and long tokens are collapsed", () => {
  const s = speakable(
    "See [the docs](https://example.com/x) and https://www.github.com/a/b?c=1. " +
      "Edited /Users/me/dev/proj/daemon/index.js and src/lib/util.ts and ./scripts/hook.sh. " +
      "Commit 3f2a9c1b7d4e5f60a1, session 123e4567-e89b-12d3-a456-426614174000, key sk_live_abcdefghijklmnopqrstuvwx0123. and/or fine.",
  );
  assert.ok(s.includes("See the docs"));
  assert.ok(s.includes("a link to github.com"));
  assert.ok(!/https?:/.test(s));
  assert.ok(s.includes("Edited index.js and util.ts and hook.sh."));
  assert.ok(s.includes("Commit an id"));
  assert.ok(s.includes("session an id"));
  assert.ok(s.includes("key a secret token"), "a Stripe-style key is redacted as a secret");
  assert.ok(s.includes("and/or fine"));
});

test("inline code: short kept, long or pathy collapsed", () => {
  assert.equal(speakable("Run `npm test` now."), "Run npm test now.");
  assert.equal(speakable("Open `daemon/voice.js` please."), "Open voice.js please.");
  assert.equal(speakable("Use `const x = someVeryLongFunctionName(argument, other)` here."), "Use some code here.");
});

test("snake_case and plain words survive", () => {
  assert.equal(speakable("The my_var_name value is set."), "The my_var_name value is set.");
});

test("summary respects maxChars and cuts at a sentence end", () => {
  const md = "First sentence is here. Second sentence is a bit longer than the first. Third one.\n\nNext paragraph.";
  const s = summary(md, 60);
  assert.ok(s.length <= 60);
  assert.equal(s, "First sentence is here.");
  assert.equal(summary(md, 2000), speakable(md));
  // A single sentence longer than max is cut at a word boundary.
  const long = summary("word ".repeat(100).trim() + ".", 50);
  assert.ok(long.length <= 50);
  assert.ok(!long.endsWith(" "));
});

test("summary of empty input is empty", () => {
  assert.equal(summary("", 900), "");
  assert.equal(summary("```\ncode\n```", 900), "(code omitted).");
});

test("chunks are ≤ max and rejoin to the input's words", () => {
  const text = Array.from({ length: 300 }, (_, i) => `Sentence number ${i} has some words in it${i % 7 === 0 ? "!" : "."}`).join(" ") +
    " " + "averyveryverylongword ".repeat(120).trim() + ".";
  for (const max of [1400, 200, 57]) {
    const cs = chunks(text, max);
    assert.ok(cs.length > 1);
    for (const c of cs) assert.ok(c.length <= max, `chunk ${c.length} > ${max}`);
    assert.deepEqual(cs.join(" ").split(/\s+/), text.split(/\s+/));
  }
  assert.deepEqual(chunks(""), []);
  assert.deepEqual(chunks("Short."), ["Short."]);
});

test("sentences / clip / firstSentences helpers", () => {
  assert.deepEqual(sentences("A b. C d? E!"), ["A b.", "C d?", "E!"]);
  assert.equal(firstSentences("One. Two. Three.", 2), "One. Two.");
  const c = clip("x ".repeat(100), 21);
  assert.ok(c.length <= 21);
  assert.ok(c.endsWith("…"));
});
