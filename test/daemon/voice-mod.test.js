// The mod link wired into the daemon (SPEC §6.21): hello, transport choice
// and mid-session failover to classic, one event source per session,
// receipts and the requeue nudge, release on off, restore after a handover.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHarness, SESSION } from "../helpers/daemon-harness.js";
import { flushMicrotasks } from "../helpers/fake-clock.js";
import { TAKE_MS, LOST_MS } from "../../daemon/modlink.js";
import { REQUEUE_NUDGE } from "../../daemon/delegation.js";
import { voiceMarker } from "../../daemon/config.js";

const SOCK = "/tmp/clv-owner-a.sock";
const activeOwner = (h) => fs.readFileSync(path.join(h.dataDir, "active"), "utf8").split("\t")[0];

async function linked() {
  const h = await makeHarness();
  h.on(SESSION(SOCK));
  const r = h.voice.modHello({ instance: "inst-1", socket: SOCK, session_id: "sess-a", cli: "2.1.287", mod: "1" });
  assert.equal(r.status, 200);
  return h;
}

test("hello: only the owner session's mod links; the active file then silences its shell hooks", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  assert.equal(h.voice.modHello({ instance: "inst-1", socket: SOCK }).status, 409, "no owner yet");
  h.on(SESSION(SOCK));
  assert.equal(activeOwner(h), SOCK);
  assert.equal(h.voice.modHello({ instance: "inst-1", socket: "/tmp/other.sock" }).status, 409);
  assert.equal(h.voice.modHello({ instance: "x", socket: SOCK }).status, 400, "bad instance id");
  const r = h.voice.modHello({ instance: "inst-1", socket: SOCK, cli: "2.1.287" });
  assert.equal(r.status, 200);
  assert.equal(r.body.nonce, h.voice.nonce);
  assert.equal(h.voice.owner.transport, "mod");
  assert.equal(activeOwner(h), `mod:${SOCK}`);
  assert.match(h.voice.statusMessage(), /\| link mod$/);
  assert.equal(h.voice.status().integration.mode, "mod");
  assert.equal(h.voice.status().owner.transport, "mod");
  assert.equal(h.log.find("modlink.up").length, 1);
});

test("a voice message goes through the mod when it takes it; no inbox write", async (t) => {
  const h = await linked();
  t.after(() => h.cleanup());
  const poll = h.voice.modPoll({ instance: "inst-1", after: 0 });
  await flushMicrotasks();
  const sent = h.voice.inboxSend("[sotto voice] hello", "clv-1-1");
  const p = await poll;
  assert.equal(p.body.items[0].msg_id, "clv-1-1");
  assert.deepEqual(await sent, { ok: true, via: "mod", how: "taken" });
  assert.equal(h.inboxSends.length, 0);
  assert.equal(h.log.find("inbox.send").at(-1).via, "mod");
});

test("failover mid-session: a message the mod does not take goes the classic way, and the shell hooks take over", async (t) => {
  const h = await linked();
  t.after(() => h.cleanup());
  const sent = h.voice.inboxSend("[sotto voice] hello", "clv-1-1");
  await h.clock.advance(TAKE_MS);
  const r = await sent;
  assert.equal(r.ok, true);
  assert.equal(h.inboxSends.length, 1, "sent once, the classic way");
  assert.equal(h.inboxSends[0].content, "[sotto voice] hello");
  assert.equal(h.voice.modActive(), false);
  assert.equal(h.voice.owner.transport, "inbox");
  assert.equal(activeOwner(h), SOCK, "hook.sh is live again");
  assert.match(h.voice.statusMessage(), /\| link classic$/);
  assert.equal(h.log.find("modlink.fallback")[0].reason, "not_taken");
  // The shell's hooks count again; the old mod's events are refused.
  assert.equal(h.voice.handleHook("UserPromptSubmit", { prompt: "hi", prompt_id: "p1" }, SOCK), true);
  assert.equal(h.voice.modEvents({ instance: "inst-1", events: [{ seq: 1, kind: "classic", event: "Stop", body: {} }] }).status, 410);
  // The next message does not wait on a gone mod.
  await h.voice.inboxSend("[sotto voice] again", "clv-2-1");
  assert.equal(h.inboxSends.length, 2);
});

test("heartbeat loss also fails over; the same mod can link again", async (t) => {
  const h = await linked();
  t.after(() => h.cleanup());
  await h.clock.advance(LOST_MS + 6000); // the 5 s check runs
  assert.equal(h.voice.modActive(), false);
  assert.equal(activeOwner(h), SOCK);
  assert.equal(h.log.find("modlink.fallback")[0].reason, "heartbeat");
  assert.equal(h.voice.modHello({ instance: "inst-1", socket: SOCK }).status, 200);
  assert.equal(activeOwner(h), `mod:${SOCK}`);
});

test("one event source: shell hooks are ignored while linked, the uplink's events are handled in seq order", async (t) => {
  const h = await linked();
  t.after(() => h.cleanup());
  assert.equal(h.voice.handleHook("UserPromptSubmit", { prompt: "typed", prompt_id: "p1" }, SOCK), false);
  assert.equal(h.voice.delegation.claudeBusy, false);
  const r = h.voice.modEvents({ instance: "inst-1", events: [
    { seq: 2, kind: "turn", phase: "start", turn_id: "t1" },
    { seq: 1, kind: "classic", event: "UserPromptSubmit", body: { prompt: "typed", prompt_id: "p1", session_id: "sess-b" } },
  ] });
  assert.deepEqual(r, { status: 200, body: { ok: true, acked: 2 } });
  assert.equal(h.voice.delegation.claudeBusy, true);
  assert.equal(h.voice.owner.session_id, "sess-b");
  assert.equal(h.log.find("hook").at(-1).via, "mod");
  // A retried batch is not handled twice.
  h.voice.modEvents({ instance: "inst-1", events: [{ seq: 2, kind: "turn", phase: "start" }, { seq: 3, kind: "turn", phase: "complete", reason: "answer" }] });
  assert.equal(h.voice.delegation.claudeBusy, false);
  assert.equal(h.voice.modlink.counters.dup_events, 1);
  assert.equal(h.log.find("claude.turn").length, 1);
});

test("the adapted PreToolUse reaches the tool narration like the shell's", async (t) => {
  const h = await linked();
  t.after(() => h.cleanup());
  h.voice.modEvents({ instance: "inst-1", events: [
    { seq: 1, kind: "classic", event: "UserPromptSubmit", body: { prompt: "go", prompt_id: "p1" } },
    { seq: 2, kind: "classic", event: "PreToolUse", body: { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { description: "x", prompt: "y" }, tool_use_id: "tu1", prompt_id: "p1" } },
  ] });
  const hook = h.log.find("hook").at(-1);
  assert.equal(hook.tool_name, "Agent");
});

test("receipts: appended delivers a delegation in the running turn; requeued sends a nudge once Claude is idle", async (t) => {
  const h = await linked();
  t.after(() => h.cleanup());
  const d = h.voice.delegation;
  const rec = { id: 7, rev: 1, status: "sent", msg_id: "clv-7-1", content: `${voiceMarker(h.voice.nonce)} do it`, text: "do it", sent_at: h.clock.now(), prompt_id: null, live_id: null };
  d.records.push(rec);
  d.promptId = "p9";
  h.voice.modEvents({ instance: "inst-1", events: [{ seq: 1, kind: "receipt", msg_id: "clv-7-1", how: "appended", prompt_id: "p9" }] });
  assert.equal(rec.status, "delivered");
  assert.equal(rec.prompt_id, "p9");
  // Landed after the last model request: requeued before the Stop.
  const poll = h.voice.modPoll({ instance: "inst-1", after: 0 });
  await flushMicrotasks();
  h.voice.modEvents({ instance: "inst-1", events: [{ seq: 2, kind: "receipt", msg_id: "clv-7-1", how: "requeued" }] });
  assert.equal(rec.status, "sent");
  assert.equal(rec.requeued, true);
  const nudge = `${voiceMarker(h.voice.nonce)} ${REQUEUE_NUDGE}`;
  assert.equal(rec.content, nudge);
  const p = await poll;
  assert.deepEqual(p.body.items.map((i) => [i.msg_id, i.text, i.submit_only]), [["clv-7-1-n", nudge, true]]);
  // The nudge's own prompt delivers the record; its Stop answers it.
  h.voice.modEvents({ instance: "inst-1", events: [{ seq: 3, kind: "classic", event: "UserPromptSubmit", body: { prompt: nudge, prompt_id: "p10" } }] });
  assert.equal(rec.status, "delivered");
  assert.equal(rec.prompt_id, "p10");
});

test("a failed receipt sends the message the classic way and leaves mod mode", async (t) => {
  const h = await linked();
  t.after(() => h.cleanup());
  h.voice.modEvents({ instance: "inst-1", events: [{ seq: 1, kind: "receipt", msg_id: "m1", how: "failed", error: "refused", text: "[sotto voice] x", priority: "next" }] });
  await flushMicrotasks();
  assert.equal(h.voice.modActive(), false);
  assert.equal(h.inboxSends.length, 1);
  assert.equal(h.inboxSends[0].content, "[sotto voice] x");
});

test("an interrupted turn (Esc) ends its voice requests at once", async (t) => {
  const h = await linked();
  t.after(() => h.cleanup());
  const d = h.voice.delegation;
  const rec = { id: 3, rev: 1, status: "delivered", msg_id: "clv-3-1", prompt_id: "p1", sent_at: h.clock.now(), live_id: null };
  d.records.push(rec);
  d.promptId = "p1";
  h.voice.modEvents({ instance: "inst-1", events: [{ seq: 1, kind: "turn", phase: "start" }, { seq: 2, kind: "turn", phase: "complete", reason: "aborted" }] });
  assert.equal(rec.status, "interrupted");
  assert.equal(d.claudeBusy, false);
});

test("voice off releases the mod: its poll is told to stop, the active file goes", async (t) => {
  const h = await linked();
  t.after(() => h.cleanup());
  const poll = h.voice.modPoll({ instance: "inst-1", after: 0 });
  await flushMicrotasks();
  h.voice.control({ action: "off" });
  await h.clock.advance(20000);
  const p = await poll;
  assert.equal(p.body.release, "off");
  assert.equal(h.voice.modlink.linked, false);
  assert.equal(fs.existsSync(path.join(h.dataDir, "active")), false);
});

test("a new owner session releases the old session's mod", async (t) => {
  const h = await linked();
  t.after(() => h.cleanup());
  h.on(SESSION("/tmp/clv-owner-b.sock"));
  assert.equal(h.voice.modlink.linked, false);
  assert.equal(h.voice.owner.transport, "inbox");
  assert.equal(activeOwner(h), "/tmp/clv-owner-b.sock");
  // /talk on again in the linked session keeps its link.
  assert.equal(h.voice.modHello({ instance: "inst-2", socket: "/tmp/clv-owner-b.sock" }).status, 200);
  h.on(SESSION("/tmp/clv-owner-b.sock"));
  assert.equal(h.voice.modActive(), true);
  assert.equal(activeOwner(h), "mod:/tmp/clv-owner-b.sock");
});

test("a handover successor starts classic (no link yet) and rewrites the active file with the real socket", async (t) => {
  const h = await linked();
  t.after(() => h.cleanup());
  const snap = JSON.parse(JSON.stringify(h.voice.snapshot({ resume: "paused" })));
  assert.equal(snap.owner.transport, "mod");
  const b = await makeHarness({ dataDir: h.dataDir });
  t.after(() => b.d.close());
  assert.equal(b.voice.restore(snap), true);
  assert.equal(b.voice.owner.transport, "inbox");
  assert.equal(activeOwner(b), SOCK);
  assert.equal(b.voice.modHello({ instance: "inst-9", socket: SOCK }).status, 200);
});

test("pending-context (hook.sh's fallback) is not created while the mod frames its own appends", async (t) => {
  const h = await linked();
  t.after(() => h.cleanup());
  h.voice.delegation.fx.createPendingContext();
  assert.equal(fs.existsSync(path.join(h.dataDir, "pending-context")), false);
});
