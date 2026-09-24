// Desktop app sources checked without building (fast; runs in npm test).
// The build smoke test and launch checks are in test/app (npm run test:app).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("build-app.sh parses under /bin/bash and is executable", () => {
  const f = path.join(ROOT, "scripts/build-app.sh");
  assert.equal(spawnSync("/bin/bash", ["-n", f]).status, 0);
  assert.ok(fs.statSync(f).mode & 0o111);
});

test("Info.plist has the keys the app relies on", { skip: process.platform !== "darwin" }, () => {
  const r = spawnSync("plutil", ["-convert", "json", "-o", "-", path.join(ROOT, "app/Info.plist")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(r.stdout);
  assert.equal(p.CFBundleIdentifier, "com.chadboyda.sotto");
  assert.equal(p.CFBundleExecutable, "Sotto");
  assert.equal(p.LSUIElement, true);
  assert.equal(p.LSMultipleInstancesProhibited, true);
  assert.match(p.NSMicrophoneUsageDescription, /microphone/i);
  assert.deepEqual(p.CFBundleURLTypes[0].CFBundleURLSchemes, ["sotto"]);
  assert.equal(p.NSAppTransportSecurity.NSAllowsLocalNetworking, true);
});

/** Run app/Resources/bridge.js against a stub page and collect what it posts. */
function loadBridge() {
  const posted = [];
  const keys = [];
  const fetches = [];
  class FakeEventSource {
    constructor(url) { this.url = url; this.l = {}; }
    addEventListener(t, fn) { (this.l[t] ||= []).push(fn); }
    emit(t, data) { for (const fn of this.l[t] || []) fn({ data: JSON.stringify(data) }); }
  }
  class FakeChannel {
    constructor() { this.l = {}; }
    addEventListener(t, fn) { (this.l[t] ||= []).push(fn); }
    emit(t, data) { for (const fn of this.l[t] || []) fn({ data: JSON.stringify(data) }); }
  }
  class FakePC { createDataChannel() { return new FakeChannel(); } }
  const track = { getSettings: () => ({ echoCancellation: true, sampleRate: 48000, deviceId: "x" }) };
  const win = {
    webkit: { messageHandlers: { sottoHost: { postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))) } } },
    EventSource: FakeEventSource,
    RTCPeerConnection: FakePC,
    navigator: { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [track] }) } },
    location: { origin: "http://127.0.0.1:47999", pathname: "/", href: "http://127.0.0.1:47999/" },
    document: { dispatchEvent: (e) => keys.push(e) },
    KeyboardEvent: class { constructor(type, init) { Object.assign(this, { type }, init); } },
    fetch: async (url, init) => { fetches.push({ url, init }); return {}; },
    URL,
    JSON,
    Date,
  };
  win.window = win;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "app/Resources/bridge.js"), "utf8"), win);
  return { win, posted, keys, fetches };
}

test("bridge.js forwards state, never caption text or tokens", async () => {
  const { win, posted } = loadBridge();
  assert.deepEqual(posted[0], { kind: "hello", url: "http://127.0.0.1:47999/" });
  const es = new win.EventSource("/api/events?token=secret-page-token");
  es.emit("message", {
    type: "status",
    status: { state: "live", owner: { project: "sotto" }, live: { muted: true }, claude: { busy: true }, last_error: null },
  });
  es.emit("message", { type: "command", command: "close_window" });
  es.emit("message", { type: "activity", kind: "text", text: "private words" });
  const dc = new win.RTCPeerConnection().createDataChannel("oai-events");
  dc.emit("message", { type: "session.output_transcript.delta", delta: "private words" });
  dc.emit("message", { type: "session.input_transcript.delta", delta: "more private words" });
  dc.emit("message", { type: "session.input_audio.muted" });
  await win.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
  const kinds = posted.map((m) => m.kind);
  assert.deepEqual(kinds, ["hello", "status", "command", "speaking", "speaking", "muted", "mic"]);
  assert.deepEqual(posted[1], { kind: "status", state: "live", project: "sotto", muted: true, busy: true, error: "", error_message: "" });
  assert.deepEqual(posted[2], { kind: "command", command: "close_window" });
  assert.deepEqual(posted[3], { kind: "speaking", role: "assistant" });
  assert.deepEqual(posted.at(-1), { kind: "mic", ok: true, echoCancellation: true, sampleRate: 48000 });
  const all = JSON.stringify(posted);
  assert.ok(!all.includes("private words") && !all.includes("secret-page-token"));
});

test("bridge.js host API: mute through the page hotkey, stop through /api/page", () => {
  const { win, keys, fetches } = loadBridge();
  assert.equal(win.sottoHost.stopVoice(), false, "no token before the event stream opens");
  new win.EventSource("/api/events?token=tok123");
  win.sottoHost.toggleMute();
  assert.equal(keys[0].type, "keydown");
  assert.equal(keys[0].key, "m");
  assert.equal(win.sottoHost.stopVoice(), true);
  assert.equal(fetches[0].url, "/api/page");
  assert.equal(fetches[0].init.headers["X-Sotto-Page"], "tok123");
  assert.equal(fetches[0].init.body, JSON.stringify({ type: "stop" }));
});
