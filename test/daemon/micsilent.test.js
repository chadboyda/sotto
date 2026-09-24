// Silent mic and stale app (SPEC §6.16 "Silent mic", "Stale app"): the daemon
// side. A page that hears only digital silence in the desktop app gets a fresh
// app (when the running one has a replaced bundle) or Chrome; the voice
// reconnects in the new window instead of pausing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "../helpers/daemon-harness.js";
import { APP_MIC_BLOCKED } from "../../daemon/voice.js";

const tick = () => new Promise((r) => setImmediate(r));

/** The harness's fake window, extended with the desktop-app surface of window.js. */
function appWindow(h, { stale = [], launched = true } = {}) {
  const c = h.chrome;
  c.appLaunched = launched;
  c.stale = stale;
  c.replaced = [];
  c.quitStale = [];
  c.openArgs = [];
  c.staleApps = async () => c.stale;
  c.quitStaleApps = async (reason) => { c.quitStale.push(reason); return c.stale.length; };
  c.replaceApp = async (o) => {
    c.replaced.push(o);
    c.appLaunched = false;
    // The dying app's page sends its unload beacon while it quits.
    h.voice.handlePage({ type: "unload" });
    return 1;
  };
  c.open = function (o) { this.opened++; this.openArgs.push(o); return { mode: "app" }; };
  return c;
}

test("mic_silent in a stale app: the app restarts once and the live voice reconnects in it", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  const w = appWindow(h, { stale: [{ pid: 4957, startMs: 0 }] });
  h.voice.handlePage({ type: "mic_silent", input_label: "MacBook Pro Microphone", source: "native", ms: 4000, host: "app" });
  await tick();
  await tick();
  const logged = h.log.find("page.mic_silent");
  assert.equal(logged.length, 1);
  assert.equal(logged[0].lvl, "warn");
  assert.equal(logged[0].input, "MacBook Pro Microphone");
  assert.deepEqual(w.replaced, [{ reason: "mic_silent_stale_app", chrome: false }]);
  assert.equal(h.log.find("window.swap")[0].to, "app");
  assert.equal(h.voice.state, "reconnecting", "the unload during the swap did not pause the voice");
  assert.equal(h.log.find("pause").length, 0);
  assert.deepEqual(w.openArgs, [{ force: true }], "the new window opens at once");
  assert.ok(ws.sent.some((m) => m.type === "session.close"), "the old Live session is closed by the daemon");
  assert.equal(h.voice.status().last_error.code, "mic_silent");
});

test("mic_silent in a fresh app: the voice moves to Chrome", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  await h.goLive();
  const w = appWindow(h);
  h.voice.handlePage({ type: "mic_silent", input_label: "Chad's AirPods Max", source: "webkit_fallback", ms: 4000, host: "app" });
  await tick();
  await tick();
  assert.deepEqual(w.replaced, [{ reason: "mic_silent", chrome: true }]);
  assert.equal(h.log.find("window.swap")[0].to, "chrome");
  assert.deepEqual(w.openArgs, [{ force: true }]);
  // Within a minute a second report changes nothing (no window ping-pong).
  w.appLaunched = true;
  h.voice.handlePage({ type: "mic_silent", input_label: "x", host: "app" });
  await tick();
  assert.equal(w.replaced.length, 1);
});

test("mic_silent in Chrome is logged and reported, the window stays", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  await h.goLive();
  const w = appWindow(h, { launched: false });
  h.voice.handlePage({ type: "mic_silent", input_label: "OBSBOT Meet 2 Microphone", source: "", ms: 4100, host: "browser" });
  await tick();
  assert.equal(h.log.find("page.mic_silent")[0].host, "browser");
  assert.equal(w.replaced.length, 0);
  assert.match(h.voice.statusMessage(), /last error: The microphone \(OBSBOT Meet 2 Microphone\) delivered only silence/);
});

test("mic_fallback (native capture fell back to WebKit's) is logged with why", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  await h.goLive();
  h.voice.handlePage({ type: "mic_fallback", from: "native", to: "webkit", reason: "zeros", input_label: "MacBook Pro Microphone", ok: true, ms: 2000, permission: "granted", bundle_replaced: true });
  const l = h.log.find("page.mic_fallback");
  assert.equal(l.length, 1);
  assert.equal(l[0].lvl, "warn");
  assert.deepEqual([l[0].from, l[0].to, l[0].reason, l[0].ok, l[0].permission, l[0].bundle_replaced], ["native", "webkit", "zeros", true, "granted", true]);
});

test("mic_error in the app: /talk status says how to allow the microphone", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  h.on();
  h.voice.handlePage({ type: "mic_error", name: "NotAllowedError", message: "Permission denied by system", host: "app" });
  assert.equal(h.voice.state, "paused");
  assert.equal(h.voice.status().last_error.code, "mic_denied");
  assert.match(h.voice.statusMessage(), /Sotto can't use the microphone: allow it in System Settings > Privacy & Security > Microphone/);
  assert.equal(h.voice.status().last_error.message, APP_MIC_BLOCKED);
  const l = h.log.find("page.mic_error");
  assert.equal(l[0].lvl, "warn");
  assert.equal(l[0].host, "app");
  // Chrome keeps the browser's own message.
  h.voice.handlePage({ type: "mic_error", name: "NotAllowedError", message: "Permission denied", host: "browser" });
  assert.equal(h.voice.status().last_error.message, "Permission denied");
});

test("checkStaleApp: a stale app not hosting our page just quits; one hosting it is swapped", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const w = appWindow(h, { stale: [{ pid: 4957, startMs: 0 }], launched: false });
  assert.equal(await h.voice.checkStaleApp("start"), true);
  assert.deepEqual(w.quitStale, ["start"]);
  assert.equal(w.replaced.length, 0);
  // Hosting (launched by this daemon): the voice moves to a fresh app.
  await h.goLive();
  w.appLaunched = true;
  assert.equal(await h.voice.checkStaleApp("install"), true);
  assert.deepEqual(w.replaced, [{ reason: "stale_app_install", chrome: false }]);
  assert.equal(h.voice.state, "reconnecting");
  // Nothing stale: nothing happens.
  w.stale = [];
  w.appLaunched = true;
  assert.equal(await h.voice.checkStaleApp("install"), false);
  assert.equal(w.replaced.length, 1);
});

test("stale app after an install: swapped only at a quiet moment, never mid-conversation or mid-request", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  await h.goLive();
  const w = appWindow(h, { stale: [{ pid: 4957, startMs: 0 }] });
  // Just live (the user and voice talking): the install finishes, the swap waits.
  h.voice.appInstallResult({ ok: true });
  await tick();
  assert.equal(w.replaced.length, 0, "not swapped mid-conversation");
  const deferred = h.log.entries.find((e) => e.ev === "app.swap_deferred");
  assert.equal(deferred.reason, "install");
  assert.equal(deferred.blocker, "recent_speech");
  // Claude is working on a request: still waits, past the quiet period.
  h.voice.delegation.claudeBusy = true;
  await h.clock.advance(60_000);
  await tick();
  assert.equal(w.replaced.length, 0, "not swapped mid-request");
  // Request done and 45 s of quiet: swapped at the next check.
  h.voice.delegation.claudeBusy = false;
  await h.clock.advance(5000);
  await tick();
  await tick();
  assert.deepEqual(w.replaced, [{ reason: "stale_app_install", chrome: false }]);
  assert.equal(h.log.entries.filter((e) => e.ev === "app.swap_deferred").length, 1, "logged once");
});

test("stale app after an install: with voice off it is swapped at once", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const w = appWindow(h, { stale: [{ pid: 4957, startMs: 0 }], launched: false });
  h.voice.appInstallResult({ ok: true });
  await tick();
  await tick();
  assert.deepEqual(w.quitStale, ["install"]);
});
