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

test("release-app.sh parses, is executable, and only uploads behind --upload", () => {
  const f = path.join(ROOT, "scripts/release-app.sh");
  assert.equal(spawnSync("/bin/bash", ["-n", f]).status, 0);
  assert.ok(fs.statSync(f).mode & 0o111);
  const src = fs.readFileSync(f, "utf8");
  const create = src.lastIndexOf("gh release create");
  assert.ok(create > 0 && src.lastIndexOf("if [[ $UPLOAD -eq 1 ]]", create) > 0, "gh release create sits behind --upload");
  assert.match(src, /notarytool submit .*--wait/);
  assert.match(src, /stapler staple/);
  // Refuses a version that does not match the manifests, before building anything.
  const r = spawnSync("/bin/bash", [f, "99.99.99"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /version/);
});

test("entitlements: the microphone and nothing else", { skip: process.platform !== "darwin" }, () => {
  const r = spawnSync("plutil", ["-convert", "json", "-o", "-", path.join(ROOT, "app/Sotto.entitlements")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { "com.apple.security.device.audio-input": true });
});

test("one version everywhere: package.json, plugin.json, Info.plist, daemon VERSION", { skip: process.platform !== "darwin" }, async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin/plugin.json"), "utf8")).version, pkg);
  const plist = spawnSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path.join(ROOT, "app/Info.plist")], { encoding: "utf8" }).stdout.trim();
  assert.equal(plist, pkg);
  const { VERSION } = await import("../../daemon/config.js");
  assert.equal(VERSION, pkg);
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

/** Run app/Resources/mic.js against a stub page and a fake `sottoMic` app side. */
function loadMic({ plan = { mode: "webkit", device: { id: "sotto-b", label: "MacBook Pro Microphone" } }, handler = true } = {}) {
  const asked = [];
  const gum = [];
  const state = { plan, started: [] };
  class FakeTrack {
    constructor(label) { this.label = label; this.readyState = "live"; this.l = {}; }
    getSettings() { return { deviceId: "webkit-id", echoCancellation: true, sampleRate: 48000 }; }
    stop() { this.readyState = "ended"; }
    addEventListener(t, fn) { (this.l[t] ||= []).push(fn); }
    dispatchEvent(e) { for (const fn of this.l[e.type] || []) fn(e); if (this.onended && e.type === "ended") this.onended(e); }
  }
  class FakeStream { constructor(tracks) { this.tracks = tracks; } getAudioTracks() { return this.tracks; } getTracks() { return this.tracks; } }
  class FakeNode { constructor() { this.port = { postMessage: () => {}, onmessage: null }; } connect(n) { return n; } disconnect() {} }
  class FakeAudioContext {
    constructor(o) { this.o = o; this.state = "running"; this.audioWorklet = { addModule: async () => {} }; this.destination = {}; }
    createMediaStreamDestination() { return { channelCount: 2, stream: new FakeStream([new FakeTrack("")]) }; }
    createGain() { return Object.assign(new FakeNode(), { gain: { value: 1 } }); }
    async resume() {}
    async close() { this.state = "closed"; }
  }
  const win = {
    webkit: {
      messageHandlers: handler ? {
        sottoMic: {
          postMessage: async (m) => {
            asked.push(m);
            if (m.op === "devices") return { default: { id: "sotto-a", label: "AirPods Max" }, inputs: [{ id: "sotto-a", label: "AirPods Max" }, { id: "sotto-b", label: "MacBook Pro Microphone" }] };
            if (m.op === "plan") return state.plan;
            if (m.op === "permission") return "granted";
            if (m.op === "start") { state.started.push(m); return { ok: true, sampleRate: 48000, label: m.device === "sotto-c" ? "USB Mic" : "MacBook Pro Microphone", device: m.device }; }
            return true;
          },
        },
      } : {},
    },
    navigator: {
      mediaDevices: {
        getUserMedia: async (c) => { gum.push(c); return new FakeStream([new FakeTrack("MacBook Pro Microphone")]); },
        enumerateDevices: async () => [
          { kind: "audioinput", deviceId: "default", label: "Default - MacBook Pro Microphone" },
          { kind: "audioinput", deviceId: "webkit-id", label: "MacBook Pro Microphone" },
          { kind: "audiooutput", deviceId: "out-1", label: "MacBook Pro Speakers" },
        ],
      },
      permissions: { query: async () => ({ state: "prompt" }) },
    },
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeNode,
    MediaStream: FakeStream,
    Blob: class {},
    URL: { createObjectURL: () => "blob:x" },
    Event: class { constructor(type) { this.type = type; } },
    DOMException: class extends Error { constructor(msg, name) { super(msg); this.name = name; } },
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    setInterval: () => 0,
    clearInterval: () => {},
    Date,
    Promise,
    Object,
    Math,
    Int16Array,
    String,
    Array,
  };
  win.window = win;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "app/Resources/mic.js"), "utf8"), win);
  return { win, asked, gum, state };
}

test("mic.js is inert without the app's sottoMic handler", async () => {
  const { win } = loadMic({ handler: false });
  assert.equal(win.__sottoMicFeed, undefined);
  const list = await win.navigator.mediaDevices.enumerateDevices();
  assert.equal(list[1].deviceId, "webkit-id");
});

test("mic.js lists the app's inputs (labelled) and keeps WebKit's outputs", async () => {
  const { win } = loadMic();
  const list = JSON.parse(JSON.stringify((await win.navigator.mediaDevices.enumerateDevices()).map((d) => [d.kind, d.deviceId, d.label])));
  assert.deepEqual(list, [
    ["audioinput", "default", "Default - AirPods Max"],
    ["audioinput", "sotto-a", "AirPods Max"],
    ["audioinput", "sotto-b", "MacBook Pro Microphone"],
    ["audiooutput", "out-1", "MacBook Pro Speakers"],
  ]);
  assert.equal((await win.navigator.permissions.query({ name: "microphone" })).state, "granted");
});

test("mic.js webkit plan: WebKit capture of the same device by label, reported under the app's id", async () => {
  const { win, gum } = loadMic();
  const s = await win.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, deviceId: { exact: "sotto-b" } } });
  assert.deepEqual(JSON.parse(JSON.stringify(gum[0].audio)), { echoCancellation: true, deviceId: { exact: "webkit-id" } });
  const st = s.getAudioTracks()[0].getSettings();
  assert.equal(st.deviceId, "sotto-b");
  assert.equal(st.echoCancellation, true);
  assert.equal(st.sottoSource, "webkit");
});

test("mic.js native plan: an app capture behind a worklet track; a route flip ends it", async () => {
  const { win, gum, asked, state } = loadMic({ plan: { mode: "native", device: { id: "sotto-b", label: "MacBook Pro Microphone" } } });
  const s = await win.navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: "sotto-b" } } });
  assert.equal(gum.length, 0, "WebKit capture never opened");
  assert.deepEqual({ ...state.started[0] }, { op: "start", id: 1, device: "sotto-b" });
  const t = s.getAudioTracks()[0];
  assert.equal(t.label, "MacBook Pro Microphone");
  assert.deepEqual([t.getSettings().echoCancellation, t.getSettings().sottoSource, t.getSettings().deviceId], [false, "native", "sotto-b"]);
  // Same mode, another device: moved under the same track.
  state.plan = { mode: "native", device: { id: "sotto-c", label: "USB Mic" } };
  await win.__sottoMicRoute();
  assert.equal(state.started.length, 2);
  assert.equal(t.readyState, "live");
  assert.equal(t.label, "USB Mic");
  // Speakers now: the track ends (the page re-opens the mic) and the app capture stops.
  let ended = 0;
  t.onended = () => ended++;
  state.plan = { mode: "webkit", device: { id: "sotto-b", label: "MacBook Pro Microphone" } };
  await win.__sottoMicRoute();
  assert.equal(t.readyState, "ended");
  assert.equal(ended, 1);
  assert.ok(asked.some((m) => m.op === "stop" && m.id === 1));
});

test("mic.js: an exact device the app does not have is OverconstrainedError (the page then retries)", async () => {
  const { win } = loadMic({ plan: { error: "NotFoundError" } });
  await assert.rejects(win.navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: "gone" } } }), { name: "OverconstrainedError" });
});
