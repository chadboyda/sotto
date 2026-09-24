// Desktop app (SPEC §6.16): build smoke test + automated launch checks.
// Run with `npm run test:app` (macOS with Xcode or the Command Line Tools).
// Not part of `npm test`: the first build takes about 20 s of swiftc.
//
// The launches use --test / SOTTO_APP_TEST=1: an invisible panel, no
// global hotkeys, WebKit's mock microphone (so no microphone permission
// prompt), and a separate defaults suite and web storage. A temp daemon on a
// spare port serves the real web/ page; the user's daemon is never touched.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDaemon } from "../../daemon/index.js";
import { APP_BUNDLE, APP_EXE } from "../../daemon/window.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SKIP = process.platform !== "darwin" ? "macOS only"
  : spawnSync("xcode-select", ["-p"]).status !== 0 ? "no Xcode or Command Line Tools" : false;
// A stable cache dir makes reruns incremental (build-app.sh hash check).
const OUT = path.join(os.tmpdir(), "sotto-app-test-build");
const BUNDLE = path.join(OUT, APP_BUNDLE);
const EXE = path.join(BUNDLE, "Contents", "MacOS", APP_EXE);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const readLog = (file) => {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("desktop app", { skip: SKIP }, () => {
  let tmp;
  let daemon;
  let port;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sotto-app-test-"));
    port = await freePort();
    daemon = createDaemon({
      dataDir: path.join(tmp, "data"), port, pluginRoot: ROOT,
      env: { SOTTO_BROWSER: "none" }, daemonKey: "k".repeat(64),
    });
    await daemon.listen();
  });

  after(async () => {
    await daemon?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("build-app.sh builds a signed bundle with the required Info.plist keys", { timeout: 240_000 }, () => {
    const t0 = Date.now();
    const r = spawnSync("/bin/bash", [path.join(ROOT, "scripts/build-app.sh"), "--out", OUT], { encoding: "utf8" });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.ok(fs.existsSync(EXE));
    const key = (k) => spawnSync("plutil", ["-extract", k, "raw", "-o", "-", path.join(BUNDLE, "Contents/Info.plist")], { encoding: "utf8" }).stdout.trim();
    assert.equal(key("CFBundleIdentifier"), "com.chadboyda.sotto");
    assert.equal(key("CFBundleExecutable"), APP_EXE);
    assert.equal(key("LSUIElement"), "true");
    assert.match(key("NSMicrophoneUsageDescription"), /microphone/i);
    assert.equal(key("CFBundleURLTypes.0.CFBundleURLSchemes.0"), "sotto");
    assert.equal(key("NSAppTransportSecurity.NSAllowsLocalNetworking"), "true");
    assert.ok(fs.existsSync(path.join(BUNDLE, "Contents/Resources/bridge.js")));
    const cs = spawnSync("codesign", ["--verify", "--strict", BUNDLE], { encoding: "utf8" });
    assert.equal(cs.status, 0, cs.stderr);
    const req = spawnSync("codesign", ["-d", "-r-", BUNDLE], { encoding: "utf8" });
    assert.match(req.stdout + req.stderr, /designated => identifier "com\.chadboyda\.sotto"/);
    const stamp = JSON.parse(fs.readFileSync(path.join(OUT, "build.json"), "utf8"));
    assert.equal(stamp.ok, true);
    console.log(`# build: ${((Date.now() - t0) / 1000).toFixed(1)} s (${stamp.seconds} s swiftc when it last compiled)`);

    // Incremental: an unchanged tree is a no-op (no compile, stamp untouched).
    const t1 = Date.now();
    const again = spawnSync("/bin/bash", [path.join(ROOT, "scripts/build-app.sh"), "--out", OUT], { encoding: "utf8" });
    assert.equal(again.status, 0);
    assert.match(again.stdout, /up to date/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(OUT, "build.json"), "utf8")), stamp);
    console.log(`# no-op rebuild: ${Date.now() - t1} ms`);
    assert.equal(spawnSync("/bin/bash", [path.join(ROOT, "scripts/build-app.sh"), "--out", OUT, "--check"]).status, 0);
  });

  test("--audio-route prints the default devices as JSON", () => {
    const r = spawnSync(EXE, ["--audio-route"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.ok("input" in j && "output" in j);
    if (j.input) assert.equal(typeof j.input.bluetooth, "boolean");
  });

  test("direct launch: loads the page with the launch code, gets status over SSE, WebRTC works", { timeout: 60_000 }, async () => {
    const log = path.join(tmp, "direct.jsonl");
    const code = daemon.issueLaunchCode();
    const child = spawn(EXE, ["--port", String(port), "--k", code, "--data-dir", path.join(tmp, "data"),
      "--debug-log", log, "--test", "--probe-media", "--exit-after", "8"], { stdio: "ignore" });
    const exited = new Promise((r) => child.on("exit", (c) => r(c)));
    assert.equal(await Promise.race([exited, sleep(30_000).then(() => "timeout")]), 0);
    const ev = readLog(log);
    const find = (name, pred = () => true) => ev.find((e) => e.ev === name && pred(e));
    assert.ok(find("load_finish"), "page loaded");
    assert.equal(find("load_finish").url, `http://127.0.0.1:${port}/`, "fragment (launch code) never logged");
    assert.ok(find("bridge", (e) => e.kind === "sse" && e.open === true), "event stream open (bootstrap accepted the launch code)");
    assert.ok(find("bridge", (e) => e.kind === "status" && e.state === "off"), "status from SSE");
    assert.ok(find("media_permission", (e) => e.granted === true), "mic permission granted for our origin");
    const probe = find("probe")?.result;
    assert.ok(probe, "probe ran");
    assert.equal(probe.error, undefined, probe.error);
    assert.equal(probe.rtc, "function");
    assert.equal(probe.secure, true);
    assert.deepEqual(probe.offer, { opus: true, datachannel: true, audio: true });
    assert.equal(probe.withAEC.settings.echoCancellation, true);
    assert.equal(probe.withoutAEC.settings.echoCancellation, false);
    const hidden = find("probe_hidden")?.result;
    assert.ok(hidden && !hidden.error, `mic opens while the panel is hidden: ${hidden?.error}`);
    assert.ok(!fs.readFileSync(log, "utf8").includes(code), "launch code never logged");
  });

  test("a sotto://open URL is ignored unless D/daemon.port records its port", { timeout: 60_000 }, async () => {
    // Any web page can fire this URL; the panel must not load (and grant the
    // app's microphone to) whatever listens on an arbitrary loopback port.
    const log = path.join(tmp, "reject.jsonl");
    const other = await freePort();
    const fakeD = path.join(tmp, "fake-data");
    fs.mkdirSync(fakeD, { recursive: true });
    const url = (p, d) => `sotto://open?port=${p}&k=${"a".repeat(32)}&data=${encodeURIComponent(d)}`;
    const r = spawnSync("open", ["-g", "-a", BUNDLE, "--env", "SOTTO_APP_TEST=1", "--env", `SOTTO_APP_DEBUG_LOG=${log}`,
      url(other, path.join(tmp, "data"))], { encoding: "utf8", timeout: 15_000 });
    assert.equal(r.status, 0, r.stderr);
    const launch = await waitFor(() => readLog(log).find((e) => e.ev === "launch"), 15_000, "launch");
    try {
      await waitFor(() => readLog(log).some((e) => e.ev === "url_rejected" && e.port === other), 10_000, "wrong port rejected");
      // A data dir without daemon.port, and one missing entirely, are rejected too.
      spawnSync("open", ["-g", "-a", BUNDLE, url(port, fakeD)], { timeout: 15_000 });
      spawnSync("open", ["-g", "-a", BUNDLE, `sotto://open?port=${port}`], { timeout: 15_000 });
      await waitFor(() => readLog(log).filter((e) => e.ev === "url_rejected").length >= 3, 10_000, "all three rejected");
      assert.equal(readLog(log).filter((e) => e.ev === "open" || e.ev === "load_start").length, 0, "no page loaded");
    } finally {
      if (pidAlive(launch.pid)) process.kill(launch.pid, "SIGTERM");
      await waitFor(() => !pidAlive(launch.pid), 10_000, "app exit");
    }
  });

  test("LaunchServices launch: single instance takes a new launch code, close_window quits", { timeout: 60_000 }, async () => {
    const log = path.join(tmp, "ls.jsonl");
    const url = (k) => `sotto://open?port=${port}&k=${k}&data=${encodeURIComponent(path.join(tmp, "data"))}`;
    const open = (args) => spawnSync("open", args, { encoding: "utf8", timeout: 15_000 });
    let r = open(["-g", "-a", BUNDLE, "--env", "SOTTO_APP_TEST=1", "--env", `SOTTO_APP_DEBUG_LOG=${log}`, url(daemon.issueLaunchCode())]);
    assert.equal(r.status, 0, r.stderr);
    const launch = await waitFor(() => readLog(log).find((e) => e.ev === "launch"), 15_000, "launch");
    try {
      await waitFor(() => readLog(log).some((e) => e.ev === "bridge" && e.kind === "status"), 15_000, "first page status");
      r = open(["-g", "-a", BUNDLE, url(daemon.issueLaunchCode())]);
      assert.equal(r.status, 0, r.stderr);
      await waitFor(() => readLog(log).filter((e) => e.ev === "load_finish").length >= 2, 15_000, "second page load");
      assert.equal(readLog(log).filter((e) => e.ev === "launch").length, 1, "one process for both requests");
      await waitFor(() => daemon.sse.count >= 1, 10_000, "page event stream");
      // What the daemon does on voice off (SPEC §6.13 step 5).
      daemon.sse.broadcast({ type: "command", command: "close_window", reason: "user" });
      await waitFor(() => readLog(log).some((e) => e.ev === "close_window"), 10_000, "close_window handled");
      await waitFor(() => !pidAlive(launch.pid), 10_000, "app quits after close_window");
    } finally {
      if (pidAlive(launch.pid)) process.kill(launch.pid, "SIGTERM");
    }
  });
});
