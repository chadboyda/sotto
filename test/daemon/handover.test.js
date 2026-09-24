// Self-update, process side (SPEC §6.17): real daemon processes on a temp
// copy of the plugin. /control restart swaps to a successor on the same port
// with the same key and owner; broken code never takes voice down. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readHandover, listenWithRetry } from "../../daemon/handover.js";
import { freePort } from "../helpers/daemon-harness.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, every = 50) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() > end) return null;
    await sleep(every);
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("readHandover: JSON until EOF; wrong version, bad JSON or no EOF → null", async () => {
  const s1 = new PassThrough();
  const p1 = readHandover(s1);
  s1.write('{"v":1,"daemon_key":"k",');
  s1.end('"page_token":"t"}');
  assert.deepEqual(await p1, { v: 1, daemon_key: "k", page_token: "t" });
  const s2 = new PassThrough();
  const p2 = readHandover(s2);
  s2.end('{"v":2}');
  assert.equal(await p2, null);
  const s3 = new PassThrough();
  const p3 = readHandover(s3);
  s3.end("not json");
  assert.equal(await p3, null);
  const s4 = new PassThrough();
  assert.equal(await readHandover(s4, 50), null);
});

test("listenWithRetry retries only EADDRINUSE", async () => {
  let n = 0;
  assert.equal(await listenWithRetry(async () => { if (++n < 3) throw Object.assign(new Error("x"), { code: "EADDRINUSE" }); return 7; }, { delayMs: 1 }), 7);
  assert.equal(n, 3);
  await assert.rejects(listenWithRetry(async () => { throw Object.assign(new Error("x"), { code: "EACCES" }); }, { delayMs: 1 }), /x/);
  await assert.rejects(listenWithRetry(async () => { throw Object.assign(new Error("y"), { code: "EADDRINUSE" }); }, { tries: 2, delayMs: 1 }), /y/);
});

/** A temp plugin root (sources only, no .env), a data dir, a fake inbox socket. */
async function plugin(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clv-ho-")));
  for (const d of ["daemon", "web", "scripts"]) fs.cpSync(path.join(REPO, d), path.join(root, d), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(root, "package.json"));
  const D = path.join(root, "data");
  const sock = path.join(root, "in.sock");
  const srv = net.createServer((c) => c.destroy());
  await new Promise((r) => srv.listen(sock, r));
  const port = await freePort();
  const env = { PATH: process.env.PATH, HOME: root, SOTTO_NO_BROWSER: "1", SOTTO_VOCAB: "0", SOTTO_KEYCHAIN: "0" };
  const ctx = { root, D, sock, port, env, base: `http://127.0.0.1:${port}` };
  ctx.pid = () => { try { return Number(fs.readFileSync(path.join(D, "daemon.pid"), "utf8").trim()); } catch { return null; } };
  ctx.key = () => fs.readFileSync(path.join(D, "daemon.key"), "utf8").trim();
  ctx.health = async () => (await fetch(`${ctx.base}/healthz`, { signal: AbortSignal.timeout(500) })).json();
  ctx.control = async (body) => (await fetch(`${ctx.base}/control`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Sotto-Key": ctx.key() }, body: JSON.stringify(body),
  })).json();
  ctx.log = () => fs.readFileSync(path.join(D, "logs", "daemon.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  t.after(async () => {
    const pid = ctx.pid();
    try { await ctx.control({ action: "shutdown" }); } catch { /* gone */ }
    await until(() => !pid || !alive(pid), 4000);
    if (pid && alive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  ctx.start = async () => {
    const c = spawn(process.execPath, [path.join(root, "daemon/index.js"), "--port", String(port), "--data-dir", D, "--plugin-root", root],
      { cwd: root, env, detached: true, stdio: "ignore" });
    c.unref();
    assert.ok(await until(() => ctx.health(), 5000), "daemon answers");
    // Bind an owner. No API key in this tree, so it waits in `paused` (quiet).
    const r = await ctx.control({ action: "on", session: { socket: sock, token: "tok-secret-1", cwd: root, session_id: "s1" }, config: { open_browser: false } });
    assert.equal(r.state, "paused");
  };
  return ctx;
}

test("/control restart: a successor takes the same port, key, owner and marker; the old process exits", async (t) => {
  const c = await plugin(t);
  await c.start();
  const pid1 = c.pid();
  const key1 = c.key();
  const active1 = fs.readFileSync(path.join(c.D, "active"), "utf8");
  const r = await c.control({ action: "restart" });
  assert.equal(r.message, "sotto: restarting the voice daemon now. Voice picks up where it left off.");
  const h = await until(async () => { const x = await c.health(); return x.pid !== pid1 ? x : null; }, 8000);
  assert.ok(h, "a new process answers");
  assert.equal(h.port, c.port);
  assert.equal(h.state, "paused");
  assert.ok(await until(() => !alive(pid1), 3000), "the old process exited");
  assert.equal(c.pid(), h.pid);
  assert.equal(c.key(), key1, "same key: hook.sh and toggle.sh keep working");
  assert.equal(fs.readFileSync(path.join(c.D, "active"), "utf8"), active1, "D/active untouched");
  const st = await (await fetch(`${c.base}/status`, { headers: { "X-Sotto-Key": key1 } })).json();
  assert.equal(st.owner.session_id, "s1");
  const ev = c.log();
  const ho = ev.find((e) => e.ev === "update.handover");
  assert.ok(ho && ho.gap_ms < 2000, `gap ${ho?.gap_ms} ms`);
  assert.ok(ev.some((e) => e.ev === "update.started" && e.parent_pid === pid1));
  const raw = fs.readFileSync(path.join(c.D, "logs", "daemon.log"), "utf8");
  assert.ok(!raw.includes("tok-secret-1") && !raw.includes(key1), "no inbox token or key in the log");
  assert.ok(!fs.readdirSync(c.D).some((f) => /handover/.test(f)), "the handover never touches disk");
});

test("the userConfig API key crosses the handover in memory (SPEC §4.3)", async (t) => {
  const c = await plugin(t);
  const uc = "sk-test-" + "H".repeat(24) + "hand";
  c.env.CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY = uc;
  const child = spawn(process.execPath, [path.join(c.root, "daemon/index.js"), "--port", String(c.port), "--data-dir", c.D, "--plugin-root", c.root],
    { cwd: c.root, env: c.env, detached: true, stdio: "ignore" });
  child.unref();
  const h0 = await until(() => c.health(), 5000);
  assert.equal(h0.api_key, true);
  // A bound owner that is quiet: the key is there, so voice waits for its page.
  const on = await c.control({ action: "on", session: { socket: c.sock, token: "tok-secret-2", cwd: c.root, session_id: "s2" }, config: { open_browser: false } });
  assert.equal(on.state, "waiting_page");
  // Pause it like the page would (a restart waits for paused, sleeping or quiet live).
  const secret = fs.readFileSync(path.join(c.D, "page.secret"), "utf8").trim();
  const boot = await (await fetch(`${c.base}/api/bootstrap`, { headers: { "X-Sotto-Boot": secret } })).json();
  await fetch(`${c.base}/api/page`, { method: "POST", headers: { "Content-Type": "application/json", "X-Sotto-Page": boot.page_token }, body: '{"type":"pause"}' });
  assert.ok(await until(async () => (await c.health()).state === "paused", 3000), "paused");
  const pid1 = c.pid();
  await c.control({ action: "restart" });
  const h = await until(async () => { const x = await c.health(); return x.pid !== pid1 ? x : null; }, 8000);
  assert.ok(h, "a new process answers");
  assert.equal(h.api_key, true, "the successor still has the userConfig key");
  const st = await (await fetch(`${c.base}/status`, { headers: { "X-Sotto-Key": c.key() } })).json();
  assert.equal(st.api_key.source, "user_config");
  const ps = (await import("node:child_process")).execFileSync("ps", ["-E", "-o", "command=", "-p", String(h.pid)], { encoding: "utf8" });
  assert.ok(!ps.includes(uc), "not in the successor's argv or environment");
  const raw = fs.readFileSync(path.join(c.D, "logs", "daemon.log"), "utf8");
  assert.ok(!raw.includes(uc), "not in the log");
});

test("broken new code: the preflight fails and the running daemon carries on", async (t) => {
  const c = await plugin(t);
  await c.start();
  const pid1 = c.pid();
  fs.appendFileSync(path.join(c.root, "daemon/format.js"), "\nexport const broken = (;\n");
  await c.control({ action: "restart" });
  const failed = await until(() => c.log().find((e) => e.ev === "update.failed"), 8000);
  assert.ok(failed, "gave up");
  assert.equal(failed.code, "preflight");
  const pre = c.log().find((e) => e.ev === "update.preflight");
  assert.match(pre.message, /SyntaxError|Unexpected/);
  assert.doesNotMatch(pre.message, /\x1b\[/, "no terminal colors in the log");
  const h = await c.health();
  assert.equal(h.pid, pid1, "same process, still serving");
  assert.equal(h.state, "paused");
});

test("a successor that dies after the preflight: the old daemon listens again", async (t) => {
  const c = await plugin(t);
  await c.start();
  const pid1 = c.pid();
  // Loads fine (preflight passes) but exits when started as a successor.
  fs.appendFileSync(path.join(c.root, "daemon/index.js"), '\nif (process.argv.includes("--handover")) process.exit(9);\n');
  await c.control({ action: "restart" });
  const failed = await until(() => c.log().find((e) => e.ev === "update.successor_failed"), 8000);
  assert.ok(failed);
  assert.equal(failed.code, "successor_exit");
  const h = await until(() => c.health(), 3000);
  assert.equal(h.pid, pid1);
  assert.equal(c.pid(), pid1, "pid file points at the survivor again");
  assert.ok(c.log().some((e) => e.ev === "update.abort"));
});
