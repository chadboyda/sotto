// Delegation engine: regression tests for the v1 review fixes
// (stale ids across Live sessions, staleness, prompt_id matching, Esc,
// subagents, per-bind marker).
import { test } from "node:test";
import assert from "node:assert/strict";
import { delegationHarness as harness, sentRecord } from "../helpers/delegation-harness.js";

test("records from an earlier Live session are answered with a null id and framed as earlier", async () => {
  const h = harness({ live: "live_A" });
  const a = await sentRecord(h, "item_a", "run the tests", 0);
  assert.equal(a.live_id, "live_A");
  h.engine.onHook("UserPromptSubmit", { prompt: a.content, prompt_id: "p1" });
  h.live = "live_B"; // resume / reconnect / expiry: a new Live session
  const r = await h.engine.onStop({ last_assistant_message: "All tests pass.", prompt_id: "p1" });
  assert.equal(r.source, "voice_result");
  assert.equal(r.earlier, true);
  assert.equal(h.routes[0].delegationId, null, "the new session does not know item_a");
  assert.equal(h.routes[0].earlier, true);
  assert.equal(h.routes[0].requestText, "run the tests");
});

test("same Live session: the delegation id is kept", async () => {
  const h = harness({ live: "live_A" });
  const a = await sentRecord(h, "item_a", "run the tests", 0);
  assert.equal(h.appends.at(-1).id, "item_a", "the 'request sent' note carries the id");
  h.engine.onHook("UserPromptSubmit", { prompt: a.content, prompt_id: "p1" });
  await h.engine.onStop({ last_assistant_message: "Done.", prompt_id: "p1" });
  assert.equal(h.routes[0].delegationId, "item_a");
  assert.equal(h.routes[0].earlier, false);
});

test("StopFailure for an earlier-session request appends with a null id", async () => {
  const h = harness({ live: "live_A" });
  const a = await sentRecord(h, "item_a", "run the tests", 0);
  h.engine.onHook("UserPromptSubmit", { prompt: a.content, prompt_id: "p1" });
  h.live = "live_B";
  h.appends.length = 0;
  h.engine.onStopFailure({ error: "rate_limit", prompt_id: "p1" });
  assert.equal(h.appends[0].id, null);
  assert.match(h.appends[0].content, /earlier request "run the tests".*rate limit/);
});

test("held warning for an earlier-session request uses a null id", async () => {
  const h = harness({ live: "live_A" });
  const a = await sentRecord(h, "item_a", "run the tests", 0);
  h.live = null; // paused
  h.appends.length = 0;
  await h.clock.advance(8000);
  assert.equal(a.status, "held_suspected");
  assert.equal(h.appends[0].id, null);
});

test("prompt_id: a queued request is answered by its own turn, not the previous Stop", async () => {
  const h = harness();
  const a = await sentRecord(h, "item_a", "first question", 0);
  h.engine.onHook("UserPromptSubmit", { prompt: a.content, prompt_id: "p1" });
  const b = await sentRecord(h, "item_b", "second question", 20000); // sent while busy
  h.absorbedFn = () => new Set();
  const p1 = h.engine.onStop({ last_assistant_message: "Answer to A.", prompt_id: "p1", transcript_path: "/t.jsonl" });
  await h.clock.advance(5000); // longer than STOP_DEFER_MS: no timer heuristic is involved
  await p1;
  assert.equal(a.status, "answered_stale");
  assert.equal(b.status, "sent");
  assert.equal(h.routes[0].source, "stale_result", "A's answer is not attributed to B");
  // The queued message now runs as its own prompt.
  h.engine.onHook("UserPromptSubmit", { prompt: b.content, prompt_id: "p2" });
  await h.engine.onStop({ last_assistant_message: "Answer to B.", prompt_id: "p2", transcript_path: "/t.jsonl" });
  assert.equal(b.status, "answered");
  assert.deepEqual([h.routes[1].source, h.routes[1].delegationId, h.routes[1].text], ["voice_result", "item_b", "Answer to B."]);
});

test("prompt_id: a message absorbed mid-turn (same prompt_id) is answered by this Stop", async () => {
  const h = harness();
  const a = await sentRecord(h, "item_a", "first question", 0);
  h.engine.onHook("UserPromptSubmit", { prompt: a.content, prompt_id: "p1" });
  const b = await sentRecord(h, "item_b", "and also this", 20000);
  // Probed on CLI 2.1.281: absorption fires UserPromptSubmit with the running turn's prompt_id.
  h.engine.onHook("UserPromptSubmit", { prompt: b.content, prompt_id: "p1" });
  assert.equal(a.status, "delivered", "same turn: not interrupted");
  await h.engine.onStop({ last_assistant_message: "Both.", prompt_id: "p1" });
  assert.equal(a.status, "superseded");
  assert.equal(b.status, "answered");
  assert.equal(h.routes[0].delegationId, "item_b");
});

test("prompt_id: an absorbed message whose UserPromptSubmit is missing is found in the transcript", async () => {
  const h = harness();
  const a = await sentRecord(h, "item_a", "first question", 0);
  h.engine.onHook("UserPromptSubmit", { prompt: a.content, prompt_id: "p1" });
  const b = await sentRecord(h, "item_b", "and also this", 20000);
  h.absorbedFn = (path, contents) => { assert.equal(path, "/t.jsonl"); return new Set(contents); };
  await h.engine.onStop({ last_assistant_message: "Both.", prompt_id: "p1", transcript_path: "/t.jsonl" });
  assert.equal(b.status, "answered");
  assert.equal(a.status, "superseded");
});

test("Esc (no Stop): the next prompt marks the interrupted turn's records and drops pending-context", async () => {
  const h = harness();
  const a = await sentRecord(h, "item_a", "long task", 0);
  h.engine.onHook("UserPromptSubmit", { prompt: a.content, prompt_id: "p1" });
  const removed = h.pendingRemoved;
  h.engine.onHook("UserPromptSubmit", { prompt: "something typed", prompt_id: "p2" });
  assert.equal(a.status, "interrupted");
  assert.equal(h.pendingRemoved, removed + 1);
  await h.engine.onStop({ last_assistant_message: "Typed answer.", prompt_id: "p2" });
  assert.equal(h.routes[0].source, "typed_result");
});

test("a Stop that loses the race to the next UserPromptSubmit still answers its record", async () => {
  const h = harness();
  const a = await sentRecord(h, "item_a", "question", 0);
  h.engine.onHook("UserPromptSubmit", { prompt: a.content, prompt_id: "p1" });
  h.engine.onHook("UserPromptSubmit", { prompt: "typed next", prompt_id: "p2" }); // arrived first
  assert.equal(a.status, "interrupted");
  await h.engine.onStop({ last_assistant_message: "Answer.", prompt_id: "p1" });
  assert.equal(a.status, "answered");
  assert.equal(h.routes.at(-1).source, "voice_result");
});

test("MessageDisplay, subagent hooks and hooks of a stopped turn never set busy", async () => {
  const h = harness();
  h.engine.onHook("MessageDisplay", { delta: "x", final: true });
  assert.equal(h.engine.claudeBusy, false);
  const hookAt = h.engine.lastHookAt;
  await h.clock.advance(10);
  h.engine.onHook("PreToolUse", { agent_id: "agent-1", tool_name: "Bash" });
  h.engine.onHook("PermissionRequest", { agent_id: "agent-1", tool_name: "Bash" });
  assert.equal(h.engine.claudeBusy, false);
  assert.equal(h.engine.lastHookAt, hookAt, "a subagent hook is not evidence of delivery");
  await h.engine.onStop({ prompt_id: "p1" });
  h.engine.onHook("PreToolUse", { prompt_id: "p1", tool_name: "Bash" });
  assert.equal(h.engine.claudeBusy, false, "late POST of a finished turn");
  h.engine.onHook("PreToolUse", { prompt_id: "p2", tool_name: "Bash" });
  assert.equal(h.engine.claudeBusy, true);
});

test("resetClaudeState clears busy so the next request arms the held timer", async () => {
  const h = harness();
  h.engine.onHook("PreToolUse", {});
  assert.equal(h.engine.claudeBusy, true);
  h.engine.resetClaudeState();
  const rec = await sentRecord(h, "item_1", "check it", 0);
  assert.equal(rec.sent_while_busy, false);
  assert.equal(h.pendingCreated, 0);
  await h.clock.advance(8000);
  assert.equal(rec.status, "held_suspected");
});

test("sweepStale orphans requests in flight too long; pendingWork is bounded", async () => {
  const h = harness();
  const rec = await sentRecord(h, "item_1", "check it", 0);
  h.engine.onHook("UserPromptSubmit", { prompt: rec.content });
  assert.equal(h.engine.pendingWork().length, 1);
  await h.clock.advance(31 * 60_000);
  assert.equal(h.engine.pendingWork().length, 0);
  h.engine.sweepStale();
  assert.equal(rec.status, "orphaned");
});

test("the per-bind marker is used on the wire and required for delivery matching", async () => {
  const h = harness();
  h.engine.fx.marker = () => "[sotto voice n0nce]";
  const rec = await sentRecord(h, "item_1", "hello there", 0);
  assert.equal(h.sends[0].content, "[sotto voice n0nce] hello there");
  h.engine.onHook("UserPromptSubmit", { prompt: "[sotto voice] hello there" });
  assert.equal(rec.status, "sent", "an un-nonced look-alike is not our message");
  h.engine.onHook("UserPromptSubmit", { prompt: rec.content });
  assert.equal(rec.status, "delivered");
});
