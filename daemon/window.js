// Voice-window chooser (SPEC §6.16): the Sotto desktop app when it is
// built and suitable, else the Chrome --app window (chrome.js), else the
// default browser. Never blocks /control: building the app, checking the audio
// route and launching all happen in the background.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn as spawnCb, execFile as execFileCb } from "node:child_process";
import { CHROME_APP, createChrome } from "./chrome.js";
import { WINDOW_MODES } from "./config.js";
import { INSTALL_STAMP, RELEASE_BASE, pluginVersion, readDownloadStamp, shouldDownload } from "./appfetch.js";

export const APP_BUNDLE = "Sotto.app";
export const APP_EXE = "Sotto";
/** Env values: the userConfig modes plus "none" (tests and probes). */
export const ENV_MODES = Object.freeze([...WINDOW_MODES, "none"]);
/** No page connected this long after launching the app: fall back to Chrome. */
export const APP_PAGE_TIMEOUT_MS = 15_000;
/** Passed to a test-mode app launch (test/app/live.test.mjs). */
export const APP_TEST_ENV = Object.freeze(["SOTTO_APP_DEBUG_LOG", "SOTTO_APP_MIC", "SOTTO_APP_MIC_FIXTURE", "SOTTO_APP_MIC_FIXTURE_LEAD_MS", "SOTTO_APP_ECHO_SIM_DB"]);
/** How long a measured audio route stays valid for `auto`. */
export const ROUTE_TTL_MS = 60_000;
/**
 * How long open() holds the window for an app install in flight before it
 * opens Chrome instead (the install carries on; the next /talk uses the app).
 * The signed release (about 350 KB) installs in a few seconds; `app` (asked
 * for explicitly) also waits out a local build.
 */
export const INSTALL_WAIT_MS = Object.freeze({ auto: 15_000, app: 120_000 });
/** Poll interval while waiting on an install another process started. */
export const INSTALL_POLL_MS = 1_000;
/** After an install ended without an app, this daemon does not start another by itself for this long (/talk app does). */
export const INSTALL_RETRY_MS = 10 * 60_000;
/** How long a quit app process gets after SIGTERM before SIGKILL. */
export const APP_QUIT_WAIT_MS = 3_000;

export function appPaths(dataDir, pluginRoot) {
  const dir = path.join(dataDir, "app");
  const bundle = path.join(dir, APP_BUNDLE);
  return {
    dir, bundle,
    exe: path.join(bundle, "Contents", "MacOS", APP_EXE),
    stamp: path.join(dir, "build.json"),
    installStamp: path.join(dir, INSTALL_STAMP),
    lock: path.join(dir, "build.lock"),
    buildLog: path.join(dataDir, "logs", "app-build.log"),
    script: pluginRoot ? path.join(pluginRoot, "scripts", "build-app.sh") : null,
    fetcher: pluginRoot ? path.join(pluginRoot, "daemon", "appfetch.js") : null,
  };
}

/**
 * Hash of the app sources, identical to scripts/build-app.sh's source_hash:
 * sha256 over, for each file of app/** plus scripts/build-app.sh sorted by
 * path (byte order), "<relative path>\n<sha256 hex>\n". null if app/ is missing.
 */
export function appSourceHash(pluginRoot, fsImpl = fs) {
  const files = [];
  const walk = (rel) => {
    let entries;
    try { entries = fsImpl.readdirSync(path.join(pluginRoot, rel), { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && e.name !== ".DS_Store") files.push(r);
    }
    return true;
  };
  if (!walk("app")) return null;
  files.push("scripts/build-app.sh");
  files.sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b))));
  const outer = createHash("sha256");
  for (const f of files) {
    let data;
    try { data = fsImpl.readFileSync(path.join(pluginRoot, f)); } catch { return null; }
    outer.update(`${f}\n${createHash("sha256").update(data).digest("hex")}\n`);
  }
  return outer.digest("hex");
}

const pidAlive = (pid, kill) => {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

/**
 * Where the app build stands: {state, hash, error?}
 *   ready    bundle built from the current sources
 *   stale    a bundle exists but the sources changed
 *   missing  never built
 *   failed   the last build of these exact sources failed (not retried)
 *   building a build is running (build.lock names a live pid)
 *   nosource no app/ in the plugin (nothing to build)
 */
export function appBuildState({ pluginRoot, dataDir, fsImpl = fs, kill = process.kill.bind(process), hash } = {}) {
  const p = appPaths(dataDir, pluginRoot);
  const h = hash === undefined ? appSourceHash(pluginRoot, fsImpl) : hash;
  if (!h) return { state: "nosource", hash: null };
  let lockPid = NaN;
  try { lockPid = Number(String(fsImpl.readFileSync(p.lock, "utf8")).trim()); } catch { /* no lock */ }
  if (pidAlive(lockPid, kill)) return { state: "building", hash: h };
  let stamp = null;
  try { stamp = JSON.parse(fsImpl.readFileSync(p.stamp, "utf8")); } catch { /* none */ }
  const exe = fsImpl.existsSync(p.exe);
  if (stamp && stamp.hash === h) {
    if (stamp.ok === true && exe) return { state: "ready", hash: h };
    if (stamp.ok === false) return { state: "failed", hash: h, error: String(stamp.error || "build failed") };
  }
  return { state: exe ? "stale" : "missing", hash: h };
}

/**
 * How to get an app bundle (SPEC §6.16 "Release download"), pure:
 *   "download"  the signed release of this version (daemon/appfetch.js; on
 *               failure it runs the local build itself unless `allowBuild` is false)
 *   "build"     scripts/build-app.sh directly
 *   null        nothing to do
 * `allowBuild` is false for a `failed` local build (never retried): only a
 * download can still produce the app then.
 */
export function installPlan({ allowBuild = true, env = {}, version, hash, stamp, now = Date.now() }) {
  const enabled = env.SOTTO_APP_DOWNLOAD !== "0";
  if (enabled && shouldDownload({ stamp, version, hash, now })) return "download";
  return allowBuild ? "build" : null;
}

/** Requested mode: SOTTO_NO_BROWSER=1 > SOTTO_BROWSER > userConfig `window` > auto. */
export function resolveWant({ env = {}, preference } = {}) {
  if (env.SOTTO_NO_BROWSER === "1") return "none";
  const e = String(env.SOTTO_BROWSER || "").trim().toLowerCase();
  if (ENV_MODES.includes(e)) return e;
  if (WINDOW_MODES.includes(preference)) return preference;
  return "auto";
}

/**
 * Pure choice. Returns {mode, build, needRoute, reason}:
 *   mode       "app" | "chrome" | "default" | "none"
 *   build      start a background app build (missing or stale bundle)
 *   needRoute  `auto` with a ready app but no fresh audio route: the caller
 *              measures it, then asks again with `route`
 * `route` is {input:{bluetooth}, output:{bluetooth, headphones}, builtin_input, native_mic}
 * from `Sotto --audio-route`.
 */
export function chooseWindow({ want, platform, app, chromeExists, route, appBroken = false }) {
  const browser = (reason) => ({ mode: chromeExists ? "chrome" : "default", build: false, needRoute: false, reason });
  if (want === "none") return { mode: "none", build: false, needRoute: false, reason: "none" };
  if (want === "default") return { mode: "default", build: false, needRoute: false, reason: "requested" };
  if (want === "chrome") return browser(chromeExists ? "requested" : "no_chrome");
  // want is "app" or "auto".
  if (platform !== "darwin") return browser("app_needs_macos");
  const state = app?.state || "nosource";
  if (appBroken) return browser("app_failed_to_open");
  if (state === "missing" || state === "stale") return { ...browser(`app_${state}`), build: true };
  if (state !== "ready") return browser(`app_${state}`);
  if (want === "app") return { mode: "app", build: false, needRoute: false, reason: "requested" };
  if (!route) return { mode: "app", build: false, needRoute: true, reason: "auto" };
  // WebKit's capture opens the system default input first; a Bluetooth
  // headset there drops to its hands-free profile for the whole session
  // (see app/Sources/AudioRoute.swift). The app's native mic avoids that on
  // headphones: it captures another input (the built-in mic) without voice
  // processing (app/Sources/NativeMic.swift). Otherwise Chrome keeps the
  // headset in high quality.
  if (route.input?.bluetooth && chromeExists) {
    if (route.native_mic === true && route.output?.headphones === true && route.builtin_input === true) {
      return { mode: "app", build: false, needRoute: false, reason: "native_mic" };
    }
    return browser("bluetooth_input");
  }
  return { mode: "app", build: false, needRoute: false, reason: "auto" };
}

/**
 * Why the app is not installed, for people (SPEC §6.16): from install.json
 * (the installer's own verdict), else the failed build stamp, else the
 * installer's exit. Returns {reason, message} or null when nothing failed.
 */
export function installFailure({ dataDir, pluginRoot, hash, exitCode = null, fsImpl = fs }) {
  const p = appPaths(dataDir, pluginRoot);
  const read = (f) => { try { return JSON.parse(fsImpl.readFileSync(f, "utf8")); } catch { return null; } };
  const rec = read(p.installStamp);
  if (rec && rec.ok === false && (!hash || rec.hash === hash)) {
    return { reason: String(rec.reason || "failed"), message: String(rec.message || rec.reason || "unknown error") };
  }
  const b = read(p.stamp);
  if (b && b.ok === false && (!hash || b.hash === hash)) return { reason: "build_failed", message: `the local build failed: ${b.error || "unknown error"}` };
  if (exitCode !== null && exitCode !== undefined) {
    return { reason: "installer_exit", message: `the installer exited (${exitCode}) without installing; see logs/app-build.log` };
  }
  return null;
}

/**
 * Our app's processes in `ps -axo pid=,lstart=,args=` output (LC_ALL=C):
 * [{pid, startMs}]. `lstart` is local time with 1 s resolution. Pure.
 */
export function parseAppProcesses(stdout, exe) {
  const out = [];
  for (const line of String(stdout || "").split("\n")) {
    const m = /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
    if (!m) continue;
    const args = m[3];
    if (args !== exe && !args.startsWith(`${exe} `)) continue;
    const startMs = Date.parse(m[2].replace(/\s+/g, " "));
    out.push({ pid: Number(m[1]), startMs: Number.isFinite(startMs) ? startMs : null });
  }
  return out;
}

/**
 * App processes that run a REPLACED bundle (SPEC §6.16 "Stale app"): started
 * before the installed executable was written (its ctime: the install, since a
 * release unzip keeps the build's mtime). macOS then attributes the process to
 * code that is no longer on disk, and its microphone delivers only zeros while
 * AVCaptureDevice still says "authorized" (measured, macOS 26.6: a Developer ID
 * app whose bundle was swapped while it ran got 71 168 samples, all zero). The
 * 1 s margin covers lstart's resolution. Pure.
 */
export function staleAppProcesses(procs, exeChangedMs) {
  if (!Number.isFinite(exeChangedMs)) return [];
  return (procs || []).filter((x) => Number.isFinite(x.startMs) && x.startMs + 1000 <= exeChangedMs);
}

/** Wait for an install in flight instead of opening Chrome? Pure. */
export function shouldWaitForInstall({ want, platform, appBroken, installing, waitMs }) {
  return (want === "app" || want === "auto") && platform === "darwin" && !appBroken && !!installing && waitMs > 0;
}

/**
 * createWindow({dataDir, port, pluginRoot, env, platform, spawn, execFile, fsImpl, exists, kill, log,
 *               launchCode, clock, chrome, getPreference, pageConnected, wantsWindow})
 * → {open(): {mode}, kill(): Promise<number>, notify(text)}, the same surface as createChrome().
 */
export function createWindow({
  dataDir, port, pluginRoot, env = process.env, platform = process.platform, spawn = spawnCb, execFile = execFileCb,
  fsImpl = fs, exists = fs.existsSync, kill = process.kill.bind(process), log, launchCode, clock,
  chrome, getPreference = () => undefined, pageConnected = () => false, wantsWindow = () => true,
  installWaitMs, onInstallResult = () => {},
} = {}) {
  const p = appPaths(dataDir, pluginRoot);
  const browser = chrome || createChrome({ dataDir, port, env, spawn, execFile, exists, kill, log, launchCode });
  const timers = clock || { setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; }, clearTimeout, now: () => Date.now() };
  let route = null; // {at, value}
  let appBroken = false; // the app failed to open or never connected: Chrome for the rest of this daemon
  let appLaunched = false;
  let watchdog = null;
  let routePending = false;
  let install = null; // {pid, at}: the installer this daemon spawned, while it runs
  let installError = null; // {reason, message, at}: the last install that ended without an app
  let pending = null; // {want, deadline, poll}: open() waiting for that install
  let quitting = null; // Promise while stale app processes are being quit: a launch waits for it
  const nowMs = () => (timers.now ? timers.now() : Date.now());
  const waitFor = (want) => {
    const envMs = Number(env.SOTTO_APP_INSTALL_WAIT_MS);
    if (installWaitMs && typeof installWaitMs === "object") return installWaitMs[want] ?? 0;
    if (typeof installWaitMs === "number") return installWaitMs;
    if (env.SOTTO_APP_INSTALL_WAIT_MS !== undefined && Number.isFinite(envMs) && envMs >= 0) return envMs;
    return INSTALL_WAIT_MS[want] ?? 0;
  };
  const buildState = () => appBuildState({ pluginRoot, dataDir, fsImpl, kill });

  /** Append one line to logs/app-build.log (the installer writes there too). */
  function buildLogLine(text) {
    try {
      fsImpl.mkdirSync(path.dirname(p.buildLog), { recursive: true, mode: 0o700 });
      fsImpl.appendFileSync(p.buildLog, `${new Date(nowMs()).toISOString()} daemon: ${text}\n`, { mode: 0o600 });
    } catch { /* best effort */ }
  }

  const detached = (cmd, args, opts = {}) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore", ...opts });
      child.on?.("error", (e) => log?.warn("window.spawn_error", { cmd, message: e.message }));
      child.unref?.();
      return child;
    } catch (e) {
      log?.warn("window.spawn_error", { cmd, message: e.message });
      return null;
    }
  };

  const sleep = (ms) => new Promise((r) => timers.setTimeout(r, ms));

  /** Our app's running processes: [{pid, startMs}] ([] when ps fails). */
  function appProcesses() {
    if (platform !== "darwin") return Promise.resolve([]);
    return new Promise((resolve) => {
      execFile("ps", ["-axo", "pid=,lstart=,args="], { timeout: 2000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (err, stdout) => {
        resolve(err ? [] : parseAppProcesses(String(stdout), p.exe));
      });
    });
  }

  /** Running app processes older than the installed bundle (see staleAppProcesses). */
  async function staleApps() {
    let changed;
    try { changed = fsImpl.statSync(p.exe).ctimeMs; } catch { return []; }
    return staleAppProcesses(await appProcesses(), changed);
  }

  /** SIGTERM, then SIGKILL whatever is left after APP_QUIT_WAIT_MS. */
  async function terminate(pids) {
    const alive = (pid) => pidAlive(pid, kill);
    for (const pid of pids) { try { kill(pid, "SIGTERM"); } catch { /* gone */ } }
    const deadline = nowMs() + APP_QUIT_WAIT_MS;
    while (pids.some(alive) && nowMs() < deadline) await sleep(100);
    for (const pid of pids.filter(alive)) { try { kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }

  /** Open logs/app-build.log for a child's stdout/stderr, or "ignore". */
  function logFd() {
    try {
      fsImpl.mkdirSync(path.dirname(p.buildLog), { recursive: true, mode: 0o700 });
      return fsImpl.openSync(p.buildLog, "a", 0o600);
    } catch {
      return "ignore";
    }
  }

  /** Watch a spawned installer: when it exits, find out whether the app is there. */
  function track(child, kind) {
    if (!child) return false;
    install = { pid: child.pid ?? null, at: nowMs(), kind };
    child.on?.("exit", (code, signal) => installEnded(code ?? (signal ? `signal ${signal}` : null)));
    child.on?.("error", (e) => { buildLogLine(`installer spawn error: ${e.message}`); installEnded(`spawn error: ${e.message}`); });
    return true;
  }

  function installEnded(exitCode) {
    if (!install) return;
    const took = Math.round((nowMs() - install.at) / 1000);
    install = null;
    const st = buildState();
    if (st.state === "ready") {
      installError = null;
      log?.info("app.install_ready", { seconds: took });
      onInstallResult({ ok: true });
    } else if (st.state === "building") {
      return; // another installer took over; the pending wait polls it
    } else {
      const f = installFailure({ dataDir, pluginRoot, hash: st.hash, exitCode, fsImpl }) || { reason: "installer_exit", message: `the installer exited (${exitCode}) without installing; see logs/app-build.log` };
      installError = { ...f, at: nowMs() };
      log?.warn("app.install_failed", { reason: f.reason, message: f.message, code: exitCode, state: st.state });
      buildLogLine(`install failed: ${f.message}`);
      onInstallResult({ ok: false, ...f });
    }
    settlePending();
  }

  function startBuild() {
    if (!p.script || !exists(p.script)) return false;
    const fd = logFd();
    buildLogLine("starting the local build (scripts/build-app.sh)");
    // Detached with no pipe to us: a 20 s swiftc build never holds /control,
    // the hook, or the daemon's exit.
    const child = detached("/bin/bash", [p.script, "--out", p.dir, "--quiet"], { stdio: ["ignore", fd, fd] });
    if (typeof fd === "number") { try { fsImpl.closeSync(fd); } catch { /* ignore */ } }
    log?.info("app.build_start", { pid: child?.pid ?? null });
    return track(child, "build");
  }

  /** Download the release (then build), or just build; detached either way. */
  function startInstall({ allowBuild = true, hash, force = false } = {}) {
    if (install) return true; // ours is still running
    if (!force && installError && nowMs() - installError.at < INSTALL_RETRY_MS) return false;
    const plan = installPlan({
      allowBuild, env, version: pluginVersion(pluginRoot, fsImpl), hash,
      stamp: readDownloadStamp(p.dir, fsImpl), now: nowMs(),
    });
    if (plan === "build") return startBuild();
    if (plan !== "download" || !p.fetcher || !exists(p.fetcher)) return false;
    const fd = logFd();
    const args = [p.fetcher, "--out", p.dir, "--plugin-root", pluginRoot, "--hash", hash];
    const base = String(env.SOTTO_RELEASE_BASE || "").trim();
    if (base && base !== RELEASE_BASE) args.push("--base", base);
    if (!allowBuild) args.push("--no-build");
    buildLogLine(`starting the installer (${allowBuild ? "signed release, else local build" : "signed release only"})`);
    // Same runtime as the daemon (Node, or Bun as its fallback), from the
    // plugin root. appfetch.js compares real paths to know it is the main
    // module, so a symlinked install (~/.claude/skills/sotto) runs it too.
    const child = detached(process.execPath, args, { stdio: ["ignore", fd, fd], cwd: pluginRoot, env: env === process.env ? process.env : { ...process.env, ...env } });
    if (typeof fd === "number") { try { fsImpl.closeSync(fd); } catch { /* ignore */ } }
    log?.info("app.download_start", { pid: child?.pid ?? null, build_fallback: allowBuild });
    return track(child, "download");
  }

  /**
   * Start an install when the app is missing, stale, or failed with a download
   * still to try. `force` (/talk app) also retries a failed build and a
   * failed download. Returns the build state after the decision.
   */
  function ensure({ force = false } = {}) {
    if (platform !== "darwin") return { state: "unsupported" };
    const st = buildState();
    if (st.state === "missing" || st.state === "stale") startInstall({ hash: st.hash, force });
    else if (st.state === "failed") {
      if (force) {
        for (const f of [p.stamp, path.join(p.dir, "download.json")]) { try { fsImpl.rmSync(f, { force: true }); } catch { /* ignore */ } }
        startInstall({ hash: st.hash, force });
      } else startInstall({ allowBuild: false, hash: st.hash });
    }
    return buildState();
  }

  /** An install in flight: ours, or another process's (build.lock names a live pid). */
  const installing = () => !!install || buildState().state === "building";

  function settlePending() {
    if (!pending) return;
    const want = pending.want;
    if (pending.deadline) timers.clearTimeout(pending.deadline);
    if (pending.poll) timers.clearTimeout(pending.poll);
    pending = null;
    if (!wantsWindow()) return;
    openNow({ noWait: true, wantOverride: want });
  }

  function waitForInstall(want) {
    const ms = waitFor(want);
    log?.info("app.wait_install", { want, ms });
    pending = { want, deadline: null, poll: null };
    pending.deadline = timers.setTimeout(() => {
      if (!pending) return;
      log?.info("app.wait_timeout", { want, ms });
      settlePending();
    }, ms);
    const poll = () => {
      if (!pending) return;
      // An installer we did not spawn (a previous daemon's): no exit event.
      if (!install && buildState().state !== "building") return settlePending();
      pending.poll = timers.setTimeout(poll, INSTALL_POLL_MS);
    };
    pending.poll = timers.setTimeout(poll, INSTALL_POLL_MS);
  }

  function fallback(reason) {
    appBroken = true;
    log?.warn("app.fallback", { reason });
    if (!wantsWindow()) return;
    browser.open(exists(CHROME_APP) ? "chrome" : "default");
  }

  function launchApp() {
    // A stale app still running would receive this launch (one instance per
    // bundle id) and host the page with a silent microphone: wait until it is gone.
    if (quitting) { quitting.then(() => launchApp()); return; }
    const code = launchCode?.();
    const q = new URLSearchParams({ port: String(port), data: dataDir });
    if (code) q.set("k", code);
    // -g: do not bring the app forward; its panel floats without taking
    // focus from the terminal. -a <bundle path>: this exact build, whatever
    // else LaunchServices knows under the sotto:// scheme.
    // Test hook (test/app/live.test.mjs): run the app in its test mode
    // (mock mic, hidden panel), since LaunchServices passes no arguments.
    // The native-mic test settings (fixture, mode, echo simulation) ride along.
    const testEnv = env.SOTTO_APP_TEST === "1"
      ? ["--env", "SOTTO_APP_TEST=1", ...APP_TEST_ENV.filter((k) => env[k]).flatMap((k) => ["--env", `${k}=${env[k]}`])]
      : [];
    const child = detached("open", ["-g", "-a", p.bundle, ...testEnv, `sotto://open?${q}`]);
    if (!child) return fallback("spawn_failed");
    appLaunched = true;
    log?.info("chrome.open", { mode: "app" });
    child.on?.("exit", (codeOut) => { if (codeOut) fallback(`open_exit_${codeOut}`); });
    if (watchdog) timers.clearTimeout(watchdog);
    watchdog = timers.setTimeout(() => {
      watchdog = null;
      if (!pageConnected() && wantsWindow()) fallback("no_page");
    }, APP_PAGE_TIMEOUT_MS);
  }

  function measureRoute(done) {
    execFile(p.exe, ["--audio-route"], { timeout: 4000, maxBuffer: 64 * 1024 }, (err, stdout) => {
      let value = null;
      if (!err) { try { value = JSON.parse(String(stdout)); } catch { /* bad output */ } }
      if (value) route = { at: timers.now ? timers.now() : Date.now(), value };
      else log?.warn("app.route_failed", { message: err ? String(err.message || err) : "bad output" });
      done(value);
    });
  }

  function openNow({ noWait = false, wantOverride, force = false } = {}) {
    const want = wantOverride || resolveWant({ env, preference: getPreference() });
    const appWanted = want === "app" || want === "auto";
    const app = appWanted && platform === "darwin" ? buildState() : null;
    const chromeExists = exists(CHROME_APP);
    const c = chooseWindow({ want, platform, app, chromeExists, route: freshRoute(), appBroken });
    log?.info("window.choose", { want, mode: c.mode, reason: c.reason, app: app?.state ?? null });
    if (c.build) startInstall({ hash: app.hash });
    else if (app?.state === "failed") startInstall({ allowBuild: false, hash: app.hash });
    if (c.mode === "none") return { mode: "none" };
    if (c.mode !== "app") {
      if (!noWait && shouldWaitForInstall({ want, platform, appBroken, installing: installing(), waitMs: waitFor(want) })) {
        if (!pending) waitForInstall(want);
        return { mode: "app", pending: true };
      }
      const r = browser.open(c.mode);
      const failed = app ? api.appStatus() : null;
      return failed?.state === "failed" ? { ...r, installError: { reason: failed.reason, message: failed.message } } : r;
    }
    if (!c.needRoute) { launchApp(); return { mode: "app" }; }
    if (routePending) return { mode: "app" };
    routePending = true;
    measureRoute((value) => {
      routePending = false;
      if (!force && !wantsWindow()) return;
      const again = chooseWindow({ want, platform, app, chromeExists, route: value || { input: { bluetooth: false } }, appBroken });
      log?.info("window.choose", { want, mode: again.mode, reason: again.reason, route: value ? { input_bt: !!value.input?.bluetooth, output_bt: !!value.output?.bluetooth, headphones: !!value.output?.headphones, native_mic: !!value.native_mic } : null });
      if (again.mode === "app") launchApp();
      else browser.open(again.mode);
    });
    return { mode: "app" };
  }

  const freshRoute = () => (route && (timers.now ? timers.now() : Date.now()) - route.at < ROUTE_TTL_MS ? route.value : undefined);

  const api = {
    get url() { return browser.url; },
    get launched() { return appLaunched || browser.launched; },

    /**
     * Open the voice window. Returns {mode} (for `auto`, the provisional
     * one), plus {pending: true} while it waits for an app install, and
     * {installError} when the app could not be installed.
     */
    open({ force = false } = {}) { return openNow({ force }); },

    /** Start installing the app if it is missing (daemon start, every /talk); see ensure(). */
    ensureInstalled(opts = {}) {
      const want = resolveWant({ env, preference: getPreference() });
      if (!opts.force && want !== "app" && want !== "auto") return api.appStatus();
      ensure(opts);
      return api.appStatus();
    },

    /**
     * {state, reason?, message?} for /talk status and messages:
     *   ready | installing | missing | stale | failed | unsupported | nosource
     */
    appStatus() {
      if (platform !== "darwin") return { state: "unsupported" };
      const st = buildState();
      if (install || st.state === "building") return { state: "installing" };
      if (st.state === "ready") return { state: "ready" };
      if (installError) return { state: "failed", reason: installError.reason, message: installError.message };
      if (st.state === "failed") {
        const f = installFailure({ dataDir, pluginRoot, hash: st.hash, fsImpl });
        return { state: "failed", reason: f?.reason || "build_failed", message: f?.message || st.error || "the local build failed" };
      }
      return { state: st.state };
    },

    get installing() { return installing(); },
    get pending() { return !!pending; },

    /** Close: the browser window as before, and ask a running app to close its panel. */
    async kill() {
      if (watchdog) { timers.clearTimeout(watchdog); watchdog = null; }
      if (pending) {
        if (pending.deadline) timers.clearTimeout(pending.deadline);
        if (pending.poll) timers.clearTimeout(pending.poll);
        pending = null;
      }
      const n = await browser.kill();
      if (!appLaunched) return n;
      appLaunched = false;
      const running = await new Promise((resolve) => {
        execFile("ps", ["-axo", "args="], { timeout: 2000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
          resolve(!err && String(stdout).split("\n").some((l) => l === p.exe || l.startsWith(`${p.exe} `)));
        });
      });
      // Only when it is still running (it normally quits on close_window
      // itself), so this never launches the app just to close it.
      if (running) detached("open", ["-g", "-a", p.bundle, `sotto://close?port=${port}`]);
      log?.info("app.close", { running });
      return n + (running ? 1 : 0);
    },

    notify(text) { browser.notify(text); },

    /** Running app processes that predate the installed bundle: Promise<[{pid, startMs}]>. */
    staleApps() { return staleApps(); },

    /**
     * Quit app processes that run a replaced bundle (SPEC §6.16 "Stale app"):
     * their microphone is silent. A launch meanwhile waits. Resolves to the
     * number quit.
     */
    quitStaleApps(reason = "stale") {
      if (quitting) return quitting.then(() => 0);
      const run = (async () => {
        const stale = await staleApps();
        if (!stale.length) return 0;
        log?.warn("app.stale_quit", { reason, pids: stale.map((x) => x.pid), started: stale.map((x) => new Date(x.startMs).toISOString()) });
        await terminate(stale.map((x) => x.pid));
        return stale.length;
      })();
      quitting = run.catch(() => 0).finally(() => { quitting = null; });
      return quitting;
    },

    /**
     * Quit every process of our app (stale or not), for a window swap (SPEC
     * §6.16 "Silent mic"). `chrome`: the app is not used again by this daemon.
     * The caller reopens the window. Resolves to the number quit.
     */
    async replaceApp({ reason = "replace", chrome: toChrome = false } = {}) {
      if (watchdog) { timers.clearTimeout(watchdog); watchdog = null; }
      if (toChrome) {
        appBroken = true;
        log?.warn("app.fallback", { reason });
      }
      appLaunched = false;
      const pids = (await appProcesses()).map((x) => x.pid);
      log?.info("app.quit", { reason, pids });
      const run = terminate(pids);
      quitting = run.catch(() => {}).finally(() => { quitting = null; });
      await quitting;
      return pids.length;
    },

    /** Self-update (§6.17): the successor learns that the app hosts the page, so kill() still closes it. */
    get appLaunched() { return appLaunched; },
    adoptApp() { appLaunched = true; },
  };
  return api;
}
