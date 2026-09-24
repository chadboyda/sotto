// daemon/chrome.js: window-opening modes (SPEC §6.12, §4.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { createChrome } from "../../daemon/chrome.js";

function make(env) {
  const spawned = [];
  const chrome = createChrome({
    dataDir: os.tmpdir(), port: 47999, env,
    spawn: (cmd, args) => { spawned.push([cmd, ...args]); return { on() {}, unref() {} }; },
    exists: () => true,
  });
  return { chrome, spawned };
}

test("SOTTO_BROWSER=none opens nothing", () => {
  const { chrome, spawned } = make({ SOTTO_BROWSER: "none" });
  assert.equal(chrome.open().mode, "none");
  assert.equal(spawned.length, 0);
});

test("SOTTO_NO_BROWSER=1 overrides SOTTO_BROWSER", () => {
  const { chrome, spawned } = make({ SOTTO_NO_BROWSER: "1", SOTTO_BROWSER: "chrome" });
  assert.equal(chrome.open().mode, "none");
  assert.equal(spawned.length, 0);
  assert.equal(chrome.launched, false);
});

test("default opens a Chrome --app window with the dedicated profile", () => {
  const { chrome, spawned } = make({});
  assert.equal(chrome.open().mode, "chrome");
  assert.equal(spawned.length, 1);
  const argv = spawned[0];
  assert.equal(argv[0], "open");
  assert.ok(argv.includes("--app=http://127.0.0.1:47999/"));
  assert.ok(argv.some((a) => a.startsWith("--user-data-dir=") && a.endsWith("/chrome")));
  assert.equal(chrome.launched, true);
});
