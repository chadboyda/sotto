// Delegation records over the mod link (SPEC §6.21): appended and requeued
// receipts, and the Stop that must not claim a requeued message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { delegationHarness, sentRecord } from "../helpers/delegation-harness.js";
import { REQUEUE_NUDGE } from "../../daemon/delegation.js";

test("appended mid-turn: delivered in the running turn and answered by its Stop", async () => {
  const h = delegationHarness();
  h.engine.onHook("UserPromptSubmit", { prompt: "typed work", prompt_id: "p1" });
  const rec = await sentRecord(h, "d1", "also check the tests", 1000);
  assert.equal(rec.status, "sent");
  h.engine.onReceipt({ msgId: rec.msg_id, how: "appended", promptId: "p1" });
  assert.equal(rec.status, "delivered");
  assert.equal(rec.prompt_id, "p1");
  await h.engine.onStop({ prompt_id: "p1", last_assistant_message: "Tests pass." });
  assert.equal(rec.status, "answered");
  assert.equal(h.routes.at(-1).source, "voice_result");
});

test("requeued: the turn that missed it does not answer it; the nudge's turn does", async () => {
  const h = delegationHarness();
  h.engine.onHook("UserPromptSubmit", { prompt: "typed work", prompt_id: "p1" });
  const rec = await sentRecord(h, "d1", "rename the file", 1000);
  h.engine.onReceipt({ msgId: rec.msg_id, how: "appended", promptId: "p1" });
  const r = h.engine.onReceipt({ msgId: rec.msg_id, how: "requeued" });
  assert.equal(r.nudge, `[sotto voice] ${REQUEUE_NUDGE}`);
  assert.equal(rec.status, "sent");
  // The old turn's Stop (transcript unreadable: the timer path) leaves it alone.
  await h.engine.onStop({ prompt_id: "p1", last_assistant_message: "Done with the typed work." });
  await h.clock.advance(3000);
  assert.equal(rec.status, "sent");
  assert.equal(h.routes.at(-1).source, "typed_result");
  // The nudge arrives as its own prompt and its Stop answers the voice request.
  h.engine.onHook("UserPromptSubmit", { prompt: r.nudge, prompt_id: "p2" });
  assert.equal(rec.status, "delivered");
  await h.engine.onStop({ prompt_id: "p2", last_assistant_message: "Renamed it." });
  assert.equal(rec.status, "answered");
  assert.equal(h.routes.at(-1).source, "voice_result");
});

test("receipts for unknown messages and submitted/queued receipts change nothing", async () => {
  const h = delegationHarness();
  assert.equal(h.engine.onReceipt({ msgId: "nope", how: "appended" }), null);
  const rec = await sentRecord(h, "d1", "hello there", 1000);
  assert.equal(h.engine.onReceipt({ msgId: rec.msg_id, how: "submitted" }), null);
  assert.equal(h.engine.onReceipt({ msgId: rec.msg_id, how: "queued" }), null);
  assert.equal(rec.status, "sent");
});

test("turn events: exact busy state; aborted interrupts the turn's delivered requests", async () => {
  const h = delegationHarness();
  h.engine.onTurn({ phase: "start" });
  assert.equal(h.engine.claudeBusy, true);
  h.engine.onHook("UserPromptSubmit", { prompt: "[sotto voice] go", prompt_id: "p1" });
  const rec = await sentRecord(h, "d1", "run it", 1000);
  h.engine.onReceipt({ msgId: rec.msg_id, how: "appended", promptId: "p1" });
  h.engine.onTurn({ phase: "complete", reason: "aborted" });
  assert.equal(h.engine.claudeBusy, false);
  assert.equal(rec.status, "interrupted");
});
