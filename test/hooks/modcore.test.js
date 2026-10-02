// Pure logic of the Claude Code mod (hooks/modcore.mjs, SPEC §6.21).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { FORWARDED, adaptPreToolUse, baseOf, forwardBody, trimBody, markerFor, parseActive, ownsSession, Seen, Uplink, Delivery, appendText } from "../../hooks/modcore.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("the mod forwards exactly the events hook.sh forwards (hooks.json minus /talk's expansion)", () => {
  const hooks = JSON.parse(fs.readFileSync(`${ROOT}/hooks/hooks.json`, "utf8"));
  const shell = Object.keys(hooks.hooks).filter((k) => k !== "UserPromptExpansion").sort();
  assert.deepEqual([...FORWARDED].sort(), shell);
  assert.deepEqual(hooks.modules, ["./sotto-mod.mjs"]);
  const src = fs.readFileSync(`${ROOT}/hooks/sotto-mod.mjs`, "utf8");
  for (const ev of FORWARDED) assert.match(src, new RegExp(`on\\("classic\\.${ev}"`), `the mod hooks classic.${ev}`);
});

test("PreToolUse adapter: the envelope becomes the stdin shape the daemon reads", () => {
  const base = baseOf({ session_id: "s1", transcript_path: "/t.jsonl", cwd: "/w", permission_mode: "bypassPermissions" });
  const main = adaptPreToolUse({ tool: "Bash", tool_use_id: "tu1", command: "ls", description: "list" }, base, "p1");
  assert.deepEqual(main, {
    session_id: "s1", transcript_path: "/t.jsonl", cwd: "/w", permission_mode: "bypassPermissions",
    hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls", description: "list" }, tool_use_id: "tu1", prompt_id: "p1",
  });
  const sub = adaptPreToolUse({ tool: "SubagentHandback", tool_use_id: "tu2", message: "report", agentId: "a7" }, base, "p1");
  assert.equal(sub.agent_id, "a7");
  assert.equal(sub.prompt_id, undefined, "a subagent's call is not the main turn's");
  assert.deepEqual(sub.tool_input, { message: "report" });
  assert.deepEqual(Object.keys(adaptPreToolUse({ tool: "Read", tool_use_id: "x" })).sort(), ["hook_event_name", "tool_input", "tool_name", "tool_use_id"]);
});

test("base fields carry over from the latest event that has them", () => {
  const a = baseOf({ session_id: "s1", cwd: "/w" });
  const b = baseOf({ permission_mode: "default" }, a);
  assert.deepEqual(b, { session_id: "s1", transcript_path: undefined, cwd: "/w", permission_mode: "default" });
});

test("forwarded bodies: PostToolUse without tool_response; long strings cut", () => {
  const b = forwardBody("PostToolUse", { tool_name: "Read", tool_use_id: "t", tool_response: "x".repeat(10) });
  assert.equal("tool_response" in b, false);
  const big = trimBody({ tool_input: { content: "y".repeat(100_000) } });
  assert.equal(big.tool_input.content.length, 16 * 1024);
});

test("marker and active file parsing match hook.sh", () => {
  assert.equal(markerFor("abc123"), "[sotto voice abc123]");
  assert.equal(markerFor("not hex!"), "[sotto voice]");
  assert.deepEqual(parseActive("/tmp/s.sock\t47821\tKEY\tabc\n"), { owner: "/tmp/s.sock", port: 47821, key: "KEY", nonce: "abc" });
  assert.deepEqual(parseActive("/tmp/s.sock\t47821\tKEY"), { owner: "/tmp/s.sock", port: 47821, key: "KEY", nonce: "" });
  assert.equal(parseActive("/tmp/s.sock\tx\tKEY"), null);
  assert.equal(parseActive(""), null);
  assert.equal(ownsSession("/tmp/s.sock", "/tmp/s.sock"), true);
  assert.equal(ownsSession("mod:/tmp/s.sock", "/tmp/s.sock"), true);
  assert.equal(ownsSession("/tmp/other.sock", "/tmp/s.sock"), false);
  assert.equal(ownsSession("mod:", ""), false);
});

test("Seen dedupes msg_ids within its bound", () => {
  const s = new Seen(2);
  s.add("a"); s.add("b");
  assert.equal(s.has("a"), true);
  s.add("c");
  assert.equal(s.has("a"), false);
  assert.equal(s.has("c"), true);
});

test("Uplink: seq-numbered, batches in order, acked events drop, bounded", () => {
  const u = new Uplink(3);
  for (const n of [1, 2, 3, 4]) u.push({ kind: "classic", n });
  assert.equal(u.dropped, 1);
  assert.deepEqual(u.batch(2).map((e) => e.seq), [2, 3]);
  u.ack(3);
  assert.deepEqual(u.batch().map((e) => e.seq), [4]);
  u.ack(undefined);
  assert.equal(u.size, 1);
});

test("Delivery: idle submits, busy appends, mirrors and nudges wait for the end of the turn", () => {
  let now = 1000;
  const d = new Delivery({ now: () => now });
  assert.equal(d.route({ priority: "next" }), "submit");
  d.turnStart("t1");
  assert.equal(d.route({ priority: "next" }), "append");
  assert.equal(d.route({ priority: "later" }), "queue");
  assert.equal(d.route({ priority: "next", submit_only: true }), "queue");
  d.enqueue({ msg_id: "m" });
  assert.equal(d.nextQueued(), null, "nothing is submitted while busy");
  d.turnComplete();
  assert.deepEqual(d.nextQueued(), { msg_id: "m" });
});

test("Delivery: an append before the last model request was read; one after it was missed", () => {
  let now = 1000;
  const d = new Delivery({ now: () => now });
  d.turnStart("t1");
  now = 1100; d.noteAppend("read-1");      // during step 0 (a tool runs)
  now = 1200; d.stepStart();                // step 1: carries read-1
  now = 1300; d.noteAppend("missed-1");    // during the final step
  assert.deepEqual(d.missedAtStop(), ["missed-1"]);
  assert.deepEqual(d.missedAtStop(), [], "reported once");
});

test("the appended text carries the voice framing", () => {
  assert.equal(appendText("[sotto voice a] hi", "ctx"), "[sotto voice a] hi\n\n(ctx)");
  assert.equal(appendText("x", ""), "x");
});
