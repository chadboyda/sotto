// Voice orchestrator: regression tests for the v1 review fixes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { relay } from "../../daemon/phrasing.js";
import fs from "node:fs";
import path from "node:path";
import { makeHarness, SESSION } from "../helpers/daemon-harness.js";
import { estTokens } from "../../daemon/speech.js";

const OWNER = "/tmp/clv-owner-a.sock";
const appends = (ws, kind) => ws.sent.filter((e) => e.type === `session.${kind}.append`);

/** Speak a request and let the delegation settle and send. Returns the record id. */
async function ask(h, ws, id, words = "what branch am I on") {
  words.split(" ").forEach((w, i) => ws.receive({ type: "session.input_transcript.delta", delta: " " + w, start_ms: 1000 + i * 200, end_ms: 1200 + i * 200 }));
  ws.receive({ type: "session.delegation.created", offset_ms: 2000, delegation: { id, type: "delegation", target: "client" } });
  await h.clock.advance(700);
  return h.voice.delegation.get(id);
}

test("an answer to a request from before a reconnect is sent with delegation_id null", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  let ws = await h.goLive();
  const rec = await ask(h, ws, "item_old");
  h.voice.handleHook("UserPromptSubmit", { prompt: rec.content, prompt_id: "p1" }, OWNER);
  ws.receive({ type: "session.closed", reason: "connection_lost", usage: { seconds: 5 } });
  ws = await h.goLive({ reason: "reconnect" });
  h.voice.handleHook("Stop", { last_assistant_message: "You are on main.", prompt_id: "p1" }, OWNER);
  await h.clock.advance(0);
  const c = appends(ws, "commentary").at(-1);
  assert.equal(c.delegation_id, null);
  assert.equal(c.content, relay("earlier", "You are on main.", { requestText: "what branch am I on" }));
  assert.match(c.content, /earlier request "what branch am I on"/);
});

test("append_failed: a rejected delegation id is retried once with null", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  h.voice.deliver({ kind: "commentary", content: "Claude Code's answer: done.", delegationId: "item_unknown" });
  const sent = appends(ws, "commentary").at(-1);
  ws.receive({ type: "error", error: { type: "invalid_request_error", code: "invalid_value", param: "delegation_id", message: "Unknown delegation", client_event_id: sent.event_id } });
  const retry = appends(ws, "commentary").at(-1);
  assert.notEqual(retry.event_id, sent.event_id);
  assert.deepEqual([retry.delegation_id, retry.content], [null, "Claude Code's answer: done."]);
  ws.receive({ type: "error", error: { type: "invalid_request_error", code: "invalid_value", message: "again", client_event_id: retry.event_id } });
  assert.equal(appends(ws, "commentary").length, appends(ws, "commentary").indexOf(retry) + 1, "retried at most once");
});

test("append_failed: an over-long append is split and resent", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  const text = "Results. " + "A fairly ordinary sentence about the change. ".repeat(25);
  h.voice.deliver({ kind: "thinking", content: text, delegationId: null });
  const sent = appends(ws, "thinking").at(-1);
  const n = appends(ws, "thinking").length;
  ws.receive({ type: "error", error: { type: "invalid_request_error", code: "string_above_max_length", message: "content exceeds the maximum of 500 tokens", client_event_id: sent.event_id } });
  const parts = appends(ws, "thinking").slice(n);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(estTokens(p.content) <= 225);
});

test("deliver keeps CJK text under the token budget (split, not rejected)", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  const before = appends(ws, "commentary").length;
  h.voice.deliver({ kind: "commentary", content: "テストはすべて成功しました。".repeat(80), delegationId: null });
  const parts = appends(ws, "commentary").slice(before);
  assert.ok(parts.length >= 2, "split");
  for (const p of parts) assert.ok(estTokens(p.content) <= 450, `est ${estTokens(p.content)}`);
  assert.equal(h.log.find("append.invalid").length, 0);
});

test("no idle close while Claude is still working on a voice request (bounded at 30 min)", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive({ config: { idle_minutes: 1 } });
  const rec = await ask(h, ws, "item_1");
  h.voice.handleHook("UserPromptSubmit", { prompt: rec.content, prompt_id: "p1" }, OWNER);
  await h.clock.advance(10 * 60_000);
  assert.equal(ws.sentOfType("session.close").length, 0);
  assert.equal(h.voice.state, "live");
  await h.clock.advance(21 * 60_000); // past the 30 min bound
  assert.equal(ws.sentOfType("session.close").length, 1);
});

test("reconnect with no page listening: reopen the window, then pause after 30 s", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  const opened = h.chrome.opened;
  ws.receive({ type: "session.closed", reason: "connection_lost", usage: { seconds: 5 } });
  assert.equal(h.voice.state, "reconnecting");
  assert.equal(h.chrome.opened, opened, "a page between stream retries gets a few seconds");
  await h.clock.advance(4_000);
  assert.equal(h.chrome.opened, opened + 1, "the one-shot command had no listener");
  await h.clock.advance(26_000);
  assert.equal(h.voice.state, "paused");
  assert.equal(h.voice.status().last_error.code, "connection_lost");
});

test("reconnect watch is cleared when the page starts the new session", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  let ws = await h.goLive();
  ws.receive({ type: "session.closed", reason: "connection_lost", usage: { seconds: 5 } });
  const opened = h.chrome.opened;
  ws = await h.goLive({ reason: "reconnect" });
  await h.clock.advance(40_000);
  assert.equal(h.voice.state, "live");
  assert.equal(h.chrome.opened, opened, "no extra window once the page reconnected");
});

test("/talk on while stuck in reconnecting (no sideband) asks the page again", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  ws.receive({ type: "session.closed", reason: "connection_lost", usage: { seconds: 5 } });
  assert.equal(h.voice.state, "reconnecting");
  h.d.sse.clients.add({ write() {}, end() {} }); // a page is back
  const r = h.on();
  assert.equal(r.message, "sotto: voice ON (proj-a).");
  assert.equal(h.voice.state, "waiting_page");
  assert.equal(h.commands().at(-1), "connect:on");
});

test("owner switch resets busy state and removes pending-context", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  await h.goLive();
  h.voice.handleHook("PreToolUse", { tool_name: "Bash", prompt_id: "pA" }, OWNER);
  assert.equal(h.voice.delegation.claudeBusy, true);
  const flag = path.join(h.dataDir, "pending-context");
  fs.writeFileSync(flag, "");
  const nonceA = h.voice.nonce;
  h.on(SESSION("/tmp/clv-owner-b.sock", { cwd: "/work/proj-b", project_dir: "/work/proj-b" }));
  assert.equal(h.voice.delegation.claudeBusy, false);
  assert.ok(!fs.existsSync(flag));
  assert.notEqual(h.voice.nonce, nonceA, "a new bind gets a new marker nonce");
});

test("voice off resets busy state for the next /talk on", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  h.on();
  h.voice.handleHook("PreToolUse", { tool_name: "Bash" }, OWNER);
  h.voice.control({ action: "off" });
  await h.clock.advance(100);
  assert.equal(h.voice.delegation.claudeBusy, false);
});

test("subagent hooks never mark the main thread busy", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  h.voice.handleHook("PreToolUse", { tool_name: "Grep", agent_id: "agent-1", agent_type: "Explore" }, OWNER);
  assert.equal(h.voice.delegation.claudeBusy, false);
  h.voice.handleHook("PermissionRequest", { tool_name: "Bash", agent_id: "agent-1" }, OWNER);
  assert.equal(h.voice.delegation.claudeBusy, false);
  assert.match(appends(ws, "commentary").at(-1).content, /your approval in the terminal/, "permission is still announced");
});

test("a final MessageDisplay that arrives after Stop is not re-spoken and does not set busy", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive({ config: { speaking_policy: "walkthrough" } });
  h.voice.handleHook("UserPromptSubmit", { prompt: "typed", prompt_id: "p1" }, OWNER);
  h.voice.handleHook("MessageDisplay", { prompt_id: "p1", message_id: "m1", index: 0, final: false, delta: "Here is the answer.\n" }, OWNER);
  h.voice.handleHook("Stop", { prompt_id: "p1", last_assistant_message: "Here is the answer." }, OWNER);
  await h.clock.advance(0);
  h.voice.handleHook("MessageDisplay", { prompt_id: "p1", message_id: "m1", index: 1, final: true, delta: "" }, OWNER);
  assert.equal(h.voice.delegation.claudeBusy, false);
  assert.equal(h.voice.narrator.held, null);
  const before = ws.sent.length;
  h.voice.handleHook("UserPromptSubmit", { prompt: "next", prompt_id: "p2" }, OWNER);
  h.voice.handleHook("PreToolUse", { prompt_id: "p2", tool_name: "Bash" }, OWNER);
  await h.clock.advance(3000);
  assert.ok(!ws.sent.slice(before).some((e) => /Here is the answer/.test(e.content || "")), "previous answer not replayed as progress");
});
