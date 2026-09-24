import { test } from "node:test";
import assert from "node:assert/strict";
import { route, Narrator, milestoneLabel, permissionLabel, resultParts, toolActivity, ToolLine, AgentTracker, AGENT_STALE_MS, agentsText, cardText, AGENT_DONE_MS, AGENT_SPEAK_COOLDOWN_MS, workLabel, reportSentence, finishedSentence } from "../../daemon/policy.js";
import { createFakeClock } from "../helpers/fake-clock.js";
import { relay, RELAY_MARK } from "../../daemon/phrasing.js";

const BG = "[Background reference; not user speech] ";
const SHORT = "You are on the main branch. Nothing is uncommitted.";
const LONG = "## Result\n\nThe tests pass. I fixed two bugs in `daemon/voice.js`.\n\n" +
  Array.from({ length: 80 }, (_, i) => `Detail sentence number ${i} explains more about the change.`).join(" ") +
  "\n\n```js\ncode();\n```";

const kinds = (acts) => acts.map((a) => `${a.kind}:${a.delegationId ?? "null"}`);

test("voice_result: commentary(id, S) (+ thinking R when longer), all policies", () => {
  for (const p of ["quiet", "milestones"]) {
    const s = route("voice_result", p, { text: SHORT, delegationId: "d1" });
    assert.deepEqual(s, [{ kind: "commentary", delegationId: "d1", content: relay("answer", SHORT) }]);
    assert.doesNotMatch(s[0].content, /Claude Code's answer/);
    const l = route("voice_result", p, { text: LONG, delegationId: "d1" });
    assert.equal(l[0].kind, "commentary");
    assert.ok(l[0].content.includes(RELAY_MARK + "Result. The tests pass."));
    assert.ok(l.slice(1).length >= 1 && l.slice(1).length <= 2);
    for (const a of l.slice(1)) { assert.equal(a.kind, "thinking"); assert.equal(a.delegationId, null); }
    assert.ok(l[1].content.startsWith(BG + "Claude's full reply, for follow-up questions (abridged): "));
  }
  const w = route("voice_result", "walkthrough", { text: LONG, delegationId: "d1" });
  assert.deepEqual(kinds(w).slice(0, 3), ["commentary:d1", "commentary:d1", "commentary:d1"]);
  assert.ok(kinds(w).slice(3).every((k) => k === "thinking:null"));
  for (const a of w) assert.ok(a.content.length <= 1400);
});

test("stale_result: background thinking with the request text", () => {
  for (const p of ["quiet", "milestones", "walkthrough"]) {
    const a = route("stale_result", p, { text: SHORT, delegationId: "d1", requestText: 'what "branch"' });
    assert.deepEqual(a, [{ kind: "thinking", delegationId: null, content: `${BG}Result for the earlier request "what 'branch'": Claude's reply: ${SHORT}` }]);
  }
});

test("typed_result per policy", () => {
  assert.deepEqual(route("typed_result", "quiet", { text: SHORT }), [{ kind: "thinking", delegationId: null, content: BG + "Claude's reply: " + SHORT }]);
  const text3 = "One done. Two done. Three done.";
  // Milestones: one short sentence (§6.10.2), so a typed turn never crowds the voice.
  assert.deepEqual(route("typed_result", "milestones", { text: text3 }), [{ kind: "commentary", delegationId: null, content: relay("typed", "One done.") }]);
  assert.deepEqual(route("typed_result", "walkthrough", { text: text3 }), [{ kind: "commentary", delegationId: null, content: relay("typed", text3) }]);
  const m = route("typed_result", "milestones", { text: LONG });
  assert.equal(m[0].kind, "commentary");
  assert.ok(m.slice(1).every((a) => a.kind === "thinking"));
});

test("progress_text: thinking unless walkthrough may speak", () => {
  assert.deepEqual(route("progress_text", "quiet", { text: "Now running **tests**." }), [{ kind: "thinking", delegationId: null, content: BG + "Now running tests." }]);
  assert.equal(route("progress_text", "walkthrough", { text: "x." }, { canSpeakProgress: true })[0].kind, "commentary");
  assert.equal(route("progress_text", "walkthrough", { text: "x." }, { canSpeakProgress: false })[0].kind, "thinking");
  const long = route("progress_text", "milestones", { text: "word ".repeat(400) });
  assert.ok(long[0].content.length <= BG.length + 600);
});

test("tool_milestone, permission and policy_change", () => {
  assert.deepEqual(route("tool_milestone", "walkthrough", { labels: ["reading a.js", "searching the code"] }),
    [{ kind: "thinking", delegationId: null, content: BG + "Claude progress: reading a.js; searching the code" }]);
  assert.deepEqual(route("permission", "quiet", { label: "run a shell command" }),
    [{ kind: "commentary", delegationId: null, content: "Claude needs your approval in the terminal to run a shell command." }]);
  const pc = route("policy_change", "milestones", { policy: "quiet" });
  assert.equal(pc[0].kind, "instructions");
  assert.match(pc[0].content, /^The update preference has changed\. Update preference: Quiet\./);
});

test("milestone and permission labels never include raw arguments", () => {
  assert.equal(milestoneLabel("Bash", { command: "rm -rf /secret/path", description: "Remove build output" }), "remove build output");
  assert.equal(milestoneLabel("Bash", { command: "/usr/bin/npm test --silent" }), "running the tests");
  assert.equal(milestoneLabel("Bash", { command: "/opt/tool --flag /secret/x" }), "running a command");
  assert.equal(milestoneLabel("Edit", { file_path: "/a/b/hooks.json" }), "editing a file");
  assert.equal(milestoneLabel("Read", { file_path: "/a/b/c.md" }), "looking through the code");
  assert.equal(milestoneLabel("Grep", {}), "looking through the code");
  assert.equal(milestoneLabel("WebSearch", {}), "searching the web");
  assert.equal(milestoneLabel("Agent", { description: "Explore repo" }), null, "agents are counted, not narrated");
  assert.equal(milestoneLabel("mcp__github__create_issue", {}), "using github");
  assert.equal(milestoneLabel("TodoWrite", {}), null);
  assert.equal(permissionLabel("Bash", { command: "curl secret" }), "run a shell command");
  assert.equal(permissionLabel("Write", { file_path: "/x/hooks.json" }), "edit hooks.json");
  assert.equal(permissionLabel("mcp__slack__post", {}), "use slack");
});

test("toolActivity: busywork is skipped, the rest is plain words (never the literal command)", () => {
  const bash = (command, description) => toolActivity("Bash", { command, description });
  for (const c of ["cd /Users/me/dev/sotto", "ls -la", "cat package.json", "grep -n foo daemon/*.js", "sleep 5", "echo hi",
    "git status", "git log --oneline -3", "git diff", "cd /x && git status --short", "pwd", "head -20 a.js", "rg foo", "find . -name x",
    "python3 -c 'print(1)'", "node -e 'x'", "cd /a/b && ls", "FOO=1 cat x", "sed -n 1,20p a.js", "wc -l a.js", "jq . x.json"]) {
    assert.equal(bash(c, "List files in current directory"), null, c);
  }
  assert.equal(bash("cd /repo && npm test 2>&1 | tail -5"), "Running the tests");
  assert.equal(bash("node --test test/daemon/policy.test.js"), "Running the tests");
  assert.equal(bash("npm run e2e"), "Running the tests");
  assert.equal(bash("npm install"), "Installing packages");
  assert.equal(bash("bash scripts/build-app.sh"), "Building the project");
  assert.equal(bash("git commit -m 'x'"), "Committing the changes");
  assert.equal(bash("cd /repo && git push -u origin fix/x"), "Pushing the changes");
  assert.equal(bash("gh pr create --title x"), "Opening a pull request");
  assert.equal(bash("gh pr merge 12 --squash"), "Merging a pull request");
  assert.equal(bash("curl -s https://example.com/secret"), "Fetching from the web");
  assert.equal(bash("claude plugin validate . --strict"), "Validating the plugin");
  assert.equal(bash("./deploy --prod /Users/me/x", "Deploy the site to staging"), "Deploy the site to staging");
  assert.equal(bash("./deploy --prod /Users/me/x"), "Running a command");
  assert.equal(toolActivity("Edit", { file_path: "/a/voice.js" }), "Editing a file");
  assert.equal(toolActivity("WebFetch", { url: "https://x" }), "Reading a web page");
  assert.equal(toolActivity("mcp__claude_ai_Slack__slack_send_message", {}), "Using Slack");
  for (const t of ["Agent", "Task", "Workflow", "TodoWrite", "ToolSearch", "Skill", "TaskUpdate", "SomeNewTool"]) assert.equal(toolActivity(t, {}), null, t);
  for (const c of ["cd x", "ls", "git status"]) assert.ok(!String(bash(c)).includes("cd"));
});

test("ToolLine: deduped and collapsed within a turn", () => {
  const l = new ToolLine();
  assert.equal(l.push("Bash", { command: "cd /x" }), null, "busywork shows nothing");
  assert.equal(l.push("Edit", { file_path: "/a/voice.js" }), "Editing a file");
  assert.equal(l.push("Edit", { file_path: "/a/voice.js" }), null, "same line: no change");
  assert.equal(l.push("Bash", { command: "ls" }), null);
  assert.equal(l.push("Write", { file_path: "/a/policy.js" }), "Editing 2 files");
  assert.equal(l.push("Edit", { file_path: "/a/app.js" }), "Editing 3 files");
  assert.equal(l.push("Bash", { command: "npm test" }), "Running the tests");
  assert.equal(l.push("Bash", { command: "npm test -- --grep x" }), null);
  assert.equal(l.push("Agent", { description: "Explore" }), null);
  l.reset();
  assert.equal(l.push("Edit", { file_path: "/a/x.js" }), "Editing a file");
});

test("agentsText and AgentTracker: launches, first hooks and stops; stale entries expire", async () => {
  assert.equal(agentsText(0), "");
  assert.equal(agentsText(1), "1 background agent working");
  assert.equal(agentsText(3), "3 background agents working");
  const clock = createFakeClock();
  const t = new AgentTracker({ clock });
  t.launched(); t.launched();
  assert.equal(t.count(), 2);
  t.seen("a1");
  assert.equal(t.count(), 2, "a launched agent reporting in is not counted twice");
  t.seen("a1");
  assert.equal(t.complete("internal"), false, "an id that is none of our agents (an internal agent) never counts");
  assert.equal(t.count(), 2, "and does not count a launch down");
  t.noteTasks([{ id: "a2", type: "subagent", status: "running" }, { id: "b1", type: "shell" }]);
  assert.equal(t.isKnown("b1"), false, "shell tasks are not agents");
  assert.equal(t.complete("a2"), true, "the second launch, finished before any hook of its own");
  assert.equal(t.complete("a2"), false, "never counted twice");
  assert.equal(t.count(), 1);
  t.seen("w1"); // a workflow agent nobody launched through Agent
  assert.equal(t.count(), 2);
  assert.equal(t.complete("a1"), true);
  t.seen("a1"); // a late hook from a finished agent does not bring it back
  assert.equal(t.count(), 1);
  await clock.advance(AGENT_STALE_MS + 1);
  assert.equal(t.count(), 0);
});

test("cardText: Claude's words without markdown, code or paths, a sentence or two", () => {
  assert.equal(cardText("I'll **fix** the `parser` in `/Users/me/dev/sotto/daemon/voice.js` now. Then run tests. Then more."),
    "I'll fix the parser in voice.js now. Then run tests.");
  assert.equal(cardText("Here:\n\n```js\nconst x = 1;\n```"), "Here:");
  assert.equal(cardText("- first item\n- second"), "first item. second.");
  assert.equal(cardText(""), "");
});

test("resultParts: empty text is handled", () => {
  const r = resultParts("");
  assert.equal(r.S, "Claude finished, with nothing to report.");
  assert.deepEqual(r.R, []);
});

function narrator(policy = "milestones") {
  const clock = createFakeClock();
  const out = [];
  const n = new Narrator({ clock, policy: () => policy, emit: (a) => out.push(a) });
  return { clock, out, n };
}

test("milestone batching: one thinking per 3 s, joined, duplicates dropped", async () => {
  const { clock, out, n } = narrator();
  n.onToolUse("Read", { file_path: "/a/x.js" });
  n.onToolUse("Read", { file_path: "/a/x.js" });
  n.onToolUse("Grep", {});
  n.onToolUse("Bash", { command: "git status" });
  await clock.advance(2999);
  assert.equal(out.length, 0);
  await clock.advance(1);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, BG + "Claude progress: looking through the code");
  assert.equal(out[0].source, "tool_milestone");
  n.onToolUse("Grep", {}); // same as the last label sent → dropped
  n.onToolUse("Bash", { command: "cd /x && ls" }); // busywork: never a milestone
  await clock.advance(3000);
  assert.equal(out.length, 1);
});

test("thinking dedupe: identical content within 30 s is skipped", async () => {
  const { clock, out, n } = narrator();
  n.route("progress_text", { text: "Same note." });
  n.route("progress_text", { text: "Same note." });
  assert.equal(out.length, 1);
  await clock.advance(30001);
  n.route("progress_text", { text: "Same note." });
  assert.equal(out.length, 2);
});

test("walkthrough progress commentary is throttled to 1 per 15 s", async () => {
  const { clock, out, n } = narrator("walkthrough");
  n.route("progress_text", { text: "First step." });
  n.route("progress_text", { text: "Second step." });
  assert.deepEqual(out.map((a) => a.kind), ["commentary", "thinking"]);
  await clock.advance(15000);
  n.route("progress_text", { text: "Third step." });
  assert.equal(out[2].kind, "commentary");
});

test("permission: a repeated hook for the same call is spoken once; every other approval is spoken (§6.10.4)", async () => {
  const { clock, out, n } = narrator("quiet");
  assert.equal(n.onPermission("Bash", {}), "run a shell command");
  assert.equal(n.onPermission("Bash", {}), null, "the same call (no id) within 10 s");
  await clock.advance(10000);
  n.onPermission("Bash", {});
  assert.equal(out.length, 2);
  // Two approvals with the same words (two agents, two commands) are both spoken, even under quiet.
  assert.equal(n.onPermission("Bash", { command: "npm test" }, { id: "toolu_1" }), "run a shell command");
  assert.equal(n.onPermission("Bash", { command: "npm test" }, { id: "toolu_2", agent: true }), "run a shell command");
  assert.equal(n.onPermission("Bash", { command: "npm test" }, { id: "toolu_2", agent: true }), null, "same approval id");
  assert.deepEqual(out.slice(2).map((a) => a.content), [
    "Claude wants to run a shell command. It needs your approval in the terminal.", // third main-thread approval: variant 2
    "A background agent is waiting for your approval in the terminal to run a shell command.",
  ]);
  assert.deepEqual(out.slice(2).map((a) => a.dedupeKey), ["approval:toolu_1", "approval:toolu_2"], "keyed by approval, not by text");
});

test("progress_text hold: released by a later tool use, discarded by Stop", () => {
  const { out, n } = narrator();
  n.onMessageDisplay({ message_id: "m1", index: 0, final: false, delta: "Let me look at\n" });
  n.onMessageDisplay({ message_id: "m1", index: 1, final: true, delta: "the tests." });
  assert.equal(out.length, 0);
  n.onToolUse("Bash", { description: "Run tests" });
  assert.equal(out.length, 1);
  assert.equal(out[0].content, BG + "Let me look at the tests.");
  n.onMessageDisplay({ message_id: "m2", index: 0, final: true, delta: "All done." });
  n.onStop();
  n.onToolUse("Read", { file_path: "/x" });
  assert.equal(out.filter((a) => a.source === "progress_text").length, 1);
});

test("progress_text hold: released by a MessageDisplay of another message", () => {
  const { out, n } = narrator();
  n.onMessageDisplay({ message_id: "m1", final: true, delta: "Checking now." });
  n.onMessageDisplay({ message_id: "m2", final: false, delta: "Next\n" });
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "progress_text");
});

test("background agent done: named and specific, only when the parent does not speak for it", async () => {
  let { clock, out, n } = narrator("milestones");
  n.onAgentDone({ label: "fixing wake detection", result: "Normal speech wakes it now." });
  await clock.advance(AGENT_DONE_MS);
  assert.deepEqual(out.filter((a) => a.kind === "commentary").map((a) => a.content), ["Fixing wake detection is done. Normal speech wakes it now."]);
  // Unnamed (not top-level) work is context only: never a bare count.
  ({ clock, out, n } = narrator("milestones"));
  n.onAgentDone({ detail: "The Explore agent: Found 12 endpoints." });
  n.onAgentDone("");
  await clock.advance(AGENT_DONE_MS);
  assert.equal(out.filter((a) => a.kind === "commentary").length, 0);
  assert.ok(out.some((a) => a.kind === "thinking" && a.content.includes("Found 12 endpoints")));
  // The parent is mid-turn (it will summarize): context only.
  ({ clock, out, n } = narrator("milestones"));
  n.onTurnStart();
  n.onAgentDone({ label: "x" });
  await clock.advance(AGENT_DONE_MS);
  assert.equal(out.filter((a) => a.kind === "commentary").length, 0);
  // The parent's task-notification turn answers within the window: its words win.
  ({ clock, out, n } = narrator("milestones"));
  n.onAgentDone({ label: "counting files" });
  await clock.advance(2000);
  n.route("background_result", { text: "The agent counted 3 files." });
  await clock.advance(AGENT_DONE_MS);
  assert.deepEqual(out.filter((a) => a.kind === "commentary").map((a) => a.content), [relay("bgwork", "The agent counted 3 files.")]);
  // Quiet: never spoken.
  ({ clock, out, n } = narrator("quiet"));
  n.onAgentDone({ label: "x", result: "y" });
  await clock.advance(AGENT_DONE_MS);
  assert.equal(out.filter((a) => a.kind === "commentary").length, 0);
});

test("background agent done: one spoken line per minute; later ones wait and batch; nothing re-fires", async () => {
  const { clock, out, n } = narrator("milestones");
  const said = () => out.filter((a) => a.kind === "commentary").map((a) => a.content);
  n.onAgentDone({ label: "fixing wake detection", result: "Normal speech wakes it now." });
  await clock.advance(AGENT_DONE_MS);
  assert.equal(said().length, 1);
  await clock.advance(10000);
  n.onAgentDone({ label: "drafting redesign concepts", result: "Three concepts are ready." });
  await clock.advance(15000);
  n.onAgentDone({ label: "porting the pills", result: "The app has the same pills now." });
  await clock.advance(AGENT_DONE_MS);
  assert.equal(said().length, 1, "inside the cooldown");
  await clock.advance(AGENT_SPEAK_COOLDOWN_MS);
  assert.deepEqual(said().slice(1), ["Two things finished. Drafting redesign concepts: three concepts are ready. Porting the pills: the app has the same pills now."]);
  await clock.advance(10 * 60_000);
  assert.equal(said().length, 2, "nothing fires on its own later");
  for (const c of said()) assert.doesNotMatch(c, /^\w+ background agents? finished\.?$/);
});

test("finished-work phrasing: labels, report sentences and templates", () => {
  assert.equal(workLabel("Fix wake detection"), "fixing wake detection");
  assert.equal(workLabel("Write personas.js module"), "writing personas.js module");
  assert.equal(workLabel("Run the e2e suite"), "running the e2e suite");
  assert.equal(workLabel("Voice picker review"), "voice picker review");
  assert.equal(workLabel("README audit"), "README audit");
  assert.equal(reportSentence("## Summary\n\nDone.\n\nI fixed the detector in `/Users/me/x/wake.js`, normal speech wakes it now."), "It fixed the detector in wake.js, normal speech wakes it now.");
  assert.equal(reportSentence('Agent "x" finished'), "");
  const long = reportSentence("The build is green on every target we ship, the notarized zip is uploaded, the release notes are written and the tag is pushed to origin.");
  assert.ok(long.split(/\s+/).length <= 26, long);
  const one = [{ label: "fixing wake detection", result: "It works." }];
  assert.deepEqual([0, 1, 2].map((v) => finishedSentence(one, v)), ["Fixing wake detection is done. It works.", "Finished fixing wake detection. It works.", "Done with fixing wake detection. It works."]);
  assert.equal(finishedSentence([{ label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }, { label: "e" }]), "Five things finished, including a, b, and 3 more.");
});

test("spoken progress is Claude's own words, never tool names", async () => {
  const { clock, out, n } = narrator("milestones");
  n.onTurnStart();
  await clock.advance(30000);
  for (const c of ["cd /x", "ls", "npm test"]) n.onToolUse("Bash", { command: c });
  n.onToolUse("Agent", { description: "Explore" });
  n.onMessageDisplay({ message_id: "m1", index: 0, delta: "I found the **bug** in `voice.js`. ", final: false });
  n.onMessageDisplay({ message_id: "m1", index: 1, delta: "Fixing it now.", final: true });
  assert.equal(n.messageSoFar("m1"), "I found the **bug** in `voice.js`. Fixing it now.");
  n.onToolUse("Edit", { file_path: "/a/voice.js" }); // releases the held message
  await clock.advance(3000);
  const said = out.filter((a) => a.kind === "commentary").map((a) => a.content);
  assert.deepEqual(said, [relay("progress", "I found the bug in voice.js.")]);
  const all = out.map((a) => a.content).join("\n");
  assert.ok(!/helper agent|running cd|\bcd\b|\bls\b/.test(all), all);
});
