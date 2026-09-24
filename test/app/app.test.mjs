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

// LaunchServices launches (`open -a <bundle> sotto://…`) use a copy of the
// test build under its own bundle identifier. The app is single-instance
// (LSMultipleInstancesProhibited), so LaunchServices hands a URL for
// com.chadboyda.sotto to an ALREADY RUNNING Sotto, whatever bundle path `-a`
// names: with the user's app open, the test URL (a real temp daemon and data
// dir, so it passes the port check) loaded the test page into the user's live
// panel and the test never saw its own launch (both tests timed out).
const LS_ID = "com.chadboyda.sotto.apptest";
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
function makeLaunchServicesCopy(dir) {
  const copy = path.join(dir, "ls", APP_BUNDLE);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    assert.equal(r.status, 0, `${cmd} ${args.join(" ")}: ${r.stderr}`);
  };
  run("ditto", [BUNDLE, copy]);
  run("plutil", ["-replace", "CFBundleIdentifier", "-string", LS_ID, path.join(copy, "Contents/Info.plist")]);
  run("codesign", ["--force", "--sign", "-", copy]);
  return copy;
}

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

  let lsBundle;
  const lsCopy = () => (lsBundle ??= makeLaunchServicesCopy(tmp));

  after(async () => {
    if (lsBundle) spawnSync(LSREGISTER, ["-u", lsBundle]);
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

  test("--audio-route reports what the chooser needs for the native mic", () => {
    const j = JSON.parse(spawnSync(EXE, ["--audio-route"], { encoding: "utf8", timeout: 10_000 }).stdout);
    assert.equal(typeof j.builtin_input, "boolean");
    assert.equal(j.native_mic, true);
    if (j.output) assert.equal(typeof j.output.headphones, "boolean");
  });

  test("--mic-plan-eval: native on headphones (built-in mic instead of a Bluetooth default), WebKit on speakers", () => {
    const plan = (o) => JSON.parse(spawnSync(EXE, ["--mic-plan-eval", JSON.stringify(o)], { encoding: "utf8", timeout: 10_000 }).stdout);
    const airpods = { name: "AirPods Max", transport: "bluetooth" };
    const builtin = { name: "MacBook Pro Microphone", transport: "builtin" };
    const zoom = { name: "ZoomAudioDevice", transport: "virtual" };
    const hp = { bluetooth: true, headphones: true };
    const spk = { bluetooth: false, headphones: false };
    assert.deepEqual(plan({ output: hp, inputs: [airpods, zoom, builtin], default: 0 }), { mode: "native", device: "MacBook Pro Microphone", reason: "headphones" });
    assert.deepEqual(plan({ output: spk, inputs: [airpods, builtin], default: 1 }), { mode: "webkit", device: "MacBook Pro Microphone", reason: "speakers" });
    // Wired headphones (built-in jack) count as headphones too.
    assert.equal(plan({ output: { bluetooth: false, headphones: true }, inputs: [builtin], default: 0 }).mode, "native");
    // An explicit choice wins, even the headset mic (the user asked for it).
    assert.equal(plan({ output: hp, inputs: [airpods, builtin], default: 0, requested: "AirPods Max" }).device, "AirPods Max");
    // Only a Bluetooth mic: it is used (nothing else can hear the user).
    assert.equal(plan({ output: hp, inputs: [airpods], default: 0 }).device, "AirPods Max");
    assert.deepEqual(plan({ output: hp, inputs: [builtin], default: 0, requested: "gone" }), { error: "NotFoundError" });
    assert.equal(plan({ pref: "webkit", output: hp, inputs: [builtin], default: 0 }).mode, "webkit");
    assert.equal(plan({ pref: "native", output: spk, inputs: [builtin], default: 0 }).mode, "native");
    assert.equal(plan({ output: hp, inputs: [], default: 0 }).mode, "webkit", "no input: WebKit reports the error");
  });

  test("--panel-frame-eval: a tiny, missing or off-screen saved frame opens the full 420x640 panel", () => {
    const ev = (saved, screens = [[0, 77, 1440, 798]]) =>
      JSON.parse(spawnSync(EXE, ["--panel-frame-eval", JSON.stringify({ saved, screens })], { encoding: "utf8", timeout: 10_000 }).stdout);
    // First launch: the full default near the top right of the main screen.
    assert.deepEqual(ev(null), { frame: [996, 211, 420, 640], reason: "default" });
    // A pill-sized or squashed frame is clamped up to the default size, keeping its top-right corner.
    assert.deepEqual(ev("{{700, 500}, {250, 44}}"), { frame: [530, 77, 420, 640], reason: "too_small" });
    assert.deepEqual(ev("{{700, 200}, {420, 120}}"), { frame: [700, 77, 420, 640], reason: "too_small" });
    assert.equal(ev("{{700, 200}, {359, 640}}").reason, "too_small", "narrower than the 360 px minimum");
    assert.equal(ev("{{700, 200}, {360, 420}}").reason, "saved", "exactly the minimum is kept");
    assert.equal(ev("{{100, 100}, {500, 700}}").reason, "saved", "a user-resized frame is kept");
    assert.equal(ev("{{9000, 100}, {420, 640}}").reason, "offscreen");
    assert.equal(ev("garbage").reason, "default");
    // Taller than its screen: fitted to it.
    assert.deepEqual(ev("{{0, 0}, {420, 2000}}", [[0, 0, 1440, 875]]), { frame: [0, 0, 420, 875], reason: "fitted" });
  });

  test("launch with a tiny saved frame opens the full panel and replaces the bad frame", { timeout: 60_000 }, () => {
    const SUITE = "com.chadboyda.sotto.test";
    const read = (k) => spawnSync("defaults", ["read", SUITE, k], { encoding: "utf8" });
    const prevFrame = read("PanelFrame");
    const prevCompact = read("PanelCompact");
    spawnSync("defaults", ["write", SUITE, "PanelFrame", "-string", "{{200, 300}, {250, 44}}"]);
    spawnSync("defaults", ["delete", SUITE, "PanelCompact"]);
    try {
      const log = path.join(tmp, "frame.jsonl");
      const r = spawnSync(EXE, ["--port", String(port), "--data-dir", path.join(tmp, "data"), "--debug-log", log, "--test", "--exit-after", "2"],
        { stdio: "ignore", timeout: 30_000 });
      assert.equal(r.status, 0);
      const f = readLog(log).find((e) => e.ev === "panel_frame");
      assert.ok(f, "panel_frame logged");
      assert.equal(f.compact, false, "never starts compact unless the user left it compact");
      assert.equal(f.reason, "too_small");
      assert.deepEqual(f.frame.slice(2), [420, 640]);
      assert.ok(f.titlebar_inset > 0 && f.titlebar_inset < 64, `title bar inset ${f.titlebar_inset}`);
      const saved = read("PanelFrame").stdout.trim().match(/\{\{[-\d.]+, [-\d.]+\}, \{([\d.]+), ([\d.]+)\}\}/);
      assert.deepEqual(saved?.slice(1).map(Number), [420, 640], "the tiny frame is replaced in the defaults");
    } finally {
      if (prevFrame.status === 0) spawnSync("defaults", ["write", SUITE, "PanelFrame", "-string", prevFrame.stdout.trim()]);
      else spawnSync("defaults", ["delete", SUITE, "PanelFrame"]);
      if (prevCompact.status === 0 && prevCompact.stdout.trim() === "1") spawnSync("defaults", ["write", SUITE, "PanelCompact", "-bool", "YES"]);
    }
  });

  test("native mic launch: the app's capture feeds the page (fixture), WebRTC offer works, no capture leaks", { timeout: 60_000 }, async () => {
    const log = path.join(tmp, "native.jsonl");
    const child = spawn(EXE, ["--port", String(port), "--k", daemon.issueLaunchCode(), "--data-dir", path.join(tmp, "data"),
      "--debug-log", log, "--test", "--probe-media", "--exit-after", "8"], {
      stdio: "ignore",
      env: { ...process.env, SOTTO_APP_MIC: "native", SOTTO_APP_MIC_FIXTURE: path.join(ROOT, "test/fixtures/ask-files.wav"), SOTTO_APP_MIC_FIXTURE_LEAD_MS: "0" },
    });
    const exited = new Promise((r) => child.on("exit", (c) => r(c)));
    assert.equal(await Promise.race([exited, sleep(30_000).then(() => "timeout")]), 0);
    const ev = readLog(log);
    const find = (name, pred = () => true) => ev.find((e) => e.ev === name && pred(e));
    assert.equal(find("mic_pref")?.pref, "native");
    const probe = find("probe")?.result;
    assert.ok(probe && !probe.error, probe?.error);
    assert.deepEqual(probe.offer, { opus: true, datachannel: true, audio: true });
    assert.equal(probe.withAEC.settings.sottoSource, "native");
    assert.equal(probe.withAEC.settings.echoCancellation, false);
    assert.equal(probe.withAEC.label, "Test fixture");
    assert.ok(find("bridge", (e) => e.kind === "mic" && e.ok === true && e.source === "native"), "bridge sees a native mic");
    assert.ok(!find("media_permission"), "WebKit capture never requested");
    const hidden = find("probe_hidden")?.result;
    assert.ok(hidden && !hidden.error, hidden?.error);
    assert.ok(hidden.peakRms > 0.02, `fixture speech reaches the page (peak RMS ${hidden.peakRms})`);
    assert.ok(hidden.gumMs < 1000, `${hidden.gumMs} ms`);
    const starts = ev.filter((e) => e.ev === "native_mic_start").length;
    const stops = ev.filter((e) => e.ev === "native_mic_stop").length;
    assert.ok(starts >= 3 && starts === stops, `${starts} starts, ${stops} stops`);
    const stats = ev.filter((e) => e.ev === "native_mic_stats" && e.transportP95Ms != null);
    assert.ok(stats.length > 0, "latency stats reported");
    const p95 = Math.max(...stats.map((e) => e.transportP95Ms));
    assert.ok(p95 < 60, `app -> page transport p95 ${p95} ms`);
    console.log(`# native mic: gUM ${hidden.gumMs} ms, transport p95 ${p95} ms, peak RMS ${hidden.peakRms.toFixed(3)}`);
  });

  test("silent native capture (exact zeros) falls back to WebKit's capture under the same track", { timeout: 60_000 }, async () => {
    // SOTTO_APP_MIC_FIXTURE=silence: the app's native capture sends only
    // exact zeros, what a stale app delivers (SPEC §6.16 "Silent mic").
    // mic.js must switch to WebKit's (mock) capture after 2 s.
    const log = path.join(tmp, "silent.jsonl");
    const child = spawn(EXE, ["--port", String(port), "--k", daemon.issueLaunchCode(), "--data-dir", path.join(tmp, "data"),
      "--debug-log", log, "--test", "--probe-media", "--probe-seconds", "4", "--exit-after", "12"], {
      stdio: "ignore",
      env: { ...process.env, SOTTO_APP_MIC: "native", SOTTO_APP_MIC_FIXTURE: "silence" },
    });
    const exited = new Promise((r) => child.on("exit", (c) => r(c)));
    assert.equal(await Promise.race([exited, sleep(40_000).then(() => "timeout")]), 0);
    const ev = readLog(log);
    const find = (name, pred = () => true) => ev.find((e) => e.ev === name && pred(e));
    const hidden = find("probe_hidden")?.result;
    assert.ok(hidden && !hidden.error, hidden?.error);
    const silent = find("native_mic_silent");
    assert.ok(silent, "the app logged why it left the native capture");
    assert.equal(silent.reason, "zeros");
    assert.ok(silent.ms >= 2000, `${silent.ms} ms of zeros`);
    assert.equal(silent.permission, "granted");
    assert.equal(silent.bundle_replaced, false);
    assert.ok(find("media_permission", (e) => e.granted === true), "WebKit capture requested for our origin");
    assert.equal(hidden.source, "webkit_fallback");
    assert.equal(hidden.trackState, "live", "the page's track never ended");
    assert.ok(hidden.lastPeakRms > 0, `sound after the fallback (last peak RMS ${hidden.lastPeakRms})`);
    const starts = ev.filter((e) => e.ev === "native_mic_start").length;
    const stops = ev.filter((e) => e.ev === "native_mic_stop").length;
    assert.ok(starts >= 1 && starts === stops, `${starts} starts, ${stops} stops`);
    console.log(`# silent native mic: fell back after ${silent.ms} ms, last peak RMS ${hidden.lastPeakRms.toFixed(3)}`);
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
    assert.ok(find("bridge", (e) => e.kind === "silenced" && e.ok === true), "test mode mutes the page's audio (never the speakers)");
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
    const r = spawnSync("open", ["-g", "-a", lsCopy(), "--env", "SOTTO_APP_TEST=1", "--env", `SOTTO_APP_DEBUG_LOG=${log}`,
      url(other, path.join(tmp, "data"))], { encoding: "utf8", timeout: 15_000 });
    assert.equal(r.status, 0, r.stderr);
    const launch = await waitFor(() => readLog(log).find((e) => e.ev === "launch"), 15_000, "launch");
    try {
      await waitFor(() => readLog(log).some((e) => e.ev === "url_rejected" && e.port === other), 10_000, "wrong port rejected");
      // A data dir without daemon.port, and one missing entirely, are rejected too.
      spawnSync("open", ["-g", "-a", lsCopy(), url(port, fakeD)], { timeout: 15_000 });
      spawnSync("open", ["-g", "-a", lsCopy(), `sotto://open?port=${port}`], { timeout: 15_000 });
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
    let r = open(["-g", "-a", lsCopy(), "--env", "SOTTO_APP_TEST=1", "--env", `SOTTO_APP_DEBUG_LOG=${log}`, url(daemon.issueLaunchCode())]);
    assert.equal(r.status, 0, r.stderr);
    const launch = await waitFor(() => readLog(log).find((e) => e.ev === "launch"), 15_000, "launch");
    try {
      await waitFor(() => readLog(log).some((e) => e.ev === "bridge" && e.kind === "status"), 15_000, "first page status");
      r = open(["-g", "-a", lsCopy(), url(daemon.issueLaunchCode())]);
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
