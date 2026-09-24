// daemon/window.js: desktop-app / Chrome / default-browser choice and fallback (SPEC §6.16).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  appBuildState, appPaths, appSourceHash, chooseWindow, createWindow, resolveWant, APP_PAGE_TIMEOUT_MS,
} from "../../daemon/window.js";
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
function harness({ env = {}, built = true, route = { input: { bluetooth: false }, output: { bluetooth: true } }, running = false, platform = "darwin", chrome = true } = {}) {
  const root = fakePlugin();
  const data = tmp();
  const p = built ? stamp(root, data) : appPaths(data, root);
  const clock = createFakeClock();
  const spawned = [];
  const children = [];
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
    spawn: (cmd, args) => {
      const child = { pid: 4242, handlers: {}, on(ev, fn) { this.handlers[ev] = fn; }, unref() {} };
      spawned.push([cmd, ...args]);
      children.push(child);
      return child;
    },
    execFile: (file, args, opts, cb) => {
      execCalls.push([file, ...args]);
      if (args[0] === "--audio-route") return setImmediate(() => cb(null, JSON.stringify(route)));
      if (file === "ps") return setImmediate(() => cb(null, running ? `/sbin/launchd\n${p.exe}\n` : "/sbin/launchd\n"));
      return setImmediate(() => cb(new Error("unexpected")));
    },
    launchCode: () => `c0de${String(++codes).padStart(12, "0")}`,
    getPreference: () => state.pref,
    pageConnected: () => state.page,
    wantsWindow: () => state.wants,
  });
  return { w, p, root, data, clock, spawned, children, browserCalls, execCalls, state };
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

  test("first /talk without a built app: background build + Chrome now, never blocking", () => {
    const h = harness({ built: false });
    const t0 = Date.now();
    assert.equal(h.w.open().mode, "chrome");
    assert.ok(Date.now() - t0 < 1000);
    assert.deepEqual(h.spawned[0], ["/bin/bash", path.join(h.root, "scripts/build-app.sh"), "--out", h.p.dir, "--quiet"]);
    assert.deepEqual(h.browserCalls, ["chrome"]);
    assert.ok(fs.existsSync(h.p.buildLog), "build output goes to logs/app-build.log");
  });

  test("a build already running is not started twice", () => {
    const h = harness({ built: false });
    fs.mkdirSync(h.p.dir, { recursive: true });
    fs.writeFileSync(h.p.lock, `${process.pid}\n`);
    h.w.open();
    assert.equal(h.spawned.length, 0);
    assert.deepEqual(h.browserCalls, ["chrome"]);
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
