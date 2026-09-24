import { test } from "node:test";
import assert from "node:assert/strict";
import { delegationHarness as harness, sentRecord } from "../helpers/delegation-harness.js";

test("E1: only client delegations create records", () => {
  const h = harness();
  assert.equal(h.engine.onCreated({ delegation: { id: "r1", target: "responses" }, offset_ms: 0 }), null);
  const rec = h.create("item_1", 1000);
  assert.equal(rec.status, "collecting");
  assert.equal(rec.rev, 1);
  assert.equal(h.counters.delegations, 1);
  assert.equal(h.create("item_1", 1000), null, "duplicate ignored");
});

test("E2: settles at 600 ms when speech is already quiet", async () => {
  const h = harness();
  h.say("what branch am I on", 0);
  await h.clock.advance(1000); // speech ended long ago
  const rec = h.create("item_1", 800);
  await h.clock.advance(599);
  assert.equal(h.sends.length, 0);
  await h.clock.advance(1);
  assert.equal(h.sends.length, 1);
  assert.equal(rec.status, "sent");
  assert.equal(h.sends[0].content, "[sotto voice] what branch am I on");
  assert.equal(h.sends[0].msgId, "clv-item_1-1");
});

test("E2: waits for 600 ms of quiet after trailing words", async () => {
  const h = harness();
  h.say("run the", 0);
  const rec = h.create("item_1", 200);
  // trailing words keep arriving every 400 ms until +2000
  for (let i = 0; i < 5; i++) { await h.clock.advance(400); h.transcript.add("user", " tests" + i, 400 + i * 400, 600 + i * 400); }
  const lastDelta = h.clock.now();
  await h.clock.advance(599);
  assert.equal(rec.status, "collecting");
  await h.clock.advance(1);
  assert.equal(rec.status, "sent");
  assert.equal(h.clock.now() - lastDelta, 600);
  assert.match(h.sends[0].content, /run the tests0 tests1 tests2 tests3 tests4$/);
});

test("E2: settles anyway at the 3000 ms cap; later words go with the next request", async () => {
  const h = harness();
  h.say("keep", 0);
  const rec = h.create("item_1", 0);
  const created = h.clock.now();
  for (let i = 0; i < 18; i++) { await h.clock.advance(200); h.transcript.add("user", " x" + i, 200 + i * 200, 400 + i * 200); }
  assert.equal(rec.status, "sent");
  assert.ok(rec.sent_at - created <= 3000 && rec.sent_at - created >= 3000 - 1, `settled at ${rec.sent_at - created}`);
  assert.match(rec.text, /x13$/);
  const b = h.create("item_2", 4000);
  await h.clock.advance(1000);
  assert.equal(b.text, "x14 x15 x16 x17", "the words after the cap, and only those");
});

test("E3: text window is everything since the previous send, bounded to 90 s", async () => {
  const h = harness();
  h.say("ancient words", 0);
  h.say("older but same turn", 20000);
  h.say("first request here", 100000);
  const a = h.create("item_a", 100400);
  await h.clock.advance(700);
  assert.equal(a.text, "... older but same turn first request here", "speech older than 90 s is trimmed");
  assert.equal(h.engine.consumedThroughMs, 100600);
  h.say("second one", 102000);
  const b = h.create("item_b", 102200);
  await h.clock.advance(700);
  assert.equal(b.text, "second one", "already-sent speech is never re-sent");
});

test("E3: empty text → dropped_empty with a spoken retry prompt", async () => {
  const h = harness();
  const rec = h.create("item_1", 5000);
  await h.clock.advance(700);
  assert.equal(rec.status, "dropped_empty");
  assert.deepEqual(h.appends, [{ kind: "commentary", content: "I didn't catch the request clearly. Could you say it again?", id: "item_1" }]);
  assert.equal(h.sends.length, 0);
});

test("E3: echo of the assistant → dropped_echo, closed with one silent thinking note", async () => {
  const h = harness();
  h.hear("I'll check the current git branch for you", 0);
  h.say("I'll check the current git branch", 300); // heard back 300 ms later
  await h.clock.advance(500);
  const rec = h.create("item_1", 1600);
  await h.clock.advance(700);
  assert.equal(rec.status, "dropped_echo");
  assert.equal(h.appends.length, 1);
  assert.equal(h.appends[0].kind, "thinking", "never spoken");
  assert.equal(h.appends[0].id, "item_1", "closes the Live-side delegation");
  assert.match(h.appends[0].content, /Not a request/);
  assert.equal(h.sends.length, 0);
});

test("E3: the user quoting the assistant back after it spoke is a request, not an echo", async () => {
  const h = harness();
  h.hear("Should I run all the tests or just the unit tests?", 0); // ends at 2000
  h.say("yes run all the tests", 2800);
  const rec = h.create("item_q", 3900);
  await h.clock.advance(1500);
  assert.equal(rec.status, "sent");
  assert.equal(rec.text, "yes run all the tests");
});

test("E3: an older collecting record is superseded by a newer one", async () => {
  const h = harness();
  h.say("check the tests", 0);
  const a = h.create("item_a", 400);
  await h.clock.advance(100);
  h.say("and the lint", 700);
  const b = h.create("item_b", 1100);
  await h.clock.advance(1000);
  assert.equal(a.status, "superseded");
  assert.equal(b.status, "sent");
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].content, "[sotto voice] check the tests and the lint");
});

test("E3: short replies get the assistant-context suffix", async () => {
  const h = harness();
  h.transcript.add("assistant", " Should I run the whole suite?", 0, 1000);
  h.say("yes do it", 2000);
  await h.clock.advance(1000);
  h.create("item_1", 2400);
  await h.clock.advance(700);
  assert.equal(h.sends[0].content, '[sotto voice] yes do it\n(Replying to the voice assistant, which had just said: "Should I run the whole suite?")');
});

test("E3: identical content within 10 minutes gets (repeated)", async () => {
  const h = harness();
  h.say("run the tests again please now thanks", 0);
  h.create("item_1", 1000);
  await h.clock.advance(1000);
  h.say("run the tests again please now thanks", 5000);
  h.create("item_2", 6000);
  await h.clock.advance(1000);
  assert.equal(h.sends[1].content, h.sends[0].content + " (repeated)");
});

test("E3: success sends a thinking note; busy send creates pending-context", async () => {
  const h = harness();
  h.engine.onHook("PreToolUse", { tool_name: "Bash" });
  h.say("also check lint", 0);
  const rec = h.create("item_1", 400);
  await h.clock.advance(700);
  assert.equal(rec.sent_while_busy, true);
  assert.equal(h.pendingCreated, 1);
  assert.equal(h.counters.inbox_sent, 1);
  assert.deepEqual(h.appends[0], { kind: "thinking", id: "item_1", content: '[sotto] Request sent to Claude Code: "also check lint". Claude Code is working on it; there is no result yet.' });
});

test("E3: inbox failure → failed, commentary, liveness check on no_socket/refused", async () => {
  const h = harness();
  h.inboxResult = { ok: false, code: "refused" };
  h.say("do the thing now", 0);
  const rec = h.create("item_1", 400);
  await h.clock.advance(700);
  assert.equal(rec.status, "failed");
  assert.equal(h.counters.inbox_failed, 1);
  assert.equal(h.appends[0].content, "I couldn't reach Claude Code for proj. Voice is turning off.");
  assert.equal(h.liveness, 1);

  h.inboxResult = { ok: false, code: "timeout" };
  h.say("try once more please", 5000);
  h.create("item_2", 5400);
  await h.clock.advance(700);
  assert.equal(h.appends[1].content, "I couldn't reach Claude Code. Please try again.");
  assert.equal(h.liveness, 1);
});

test("held timer fires at 8 s without hooks", async () => {
  const h = harness();
  h.say("what is on main", 0);
  const rec = h.create("item_1", 400);
  await h.clock.advance(700); // settled and sent at +600
  assert.equal(rec.sent_at - rec.created_at, 600);
  await h.clock.advance(7899);
  assert.equal(rec.status, "sent");
  await h.clock.advance(1);
  assert.equal(rec.status, "held_suspected");
  assert.equal(h.lastError, "inbox_held");
  assert.deepEqual(h.notices, ["inbox_held"]);
  assert.match(h.appends.at(-1).content, /hasn't reached Claude Code/);
  // A later UserPromptSubmit brings it back into the flow.
  h.engine.onHook("UserPromptSubmit", { prompt: rec.content });
  assert.equal(rec.status, "delivered");
});

test("held timer does not fire when a hook arrives", async () => {
  const h = harness();
  h.say("what is on main", 0);
  const rec = h.create("item_1", 400);
  await h.clock.advance(700);
  await h.clock.advance(3000);
  h.engine.onHook("UserPromptSubmit", { prompt: rec.content });
  await h.clock.advance(6000);
  assert.equal(rec.status, "delivered");
  assert.equal(h.lastError, null);
});

test("E4: typed prompts become background thinking; slash and pasted are skipped", () => {
  const h = harness();
  h.engine.onHook("UserPromptSubmit", { prompt: "refactor the parser" });
  h.engine.onHook("UserPromptSubmit", { prompt: "/clear" });
  h.engine.onHook("UserPromptSubmit", { prompt: "look <pasted_content id=1>" });
  assert.equal(h.engine.claudeBusy, true);
  assert.deepEqual(h.appends, [{ kind: "thinking", id: null, content: "[Background reference; not user speech] The user typed to Claude Code: refactor the parser" }]);
});


test("E6: current delegation → voice_result with its id", async () => {
  const h = harness();
  const rec = await sentRecord(h, "item_1", "what branch", 0);
  h.engine.onHook("UserPromptSubmit", { prompt: rec.content });
  await h.engine.onStop({ last_assistant_message: "You are on main." });
  assert.equal(rec.status, "answered");
  assert.deepEqual(h.routes, [{ source: "voice_result", text: "You are on main.", delegationId: "item_1", requestText: "what branch", earlier: false }]);
  assert.equal(h.engine.claudeBusy, false);
  assert.equal(h.pendingRemoved, 2, "on the voice UserPromptSubmit and on Stop");
});

test("E6: a newer delegation that never reached Claude does not make the answer stale", async () => {
  const h = harness();
  const a = await sentRecord(h, "item_a", "first question", 0);
  h.engine.onHook("UserPromptSubmit", { prompt: a.content });
  const b = h.create("item_b", 9000); // newer delegation, no speech → dropped_empty
  await h.clock.advance(700);
  assert.equal(b.status, "dropped_empty");
  await h.engine.onStop({ last_assistant_message: "Answer." });
  assert.equal(a.status, "answered");
  assert.equal(h.routes[0].source, "voice_result");
});

test("E6: a newer request that reached Claude (queued) → stale_result", async () => {
  const h = harness();
  const a = await sentRecord(h, "item_a", "first question", 0);
  h.engine.onHook("UserPromptSubmit", { prompt: a.content, prompt_id: "p1" });
  const b = await sentRecord(h, "item_b", "second question", 20000); // sent while busy
  assert.equal(b.status, "sent");
  h.absorbedFn = () => new Set(); // the transcript shows it was not absorbed
  const p = h.engine.onStop({ last_assistant_message: "Answer.", prompt_id: "p1", transcript_path: "/t.jsonl" });
  await h.clock.advance(1300); // one transcript re-check
  await p;
  assert.equal(a.status, "answered_stale");
  assert.equal(h.routes[0].source, "stale_result");
  assert.equal(b.status, "sent", "the queued request stays in flight for its own turn");
});

test("E6: while a newer one is still collecting → stale_result", async () => {
  const h = harness();
  const a = await sentRecord(h, "item_a", "first question", 0);
  h.engine.onHook("UserPromptSubmit", { prompt: a.content });
  h.create("item_b", 9000);
  await h.engine.onStop({ last_assistant_message: "Answer." });
  assert.equal(a.status, "answered_stale");
});

test("E6: older in-flight records are superseded by the highest rev", async () => {
  const h = harness();
  h.engine.onHook("PreToolUse", {});
  const a = await sentRecord(h, "item_a", "one thing", 0);
  const b = await sentRecord(h, "item_b", "another thing", 3000);
  h.engine.onHook("UserPromptSubmit", { prompt: a.content });
  h.engine.onHook("UserPromptSubmit", { prompt: b.content });
  await h.engine.onStop({ last_assistant_message: "Both done." });
  assert.equal(a.status, "superseded");
  assert.equal(b.status, "answered");
  assert.equal(h.routes[0].delegationId, "item_b");
});

test("E6: no candidates → typed_result", async () => {
  const h = harness();
  await h.engine.onStop({ last_assistant_message: "Typed answer." });
  assert.deepEqual(h.routes, [{ source: "typed_result", text: "Typed answer." }]);
});

test("E6 busy deferral: a UserPromptSubmit during the wait means the message was queued", async () => {
  const h = harness();
  h.engine.onHook("PreToolUse", {});
  const rec = await sentRecord(h, "item_1", "also run lint", 0);
  assert.equal(rec.sent_while_busy, true);
  const p = h.engine.onStop({ last_assistant_message: "Finished the earlier task." });
  await h.clock.advance(1000);
  h.engine.onHook("UserPromptSubmit", { prompt: rec.content });
  await h.clock.advance(1500);
  await p;
  assert.equal(h.routes[0].source, "typed_result");
  assert.equal(rec.status, "delivered");
  // The next Stop answers it.
  await h.engine.onStop({ last_assistant_message: "Lint is clean." });
  assert.equal(rec.status, "answered");
  assert.equal(h.routes[1].source, "voice_result");
});

test("E6 busy deferral: no UserPromptSubmit → absorbed mid-turn, answered by this Stop", async () => {
  const h = harness();
  h.engine.onHook("PreToolUse", {});
  const rec = await sentRecord(h, "item_1", "also run lint", 0);
  const p = h.engine.onStop({ last_assistant_message: "Done, lint too." });
  await h.clock.advance(2499);
  assert.equal(h.routes.length, 0);
  await h.clock.advance(1);
  await p;
  assert.equal(rec.status, "answered");
  assert.equal(h.routes[0].source, "voice_result");
});

test("E7: StopFailure answers the newest in-flight record and speaks the error", async () => {
  const h = harness();
  const rec = await sentRecord(h, "item_1", "do it", 0);
  h.engine.onHook("UserPromptSubmit", { prompt: rec.content });
  h.engine.onStopFailure({ error: "rate_limit" });
  assert.equal(rec.status, "answered");
  assert.deepEqual(h.appends.at(-1), { kind: "commentary", content: "Claude Code hit an error: it hit a rate limit.", id: "item_1" });
  h.engine.onStopFailure({ error: "weird" });
  assert.deepEqual(h.appends.at(-1), { kind: "commentary", content: "Claude Code hit an error: an API error.", id: null });
  assert.equal(h.engine.claudeBusy, false);
});

test("E8: orphanAll marks every non-final record", async () => {
  const h = harness();
  const a = await sentRecord(h, "item_a", "one", 0);
  const c = await sentRecord(h, "item_c", "", 9000); // dropped_empty (final)
  const b = h.create("item_b", 12000); // still collecting
  h.engine.orphanAll();
  assert.equal(a.status, "orphaned");
  assert.equal(b.status, "orphaned");
  assert.equal(c.status, "dropped_empty");
  await h.clock.advance(3000);
  assert.equal(b.status, "orphaned", "timers do not revive an orphan");
});

test("list() returns the last 10, newest first, with ISO times", async () => {
  const h = harness();
  for (let i = 0; i < 12; i++) h.create(`item_${i}`, i * 1000);
  await h.clock.advance(3000);
  const l = h.engine.list();
  assert.equal(l.length, 10);
  assert.equal(l[0].id, "item_11");
  assert.deepEqual(Object.keys(l[0]), ["id", "rev", "status", "text", "sent_at", "answered_at"]);
});
