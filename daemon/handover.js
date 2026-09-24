// Process swap for self-update (SPEC §6.17). The running daemon checks that
// the new code loads (preflight), closes its Live session, stops listening and
// spawns its successor detached, handing it the state over a stdin pipe (it
// holds the inbox token, so it is never written to disk or put on a command
// line). The successor binds the same port with the same daemon key and page
// token, so D/active, the hooks and the page's credentials stay valid. The old
// process exits only once the successor answers /healthz; if it never does,
// the old one listens again and carries on.
import fs from "node:fs";
import path from "node:path";
import { spawn as defaultSpawn, execFile as defaultExecFile } from "node:child_process";
import { writePid } from "./statefiles.js";

/** Upper bound for the successor to answer /healthz (a cold `node` via a version-manager shim can take ~1 s). */
export const SUCCESSOR_TIMEOUT_MS = 10_000;
const PREFLIGHT_TIMEOUT_MS = 15_000;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
/**
 * A child's error output, condensed for the log: the error line itself (Node
 * prints the failing file:line first and "SyntaxError: …" after the source
 * excerpt, with the stack last) plus the first line, which names the file.
 */
function tail(s) {
  const lines = String(s || "").replace(ANSI, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const err = lines.find((l) => /^\w*Error\b|^error:/i.test(l));
  const picked = err ? [...new Set([lines[0], err])] : lines.slice(-3);
  return picked.join(" | ").slice(0, 400);
}

/**
 * Load the new code in a throwaway process (`--preflight` imports every daemon
 * module and exits 0) so a half-saved file never takes voice down.
 */
export function preflight({ execPath = process.execPath, entry, cwd, execFile = defaultExecFile, timeoutMs = PREFLIGHT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
    execFile(execPath, [entry, "--preflight"], { cwd, env, timeout: timeoutMs, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      const ms = Date.now() - t0;
      if (err) resolve({ ok: false, ms, code: "preflight", message: tail(stderr || err.message) });
      else resolve({ ok: true, ms });
    });
  });
}

/** Read the handover JSON from a stream (the successor's stdin) until EOF. Null on timeout or bad JSON. */
export function readHandover(stream, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); resolve(v); };
    const t = setTimeout(() => finish(null), timeoutMs);
    stream.on("data", (c) => chunks.push(Buffer.from(c)));
    stream.on("end", () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        finish(v && typeof v === "object" && v.v === 1 ? v : null);
      } catch { finish(null); }
    });
    stream.on("error", () => finish(null));
  });
}

/** listen(), retrying while the port is still held (the old process closing its socket). */
export async function listenWithRetry(listen, { tries = 100, delayMs = 50 } = {}) {
  for (let i = 0; ; i++) {
    try { return await listen(); } catch (e) {
      if (e?.code !== "EADDRINUSE" || i >= tries) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/** Poll /healthz until the process `pid` answers on `port`. */
async function waitForHealthz({ port, pid, until, exited, fetchImpl = globalThis.fetch }) {
  while (Date.now() < until) {
    if (exited()) return false;
    try {
      const r = await fetchImpl(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(300) });
      const h = await r.json();
      if (h && h.name === "sotto" && h.pid === pid) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
}

/**
 * Spawn the successor: detached, stdin = the handover (then EOF), stdout
 * ignored, stderr to D/logs/successor.err (read back if it fails to start).
 * Resolves {ok, pid, ms} once it answers /healthz, or {ok:false, code, message}.
 */
export async function spawnSuccessor({
  execPath = process.execPath, entry, args, cwd, env = process.env, payload, port, errFile,
  spawn = defaultSpawn, timeoutMs = SUCCESSOR_TIMEOUT_MS, fetchImpl,
}) {
  const t0 = Date.now();
  let errFd = "ignore";
  try { errFd = fs.openSync(errFile, "w", 0o600); } catch { /* logs dir unwritable */ }
  let child;
  try {
    child = spawn(execPath, [entry, ...args], { cwd, env, detached: true, stdio: ["pipe", "ignore", errFd] });
  } catch (e) {
    if (typeof errFd === "number") fs.closeSync(errFd);
    return { ok: false, code: "spawn", message: String(e && e.message) };
  }
  if (typeof errFd === "number") fs.closeSync(errFd);
  let exit = null;
  child.on("exit", (code, signal) => { exit = { code, signal }; });
  child.on("error", (e) => { exit = { code: -1, signal: null, message: String(e && e.message) }; });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(payload));
  const ok = await waitForHealthz({ port, pid: child.pid, until: t0 + timeoutMs, exited: () => !!exit, fetchImpl });
  if (ok) {
    child.unref();
    return { ok: true, pid: child.pid, ms: Date.now() - t0 };
  }
  try { child.kill("SIGKILL"); } catch { /* gone */ }
  let message = "";
  try { message = tail(fs.readFileSync(errFile, "utf8")); } catch { /* none */ }
  return { ok: false, code: exit ? "successor_exit" : "successor_timeout", exit, message, ms: Date.now() - t0 };
}

/**
 * The whole swap, from the running daemon's side. `d` is createDaemon()'s
 * result; `exit({handover})` ends this process: after a successful swap
 * (leave D/active and the pid file to the successor), or when this process
 * could not listen again (a normal exit that cleans up).
 * Returns {ok:false, code} when it did not happen (this process carries on).
 */
export async function performRestart({
  d, reason, from, to, quietMs, entry, pluginRoot, dataDir, port, log, exit,
  execPath = process.execPath, spawn, execFile, fetchImpl, timeoutMs,
}) {
  const t0 = Date.now();
  const pre = await preflight({ execPath, entry, cwd: pluginRoot, execFile });
  log.info("update.preflight", { ok: pre.ok, ms: pre.ms, message: pre.message || undefined });
  if (!pre.ok) return { ok: false, code: "preflight" };
  // The preflight took a moment: still quiet?
  const why = d.voice.restartBlocker(quietMs);
  if (why) return { ok: false, code: "not_quiet", why };

  const prep = await d.voice.prepareRestart(reason);
  const tPrep = Date.now();
  const payload = {
    v: 1, reason, parent_pid: process.pid, from: from?.all || null, to: to?.all || null,
    web_changed: !!(from && to && from.web !== to.web),
    daemon_key: d.daemonKey, page_token: d.pageToken, voice: d.voice.snapshot(prep),
    // The userConfig API key lives only in the daemon's memory (SPEC §4.3):
    // the successor gets it over this pipe, never argv or the environment.
    user_config_key: d.keys?.userConfigKey || null,
  };
  d.stopListening();
  d.server.closeAllConnections?.();
  const tStop = Date.now();
  const r = await spawnSuccessor({
    execPath, entry, cwd: pluginRoot, payload, port, spawn, fetchImpl, timeoutMs,
    args: ["--port", String(port), "--data-dir", dataDir, "--plugin-root", pluginRoot, "--handover"],
    errFile: path.join(d.paths.logs, "successor.err"),
  });
  if (r.ok) {
    log.info("update.handover", {
      reason, to: to?.all || null, pid: r.pid, preflight_ms: pre.ms, prepare_ms: tPrep - t0 - pre.ms,
      gap_ms: Date.now() - tStop, total_ms: Date.now() - t0, resume: prep.resume,
    });
    d.updater?.stop();
    d.voice.dispose();
    exit({ handover: true });
    return { ok: true };
  }
  log.error("update.successor_failed", { code: r.code, ms: r.ms, message: r.message || undefined, exit: r.exit || undefined });
  try {
    await listenWithRetry(() => d.listen(), { tries: 40 });
  } catch (e) {
    // Someone else took the port meanwhile: nothing can reach this process.
    log.error("update.relisten_failed", { code: e?.code || null });
    exit({ handover: false });
    return { ok: false, code: "relisten" };
  }
  // The successor may have written its pid before failing.
  try { writePid(d.paths); } catch { /* data dir unwritable */ }
  d.voice.abortRestart(prep);
  return { ok: false, code: r.code };
}
