// Mod link phases 4-6 in the daemon (SPEC §6.21): UI state pushed to the
// mod, the conversation for the seed, agent ancestry, approvals by id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, SESSION } from "../helpers/daemon-harness.js";
import { flushMicrotasks } from "../helpers/fake-clock.js";
import { ModLink } from "../../daemon/modlink.js";
import { createFakeClock } from "../helpers/fake-clock.js";

const SOCK = "/tmp/clv-owner-a.sock";

async function linked() {
  const h = await makeHarness();
  h.on(SESSION(SOCK));
  const r = h.voice.modHello({ instance: "inst-1", socket: SOCK, cli: "2.1.287" });
  assert.equal(r.status, 200);
  h.hello = r.body;
  return h;
}

test("ModLink UI state: versioned, deduped, answered at once to an older version", async () => {
  const clock = createFakeClock();
  const m = new ModLink({ clock });
  m.hello({ instance: "i1" });
  assert.equal(m.setState({ state: "live" }), true);
  assert.equal(m.setState({ state: "live" }), false, "same state: no new version");
  const r = await m.poll({ instance: "i1", after: 0, sv: 0 });
  assert.deepEqual(r.body, { items: [], seq: 0, sv: 1, state: { state: "live" } });
  let answered = null;
  m.poll({ instance: "i1", after: 0, sv: 1 }).then((x) => { answered = x; });
  await flushMicrotasks();
  assert.equal(answered, null, "up to date: parked");
  m.setState({ state: "sleeping" });
  await flushMicrotasks();
  assert.deepEqual(answered.body.state, { state: "sleeping" });
  // An older mod (no sv) is never answered for state.
  let old = null;
  m.poll({ instance: "i1", after: 0 }).then((x) => { old = x; });
  m.setState({ state: "live" });
  await flushMicrotasks();
  assert.equal(old, null);
});

test("hello hands the mod the data dir; the voice's state follows changes", async (t) => {
  const h = await linked();
  t.after(() => h.cleanup());
  assert.equal(h.hello.data_dir, h.dataDir);
  const p = await h.voice.modPoll({ instance: "inst-1", after: 0, sv: 0 });
  assert.equal(p.body.state.persona, "sotto");
  assert.ok(["paused", "waiting_page"].includes(p.body.state.state), p.body.state.state);
  const sv = p.body.sv;
  let next = null;
  h.voice.modPoll({ instance: "inst-1", after: 0, sv }).then((x) => { next = x; });
  await flushMicrotasks();
  h.voice.modEvents({ instance: "inst-1", events: [{ seq: 1, kind: "turn", phase: "start" }] });
  await flushMicrotasks();
  assert.equal(next?.body.state.busy, true);
});

test("the seed reads the mod's copy of the conversation", async (t) => {
  const h = await linked();
  t.after(() => h.cleanup());
  h.voice.modEvents({ instance: "inst-1", events: [{ seq: 1, kind: "context", messages: [
    { role: "user", text: "/talk on" }, { role: "user", text: "rename the helper" }, { role: "assistant", text: "Renamed `helper.js` to `util.js`." }, { role: "system", text: "x" },
  ] }] });
  assert.deepEqual(h.voice.modContext.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(h.voice.modContext.messages[0].text, "rename the helper");
  assert.ok(!h.voice.modContext.messages[1].text.includes("`"), "assistant text made speakable");
});

test("agent ancestry: helpers (spawned by a subagent or a plugin) are never counted", async (t) => {
  const h = await linked();
  t.after(() => h.cleanup());
  h.voice.modEvents({ instance: "inst-1", events: [
    { seq: 1, kind: "agent", agent_id: "a-user", parent_agent_id: null, origin: "engine" },
    { seq: 2, kind: "agent", agent_id: "a-nested", parent_agent_id: "a-user", origin: "engine" },
    { seq: 3, kind: "agent", agent_id: "a-plugin", parent_agent_id: null, origin: "some-plugin" },
    { seq: 4, kind: "classic", event: "PreToolUse", body: { tool_name: "Read", tool_input: {}, tool_use_id: "t1", agent_id: "a-user" } },
    { seq: 5, kind: "classic", event: "PreToolUse", body: { tool_name: "Read", tool_input: {}, tool_use_id: "t2", agent_id: "a-nested" } },
    { seq: 6, kind: "classic", event: "PreToolUse", body: { tool_name: "Read", tool_input: {}, tool_use_id: "t3", agent_id: "a-plugin" } },
  ] });
  assert.equal(h.voice.agents.count(), 1);
  assert.equal(h.voice.agents.isIgnored("a-nested"), true);
  assert.equal(h.voice.agents.complete("a-plugin"), false);
});

test("approvals: the mod's resolved event closes the pending approval by tool_use_id", async (t) => {
  const h = await linked();
  t.after(() => h.cleanup());
  h.voice.modEvents({ instance: "inst-1", events: [
    { seq: 1, kind: "classic", event: "UserPromptSubmit", body: { prompt: "go", prompt_id: "p1" } },
    { seq: 2, kind: "classic", event: "PreToolUse", body: { tool_name: "Bash", tool_input: { command: "rm -rf build" }, tool_use_id: "tu9", prompt_id: "p1" } },
    { seq: 3, kind: "approval", phase: "ask", tool_use_id: "tu9", tool: "Bash" },
    { seq: 4, kind: "classic", event: "PermissionRequest", body: { tool_name: "Bash", tool_input: { command: "rm -rf build" } } },
  ] });
  assert.equal(h.voice.approvals.size, 1);
  assert.ok(h.voice.modUiState().approval);
  h.voice.modEvents({ instance: "inst-1", events: [{ seq: 5, kind: "approval", phase: "resolved", tool_use_id: "tu9", outcome: "done" }] });
  assert.equal(h.voice.approvals.size, 0);
  assert.deepEqual(h.log.find("claude.approval").map((e) => e.phase), ["ask", "resolved"]);
});
