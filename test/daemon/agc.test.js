// Uplink level control and per-device calibration (daemon/agc.js, SPEC §6.19),
// on speech fixtures as a Bluetooth headset delivers them (test/helpers/bt-audio.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createUplinkAgc, createMicProfiles, TARGET_DB, CALIBRATED_UTTERANCES, MAX_FLOOR_OUT_DB, PROFILE_METHOD } from "../../daemon/agc.js";
import { readWavPcm24k } from "../helpers/fake-native-app.js";
import { bluetoothMic, bluetoothSilence, activeLevelDb, pcmToFloat, keyboardTyping } from "../helpers/bt-audio.js";

const FIX = (n) => path.join(fileURLToPath(new URL("../fixtures", import.meta.url)), `${n}.wav`);
const FRAME = 960;

/** Run PCM through the AGC in 20 ms frames; returns the output and the utterances. */
function run(agc, pcm, o = {}) {
  const out = [];
  const utts = [];
  const rejected = [];
  let voiced = 0;
  for (let off = 0; off + FRAME <= pcm.length; off += FRAME) {
    const r = agc.process(pcm.subarray(off, off + FRAME), o);
    out.push(r.pcm);
    if (r.utterance) utts.push(r.utterance);
    if (r.rejected) rejected.push(r.rejected);
    if (r.voiced) voiced++;
  }
  return { pcm: Buffer.concat(out), utts, rejected, voiced };
}

const speech = (name, o) => bluetoothMic(readWavPcm24k(FIX(name)), o);

test("bt-audio fixtures: 8 kHz band, gated floor, speech at the asked level", () => {
  for (const lvl of [-55, -50, -45]) {
    const x = pcmToFloat(speech("ask-files", { speechDb: lvl }));
    assert.ok(Math.abs(activeLevelDb(x, { activeDb: lvl - 15 }) - lvl) < 3, `${lvl}`);
  }
  const quiet = pcmToFloat(bluetoothSilence(1000));
  assert.ok(quiet.filter((v) => v === 0).length / quiet.length > 0.5, "mostly digital zeros, like the headset's noise gate");
});

test("soft headset speech (-55 to -45 dBFS) is brought to the target; the model's -48 dBFS cliff is cleared", () => {
  for (const lvl of [-55, -50, -45]) {
    const agc = createUplinkAgc();
    const pcm = Buffer.concat([bluetoothSilence(1500), speech("decide-name", { speechDb: lvl }), bluetoothSilence(500), speech("ask-files", { speechDb: lvl })]);
    const { pcm: out } = run(agc, pcm);
    // Judge the second utterance (the gain has settled by then).
    const second = pcmToFloat(out.subarray(out.length - speech("ask-files", { speechDb: lvl }).length));
    const got = activeLevelDb(second, { activeDb: -60 });
    assert.ok(got > -34 && got < -20, `${lvl} dBFS in -> ${got.toFixed(1)} dBFS out (target ${TARGET_DB})`);
    assert.ok(got > -45, "well above gpt-live-1's level floor");
  }
});

test("never attenuates: loud or normal speech passes untouched", () => {
  const agc = createUplinkAgc();
  const pcm = readWavPcm24k(FIX("ask-files")); // TTS at about -16 dBFS
  const { pcm: out } = run(agc, Buffer.concat([Buffer.alloc(24000 * 2), pcm]));
  assert.equal(agc.gainDb, 0);
  assert.ok(out.equals(Buffer.concat([Buffer.alloc(24000 * 2), pcm]).subarray(0, out.length)), "byte for byte");
});

test("no clipping, and the floor is never lifted above MAX_FLOOR_OUT_DB", () => {
  const agc = createUplinkAgc();
  // Soft speech with one loud transient in it.
  const pcm = speech("ask-count", { speechDb: -50 });
  pcm.writeInt16LE(12000, 60000); // a click: fine at 0 dB, clipped at +25 dB
  const { pcm: out } = run(agc, Buffer.concat([bluetoothSilence(1000), pcm]));
  assert.ok(agc.gainDb > 15, `gain ${agc.gainDb}`);
  let peak = 0;
  for (let i = 0; i < out.length; i += 2) peak = Math.max(peak, Math.abs(out.readInt16LE(i)));
  assert.ok(peak <= 0.9 * 32768, `peak ${peak}`);
  // A noisy room: floor at -60, speech at -45: gain capped by the floor rule.
  const noisy = createUplinkAgc();
  run(noisy, Buffer.concat([bluetoothMic(Buffer.alloc(48000 * 2), { floorDb: -60, gateDb: -200 }), speech("ask-files", { speechDb: -40, floorDb: -60, gateDb: -200 })]));
  assert.ok(noisy.floorDb > -66 && noisy.floorDb < -54, `floor ${noisy.floorDb}`);
  assert.ok(noisy.gainDb <= MAX_FLOOR_OUT_DB - noisy.floorDb + 0.01, `gain ${noisy.gainDb}`);
});

test("utterances are measured only while learning; a known device starts at its gain", () => {
  const agc = createUplinkAgc();
  const pcm = Buffer.concat([bluetoothSilence(1000), speech("ask-later", { speechDb: -48 }), bluetoothSilence(600)]);
  const { utts } = run(agc, pcm);
  assert.equal(utts.length, 1);
  assert.ok(Math.abs(utts[0].speechDb - -49) < 5, `utterance ${utts[0].speechDb}`);
  assert.ok(utts[0].ms >= 400);
  const quiet = createUplinkAgc();
  assert.equal(run(quiet, pcm, { learn: false }).utts.length, 0, "the assistant was audible: nothing learned");
  assert.equal(quiet.speechDb, null);
  const known = createUplinkAgc({ speechDb: -50, floorDb: -80 });
  assert.ok(known.gainDb > 20, `starts at ${known.gainDb} dB`);
});

test("mic profiles: calibrated after 5 utterances, persisted per device, evicted oldest first", () => {
  let saved = null;
  let t = 0;
  const clock = { now: () => ++t };
  const p = createMicProfiles({ load: () => saved, save: (o) => { saved = JSON.parse(JSON.stringify(o)); }, clock, maxDevices: 2 });
  for (let i = 0; i < CALIBRATED_UTTERANCES - 1; i++) p.learn("Chad's AirPods Max", { speechDb: -48 + (i % 2), ms: 900 }, -80);
  assert.equal(p.get("Chad's AirPods Max").calibrated, false);
  const last = p.learn("Chad's AirPods Max", { speechDb: -48, ms: 900 }, -80);
  assert.equal(last.calibrated, true);
  assert.ok(Math.abs(last.speech_db - -47.6) < 1);
  assert.equal(p.flush(), true);
  assert.equal(p.flush(), false, "nothing new");
  // A fresh store (daemon restart) reads the same file.
  const q = createMicProfiles({ load: () => saved, save: (o) => { saved = o; }, clock, maxDevices: 2 });
  assert.equal(q.get("Chad's AirPods Max").calibrated, true);
  assert.equal(q.get("Chad's AirPods Max").floor_db, -80);
  q.learn("MacBook Pro Microphone", { speechDb: -38, ms: 800 });
  q.learn("USB mic", { speechDb: -30, ms: 800 });
  assert.equal(q.get("Chad's AirPods Max"), null, "only the two most recent devices are kept");
  assert.ok(q.get("USB mic"));
  // Garbage on disk never throws.
  const r = createMicProfiles({ load: () => { throw new Error("bad json"); } });
  assert.equal(r.get("x"), null);
});

// Live capture 2026-09-25 (AirPods Max, 0.4.3): typing next to the headset was
// learned as "speech at -50 dBFS" and set +24 to +28 dB of gain.
test("keyboard typing is not speech: nothing learned, no gain", () => {
  const agc = createUplinkAgc();
  const input = Buffer.concat([bluetoothSilence(1000), keyboardTyping(15000), bluetoothSilence(600)]);
  const { utts, rejected, pcm } = run(agc, input);
  assert.equal(utts.length, 0, JSON.stringify(utts));
  assert.ok(rejected.length >= 1, "the typing runs are reported as not speech");
  assert.ok(rejected.every((r) => r.voiced < 0.3), JSON.stringify(rejected));
  assert.equal(agc.speechDb, null);
  assert.equal(agc.gainDb, 0);
  assert.ok(pcm.equals(input.subarray(0, pcm.length)), "passes byte for byte");
});

test("typing around real-level speech: the level comes from the voice alone", () => {
  const agc = createUplinkAgc();
  const pcm = Buffer.concat([bluetoothSilence(800), keyboardTyping(8000), speech("decide-name", { speechDb: -31 }), bluetoothSilence(400),
    keyboardTyping(6000, { seed: 3 }), speech("ask-files", { speechDb: -31 }), bluetoothSilence(600)]);
  const { utts } = run(agc, pcm);
  assert.ok(utts.length >= 2, JSON.stringify(utts));
  assert.ok(utts.every((u) => Math.abs(u.speechDb - -31) < 5 && u.voiced >= 0.3), JSON.stringify(utts));
  assert.ok(Math.abs(agc.speechDb - -31) < 5, `speech ${agc.speechDb}`);
  assert.ok(agc.gainDb < 8, `gain ${agc.gainDb}`);
});

test("mic profiles from before the voicing test (0.4.3: typing) are ignored and relearned", () => {
  const saved = { devices: { "Chad's AirPods Max": { speech_db: -49.8, floor_db: -79.6, utterances: 132, updated: 1 } } };
  const p = createMicProfiles({ load: () => saved });
  assert.equal(p.get("Chad's AirPods Max"), null);
  const q = p.learn("Chad's AirPods Max", { speechDb: -30, ms: 900 }, -80);
  assert.equal(q.utterances, 1);
  assert.equal(q.speech_db, -30);
  assert.equal(q.method, PROFILE_METHOD);
});
