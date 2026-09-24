import { test } from "node:test";
import assert from "node:assert/strict";
import { route, Narrator, milestoneLabel, permissionLabel, resultParts } from "../../daemon/policy.js";
import { createFakeClock } from "../helpers/fake-clock.js";

const BG = "[Background reference; not user speech] ";
const SHORT = "You are on the main branch. Nothing is uncommitted.";
const LONG = "## Result\n\nThe tests pass. I fixed two bugs in `daemon/voice.js`.\n\n" +
  Array.from({ length: 80 }, (_, i) => `Detail sentence number ${i} explains more about the change.`).join(" ") +
  "\n\n```js\ncode();\n```";

const kinds = (acts) => acts.map((a) => `${a.kind}:${a.delegationId ?? "null"}`);

test("voice_result: commentary(id, S) (+ thinking R when longer), all policies", () => {
  for (const p of ["quiet", "milestones"]) {
    const s = route("voice_result", p, { text: SHORT, delegationId: "d1" });
    assert.deepEqual(s, [{ kind: "commentary", delegationId: "d1", content: "Claude Code's answer: " + SHORT }]);
    const l = route("voice_result", p, { text: LONG, delegationId: "d1" });
    assert.equal(l[0].kind, "commentary");
    assert.ok(l[0].content.startsWith("Claude Code's answer: Result. The tests pass."));
    assert.ok(l.slice(1).length >= 1 && l.slice(1).length <= 2);
    for (const a of l.slice(1)) { assert.equal(a.kind, "thinking"); assert.equal(a.delegationId, null); }
    assert.ok(l[1].content.startsWith(BG + "Claude Code's full reply (abridged): "));
  }
  const w = route("voice_result", "walkthrough", { text: LONG, delegationId: "d1" });
  assert.deepEqual(kinds(w).slice(0, 3), ["commentary:d1", "commentary:d1", "commentary:d1"]);
  assert.ok(kinds(w).slice(3).every((k) => k === "thinking:null"));
  for (const a of w) assert.ok(a.content.length <= 1400);
});

test("stale_result: background thinking with the request text", () => {
  for (const p of ["quiet", "milestones", "walkthrough"]) {
    const a = route("stale_result", p, { text: SHORT, delegationId: "d1", requestText: 'what "branch"' });
    assert.deepEqual(a, [{ kind: "thinking", delegationId: null, content: `${BG}Result for the earlier request "what 'branch'": Claude Code's answer: ${SHORT}` }]);
  }
});

test("typed_result per policy", () => {
  assert.deepEqual(route("typed_result", "quiet", { text: SHORT }), [{ kind: "thinking", delegationId: null, content: BG + "Claude Code's answer: " + SHORT }]);
  const text3 = "One done. Two done. Three done.";
  // Milestones: one short sentence (§6.10.2), so a typed turn never crowds the voice.
  assert.deepEqual(route("typed_result", "milestones", { text: text3 }), [{ kind: "commentary", delegationId: null, content: "Claude Code finished: One done." }]);
  assert.deepEqual(route("typed_result", "walkthrough", { text: text3 }), [{ kind: "commentary", delegationId: null, content: "Claude Code finished: " + text3 }]);
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
    [{ kind: "commentary", delegationId: null, content: "Claude Code is waiting for your approval in the terminal to run a shell command." }]);
  const pc = route("policy_change", "milestones", { policy: "quiet" });
  assert.equal(pc[0].kind, "instructions");
  assert.match(pc[0].content, /^The update preference has changed\. Update preference: Quiet\./);
});

test("milestone and permission labels never include raw arguments", () => {
  assert.equal(milestoneLabel("Bash", { command: "rm -rf /secret/path", description: "Remove build output" }), "Remove build output");
  assert.equal(milestoneLabel("Bash", { command: "/usr/bin/npm test --silent" }), "running npm");
  assert.equal(milestoneLabel("Edit", { file_path: "/a/b/hooks.json" }), "editing hooks.json");
  assert.equal(milestoneLabel("Read", { file_path: "/a/b/c.md" }), "reading c.md");
  assert.equal(milestoneLabel("Grep", {}), "searching the code");
  assert.equal(milestoneLabel("WebSearch", {}), "searching the web");
  assert.equal(milestoneLabel("Agent", { description: "Explore repo" }), "starting a helper agent: Explore repo");
  assert.equal(milestoneLabel("mcp__github__create_issue", {}), "using github");
  assert.equal(milestoneLabel("TodoWrite", {}), "using TodoWrite");
  assert.equal(permissionLabel("Bash", { command: "curl secret" }), "run a shell command");
  assert.equal(permissionLabel("Write", { file_path: "/x/hooks.json" }), "edit hooks.json");
  assert.equal(permissionLabel("mcp__slack__post", {}), "use slack");
});

test("resultParts: empty text is handled", () => {
  const r = resultParts("");
  assert.equal(r.S, "Claude Code finished, with nothing to report.");
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
  await clock.advance(2999);
  assert.equal(out.length, 0);
  await clock.advance(1);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, BG + "Claude progress: reading x.js; searching the code");
  assert.equal(out[0].source, "tool_milestone");
  n.onToolUse("Grep", {}); // same as the last label sent → dropped
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

test("permission dedupe within 10 s", async () => {
  const { clock, out, n } = narrator();
  assert.equal(n.onPermission("Bash", {}), "run a shell command");
  assert.equal(n.onPermission("Bash", {}), null);
  await clock.advance(10000);
  n.onPermission("Bash", {});
  assert.equal(out.length, 2);
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
