// Native app sessions (docs/NATIVE.md §4): the daemon owns the Live primary
// WebSocket; the app is attached through NativeController. Fake clock, fake
// WebSocket, a fake link (no sockets): every lifecycle path, the fan-out and
// every §3.3 command.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHarness, SESSION } from "../helpers/daemon-harness.js";
import { FRAME_BYTES, FLAG, PROTOCOL, COMMANDS } from "../../daemon/native-proto.js";
import { buildPrimaryStart } from "../../daemon/live-ws.js";
import { pcm16ToWav } from "../../daemon/preview.js";

const appends = (ws, kind) => ws.sent.filter((e) => e.type === `session.${kind}.append`);
const audioAppends = (ws) => ws.sent.filter((e) => e.type === "session.input_audio.append");

function fakeLink(id = 1) {
  return {
    id, clientInfo: { version: "0.3.0", test: true }, sent: [], audio: [], closed: null, bufferedAmount: 0,
    sendJson(o) { this.sent.push(o); return true; },
    sendAudio(pcm, { flags = 0 } = {}) { this.audio.push({ pcm: Buffer.from(pcm), flags }); return true; },
    close(code, reason) { this.closed = { code, reason }; },
    of(type) { return this.sent.filter((m) => m.type === type); },
  };
}

function tone(ms, amp = 8000, hz = 220) {
  const n = Math.round((ms / 1000) * 24000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * hz * i) / 24000)), i * 2);
  return b;
}

async function setup(t, opts = {}) {
  const h = await makeHarness(opts);
  t.after(() => h.cleanup());
  h.ctl = h.d.nativeCtl;
  h.attach = async (link = fakeLink()) => {
    const welcome = h.ctl.attach(link, link.clientInfo);
    link.sendJson({ type: "welcome", ...welcome });
    h.ctl.afterWelcome(link);
    await h.clock.advance(0);
    return { link, welcome };
  };
  /** The newest primary socket: open it and answer session.started. */
  h.startPrimary = async (id = `live_prim_${h.WS.instances.length}`) => {
    await h.clock.advance(0);
    const ws = h.WS.last();
    assert.equal(ws.url, "wss://api.openai.com/v1/live/sessions");
    ws.open();
    ws.receive({ type: "session.started", session: { id, expires_at: Math.floor(h.clock.now() / 1000) + 7200 } });
    await h.clock.advance(0);
    return ws;
  };
  h.mic = (link, pcm = Buffer.alloc(FRAME_BYTES), flags = FLAG.FAKE) => h.ctl.onMicFrame(link, { kind: 1, flags, seq: 0, tsNs: 0n, pcm });
  return h;
}

test("buildPrimaryStart: the session object minus client/transport, plus audio.format", () => {
  const s = buildPrimaryStart({ instructions: "I", seed: [{ role: "developer", text: "seed" }], voice: "cedar" });
  assert.equal(s.type, "session.start");
  assert.equal(s.session.client, undefined);
  assert.equal(s.transport, undefined);
  assert.deepEqual(s.session.audio, { format: { type: "audio/pcm", rate: 24000 }, output: { voice: "cedar" } });
  assert.deepEqual(s.session.delegation, { type: "client" });
  assert.equal(s.session.store, false);
  assert.equal(s.session.input[0].content[0].text, "seed");
});

test("start: /talk on, the app says hello, the daemon opens a primary session itself (no page)", async (t) => {
  const h = await setup(t);
  h.on();
  assert.equal(h.voice.state, "waiting_page");
  assert.equal(h.chrome.opened, 1, "the window (the app) is launched as today");
  const { link, welcome } = await h.attach();
  assert.equal(welcome.protocol, PROTOCOL);
  assert.equal(welcome.status.audio_client, "app");
  assert.deepEqual(Object.keys(welcome.settings), ["voices", "personas", "window", "policies", "wake_sensitivities", "data_dir", "version"]);
  // The persona picker's list (§3.1): summaries, never a persona's body.
  const ps = welcome.settings.personas;
  assert.deepEqual(Object.keys(ps), ["personas", "current", "use_voice", "live", "live_persona"]);
  assert.equal(ps.current, "sotto");
  assert.equal(ps.use_voice, true);
  assert.ok(ps.personas.length >= 8);
  assert.deepEqual(Object.keys(ps.personas[0]), ["id", "name", "description", "voice", "source"]);
  assert.ok(ps.personas.every((p) => typeof p.description === "string" && p.description.length > 0 && !("body" in p)));
  assert.equal(link.sent[0].type, "welcome", "nothing before welcome");
  assert.equal(h.voice.state, "connecting");
  assert.equal(h.fetchCalls.length, 0, "no SDP POST");
  const ws = await h.startPrimary("live_p1");
  const start = ws.sent[0];
  assert.equal(start.type, "session.start");
  assert.equal(start.session.audio.format.rate, 24000);
  assert.match(start.session.input[0].content[0].text, /Project: proj-a/);
  assert.equal(h.voice.state, "live");
  assert.equal(h.voice.live.id, "live_p1");
  assert.equal(appends(ws, "instructions").length, 1, "greeting");
  assert.equal(h.voice.counters.sessions_created, 1);
  assert.equal(h.commands().filter((c) => c.startsWith("connect")).length, 0, "no SSE connect");
  // status fan-out: a full snapshot per change, audio_client app.
  const st = link.of("status").at(-1).status;
  assert.equal(st.state, "live");
  assert.equal(st.audio_client, "app");
  assert.equal(st.live.session_id, "live_p1");
  const live = link.of("live").map((m) => m.event.type);
  assert.ok(live.includes("session.started"));
});

test("pacer: mic frames stream continuously as input_audio.append; silence fills a lagging app; mute zeroes", async (t) => {
  const h = await setup(t);
  h.on();
  const { link } = await h.attach();
  const ws = await h.startPrimary();
  assert.equal(audioAppends(ws).length, 0, "nothing before frames or 60 ms lag");
  const speech = tone(20);
  for (let i = 0; i < 5; i++) { h.mic(link, speech); await h.clock.advance(20); }
  const got = audioAppends(ws);
  assert.ok(got.length >= 5, `sent ${got.length}`);
  assert.equal(Buffer.from(got[0].audio, "base64").length, FRAME_BYTES);
  assert.ok(got.some((e) => Buffer.from(e.audio, "base64").some((b) => b !== 0)));
  // App stalls 200 ms: silence keeps the timeline running.
  const before = audioAppends(ws).length;
  await h.clock.advance(200);
  assert.ok(audioAppends(ws).length - before >= 7, "silence fill");
  assert.ok(h.ctl.pacer.stats().fill_frames >= 7);
  // Mute: the primary session is muted and the frames carry zeros.
  const r = await h.ctl.runCommand("mute", { on: true });
  assert.deepEqual(r, { ok: true, data: { muted: true } });
  assert.equal(ws.sentOfType("session.input_audio.mute").length, 1);
  const n0 = audioAppends(ws).length;
  for (let i = 0; i < 5; i++) { h.mic(link, speech); await h.clock.advance(20); }
  for (const e of audioAppends(ws).slice(n0)) assert.ok(Buffer.from(e.audio, "base64").every((b) => b === 0), "zeros while muted");
});

test("speaker path: output deltas are re-chunked to 960-byte frames; a session end sends audio_flush and flags the next frame", async (t) => {
  const h = await setup(t);
  h.on();
  const { link } = await h.attach();
  const ws = await h.startPrimary();
  const out = tone(50);
  ws.receive({ type: "session.output_audio.delta", delta: out.toString("base64") });
  assert.equal(link.audio.length, 2, "2 full frames of 50 ms, the rest waits");
  assert.ok(link.audio.every((f) => f.pcm.length === FRAME_BYTES));
  assert.equal(link.audio[0].flags, 0, "no flush yet");
  ws.receive({ type: "session.output_transcript.delta", delta: "Hello there", start_ms: 0, end_ms: 400 });
  assert.deepEqual(link.of("caption").at(-1), { type: "caption", role: "assistant", text: "Hello there", start_ms: 0, end_ms: 400, session: h.voice.live.id });
  // Voice switch: flush with voice_change, new primary session.
  const r = await h.ctl.runCommand("set_voice", { voice: "cedar" });
  assert.equal(r.ok, true);
  assert.equal(r.data.switching, true);
  assert.equal(link.of("audio_flush").at(-1).reason, "voice_change");
  h.closeReply(ws);
  await h.clock.advance(0);
  const ws2 = await h.startPrimary("live_p2");
  assert.notEqual(ws2, ws);
  assert.equal(ws2.sent[0].session.audio.output.voice, "cedar");
  assert.match(appends(ws2, "instructions")[0].content, /cedar/i, "confirms in the new voice");
  ws2.receive({ type: "session.output_audio.delta", delta: tone(20).toString("base64") });
  assert.equal(link.audio.at(-1).flags, FLAG.AFTER_FLUSH);
  assert.ok(link.of("settings").length >= 1, "settings resent when the voice changes");
});

test("delegation end to end: transcript + delegation.created -> inbox; result comes back as commentary", async (t) => {
  const h = await setup(t);
  h.on();
  const { link } = await h.attach();
  const ws = await h.startPrimary();
  ws.receive({ type: "session.input_transcript.delta", delta: "List the files in the daemon folder.", start_ms: 0, end_ms: 1500 });
  ws.receive({ type: "session.delegation.created", offset_ms: 1500, delegation: { id: "item_1", target: "client" } });
  await h.clock.advance(4000);
  assert.equal(h.inboxSends.length, 1);
  assert.match(h.inboxSends[0].content, /List the files in the daemon folder/);
  assert.ok(link.of("delegation").length >= 1);
  assert.equal(link.of("caption").find((m) => m.role === "user").text, "List the files in the daemon folder.");
});

test("resume and wake commands start a native session from paused and sleeping", async (t) => {
  const h = await setup(t);
  h.on();
  const { link } = await h.attach();
  let ws = await h.startPrimary();
  const p = h.ctl.runCommand("pause", {});
  h.closeReply(ws);
  assert.deepEqual(await p, { ok: true });
  assert.equal(h.voice.state, "paused");
  assert.equal(link.of("audio_flush").at(-1).reason, "pause");
  assert.deepEqual(await h.ctl.runCommand("resume", {}), { ok: true, data: {} });
  ws = await h.startPrimary("live_r");
  assert.equal(h.voice.state, "live");
  assert.equal(h.voice.live.reason, "resume");
  // Idle sleep (wake on: the app listens): state sleeping, then a tap wakes.
  const pp = h.voice.goToSleep("idle");
  h.closeReply(ws);
  await pp;
  assert.equal(h.voice.state, "sleeping");
  assert.equal(link.of("audio_flush").at(-1).reason, "sleep");
  assert.deepEqual(await h.ctl.runCommand("wake", {}), { ok: true, data: {} });
  await h.startPrimary("live_w");
  assert.equal(h.voice.state, "live");
});

test("notify wake: a result while sleeping wakes a native session and is spoken", async (t) => {
  const h = await setup(t);
  h.on();
  await h.attach();
  const ws = await h.startPrimary();
  const pp = h.voice.goToSleep("idle");
  h.closeReply(ws);
  await pp;
  assert.equal(h.voice.state, "sleeping");
  assert.equal(h.voice.notifyUser("Claude finished the build."), "queued");
  await h.clock.advance(0);
  assert.equal(h.voice.state, "connecting");
  const ws2 = await h.startPrimary("live_n");
  assert.equal(h.voice.live.reason, "notify");
  await h.clock.advance(10_000);
  assert.ok(appends(ws2, "commentary").some((e) => /Claude finished the build/.test(e.content)));
});

test("expiry reconnect re-creates the primary session with no page", async (t) => {
  const h = await setup(t);
  h.on();
  const { link } = await h.attach();
  const ws = await h.startPrimary();
  h.voice.live.expires_at = Math.floor(h.clock.now() / 1000) + 301;
  h.voice.scheduleExpiry();
  await h.clock.advance(3000);
  assert.equal(h.voice.state, "reconnecting");
  h.closeReply(ws);
  await h.clock.advance(0);
  const ws2 = await h.startPrimary("live_x");
  assert.notEqual(ws2, ws);
  assert.equal(h.voice.state, "live");
  assert.equal(h.voice.live.reason, "reconnect");
  assert.equal(link.of("audio_flush").at(-1).reason, "session_end");
  assert.equal(h.commands().filter((c) => c.startsWith("reconnect")).length, 0);
});

test("a lost primary socket reconnects after a backoff; a start failure maps the key check", async (t) => {
  const h = await setup(t);
  h.on();
  await h.attach();
  const ws = await h.startPrimary();
  ws.serverClose(1006);
  await h.clock.advance(0);
  assert.equal(h.voice.state, "reconnecting");
  const n = h.WS.instances.length;
  await h.clock.advance(400);
  assert.equal(h.WS.instances.length, n, "waits 0.5 s");
  await h.clock.advance(200);
  await h.startPrimary("live_again");
  assert.equal(h.voice.state, "live");
  // Now a handshake failure before open: the key check says the key is bad.
  h.setFetch(async () => ({ status: 401, text: async () => "{}" }));
  const pz = h.ctl.runCommand("pause", {});
  await h.clock.advance(0);
  h.closeReply(h.WS.last());
  await pz;
  h.ctl.runCommand("resume", {});
  await h.clock.advance(0);
  h.WS.last().serverClose(1006); // never opened
  await h.clock.advance(0);
  assert.equal(h.voice.state, "paused");
  assert.equal(h.voice.lastError.code, "openai_auth");
});

test("app gone: the pacer fills silence for 10 s, then voice pauses (app_gone); reattach within the grace keeps the session", async (t) => {
  const h = await setup(t);
  h.on();
  const { link } = await h.attach();
  const ws = await h.startPrimary();
  h.ctl.detach(link, { code: 1006 });
  await h.clock.advance(5000);
  assert.equal(h.voice.state, "live");
  assert.ok(audioAppends(ws).length >= 240, "silence keeps the timeline running");
  const { link: link2 } = await h.attach(fakeLink(2));
  await h.clock.advance(6000);
  assert.equal(h.voice.state, "live", "same session after reattach");
  assert.equal(h.WS.instances.length, 1);
  h.ctl.detach(link2, { code: 1006 });
  await h.clock.advance(10_000);
  h.closeReply(ws);
  await h.clock.advance(0);
  assert.equal(h.voice.state, "paused");
  assert.equal(h.voice.pauseReason, "app_gone");
  assert.equal(h.voice.pageStatus().audio_client, null);
});

test("one audio client: the app takes over a page's WebRTC session (app_took_over)", async (t) => {
  const h = await setup(t);
  const pageWs = await h.goLive();
  assert.equal(h.voice.pageStatus().audio_client, "page");
  const { link } = await h.attach();
  const cmds = h.commands();
  assert.ok(cmds.includes("disconnect:app_took_over"));
  assert.ok(h.sse.some((m) => m.type === "notice" && m.code === "app_took_over"));
  assert.ok(!link.sent.some((m) => m.type === "notice" && m.code === "app_took_over"), "page only");
  assert.equal(pageWs.sentOfType("session.close").length, 1);
  const ws = await h.startPrimary("live_took");
  assert.equal(h.voice.state, "live");
  assert.equal(h.voice.live.reason, "reconnect");
  assert.equal(ws.url, "wss://api.openai.com/v1/live/sessions");
  // A page asking for a WebRTC session now is refused.
  const r = await h.voice.createSession({ sdp: "v=0 offer", reason: "start" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "app_took_over");
});

test("off: audio_flush off, then command close_window; the link stays up", async (t) => {
  const h = await setup(t);
  h.on();
  const { link } = await h.attach();
  const ws = await h.startPrimary();
  const r = await h.ctl.runCommand("end", {});
  assert.deepEqual(r, { ok: true });
  h.closeReply(ws);
  await h.clock.advance(2000);
  const types = link.sent.map((m) => (m.type === "command" ? `command:${m.command}` : m.type === "audio_flush" ? `flush:${m.reason}` : m.type));
  assert.ok(types.indexOf("flush:off") >= 0 && types.indexOf("flush:off") < types.indexOf("command:close_window"));
  assert.equal(link.closed, null);
  assert.equal(h.voice.state, "off");
  // The next /talk on starts a native session right away and shows the panel.
  h.chrome.showApp = () => { h.chrome.shown = (h.chrome.shown || 0) + 1; };
  h.on();
  assert.equal(h.chrome.shown, 1);
  await h.startPrimary("live_again");
  assert.equal(h.voice.state, "live");
});

test("self-update: snapshot records the app; the successor waits for its hello, then reconnects natively", async (t) => {
  const h = await setup(t);
  h.on();
  await h.attach();
  const ws = await h.startPrimary();
  const prepP = h.voice.prepareRestart("update");
  h.closeReply(ws);
  const prep = await prepP;
  const snap = h.voice.snapshot(prep);
  assert.equal(snap.audio_client, "app");
  // Successor.
  const h2 = await setup(t);
  assert.equal(h2.voice.restore(JSON.parse(JSON.stringify(snap))), true);
  assert.equal(h2.voice.state, "reconnecting");
  assert.equal(h2.commands().filter((c) => c.startsWith("reconnect")).length, 0, "no page reconnect while waiting for the app");
  await h2.attach();
  const ws2 = await h2.startPrimary("live_succ");
  assert.equal(h2.voice.state, "live");
  assert.equal(h2.voice.live.reason, "reconnect");
  assert.match(appends(ws2, "instructions")[0].content, /updated/i);
  // A successor whose app never comes back falls back to the page after 10 s.
  const h3 = await setup(t);
  h3.voice.restore(JSON.parse(JSON.stringify(snap)));
  await h3.clock.advance(10_000);
  assert.ok(h3.commands().includes("reconnect:update"));
});

test("commands: each gets exactly one result; errors use the HTTP codes; key_save args are never logged", async (t) => {
  const h = await setup(t);
  h.on();
  const { link } = await h.attach();
  await h.startPrimary();
  let seq = 0;
  const send = async (name, args) => {
    const id = `id_${name}_${++seq}`;
    h.ctl.onMessage(link, { type: "cmd", id, name, args });
    await h.clock.advance(0);
    const rs = link.of("result").filter((m) => m.id === id);
    assert.equal(rs.length, 1, name);
    return rs[0];
  };
  assert.equal((await send("set_policy", { policy: "quiet" })).ok, true);
  assert.equal(h.voice.policy, "quiet");
  assert.equal((await send("set_policy", { policy: "loud" })).error.code, "bad_policy");
  assert.deepEqual((await send("set_wake", { sensitivity: "high" })).data, { sensitivity: "high" });
  assert.equal((await send("set_wake", { sensitivity: "max" })).error.code, "bad_sensitivity");
  assert.equal((await send("set_voice", { voice: "robot" })).error.code, "bad_voice");
  assert.equal((await send("set_persona", { persona: "nobody" })).error.code, "bad_persona");
  assert.equal((await send("set_persona", {})).error.code, "bad_persona");
  assert.equal((await send("set_persona", { persona: 7 })).error.code, "bad_persona");
  assert.deepEqual((await send("set_persona", { use_voice: false })).data, { use_voice: false });
  assert.deepEqual((await send("set_persona", { use_voice: true })).data, { use_voice: true });
  assert.deepEqual(Object.keys((await send("get_voices", {})).data), ["voices", "current", "live", "live_voice"]);
  assert.equal((await send("set_window", { mode: "chrome" })).data.window, "chrome");
  assert.equal((await send("set_window", { mode: "tv" })).error.code, "bad_window");
  const ks = await send("key_save", { key: "not-a-key" });
  assert.equal(ks.error.code, "bad_key_format");
  assert.equal((await send("key_remove", {})).ok, false);
  assert.equal((await send("nope", {})).error.code, "unknown_command");
  assert.equal((await send("echo_test", {})).error.code, "not_cached");
  const logText = JSON.stringify(h.log.entries);
  assert.ok(!logText.includes("not-a-key"), "key_save args never logged");
  assert.ok(COMMANDS.every((c) => typeof c === "string"));
});

test("open_browser: the app stops being the audio client and the Chrome page opens", async (t) => {
  const h = await setup(t);
  h.on();
  const { link } = await h.attach();
  const ws = await h.startPrimary();
  let asked = null;
  h.chrome.open = (o) => { asked = o; return { mode: "chrome" }; };
  const p = h.ctl.runCommand("open_browser", {});
  h.closeReply(ws);
  const r = await p;
  assert.deepEqual(r, { ok: true, data: { mode: "chrome" } });
  assert.deepEqual(asked, { want: "chrome" });
  assert.equal(h.voice.state, "waiting_page");
  assert.equal(h.voice.pageStatus().audio_client, null);
  assert.equal(link.of("audio_flush").at(-1).reason, "session_end");
  // The page can create its session now.
  const c = await h.voice.createSession({ sdp: "v=0 offer", reason: "start" });
  assert.equal(c.status, 201);
});

test("Mac sleep: a live session closes into sleeping (wake on) or paused (wake off)", async (t) => {
  const h = await setup(t);
  h.on();
  const { link } = await h.attach();
  const ws = await h.startPrimary();
  h.ctl.onMessage(link, { type: "system", event: "sleep" });
  h.closeReply(ws);
  await h.clock.advance(0);
  assert.equal(h.voice.state, "sleeping");
  h.voice.setWakeSensitivity("off");
  assert.equal(h.voice.state, "paused");
});

test("mute before a session: applied to the next primary session", async (t) => {
  const h = await setup(t);
  h.on();
  await h.attach();
  await h.ctl.runCommand("mute", { on: true });
  const ws = await h.startPrimary();
  assert.equal(ws.sentOfType("session.input_audio.mute").length, 1);
  assert.equal(h.voice.live.muted, true);
});

test("voice wake on relayed audio: speech while sleeping starts a wake session and hands over the clip", async (t) => {
  const h = await setup(t);
  h.on();
  const { link } = await h.attach();
  const ws = await h.startPrimary();
  const pp = h.voice.goToSleep("idle");
  h.closeReply(ws);
  await pp;
  assert.equal(h.voice.state, "sleeping");
  assert.ok(h.ctl.wake, "listening while sleeping");
  // 1 s of quiet noise floor, then 1.2 s of a voiced, modulated vowel.
  const noise = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < 50; i++) { for (let j = 0; j < 480; j++) noise.writeInt16LE(Math.round((Math.random() - 0.5) * 60), j * 2); h.mic(link, Buffer.from(noise)); }
  const n = Math.round(1.2 * 24000);
  const voice = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const tt = i / 24000;
    const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * tt);
    let v = 0;
    for (let k = 1; k <= 12; k++) v += Math.sin(2 * Math.PI * 140 * k * tt) / k;
    voice.writeInt16LE(Math.round(4000 * env * v), i * 2);
  }
  h.voice.transcribe = null;
  for (let off = 0; off + FRAME_BYTES <= voice.length; off += FRAME_BYTES) h.mic(link, voice.subarray(off, off + FRAME_BYTES));
  await h.clock.advance(0);
  assert.equal(h.ctl.counters.wake_triggers, 1);
  assert.equal(h.voice.state, "connecting");
  let posted = null;
  h.voice.onWakeAudio = async (msg) => { posted = msg; };
  const ws2 = await h.startPrimary("live_wake");
  assert.equal(h.voice.live.reason, "wake");
  assert.ok(posted && posted.session_id === "live_wake" && posted.audio.length > 1000, "clip handed to onWakeAudio");
  assert.ok(ws2);
});

test("can't hear: a silent mic for 20 s raises notice cant_hear; an input transcript clears it", async (t) => {
  const h = await setup(t);
  h.on();
  const { link } = await h.attach();
  const ws = await h.startPrimary();
  for (let i = 0; i < 1100; i++) { h.mic(link); await h.clock.advance(20); }
  assert.ok(link.of("notice").some((m) => m.code === "cant_hear"));
  assert.ok(appends(ws, "instructions").some((e) => /hear/i.test(e.content)), "the voice says so once");
  ws.receive({ type: "session.input_transcript.delta", delta: "hello?", start_ms: 0, end_ms: 300 });
  assert.ok(link.of("notice_clear").some((m) => m.code === "cant_hear"));
});

test("echo test: the cached sample is played by the app and the mic is measured against it", async (t) => {
  const h = await setup(t);
  h.on();
  const { link } = await h.attach();
  fs.mkdirSync(h.voice.paths.previews, { recursive: true });
  // A speech-like modulated sample.
  const n = 3 * 24000;
  const s = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) { const tt = i / 24000; s.writeInt16LE(Math.round(9000 * (0.2 + 0.8 * Math.abs(Math.sin(2 * Math.PI * 1.7 * tt))) * Math.sin(2 * Math.PI * 200 * tt)), i * 2); }
  fs.writeFileSync(path.join(h.voice.paths.previews, "marin.wav"), pcm16ToWav(s));
  const p = h.ctl.runCommand("echo_test", {});
  assert.equal(link.of("command").at(-1).command, "play_echo_sample");
  // The mic hears the sample 100 ms late at -20 dB.
  for (let f = 0; f < 160; f++) {
    const off = (f - 5) * FRAME_BYTES;
    const frame = Buffer.alloc(FRAME_BYTES);
    if (off >= 0 && off + FRAME_BYTES <= s.length) for (let j = 0; j < 480; j++) frame.writeInt16LE(Math.round(s.readInt16LE(off + j * 2) * 0.1), j * 2);
    h.mic(link, frame);
  }
  h.ctl.onMessage(link, { type: "played", what: "echo_test", voice: "marin" });
  const r = await p;
  assert.equal(r.ok, true);
  assert.ok(["heavy", "some"].includes(r.data.verdict), JSON.stringify(r.data));
});

test("mic_silent from the native app (SPEC §6.16 \"Silent mic\"): a stale app restarts; otherwise the voice moves to Chrome and the gone app does not pause it", async (t) => {
  const h = await setup(t);
  h.on();
  const { link } = await h.attach();
  await h.startPrimary();
  assert.equal(h.voice.state, "live");
  const c = h.chrome;
  c.appLaunched = false; // the user opened the app: attached is enough
  c.replaced = [];
  c.openArgs = [];
  let stale = [{ pid: 4957, startMs: 0 }];
  c.staleApps = async () => stale;
  c.replaceApp = async (o) => { c.replaced.push(o); return 1; };
  c.open = function (o) { this.opened++; this.openArgs.push(o); return { mode: o?.force ? "app" : "chrome" }; };
  h.ctl.onMessage(link, { type: "route", mode: "split", input: { name: "MacBook Pro Microphone" }, output: { name: "Speakers" } });
  h.ctl.onMessage(link, { type: "mic_silent", input_label: "", source: "native", ms: 3000 });
  await h.clock.advance(0);
  await h.clock.advance(0);
  const l = h.log.find("page.mic_silent");
  assert.equal(l.length, 1);
  assert.equal(l[0].host, "app");
  assert.equal(l[0].input, "MacBook Pro Microphone", "the app's current input names the mic");
  assert.deepEqual(c.replaced, [{ reason: "mic_silent_stale_app", chrome: false }]);
  assert.equal(h.voice.audioClient, "app", "a fresh app keeps the voice");

  // A minute later, still silent in a fresh app: Chrome takes the voice.
  stale = [];
  await h.clock.advance(61_000);
  h.ctl.detach(link, { code: 1006 });
  h.ctl.onMessage(link, { type: "mic_silent" }); // an old link: ignored
  const { link: link2 } = await h.attach(fakeLink(2));
  await h.startPrimary();
  h.ctl.onMessage(link2, { type: "mic_silent", input_label: "MacBook Pro Microphone", ms: 3000 });
  await h.clock.advance(0);
  await h.clock.advance(0);
  assert.deepEqual(c.replaced.at(-1), { reason: "mic_silent", chrome: true });
  assert.equal(h.voice.audioClient, null, "the page is the audio client now");
  h.ctl.detach(link2, { code: 1006 });
  await h.clock.advance(11_000);
  assert.equal(h.log.find("native.app_gone").length, 1);
  assert.notEqual(h.voice.state, "paused", "the app's grace period ending does not pause a voice that moved to Chrome");
});

test("can't hear: a new native session re-arms it; a reconnect on the same mic keeps \"heard\"; a new mic re-arms it", async (t) => {
  const h = await setup(t);
  h.on();
  const { link } = await h.attach();
  h.ctl.onMessage(link, { type: "route", mode: "split", input: { name: "Mic A" }, output: { name: "Speakers" } });
  const ws = await h.startPrimary();
  assert.equal(h.ctl.hearing.hasHeard, false);
  ws.receive({ type: "session.input_transcript.delta", delta: "hello there" });
  await h.clock.advance(0);
  assert.equal(h.ctl.hearing.hasHeard, true);
  // A transparent reconnect: still heard on Mic A.
  h.voice.reconnect("primary_lost");
  await h.clock.advance(1000);
  await h.startPrimary();
  assert.equal(h.ctl.hearing.hasHeard, true);
  // A different mic: not heard on it yet.
  h.ctl.onMessage(link, { type: "route", mode: "split", input: { name: "Mic B" }, output: { name: "Speakers" } });
  assert.equal(h.ctl.hearing.hasHeard, false);
});

test("persona switch on the native app (SPEC §4.6): the primary session is re-created in the new persona and its voice", async (t) => {
  const h = await setup(t);
  h.on();
  const { link } = await h.attach();
  const ws1 = await h.startPrimary();
  assert.equal(h.voice.live.persona, "sotto");
  const r = h.voice.setPersona("june", "control");
  assert.equal(r.ok, true);
  assert.equal(r.switching, true);
  assert.equal(r.voice, "coral", "the persona's voice comes along");
  assert.ok(ws1.sent.some((m) => m.type === "session.close"), "the old primary session is closed");
  ws1.receive({ type: "session.closed", reason: "client_requested" });
  await h.clock.advance(0);
  const ws2 = await h.startPrimary();
  assert.notEqual(ws2, ws1);
  const start = ws2.sent.find((m) => m.type === "session.start");
  assert.match(start.session.instructions, /You are June/);
  assert.equal(start.session.audio.output.voice, "coral");
  assert.equal(h.voice.live.persona, "june");
  assert.equal(h.voice.pageStatus().persona, "june");
  assert.ok(link.of("audio_flush").length >= 1, "the app dropped the old session's audio");
  const created = h.log.find("session.create").at(-1);
  assert.equal(created.persona, "june");
});

test("cmd set_persona (docs/NATIVE.md §3.3): the app's picker switches the live persona; the toggle keeps the voice; settings follow", async (t) => {
  const h = await setup(t);
  h.on();
  const { link } = await h.attach();
  const ws1 = await h.startPrimary();
  // "Switch to the persona's own voice" off: the voice stays marin.
  const off = await h.ctl.runCommand("set_persona", { use_voice: false });
  assert.deepEqual(off, { ok: true, data: { use_voice: false } });
  await h.clock.advance(0);
  assert.equal(link.of("settings").at(-1).personas.use_voice, false, "settings resent with the toggle");
  const r = await h.ctl.runCommand("set_persona", { persona: "Moss" });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.data), ["persona", "voice", "switching", "message", "use_voice"]);
  assert.equal(r.data.persona, "moss", "a display name finds the id");
  assert.equal(r.data.switching, true);
  assert.equal(r.data.voice, "marin", "the toggle is off: no voice change");
  assert.equal(r.data.use_voice, false);
  assert.match(r.data.message, /^sotto: persona set to moss\. Switching the live session now\./);
  assert.equal(link.of("audio_flush").at(-1).reason, "voice_change");
  ws1.receive({ type: "session.closed", reason: "client_requested" });
  await h.clock.advance(0);
  const ws2 = await h.startPrimary();
  const start = ws2.sent.find((m) => m.type === "session.start");
  assert.match(start.session.instructions, /Your persona is Moss/);
  assert.equal(start.session.audio.output.voice, "marin");
  assert.equal(h.voice.live.persona, "moss");
  const st = link.of("settings").at(-1);
  assert.equal(st.personas.current, "moss", "settings carry the new persona");
  assert.equal(st.personas.live_persona, "moss");
  assert.equal(link.of("status").at(-1).status.persona, "moss");
  assert.equal(h.log.find("persona.set").at(-1).via, "app");
  // Toggle and pick in one command: the persona's own voice comes along.
  const both = await h.ctl.runCommand("set_persona", { persona: "june", use_voice: true });
  assert.equal(both.data.voice, "coral");
  assert.equal(both.data.use_voice, true);
});
