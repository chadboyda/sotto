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

export function appPaths(dataDir, pluginRoot) {
  const dir = path.join(dataDir, "app");
  const bundle = path.join(dir, APP_BUNDLE);
  return {
    dir, bundle,
    exe: path.join(bundle, "Contents", "MacOS", APP_EXE),
    stamp: path.join(dir, "build.json"),
    lock: path.join(dir, "build.lock"),
    buildLog: path.join(dataDir, "logs", "app-build.log"),
    script: pluginRoot ? path.join(pluginRoot, "scripts", "build-app.sh") : null,
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
 * createWindow({dataDir, port, pluginRoot, env, platform, spawn, execFile, fsImpl, exists, kill, log,
 *               launchCode, clock, chrome, getPreference, pageConnected, wantsWindow})
 * → {open(): {mode}, kill(): Promise<number>, notify(text)}, the same surface as createChrome().
 */
export function createWindow({
  dataDir, port, pluginRoot, env = process.env, platform = process.platform, spawn = spawnCb, execFile = execFileCb,
  fsImpl = fs, exists = fs.existsSync, kill = process.kill.bind(process), log, launchCode, clock,
  chrome, getPreference = () => undefined, pageConnected = () => false, wantsWindow = () => true,
} = {}) {
  const p = appPaths(dataDir, pluginRoot);
  const browser = chrome || createChrome({ dataDir, port, env, spawn, execFile, exists, kill, log, launchCode });
  const timers = clock || { setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; }, clearTimeout, now: () => Date.now() };
  let route = null; // {at, value}
  let appBroken = false; // the app failed to open or never connected: Chrome for the rest of this daemon
  let appLaunched = false;
  let watchdog = null;
  let routePending = false;

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

  function startBuild() {
    if (!p.script || !exists(p.script)) return false;
    let fd = "ignore";
    try {
      fsImpl.mkdirSync(path.dirname(p.buildLog), { recursive: true, mode: 0o700 });
      fd = fsImpl.openSync(p.buildLog, "a", 0o600);
    } catch { /* log to nowhere */ }
    // Detached with no pipe to us: a 20 s swiftc build never holds /control,
    // the hook, or the daemon's exit.
    const child = detached("/bin/bash", [p.script, "--out", p.dir, "--quiet"], { stdio: ["ignore", fd, fd] });
    if (typeof fd === "number") { try { fsImpl.closeSync(fd); } catch { /* ignore */ } }
    log?.info("app.build_start", { pid: child?.pid ?? null });
    return !!child;
  }

  function fallback(reason) {
    appBroken = true;
    log?.warn("app.fallback", { reason });
    if (!wantsWindow()) return;
    browser.open(exists(CHROME_APP) ? "chrome" : "default");
  }

  function launchApp() {
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

  const freshRoute = () => (route && (timers.now ? timers.now() : Date.now()) - route.at < ROUTE_TTL_MS ? route.value : undefined);

  const api = {
    get url() { return browser.url; },
    get launched() { return appLaunched || browser.launched; },

    /** Open the voice window. Returns {mode} (for `auto`, the provisional one). */
    open() {
      const want = resolveWant({ env, preference: getPreference() });
      const appWanted = want === "app" || want === "auto";
      const app = appWanted && platform === "darwin" ? appBuildState({ pluginRoot, dataDir, fsImpl, kill }) : null;
      const chromeExists = exists(CHROME_APP);
      const c = chooseWindow({ want, platform, app, chromeExists, route: freshRoute(), appBroken });
      log?.info("window.choose", { want, mode: c.mode, reason: c.reason, app: app?.state ?? null });
      if (c.build) startBuild();
      if (c.mode === "none") return { mode: "none" };
      if (c.mode !== "app") return browser.open(c.mode);
      if (!c.needRoute) { launchApp(); return { mode: "app" }; }
      if (routePending) return { mode: "app" };
      routePending = true;
      measureRoute((value) => {
        routePending = false;
        if (!wantsWindow()) return;
        const again = chooseWindow({ want, platform, app, chromeExists, route: value || { input: { bluetooth: false } }, appBroken });
        log?.info("window.choose", { want, mode: again.mode, reason: again.reason, route: value ? { input_bt: !!value.input?.bluetooth, output_bt: !!value.output?.bluetooth, headphones: !!value.output?.headphones, native_mic: !!value.native_mic } : null });
        if (again.mode === "app") launchApp();
        else browser.open(again.mode);
      });
      return { mode: "app" };
    },

    /** Close: the browser window as before, and ask a running app to close its panel. */
    async kill() {
      if (watchdog) { timers.clearTimeout(watchdog); watchdog = null; }
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
  };
  return api;
}
