// Spoken notifications (SPEC §6.10.1): questions, approvals, Notification,
// Elicitation, subagent/task completions, background-task turns, failures.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  route, Narrator, questionSpeech, planSpeech, elicitationSpeech, serverName, isBackgroundLaunch,
  COMPLETION_BATCH_MS, LONG_PROGRESS_MS, ATTENTION_DEDUPE_MS, AGENT_DONE_MS,
} from "../../daemon/policy.js";
import { parseTaskNotifications } from "../../daemon/delegation.js";
import { createFakeClock } from "../helpers/fake-clock.js";
import { relay } from "../../daemon/phrasing.js";
import { makeHarness } from "../helpers/daemon-harness.js";

const BG = "[Background reference; not user speech] ";
const SOCK = "/tmp/clv-owner-a.sock";
const POLICIES = ["quiet", "milestones", "walkthrough"];
const appends = (ws, kind) => ws.sent.filter((e) => e.type === `session.${kind}.append`);

function narrator(policy = "milestones") {
  const clock = createFakeClock();
  const out = [];
  const state = { policy };
  const n = new Narrator({ clock, policy: () => state.policy, emit: (a) => out.push(a) });
  return { clock, n, out, state, spoken: () => out.filter((a) => a.kind === "commentary").map((a) => a.content) };
}

// ---- pure speech helpers ---------------------------------------------------------------

test("questionSpeech: question and option labels, concise", () => {
  const t = questionSpeech({ questions: [{ question: "Which layout?", header: "Layout", options: [{ label: "A" }, { label: "B" }, { label: "C" }], multiSelect: false }] });
  assert.equal(t, "Claude's asking: Which layout? Options: A, B, or C. Answer in the terminal.");
  const two = questionSpeech({ questions: [
    { question: "Which DB?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
    { question: "Which tests", multiSelect: true, options: [{ label: "Unit" }, { label: "E2E" }] },
  ] });
  assert.equal(two, "Claude has 2 questions for you in the terminal. First: Which DB? Options: Postgres or SQLite. Second: Which tests? Pick any of: Unit and E2E.");
  assert.equal(questionSpeech({}), "Claude has a question for you in the terminal.");
  assert.equal(questionSpeech({ questions: "nope" }), "Claude has a question for you in the terminal.");
  // Variants rotate; each still says where to answer.
  const input = { questions: [{ question: "Which layout?", options: [{ label: "A" }, { label: "B" }] }] };
  const vs = [0, 1, 2].map((v) => questionSpeech(input, v));
  assert.equal(new Set(vs).size, 3);
  for (const v of vs) assert.match(v, /Which layout\? Options: A or B\..*terminal\.$/);
});

test("questionSpeech sanitizes: no code, paths, URLs or secrets are read out", () => {
  const t = questionSpeech({ questions: [{
    // The fake key is assembled at run time so the pre-commit secret scan stays quiet.
    question: `Should I edit /Users/me/proj/src/daemon/voice.js and set \`OPENAI_API_KEY=${"sk-" + "proj-"}abcdef1234567890abcdef\` from https://user:pw@example.com/x?`,
    options: [{ label: "Yes, run `rm -rf ./node_modules/.cache/some/deep/dir`" }, { label: "ghp_ABCDEFGHIJKLMNOPQRST1234" }],
  }] });
  assert.ok(!t.includes("/Users"), t);
  assert.ok(!t.includes("sk-proj"), t);
  assert.ok(!t.includes("ghp_"), t);
  assert.ok(!t.includes("pw@"), t);
  assert.ok(!t.includes("https://"), t);
  assert.match(t, /voice\.js/);
  assert.match(t, /^Claude's asking: /);
  assert.match(t, /Answer in the terminal\.$/);
});

test("questionSpeech stays within the append budget with 4 long questions", () => {
  const q = { question: "word ".repeat(200) + "?", options: Array.from({ length: 10 }, (_, i) => ({ label: `option number ${i} `.repeat(8) })) };
  const t = questionSpeech({ questions: [q, q, q, q, q] });
  assert.ok(t.length < 1400, String(t.length));
  assert.match(t, /^Claude has 4 questions/);
});

test("planSpeech: title from the first heading; the plan itself is reference only", () => {
  const p = planSpeech({ plan: "## Refactor auth\n\n1. Extract `token.js`.\n2. Add tests.", planFilePath: "/Users/me/.claude/plans/x.md" });
  assert.equal(p.text, "Claude's plan is ready for your approval in the terminal: Refactor auth.");
  assert.match(p.reference, /Extract token\.js/);
  assert.ok(!p.reference.includes("/Users"));
  const w = planSpeech({ plan: "# Refactor auth\n\nMove the token logic out. Then add tests." }, "walkthrough");
  assert.match(w.text, /Refactor auth\. In short: Move the token logic out\./);
  assert.equal(planSpeech({}).text, "Claude's plan is ready for your approval in the terminal.");
});

test("elicitationSpeech / serverName never read URLs", () => {
  assert.equal(serverName("claude_ai_Google_Drive"), "Google Drive");
  assert.equal(serverName("plugin_slack_slack"), "slack");
  assert.equal(elicitationSpeech({ mcp_server_name: "my-mcp-server", message: "Please provide your credentials", mode: "form" }),
    "my mcp server is asking for your input in the terminal: Please provide your credentials.");
  const u = elicitationSpeech({ mcp_server_name: "github", message: "Please authenticate", mode: "url", url: "https://auth.example.com/login?code=abc" });
  assert.equal(u, "github needs you to finish a step in your browser. Check the terminal.");
});

test("isBackgroundLaunch: Agent defaults to background, Bash only with run_in_background", () => {
  assert.equal(isBackgroundLaunch("Agent", { prompt: "x" }), true);
  assert.equal(isBackgroundLaunch("Agent", { run_in_background: false }), false);
  assert.equal(isBackgroundLaunch("Bash", { command: "sleep 3" }), false);
  assert.equal(isBackgroundLaunch("Bash", { command: "sleep 3", run_in_background: true }), true);
  assert.equal(isBackgroundLaunch("Workflow", {}), true);
});

test("parseTaskNotifications: the real CLI 2.1.281 payload", () => {
  const prompt = "<task-notification>\n<task-id>ac0dd5dd9b41ce48c</task-id>\n<tool-use-id>toolu_01555gFs6PBBXB1i4q2XkQNh</tool-use-id>\n<output-file>/private/tmp/x.output</output-file>\n<status>completed</status>\n<summary>Agent \"count files\" finished</summary>\n<result>there are 3 files.</result>\n</task-notification>";
  assert.deepEqual(parseTaskNotifications(prompt), [{ taskId: "ac0dd5dd9b41ce48c", toolUseId: "toolu_01555gFs6PBBXB1i4q2XkQNh", status: "completed", summary: 'Agent "count files" finished', result: "there are 3 files." }]);
  assert.deepEqual(parseTaskNotifications("hello <task-notification>"), []);
  assert.equal(parseTaskNotifications(prompt + "\n" + prompt).length, 2);
});

// ---- routing table (§6.10) for the new sources -------------------------------------------

test("route: question/attention/notice are spoken under every policy", () => {
  for (const p of POLICIES) {
    assert.deepEqual(route("question", p, { text: "Claude's asking: x?", delegationId: "d1" }), [{ kind: "commentary", delegationId: "d1", content: "Claude's asking: x?" }]);
    const withRef = route("question", p, { text: "plan ready.", reference: "the plan" });
    assert.deepEqual(withRef.map((a) => a.kind), ["commentary", "thinking"]);
    assert.equal(withRef[1].content, BG + "the plan");
    assert.equal(route("attention", p, { text: "a" })[0].kind, "commentary");
    assert.equal(route("notice", p, { text: "n" })[0].kind, "commentary");
  }
});

test("route: completion batches by policy level", () => {
  const items = [{ what: "the Explore agent", detail: "Found 3 endpoints. And more.", level: "milestones" }, { what: 'the task "Write tests"', level: "walkthrough" }];
  const q = route("completion", "quiet", { items });
  assert.deepEqual(q.map((a) => a.kind), ["thinking"]);
  assert.match(q[0].content, /The Explore agent finished: Found 3 endpoints/);
  const m = route("completion", "milestones", { items });
  assert.deepEqual(m.map((a) => a.kind), ["commentary", "thinking"]);
  assert.equal(m[0].content, "The Explore agent finished: Found 3 endpoints.");
  const w = route("completion", "walkthrough", { items });
  assert.equal(w[0].content, 'Finished: the Explore agent and the task "Write tests".');
});

test("route: background turns and turns nobody asked for", () => {
  const text = "The agent found 3 files. It also checked the tests. All good.";
  for (const p of POLICIES) {
    const v = route("background_voice", p, { text, requestText: "count the files" });
    assert.equal(v[0].kind, "commentary", p);
    assert.match(v[0].content, /^Background work for the user's earlier request "count the files" finished\. /);
    assert.ok(v[0].content.endsWith("Claude said: The agent found 3 files. It also checked the tests.") || p === "walkthrough", v[0].content);
  }
  assert.deepEqual(route("background_result", "quiet", { text }).map((a) => a.kind), ["thinking"]);
  assert.equal(route("background_result", "milestones", { text })[0].content, relay("bgwork", "The agent found 3 files."));
  assert.equal(route("background_result", "walkthrough", { text })[0].content, relay("bgwork", "The agent found 3 files. It also checked the tests."));
  assert.deepEqual(route("other_result", "quiet", { text }).map((a) => a.kind), ["thinking"]);
  assert.deepEqual(route("other_result", "milestones", { text }).map((a) => a.kind), ["thinking"], "thinking-only when the user did not ask");
  assert.equal(route("other_result", "walkthrough", { text })[0].content, relay("other", "The agent found 3 files."));
});

test("route: typed_result under milestones is one short sentence", () => {
  const long = "This is a very long first sentence that goes on and on about " + "details ".repeat(40) + "end. Second.";
  const m = route("typed_result", "milestones", { text: long });
  assert.ok(m[0].content.length <= relay("typed", "").length + 160, String(m[0].content.length));
  assert.ok(!m[0].content.includes("Second"));
});

test("route: idle and tool_failure", () => {
  assert.deepEqual(route("idle", "quiet", { speak: true }).map((a) => a.kind), ["thinking"]);
  assert.equal(route("idle", "milestones", { speak: true })[0].content, "Claude's waiting for you in the terminal.");
  assert.equal(route("idle", "milestones", { speak: true, variant: 1 })[0].content, "Over to you, Claude's waiting in the terminal.");
  assert.deepEqual(route("idle", "milestones", { speak: false }).map((a) => a.kind), ["thinking"]);
  for (const p of ["quiet", "milestones"]) assert.deepEqual(route("tool_failure", p, { label: "running tests", exit: "1" }, { canSpeakFailure: true }).map((a) => a.kind), ["thinking"]);
  const w = route("tool_failure", "walkthrough", { label: "running tests", exit: "1" }, { canSpeakFailure: true });
  assert.equal(w[0].content, "Running tests failed.", "no exit codes aloud");
  assert.match(w[1].content, /exit code 1/, "the exit code stays in the silent note");
  assert.deepEqual(route("tool_failure", "walkthrough", { label: "x" }, { canSpeakFailure: false }).map((a) => a.kind), ["thinking"]);
});

// ---- narrator: dedupe, batching, throttles --------------------------------------------------

test("onQuestion: spoken once per tool call, whether PreToolUse or PermissionRequest comes first", () => {
  const { n, spoken } = narrator("quiet");
  const input = { questions: [{ question: "Which layout?", options: [{ label: "A" }, { label: "B" }] }] };
  assert.ok(n.onQuestion("AskUserQuestion", input, { toolUseId: "toolu_1" }));
  assert.equal(n.onQuestion("AskUserQuestion", input, {}), null, "PermissionRequest for the same call (no tool_use_id)");
  assert.equal(n.onPermission("AskUserQuestion", input), null, "never 'approval to use AskUserQuestion'");
  assert.equal(n.onToolUse("AskUserQuestion", input), null, "not a milestone");
  assert.deepEqual(spoken(), ["Claude's asking: Which layout? Options: A or B. Answer in the terminal."]);
  assert.equal(n.onQuestion("AskUserQuestion", input, { toolUseId: "toolu_1" }), null, "a repeat is deduped although the next variant differs");
  n.onQuestion("AskUserQuestion", { questions: [{ question: "Another?" }] }, { toolUseId: "toolu_2" });
  assert.equal(spoken().length, 2);
});

test("ExitPlanMode: spoken under quiet, plan text as reference", () => {
  const { n, out } = narrator("quiet");
  n.onQuestion("ExitPlanMode", { plan: "# Ship it\n\nStep one." }, { toolUseId: "t" });
  assert.equal(out[0].content, "Claude's plan is ready for your approval in the terminal: Ship it.");
  assert.equal(out[1].kind, "thinking");
});

test("Notification permission_prompt is deduped against PermissionRequest; spoken if nothing was said", async () => {
  const { clock, n, spoken } = narrator("quiet");
  n.onPermission("Bash", { command: "ls" });
  assert.equal(n.onNotification({ notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }), "deduped");
  assert.equal(spoken().length, 1);
  await clock.advance(ATTENTION_DEDUPE_MS + 1);
  assert.equal(n.onNotification({ notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }), "spoken");
  assert.equal(spoken().at(-1), "Claude needs you in the terminal: Claude needs your permission to use Bash.");
});

test("Notification types: attention spoken in quiet; ignored ones silent; unknown ones as context", () => {
  const { n, out, spoken } = narrator("quiet");
  assert.equal(n.onNotification({ notification_type: "auth_success", message: "ok" }), "ignored");
  assert.equal(n.onNotification({ notification_type: "elicitation_response" }), "ignored");
  assert.equal(out.length, 0);
  assert.equal(n.onNotification({ notification_type: "agent_needs_input", message: "Session 2 asks a question" }), "spoken");
  assert.equal(n.onNotification({ notification_type: "quota_auto_resume_stale" }), "spoken");
  assert.equal(n.onNotification({ notification_type: "quota_auto_resume_disabled" }), "spoken");
  assert.deepEqual(spoken(), [
    "A background Claude session needs your input: Session 2 asks a question.",
    "Your usage limit has reset. Press Enter in the terminal to continue.",
    "Claude stopped waiting for the usage limit, so the task didn't continue.",
  ]);
  assert.equal(n.onNotification({ notification_type: "something_new", message: "hello there" }), "context");
  assert.equal(out.at(-1).kind, "thinking");
  assert.equal(n.onNotification({ notification_type: "quota_auto_resume_fired" }), "spoken");
  assert.equal(out.at(-1).kind, "thinking", "resumed: context only under quiet");
});

test("elicitation dialog Notification is deduped against the Elicitation hook", () => {
  const { n, spoken } = narrator("quiet");
  assert.ok(n.onAttention("elicitation", "Slack is asking for your input in the terminal."));
  assert.equal(n.onNotification({ notification_type: "elicitation_dialog", message: "x" }), "deduped");
  assert.equal(spoken().length, 1);
});

test("idle_prompt: Claude Code's generic idle notice is never sent to the voice", async () => {
  for (const pol of ["milestones", "walkthrough", "quiet"]) {
    const m = narrator(pol);
    m.n.onTurnStart();
    m.n.route("stale_result", { text: "Done." }); // even with an unspoken result
    assert.equal(m.n.onNotification({ notification_type: "idle_prompt", message: "Claude is waiting for your input" }), "ignored");
    assert.equal(m.n.onNotification({ notification_type: "idle_prompt" }), "deduped");
    assert.equal(m.spoken().length, 0);
  }
});

test("completions within 3 s are batched into one sentence", async () => {
  const { clock, n, spoken, out } = narrator("milestones");
  n.onCompletion({ what: "the Explore agent", detail: "Found it.", level: "milestones" });
  n.onCompletion({ what: "the Plan agent", detail: "Planned.", level: "milestones" });
  n.onCompletion({ what: "the Plan agent", detail: "Planned.", level: "milestones" }); // duplicate
  assert.equal(out.length, 0);
  await clock.advance(COMPLETION_BATCH_MS);
  assert.deepEqual(spoken(), ["Finished: the Explore agent and the Plan agent."]);
  n.onCompletion({ what: "the Explore agent", detail: "Found 3 endpoints.", level: "milestones" });
  await clock.advance(COMPLETION_BATCH_MS);
  assert.equal(spoken().at(-1), "The Explore agent finished: Found 3 endpoints.");
});

test("completions respect the policy level", async () => {
  const q = narrator("quiet");
  q.n.onCompletion({ what: "the Explore agent", level: "milestones" });
  await q.clock.advance(COMPLETION_BATCH_MS);
  assert.equal(q.spoken().length, 0);
  assert.equal(q.out[0].kind, "thinking");
  const m = narrator("milestones");
  m.n.onCompletion({ what: 'the task "x"', level: "walkthrough" });
  await m.clock.advance(COMPLETION_BATCH_MS);
  assert.equal(m.spoken().length, 0);
});

test("milestones: intermediate text of a long-running turn is spoken at most every 30 s", async () => {
  const { clock, n, spoken } = narrator("milestones");
  n.onTurnStart();
  n.route("progress_text", { text: "Looking at the tests now." });
  assert.equal(spoken().length, 0, "turn too young");
  await clock.advance(LONG_PROGRESS_MS);
  n.route("progress_text", { text: "Running the suite. This takes a while." });
  assert.deepEqual(spoken(), [relay("progress", "Running the suite.")]);
  await clock.advance(10000);
  n.route("progress_text", { text: "Half done." });
  assert.equal(spoken().length, 1, "throttled");
  await clock.advance(LONG_PROGRESS_MS);
  n.route("progress_text", { text: "Almost done." });
  assert.equal(spoken().length, 2);
  n.onStop({});
  await clock.advance(LONG_PROGRESS_MS);
  n.route("progress_text", { text: "late" });
  assert.equal(spoken().length, 2, "no turn running");
});

test("tool failures: context always, spoken in walkthrough at most every 15 s", async () => {
  const { clock, n, spoken, out } = narrator("walkthrough");
  n.onToolFailure("Bash", { command: "npm test", description: "Run the test suite" }, "Exit code 1\nError: /Users/me/secret/path.js failed");
  assert.deepEqual(spoken(), ["Run the test suite failed."]);
  assert.ok(!out.some((a) => a.content.includes("/Users")));
  n.onToolFailure("Read", { file_path: "/a/b.js" }, "File does not exist.");
  assert.equal(spoken().length, 1);
  await clock.advance(15000);
  n.onToolFailure("Read", { file_path: "/a/b.js" }, "File does not exist.");
  assert.match(spoken().at(-1), /^(?:Hm, |Looks like )?[Rr]eading a file failed\.$/);
});

// ---- daemon integration (fake sideband) --------------------------------------------------

async function live(t, config = {}) {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive({ config });
  return { h, ws, hook: (ev, body) => h.voice.handleHook(ev, body, SOCK) };
}

test("AskUserQuestion PreToolUse → spoken question, attached to the voice request it serves", async (t) => {
  const { h, ws, hook } = await live(t, { speaking_policy: "quiet" });
  ws.receive({ type: "session.input_transcript.delta", delta: "Can you ask Claude to pick a layout", start_ms: 100, end_ms: 1500 });
  ws.receive({ type: "session.delegation.created", offset_ms: 1600, delegation: { id: "item_q", type: "delegation", target: "client" } });
  await h.clock.advance(2500);
  hook("UserPromptSubmit", { prompt: h.inboxSends[0].content, prompt_id: "p1" });
  hook("PreToolUse", { prompt_id: "p1", tool_name: "AskUserQuestion", tool_use_id: "toolu_q", tool_input: { questions: [{ question: "Which layout?", options: [{ label: "Grid" }, { label: "Stack" }] }] } });
  hook("PermissionRequest", { prompt_id: "p1", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which layout?", options: [{ label: "Grid" }, { label: "Stack" }] }] } });
  const c = appends(ws, "commentary");
  assert.equal(c.length, 1);
  assert.equal(c[0].content, "Claude's asking: Which layout? Options: Grid or Stack. Answer in the terminal.");
  assert.equal(c[0].delegation_id, "item_q");
  assert.ok(h.sse.some((m) => m.type === "activity" && m.kind === "question"));
});

test("SubagentStop: the parent speaks for its agents; otherwise the voice names what finished and how it went", async (t) => {
  const { h, ws, hook } = await live(t);
  const BGT = [{ id: "a1", type: "subagent", status: "running", description: "Fix wake detection" }, { id: "a2", type: "subagent", status: "running", description: "Draft redesign concepts" }];
  hook("UserPromptSubmit", { prompt: "go", prompt_id: "p0" });
  hook("PreToolUse", { prompt_id: "p0", tool_name: "Agent", tool_use_id: "t1", tool_input: { description: "Fix wake detection", prompt: "fix it", run_in_background: true } });
  hook("PreToolUse", { prompt_id: "p0", tool_name: "Agent", tool_use_id: "t2", tool_input: { description: "Draft redesign concepts", prompt: "draft", run_in_background: true } });
  hook("Stop", { prompt_id: "p0", last_assistant_message: "Two helpers started.", background_tasks: BGT });
  await h.clock.advance(3000);
  const before = appends(ws, "commentary").length;
  hook("SubagentStop", { agent_id: "x1", agent_type: "", last_assistant_message: "suggestion" });
  hook("SubagentStop", { agent_id: "a1", agent_type: "general-purpose", last_assistant_message: "## Summary\n\nDone.\n\nI fixed the wake detector in `/Users/me/dev/sotto/daemon/wake.js`: normal speech wakes it now, and the PR is merged.", background_tasks: BGT });
  hook("SubagentStop", { agent_id: "a2", agent_type: "general-purpose", last_assistant_message: "Three redesign concepts are ready to look at.", background_tasks: BGT });
  await h.clock.advance(AGENT_DONE_MS);
  // The parent is idle and said nothing about them: one sentence, by name and outcome.
  const said = appends(ws, "commentary").slice(before).map((e) => e.content);
  assert.equal(said.length, 1, JSON.stringify(said));
  assert.match(said[0], /^Two things finished\. Fixing wake detection: it fixed the wake detector in wake\.js\. Drafting redesign concepts: three redesign concepts are ready to look at\.$/);
  assert.ok(!/\/Users|##/.test(said[0]));
  assert.ok(!appends(ws, "thinking").some((e) => /suggestion/.test(e.content)));
  assert.equal(h.voice.status().claude.busy, false, "subagent stops never mark Claude busy");
  // Mid-turn: the parent will summarize, so nothing is spoken.
  hook("PreToolUse", { prompt_id: "p0", tool_name: "Agent", tool_use_id: "t3", tool_input: { description: "Explore docs", prompt: "x" } });
  hook("UserPromptSubmit", { prompt: "typed task", prompt_id: "p9" });
  hook("SubagentStop", { agent_id: "a3", agent_type: "Explore", last_assistant_message: "Done reading the docs folder.", background_tasks: [{ id: "a3", type: "subagent", description: "Explore docs" }] });
  await h.clock.advance(AGENT_DONE_MS);
  assert.equal(appends(ws, "commentary").length, before + 1);
});

test("finished work: a single agent in plain words; nested agents, workflow agents and checklist ticks never spoken", async (t) => {
  const { h, ws, hook } = await live(t, { idle_seconds: 7200 });
  const spoken = () => appends(ws, "commentary").map((e) => e.content);
  hook("PreToolUse", { tool_name: "Agent", tool_use_id: "t1", tool_input: { description: "Fix wake detection", prompt: "fix" } });
  hook("PreToolUse", { tool_name: "Workflow", tool_use_id: "w1", tool_input: { scriptPath: "/x/redesign-concepts.js", meta: { description: "Redesign concepts" } } });
  // A nested agent (launched by a1), and a workflow's own agent.
  hook("PreToolUse", { agent_id: "a1", agent_type: "general-purpose", tool_name: "Agent", tool_use_id: "tn", tool_input: { description: "Read the wake tests", prompt: "read" } });
  hook("PreToolUse", { agent_id: "wa1", agent_type: "general-purpose", tool_name: "Read", tool_input: { file_path: "/x" } });
  hook("PreToolUse", { agent_id: "n1", agent_type: "Explore", tool_name: "Read", tool_input: { file_path: "/y" } });
  const n0 = spoken().length;
  hook("SubagentStop", { agent_id: "n1", agent_type: "Explore", last_assistant_message: "The wake tests cover the VAD thresholds and nothing else at all.", background_tasks: [{ id: "n1", type: "subagent", description: "Read the wake tests" }] });
  hook("SubagentStop", { agent_id: "wa1", agent_type: "general-purpose", last_assistant_message: "Concept A uses a dark dial with a big mute button in the middle." });
  const appendsBefore = ws.sent.length;
  hook("TaskCompleted", { task_id: "7", task_subject: "Write tests" });
  await h.clock.advance(AGENT_DONE_MS + 1000);
  assert.equal(spoken().length, n0, "nested, workflow-internal and checklist completions are silent");
  assert.equal(ws.sent.length, appendsBefore, "no append of any kind for nested agents or checklist ticks");
  hook("PreToolUse", { agent_id: "a1", agent_type: "general-purpose", tool_name: "SubagentHandback", tool_input: { message: "Fixed it. Normal speech wakes it now, and it's merged." } });
  hook("SubagentStop", { agent_id: "a1", agent_type: "general-purpose", last_assistant_message: "", background_tasks: [{ id: "a1", type: "subagent", description: "Fix wake detection" }] });
  await h.clock.advance(AGENT_DONE_MS);
  assert.deepEqual(spoken().slice(n0), ["Fixing wake detection is done. Normal speech wakes it now, and it's merged."]);
  // The workflow finishes by task-notification; Claude's own reply speaks for it.
  hook("UserPromptSubmit", { prompt: "<task-notification>\n<task-id>wf9</task-id>\n<tool-use-id>w1</tool-use-id>\n<status>completed</status>\n<summary>Workflow finished</summary>\n<result>Three redesign concepts are ready to look at.</result>\n</task-notification>", prompt_id: "q1" });
  hook("Stop", { prompt_id: "q1", last_assistant_message: "The redesign concepts are ready: three directions to compare." });
  // Claude's reply was context only (a turn nobody asked for): after the one-minute cooldown, the voice names it.
  await h.clock.advance(60_000);
  const after = spoken().slice(n0 + 1);
  assert.equal(after.length, 1, JSON.stringify([after, appends(ws, "thinking").slice(-4).map((e) => e.content)]));
  assert.match(after[0], /redesign concepts are ready/);
  for (const c of spoken()) assert.doesNotMatch(c, /^\w+ background agents? finished\.?$|task is complete/i);
});

test("subagent events stay out of the card and the voice; they only count as background agents", async (t) => {
  const { h, ws, hook } = await live(t);
  hook("UserPromptSubmit", { prompt: "research this", prompt_id: "p1" });
  hook("PreToolUse", { prompt_id: "p1", tool_name: "Agent", tool_input: { description: "Explore repo", subagent_type: "Explore" } });
  hook("PreToolUse", { prompt_id: "p1", tool_name: "Agent", tool_input: { description: "Explore docs", subagent_type: "Explore" } });
  for (const id of ["a1", "a2"]) {
    hook("PreToolUse", { agent_id: id, agent_type: "Explore", tool_name: "Bash", tool_input: { command: "cd /repo && ls", description: "List files" } });
    hook("PreToolUse", { agent_id: id, agent_type: "Explore", tool_name: "Read", tool_input: { file_path: "/repo/secret.js" } });
    hook("MessageDisplay", { agent_id: id, agent_type: "Explore", message_id: `m${id}`, index: 0, delta: "Subagent musings.", final: true });
  }
  await h.clock.advance(3000);
  const act = h.sse.filter((m) => m.type === "activity");
  const texts = act.map((m) => m.text).join("\n");
  assert.ok(!/helper agent|running|List files|Subagent musings|\bcd\b/.test(texts), texts);
  assert.deepEqual(act.filter((m) => m.kind === "agents").map((m) => m.count), [1, 2]);
  assert.equal(act.filter((m) => m.kind === "agents").at(-1).text, "2 background agents working");
  const toVoice = ws.sent.map((e) => JSON.stringify(e)).join("\n");
  assert.ok(!/Subagent musings|List files|secret\.js/.test(toVoice));
  hook("SubagentStop", { agent_id: "a1", agent_type: "Explore", last_assistant_message: "ok" });
  assert.equal(h.sse.filter((m) => m.type === "activity" && m.kind === "agents").at(-1).count, 1);
});

test("the card gets Claude's own words, sanitized, not raw deltas or busywork", async (t) => {
  const { h, hook } = await live(t);
  hook("UserPromptSubmit", { prompt: "fix it", prompt_id: "p1" });
  hook("PreToolUse", { prompt_id: "p1", tool_name: "Bash", tool_input: { command: "cd /repo" } });
  hook("PreToolUse", { prompt_id: "p1", tool_name: "Bash", tool_input: { command: "npm test" } });
  hook("MessageDisplay", { prompt_id: "p1", message_id: "m1", index: 0, delta: "I found the **bug** in `/Users/me/x/voice.js`", final: false });
  hook("MessageDisplay", { prompt_id: "p1", message_id: "m1", index: 1, delta: ". Fixing it now.", final: true });
  hook("Stop", { prompt_id: "p1", last_assistant_message: "Fixed **two** bugs.\n\n- one\n- two" });
  const act = h.sse.filter((m) => m.type === "activity");
  assert.deepEqual(act.filter((m) => m.kind === "tool").map((m) => m.text), ["Running the tests"]);
  assert.deepEqual(act.filter((m) => m.kind === "text").map((m) => m.text), ["I found the bug in voice.js.", "I found the bug in voice.js. Fixing it now."]);
  const end = act.find((m) => m.kind === "turn_end");
  assert.equal(end.summary, "Fixed **two** bugs.\n\n- one\n- two", "markdown for the page's safe renderer");
});

test("background task turn: a voice-launched agent's completion is spoken as an update on that request, even in quiet", async (t) => {
  const { h, ws, hook } = await live(t, { speaking_policy: "quiet" });
  ws.receive({ type: "session.input_transcript.delta", delta: "Ask Claude to count the files in the background", start_ms: 100, end_ms: 1500 });
  ws.receive({ type: "session.delegation.created", offset_ms: 1600, delegation: { id: "item_bg", type: "delegation", target: "client" } });
  await h.clock.advance(2500);
  hook("UserPromptSubmit", { prompt: h.inboxSends[0].content, prompt_id: "p1" });
  hook("PreToolUse", { prompt_id: "p1", tool_name: "Agent", tool_use_id: "toolu_A", tool_input: { description: "count files", prompt: "count", subagent_type: "general-purpose" } });
  hook("Stop", { prompt_id: "p1", last_assistant_message: "Launched a helper to count the files." });
  await h.clock.advance(3000);
  const before = appends(ws, "commentary").length;
  const note = '<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>toolu_A</tool-use-id>\n<status>completed</status>\n<summary>Agent "count files" finished</summary>\n<result>3</result>\n</task-notification>';
  hook("UserPromptSubmit", { prompt: note, prompt_id: "p2" });
  assert.ok(!appends(ws, "thinking").some((e) => /The user typed/.test(e.content)), "a task notification is not something the user typed");
  assert.ok(appends(ws, "thinking").some((e) => /Background task update: Agent "count files" finished/.test(e.content)));
  hook("Stop", { prompt_id: "p2", last_assistant_message: "The helper counted 3 files. That is all." });
  await h.clock.advance(3000);
  const c = appends(ws, "commentary").slice(before);
  assert.equal(c.length, 1);
  assert.match(c[0].content, /^Background work for the user's earlier request "Ask Claude to count the files in the background" finished\. [\s\S]*\nClaude said: The helper counted 3 files\./);
});

test("background task turn: typed launch spoken briefly under milestones; unknown launch is context only", async (t) => {
  const { h, ws, hook } = await live(t);
  hook("UserPromptSubmit", { prompt: "run the tests in the background", prompt_id: "p1" });
  hook("PreToolUse", { prompt_id: "p1", tool_name: "Bash", tool_use_id: "toolu_B", tool_input: { command: "npm test", run_in_background: true } });
  hook("Stop", { prompt_id: "p1", last_assistant_message: "Started." });
  await h.clock.advance(3000);
  let n = appends(ws, "commentary").length;
  hook("UserPromptSubmit", { prompt: "<task-notification>\n<task-id>b</task-id>\n<tool-use-id>toolu_B</tool-use-id>\n<status>completed</status>\n<summary>Background command completed (exit code 0)</summary>\n</task-notification>", prompt_id: "p2" });
  hook("Stop", { prompt_id: "p2", last_assistant_message: "All 248 tests passed. Nothing failed." });
  await h.clock.advance(3000);
  assert.deepEqual(appends(ws, "commentary").slice(n).map((e) => e.content), [relay("bgwork", "All 248 tests passed.")]);
  n = appends(ws, "commentary").length;
  hook("UserPromptSubmit", { prompt: "<task-notification>\n<task-id>c</task-id>\n<tool-use-id>toolu_unknown</tool-use-id>\n<status>completed</status>\n<summary>x</summary>\n</task-notification>", prompt_id: "p3" });
  hook("Stop", { prompt_id: "p3", last_assistant_message: "Something finished." });
  await h.clock.advance(3000);
  assert.equal(appends(ws, "commentary").length, n, "work we did not see launched: thinking only");
});

test("Notification idle_prompt and Elicitation reach the voice through handleHook", async (t) => {
  const { h, ws, hook } = await live(t);
  hook("Elicitation", { mcp_server_name: "claude_ai_Slack", message: "Pick a channel", mode: "form" });
  hook("Notification", { notification_type: "elicitation_dialog", message: "Slack needs input" });
  await h.clock.advance(3000);
  hook("Notification", { notification_type: "idle_prompt", message: "Claude is waiting for your input" });
  await h.clock.advance(3000);
  const c = appends(ws, "commentary").map((e) => e.content);
  assert.deepEqual(c, ["Slack is asking for your input in the terminal: Pick a channel."]);
  assert.equal(h.voice.handleHook("Notification", { notification_type: "idle_prompt" }, "/tmp/other.sock"), false, "non-owners are ignored");
});

test("PostToolUseFailure: context under milestones; spoken under walkthrough; interrupts ignored", async (t) => {
  const { h, ws, hook } = await live(t, { speaking_policy: "walkthrough" });
  hook("PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "npm test", description: "Run tests" }, error: "Exit code 1", is_interrupt: true });
  assert.equal(appends(ws, "commentary").length, 0);
  hook("PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "npm test", description: "Run tests" }, error: "Exit code 1" });
  assert.deepEqual(appends(ws, "commentary").map((e) => e.content), ["Run tests failed."]);
});

test("the observed bug: an unrelated turn's summary does not cut off a voice answer", async (t) => {
  const { h, ws, hook } = await live(t);
  ws.receive({ type: "session.input_transcript.delta", delta: "What branch am I on", start_ms: 100, end_ms: 1500 });
  ws.receive({ type: "session.delegation.created", offset_ms: 1600, delegation: { id: "item_ans", type: "delegation", target: "client" } });
  await h.clock.advance(2500);
  hook("UserPromptSubmit", { prompt: h.inboxSends[0].content, prompt_id: "p1" });
  hook("Stop", { prompt_id: "p1", last_assistant_message: "You are on main. There are two uncommitted files and one stash." });
  await h.clock.advance(600);
  // The voice speaks the answer for ~5 s; 3 s in, an unrelated turn finishes.
  const ms = 5000;
  for (let tl = 0; tl < 3000; tl += 250) { ws.receive({ type: "session.output_transcript.delta", delta: "word ", start_ms: 10000 + tl, end_ms: 10250 + tl }); await h.clock.advance(250); }
  hook("UserPromptSubmit", { prompt: "unrelated typed task", prompt_id: "p2" });
  hook("Stop", { prompt_id: "p2", last_assistant_message: "Refactored the parser. Tests pass." });
  await h.clock.advance(0);
  let c = appends(ws, "commentary");
  assert.equal(c.length, 1, "held while the answer is being spoken");
  assert.equal(c[0].delegation_id, "item_ans");
  for (let tl = 3000; tl < ms; tl += 250) { ws.receive({ type: "session.output_transcript.delta", delta: "word ", start_ms: 10000 + tl, end_ms: 10250 + tl }); await h.clock.advance(250); }
  c = appends(ws, "commentary");
  assert.equal(c.length, 1);
  await h.clock.advance(2000);
  c = appends(ws, "commentary");
  assert.equal(c.length, 2, "released once the voice went quiet");
  assert.equal(c[1].content, relay("typed", "Refactored the parser."));
  assert.ok(h.log.find("speech.released").length >= 1);
});

test("held low-priority update becomes thinking after 20 s of continuous speech", async (t) => {
  const { h, ws, hook } = await live(t);
  ws.receive({ type: "session.output_transcript.delta", delta: "Let me explain", start_ms: 0, end_ms: 200 });
  hook("PreToolUse", { tool_name: "Agent", tool_use_id: "t1", tool_input: { description: "Find the config loader", prompt: "find" } });
  hook("SubagentStop", { agent_id: "a1", agent_type: "Explore", last_assistant_message: "Found it in config.js at the top.", background_tasks: [{ id: "a1", type: "subagent", status: "running", description: "Find the config loader" }] });
  for (let tl = 0; tl < 25000; tl += 250) { ws.receive({ type: "session.output_transcript.delta", delta: "and ", start_ms: 200 + tl, end_ms: 450 + tl }); await h.clock.advance(250); }
  assert.equal(appends(ws, "commentary").length, 0);
  assert.ok(appends(ws, "thinking").some((e) => e.content === BG + "Finished finding the config loader. Found it in config.js at the top."), JSON.stringify(appends(ws, "thinking").map((e) => e.content)));
});

// ---- "Why are you repeating?" (live log 2026-09-24) -------------------------------------

test("the observed repeat: internal progress-line SubagentStops are not agents finishing", async (t) => {
  const { h, ws, hook } = await live(t, { idle_seconds: 7200 }); // the pattern runs for minutes: no idle sleep
  const said = () => appends(ws, "commentary").map((e) => e.content).filter((c) => /finished|is done/.test(c) && !c.includes("Claude said: "));
  // Claude (running as `--agent claude`) launches two background agents; launching is not finishing.
  hook("UserPromptSubmit", { agent_type: "claude", prompt: "build it", prompt_id: "p1" });
  hook("PreToolUse", { agent_type: "claude", prompt_id: "p1", tool_name: "Agent", tool_use_id: "toolu_1", tool_input: { description: "web fix", prompt: "x", run_in_background: true } });
  hook("PreToolUse", { agent_type: "claude", prompt_id: "p1", tool_name: "Agent", tool_use_id: "toolu_2", tool_input: { description: "app fix", prompt: "y", run_in_background: true } });
  hook("Stop", { agent_type: "claude", prompt_id: "p1", last_assistant_message: "Two builders are on it.",
    background_tasks: [{ id: "a1", type: "subagent", status: "running", description: "web fix" }, { id: "a2", type: "subagent", status: "running", description: "app fix" }] });
  await h.clock.advance(16000);
  assert.deepEqual(said(), [], "a launch is never a completion");
  const tasks = [{ id: "a1", type: "subagent", status: "running", description: "web fix" }, { id: "a2", type: "subagent", status: "running", description: "app fix" }];
  for (const id of ["a1", "a2"]) hook("PreToolUse", { agent_id: id, agent_type: "general-purpose", tool_name: "Bash", tool_input: { command: "npm test" } });
  const chip = () => h.sse.filter((m) => m.type === "activity" && m.kind === "agents").at(-1).count;
  assert.equal(chip(), 2);
  // The log's pattern: a SubagentStop about every 8 s and 23 s, in pairs, for
  // three and a half minutes, from Claude Code's internal agent that writes
  // each background agent's progress line. agent_type is the session's own
  // agent name, its ids are none of the session's agents.
  let n = 0;
  for (let i = 0; i < 7; i++) {
    for (const gap of [8000, 23000]) {
      hook("SubagentStop", { agent_id: `sum${n++}`, agent_type: "claude", last_assistant_message: "Reading app.js voice picker code.", background_tasks: tasks });
      await h.clock.advance(gap);
    }
  }
  assert.deepEqual(said(), [], "no utterance for progress lines");
  assert.equal(chip(), 2, "progress lines do not count agents down");
  assert.ok(!appends(ws, "thinking").some((e) => /voice picker/.test(e.content)));
  // The real completions: both agents within 30 s, each reported by SubagentStop
  // AND its task-notification (and a1's SubagentStop twice): counted once each.
  hook("SubagentStop", { agent_id: "a1", agent_type: "general-purpose", last_assistant_message: "The web fix is done.", background_tasks: tasks });
  hook("SubagentStop", { agent_id: "a1", agent_type: "general-purpose", last_assistant_message: "The web fix is done.", background_tasks: tasks });
  await h.clock.advance(3000);
  hook("SubagentStop", { agent_id: "a2", agent_type: "general-purpose", last_assistant_message: "The app fix is done.", background_tasks: tasks });
  assert.equal(chip(), 0);
  await h.clock.advance(AGENT_DONE_MS);
  assert.deepEqual(said(), ["Two things finished. Web fix: the web fix is done. App fix: the app fix is done."]);
  // Their task-notifications arrive later: no second count, no second utterance.
  for (const id of ["a1", "a2"]) {
    hook("UserPromptSubmit", { agent_type: "claude", prompt: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>`, prompt_id: `n${id}` });
    hook("Stop", { agent_type: "claude", prompt_id: `n${id}`, last_assistant_message: "Noted." });
  }
  // Nothing re-arms on a timer.
  await h.clock.advance(5 * 60_000);
  assert.equal(said().length, 1, "at most one utterance for the whole pattern");
  assert.ok(h.log.find("agent.stop_ignored").length >= 14);
});

test("a task-notification alone completes a launched agent once; quiet never speaks it", async (t) => {
  const { h, ws, hook } = await live(t, { speaking_policy: "quiet" });
  hook("PreToolUse", { tool_name: "Agent", tool_use_id: "t9", tool_input: { description: "Explore the docs", prompt: "x" } });
  hook("PreToolUse", { agent_id: "a9", agent_type: "Explore", tool_name: "Read", tool_input: { file_path: "/x" } });
  const note = "<task-notification>\n<task-id>a9</task-id>\n<tool-use-id>t9</tool-use-id>\n<status>completed</status>\n<summary>Agent done</summary>\n<result>The docs cover setup and the hook contract.</result>\n</task-notification>";
  hook("UserPromptSubmit", { prompt: note, prompt_id: "q1" });
  hook("SubagentStop", { agent_id: "a9", agent_type: "Explore", last_assistant_message: "late stop" });
  hook("Stop", { prompt_id: "q1", last_assistant_message: "The explorer is done." });
  await h.clock.advance(2 * AGENT_DONE_MS);
  assert.equal(h.sse.filter((m) => m.type === "activity" && m.kind === "agents").at(-1).count, 0);
  assert.ok(!appends(ws, "commentary").some((e) => /exploring|finished/i.test(e.content)));
  assert.equal(appends(ws, "thinking").filter((e) => /Finished exploring the docs\. The docs cover setup/.test(e.content)).length, 1);
});
