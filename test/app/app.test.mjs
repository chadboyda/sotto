// Native desktop app (SPEC §6.16, docs/NATIVE.md §5): build + bundle checks,
// the app's pure self-tests, and silent launches against a temp daemon.
// Run with `npm run test:app` (macOS with Xcode or the Command Line Tools).
// Not part of `npm test`: the first release build takes a minute of swift.
//
// Every launch is in test mode (--test / SOTTO_APP_TEST=1): fake audio (no
// CoreAudio unit, no microphone prompt, nothing played on the speakers), no
// status item, no global hotkeys, a hidden panel and the separate defaults
// suite com.chadboyda.sotto.test. LaunchServices launches use a copy with the
// bundle id com.chadboyda.sotto.apptest, so a URL never reaches the user's
// own Sotto. The user's daemon and installed app are never touched.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDaemon } from "../../daemon/index.js";
import { APP_BUNDLE, APP_EXE, appPaths, appSourceHash } from "../../daemon/window.js";
import { startFakeLiveServer } from "../helpers/fake-live-server.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SKIP = process.platform !== "darwin" ? "macOS only"
  : spawnSync("xcode-select", ["-p"]).status !== 0 ? "no Xcode or Command Line Tools" : false;
// A stable cache dir makes reruns incremental (build-app.sh hash check + SwiftPM scratch).
const OUT = path.join(os.tmpdir(), "sotto-native-app-test-build");
const BUNDLE = path.join(OUT, APP_BUNDLE);
const EXE = path.join(BUNDLE, "Contents", "MacOS", APP_EXE);
// Unique per run: LaunchServices hands `open -a <path> sotto://…` to an already
// running app with the same bundle id, so two concurrent test runs sharing one
// id steal each other's app (seen in integration). Never the user's own id.
const LS_ID = `com.chadboyda.sotto.apptest.${process.pid}`;
const TEST_SUITE = "com.chadboyda.sotto.test";
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

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
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Peak |sample| of a PCM16 WAV's data chunk (0 while the file is still being written). */
function wavPeak(file) {
  let b;
  try { b = fs.readFileSync(file); } catch { return 0; }
  let off = 12;
  while (off + 8 <= b.length) {
    const size = b.readUInt32LE(off + 4);
    if (b.toString("ascii", off, off + 4) === "data") {
      let peak = 0;
      for (let i = off + 8; i + 1 < Math.min(b.length, off + 8 + size); i += 2) peak = Math.max(peak, Math.abs(b.readInt16LE(i)));
      return peak;
    }
    off += 8 + size + (size & 1);
  }
  return 0;
}
const selftest = (name, arg, exe = EXE) => {
  const r = spawnSync(exe, ["--selftest", name, ...(arg === undefined ? [] : [JSON.stringify(arg)])], { encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  return JSON.parse(r.stdout);
};
const plistKey = (bundle, k) => spawnSync("plutil", ["-extract", k, "raw", "-o", "-", path.join(bundle, "Contents/Info.plist")], { encoding: "utf8" }).stdout.trim();

/**
 * Copy the test build under the test bundle id (LaunchServices routes a
 * sotto:// URL to a RUNNING app with the same id, whatever bundle path `-a`
 * names: with the production id, the user's live Sotto would get the test's
 * URL). `dest` is the bundle path; `stampFrom` also copies build.json so
 * the daemon's chooser sees a ready app in that dir.
 */
function testCopy(dest, { stampFrom } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    assert.equal(r.status, 0, `${cmd} ${args.join(" ")}: ${r.stderr}`);
  };
  run("ditto", [BUNDLE, dest]);
  run("plutil", ["-replace", "CFBundleIdentifier", "-string", LS_ID, path.join(dest, "Contents/Info.plist")]);
  run("codesign", ["--force", "--sign", "-", "--identifier", LS_ID, dest]);
  if (stampFrom) fs.copyFileSync(path.join(stampFrom, "build.json"), path.join(path.dirname(dest), "build.json"));
  return dest;
}

describe("native desktop app", { skip: SKIP }, () => {
  let tmp;
  let daemon;
  let port;
  let D;
  const registered = [];

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sotto-native-app-test-")));
    D = path.join(tmp, "data");
    port = await freePort();
    daemon = createDaemon({
      dataDir: D, port, pluginRoot: ROOT,
      env: { SOTTO_BROWSER: "none", SOTTO_KEYCHAIN_SERVICE: `sotto-apptest-${process.pid}` }, daemonKey: "k".repeat(64),
    });
    await daemon.listen();
  });

  after(async () => {
    for (const b of registered) spawnSync(LSREGISTER, ["-u", b]);
    await daemon?.close();
    if (tmp && !process.env.SOTTO_E2E_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
    else if (tmp) console.log(`# kept ${tmp}`);
  });

  test("build-app.sh builds a signed bundle from app-native with the required Info.plist keys", { timeout: 600_000 }, () => {
    const t0 = Date.now();
    const r = spawnSync("/bin/bash", [path.join(ROOT, "scripts/build-app.sh"), "--out", OUT], { encoding: "utf8" });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.ok(fs.existsSync(EXE));
    assert.equal(plistKey(BUNDLE, "CFBundleIdentifier"), "com.chadboyda.sotto");
    assert.equal(plistKey(BUNDLE, "CFBundleExecutable"), APP_EXE);
    assert.equal(plistKey(BUNDLE, "LSUIElement"), "true");
    assert.equal(plistKey(BUNDLE, "LSMultipleInstancesProhibited"), "true");
    assert.equal(plistKey(BUNDLE, "LSMinimumSystemVersion"), "14.0");
    assert.match(plistKey(BUNDLE, "NSMicrophoneUsageDescription"), /microphone/i);
    assert.equal(plistKey(BUNDLE, "CFBundleURLTypes.0.CFBundleURLSchemes.0"), "sotto");
    assert.equal(plistKey(BUNDLE, "NSAppTransportSecurity.NSAllowsLocalNetworking"), "true");
    // No web resources any more: the native app hosts no page.
    assert.ok(!fs.existsSync(path.join(BUNDLE, "Contents/Resources/bridge.js")));
    const src = JSON.parse(fs.readFileSync(path.join(BUNDLE, "Contents/Resources/sotto-source.json"), "utf8"));
    assert.equal(src.hash, appSourceHash(ROOT), "the bundle's hash is the daemon's appSourceHash");
    assert.equal(src.version, plistKey(BUNDLE, "CFBundleShortVersionString"));
    const cs = spawnSync("codesign", ["--verify", "--strict", BUNDLE], { encoding: "utf8" });
    assert.equal(cs.status, 0, cs.stderr);
    const req = spawnSync("codesign", ["-d", "-r-", BUNDLE], { encoding: "utf8" });
    assert.match(req.stdout + req.stderr, /designated => identifier "com\.chadboyda\.sotto"/);
    const stamp = JSON.parse(fs.readFileSync(path.join(OUT, "build.json"), "utf8"));
    assert.equal(stamp.ok, true);
    assert.equal(stamp.hash, src.hash);
    // SwiftPM's scratch dir stays in the output dir, never in the plugin.
    assert.ok(fs.existsSync(path.join(OUT, ".swiftpm-build")));
    console.log(`# build: ${((Date.now() - t0) / 1000).toFixed(1)} s (${stamp.seconds} s swift when it last compiled)`);

    // Incremental: an unchanged tree is a no-op (no compile, stamp untouched).
    const t1 = Date.now();
    const again = spawnSync("/bin/bash", [path.join(ROOT, "scripts/build-app.sh"), "--out", OUT], { encoding: "utf8" });
    assert.equal(again.status, 0);
    assert.match(again.stdout, /up to date/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(OUT, "build.json"), "utf8")), stamp);
    console.log(`# no-op rebuild: ${Date.now() - t1} ms`);
    assert.equal(spawnSync("/bin/bash", [path.join(ROOT, "scripts/build-app.sh"), "--out", OUT, "--check"]).status, 0);
    const printed = spawnSync("/bin/bash", [path.join(ROOT, "scripts/build-app.sh"), "--print-hash"], { encoding: "utf8" }).stdout.trim();
    assert.equal(printed, src.hash);
  });

  test("--version and --selftest bundle describe the build", () => {
    const v = JSON.parse(spawnSync(EXE, ["--version"], { encoding: "utf8", timeout: 10_000 }).stdout);
    assert.equal(v.protocol, 1);
    assert.equal(v.version, plistKey(BUNDLE, "CFBundleShortVersionString"));
    const b = selftest("bundle");
    assert.deepEqual({ id: b.id, schemes: b.schemes, ui: b.ui_element, mic: b.mic_usage, protocol: b.protocol },
      { id: "com.chadboyda.sotto", schemes: ["sotto"], ui: true, mic: true, protocol: 1 });
    assert.equal(b.source_hash, appSourceHash(ROOT));
    assert.equal(spawnSync(EXE, ["--selftest", "no-such-check"], { timeout: 10_000 }).status, 2);
  });

  test("--selftest panel-frame: a tiny, missing or off-screen saved frame opens the full 420x640 panel", () => {
    const ev = (saved, screens = [[0, 77, 1440, 798]]) => selftest("panel-frame", { saved, screens });
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
    // A second screen: a frame on it stays there.
    assert.equal(ev("{{-1500, 100}, {420, 640}}", [[0, 0, 1440, 875], [-1920, 0, 1920, 1080]]).reason, "saved");
  });

  test("--selftest url: sotto:// parsing and the daemon.port ownership rule", () => {
    const own = path.join(tmp, "own");
    fs.mkdirSync(own, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(own, "daemon.port"), "47123\n");
    const u = (url) => selftest("url", { url });
    const k = "a".repeat(32);
    assert.deepEqual(u(`sotto://open?port=47123&k=${k}&data=${encodeURIComponent(own)}`),
      { cmd: "open", port: 47123, has_code: true, data: own, owned: true });
    assert.equal(u(`sotto://open?port=47124&k=${k}&data=${encodeURIComponent(own)}`).owned, false, "another port");
    assert.equal(u(`sotto://open?port=47123&data=${encodeURIComponent(path.join(tmp, "nope"))}`).owned, false, "no daemon.port");
    assert.equal(u("sotto://open?port=47123").owned, false, "no data dir");
    assert.equal(u("sotto://open?port=47123&data=relative/dir").data, null, "relative data dirs are dropped");
    assert.equal(u("sotto://open?port=80").cmd, null, "privileged port");
    assert.equal(u("sotto://open?port=47123&k=xyz").has_code, false, "a malformed code is dropped");
    // A symlinked daemon.port is refused, even with the right content.
    const sym = path.join(tmp, "sym");
    fs.mkdirSync(sym, { recursive: true });
    fs.symlinkSync(path.join(own, "daemon.port"), path.join(sym, "daemon.port"));
    assert.equal(u(`sotto://open?port=47123&data=${encodeURIComponent(sym)}`).owned, false, "symlink");
    assert.deepEqual(u("sotto://close?port=47123"), { cmd: "close", port: 47123 });
    assert.deepEqual(u("sotto://show"), { cmd: "show" });
    assert.deepEqual(u("https://example.com/"), { cmd: null });
    assert.deepEqual(u("sotto://format-disk"), { cmd: null });
  });

  test("--selftest icon: the menu-bar icon follows the voice state", () => {
    const ic = (o) => selftest("icon", o).icon;
    assert.equal(ic({ attached: false, state: "live" }), "off", "no daemon yet");
    assert.equal(ic({ link_up: false, state: "live" }), "connecting", "link down, reconnecting");
    assert.equal(ic({ link_failed: true, state: "live" }), "error");
    assert.equal(ic({ state: "off" }), "off");
    assert.equal(ic({ state: "waiting_page" }), "connecting");
    assert.equal(ic({ state: "connecting" }), "connecting");
    assert.equal(ic({ state: "sleeping" }), "sleeping");
    assert.equal(ic({ state: "paused" }), "paused");
    assert.equal(ic({ state: "paused", error: "idle" }), "paused", "idle pause is not an error");
    assert.equal(ic({ state: "paused", error: "key_invalid" }), "error");
    assert.equal(ic({ state: "live" }), "listening");
    assert.equal(ic({ state: "live", muted: true, busy: true }), "muted");
    assert.equal(ic({ state: "live", busy: true }), "working");
    assert.equal(ic({ state: "live", busy: true, last_assistant: 999.5, now: 1000 }), "assistantSpeaking");
    assert.equal(ic({ state: "live", last_user: 999.5, now: 1000 }), "userSpeaking");
    assert.equal(ic({ state: "live", last_user: 998, now: 1000 }), "listening", "speaking decays after 1.2 s");
    assert.equal(ic({ state: "live", mic_failed: true }), "error");
    const all = selftest("icon", { state: "live", muted: true });
    assert.equal(all.label, "Muted");
    assert.equal(all.symbol, "mic.slash.fill");
  });

  test("--selftest ui-snapshot renders the SwiftUI panel offscreen (no window)", { timeout: 60_000 }, () => {
    const dir = path.join(tmp, "ui");
    const out = selftest("ui-snapshot", undefined, EXE);
    assert.equal(out.ok, true, out.error);
    fs.rmSync(out.dir, { recursive: true, force: true });
    const r = spawnSync(EXE, ["--selftest", "ui-snapshot", dir], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".png"));
    assert.ok(files.length >= 20, `${files.length} snapshots`);
    assert.ok(files.some((f) => /listening--dark/.test(f)) && files.some((f) => /listening--light/.test(f)));
    for (const f of files.slice(0, 3)) assert.ok(fs.statSync(path.join(dir, f)).size > 5000, f);
  });

  test("--selftest hotkey and options: defaults, test mode from argv or env", () => {
    assert.deepEqual(selftest("hotkey", { spec: "opt+cmd+m" }), { ok: true, display: "⌥⌘M", key: "m" });
    assert.deepEqual(selftest("hotkey", { spec: "opt+cmd+t" }), { ok: true, display: "⌥⌘T", key: "t" });
    assert.equal(selftest("hotkey", { spec: "m" }).ok, false, "a bare letter is never taken system-wide");
    const o = (argv, env) => selftest("options", { argv, env });
    const t = o(["--test", "--port", "47000", "--k", "b".repeat(32), "--data-dir", "/tmp/x", "--exit-after", "2"]);
    assert.deepEqual({ test: t.test, hidden: t.hidden, hotkeys: t.hotkeys, port: t.port, code: t.has_code, data: t.data, exit: t.exit_after },
      { test: true, hidden: true, hotkeys: false, port: 47000, code: true, data: "/tmp/x", exit: 2 });
    const e = o([], { SOTTO_APP_TEST: "1", SOTTO_APP_DEBUG_LOG: "/tmp/l.jsonl" });
    assert.deepEqual({ test: e.test, hidden: e.hidden, hotkeys: e.hotkeys, log: e.debug_log }, { test: true, hidden: true, hotkeys: false, log: "/tmp/l.jsonl" });
    const prod = o(["-psn_0_123"]);
    assert.deepEqual({ test: prod.test, hidden: prod.hidden, hotkeys: prod.hotkeys }, { test: false, hidden: false, hotkeys: true });
    assert.deepEqual(prod.wants_audio, ["connecting", "live", "reconnecting", "sleeping"], "uplink states (docs/NATIVE.md §2.2)");
  });

  test("launch with a tiny saved frame opens the full panel and replaces the bad frame", { timeout: 60_000 }, () => {
    const read = (key) => spawnSync("defaults", ["read", TEST_SUITE, key], { encoding: "utf8" });
    const prevFrame = read("PanelFrame");
    const prevCompact = read("PanelCompact");
    spawnSync("defaults", ["write", TEST_SUITE, "PanelFrame", "-string", "{{200, 300}, {250, 44}}"]);
    spawnSync("defaults", ["delete", TEST_SUITE, "PanelCompact"]);
    try {
      const log = path.join(tmp, "frame.jsonl");
      const r = spawnSync(EXE, ["--test", "--debug-log", log, "--exit-after", "1"], { stdio: "ignore", timeout: 30_000 });
      assert.equal(r.status, 0);
      const f = readLog(log).find((e) => e.ev === "panel_frame");
      assert.ok(f, "panel_frame logged");
      assert.equal(f.compact, false, "never starts compact unless the user left it compact");
      assert.equal(f.reason, "too_small");
      assert.deepEqual(f.frame.slice(2), [420, 640]);
      const saved = read("PanelFrame").stdout.trim().match(/\{\{[-\d.]+, [-\d.]+\}, \{([\d.]+), ([\d.]+)\}\}/);
      assert.deepEqual(saved?.slice(1).map(Number), [420, 640], "the tiny frame is replaced in the test defaults");
      assert.ok(!readLog(log).some((e) => e.ev === "hotkeys"), "no global hotkeys in test mode");
    } finally {
      if (prevFrame.status === 0) spawnSync("defaults", ["write", TEST_SUITE, "PanelFrame", "-string", prevFrame.stdout.trim()]);
      else spawnSync("defaults", ["delete", TEST_SUITE, "PanelFrame"]);
      if (prevCompact.status === 0 && prevCompact.stdout.trim() === "1") spawnSync("defaults", ["write", TEST_SUITE, "PanelCompact", "-bool", "YES"]);
    }
  });

  test("direct launch: bootstraps with page.secret, connects /api/native, never logs a secret", { timeout: 60_000 }, async () => {
    const log = path.join(tmp, "direct.jsonl");
    const child = spawn(EXE, ["--port", String(port), "--data-dir", D, "--debug-log", log, "--test", "--exit-after", "4"], { stdio: "ignore" });
    const exited = new Promise((r) => child.on("exit", (c) => r(c)));
    assert.equal(await Promise.race([exited, sleep(30_000).then(() => "timeout")]), 0);
    const ev = readLog(log);
    const find = (name, pred = () => true) => ev.find((e) => e.ev === name && pred(e));
    assert.equal(find("launch")?.test, true);
    assert.ok(find("open", (e) => e.port === port && e.source === "argv"), "argv launch opens the link");
    assert.ok(find("link.connect"), "the link starts");
    if (daemon.native) {
      // B1's endpoint is wired: the full handshake.
      assert.ok(find("welcome"), "hello -> welcome over /api/native");
    }
    assert.ok(!ev.some((e) => e.ev === "audio_start_failed"), "fake audio never fails");
    const text = fs.readFileSync(log, "utf8");
    for (const secret of [daemon.pageToken, daemon.pageSecret, daemon.daemonKey]) {
      if (secret) assert.ok(!text.includes(secret), "no token, secret or key in the app log");
    }
  });

  test("a sotto://open URL is ignored unless D/daemon.port records its port", { timeout: 60_000 }, async () => {
    // Any web page can fire this URL; the app must not connect its microphone
    // to (and send the page secret to) whatever listens on another port.
    const bundle = testCopy(path.join(tmp, "ls", APP_BUNDLE));
    registered.push(bundle);
    const log = path.join(tmp, "reject.jsonl");
    const other = await freePort();
    const fakeD = path.join(tmp, "fake-data");
    fs.mkdirSync(fakeD, { recursive: true });
    const url = (p, d) => `sotto://open?port=${p}&k=${"a".repeat(32)}&data=${encodeURIComponent(d)}`;
    const r = spawnSync("open", ["-g", "-a", bundle, "--env", "SOTTO_APP_TEST=1", "--env", `SOTTO_APP_DEBUG_LOG=${log}`,
      url(other, D)], { encoding: "utf8", timeout: 15_000 });
    assert.equal(r.status, 0, r.stderr);
    const launch = await waitFor(() => readLog(log).find((e) => e.ev === "launch"), 15_000, "launch");
    try {
      assert.equal(launch.bundle, LS_ID, "the test copy, never the production id");
      await waitFor(() => readLog(log).some((e) => e.ev === "url_rejected" && e.port === other), 10_000, "wrong port rejected");
      // A data dir without daemon.port, and one missing entirely, are rejected too.
      spawnSync("open", ["-g", "-a", bundle, url(port, fakeD)], { timeout: 15_000 });
      spawnSync("open", ["-g", "-a", bundle, `sotto://open?port=${port}`], { timeout: 15_000 });
      await waitFor(() => readLog(log).filter((e) => e.ev === "url_rejected").length >= 3, 10_000, "all three rejected");
      assert.equal(readLog(log).filter((e) => e.ev === "open" || e.ev === "link.connect").length, 0, "no link opened");
      assert.equal(readLog(log).filter((e) => e.ev === "launch").length, 1, "one process for every URL (single instance)");
    } finally {
      if (pidAlive(launch.pid)) process.kill(launch.pid, "SIGTERM");
      await waitFor(() => !pidAlive(launch.pid), 10_000, "app exit");
    }
  });

  test("chooser -> sotto://open -> link -> welcome -> fake Live session -> output WAV -> mute round trip -> close_window quits", { timeout: 120_000 }, async (t) => {
    if (!daemon.native) return t.skip("needs the daemon's /api/native endpoint (docs/NATIVE.md B1)");
    // The model's voice: 1 s of a loud tone from the fake Live server.
    const greet = Buffer.alloc(24000 * 2);
    for (let i = 0; i < 24000; i++) greet.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 220 * i) / 24000)), i * 2);
    const live = await startFakeLiveServer({ key: "sk-test-key", outputPcm: greet });
    t.after(() => live.close());
    // A second daemon that really opens windows: SOTTO_BROWSER=app through the
    // real chooser (daemon/window.js), with a test-id copy installed at D2/app.
    const D2 = path.join(tmp, "chooser");
    const p = appPaths(D2, ROOT);
    const bundle = testCopy(p.bundle, { stampFrom: OUT });
    registered.push(bundle);
    const appLog = path.join(tmp, "chooser.jsonl");
    const outWav = path.join(tmp, "chooser-out.wav");
    const port2 = await freePort();
    const d = createDaemon({
      dataDir: D2, port: port2, pluginRoot: ROOT, daemonKey: "c".repeat(64),
      env: {
        SOTTO_BROWSER: "app", SOTTO_APP_TEST: "1", SOTTO_APP_DEBUG_LOG: appLog, SOTTO_APP_OUT_WAV: outWav,
        SOTTO_APP_MIC_FIXTURE: path.join(ROOT, "test/fixtures/ask-files.wav"), SOTTO_APP_MIC_FIXTURE_LEAD_MS: "300",
        SOTTO_APP_TEST_MUTE_AFTER_MS: "2500", SOTTO_APP_DOWNLOAD: "0", SOTTO_VOCAB: "0",
        OPENAI_API_KEY: "sk-test-key", SOTTO_OPENAI_BASE: live.base, SOTTO_KEYCHAIN_SERVICE: `sotto-apptest-${process.pid}`,
      },
    });
    await d.listen();
    const ctl = (body) => fetch(`http://127.0.0.1:${port2}/control`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Sotto-Key": d.daemonKey }, body: JSON.stringify(body),
    }).then((r) => r.json());
    let pid = null;
    try {
      const on = await ctl({ action: "on", session: { session_id: "apptest", socket: "/tmp/none.sock", token: "t", cwd: ROOT, project_dir: ROOT }, config: { open_browser: true } });
      assert.equal(on.ok, true, on.message);
      const launch = await waitFor(() => readLog(appLog).find((e) => e.ev === "launch"), 20_000, "app launch via the chooser");
      pid = launch.pid;
      assert.equal(launch.bundle, LS_ID);
      assert.equal(launch.test, true);
      await waitFor(() => readLog(appLog).some((e) => e.ev === "open" && e.source === "url" && e.has_code), 10_000, "sotto://open with a launch code");
      await waitFor(() => readLog(appLog).some((e) => e.ev === "welcome"), 15_000, "welcome");
      assert.match(fs.readFileSync(path.join(D2, "logs", "daemon.log"), "utf8"), /"ev":"window.choose"[^\n]*"mode":"app"/);
      await waitFor(() => d.voice.state === "live", 15_000, "live on the fake session");
      assert.ok(readLog(appLog).some((e) => e.ev === "capture" && e.to === "full"), "capture follows the state");
      const s1 = live.last();
      assert.equal(s1.start.audio.format.rate, 24000);
      await waitFor(() => s1.inputFrames >= 50, 10_000, "continuous mic frames reach the Live session");
      // The model's voice lands in the app's output WAV (FakeAudioIO writes it every second).
      await waitFor(() => fs.existsSync(outWav) && wavPeak(outWav) > 1200, 15_000, "speech in the output WAV");
      // Mute round trip: the app sends cmd mute, the daemon mutes the Live input and answers.
      await waitFor(() => readLog(appLog).some((e) => e.ev === "cmd_result" && e.name === "mute"), 10_000, "mute result");
      assert.ok(readLog(appLog).some((e) => e.ev === "cmd_result" && e.name === "mute" && e.ok === true), "mute ok");
      await waitFor(() => s1.events.some((e) => e.type === "session.input_audio.mute") || live.last().events.some((e) => e.type === "session.input_audio.mute"), 5_000, "Live input muted");
      await waitFor(() => d.voice.pageStatus?.().live?.muted === true || readLog(appLog).some((e) => e.ev === "icon" && e.state === "muted"), 5_000, "muted state");
      // Voice off: close_window stops audio and hides the panel, then the app quits.
      const off = await ctl({ action: "off" });
      assert.equal(off.ok, true);
      await waitFor(() => readLog(appLog).some((e) => e.ev === "close_window"), 10_000, "close_window handled");
      await waitFor(() => !pidAlive(pid), 10_000, "app quits after voice off");
      const ev = readLog(appLog);
      assert.ok(ev.some((e) => e.ev === "capture" && e.to === "off"), "audio stopped");
      assert.ok(!ev.some((e) => e.ev === "audio_start_failed" || e.ev === "audio_error"));
      assert.ok(!fs.readFileSync(appLog, "utf8").includes("sk-test-key"), "the key never reaches the app log");
    } finally {
      if (pid && pidAlive(pid)) process.kill(pid, "SIGTERM");
      await ctl({ action: "off" }).catch(() => {});
      await d.close();
    }
  });
});
