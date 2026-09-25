// A Bluetooth headset mic on the native path (SPEC §6.19, §7.6): the uplink
// gain, the settle window after a route, per-device calibration and the
// empty-clip wake. Fake clock, fake WebSocket, a fake link; the mic frames are
// speech fixtures as AirPods deliver them in call mode (test/helpers/bt-audio.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeHarness } from "../helpers/daemon-harness.js";
import { FRAME_BYTES, FLAG } from "../../daemon/native-proto.js";
import { readWavPcm24k } from "../helpers/fake-native-app.js";
import { bluetoothMic, bluetoothSilence, activeLevelDb, pcmToFloat } from "../helpers/bt-audio.js";
import { MIN_AWAKE_MS, FALSE_WAKE_QUIET_MS } from "../../daemon/wake.js";
import { CALIBRATED_UTTERANCES } from "../../daemon/agc.js";

const FIX = (n) => path.join(fileURLToPath(new URL("../fixtures", import.meta.url)), `${n}.wav`);
const AIRPODS = { name: "Chad's AirPods Max", bluetooth: true, headphones: false };
const appends = (ws, kind) => ws.sent.filter((e) => e.type === `session.${kind}.append`);

function fakeLink(id = 1) {
  return {
    id, clientInfo: { version: "0.4.1", test: true }, sent: [], audio: [], closed: null, bufferedAmount: 0,
    sendJson(o) { this.sent.push(o); return true; },
    sendAudio(pcm, { flags = 0 } = {}) { this.audio.push({ pcm: Buffer.from(pcm), flags }); return true; },
    close(code, reason) { this.closed = { code, reason }; },
    of(type) { return this.sent.filter((m) => m.type === type); },
  };
}

async function setup(t) {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  h.ctl = h.d.nativeCtl;
  h.attach = async (link = fakeLink()) => {
    const welcome = h.ctl.attach(link, link.clientInfo);
    link.sendJson({ type: "welcome", ...welcome });
    h.ctl.afterWelcome(link);
    await h.clock.advance(0);
    return link;
  };
  h.startPrimary = async (id = `live_prim_${h.WS.instances.length}`) => {
    await h.clock.advance(0);
    const ws = h.WS.last();
    ws.open();
    ws.receive({ type: "session.started", session: { id, expires_at: Math.floor(h.clock.now() / 1000) + 7200 } });
    await h.clock.advance(0);
    return ws;
  };
  h.route = (link, mode = "split") => h.ctl.onMessage(link, { type: "route", mode, input: AIRPODS, output: mode === "listen" ? null : { name: AIRPODS.name, bluetooth: true, headphones: true } });
  /** Stream PCM in 20 ms frames on the fake clock. */
  h.stream = async (link, pcm) => {
    for (let off = 0; off + FRAME_BYTES <= pcm.length; off += FRAME_BYTES) {
      h.ctl.onMicFrame(link, { kind: 1, flags: FLAG.FAKE, seq: 0, tsNs: 0n, pcm: pcm.subarray(off, off + FRAME_BYTES) });
      await h.clock.advance(20);
    }
  };
  return h;
}

const said = (name, speechDb) => bluetoothMic(readWavPcm24k(FIX(name)), { speechDb });
const uplink = (ws) => Buffer.concat(ws.sent.filter((e) => e.type === "session.input_audio.append").map((e) => Buffer.from(e.audio, "base64")));

test("soft headset speech reaches the model at a level it hears; the gain is learned per device and persisted", async (t) => {
  const h = await setup(t);
  h.on();
  const link = await h.attach();
  h.route(link);
  const ws = await h.startPrimary();
  const talk = [];
  for (const [i, n] of ["decide-name", "ask-later", "ask-files", "ask-count", "decide-name", "ask-later"].entries()) talk.push(said(n, -50 + (i % 2)), bluetoothSilence(800));
  await h.stream(link, Buffer.concat([bluetoothSilence(1500), ...talk]));
  // What went to gpt-live-1: the last utterance, well above its -48 dBFS floor.
  const up = uplink(ws);
  const tail = pcmToFloat(up.subarray(up.length - (said("ask-later", -49).length + bluetoothSilence(800).length)));
  const lvl = activeLevelDb(tail, { activeDb: -60 });
  assert.ok(lvl > -34, `uplink speech at ${lvl.toFixed(1)} dBFS (sent -50)`);
  const cal = h.log.entries.filter((e) => e.ev === "mic.calibrate");
  assert.ok(cal.length >= CALIBRATED_UTTERANCES, `${cal.length} utterances learned`);
  assert.equal(cal.at(-1).input, AIRPODS.name);
  assert.equal(cal.at(-1).calibrated, true);
  assert.ok(Math.abs(cal.at(-1).speech_db - -50) < 6, `speech ${cal.at(-1).speech_db}`);
  const file = JSON.parse(fs.readFileSync(h.voice.paths.micLevels, "utf8"));
  assert.ok(file.devices[AIRPODS.name].utterances >= cal.at(-1).utterances);
  assert.ok(h.voice.status().native.agc.gain_db > 15);
  // Sleeping afterwards: the detector is calibrated from that profile.
  const pp = h.voice.goToSleep("idle");
  h.closeReply(ws);
  await pp;
  h.route(link, "listen");
  await h.stream(link, bluetoothSilence(1200));
  const listen = h.log.entries.filter((e) => e.ev === "wake.listen").at(-1);
  assert.equal(listen.calibrated, true);
  assert.ok(Math.abs(listen.min_db - (listen.speech_db - 15)) < 0.2, JSON.stringify(listen));
});

test("listen route on a Bluetooth mic: the profile-switch silence and burst are not trusted; the wake clip comes from the settled stream", async (t) => {
  const h = await setup(t);
  h.on();
  const link = await h.attach();
  h.route(link);
  const ws = await h.startPrimary();
  await h.stream(link, bluetoothSilence(2000));
  const pp = h.voice.goToSleep("idle");
  h.closeReply(ws);
  await pp;
  assert.equal(h.voice.state, "sleeping");
  h.route(link, "listen");
  assert.equal(h.ctl.wake, null, "not armed on the old stream");
  // AirPods switching to the call profile: 2.6 s of digital zeros, then a loud 60 ms burst.
  await h.stream(link, Buffer.alloc(Math.round(2.6 * 24000) * 2));
  assert.equal(h.ctl.wake, null, "still settling while the stream is zeros");
  const burst = Buffer.alloc(3 * FRAME_BYTES);
  for (let i = 0; i < burst.length / 2; i++) burst.writeInt16LE(Math.round(9000 * Math.sin(i * 0.7)), i * 2);
  await h.stream(link, Buffer.concat([burst, bluetoothSilence(1500)]));
  const settled = h.log.entries.find((e) => e.ev === "native.settled" && e.bluetooth);
  assert.ok(settled, "settle logged");
  assert.ok(h.ctl.wake, "re-armed on the settled stream");
  assert.equal(h.ctl.counters.wake_triggers, 0, "the burst never woke it");
  let clip = null;
  h.voice.onWakeAudio = async (msg) => { clip = msg; };
  await h.stream(link, Buffer.concat([said("ask-count", -48), bluetoothSilence(300)]));
  assert.equal(h.ctl.counters.wake_triggers, 1, "soft headset speech wakes it");
  await h.startPrimary("live_wake");
  assert.ok(clip && clip.audio.length > 1000);
  // The clip is 16 kHz PCM16: it holds speech, not the switch's zeros or burst.
  const wav = Buffer.from(clip.audio, "base64");
  const x = pcmToFloat(wav.subarray(44));
  assert.ok(activeLevelDb(x, { activeDb: -60 }) > -56, "speech in the clip");
  // From the onset (less the 250 ms pad) to live: the fixture's 4.2 s and the pad, not the 3 s pre-roll before it.
  assert.ok(x.length / 16000 < 4.2 + 0.25 + 0.4, `clip ${(x.length / 16000).toFixed(1)} s`);
});

test("empty wake clip, then live speech the model has not transcribed yet: the session stays awake; 10 s of quiet makes it a false wake", async (t) => {
  const h = await setup(t);
  h.on();
  const link = await h.attach();
  h.route(link);
  let ws = await h.startPrimary();
  const pp = h.voice.goToSleep("idle");
  h.closeReply(ws);
  await pp;
  h.route(link, "listen");
  await h.stream(link, bluetoothSilence(1500));
  h.voice.onWakeAudio = async () => {};
  await h.stream(link, Buffer.concat([said("ask-files", -48), bluetoothSilence(200)]));
  assert.equal(h.voice.state, "connecting");
  h.route(link);
  ws = await h.startPrimary("live_wake");
  h.voice.injectWakeText(h.voice.sideband, null, "clip");
  assert.match(appends(ws, "instructions").at(-1).content, /"Yes\?"/, "an empty clip still gets a short answer");
  // The user keeps talking for 20 s; no input transcript arrives.
  const talk = [];
  for (let i = 0; i < 5; i++) talk.push(said(["decide-name", "ask-later", "ask-count"][i % 3], -48), bluetoothSilence(700));
  await h.stream(link, Buffer.concat(talk));
  assert.ok(h.clock.now() - h.voice.liveStartedAt > MIN_AWAKE_MS);
  assert.equal(h.voice.state, "live", "not slept while the user talks");
  assert.equal(h.log.entries.filter((e) => e.ev === "idle.close").length, 1, "only the first sleep");
  // Then quiet: a false wake after FALSE_WAKE_QUIET_MS.
  await h.stream(link, bluetoothSilence(FALSE_WAKE_QUIET_MS + 2500));
  const close = h.log.entries.filter((e) => e.ev === "idle.close").at(-1);
  assert.equal(close.detail, "false_wake");
});
