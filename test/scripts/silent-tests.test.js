// Tests must be silent and mic-free: never the real microphone, never the
// real speakers. A live voice session on the same Mac hears anything a test
// plays through the speakers and sends it to the model as the user's speech.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSilentChromeArgs, spawnSilentChrome, REQUIRED_FLAGS } from "../helpers/silent-chrome.js";

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

test("every desktop-app launch in the tests is in test mode (mock mic, muted page)", () => {
  // Direct exec of the app binary with a page: must pass --test.
  const app = read("test/app/app.test.mjs");
  const direct = [...app.matchAll(/spawn\(EXE,\s*\[([^\]]*)\]/g)];
  assert.ok(direct.length > 0);
  for (const [, args] of direct) assert.match(args, /"--test"/);
  // First LaunchServices launch of each test carries SOTTO_APP_TEST=1 (later
  // `open` calls reach the same, already test-mode instance).
  assert.match(app, /"--env", "SOTTO_APP_TEST=1"/);
  assert.match(read("test/app/live.test.mjs"), /SOTTO_APP_TEST: "1"/);
  // The app's test mode forces the mock mic and adds the page-silencing script.
  const support = read("app/Sources/Support.swift");
  assert.match(support, /if o\.testMode \{[^}]*o\.mockCapture = true/);
  const panel = read("app/Sources/Panel.swift");
  assert.match(panel, /if Prefs\.testMode \{ ucc\.addUserScript\(WKUserScript\(source: PanelController\.testSilenceSource/);
});
