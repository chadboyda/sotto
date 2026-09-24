// Pure-module regression tests for the v1 review fixes: secret redaction and
// token budgeting (speech.js), MessageDisplay ordering (policy.js), earlier-
// session framing, transcript absorption (claude-context.js), Node check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { relay } from "../../daemon/phrasing.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { speakable, redactSecrets, estTokens, fitTokens, tokenChunks } from "../../daemon/speech.js";
import { route, Narrator } from "../../daemon/policy.js";
import { readAbsorbed } from "../../daemon/claude-context.js";
import { nodeProblem } from "../../daemon/index.js";
import { TEMPLATE } from "../../daemon/prompt.js";
import { createFakeClock } from "../helpers/fake-clock.js";

test("speakable never says credentials", () => {
  const cases = [
    ["Pushed to https://oauth2:glpat-AbC12345xyz@gitlab.com/org/repo.git just now.", /glpat|oauth2|AbC123/],
    ["Connect with postgres://admin:hunter2@db.internal:5432/app please.", /hunter2|admin:/],
    ["Set AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE first.", /AKIA/],
    ["Run export OPENAI_API_KEY=sk-12345 then retry.", /sk-12345/],
    ["The key is sk-proj-abc123def456 and ghp_abcdefghij1234567890 too.", /sk-proj|ghp_/],
    ["Header: Bearer abcdef1234567890xyz", /abcdef1234567890/],
    ["Token eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4 expired.", /eyJ/],
    ["The password: Hunter22 works.", /Hunter22/],
  ];
  for (const [input, bad] of cases) {
    const out = speakable(input);
    assert.ok(!bad.test(out), `${input} → ${out}`);
  }
  assert.equal(speakable("Set AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE first."), "Set AWS_ACCESS_KEY_ID is set first.");
  assert.equal(speakable("Use PORT=3000 and NODE_ENV=production."), "Use PORT=3000 and NODE_ENV=production.", "non-secret settings survive");
  assert.equal(redactSecrets("Plain English stays the same; the key idea is simple."), "Plain English stays the same; the key idea is simple.");
});

test("indented code blocks are omitted; indented list items are kept", () => {
  assert.equal(speakable('Intro text.\n\n    const x = require("fs");\n    passwd("hunter2")\n\nAfter.'), "Intro text. (code omitted). After.");
  assert.equal(speakable("- item\n\n    - nested a\n    - nested b\n\nok"), "item. nested a. nested b. ok.");
});

test("the Live instructions forbid speaking secrets", () => {
  assert.match(TEMPLATE, /Never say passwords, API keys, tokens, or other secrets aloud/);
});

test("estTokens is conservative for non-Latin text; fitTokens/tokenChunks respect the budget", () => {
  assert.ok(estTokens("hello world") <= 5);
  const cjk = "テストはすべて成功しました。".repeat(100);
  assert.ok(estTokens(cjk) >= cjk.length, "about one token per CJK char or more");
  assert.ok(estTokens(fitTokens(cjk, 450)) <= 450);
  const cs = tokenChunks(cjk, 450);
  assert.ok(cs.length > 1);
  for (const c of cs) assert.ok(estTokens(c) <= 450 && c.length <= 1400);
  assert.equal(cs.join("").replace(/\s/g, ""), cjk.replace(/\s/g, ""), "nothing lost when chunking");
  // English prose that fits in 1,400 chars stays one chunk under the budget.
  const en = "This is an ordinary sentence. ".repeat(40).trim();
  assert.deepEqual(tokenChunks(en, 450).length, 1);
});

test("every routed append fits the token budget, even for CJK results", () => {
  const text = "修正しました。".repeat(400);
  for (const policy of ["quiet", "milestones", "walkthrough"]) {
    for (const source of ["voice_result", "typed_result", "stale_result", "progress_text"]) {
      for (const a of route(source, policy, { text, delegationId: "d1", requestText: "やって" }, { canSpeakProgress: true })) {
        assert.ok(estTokens(a.content) <= 450, `${policy}/${source}/${a.kind}: ${estTokens(a.content)}`);
      }
    }
  }
});

test("voice_result for an earlier Live session: null id, says which request", () => {
  const acts = route("voice_result", "milestones", { text: "Done.", delegationId: "item_old", requestText: "run the tests", earlier: true });
  assert.equal(acts[0].delegationId, null);
  assert.equal(acts[0].content, relay("earlier", "Done.", { requestText: "run the tests" }));
  assert.match(acts[0].content, /^This answers the user's earlier request "run the tests"\./);
});

function narrator() {
  const clock = createFakeClock();
  const out = [];
  const n = new Narrator({ clock, policy: () => "walkthrough", emit: (a) => out.push(a) });
  return { n, out, clock };
}

test("MessageDisplay batches are assembled by index, whatever the arrival order", () => {
  const { n } = narrator();
  n.onMessageDisplay({ message_id: "m1", index: 2, final: true, delta: "three" });
  n.onMessageDisplay({ message_id: "m1", index: 0, final: false, delta: "one\n" });
  assert.equal(n.held, null, "index 1 still missing");
  n.onMessageDisplay({ message_id: "m1", index: 1, final: false, delta: "two\n" });
  assert.deepEqual(n.held, { id: "m1", text: "one\ntwo\nthree" });
});

test("MessageDisplay of a finished message or stopped turn is dropped", () => {
  const { n, out } = narrator();
  n.onMessageDisplay({ message_id: "m1", prompt_id: "p1", index: 0, final: false, delta: "Answer\n" });
  n.onStop({ prompt_id: "p1" });
  assert.equal(n.onMessageDisplay({ message_id: "m1", prompt_id: "p1", index: 1, final: true, delta: "" }), false);
  assert.equal(n.onMessageDisplay({ message_id: "m9", prompt_id: "p1", index: 0, final: true, delta: "late" }), false);
  assert.equal(n.held, null);
  n.onToolUse("Bash", {});
  assert.equal(out.filter((a) => a.source === "progress_text").length, 0, "nothing replayed");
});

test("readAbsorbed finds messages absorbed mid-turn, not ones merely queued", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clv-abs-"));
  try {
    const f = path.join(dir, "t.jsonl");
    const A = "[sotto voice abc] absorbed one";
    const Q = "[sotto voice abc] queued one";
    fs.writeFileSync(f, [
      { type: "queue-operation", operation: "enqueue", content: A },
      { type: "queue-operation", operation: "enqueue", content: Q },
      { type: "attachment", attachment: { type: "queued_command", prompt: A, origin: { kind: "peer" } } },
      { type: "queue-operation", operation: "remove", content: A, reason: "absorbed_mid_turn" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    assert.deepEqual([...readAbsorbed(f, [A, Q])], [A]);
    assert.equal(readAbsorbed(path.join(dir, "missing.jsonl"), [A]), null, "unreadable → null");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("nodeProblem: Node 22 with a global WebSocket is required", () => {
  assert.equal(nodeProblem({ node: "22.18.0" }, function WS() {}), null);
  assert.match(nodeProblem({ node: "20.11.1" }, function WS() {}), /too old/);
  assert.match(nodeProblem({ node: "18.18.0" }, undefined), /too old/);
  assert.match(nodeProblem({ node: "22.0.0" }, null), /no global WebSocket/);
});
