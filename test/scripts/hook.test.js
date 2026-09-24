// node:test suite for scripts/hook.sh (SPEC §5.6, §11.1).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { HOOK, ROOT, run, runSync, tempDir, rmDir, baseEnv, sleep, spawnBaseline } from "./helpers/run.js";
import { startFakeDaemon } from "./helpers/fake-daemon.js";

const EVENTS = ["UserPromptSubmit", "PreToolUse", "PermissionRequest", "MessageDisplay", "Stop", "StopFailure", "SessionEnd",
  "Notification", "Elicitation", "SubagentStop", "TaskCompleted", "TeammateIdle", "PostToolUseFailure"];
// Forward-only events: the owner path prints nothing for these.
const QUIET_EVENTS = EVENTS.filter((e) => e !== "UserPromptSubmit" && e !== "PreToolUse");
const SOCK = "/tmp/clv-owner.sock";
const KEY = "k".repeat(64);
const NONCE = "abc123def456";
const MARK = `[sotto voice ${NONCE}]`;
const VOICE_CONTEXT = readFileSync(join(ROOT, "scripts/voice-context.txt"), "utf8").trim().replaceAll("@MARKER@", MARK);
const BIG = JSON.stringify({ session_id: "s", hook_event_name: "UserPromptSubmit", prompt: "x".repeat(200 * 1024) });

const median = (xs) => { const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

// Wall time of spawning an empty `#!/bin/bash` script file with the same stdin:
// the floor any command hook pays (shebang exec + bash startup). Interleaved
// with the hook runs, so machine load (npm test runs the test files in
// parallel) hits both equally.
let bareScript = null;
function bareBashMs(input) {
  if (!bareScript) {
    const dir = tempDir("clv-bare-");
    bareScript = join(dir, "bare.sh");
    writeFileSync(bareScript, "#!/bin/bash\nexit 0\n", { mode: 0o755 });
    process.once("exit", () => rmDir(dir));
  }
  const t0 = performance.now();
  spawnSync(bareScript, [], { input, encoding: "utf8" });
  return performance.now() - t0;
}

const quartile = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 4)];

/**
 * The hook's own cost must be small: lower-quartile(hook) - lower-quartile(bare
 * script) <= 8 ms, and the median <= 40 ms. Lower quartiles shrug off the load
 * spikes of a parallel `npm test`; a measurement round that still fails is
 * retried before the test fails. Unloaded, the hook and the bare script are
 * within ~1-2 ms of each other (SPEC goal: gate <= 10 ms p95).
 * Under sustained load (a build or a CPU burner next to `npm test`) both
 * stretch together, so both bounds scale with the bare script: the extra is
 * 8 ms + 25 % of the bare q1, and the median may reach 3x the bare median.
 * Unloaded (bare q1 ~3 ms) that is the original 8.75 ms / 40 ms.
 */
function assertFastGate(runOnce, input) {
  let msg = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const hook = [], base = [];
    for (let i = 0; i < 20; i++) { hook.push(runOnce(i)); base.push(bareBashMs(input)); }
    const h = quartile(hook), b = quartile(base), m = median(hook);
    if (h - b <= 8 + 0.25 * b && m <= Math.max(40, 3 * median(base))) return;
    msg = `hook q1 ${h.toFixed(2)} ms (median ${m.toFixed(2)}) vs bare script q1 ${b.toFixed(2)} ms`;
  }
  assert.fail(msg);
}

function writeActive(D, owner, port, nonce = NONCE) {
  writeFileSync(join(D, "active"), `${owner}\t${port}\t${KEY}\t${nonce}\n`, { mode: 0o600 });
}

describe("hook.sh off path", () => {
  let D, env;
  before(() => {
    D = tempDir();
    env = baseEnv({ CLAUDE_PLUGIN_DATA: D, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_CODE_MESSAGING_SOCKET: SOCK });
  });
  after(() => rmDir(D));

  test("no active file: silent exit 0 for every event with 200 KB stdin", () => {
    for (const ev of EVENTS) {
      const r = runSync(HOOK, { args: [ev], env, input: BIG });
      assert.equal(r.code, 0, ev);
      assert.equal(r.stdout, "", ev);
      assert.equal(r.stderr, "", ev);
    }
  });

  // Median, not mean: `npm test` runs the test files in parallel, and a single
  // scheduler hiccup would otherwise fail an honest ~5 ms hook.
  test("no active file: gate costs <= 8 ms over bare bash (median of 20)", () => {
    runSync(HOOK, { args: ["Stop"], env, input: BIG }); // warm the page cache
    assertFastGate((i) => runSync(HOOK, { args: [EVENTS[i % EVENTS.length]], env, input: BIG }).ms, BIG);
  });

  test("no messaging socket in env: silent even if active exists", async () => {
    const srv = await startFakeDaemon();
    try {
      writeActive(D, SOCK, srv.port);
      const { CLAUDE_CODE_MESSAGING_SOCKET, ...noSock } = env;
      const r = runSync(HOOK, { args: ["Stop"], env: noSock, input: "{}" });
      assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""]);
      await sleep(200);
      assert.equal(srv.requests.length, 0);
    } finally {
      rmDir(join(D, "active"));
      await srv.close();
    }
  });

  test("unreadable active file: silent", () => {
    writeFileSync(join(D, "active"), `${SOCK}\t1\t${KEY}\n`, { mode: 0o000 });
    try {
      const r = runSync(HOOK, { args: ["Stop"], env, input: "{}" });
      assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""]);
    } finally {
      rmDir(join(D, "active"));
    }
  });
});

describe("hook.sh non-owner", () => {
  let D, srv, env;
  before(async () => {
    D = tempDir();
    srv = await startFakeDaemon();
    writeActive(D, "/tmp/clv-someone-else.sock", srv.port);
    writeFileSync(join(D, "pending-context"), "");
    env = baseEnv({ CLAUDE_PLUGIN_DATA: D, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_CODE_MESSAGING_SOCKET: SOCK });
  });
  after(async () => { await srv.close(); rmDir(D); });

  test("silent, fast, forwards nothing, leaves pending-context alone", async () => {
    assertFastGate((i) => {
      const ev = EVENTS[i % EVENTS.length];
      const input = ev === "UserPromptSubmit" ? BIG.replace('"x', '"[sotto voice] x') : BIG;
      const r = runSync(HOOK, { args: [ev], env, input });
      assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""], ev);
      return r.ms;
    }, BIG);
    await sleep(300);
    assert.equal(srv.requests.length, 0);
    assert.ok(existsSync(join(D, "pending-context")));
  });
});

describe("hook.sh owner path", () => {
  let D, srv, env;
  before(async () => {
    D = tempDir();
    srv = await startFakeDaemon();
    writeActive(D, SOCK, srv.port);
    env = baseEnv({ CLAUDE_PLUGIN_DATA: D, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_CODE_MESSAGING_SOCKET: SOCK });
  });
  after(async () => { await srv.close(); rmDir(D); });

  test("forwards stdin verbatim to POST /hook/<Event> with key and socket headers", async () => {
    for (const ev of EVENTS) {
      srv.requests.length = 0;
      const payload = JSON.stringify({ session_id: "abc", hook_event_name: ev, text: 'quote " backslash \\ unicode é newline \n end' });
      const r = await run(HOOK, { args: [ev], env, input: payload });
      assert.equal(r.code, 0);
      assert.equal(r.stderr, "");
      const req = (await srv.waitForRequests(1)).find((q) => q.url === `/hook/${ev}`);
      assert.ok(req, `no request for ${ev}`);
      assert.equal(req.method, "POST");
      assert.equal(req.url, `/hook/${ev}`);
      assert.equal(req.headers["x-sotto-key"], KEY);
      assert.equal(req.headers["x-sotto-socket"], SOCK);
      assert.equal(req.headers["content-type"], "application/json");
      assert.equal(req.body, payload);
    }
  });

  test("large (200 KB) body is forwarded intact", async () => {
    srv.requests.length = 0;
    const r = await run(HOOK, { args: ["MessageDisplay"], env, input: BIG });
    assert.equal(r.code, 0);
    const [req] = await srv.waitForRequests(1);
    assert.equal(req.body, BIG);
  });

  test("stdout is empty for every forward-only event (incl. Notification, Elicitation, SubagentStop, ...)", async () => {
    for (const ev of QUIET_EVENTS) {
      const r = await run(HOOK, { args: [ev], env, input: `{"prompt":"${MARK} hi"}` });
      assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""], ev);
    }
  });

  test("new notification events: owner path stays fast and prints nothing, even with pending-context", async () => {
    writeFileSync(join(D, "pending-context"), "");
    try {
      const inputs = {
        Notification: '{"hook_event_name":"Notification","notification_type":"idle_prompt","message":"Claude is waiting for your input"}',
        Elicitation: '{"hook_event_name":"Elicitation","mcp_server_name":"x","message":"Please provide your credentials","mode":"form"}',
        SubagentStop: '{"hook_event_name":"SubagentStop","agent_id":"a1","agent_type":"Explore","last_assistant_message":"done"}',
        TaskCompleted: '{"hook_event_name":"TaskCompleted","task_id":"t1","task_subject":"Write tests"}',
        TeammateIdle: '{"hook_event_name":"TeammateIdle","teammate_name":"researcher"}',
        PostToolUseFailure: '{"hook_event_name":"PostToolUseFailure","tool_name":"Bash","error":"Exit code 1"}',
      };
      const evs = Object.keys(inputs);
      const times = [];
      for (let i = 0; i < 12; i++) {
        const ev = evs[i % evs.length];
        const r = await run(HOOK, { args: [ev], env, input: inputs[ev] });
        assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""], ev);
        times.push(r.ms);
      }
      // 200 ms plus a load allowance (10 bare bash spawns; ~30 ms unloaded).
      const bound = 200 + 10 * spawnBaseline().bash;
      assert.ok(median(times) < bound, `median ${median(times).toFixed(1)} ms (bound ${bound.toFixed(0)} ms)`);
      assert.ok(existsSync(join(D, "pending-context")), "only a main-thread PreToolUse claims the flag");
    } finally {
      rmDir(join(D, "pending-context"));
    }
  });

  test("unknown events are still forwarded", async () => {
    await sleep(200); // let background POSTs from earlier tests land first
    srv.requests.length = 0;
    await run(HOOK, { args: ["SomeFutureEvent"], env, input: "{}" });
    const reqs = await srv.waitForRequests(1);
    assert.ok(reqs.some((r) => r.url === "/hook/SomeFutureEvent"));
  });

  test("returns before a slow daemon (2 s) answers", async () => {
    const slow = await startFakeDaemon({ delayMs: 2000 });
    const D2 = tempDir();
    try {
      writeActive(D2, SOCK, slow.port);
      const r = await run(HOOK, { args: ["Stop"], env: { ...env, CLAUDE_PLUGIN_DATA: D2 }, input: "{}" });
      assert.equal(r.code, 0);
      // Far below the daemon's 2 s delay, plus a load allowance.
      const bound = 1000 + 10 * spawnBaseline().bash;
      assert.ok(r.ms < bound, `took ${r.ms.toFixed(0)} ms (bound ${bound.toFixed(0)} ms)`);
      const reqs = await slow.waitForRequests(1);
      assert.equal(reqs.length, 1);
    } finally {
      await slow.close();
      rmDir(D2);
    }
  });

  test("daemon down (stale active file): silent, fast exit 0", async () => {
    const D2 = tempDir();
    try {
      writeActive(D2, SOCK, 1); // nothing listens on port 1
      const r = await run(HOOK, { args: ["Stop"], env: { ...env, CLAUDE_PLUGIN_DATA: D2 }, input: "{}" });
      assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""]);
      const bound = 500 + 10 * spawnBaseline().bash;
      assert.ok(r.ms < bound, `took ${r.ms.toFixed(0)} ms (bound ${bound.toFixed(0)} ms)`);
    } finally {
      rmDir(D2);
    }
  });

  test("active file without trailing newline still gates in", async () => {
    const D2 = tempDir();
    try {
      writeFileSync(join(D2, "active"), `${SOCK}\t${srv.port}\t${KEY}`);
      srv.requests.length = 0;
      await run(HOOK, { args: ["Stop"], env: { ...env, CLAUDE_PLUGIN_DATA: D2 }, input: "{}" });
      const reqs = await srv.waitForRequests(1);
      assert.equal(reqs.length, 1);
    } finally {
      rmDir(D2);
    }
  });

  test("UserPromptSubmit with the voice marker prints the context JSON", async () => {
    const input = JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: `${MARK} what branch am I on` });
    const r = await run(HOOK, { args: ["UserPromptSubmit"], env, input });
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.includes("\n"), "single line");
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out, { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: VOICE_CONTEXT } });
  });

  test("UserPromptSubmit without the marker prints nothing", async () => {
    const r = await run(HOOK, { args: ["UserPromptSubmit"], env, input: JSON.stringify({ prompt: "fix the tests" }) });
    assert.deepEqual([r.code, r.stdout], [0, ""]);
  });

  test("UserPromptSubmit: look-alike markers get no voice framing", async () => {
    for (const prompt of [
      "[sotto voice] what branch", // no nonce (e.g. a peer that copied the old marker)
      "[sotto voice 000000000000] what branch", // wrong nonce
      `please explain ${MARK} in hook.sh`, // mentioned, not at the start
    ]) {
      const r = await run(HOOK, { args: ["UserPromptSubmit"], env, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt }) });
      assert.deepEqual([r.code, r.stdout], [0, ""], prompt);
    }
    // The marker inside another field (e.g. transcript text) does not count either.
    const r = await run(HOOK, { args: ["UserPromptSubmit"], env, input: JSON.stringify({ note: `${MARK} x`, prompt: "typed" }) });
    assert.equal(r.stdout, "");
  });

  test("PreToolUse from a subagent (agent_id) does not claim pending-context", async () => {
    const flag = join(D, "pending-context");
    writeFileSync(flag, "");
    const r = await run(HOOK, { args: ["PreToolUse"], env, input: JSON.stringify({ tool_name: "Bash", agent_id: "agent-1", agent_type: "Explore" }) });
    assert.equal(r.stdout, "");
    assert.ok(existsSync(flag), "left for the main thread");
    const r2 = await run(HOOK, { args: ["PreToolUse"], env, input: '{"tool_name":"Bash"}' });
    assert.equal(JSON.parse(r2.stdout).hookSpecificOutput.additionalContext, VOICE_CONTEXT);
    assert.ok(!existsSync(flag));
  });

  test("PreToolUse consumes pending-context once", async () => {
    const flag = join(D, "pending-context");
    writeFileSync(flag, "");
    const r1 = await run(HOOK, { args: ["PreToolUse"], env, input: '{"tool_name":"Bash"}' });
    const out = JSON.parse(r1.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(out.hookSpecificOutput.additionalContext, VOICE_CONTEXT);
    assert.ok(!existsSync(flag));
    const r2 = await run(HOOK, { args: ["PreToolUse"], env, input: '{"tool_name":"Bash"}' });
    assert.equal(r2.stdout, "");
  });

  test("two concurrent PreToolUse hooks: exactly one prints", async () => {
    for (let round = 0; round < 5; round++) {
      writeFileSync(join(D, "pending-context"), "");
      const rs = await Promise.all([1, 2].map(() => run(HOOK, { args: ["PreToolUse"], env, input: "{}" })));
      const printed = rs.filter((r) => r.stdout !== "");
      assert.equal(printed.length, 1, `round ${round}`);
      JSON.parse(printed[0].stdout);
    }
  });
});

// The daemon key must never be on a command line: macOS `ps` shows every
// user's argv, and the daemon listens on loopback for all local users.
test("scripts never pass the daemon key in curl argv", () => {
  for (const f of ["scripts/hook.sh", "scripts/toggle.sh", "scripts/lib.sh", "bin/sotto"]) {
    const src = readFileSync(join(ROOT, f), "utf8");
    assert.doesNotMatch(src, /-H\s+["']X-Sotto-Key:/, `${f} puts X-Sotto-Key on curl's command line`);
  }
});
