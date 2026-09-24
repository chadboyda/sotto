// Tests must be silent and mic-free: never the real microphone, never the
// real speakers. A live voice session on the same Mac hears anything a test
// plays through the speakers and sends it to the model as the user's speech.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { assertSilentChromeArgs, spawnSilentChrome, stopChrome, REQUIRED_FLAGS } from "../helpers/silent-chrome.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const listTests = (dir) => fs.readdirSync(path.join(ROOT, dir), { recursive: true })
  .filter((f) => /\.(m?js)$/.test(f)).map((f) => path.join(dir, f));

test("spawnSilentChrome: muted output, fake mic from a file, headless", () => {
  let got;
  spawnSilentChrome({ wav: "/tmp/x.wav", extra: ["--user-data-dir=/tmp/p", "http://127.0.0.1:1/"], spawnImpl: (bin, args) => { got = { bin, args }; } });
  for (const f of REQUIRED_FLAGS) assert.ok(got.args.some((a) => a.startsWith(f)), f);
  assert.ok(got.args.includes("--mute-audio"));
  assert.ok(got.args.includes("--use-file-for-fake-audio-capture=/tmp/x.wav%noloop"));
  assert.equal(got.args.at(-1), "http://127.0.0.1:1/");
});

test("spawnSilentChrome fails fast without a fake-mic file", () => {
  assert.throws(() => spawnSilentChrome({ wav: "", spawnImpl: () => assert.fail("spawned") }), /real mic/);
});

test("assertSilentChromeArgs refuses any missing silence / fake-device flag", () => {
  const good = ["--headless=new", "--mute-audio", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--use-file-for-fake-audio-capture=/a.wav"];
  assert.doesNotThrow(() => assertSilentChromeArgs(good));
  for (const drop of good) {
    assert.throws(() => assertSilentChromeArgs(good.filter((a) => a !== drop)), /real mic or speakers/, drop);
  }
  assert.throws(() => assertSilentChromeArgs([...good.slice(0, 4), "--use-file-for-fake-audio-capture="]), /missing/);
});

test("no test launches Chrome except through spawnSilentChrome", () => {
  for (const f of listTests("test")) {
    if (f === path.join("test", "helpers", "silent-chrome.js") || f === path.join("test", "scripts", "silent-tests.test.js")) continue;
    const src = read(f);
    assert.doesNotMatch(src, /Google Chrome\.app/, `${f}: use CHROME from test/helpers/silent-chrome.js`);
    assert.doesNotMatch(src, /spawn(Sync)?\(\s*CHROME\b/, `${f}: launch Chrome with spawnSilentChrome()`);
  }
  const launchers = listTests("test/e2e").filter((f) => /\bCHROME\b/.test(read(f)));
  assert.ok(launchers.length >= 2, "the e2e scripts launch Chrome");
  for (const f of launchers) assert.match(read(f), /spawnSilentChrome\(/, f);
});

test("every desktop-app launch in the tests is in test mode (fake audio, never the speakers)", () => {
  // Direct exec of the app binary: every spawn(EXE, [...]) with a daemon port
  // or a URL passes --test (the --selftest/--version probes open no audio).
  const app = read("test/app/app.test.mjs");
  const direct = [...app.matchAll(/spawn(?:Sync)?\(EXE,\s*\[([^\]]*)\]/g)].map((m) => m[1]).filter((a) => !/"--(selftest|version)"/.test(a));
  assert.ok(direct.length > 0);
  for (const args of direct) assert.match(args, /"--test"/, args);
  // The first LaunchServices launch of each test carries SOTTO_APP_TEST=1
  // (later `open` calls reach the same, already test-mode instance), and the
  // daemon-driven launches set it in the daemon env (window.js forwards it).
  assert.match(app, /"--env", "SOTTO_APP_TEST=1"/);
  assert.match(app, /SOTTO_APP_TEST: "1"/);
  for (const f of listTests("test/app")) {
    const src = read(f);
    if (/createDaemon\(/.test(src) && /SOTTO_BROWSER: "app"/.test(src)) assert.match(src, /SOTTO_APP_TEST: "1"/, f);
    // LaunchServices launches go to a test bundle id copy, never com.chadboyda.sotto.
    if (/"open", \["-g", "-a"/.test(src)) assert.match(src, /com\.chadboyda\.sotto\.apptest/, f);
  }
  // In test mode the app always builds the fake engine (output to a WAV, never
  // a CoreAudio unit) and never registers hotkeys or shows the panel.
  const dir = path.join(ROOT, "app-native/Sources/SottoApp");
  const src = fs.readdirSync(dir).filter((f) => f.endsWith(".swift")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  assert.match(src, /makeAudioIO\(test: options\.testMode\)/);
  assert.match(src, /if o\.testMode \{[^}]*o\.hidden = !o\.show[^}]*o\.hotkeys = false/);
});

// stopChrome: the profile is removed only after Chrome has exited (the
// layout test's old 500 ms timer raced Chrome's own writes: ENOTEMPTY in CI).

function fakeChild({ exitAfterMs = null, onSignal = () => {} } = {}) {
  const c = new EventEmitter();
  c.exitCode = null; c.signalCode = null; c.signals = [];
  c.kill = (sig) => {
    c.signals.push(sig);
    onSignal(sig);
    const ms = sig === "SIGKILL" ? 5 : exitAfterMs;
    if (ms != null) setTimeout(() => { c.signalCode = sig; c.emit("exit", null, sig); }, ms);
    return true;
  };
  return c;
}

test("stopChrome waits for Chrome to exit before removing the profile", async () => {
  const order = [];
  const child = fakeChild({ exitAfterMs: 50, onSignal: (s) => order.push(`kill:${s}`) });
  child.once("exit", () => order.push("exit"));
  await stopChrome(child, "/tmp/profile", { rm: (dir, o) => { order.push(`rm:${dir}`); assert.equal(o.recursive, true); assert.ok(o.maxRetries > 0); } });
  assert.deepEqual(order, ["kill:SIGTERM", "exit", "rm:/tmp/profile"]);
});

test("stopChrome escalates to SIGKILL when SIGTERM is ignored, and never throws", async () => {
  const child = fakeChild({ exitAfterMs: null });
  let removed = false;
  await stopChrome(child, "/tmp/p", { graceMs: 30, rm: () => { removed = true; throw Object.assign(new Error("ENOTEMPTY"), { code: "ENOTEMPTY" }); } });
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(removed, true, "removal attempted after the exit; its error is swallowed");
  const gone = fakeChild(); gone.exitCode = 0;
  await stopChrome(gone, null);
  assert.deepEqual(gone.signals, [], "an exited Chrome is not signalled");
});
