// Process-level checks of daemon/index.js: args, pid/key files, single
// instance, stale-file cleanup, SIGTERM cleanup. No network beyond loopback.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpDir, freePort, makePluginRoot } from "../helpers/daemon-harness.js";

const ENTRY = fileURLToPath(new URL("../../daemon/index.js", import.meta.url));
const homes = [];
after(() => { for (const d of homes) fs.rmSync(d, { recursive: true, force: true }); });
const envNoKey = () => {
  const home = tmpDir("clv-home-");
  homes.push(home);
  // A Keychain service nobody uses, so a key the user saved never leaks in.
  const e = { ...process.env, HOME: home, SOTTO_BROWSER: "none", SOTTO_KEYCHAIN_SERVICE: `sotto-test-none-${process.pid}` };
  delete e.OPENAI_API_KEY;
  delete e.CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY;
  return e;
};

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("missing args → exit 2", () => {
  const r = spawnSync(process.execPath, [ENTRY, "--port", "1"], { encoding: "utf8" });
  assert.equal(r.status, 2);
});

test("start: pid/key files, stale cleanup, healthz, single instance, SIGTERM cleanup", async (t) => {
  const D = tmpDir("clv-d-");
  const root = makePluginRoot();
  const port = await freePort();
  fs.writeFileSync(path.join(D, "active"), "stale\t1\tk\n");
  fs.writeFileSync(path.join(D, "pending-context"), "");
  const child = spawn(process.execPath, [ENTRY, "--port", String(port), "--data-dir", D, "--plugin-root", root], { stdio: "ignore", env: envNoKey() });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } fs.rmSync(D, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); });

  const health = await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).json());
  assert.equal(health.name, "sotto");
  assert.equal(health.data_dir, D);
  assert.equal(health.pid, child.pid);
  assert.equal(fs.readFileSync(path.join(D, "daemon.pid"), "utf8"), `${child.pid}\n`);
  const key = fs.readFileSync(path.join(D, "daemon.key"), "utf8");
  assert.match(key, /^[0-9a-f]{64}\n$/);
  assert.equal(fs.statSync(path.join(D, "daemon.key")).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(D, "active")), "stale active removed");
  assert.ok(!fs.existsSync(path.join(D, "pending-context")), "stale pending-context removed");

  // A second daemon for the same data dir refuses to start.
  const second = spawnSync(process.execPath, [ENTRY, "--port", String(port + 1), "--data-dir", D, "--plugin-root", root], { env: envNoKey(), timeout: 5000 });
  assert.equal(second.status, 1);
  assert.equal(fs.readFileSync(path.join(D, "daemon.key"), "utf8"), key, "key untouched by the refused instance");

  // Bind an owner, then SIGTERM: active and pid are removed.
  const ctl = await fetch(`http://127.0.0.1:${port}/control?format=hook`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Sotto-Key": key.trim() },
    body: JSON.stringify({ action: "on", session: { socket: "/tmp/clv-none.sock", token: "t", cwd: "/x/proj" }, config: { open_browser: false } }),
  });
  const cj = await ctl.json();
  assert.equal(cj.continue, false);
  assert.match(cj.stopReason, process.platform === "darwin" ? /no OpenAI API key yet\. Run \/talk key to add it\./ : /OPENAI_API_KEY was not found/);
  assert.ok(fs.existsSync(path.join(D, "active")));
  child.kill("SIGTERM");
  const code = await new Promise((r) => child.once("exit", (c) => r(c)));
  assert.equal(code, 0);
  assert.ok(!fs.existsSync(path.join(D, "active")));
  assert.ok(!fs.existsSync(path.join(D, "daemon.pid")));
  const log = fs.readFileSync(path.join(D, "logs", "daemon.log"), "utf8");
  assert.match(log, /"ev":"start"/);
  assert.match(log, /"ev":"exit"/);
  assert.ok(!log.includes(key.trim()), "daemon key never logged");
});

test("EADDRINUSE → exit 1", async (t) => {
  const D = tmpDir("clv-d-");
  const root = makePluginRoot();
  const port = await freePort();
  const net = await import("node:net");
  const blocker = net.createServer().listen(port, "127.0.0.1");
  await new Promise((r) => blocker.once("listening", r));
  t.after(() => { blocker.close(); fs.rmSync(D, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); });
  const r = spawnSync(process.execPath, [ENTRY, "--port", String(port), "--data-dir", D, "--plugin-root", root], { env: envNoKey(), timeout: 5000 });
  assert.equal(r.status, 1);
  assert.ok(!fs.existsSync(path.join(D, "daemon.pid")));
});

test("createDaemon().listen() records the bound port in D/daemon.port (0600)", async () => {
  const { createDaemon } = await import("../../daemon/index.js");
  const D = tmpDir("clv-d-");
  const port = await freePort();
  const d = createDaemon({ dataDir: D, port, pluginRoot: makePluginRoot(), env: { SOTTO_BROWSER: "none", SOTTO_KEYCHAIN: "0" }, daemonKey: "k".repeat(64) });
  try {
    assert.ok(!fs.existsSync(path.join(D, "daemon.port")), "not written before listening");
    assert.equal(await d.listen(), port);
    const f = path.join(D, "daemon.port");
    assert.equal(fs.readFileSync(f, "utf8").trim(), String(port));
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  } finally {
    await d.close();
    fs.rmSync(D, { recursive: true, force: true });
  }
});
