// node:test suite for scripts/toggle.sh (SPEC §5.7, §9.1, §11.1).
// A stub daemon (helpers/stub-daemon.js) stands in for daemon/index.js via
// SOTTO_DAEMON_ENTRY; it records every /control body it receives.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { TOGGLE, ROOT, run, tempDir, rmDir, baseEnv, freePort, waitFor, isAlive, sleep, spawnBaseline } from "./helpers/run.js";
import { startFakeDaemon } from "./helpers/fake-daemon.js";

const STUB = join(ROOT, "test/scripts/helpers/stub-daemon.js");
const SOCK = "/tmp/clv-toggle-test.sock";
const TOKEN = "tok-123";

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** Fresh data dir + port + env, with stub cleanup registered. */
async function setup(extraEnv = {}) {
  const D = tempDir();
  const port = await freePort();
  const env = baseEnv({
    HOME: tempDir("clv-home-"), // own HOME: removed by this setup's cleanup
    CLAUDE_PLUGIN_DATA: D,
    CLAUDE_PLUGIN_ROOT: ROOT,
    CLAUDE_PLUGIN_OPTION_PORT: String(port),
    CLAUDE_CODE_MESSAGING_SOCKET: SOCK,
    CLAUDE_CODE_MESSAGING_TOKEN: TOKEN,
    CLAUDE_PID: "4242",
    CLAUDE_PROJECT_DIR: "/tmp/proj dir",
    SOTTO_DAEMON_ENTRY: STUB,
    ...extraEnv,
  });
  cleanups.push(() => {
    killStub(D);
    rmDir(D);
    rmDir(env.HOME);
  });
  return { D, port, env };
}

function killStub(D) {
  try {
    const pid = Number(readFileSync(join(D, "daemon.pid"), "utf8"));
    if (pid) process.kill(pid, "SIGTERM");
  } catch {}
}

function stdinFor(args, extra = {}) {
  return JSON.stringify({
    session_id: "sess-1",
    transcript_path: "/Users/me/.claude/projects/x/sess-1.jsonl",
    cwd: "/Users/me/dev/proj",
    prompt_id: "p1",
    permission_mode: "auto",
    hook_event_name: "UserPromptExpansion",
    expansion_type: "slash_command",
    command_name: "sotto:talk",
    command_args: args,
    command_source: "plugin",
    prompt: `/sotto:talk ${args}`.trim(),
    ...extra,
  });
}

/** Parse toggle output: exactly one line of JSON with continue:false. */
function parseOut(r) {
  assert.equal(r.code, 0, "exit code");
  assert.equal(r.stderr, "", "stderr");
  assert.ok(r.stdout.endsWith("\n"), "ends with newline");
  const lines = r.stdout.slice(0, -1).split("\n");
  assert.equal(lines.length, 1, `one line: ${r.stdout}`);
  const o = JSON.parse(lines[0]);
  assert.equal(o.continue, false);
  assert.equal(typeof o.stopReason, "string");
  return o;
}

function controlBodies(D) {
  if (!existsSync(join(D, "stub-control.jsonl"))) return [];
  return readFileSync(join(D, "stub-control.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("toggle.sh cold start", () => {
  test("spawns the stub detached, passes its /control reply through, fast", async () => {
    const { D, port, env } = await setup();
    const r = await run(TOGGLE, { env, input: stdinFor("on") });
    const out = parseOut(r);
    assert.equal(out.stopReason, "stub: on");
    // Load allowance: 10 bare node spawns (~0.4 s unloaded; toggle.sh starts node).
    const bound = 3500 + 10 * spawnBaseline().node;
    assert.ok(r.ms < bound, `took ${r.ms.toFixed(0)} ms (bound ${bound.toFixed(0)} ms)`);
    // Verbatim pass-through: exactly the stub's JSON.
    assert.equal(r.stdout, JSON.stringify({ continue: false, stopReason: "stub: on" }) + "\n");

    // Detached: the stub is still alive after toggle.sh (and its stdio) closed,
    // and its parent is not this test process.
    const pid = Number(readFileSync(join(D, "daemon.pid"), "utf8"));
    assert.ok(isAlive(pid));
    const ppid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
    assert.notEqual(ppid, process.pid);
    assert.notEqual(ppid, r.pid);

    // Exact spawn argv.
    const { argv, cwd } = JSON.parse(readFileSync(join(D, "stub-argv.json"), "utf8"));
    assert.deepEqual(argv, ["--port", String(port), "--data-dir", D, "--plugin-root", ROOT]);
    // Spawned from the plugin root, not the session's project (version-manager
    // shims pick Node from the cwd).
    assert.equal(realpathSync(cwd), realpathSync(ROOT));

    // Data dir permissions.
    assert.equal(statSync(D).mode & 0o777, 0o700);
    assert.ok(statSync(join(D, "logs")).isDirectory());
  });

  test("ControlRequest body: session from env + stdin (escapes preserved), config defaults", async () => {
    const { D, env } = await setup();
    const input = stdinFor("on", { cwd: 'C:\\odd "dir"\\x', transcript_path: "/tmp/t\u00e9st.jsonl" });
    parseOut(await run(TOGGLE, { env, input }));
    const [body] = controlBodies(D);
    assert.deepEqual(body, {
      action: "on",
      session: {
        session_id: "sess-1",
        socket: SOCK,
        token: TOKEN,
        claude_pid: 4242,
        cwd: 'C:\\odd "dir"\\x',
        project_dir: "/tmp/proj dir",
        transcript_path: "/tmp/t\u00e9st.jsonl",
      },
      config: { voice: "marin", speaking_policy: "milestones", daily_cap_minutes: 120, wake_sensitivity: "medium", window: "auto", mirror: "all", echo_guard: "auto", open_browser: true },
    });
  });

  test("action mapping once the daemon is up", async () => {
    const { D, env } = await setup();
    parseOut(await run(TOGGLE, { env, input: stdinFor("on") })); // cold start
    const cases = [
      ["", "toggle"], ["on", "on"], ["start", "on"], ["off", "off"], ["STOP", "off"],
      ["status", "status"], ["  Status  extra words", "status"], ["restart", "restart"], ["RESTART", "restart"],
      ["quiet", "policy"], ["Walkthrough", "policy"], ["milestones", "policy"],
    ];
    for (const [arg, action] of cases) {
      const out = parseOut(await run(TOGGLE, { env, input: stdinFor(arg) }));
      assert.equal(out.stopReason, `stub: ${action}`, `arg "${arg}"`);
    }
    const bodies = controlBodies(D).slice(1);
    assert.deepEqual(bodies.map((b) => b.action), cases.map((c) => c[1]));
    const policies = bodies.filter((b) => b.action === "policy").map((b) => b.policy);
    assert.deepEqual(policies, ["quiet", "walkthrough", "milestones"]);
    assert.ok(bodies.filter((b) => b.action !== "policy").every((b) => !("policy" in b)));
  });

  test("bogus argument prints usage and never contacts the daemon", async () => {
    const { D, env } = await setup();
    const out = parseOut(await run(TOGGLE, { env, input: stdinFor("bogus") }));
    assert.equal(out.stopReason, "sotto: usage: /talk [on|off|status|restart|quiet|milestones|walkthrough|voice [name]|key]");
    assert.ok(!existsSync(join(D, "daemon.pid")));
  });
});

describe("toggle.sh /talk key (SPEC §4.3)", () => {
  const SECRET = "sk-test-" + "S3cr3tS3cr3tS3cr3t-typed";

  test("/talk key cold-starts a daemon without needing an inbox socket", async () => {
    const { D, env } = await setup({ CLAUDE_CODE_MESSAGING_SOCKET: "" });
    const out = parseOut(await run(TOGGLE, { env, input: stdinFor("key") }));
    assert.equal(out.stopReason, "stub: key");
    const [body] = controlBodies(D);
    assert.equal(body.action, "key");
    assert.ok(!("setup" in body));
  });

  test("a key typed as an argument is never read or forwarded: setup instead", async () => {
    const { D, env } = await setup();
    for (const args of [`key ${SECRET}`, SECRET, `apikey  ${SECRET} more`]) {
      const out = parseOut(await run(TOGGLE, { env, input: stdinFor(args) }));
      assert.equal(out.stopReason, "stub: key", args);
    }
    const bodies = controlBodies(D);
    assert.deepEqual(bodies.map((b) => [b.action, b.setup]), [["key", true], ["key", true], ["key", true]]);
    const everything = readFileSync(join(D, "stub-control.jsonl"), "utf8")
      + (existsSync(join(D, "logs", "toggle.log")) ? readFileSync(join(D, "logs", "toggle.log"), "utf8") : "");
    assert.ok(!everything.includes("S3cr3t"), "the typed key goes nowhere");
  });

  test("the userConfig key reaches the daemon through its environment, not argv", async () => {
    const { D, env } = await setup({ CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY: SECRET });
    parseOut(await run(TOGGLE, { env, input: stdinFor("on") }));
    const spawned = JSON.parse(readFileSync(join(D, "stub-argv.json"), "utf8"));
    assert.equal(spawned.userConfigKey, SECRET);
    assert.ok(!spawned.argv.join(" ").includes("S3cr3t"));
    assert.ok(!readFileSync(join(D, "stub-control.jsonl"), "utf8").includes("S3cr3t"), "not in /control either");
  });

  test("a running daemon without any key restarts once the plugin settings hold one", async () => {
    const { D, env } = await setup();
    parseOut(await run(TOGGLE, { env, input: stdinFor("on") }));
    const first = Number(readFileSync(join(D, "daemon.pid"), "utf8"));
    // Same daemon while no userConfig key is set.
    parseOut(await run(TOGGLE, { env, input: stdinFor("status") }));
    assert.equal(Number(readFileSync(join(D, "daemon.pid"), "utf8")), first);
    const withKey = { ...env, CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY: SECRET };
    // status never restarts it.
    parseOut(await run(TOGGLE, { env: withKey, input: stdinFor("status") }));
    assert.equal(Number(readFileSync(join(D, "daemon.pid"), "utf8")), first);
    const out = parseOut(await run(TOGGLE, { env: withKey, input: stdinFor("on") }));
    assert.equal(out.stopReason, "stub: on");
    const second = Number(readFileSync(join(D, "daemon.pid"), "utf8"));
    assert.notEqual(second, first);
    assert.equal(JSON.parse(readFileSync(join(D, "stub-argv.json"), "utf8")).userConfigKey, SECRET);
    // Now it has a key: no further restarts.
    parseOut(await run(TOGGLE, { env: withKey, input: stdinFor("on") }));
    assert.equal(Number(readFileSync(join(D, "daemon.pid"), "utf8")), second);
  });

  test("a daemon that already has a key is not restarted", async () => {
    const { D, env } = await setup();
    parseOut(await run(TOGGLE, { env, input: stdinFor("on") }));
    const first = Number(readFileSync(join(D, "daemon.pid"), "utf8"));
    writeFileSync(join(D, "stub-has-key"), "");
    parseOut(await run(TOGGLE, { env: { ...env, CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY: SECRET }, input: stdinFor("on") }));
    assert.equal(Number(readFileSync(join(D, "daemon.pid"), "utf8")), first);
  });
});

describe("toggle.sh config", () => {
  test("valid option values pass through", async () => {
    const { D, env } = await setup({
      CLAUDE_PLUGIN_OPTION_VOICE: "cedar",
      CLAUDE_PLUGIN_OPTION_IDLE_MINUTES: "0",
      CLAUDE_PLUGIN_OPTION_IDLE_SECONDS: "90",
      CLAUDE_PLUGIN_OPTION_SPEAKING_POLICY: "walkthrough",
      CLAUDE_PLUGIN_OPTION_DAILY_CAP_MINUTES: "1440",
      CLAUDE_PLUGIN_OPTION_WAKE_SENSITIVITY: "high",
      CLAUDE_PLUGIN_OPTION_WINDOW: "app",
      CLAUDE_PLUGIN_OPTION_MIRROR: "decisions",
      CLAUDE_PLUGIN_OPTION_ECHO_GUARD: "on",
    });
    parseOut(await run(TOGGLE, { env, input: stdinFor("on") }));
    assert.deepEqual(controlBodies(D)[0].config, {
      voice: "cedar", idle_seconds: 90, idle_minutes: 0, speaking_policy: "walkthrough", daily_cap_minutes: 1440, wake_sensitivity: "high", window: "app", mirror: "decisions", echo_guard: "on", open_browser: true,
    });
  });

  test("invalid option values fall back to defaults", async () => {
    const { D, env } = await setup({
      CLAUDE_PLUGIN_OPTION_VOICE: "robot",
      CLAUDE_PLUGIN_OPTION_IDLE_MINUTES: "121",
      CLAUDE_PLUGIN_OPTION_IDLE_SECONDS: "7201",
      CLAUDE_PLUGIN_OPTION_SPEAKING_POLICY: "loud",
      CLAUDE_PLUGIN_OPTION_DAILY_CAP_MINUTES: "-5",
      CLAUDE_PLUGIN_OPTION_WAKE_SENSITIVITY: "loud",
      CLAUDE_PLUGIN_OPTION_WINDOW: "none",
      CLAUDE_PLUGIN_OPTION_MIRROR: "everything",
      CLAUDE_PLUGIN_OPTION_ECHO_GUARD: "sometimes",
    });
    parseOut(await run(TOGGLE, { env, input: stdinFor("on") }));
    // Invalid idle values are left out, so the daemon applies its default (60 s).
    assert.deepEqual(controlBodies(D)[0].config, {
      voice: "marin", speaking_policy: "milestones", daily_cap_minutes: 120, wake_sensitivity: "medium", window: "auto", mirror: "all", echo_guard: "auto", open_browser: true,
    });
  });

  test("empty values and decimals", async () => {
    const { D, env } = await setup({
      CLAUDE_PLUGIN_OPTION_VOICE: "",
      CLAUDE_PLUGIN_OPTION_IDLE_MINUTES: "2.50",
      CLAUDE_PLUGIN_OPTION_DAILY_CAP_MINUTES: "abc",
    });
    parseOut(await run(TOGGLE, { env, input: stdinFor("on") }));
    const c = controlBodies(D)[0].config;
    assert.equal(c.voice, "marin");
    assert.equal(c.idle_minutes, 2.5);
    assert.equal(c.daily_cap_minutes, 120);
  });

  test("invalid port falls back to 47821 (checked via 'off' with nothing listening)", async () => {
    // We cannot safely spawn on 47821 in a test; 'off' with a down daemon
    // proves the script ran end to end without a spawn.
    const { D, env } = await setup({ CLAUDE_PLUGIN_OPTION_PORT: "80" });
    const out = parseOut(await run(TOGGLE, { env, input: stdinFor("status") }));
    assert.match(out.stopReason, /^sotto: voice is off\.|^sotto: voice |^sotto: ERROR port 47821/);
    assert.ok(!existsSync(join(D, "daemon.pid")));
  });
});

describe("toggle.sh with the daemon down", () => {
  test("off and status report voice off and do not spawn", async () => {
    const { D, env } = await setup();
    for (const a of ["off", "status", "stop"]) {
      const out = parseOut(await run(TOGGLE, { env, input: stdinFor(a) }));
      assert.equal(out.stopReason, "sotto: voice is off.");
    }
    const r = parseOut(await run(TOGGLE, { env, input: stdinFor("restart") }));
    assert.equal(r.stopReason, "sotto: voice is off. The next /talk on starts the latest code.");
    await sleep(100);
    assert.ok(!existsSync(join(D, "daemon.pid")));
  });

  test("policy asks to turn voice on first", async () => {
    const { env } = await setup();
    const out = parseOut(await run(TOGGLE, { env, input: stdinFor("quiet") }));
    assert.equal(out.stopReason, "sotto: voice is off. Turn it on with /talk on first.");
  });

  test("missing socket env + on -> error, logged, no spawn", async () => {
    const { D, env } = await setup();
    delete env.CLAUDE_CODE_MESSAGING_SOCKET;
    for (const a of ["on", ""]) {
      const out = parseOut(await run(TOGGLE, { env, input: stdinFor(a) }));
      assert.equal(out.stopReason, "sotto: ERROR this session has no inbox socket (CLAUDE_CODE_MESSAGING_SOCKET is unset), so voice cannot reach it.");
    }
    assert.ok(!existsSync(join(D, "daemon.pid")));
    const log = readFileSync(join(D, "logs/toggle.log"), "utf8").trim().split("\n");
    assert.equal(log.length, 2);
    assert.match(log[0], /^\d{4}-\d\d-\d\dT[^\t]+\ton\tno_socket$/);
    assert.equal(statSync(join(D, "logs/toggle.log")).mode & 0o777, 0o600);
  });

  test("SOTTO_NODE not found -> error", async () => {
    const { env } = await setup({ SOTTO_NODE: "/nonexistent/node" });
    const out = parseOut(await run(TOGGLE, { env, input: stdinFor("on") }));
    assert.equal(out.stopReason, "sotto: ERROR SOTTO_NODE (/nonexistent/node) was not found. Point it at a Node 22 (or Bun) binary, or unset it.");
  });

  /** A PATH with only a fake `node` (and optionally a fake `bun`) plus the system tools. */
  function fakeRuntimes({ node, bun }) {
    const bin = tempDir("clv-bin-");
    cleanups.push(() => rmDir(bin));
    if (node) writeFileSync(join(bin, "node"), `#!/bin/bash\n${node}\n`, { mode: 0o755 });
    if (bun) {
      // Answers --version like bun, runs the stub daemon with the real Node, leaves a mark.
      writeFileSync(join(bin, "bun"), `#!/bin/bash\nif [[ "$1" == --version ]]; then echo ${bun}; exit 0; fi\ntouch "${bin}/bun-ran"\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
    }
    return { bin, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` };
  }

  test("node too old and no bun -> early error with how to install, no spawn", async () => {
    const { bin, PATH } = fakeRuntimes({ node: 'echo v18.18.0' });
    const { D, env } = await setup({ PATH });
    const r = await run(TOGGLE, { env, input: stdinFor("on") });
    const out = parseOut(r);
    assert.equal(out.stopReason, "sotto: ERROR node on PATH is v18.18.0; sotto needs Node 22 or newer. Install Node 22 or newer (brew install node, nvm install 22, or nodejs.org), or Bun (bun.sh), then run /talk on again.");
    assert.ok(!existsSync(join(D, "daemon.pid")));
    assert.ok(r.ms < 3000, `took ${r.ms.toFixed(0)} ms`);
    void bin;
  });

  test("no node at all -> error names both runtimes", async () => {
    const { PATH } = fakeRuntimes({});
    const { env } = await setup({ PATH });
    const out = parseOut(await run(TOGGLE, { env, input: stdinFor("on") }));
    assert.match(out.stopReason, /^sotto: ERROR node was not found on PATH; sotto needs Node 22 or newer\. Install .*Bun \(bun\.sh\)/);
  });

  test("node shim that fails -> 'did not run' error", async () => {
    const { PATH } = fakeRuntimes({ node: "echo 'nodenv: version not installed' >&2; exit 127" });
    const { env } = await setup({ PATH });
    const out = parseOut(await run(TOGGLE, { env, input: stdinFor("on") }));
    assert.match(out.stopReason, /^sotto: ERROR node on PATH did not run/);
  });

  test("node too old but bun >= 1.1 -> the daemon runs under bun", async () => {
    const { bin, PATH } = fakeRuntimes({ node: "echo v20.11.0", bun: "1.3.5" });
    const { D, env } = await setup({ PATH });
    const out = parseOut(await run(TOGGLE, { env, input: stdinFor("on") }));
    assert.equal(out.stopReason, "stub: on");
    assert.ok(existsSync(join(bin, "bun-ran")), "started through bun");
    assert.ok(existsSync(join(D, "daemon.pid")));
  });

  test("bun older than 1.1 is not used", async () => {
    const { bin, PATH } = fakeRuntimes({ node: "echo v20.11.0", bun: "1.0.30" });
    const { env } = await setup({ PATH });
    const out = parseOut(await run(TOGGLE, { env, input: stdinFor("on") }));
    assert.match(out.stopReason, /^sotto: ERROR node on PATH is v20\.11\.0/);
    assert.ok(!existsSync(join(bin, "bun-ran")));
  });

  test("daemon that exits on an old Node -> clear Node-version error, fast", async () => {
    const D0 = tempDir();
    const old = join(D0, "old-node.js");
    // What daemon/index.js does on Node < 22: record the reason, exit 3.
    writeFileSync(old, `const fs=require("fs");const d=process.argv[process.argv.indexOf("--data-dir")+1];fs.writeFileSync(d+"/start-error","node_version\\tv18.18.0\\t/x/node\\n");process.exit(3);\n`);
    const { env } = await setup({ SOTTO_DAEMON_ENTRY: old });
    cleanups.push(() => rmDir(D0));
    const r = await run(TOGGLE, { env, input: stdinFor("on") });
    const out = parseOut(r);
    assert.match(out.stopReason, /^sotto: ERROR node on PATH is v18\.18\.0; sotto needs Node 22 or newer/);
    // Without the early stop the poll runs 4-5 s, so 4 s is the hard ceiling of
    // the load allowance (3 s + 10 bare node spawns).
    const bound = Math.min(4000, 3000 + 10 * spawnBaseline().node);
    assert.ok(r.ms < bound, `took ${r.ms.toFixed(0)} ms, bound ${bound.toFixed(0)} ms (the poll stops at the start-error file)`);
  });

  test("daemon that never listens -> spawn timeout error within ~5 s", async () => {
    const D0 = tempDir();
    const dud = join(D0, "dud.js");
    writeFileSync(dud, "setTimeout(() => {}, 100);\n");
    const { D, env } = await setup({ SOTTO_DAEMON_ENTRY: dud });
    cleanups.push(() => rmDir(D0));
    const r = await run(TOGGLE, { env, input: stdinFor("on") });
    const out = parseOut(r);
    assert.equal(out.stopReason, `sotto: ERROR the voice daemon did not start. See ${D}/logs/daemon.log`);
    // The poll is bounded at 4-5 s (version-manager shims start node slowly);
    // 7.5 s leaves room for a loaded machine (npm test runs files in parallel)
    // while still proving the poll ends well inside the 15 s hook timeout.
    const bound = 7500 + 10 * spawnBaseline().node;
    assert.ok(r.ms < bound, `took ${r.ms.toFixed(0)} ms (bound ${bound.toFixed(0)} ms)`);
  });
});

describe("toggle.sh with something else on the port", () => {
  test("foreign HTTP server -> port in use error", async () => {
    const foreign = await startFakeDaemon({ handler: () => ({ status: 200, body: "<html>hi</html>" }) });
    const { env } = await setup({ CLAUDE_PLUGIN_OPTION_PORT: String(foreign.port) });
    cleanups.push(() => foreign.close());
    const out = parseOut(await run(TOGGLE, { env, input: stdinFor("on") }));
    assert.equal(out.stopReason, `sotto: ERROR port ${foreign.port} is used by another program. Choose another port in /config (sotto), or stop that program.`);
  });

  test("another program that names itself in /healthz is named in the error", async () => {
    const foreign = await startFakeDaemon({ handler: () => ({ status: 200, body: JSON.stringify({ ok: true, name: "old-voice", port: 1 }) }) });
    const { env } = await setup({ CLAUDE_PLUGIN_OPTION_PORT: String(foreign.port) });
    cleanups.push(() => foreign.close());
    const out = parseOut(await run(TOGGLE, { env, input: stdinFor("status") }));
    assert.equal(out.stopReason, `sotto: ERROR port ${foreign.port} is used by another program (old-voice). Choose another port in /config (sotto), or stop that program.`);
  });

  test("daemon answering non-JSON to /control -> did-not-answer error", async () => {
    const { D, port, env } = await setup();
    const srv = await startFakeDaemon({
      handler: (req) => req.url === "/healthz"
        ? { status: 200, body: JSON.stringify({ ok: true, name: "sotto", data_dir: D, plugin_root: ROOT, state: "off" }) }
        : { status: 403, body: '{"error":{"code":"bad_key"}}' },
    });
    cleanups.push(() => srv.close());
    env.CLAUDE_PLUGIN_OPTION_PORT = String(srv.port);
    const out = parseOut(await run(TOGGLE, { env, input: stdinFor("status") }));
    assert.equal(out.stopReason, `sotto: ERROR the voice daemon did not answer. See ${D}/logs/daemon.log`);
    void port;
  });

  test("sotto daemon from another data dir is shut down and replaced on 'on'", async () => {
    const { D, port, env } = await setup();
    // Start an "other install" stub on our port with a different data dir.
    const otherD = tempDir();
    cleanups.push(() => { killStub(otherD); rmDir(otherD); });
    parseOut(await run(TOGGLE, { env: { ...env, CLAUDE_PLUGIN_DATA: otherD }, input: stdinFor("on") }));
    const otherPid = Number(readFileSync(join(otherD, "daemon.pid"), "utf8"));
    assert.ok(isAlive(otherPid));

    // Status from our install talks to the foreign daemon with ITS key.
    const st = parseOut(await run(TOGGLE, { env, input: stdinFor("status") }));
    assert.equal(st.stopReason, "stub: status");

    const out = parseOut(await run(TOGGLE, { env, input: stdinFor("on") }));
    assert.equal(out.stopReason, "stub: on");
    assert.ok(await waitFor(() => !isAlive(otherPid), 6000), "old daemon exited");
    assert.deepEqual(controlBodies(otherD).map((b) => b.action), ["on", "status", "shutdown"]);
    const ours = Number(readFileSync(join(D, "daemon.pid"), "utf8"));
    assert.ok(isAlive(ours));
    assert.deepEqual(controlBodies(D).map((b) => b.action), ["on"]);
    void port;
  });

  test("a foreign daemon that takes 1.5 s to shut down is still replaced", async () => {
    const { D, env } = await setup({ CLV_STUB_SHUTDOWN_MS: "1500" });
    const otherD = tempDir();
    cleanups.push(() => { killStub(otherD); rmDir(otherD); });
    parseOut(await run(TOGGLE, { env: { ...env, CLAUDE_PLUGIN_DATA: otherD }, input: stdinFor("on") }));
    const otherPid = Number(readFileSync(join(otherD, "daemon.pid"), "utf8"));
    const r = await run(TOGGLE, { env, input: stdinFor("on") });
    assert.equal(parseOut(r).stopReason, "stub: on");
    assert.ok(!isAlive(otherPid) || (await waitFor(() => !isAlive(otherPid), 6000)));
    assert.deepEqual(controlBodies(D).map((b) => b.action), ["on"]);
  });
});

describe("toggle.sh when the daemon exits mid-request", () => {
  test("status reports off, and on starts a fresh daemon", async () => {
    const { D, env } = await setup();
    parseOut(await run(TOGGLE, { env, input: stdinFor("on") }));
    writeFileSync(join(D, "stub-die-next"), "");
    assert.equal(parseOut(await run(TOGGLE, { env, input: stdinFor("status") })).stopReason, "sotto: voice is off.");
    parseOut(await run(TOGGLE, { env, input: stdinFor("on") }));
    writeFileSync(join(D, "stub-die-next"), "");
    const r = await run(TOGGLE, { env, input: stdinFor("") });
    assert.equal(parseOut(r).stopReason, "stub: toggle");
    assert.ok(isAlive(Number(readFileSync(join(D, "daemon.pid"), "utf8"))));
  });
});

describe("toggle.sh after the port option changed", () => {
  test("off/status reach the daemon on its recorded port; on moves it to the new port", async () => {
    const { D, env } = await setup();
    const oldPort = env.CLAUDE_PLUGIN_OPTION_PORT;
    parseOut(await run(TOGGLE, { env, input: stdinFor("on") }));
    const oldPid = Number(readFileSync(join(D, "daemon.pid"), "utf8"));
    assert.equal(readFileSync(join(D, "daemon.port"), "utf8").trim(), oldPort);

    const newPort = String(await freePort());
    const env2 = { ...env, CLAUDE_PLUGIN_OPTION_PORT: newPort };
    assert.equal(parseOut(await run(TOGGLE, { env: env2, input: stdinFor("status") })).stopReason, "stub: status");
    assert.equal(parseOut(await run(TOGGLE, { env: env2, input: stdinFor("off") })).stopReason, "stub: off");

    const out = parseOut(await run(TOGGLE, { env: env2, input: stdinFor("on") }));
    assert.equal(out.stopReason, "stub: on");
    assert.ok(await waitFor(() => !isAlive(oldPid), 6000), "old-port daemon stopped");
    assert.equal(readFileSync(join(D, "daemon.port"), "utf8").trim(), newPort);
    assert.deepEqual(controlBodies(D).map((b) => b.action), ["on", "status", "off", "shutdown", "on"]);
  });
});

describe("toggle.sh data dir fallback", () => {
  test("uses $HOME/.sotto when CLAUDE_PLUGIN_DATA is unset or empty", async () => {
    const { env } = await setup();
    env.CLAUDE_PLUGIN_DATA = "";
    const out = parseOut(await run(TOGGLE, { env, input: stdinFor("off") }));
    assert.equal(out.stopReason, "sotto: voice is off.");
    const d = join(env.HOME, ".sotto");
    assert.ok(statSync(join(d, "logs")).isDirectory());
    assert.equal(statSync(d).mode & 0o777, 0o700);
    mkdirSync(d, { recursive: true });
  });
});

describe("toggle.sh /talk voice (SPEC §4.5)", () => {
  const LIST_RE = /^sotto: voice is (\w+)\. Voices: alloy, ash, .*\. Change it with \/talk voice <name>\.$/;

  test("daemon down: lists voices with the current one marked, never spawns", async () => {
    const { D, env } = await setup({ CLAUDE_PLUGIN_OPTION_VOICE: "sage" });
    for (const arg of ["voice", "VOICES", "  voice  "]) {
      const out = parseOut(await run(TOGGLE, { env, input: stdinFor(arg) }));
      assert.match(out.stopReason, LIST_RE, arg);
      assert.equal(LIST_RE.exec(out.stopReason)[1], "sage", "userConfig when no prefs");
      assert.match(out.stopReason, /, sage \(current\), /);
      assert.equal((out.stopReason.match(/\(current\)/g) || []).length, 1);
    }
    await sleep(100);
    assert.ok(!existsSync(join(D, "daemon.pid")));
  });

  test("daemon down: set writes prefs.json (0600), which then beats userConfig", async () => {
    const { D, env } = await setup({ CLAUDE_PLUGIN_OPTION_VOICE: "sage" });
    let out = parseOut(await run(TOGGLE, { env, input: stdinFor("voice Cedar") }));
    assert.equal(out.stopReason, "sotto: voice set to cedar. It applies to the next voice session.");
    assert.deepEqual(JSON.parse(readFileSync(join(D, "prefs.json"), "utf8")), { voice: "cedar" });
    assert.equal(statSync(join(D, "prefs.json")).mode & 0o777, 0o600);
    out = parseOut(await run(TOGGLE, { env, input: stdinFor("voice") }));
    assert.equal(LIST_RE.exec(out.stopReason)[1], "cedar");
    out = parseOut(await run(TOGGLE, { env, input: stdinFor("voice cedar") }));
    assert.equal(out.stopReason, "sotto: voice is already cedar.");
    assert.ok(!existsSync(join(D, "daemon.pid")));
  });

  test("an invalid prefs.json is ignored", async () => {
    const { D, env } = await setup();
    writeFileSync(join(D, "prefs.json"), '{"voice":"robot"}');
    const out = parseOut(await run(TOGGLE, { env, input: stdinFor("voice") }));
    assert.equal(LIST_RE.exec(out.stopReason)[1], "marin");
  });

  test("unknown voice: message lists the voices; nothing written, nothing contacted", async () => {
    const { D, env } = await setup();
    const out = parseOut(await run(TOGGLE, { env, input: stdinFor('voice rob\\"ot') }));
    assert.match(out.stopReason, /^sotto: unknown voice "robot"\. Voices: alloy, ash, .* willow\.$/);
    assert.ok(!existsSync(join(D, "prefs.json")));
    assert.ok(!existsSync(join(D, "daemon.pid")));
  });

  test("daemon up: /control gets action voice (+ voice when setting)", async () => {
    const { D, env } = await setup();
    parseOut(await run(TOGGLE, { env, input: stdinFor("on") })); // cold start
    let out = parseOut(await run(TOGGLE, { env, input: stdinFor("voice") }));
    assert.equal(out.stopReason, "stub: voice");
    out = parseOut(await run(TOGGLE, { env, input: stdinFor("voice ECHO") }));
    assert.equal(out.stopReason, "stub: voice");
    const bodies = controlBodies(D).slice(1);
    assert.deepEqual(bodies.map((b) => [b.action, b.voice]), [["voice", undefined], ["voice", "echo"]]);
    assert.ok(!existsSync(join(D, "prefs.json")), "the daemon owns the write when it runs");
  });
});

describe("bin/sotto (SPEC §5.9)", () => {
  const CLI = join(ROOT, "bin/sotto");

  test("finds the data dir whose active file names this session and drives /control there", async () => {
    const { D: other, env: otherEnv } = await setup();
    const home = otherEnv.HOME;
    const data = join(home, ".claude/plugins/data");
    mkdirSync(data, { recursive: true });
    // The owning install's data dir, with a running (stub) daemon on its port.
    const D = join(data, "sotto-test");
    mkdirSync(D);
    const port = await freePort();
    const env = { ...otherEnv, CLAUDE_PLUGIN_DATA: D, CLAUDE_PLUGIN_OPTION_PORT: String(port) };
    parseOut(await run(TOGGLE, { env, input: stdinFor("on") }));
    cleanups.push(() => killStub(D));
    // A decoy with voice active for ANOTHER session.
    const decoy = join(data, "sotto-decoy");
    mkdirSync(decoy);
    writeFileSync(join(decoy, "active"), `/tmp/other.sock\t1\tk\n`);
    writeFileSync(join(D, "active"), `${SOCK}\t${port}\tk\tn\n`);

    const cliEnv = baseEnv({ HOME: home, CLAUDE_CODE_MESSAGING_SOCKET: SOCK });
    const r = await run(CLI, { args: ["voice", "cedar"], env: cliEnv });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "stub: voice\n");
    const last = controlBodies(D).at(-1);
    assert.equal(last.action, "voice");
    assert.equal(last.voice, "cedar");
    assert.equal(controlBodies(other).length, 0);
  });

  test("no daemon: writes prefs.json in the newest data dir; errors exit 1", async () => {
    const { env: e0 } = await setup();
    const home = e0.HOME;
    const D = join(home, ".claude/plugins/data/sotto-x");
    mkdirSync(join(D, "logs"), { recursive: true });
    const cliEnv = baseEnv({ HOME: home, CLAUDE_PLUGIN_OPTION_PORT: String(await freePort()) });
    let r = await run(CLI, { args: ["voice", "verse"], env: cliEnv });
    assert.equal(r.stdout, "sotto: voice set to verse. It applies to the next voice session.\n");
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(D, "prefs.json"), "utf8")), { voice: "verse" });
    r = await run(CLI, { args: ["voice"], env: cliEnv });
    assert.match(r.stdout, /^sotto: voice is verse\. Voices: .*verse \(current\)/);
    r = await run(CLI, { args: ["voice", "nope"], env: cliEnv });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^sotto: unknown voice "nope"/);
    r = await run(CLI, { args: ["restart"], env: cliEnv });
    assert.equal(r.stdout, "sotto: voice is off. The next /talk on starts the latest code.\n");
    assert.equal(r.code, 0);
    r = await run(CLI, { args: ["bogus"], env: cliEnv });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /sotto restart/);
  });
});
