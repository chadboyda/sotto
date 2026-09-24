// Helpers for driving scripts/*.sh from node:test with fake stdin and env.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const HOOK = join(ROOT, "scripts/hook.sh");
export const TOGGLE = join(ROOT, "scripts/toggle.sh");

/** Fresh temp dir (realpath, so /var -> /private/var does not bite comparisons). */
export function tempDir(prefix = "clv-test-") {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function rmDir(d) {
  try { rmSync(d, { recursive: true, force: true }); } catch {}
}

/**
 * Minimal, hermetic env: nothing from the developer's shell leaks in
 * (no real CLAUDE_* vars, HOME points at a temp dir).
 */
let sharedHome = null;
function testHome() {
  if (!sharedHome) {
    // One temp HOME per test process, removed at exit (not one per call, which
    // used to leave a dozen empty clv-home-* dirs behind per run).
    sharedHome = tempDir("clv-home-");
    process.once("exit", () => rmDir(sharedHome));
  }
  return sharedHome;
}

export function baseEnv(extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: extra.HOME ?? testHome(),
    ...extra,
  };
}

/** Run a script asynchronously; resolves when it exits AND its stdio closes. */
export function run(script, { args = [], env = {}, input = "" } = {}) {
  return new Promise((resolvePromise, reject) => {
    const t0 = performance.now();
    const child = spawn(script, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.stdin.on("error", () => {}); // EPIPE when the script ignores stdin
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr, ms: performance.now() - t0, pid: child.pid }));
    child.stdin.end(input);
  });
}

/** Synchronous variant used for timing the gated-off path. */
export function runSync(script, { args = [], env = {}, input = "" } = {}) {
  const t0 = performance.now();
  const r = spawnSync(script, args, { env, input, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, ms: performance.now() - t0, error: r.error };
}

/** A currently free loopback port. */
export function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll fn() until truthy or timeout; returns the last value. */
export async function waitFor(fn, timeoutMs = 3000, stepMs = 25) {
  const end = Date.now() + timeoutMs;
  let v;
  while (Date.now() < end) {
    v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  return v;
}

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
