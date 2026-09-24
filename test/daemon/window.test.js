// daemon/window.js: desktop-app / Chrome / default-browser choice and fallback (SPEC §6.16).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  appBuildState, appPaths, appSourceHash, chooseWindow, createWindow, installPlan, resolveWant, APP_PAGE_TIMEOUT_MS,
  INSTALL_WAIT_MS, INSTALL_POLL_MS, installFailure, shouldWaitForInstall, parseAppProcesses, staleAppProcesses, APP_QUIT_WAIT_MS,
} from "../../daemon/window.js";
import { RETRY_MS } from "../../daemon/appfetch.js";
import { CHROME_APP } from "../../daemon/chrome.js";
import { createFakeClock } from "../helpers/fake-clock.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "clw-"));

/** A plugin root with a tiny app/ and a build script (content only matters for the hash). */
function fakePlugin() {
  const root = tmp();
  fs.mkdirSync(path.join(root, "app/Sources"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "app/Info.plist"), "<plist/>");
  fs.writeFileSync(path.join(root, "app/Sources/main.swift"), "print(1)\n");
  fs.writeFileSync(path.join(root, "scripts/build-app.sh"), "#!/bin/bash\nexit 0\n");
  return root;
}

/** Mark the fake plugin's app as built (ok) or failed for the current sources. */
function stamp(root, dataDir, { ok = true, exe = true, hash } = {}) {
  const p = appPaths(dataDir, root);
  fs.mkdirSync(path.dirname(p.exe), { recursive: true });
  if (exe) fs.writeFileSync(p.exe, "");
  fs.writeFileSync(p.stamp, JSON.stringify({ hash: hash ?? appSourceHash(root), ok, error: ok ? undefined : "no swiftc" }));
  return p;
}

describe("resolveWant", () => {
  test("NO_BROWSER beats everything, then env, then userConfig, then auto", () => {
    assert.equal(resolveWant({ env: { SOTTO_NO_BROWSER: "1", SOTTO_BROWSER: "app" }, preference: "chrome" }), "none");
    assert.equal(resolveWant({ env: { SOTTO_BROWSER: "Chrome" }, preference: "app" }), "chrome");
    assert.equal(resolveWant({ env: { SOTTO_BROWSER: "bogus" }, preference: "app" }), "app");
    assert.equal(resolveWant({ env: {}, preference: "none" }), "auto"); // none is env-only
    assert.equal(resolveWant({ env: {} }), "auto");
  });
});

describe("chooseWindow", () => {
  const ready = { state: "ready" };
  const base = { platform: "darwin", chromeExists: true, app: ready };
  const pick = (o) => chooseWindow({ ...base, ...o });

  test("explicit none / default / chrome", () => {
    assert.equal(pick({ want: "none" }).mode, "none");
    assert.equal(pick({ want: "default" }).mode, "default");
    assert.equal(pick({ want: "chrome" }).mode, "chrome");
    assert.deepEqual(pick({ want: "chrome", chromeExists: false }), { mode: "default", build: false, needRoute: false, reason: "no_chrome" });
  });

  test("app: ready app launches without a route check", () => {
    assert.deepEqual(pick({ want: "app" }), { mode: "app", build: false, needRoute: false, reason: "requested" });
  });

  test("auto: ready app needs the audio route first, then picks by it", () => {
    assert.equal(pick({ want: "auto" }).needRoute, true);
    assert.equal(pick({ want: "auto", route: { input: { bluetooth: false }, output: { bluetooth: true } } }).mode, "app");
    const bt = pick({ want: "auto", route: { input: { bluetooth: true }, output: { bluetooth: true } } });
    assert.equal(bt.mode, "chrome");
    assert.equal(bt.reason, "bluetooth_input");
    // No Chrome to fall back to: the app is still better than the default browser.
    assert.equal(pick({ want: "auto", chromeExists: false, route: { input: { bluetooth: true } } }).mode, "app");
  });

  test("auto + Bluetooth default input: the app when its native mic can use another input on headphones", () => {
    const route = (o) => ({ input: { bluetooth: true }, output: { bluetooth: true, headphones: true }, builtin_input: true, native_mic: true, ...o });
    assert.deepEqual(pick({ want: "auto", route: route() }), { mode: "app", build: false, needRoute: false, reason: "native_mic" });
    // Any missing condition: Chrome, as before.
    assert.equal(pick({ want: "auto", route: route({ native_mic: false }) }).reason, "bluetooth_input");
    assert.equal(pick({ want: "auto", route: route({ builtin_input: false }) }).reason, "bluetooth_input");
    assert.equal(pick({ want: "auto", route: route({ output: { bluetooth: false, headphones: false } }) }).reason, "bluetooth_input");
    // An older app build without the fields: Chrome.
    assert.equal(pick({ want: "auto", route: { input: { bluetooth: true }, output: { bluetooth: true } } }).reason, "bluetooth_input");
  });

  test("missing or stale app: build in the background, Chrome this time", () => {
    for (const state of ["missing", "stale"]) {
      for (const want of ["auto", "app"]) {
        const c = pick({ want, app: { state } });
        assert.equal(c.mode, "chrome", `${want}/${state}`);
        assert.equal(c.build, true, `${want}/${state}`);
      }
    }
    assert.equal(pick({ want: "auto", app: { state: "missing" }, chromeExists: false }).mode, "default");
  });

  test("failed, building or absent sources: no build, browser", () => {
    for (const state of ["failed", "building", "nosource"]) {
      const c = pick({ want: "auto", app: { state } });
      assert.equal(c.mode, "chrome", state);
      assert.equal(c.build, false, state);
    }
  });

  test("not macOS, or the app already failed to open: browser", () => {
    assert.equal(pick({ want: "app", platform: "linux" }).reason, "app_needs_macos");
    assert.equal(pick({ want: "app", appBroken: true }).mode, "chrome");
  });
});

describe("app build state and sources hash", () => {
  test("hash matches scripts/build-app.sh --print-hash on the real repo", { skip: process.platform !== "darwin" }, () => {
    const r = spawnSync("/bin/bash", [path.join(ROOT, "scripts/build-app.sh"), "--print-hash"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), appSourceHash(ROOT));
  });

  test("hash changes with any app source", () => {
    const root = fakePlugin();
    const h1 = appSourceHash(root);
    fs.writeFileSync(path.join(root, "app/Sources/main.swift"), "print(2)\n");
    assert.notEqual(appSourceHash(root), h1);
    fs.rmSync(path.join(root, "app"), { recursive: true });
    assert.equal(appSourceHash(root), null);
  });

  test("missing, ready, stale, failed, building, nosource", () => {
    const root = fakePlugin();
    const data = tmp();
    assert.equal(appBuildState({ pluginRoot: root, dataDir: data }).state, "missing");
    const p = stamp(root, data);
    assert.equal(appBuildState({ pluginRoot: root, dataDir: data }).state, "ready");
    fs.writeFileSync(path.join(root, "app/Sources/main.swift"), "print(3)\n");
    assert.equal(appBuildState({ pluginRoot: root, dataDir: data }).state, "stale");
    stamp(root, data, { ok: false, exe: false });
    const failed = appBuildState({ pluginRoot: root, dataDir: data });
    assert.equal(failed.state, "failed");
    assert.equal(failed.error, "no swiftc");
    fs.writeFileSync(p.lock, `${process.pid}\n`);
    assert.equal(appBuildState({ pluginRoot: root, dataDir: data }).state, "building");
    fs.writeFileSync(p.lock, "999999999\n"); // dead pid: ignored
    assert.equal(appBuildState({ pluginRoot: root, dataDir: data }).state, "failed");
    assert.equal(appBuildState({ pluginRoot: tmp(), dataDir: data }).state, "nosource");
  });
});

/** createWindow with fakes: records spawns, answers --audio-route and ps. */
function harness({ env = {}, built = true, release = false, route = { input: { bluetooth: false }, output: { bluetooth: true } }, running = false, platform = "darwin", chrome = true, installWaitMs, procs = null, kill } = {}) {
  const root = fakePlugin();
  if (release) {
    // A versioned plugin with the fetcher: the release download applies.
    fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude-plugin/plugin.json"), JSON.stringify({ name: "sotto", version: "1.2.3" }));
    fs.mkdirSync(path.join(root, "daemon"), { recursive: true });
    fs.writeFileSync(path.join(root, "daemon/appfetch.js"), "");
  }
  const data = tmp();
  const p = built ? stamp(root, data) : appPaths(data, root);
  const clock = createFakeClock();
  const spawned = [];
  const spawnOpts = [];
  const children = [];
  const results = [];
  const logs = [];
  const browserCalls = [];
  const execCalls = [];
  const state = { page: false, wants: true, pref: undefined };
  const browser = {
    url: "http://127.0.0.1:47999/", launched: false,
    open(force) { browserCalls.push(force ?? "env"); return { mode: force || "chrome" }; },
    kill: async () => 0,
    notify() {},
  };
  let codes = 0;
  const w = createWindow({
    dataDir: data, port: 47999, pluginRoot: root, env, platform, clock, chrome: browser,
    exists: (f) => (f === CHROME_APP ? chrome : fs.existsSync(f)),
    spawn: (cmd, args, opts) => {
      const child = { pid: 4242, handlers: {}, on(ev, fn) { this.handlers[ev] = fn; }, unref() {} };
      spawned.push([cmd, ...args]);
      spawnOpts.push(opts);
      children.push(child);
      return child;
    },
    execFile: (file, args, opts, cb) => {
      execCalls.push([file, ...args]);
      if (args[0] === "--audio-route") return setImmediate(() => cb(null, JSON.stringify(route)));
      if (file === "ps" && args[1] === "pid=,lstart=,args=") return setImmediate(() => cb(null, procs ? procs(p.exe) : ""));
      if (file === "ps") return setImmediate(() => cb(null, running ? `/sbin/launchd\n${p.exe}\n` : "/sbin/launchd\n"));
      return setImmediate(() => cb(new Error("unexpected")));
    },
    launchCode: () => `c0de${String(++codes).padStart(12, "0")}`,
    getPreference: () => state.pref,
    pageConnected: () => state.page,
    wantsWindow: () => state.wants,
    installWaitMs,
    ...(kill ? { kill } : {}),
    onInstallResult: (r) => results.push(r),
    log: { info: (ev, o) => logs.push([ev, o]), warn: (ev, o) => logs.push([ev, o]), error: (ev, o) => logs.push([ev, o]) },
  });
  return { w, p, root, data, clock, spawned, spawnOpts, children, browserCalls, execCalls, state, results, logs };
}
const tick = () => new Promise((r) => setImmediate(r));

describe("createWindow", () => {
  test("auto + built app + wired/built-in mic: measures the route, then opens the app with a launch code", async () => {
    const h = harness();
    assert.deepEqual(h.w.open(), { mode: "app" });
    assert.equal(h.spawned.length, 0, "launch waits for the route check");
    await tick();
    assert.deepEqual(h.execCalls[0], [h.p.exe, "--audio-route"]);
    assert.equal(h.spawned.length, 1);
    const [cmd, g, a, bundle, url] = h.spawned[0];
    assert.deepEqual([cmd, g, a, bundle], ["open", "-g", "-a", h.p.bundle]);
    const u = new URL(url);
    assert.equal(u.protocol, "sotto:");
    assert.equal(u.host, "open");
    assert.equal(u.searchParams.get("port"), "47999");
    assert.equal(u.searchParams.get("k"), "c0de000000000001");
    assert.equal(u.searchParams.get("data"), h.data);
    assert.deepEqual(h.browserCalls, []);
    // The route is cached: the next open launches at once.
    h.w.open();
    assert.equal(h.spawned.length, 2);
  });

  test("auto + Bluetooth default input: Chrome, not the app", async () => {
    const h = harness({ route: { input: { bluetooth: true }, output: { bluetooth: true } } });
    h.w.open();
    await tick();
    assert.equal(h.spawned.length, 0);
    assert.deepEqual(h.browserCalls, ["chrome"]);
  });

  test("auto + Bluetooth input + headphones + native mic: the app", async () => {
    const h = harness({ route: { input: { bluetooth: true }, output: { bluetooth: true, headphones: true }, builtin_input: true, native_mic: true } });
    h.w.open();
    await tick();
    assert.equal(h.spawned.length, 1);
    assert.deepEqual(h.browserCalls, []);
  });

  test("test-mode launches forward the native-mic test settings to the app", async () => {
    const h = harness({ env: { SOTTO_BROWSER: "app", SOTTO_APP_TEST: "1", SOTTO_APP_MIC: "native", SOTTO_APP_MIC_FIXTURE: "/tmp/f.wav", SOTTO_APP_ECHO_SIM_DB: "-12" } });
    h.w.open();
    await tick();
    const args = h.spawned[0];
    for (const kv of ["SOTTO_APP_TEST=1", "SOTTO_APP_MIC=native", "SOTTO_APP_MIC_FIXTURE=/tmp/f.wav", "SOTTO_APP_ECHO_SIM_DB=-12"]) {
      assert.ok(args.includes(kv), `${kv} in ${args}`);
    }
    // Never outside test mode.
    const h2 = harness({ env: { SOTTO_BROWSER: "app", SOTTO_APP_MIC: "native" } });
    h2.w.open();
    await tick();
    assert.ok(!h2.spawned[0].some((a) => a.startsWith("SOTTO_APP_MIC")));
  });

  test("the window is no longer wanted when the route arrives: nothing opens", async () => {
    const h = harness();
    h.w.open();
    h.state.wants = false;
    await tick();
    assert.equal(h.spawned.length, 0);
    assert.deepEqual(h.browserCalls, []);
  });

  test("app requested explicitly: no route check", () => {
    const h = harness({ env: { SOTTO_BROWSER: "app" } });
    assert.equal(h.w.open().mode, "app");
    assert.equal(h.execCalls.length, 0);
    assert.equal(h.spawned[0][0], "open");
  });

  test("userConfig window=chrome and env overrides", () => {
    const h = harness();
    h.state.pref = "chrome";
    assert.equal(h.w.open().mode, "chrome");
    assert.deepEqual(h.browserCalls, ["chrome"]);
    const n = harness({ env: { SOTTO_NO_BROWSER: "1" } });
    assert.equal(n.w.open().mode, "none");
    assert.equal(n.spawned.length + n.browserCalls.length, 0);
  });

  test("first /talk without a built app: detached build, the window waits for it, never blocking", async () => {
    const h = harness({ built: false });
    const t0 = Date.now();
    assert.deepEqual(h.w.open(), { mode: "app", pending: true });
    assert.ok(Date.now() - t0 < 3000, "the build runs detached (it takes 10-20 s)");
    assert.deepEqual(h.spawned[0], ["/bin/bash", path.join(h.root, "scripts/build-app.sh"), "--out", h.p.dir, "--quiet"]);
    assert.deepEqual(h.browserCalls, []);
    assert.ok(fs.existsSync(h.p.buildLog), "build output goes to logs/app-build.log");
    assert.equal(h.w.appStatus().state, "installing");
    // The build finishes: the app opens (auto measures the route first).
    stamp(h.root, h.data);
    h.children[0].handlers.exit(0);
    await tick();
    assert.equal(h.spawned.at(-1)[0], "open");
    assert.deepEqual(h.browserCalls, []);
    assert.deepEqual(h.results, [{ ok: true }]);
  });

  test("an install that ends without an app: Chrome, with the reason for /talk and the page", () => {
    const h = harness({ built: false, release: true });
    h.w.open();
    fs.mkdirSync(h.p.dir, { recursive: true });
    fs.writeFileSync(h.p.installStamp, JSON.stringify({ ok: false, hash: appSourceHash(h.root), reason: "build_failed", message: "no signed release for this version; the local build failed: swiftc not found" }));
    h.children[0].handlers.exit(1);
    assert.deepEqual(h.browserCalls, ["chrome"]);
    assert.equal(h.results[0].ok, false);
    assert.match(h.results[0].message, /swiftc not found/);
    const st = h.w.appStatus();
    assert.equal(st.state, "failed");
    assert.match(st.message, /no signed release/);
    assert.ok(h.logs.some(([ev, o]) => ev === "app.install_failed" && o.reason === "build_failed"));
    assert.match(fs.readFileSync(h.p.buildLog, "utf8"), /daemon: install failed: no signed release/);
  });

  test("an installer that exits without doing anything is reported, not silent", () => {
    const h = harness({ built: false, release: true });
    h.w.open();
    h.children[0].handlers.exit(0);
    assert.deepEqual(h.browserCalls, ["chrome"]);
    assert.equal(h.w.appStatus().reason, "installer_exit");
    assert.match(h.w.appStatus().message, /exited \(0\) without installing/);
  });

  test("the wait is bounded: Chrome at the deadline, the install carries on", async () => {
    const h = harness({ built: false });
    h.w.open();
    await h.clock.advance(INSTALL_WAIT_MS.auto - 1);
    assert.deepEqual(h.browserCalls, []);
    await h.clock.advance(1);
    assert.deepEqual(h.browserCalls, ["chrome"]);
    assert.equal(h.w.appStatus().state, "installing");
    // /talk app waits longer (it may be a local build).
    const a = harness({ built: false, env: { SOTTO_BROWSER: "app" } });
    a.w.open();
    await a.clock.advance(INSTALL_WAIT_MS.auto);
    assert.deepEqual(a.browserCalls, []);
    await a.clock.advance(INSTALL_WAIT_MS.app - INSTALL_WAIT_MS.auto);
    assert.deepEqual(a.browserCalls, ["chrome"]);
  });

  test("no wait when disabled (installWaitMs 0 or SOTTO_APP_INSTALL_WAIT_MS=0): Chrome at once", () => {
    const h = harness({ built: false, installWaitMs: 0 });
    assert.equal(h.w.open().mode, "chrome");
    assert.equal(h.spawned.length, 1);
    const e = harness({ built: false, env: { SOTTO_APP_INSTALL_WAIT_MS: "0" } });
    assert.equal(e.w.open().mode, "chrome");
  });

  test("closing the voice while waiting cancels the pending window", async () => {
    const h = harness({ built: false });
    h.w.open();
    await h.w.kill();
    stamp(h.root, h.data);
    h.children[0].handlers.exit(0);
    await tick();
    assert.deepEqual(h.browserCalls, []);
    assert.equal(h.spawned.length, 1, "only the build");
  });

  test("first /talk with a release to try: the detached download (which builds on failure)", () => {
    const h = harness({ built: false, release: true });
    assert.equal(h.w.open().pending, true);
    assert.deepEqual(h.spawned[0], [process.execPath, path.join(h.root, "daemon/appfetch.js"), "--out", h.p.dir, "--plugin-root", h.root, "--hash", appSourceHash(h.root)]);
    assert.equal(h.spawnOpts[0].cwd, h.root, "run from the plugin root");
    assert.equal(h.spawnOpts[0].detached, true);
    assert.equal(typeof h.spawnOpts[0].stdio[1], "number", "stdout goes to logs/app-build.log");
    assert.match(fs.readFileSync(h.p.buildLog, "utf8"), /daemon: starting the installer/);
    // SOTTO_APP_DOWNLOAD=0 skips it; SOTTO_RELEASE_BASE is passed through.
    const off = harness({ built: false, release: true, env: { SOTTO_APP_DOWNLOAD: "0" } });
    off.w.open();
    assert.equal(off.spawned[0][0], "/bin/bash");
    const based = harness({ built: false, release: true, env: { SOTTO_RELEASE_BASE: "http://127.0.0.1:9/r" } });
    based.w.open();
    assert.deepEqual(based.spawned[0].slice(-2), ["--base", "http://127.0.0.1:9/r"]);
  });

  test("ensureInstalled: eager install for auto/app, never for chrome; one installer at a time", () => {
    const h = harness({ built: false, release: true });
    assert.equal(h.w.ensureInstalled().state, "installing");
    h.w.ensureInstalled();
    h.w.open();
    assert.equal(h.spawned.length, 1);
    const c = harness({ built: false, release: true });
    c.state.pref = "chrome";
    assert.equal(c.w.ensureInstalled().state, "missing");
    assert.equal(c.spawned.length, 0);
    const linux = harness({ built: false, release: true, platform: "linux" });
    assert.equal(linux.w.ensureInstalled().state, "unsupported");
    assert.equal(linux.spawned.length, 0);
  });

  test("ensureInstalled({force}) (/talk app) retries a failed build and download", () => {
    const h = harness({ built: false, release: true });
    stamp(h.root, h.data, { ok: false, exe: false });
    fs.writeFileSync(path.join(h.p.dir, "download.json"), JSON.stringify({ version: "1.2.3", hash: appSourceHash(h.root), ok: false, at: new Date().toISOString() }));
    h.w.ensureInstalled();
    assert.equal(h.spawned.length, 0, "a recent failure is not retried by itself");
    assert.equal(h.w.appStatus().state, "failed");
    h.w.ensureInstalled({ force: true });
    assert.equal(h.spawned.length, 1);
    assert.equal(h.spawned[0][1], path.join(h.root, "daemon/appfetch.js"));
    assert.ok(!h.spawned[0].includes("--no-build"));
  });

  test("a recent failed download of this version goes straight to the local build", () => {
    const h = harness({ built: false, release: true });
    fs.mkdirSync(h.p.dir, { recursive: true });
    fs.writeFileSync(path.join(h.p.dir, "download.json"), JSON.stringify({ version: "1.2.3", hash: appSourceHash(h.root), ok: false, at: new Date().toISOString() }));
    h.w.open();
    assert.equal(h.spawned[0][0], "/bin/bash");
  });

  test("a failed local build (never retried) still gets one download try, without a build", () => {
    const h = harness({ built: false, release: true });
    stamp(h.root, h.data, { ok: false, exe: false });
    h.w.open();
    assert.equal(h.spawned.length, 1);
    assert.equal(h.spawned[0].at(-1), "--no-build");
    fs.writeFileSync(path.join(h.p.dir, "download.json"), JSON.stringify({ version: "1.2.3", hash: appSourceHash(h.root), ok: false, at: new Date().toISOString() }));
    h.w.open();
    assert.equal(h.spawned.length, 1, "no second try within a day, and no build");
  });

  test("installPlan", () => {
    const base = { version: "1.0.0", hash: "h", now: 1e12 };
    assert.equal(installPlan({ ...base }), "download");
    assert.equal(installPlan({ ...base, env: { SOTTO_APP_DOWNLOAD: "0" } }), "build");
    assert.equal(installPlan({ ...base, version: null }), "build");
    assert.equal(installPlan({ ...base, allowBuild: false, version: null }), null);
    const failed = { version: "1.0.0", hash: "h", ok: false, at: new Date(1e12 - 1000).toISOString() };
    assert.equal(installPlan({ ...base, stamp: failed }), "build");
    assert.equal(installPlan({ ...base, stamp: failed, now: 1e12 + RETRY_MS }), "download");
  });

  test("a build already running (another daemon's) is not started twice; the window waits for it", async () => {
    const h = harness({ built: false });
    fs.mkdirSync(h.p.dir, { recursive: true });
    fs.writeFileSync(h.p.lock, `${process.pid}\n`);
    assert.equal(h.w.open().pending, true);
    assert.equal(h.spawned.length, 0);
    assert.deepEqual(h.browserCalls, []);
    fs.rmSync(h.p.lock);
    stamp(h.root, h.data);
    await h.clock.advance(INSTALL_POLL_MS);
    await tick();
    assert.equal(h.spawned.at(-1)?.[0], "open");
    assert.deepEqual(h.browserCalls, []);
  });

  test("not macOS: Chrome, no build, no app", () => {
    const h = harness({ platform: "linux", env: { SOTTO_BROWSER: "app" } });
    assert.equal(h.w.open().mode, "chrome");
    assert.equal(h.spawned.length, 0);
  });

  test("`open -a` fails: fall back to Chrome and stay on it", () => {
    const h = harness({ env: { SOTTO_BROWSER: "app" } });
    h.w.open();
    h.children[0].handlers.exit(1);
    assert.deepEqual(h.browserCalls, ["chrome"]);
    assert.equal(h.w.open().mode, "chrome");
  });

  test("the app never connects a page: Chrome after the watchdog", async () => {
    const h = harness({ env: { SOTTO_BROWSER: "app" } });
    h.w.open();
    await h.clock.advance(APP_PAGE_TIMEOUT_MS - 1);
    assert.deepEqual(h.browserCalls, []);
    await h.clock.advance(1);
    assert.deepEqual(h.browserCalls, ["chrome"]);
  });

  test("a connected page disarms the watchdog", async () => {
    const h = harness({ env: { SOTTO_BROWSER: "app" } });
    h.w.open();
    h.state.page = true;
    await h.clock.advance(APP_PAGE_TIMEOUT_MS + 1);
    assert.deepEqual(h.browserCalls, []);
  });

  test("kill asks a still-running app to close, and never launches it to do so", async () => {
    const h = harness({ env: { SOTTO_BROWSER: "app" }, running: true });
    h.w.open();
    assert.equal(await h.w.kill(), 1);
    assert.deepEqual(h.spawned[1], ["open", "-g", "-a", h.p.bundle, "sotto://close?port=47999"]);
    const q = harness({ env: { SOTTO_BROWSER: "app" }, running: false });
    q.w.open();
    assert.equal(await q.w.kill(), 0);
    assert.equal(q.spawned.length, 1);
    const never = harness();
    assert.equal(await never.w.kill(), 0);
    assert.equal(never.execCalls.length, 0);
  });
});

describe("stale app (SPEC §6.16 \"Stale app\")", () => {
  const EXE = "/data/app/Sotto.app/Contents/MacOS/Sotto";
  const PS = [
    "    1 Thu Sep 17 10:37:03 2026     /sbin/launchd",
    ` 4957 Thu Sep 24 11:03:35 2026     ${EXE}`,
    ` 5001 Thu Sep  4 09:00:00 2026     ${EXE} --test`,
    ` 5002 Thu Sep 24 11:03:35 2026     ${EXE}2`,
    "garbage line",
  ].join("\n");

  test("parseAppProcesses finds our executable (with or without arguments) and its start time", () => {
    const procs = parseAppProcesses(PS, EXE);
    assert.deepEqual(procs.map((x) => x.pid), [4957, 5001]);
    assert.equal(procs[0].startMs, new Date(2026, 8, 24, 11, 3, 35).getTime());
    assert.equal(procs[1].startMs, new Date(2026, 8, 4, 9, 0, 0).getTime());
    assert.deepEqual(parseAppProcesses("", EXE), []);
  });

  test("staleAppProcesses: started at least 1 s before the executable was installed", () => {
    const installed = new Date(2026, 8, 24, 11, 27, 53, 711).getTime();
    const procs = [{ pid: 1, startMs: installed - 3600_000 }, { pid: 2, startMs: installed - 500 }, { pid: 3, startMs: installed + 5000 }, { pid: 4, startMs: null }];
    assert.deepEqual(staleAppProcesses(procs, installed).map((x) => x.pid), [1]);
    assert.deepEqual(staleAppProcesses(procs, NaN), []);
  });

  test("quitStaleApps: SIGTERM to an app older than the bundle; a launch waits until it is gone", async () => {
    const signals = [];
    const alive = new Set([4957]);
    const kill = (pid, sig) => {
      if (sig === 0 || sig === undefined) { if (alive.has(pid)) return true; throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); }
      signals.push([pid, sig]);
      alive.delete(pid);
      return true;
    };
    const h = harness({ env: { SOTTO_BROWSER: "app" }, kill, procs: (exe) => ` 4957 Thu Sep 24 11:03:35 2020     ${exe}\n` });
    const quit = h.w.quitStaleApps("start");
    h.w.open();
    assert.equal(h.spawned.length, 0, "the launch waits for the stale app to quit");
    assert.equal(await quit, 1);
    await tick();
    assert.deepEqual(signals, [[4957, "SIGTERM"]]);
    assert.equal(h.spawned.length, 1);
    assert.equal(h.spawned[0][0], "open");
    const l = h.logs.find(([ev]) => ev === "app.stale_quit");
    assert.deepEqual(l[1].pids, [4957]);
  });

  test("quitStaleApps: an app started after the install is left alone", async () => {
    const signals = [];
    const kill = (pid, sig) => { if (sig) signals.push([pid, sig]); return true; };
    const h = harness({ kill, procs: (exe) => ` 4957 Thu Sep 24 11:03:35 2099     ${exe}\n` });
    assert.equal(await h.w.quitStaleApps("start"), 0);
    assert.deepEqual(signals, []);
    assert.deepEqual(await h.w.staleApps(), []);
  });

  test("an app that ignores SIGTERM gets SIGKILL after APP_QUIT_WAIT_MS", async () => {
    const signals = [];
    const kill = (pid, sig) => {
      if (sig === 0 || sig === undefined) { if (!signals.some(([, s]) => s === "SIGKILL")) return true; throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); }
      signals.push([pid, sig]);
      return true;
    };
    const h = harness({ kill, procs: (exe) => ` 4957 Thu Sep 24 11:03:35 2020     ${exe}\n` });
    const quit = h.w.quitStaleApps("install");
    for (let i = 0; i < 5; i++) await tick();
    assert.deepEqual(signals, [[4957, "SIGTERM"]]);
    await h.clock.advance(APP_QUIT_WAIT_MS + 200);
    assert.equal(await quit, 1);
    assert.deepEqual(signals, [[4957, "SIGTERM"], [4957, "SIGKILL"]]);
  });

  test("replaceApp({chrome}): quits the app, and later opens go to Chrome", async () => {
    const signals = [];
    const kill = (pid, sig) => { if (sig === 0 || sig === undefined) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); signals.push([pid, sig]); return true; };
    const h = harness({ env: { SOTTO_BROWSER: "app" }, kill, procs: (exe) => ` 777 Thu Sep 24 11:03:35 2099     ${exe}\n` });
    h.w.open();
    assert.equal(h.w.appLaunched, true);
    assert.equal(await h.w.replaceApp({ reason: "mic_silent", chrome: true }), 1);
    assert.deepEqual(signals, [[777, "SIGTERM"]], "a fresh app quits too: its mic is silent");
    assert.equal(h.w.appLaunched, false);
    h.w.open({ force: true });
    assert.deepEqual(h.browserCalls, ["chrome"]);
    assert.ok(h.logs.some(([ev, o]) => ev === "app.fallback" && o.reason === "mic_silent"));
  });
});
