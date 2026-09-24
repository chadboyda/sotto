// Pending tool approvals (SPEC §6.10.4): keyed by tool_use_id, cleared on the
// first evidence the prompt was answered, subagent prompts labelled, spoken
// every time, reminded at 2 and 5 minutes, and a running approved command
// clears the card.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Approvals, REMIND_AT_MS, SIBLING_GRACE_MS, commandFingerprint, findRunning } from "../../daemon/approvals.js";
import { reminderSpeech } from "../../daemon/policy.js";
import { createFakeClock } from "../helpers/fake-clock.js";
import { makeHarness } from "../helpers/daemon-harness.js";

const OWNER = "/tmp/clv-owner-a.sock";
const appends = (ws, kind) => ws.sent.filter((e) => e.type === `session.${kind}.append`);
const said = (ws) => appends(ws, "commentary").map((e) => e.content);
const activities = (h) => h.sse.filter((m) => m.type === "activity" && m.kind !== "agents");
const lastActivity = (h) => activities(h).at(-1);
const CMD = "cd /tmp && python3 render_frames.py --out /tmp/sotto-frames --count 60";

// ---- pure --------------------------------------------------------------------------------

test("Approvals: a request is keyed by the thread's matching PreToolUse; PostToolUse for that id clears it", () => {
  const clock = createFakeClock();
  const a = new Approvals({ clock });
  a.onPreToolUse({ tool_use_id: "toolu_1", tool_name: "Bash", tool_input: { command: CMD } });
  const { approval, fresh } = a.onRequest({ tool_name: "Bash", tool_input: { command: CMD } }, "run a shell command");
  assert.equal(fresh, true);
  assert.equal(approval.id, "toolu_1");
  assert.equal(approval.agent, false);
  assert.equal(a.onRequest({ tool_name: "Bash", tool_input: { command: CMD } }).fresh, false, "a repeated hook is the same approval");
  assert.deepEqual(a.onToolDone({ tool_use_id: "toolu_other" }), []);
  const done = a.onToolDone({ tool_use_id: "toolu_1" });
  assert.deepEqual(done.map((p) => [p.id, p.reason]), [["toolu_1", "tool_done"]]);
  assert.equal(a.size, 0);
});

test("Approvals: a later PreToolUse of the same thread clears it (a parallel sibling within the grace does not)", async () => {
  const clock = createFakeClock();
  const a = new Approvals({ clock });
  a.onPreToolUse({ tool_use_id: "t1", tool_name: "Bash", tool_input: { command: "npm test" } });
  a.onRequest({ tool_name: "Bash", tool_input: { command: "npm test" } });
  assert.deepEqual(a.onPreToolUse({ tool_use_id: "t2", tool_name: "Read", tool_input: {} }), [], "sibling in the same batch");
  await clock.advance(SIBLING_GRACE_MS);
  assert.deepEqual(a.onPreToolUse({ tool_use_id: "t3", tool_name: "Read", agent_id: "agent-x", tool_input: {} }), [], "another thread");
  assert.deepEqual(a.onPreToolUse({ tool_use_id: "t4", tool_name: "Read", tool_input: {} }).map((p) => p.reason), ["next_tool"]);
});

test("Approvals: subagent prompts belong to the agent; the main thread's Stop and events leave them alone", () => {
  const clock = createFakeClock();
  const a = new Approvals({ clock });
  a.onPreToolUse({ tool_use_id: "ta", agent_id: "agent-1", tool_name: "Bash", tool_input: { command: CMD } });
  const { approval } = a.onRequest({ agent_id: "agent-1", tool_name: "Bash", tool_input: { command: CMD } }, "run a shell command");
  assert.equal(approval.id, "ta");
  assert.equal(approval.agent, true);
  assert.deepEqual(a.onThreadEnd({}), [], "main-thread Stop");
  assert.deepEqual(a.onThreadEnd({ agent_id: "agent-2" }), [], "another agent's SubagentStop");
  assert.deepEqual(a.onThreadEnd({ agent_id: "agent-1" }).map((p) => p.reason), ["stop"]);
});

test("Approvals: without a matching PreToolUse the request gets its own id; the thread's next finished tool clears it", async () => {
  const clock = createFakeClock();
  const a = new Approvals({ clock });
  const { approval } = a.onRequest({ tool_name: "Edit", tool_input: { file_path: "/a/b.js" } }, "edit b.js");
  assert.match(approval.id, /^perm-/);
  await clock.advance(SIBLING_GRACE_MS);
  assert.equal(a.onToolDone({ tool_use_id: "toolu_z" }).length, 1);
  a.onRequest({ tool_name: "Edit", tool_input: { file_path: "/a/c.js" } });
  assert.equal(a.onUserPrompt().length, 1, "UserPromptSubmit clears everything");
});

test("Approvals: reminders fall due at 2 and 5 minutes, at most twice", async () => {
  const clock = createFakeClock();
  const a = new Approvals({ clock });
  assert.deepEqual(REMIND_AT_MS, [120_000, 300_000]);
  const { approval } = a.onRequest({ tool_name: "Bash", tool_input: { command: "x" } }, "run a shell command");
  assert.equal(a.nextDueAt(), approval.at + 120_000);
  await clock.advance(119_999);
  assert.deepEqual(a.takeDue(), []);
  await clock.advance(1);
  assert.equal(a.takeDue().length, 1);
  approval.reminders = 1;
  assert.equal(a.nextDueAt(), approval.at + 300_000);
  approval.reminders = 2;
  assert.equal(a.nextDueAt(), null);
});

test("commandFingerprint / findRunning: the approved command as Claude Code's shell runs it", () => {
  const cmd = "cd /tmp && O=/Users/me/p/stills && rm -f $O/*.png && echo 'done rendering'";
  const fp = commandFingerprint(cmd);
  assert.equal(fp, "cd /tmp && O=/Users/me/p/stills && rm -f $O/*.png && echo");
  // Measured shape of the running shell's argv (quotes rewritten as '"'"').
  const ps = [
    "  101 /bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval 'cd /tmp && O=/Users/me/p/stills && rm -f $O/*.png && echo '\"'\"'done rendering'\"'\"'' < /dev/null && pwd -P >| /tmp/claude-a065-cwd",
    "  102 /usr/sbin/cfprefsd agent",
  ].join("\n");
  assert.equal(findRunning(ps, fp), true);
  assert.equal(findRunning(ps, fp, [101]), false, "our own pids are skipped");
  assert.equal(findRunning("  7 /bin/zsh -c eval 'npm test'", commandFingerprint("npm test")), false, "too short to be distinctive: never guessed");
  assert.equal(commandFingerprint("ls"), null);
});

test("reminderSpeech: Claude, a background agent, several", () => {
  assert.equal(reminderSpeech([{ label: "run a shell command" }]), "By the way, Claude's still waiting on your approval to run a shell command.");
  assert.equal(reminderSpeech([{ label: "edit a.js", agent: true }]), "By the way, a background agent is still waiting on your approval to edit a.js.");
  assert.equal(reminderSpeech([{ label: "x" }, { label: "y" }]), "By the way, 2 approvals are still waiting for you in the terminal.");
});

// ---- voice (daemon harness) --------------------------------------------------------------

async function live(t, config = {}) {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive({ config: { idle_seconds: 0, ...config } });
  const hook = (ev, b) => h.voice.handleHook(ev, b, OWNER);
  return { h, ws, hook, flag: () => fs.existsSync(path.join(h.dataDir, "approval-pending")) };
}

test("lifecycle: request, then PostToolUse for that tool_use_id, then the card and the word clear", async (t) => {
  const { h, ws, hook, flag } = await live(t);
  hook("UserPromptSubmit", { prompt: "deploy it", prompt_id: "p1" });
  hook("PreToolUse", { prompt_id: "p1", tool_use_id: "toolu_1", tool_name: "Bash", tool_input: { command: CMD } });
  hook("PermissionRequest", { prompt_id: "p1", tool_name: "Bash", tool_input: { command: CMD } });
  assert.equal(said(ws).at(-1), "Claude needs your approval in the terminal to run a shell command.");
  assert.deepEqual([lastActivity(h).kind, lastActivity(h).text, lastActivity(h).agent], ["permission", "Claude needs approval to run a shell command", false]);
  assert.equal(h.voice.status().claude.approval.label, "run a shell command");
  assert.equal(h.voice.pageStatus().claude.approval.agent, false);
  assert.equal(flag(), true, "hook.sh forwards PostToolUse while this exists");

  hook("PostToolUse", { prompt_id: "p1", tool_use_id: "toolu_1", tool_name: "Bash", tool_input: { command: CMD }, tool_response: { stdout: "ok" } });
  assert.deepEqual([lastActivity(h).kind, lastActivity(h).busy], ["approval_cleared", true], "Claude is still working on the turn");
  assert.equal(h.voice.status().claude.approval, null);
  assert.equal(h.voice.pageStatus().claude.approval, null);
  assert.equal(flag(), false);
  assert.equal(h.log.find("approval.resolved")[0].reason, "tool_done");
  await h.clock.advance(10 * 60_000);
  assert.ok(!said(ws).some((c) => /By the way/.test(c)), "no reminder for an answered prompt");
});

test("lifecycle: a later PreToolUse, a Stop or a typed prompt also clear it; a denied call's failure too", async (t) => {
  const { h, hook } = await live(t);
  const ask = (id) => {
    hook("PreToolUse", { tool_use_id: id, tool_name: "Bash", tool_input: { command: `${CMD} ${id}` } });
    hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: `${CMD} ${id}` } });
    assert.equal(lastActivity(h).kind, "permission");
  };
  ask("t1");
  await h.clock.advance(2000);
  hook("PreToolUse", { tool_use_id: "t2", tool_name: "Read", tool_input: { file_path: "/a" } });
  assert.equal(activities(h).at(-2).kind, "approval_cleared");
  ask("t3");
  hook("Stop", { last_assistant_message: "Done." });
  assert.equal(h.voice.status().claude.approval, null);
  ask("t4");
  hook("UserPromptSubmit", { prompt: "never mind", prompt_id: "p9" });
  assert.equal(h.voice.status().claude.approval, null);
  ask("t5");
  hook("PostToolUseFailure", { tool_use_id: "t5", tool_name: "Bash", error: "The user doesn't want to proceed with this tool use." });
  assert.equal(h.voice.status().claude.approval, null);
  assert.deepEqual(h.log.find("approval.resolved").map((l) => l.reason), ["next_tool", "stop", "prompt", "tool_done"]);
});

test("subagent approval: labelled as a background agent; cleared by that agent's events or SubagentStop only", async (t) => {
  const { h, ws, hook } = await live(t);
  const agent = { agent_id: "a1952219675aab53c", agent_type: "workflow-subagent" };
  hook("PreToolUse", { ...agent, tool_use_id: "toolu_017V", tool_name: "Bash", tool_input: { command: CMD } });
  hook("PermissionRequest", { ...agent, tool_name: "Bash", tool_input: { command: CMD } });
  assert.equal(said(ws).at(-1), "A background agent is waiting for your approval in the terminal to run a shell command.");
  assert.deepEqual([lastActivity(h).kind, lastActivity(h).text, lastActivity(h).agent], ["permission", "A background agent needs approval to run a shell command", true]);
  assert.equal(h.voice.status().claude.approval.agent, true);

  // The main thread and other agents keep working: not evidence.
  await h.clock.advance(5000);
  hook("PreToolUse", { tool_use_id: "m1", tool_name: "Read", tool_input: { file_path: "/x" } });
  hook("PreToolUse", { agent_id: "other", tool_use_id: "o1", tool_name: "Read", tool_input: { file_path: "/y" } });
  hook("UserPromptSubmit", { prompt: "<task-notification><task-id>b1</task-id><status>completed</status></task-notification>" });
  hook("Stop", { last_assistant_message: "Waiting on the agents." });
  assert.equal(h.voice.status().claude.approval?.agent, true, "still pending");
  hook("SubagentStop", { agent_id: "other", agent_type: "Explore", last_assistant_message: "done" });
  assert.equal(h.voice.status().claude.approval?.agent, true);

  hook("SubagentStop", { ...agent, last_assistant_message: "Rendered." });
  assert.equal(h.voice.status().claude.approval, null);
  assert.deepEqual([lastActivity(h).kind, lastActivity(h).busy], ["approval_cleared", false], "the main thread is idle: the card goes back to idle/finished");

  // And the agent's next tool call clears a second one.
  hook("PreToolUse", { ...agent, tool_use_id: "toolu_2", tool_name: "Bash", tool_input: { command: CMD + " 2" } });
  hook("PermissionRequest", { ...agent, tool_name: "Bash", tool_input: { command: CMD + " 2" } });
  await h.clock.advance(2000);
  hook("PostToolUse", { ...agent, tool_use_id: "toolu_2", tool_name: "Bash" });
  assert.equal(h.voice.status().claude.approval, null);
});

test("two pending approvals: the card shows the newest, then the other, then clears", async (t) => {
  const { h, hook } = await live(t);
  hook("PreToolUse", { tool_use_id: "m1", tool_name: "Edit", tool_input: { file_path: "/p/a.js" } });
  hook("PermissionRequest", { tool_name: "Edit", tool_input: { file_path: "/p/a.js" } });
  hook("PreToolUse", { agent_id: "ag", tool_use_id: "g1", tool_name: "Bash", tool_input: { command: CMD } });
  hook("PermissionRequest", { agent_id: "ag", tool_name: "Bash", tool_input: { command: CMD } });
  assert.equal(h.voice.status().claude.approval.pending, 2);
  hook("PostToolUse", { agent_id: "ag", tool_use_id: "g1", tool_name: "Bash" });
  assert.deepEqual([lastActivity(h).kind, lastActivity(h).text], ["permission", "Claude needs approval to edit a.js"]);
  hook("PostToolUse", { tool_use_id: "m1", tool_name: "Edit" });
  assert.equal(lastActivity(h).kind, "approval_cleared");
});

test("approvals are never deduped: same words twice, after a similar line, and under quiet", async (t) => {
  const { h, ws, hook } = await live(t, { speaking_policy: "quiet" });
  // The voice has just talked about approvals (the repeat filter of PR #16 must not apply).
  ws.receive({ type: "session.output_transcript.delta", delta: "You're still blocked on that approval to run a shell command in the terminal.", start_ms: 0, end_ms: 3000 });
  await h.clock.advance(5000);
  for (const [id, who] of [["t1", {}], ["t2", { agent_id: "a1" }], ["t3", { agent_id: "a2" }]]) {
    hook("PreToolUse", { ...who, tool_use_id: id, tool_name: "Bash", tool_input: { command: CMD } });
    hook("PermissionRequest", { ...who, tool_name: "Bash", tool_input: { command: CMD } });
  }
  await h.clock.advance(15_000);
  assert.deepEqual(said(ws), [
    "Claude needs your approval in the terminal to run a shell command.",
    "A background agent is waiting for your approval in the terminal to run a shell command.",
    "Heads up, a background agent needs your approval in the terminal to run a shell command.", // rotated: same meaning
  ]);
  assert.equal(h.log.find("speech.duplicate").length, 0);
  // The Notification that repeats the first prompt 6 s later is the same prompt: not spoken again.
  hook("Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
  assert.equal(said(ws).length, 3);
});

test("an approval answered before the voice got to say it is not spoken late", async (t) => {
  const { h, ws, hook } = await live(t);
  ws.receive({ type: "session.output_transcript.delta", delta: "Here is a long answer that keeps going and going", start_ms: 0, end_ms: 8000 });
  hook("PreToolUse", { tool_use_id: "t1", tool_name: "Bash", tool_input: { command: CMD } });
  hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: CMD } });
  assert.equal(said(ws).length, 0, "held: the voice is mid-sentence");
  hook("PostToolUse", { tool_use_id: "t1", tool_name: "Bash" });
  await h.clock.advance(15_000);
  assert.equal(said(ws).length, 0);
  assert.equal(h.log.find("speech.cancelled").length, 1);
});

test("reminder (fake clock): at 2 min and 5 min, at most twice, never over the user's speech", async (t) => {
  const { h, ws, hook } = await live(t);
  hook("PreToolUse", { tool_use_id: "t1", tool_name: "Bash", tool_input: { command: CMD } });
  hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: CMD } });
  const reminders = () => said(ws).filter((c) => /^(?:By the way|Just a reminder)/.test(c));
  await h.clock.advance(119_000);
  assert.equal(reminders().length, 0);
  // The user starts talking just before it is due: the reminder waits for them.
  ws.receive({ type: "session.input_transcript.delta", delta: "so what I was thinking", start_ms: 1000, end_ms: 2000 });
  await h.clock.advance(1500);
  assert.equal(reminders().length, 0, "not while the user speaks");
  await h.clock.advance(3000);
  assert.deepEqual(reminders(), ["By the way, Claude's still waiting on your approval to run a shell command."]);
  await h.clock.advance(300_000 - 123_500 - 1000);
  assert.equal(reminders().length, 1);
  await h.clock.advance(1000);
  assert.equal(reminders().length, 2);
  await h.clock.advance(30 * 60_000);
  assert.equal(reminders().length, 2, "at most twice");
  assert.equal(h.voice.status().claude.approval.label, "run a shell command", "still shown until answered");
});

test("reminder for a subagent names the background agent", async (t) => {
  const { h, ws, hook } = await live(t);
  hook("PermissionRequest", { agent_id: "a1", tool_name: "Edit", tool_input: { file_path: "/p/voice.js" } });
  await h.clock.advance(REMIND_AT_MS[0]);
  assert.equal(said(ws).at(-1), "By the way, a background agent is still waiting on your approval to edit voice.js.");
});

test("an approved Bash command that is still running clears the card and cancels the reminder (process probe)", async (t) => {
  const { h, ws, hook } = await live(t);
  hook("PreToolUse", { agent_id: "a1", tool_use_id: "toolu_017V", tool_name: "Bash", tool_input: { command: CMD } });
  hook("PermissionRequest", { agent_id: "a1", tool_name: "Bash", tool_input: { command: CMD } });
  h.processes = "  1 /sbin/launchd\n";
  await h.clock.advance(60_000);
  assert.equal(h.voice.status().claude.approval.agent, true, "not running yet: still waiting");
  // The user approves at 1:30; the command starts and runs for minutes.
  h.processes += `  95628 /bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval '${CMD}' < /dev/null && pwd -P >| /tmp/claude-a065-cwd\n`;
  await h.clock.advance(30_000);
  assert.equal(h.voice.status().claude.approval, null);
  assert.equal(h.log.find("approval.resolved")[0].reason, "running");
  assert.equal(lastActivity(h).kind, "approval_cleared");
  await h.clock.advance(10 * 60_000);
  assert.ok(!said(ws).some((c) => c.startsWith("By the way")), "no reminder after the user approved");
});

test("a reminder while voice sleeps wakes a session to say it", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  h.d.sse.clients.add({ write() {}, end() {} }); // a page listening: sleeping needs someone to wake
  let ws = await h.goLive({ config: { idle_seconds: 20 } });
  h.voice.handleHook("PermissionRequest", { tool_name: "Bash", tool_input: { command: CMD } }, OWNER);
  await h.clock.advance(60_000); // spoken, then idle: asleep
  ws.receive({ type: "session.closed", reason: "close_requested", usage: { seconds: 60 } });
  await h.clock.advance(1000);
  assert.equal(h.voice.state, "sleeping");
  await h.clock.advance(REMIND_AT_MS[0] - 61_000); // due 2 min after the request
  assert.ok(h.commands().includes("connect:notify"), h.commands().join(","));
  ws = await h.goLive({ reason: "notify" });
  await h.clock.advance(6000);
  assert.ok(said(ws).includes("By the way, Claude's still waiting on your approval to run a shell command."), said(ws).join(" | "));
});
