#!/usr/bin/env node
// sotto daemon entry (SPEC §6.2).
//   node daemon/index.js --port <n> --data-dir <D> --plugin-root <ROOT>
// Exports createDaemon() for tests; runs main() only when executed directly.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveApiKey, VERSION } from "./config.js";
import { dataPaths } from "./paths.js";
import { writePid, writeKey, writePort, writeAtomic, removeQuiet } from "./statefiles.js";
import { createLogger } from "./log.js";
import { SseHub } from "./sse.js";
import { Voice } from "./voice.js";
import { createHttpServer } from "./http.js";
import { createWindow } from "./window.js";
import * as inboxModule from "./inbox.js";
import { WebSocketImpl as DefaultWS } from "./ws.js";

const LAUNCH_CODE_TTL_MS = 2 * 60_000;

export const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  setInterval: (fn, ms) => { const h = setInterval(fn, ms); h.unref?.(); return h; },
  clearInterval: (h) => clearInterval(h),
};

/**
 * The page secret gates GET /api/bootstrap (which hands out the page token).
 * It reaches the page only in the URL fragment of the window the daemon opens
 * (never sent over HTTP, not visible to other users' `ps`), and persists in
 * D/page.secret (0600) so a page can re-bootstrap after a daemon restart.
 */
export function loadPageSecret(paths) {
  try {
    const s = fs.readFileSync(paths.pageSecret, "utf8").trim();
    if (/^[0-9a-f]{32,}$/.test(s)) return s;
  } catch { /* missing: create */ }
  const s = randomBytes(24).toString("hex");
  try { writeAtomic(paths.pageSecret, `${s}\n`); } catch { /* data dir unwritable: in-memory only */ }
  return s;
}

/** Node 22+ is required (global WebSocket, used by the zero-dependency sideband). */
export function nodeProblem(versions = process.versions, WS = globalThis.WebSocket) {
  const major = Number(String(versions.node || "0").split(".")[0]);
  if (!(major >= 22)) return `Node ${versions.node} is too old; sotto needs Node 22 or newer`;
  if (typeof WS !== "function") return `Node ${versions.node} has no global WebSocket`;
  return null;
}

/**
 * Build a daemon without listening or touching pid/key files.
 * Returns {server, voice, sse, daemonKey, pageToken, pageSecret, paths, listen(), stopListening(), close()}.
 */
export function createDaemon({
  dataDir, port, pluginRoot, env = process.env, clock = realClock, fetchImpl = globalThis.fetch,
  WebSocketImpl = DefaultWS, inbox = inboxModule, chrome, log, daemonKey, pageToken, pageSecret, onExit, owner, execFile,
}) {
  const paths = dataPaths(dataDir);
  fs.mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  const logger = log || createLogger({ dir: paths.logs, debug: env.SOTTO_DEBUG === "1" });
  const key = daemonKey || randomBytes(32).toString("hex");
  const token = pageToken || randomBytes(16).toString("hex");
  const secret = pageSecret || loadPageSecret(paths);
  // One-time launch codes for window URLs (see chrome.js): code → expiry.
  const launchCodes = new Map();
  const issueLaunchCode = () => {
    const now = clock.now();
    for (const [c, exp] of launchCodes) if (exp <= now) launchCodes.delete(c);
    const code = randomBytes(16).toString("hex");
    launchCodes.set(code, now + LAUNCH_CODE_TTL_MS);
    return code;
  };
  const redeemLaunchCode = (code) => {
    const exp = typeof code === "string" ? launchCodes.get(code) : undefined;
    if (exp === undefined) return false;
    launchCodes.delete(code); // single use
    return exp > clock.now();
  };
  let voice;
  const sse = new SseHub({ clock, onChange: () => voice && voice.changed() });
  // Desktop app, Chrome --app window, or default browser (SPEC §6.16).
  const chromeApi = chrome || createWindow({
    dataDir, port, pluginRoot, env, log: logger, launchCode: issueLaunchCode, clock,
    getPreference: () => voice?.config?.window,
    pageConnected: () => sse.count > 0,
    wantsWindow: () => !!voice && voice.config.open_browser !== false && sse.count === 0
      && (voice.state === "waiting_page" || voice.state === "reconnecting"),
  });
  voice = new Voice({
    paths, port, pluginRoot, daemonKey: key, env, clock, fetchImpl, WebSocketImpl, inbox, chrome: chromeApi, log: logger,
    getApiKey: () => resolveApiKey({ env, pluginRoot, dataDir }), sse, onExit: (r) => onExit?.(r), owner, execFile,
  });
  let listening = false;
  // After a `shutdown` control is answered, stop accepting connections at once
  // so /healthz goes quiet and the port frees for the next daemon while the
  // Live/window teardown finishes (open SSE streams stay up for close_window).
  const stopListening = () => {
    if (!listening) return;
    listening = false;
    try { server.close(); } catch { /* not listening */ }
    server.closeIdleConnections?.();
    logger.info("listen.stop", { port });
  };
  const server = createHttpServer({
    voice, port, daemonKey: key, pageToken: token, pageSecret: secret, redeemLaunchCode, webDir: path.join(pluginRoot, "web"), sse, log: logger,
    onControlAnswered: (action) => { if (action === "shutdown") setImmediate(stopListening); },
  });

  return {
    server, voice, sse, paths, daemonKey: key, pageToken: token, pageSecret: secret, issueLaunchCode, log: logger, stopListening,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          listening = true;
          const bound = server.address().port;
          // D/daemon.port: toggle.sh finds a moved port with it, and the desktop
          // app only trusts a sotto://open URL whose port matches it
          // (any web page can fire that URL; SPEC §6.16).
          try { writePort(paths, bound); } catch { /* data dir unwritable */ }
          resolve(bound);
        });
      });
    },
    close() {
      voice.dispose();
      sse.close();
      listening = false;
      return new Promise((resolve) => {
        server.close(() => resolve()); // the callback also runs (with an error) if already closed
        server.closeAllConnections?.();
      });
    },
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--data-dir") out.dataDir = argv[++i];
    else if (a === "--plugin-root") out.pluginRoot = argv[++i];
  }
  return out;
}

/** Is another daemon (same data dir) alive? Checks the pid and its command line. */
function otherDaemonAlive(pidFile) {
  let pid;
  try { pid = Number(fs.readFileSync(pidFile, "utf8").trim()); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== "EPERM") return false; }
  try {
    const args = execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
    return args.includes("daemon/index.js");
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.port || !Number.isInteger(args.port) || !args.dataDir || !args.pluginRoot) {
    process.stderr.write("usage: node daemon/index.js --port <n> --data-dir <D> --plugin-root <ROOT>\n");
    process.exit(2);
  }
  const paths = dataPaths(args.dataDir);
  fs.mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(args.dataDir, 0o700); } catch { /* ignore */ }
  const log = createLogger({ dir: paths.logs, debug: process.env.SOTTO_DEBUG === "1" });

  // toggle.sh spawns `node` from PATH; a version manager may pick an old Node.
  // Fail now, with a reason toggle.sh can report, not later in the sideband.
  const problem = nodeProblem();
  if (problem) {
    log.error("start.node", { message: problem, node: process.version, exec: process.execPath });
    try { writeAtomic(paths.startError, `node_version\t${process.version}\t${process.execPath}\n`); } catch { /* ignore */ }
    process.exit(3);
  }
  removeQuiet(paths.startError);

  if (otherDaemonAlive(paths.pid)) {
    log.warn("start.refused", { reason: "another daemon is running for this data dir" });
    process.exit(1);
  }
  // Stale state from a previous run.
  removeQuiet(paths.active);
  removeQuiet(paths.pendingContext);

  const daemonKey = randomBytes(32).toString("hex");
  writePid(paths);
  writeKey(paths, daemonKey);

  let exiting = false;
  const d = createDaemon({
    dataDir: args.dataDir, port: args.port, pluginRoot: args.pluginRoot, daemonKey, log,
    onExit: (reason) => finish(reason),
  });

  async function finish(reason) {
    if (exiting) return;
    exiting = true;
    log.info("exit", { reason });
    removeQuiet(paths.active);
    removeQuiet(paths.pendingContext);
    removeQuiet(paths.pid);
    removeQuiet(paths.port);
    setTimeout(() => process.exit(0), 500).unref();
    try { await d.close(); } catch { /* ignore */ }
    process.exit(0);
  }

  process.on("uncaughtException", (e) => log.crash("uncaughtException", e));
  process.on("unhandledRejection", (e) => log.crash("unhandledRejection", e));
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      log.info("signal", { signal: sig });
      if (d.voice.state === "off" && !d.voice.owner) finish(sig);
      else d.voice.gracefulOff("shutdown");
    });
  }

  try {
    await d.listen();
  } catch (e) {
    log.error("listen.error", { code: e.code, port: args.port });
    removeQuiet(paths.pid);
    process.exit(1);
  }
  log.info("start", { version: VERSION, pid: process.pid, port: args.port, node: process.version });
  // Nobody claimed us (toggle.sh posts /control right after spawning): exit eventually.
  setTimeout(() => { if (d.voice.state === "off" && !d.voice.owner && !exiting) finish("unclaimed"); }, 60_000).unref();
}

const isMain = process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href;
if (isMain) main();
