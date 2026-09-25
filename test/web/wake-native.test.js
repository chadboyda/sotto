// Voice wake on the native app's raw mic (web/wake.js profile "native",
// SENSITIVITY_NATIVE): the page's thresholds assumed Chrome's AGC, so on the
// app's capture normal speech did not wake it (only a shout did). These tests
// use real speech fixtures at the levels a MacBook Pro microphone gives at
// about 1 m (-45 to -35 dBFS) over a floor shaped like the one measured on it
// (-55 dBFS, most of it mains hum and rumble under 150 Hz), and the false-wake
// sources the detector must keep rejecting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as wake from "../../web/wake.js";
import { bluetoothMic, bluetoothSilence, pcmToFloat } from "../helpers/bt-audio.js";
import { readWavPcm24k } from "../helpers/fake-native-app.js";

const SR = 24000; // the native link's rate (daemon/native-proto.js)
const F = 512; // daemon/native-session.js VAD_FRAME
const FIXTURES = ["ask-files", "ask-count", "ask-later", "decide-name"];

function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}
const samples = (ms) => Math.round((ms * SR) / 1000);

function readWav(name) {
  const b = readFileSync(new URL(`../fixtures/${name}.wav`, import.meta.url));
  for (let o = 12; o + 8 <= b.length;) {
    const id = b.toString("ascii", o, o + 4);
    const size = b.readUInt32LE(o + 4);
    if (id === "data") {
      const n = Math.min(size, b.length - o - 8) >> 1;
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = b.readInt16LE(o + 8 + i * 2) / 32768;
      return x;
    }
    o += 8 + size;
  }
  throw new Error(`no data chunk in ${name}`);
}

/** Active speech level: mean power of the 20 ms frames within 25 dB of the loudest. */
function activeDb(x) {
  const pw = [];
  for (let o = 0; o + 480 <= x.length; o += 480) {
    let e = 0;
    for (let i = 0; i < 480; i++) e += x[o + i] * x[o + i];
    pw.push(e / 480);
  }
  const mx = Math.max(...pw);
  const act = pw.filter((p) => p > mx * 10 ** -2.5);
  return 10 * Math.log10(act.reduce((a, b) => a + b, 0) / act.length);
}
const atLevel = (x, dbfs) => { const k = 10 ** ((dbfs - activeDb(x)) / 20); return x.map((v) => v * k); };

/**
 * A MacBook Pro microphone's floor on the native capture path: power shares
 * measured there (0-40 Hz 4.5 %, 40-80 Hz 45 %, 80-150 Hz 14 %, 150-300 Hz 13 %,
 * 300-1000 Hz 19 %, 1-4 kHz 3.8 %): 60/120 Hz hum plus shaped noise.
 */
function macFloor(n, dbfs, seed = 3) {
  const r = rng(seed);
  let N = 1;
  while (N < n) N <<= 1;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (const [a, b, share] of [[1, 40, 4.5], [80, 150, 6], [150, 300, 13], [300, 1000, 19], [1000, 4000, 3.8], [4000, 12000, 0.2]]) {
    const k0 = Math.max(1, Math.round((a * N) / SR));
    const k1 = Math.round((b * N) / SR);
    const m = Math.sqrt(share / (k1 - k0));
    for (let k = k0; k < k1; k++) {
      const ph = Math.PI * (r() + 1);
      re[k] = m * Math.cos(ph); im[k] = -m * Math.sin(ph); // conjugated: the forward FFT then inverts
      re[N - k] = re[k]; im[N - k] = -im[k];
    }
  }
  wake.fft(re, im);
  const x = new Float32Array(n);
  let e = 0;
  for (let i = 0; i < n; i++) e += re[i] * re[i];
  const kn = Math.sqrt(46.5 / (e / n));
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    x[i] = re[i] * kn + Math.sqrt(90) * Math.sin(2 * Math.PI * 60 * t) + 4 * Math.sin(2 * Math.PI * 120 * t + 1);
  }
  let p = 0;
  for (const v of x) p += v * v;
  const k = 10 ** (dbfs / 20) / Math.sqrt(p / n);
  for (let i = 0; i < n; i++) x[i] *= k;
  return x;
}

/** `floorMs` of floor, then `sig` over the same floor. */
function overFloor(sig, floorDb = -55, floorMs = 2000, seed = 5) {
  const pre = samples(floorMs);
  const x = macFloor(pre + sig.length, floorDb, seed);
  for (let i = 0; i < sig.length; i++) x[pre + i] += sig[i];
  return x;
}

function detect(sig, opts = {}) {
  const vad = wake.createVad({ sampleRate: SR, profile: "native", ...opts });
  let hit = null;
  const near = [];
  for (let o = 0; o + F <= sig.length; o += F) {
    const r = vad.process(sig.subarray(o, o + F));
    if (r.near) near.push(r.near);
    if (r.trigger && hit === null) hit = o / SR;
  }
  return { hit, near, floorDb: vad.floorDb };
}

/** Typing: 8 ms decaying broadband clicks at irregular intervals around `everyMs`. */
function typing(ms, everyMs, peakDb, seed = 5) {
  const r = rng(seed);
  const x = new Float32Array(samples(ms));
  const len = samples(8);
  for (let s = 0; s < x.length; s += Math.round(samples(everyMs) * (0.6 + 0.8 * Math.abs(r())))) {
    for (let i = 0; i < len && s + i < x.length; i++) x[s + i] += r() * 10 ** (peakDb / 20) * Math.exp(-i / (len / 5));
  }
  return x;
}

/** Fan: steady low-passed broadband noise with a faint blade tone. */
function fan(ms, dbfs, seed = 9) {
  const r = rng(seed);
  const x = new Float32Array(samples(ms));
  let b = 0;
  for (let i = 0; i < x.length; i++) {
    b = 0.97 * b + 0.03 * r();
    x[i] = b * 3 + 0.3 * r() + 0.2 * Math.sin((2 * Math.PI * 190 * i) / SR);
  }
  let e = 0;
  for (const v of x) e += v * v;
  const k = 10 ** (dbfs / 20) / Math.sqrt(e / x.length);
  return x.map((v) => v * k);
}

const plus = (a, b) => { const o = Float32Array.from(a); for (let i = 0; i < Math.min(a.length, b.length); i++) o[i] += b[i]; return o; };

test("native presets: calibrated for the raw capture, below the page's bars", () => {
  assert.deepEqual(wake.sensitivityPreset("medium", "native"), wake.SENSITIVITY_NATIVE.medium);
  assert.deepEqual(wake.sensitivityPreset("bogus", "native"), wake.SENSITIVITY_NATIVE.medium);
  assert.equal(wake.sensitivityPreset("off", "native"), null);
  for (const s of ["low", "medium", "high"]) {
    assert.ok(wake.SENSITIVITY_NATIVE[s].snrDb < wake.SENSITIVITY[s].snrDb, s);
  }
  assert.equal(wake.createVad({ sampleRate: SR, profile: "native" }).profile, "native");
  assert.equal(wake.createVad({ sampleRate: SR }).profile, "page");
});

test("the analysis high-pass removes mains hum and keeps the speech band", () => {
  const level = (hz) => {
    const hp = wake.createHighPass(SR);
    const x = new Float32Array(SR);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * hz * i) / SR);
    const y = hp.process(x).subarray(SR / 2); // settled
    let e = 0;
    for (const v of y) e += v * v;
    return 10 * Math.log10(e / y.length / 0.5);
  };
  assert.ok(level(60) < -25, `60 Hz ${level(60).toFixed(1)} dB`);
  assert.ok(level(1000) > -0.5, `1 kHz ${level(1000).toFixed(1)} dB`);
  assert.ok(level(300) > -1, `300 Hz ${level(300).toFixed(1)} dB`);
});

test("normal speech at -45 and -40 dBFS over a MacBook floor wakes on medium (every fixture, three floors)", () => {
  for (const name of FIXTURES) {
    const speech = readWav(name);
    for (const lvl of [-45, -40]) {
      for (const seed of [5, 6, 7]) {
        const { hit, near } = detect(overFloor(atLevel(speech, lvl), -55, 2000, seed), { sensitivity: "medium" });
        assert.ok(hit !== null, `${name} at ${lvl} dBFS (seed ${seed}) did not wake: ${JSON.stringify(near)}`);
        assert.ok(hit >= 2, `${name}: woke before the speech`);
      }
    }
  }
});

test("reach: over the MacBook floor the native profile wakes on quieter speech than the page's presets did", () => {
  const rate = (profile, lvl) => {
    let hits = 0;
    let total = 0;
    for (const name of FIXTURES) {
      for (const seed of [5, 6, 7]) {
        const sig = overFloor(atLevel(readWav(name), lvl), -55, 2000, seed);
        const vad = wake.createVad({ sampleRate: SR, sensitivity: "medium", profile });
        let hit = false;
        for (let o = 0; o + F <= sig.length; o += F) if (vad.process(sig.subarray(o, o + F)).trigger) hit = true;
        total++;
        if (hit) hits++;
      }
    }
    return hits / total;
  };
  const page = rate("page", -48);
  const native = rate("native", -48);
  assert.ok(native >= 0.9, `native wakes ${native} of speech at -48 dBFS`);
  assert.ok(native > page, `native ${native} vs page ${page}`);
});

test("speech over a noisier floor (-50 dBFS) still wakes at -40 dBFS", () => {
  for (const name of FIXTURES) {
    const { hit } = detect(overFloor(atLevel(readWav(name), -40), -50), { sensitivity: "medium" });
    assert.ok(hit !== null, name);
  }
});

test("typing, fans, hum and an abrupt steady tone never wake the native detector", () => {
  const n = 8000;
  const cases = {
    "typing, -20 dBFS peaks": plus(macFloor(samples(n), -55, 11), typing(n, 150, -20)),
    "fast typing, -10 dBFS peaks": plus(macFloor(samples(n), -55, 12), typing(n, 70, -10, 6)),
    "fan at -45 dBFS": plus(macFloor(samples(n), -55, 13), fan(n, -45)),
    "fan starting at -40 dBFS": plus(macFloor(samples(n), -55, 14), (() => { const f = fan(n, -40); f.fill(0, 0, samples(3000)); return f; })()),
    "hum only, -48 dBFS": macFloor(samples(n), -48, 15),
    "tone starting at -30 dBFS": plus(macFloor(samples(n), -55, 16), (() => {
      const t = new Float32Array(samples(n));
      for (let i = samples(2000); i < t.length; i++) {
        const s = i / SR;
        t[i] = 0.0316 * (Math.sin(2 * Math.PI * 220 * s) + 0.5 * Math.sin(4 * Math.PI * 220 * s) + 0.3 * Math.sin(6 * Math.PI * 220 * s));
      }
      return t;
    })()),
  };
  for (const s of ["low", "medium", "high"]) {
    for (const [what, sig] of Object.entries(cases)) assert.equal(detect(sig, { sensitivity: s }).hit, null, `${what} woke on ${s}`);
    // A calibrated quiet device (a headset at -50 dBFS) lowers the level bar, not the other gates.
    for (const [what, sig] of Object.entries(cases)) assert.equal(detect(sig, { sensitivity: s, speechDb: -50 }).hit, null, `${what} woke on ${s}, calibrated`);
  }
});

/** A fixture as AirPods deliver it in call mode (8 kHz band, gated -80 dBFS floor), after 2 s of that idle signal. */
const headset = (name, speechDb) => Float32Array.from(pcmToFloat(Buffer.concat([
  bluetoothSilence(2000), bluetoothMic(readWavPcm24k(new URL(`../fixtures/${name}.wav`, import.meta.url).pathname), { speechDb }), bluetoothSilence(500),
])));

test("Bluetooth headset speech (8 kHz band, gated floor) at -55 to -45 dBFS wakes on medium, uncalibrated and calibrated", () => {
  for (const name of FIXTURES) {
    for (const lvl of [-55, -50, -45]) {
      const sig = headset(name, lvl);
      assert.ok(detect(sig, { sensitivity: "medium" }).hit !== null, `${name} at ${lvl} dBFS (fixed preset)`);
      assert.ok(detect(sig, { sensitivity: "medium", speechDb: lvl }).hit !== null, `${name} at ${lvl} dBFS (calibrated at that level)`);
    }
  }
});

test("calibration follows the user's speech on the device: the level bar sits CALIBRATED_BELOW_DB under it", () => {
  const vad = wake.createVad({ sampleRate: SR, profile: "native", sensitivity: "medium", speechDb: -31 });
  assert.equal(vad.calibrated, true);
  assert.equal(vad.minDb, -31 - wake.CALIBRATED_BELOW_DB.medium);
  vad.setSensitivity("high");
  assert.equal(vad.minDb, -31 - wake.CALIBRATED_BELOW_DB.high);
  assert.equal(wake.createVad({ sampleRate: SR, profile: "native", sensitivity: "medium" }).minDb, wake.SENSITIVITY_NATIVE.medium.minDb, "uncalibrated: the fixed preset");
  assert.equal(wake.createVad({ sampleRate: SR, profile: "page", sensitivity: "medium", speechDb: -31 }).calibrated, false, "the page profile is never calibrated");
  // A loud device (speech at -31): distant talk 20 dB under the user stays out, the user wakes it.
  let woke = 0;
  for (const name of FIXTURES) {
    assert.equal(detect(headset(name, -55), { sensitivity: "medium", speechDb: -31 }).hit, null, `${name}: -55 dBFS on a -31 dBFS device`);
    if (detect(headset(name, -35), { sensitivity: "medium", speechDb: -31 }).hit !== null) woke++;
  }
  assert.equal(woke, FIXTURES.length);
});

test("false-wake boost still raises the bar on the native profile", () => {
  const sig = overFloor(atLevel(readWav("ask-files"), -45));
  assert.ok(detect(sig, { sensitivity: "medium" }).hit !== null);
  assert.equal(detect(sig, { sensitivity: "medium", boostDb: 12 }).hit, null);
});

test("near misses: quiet speech is reported once per candidate with the reason, and never wakes", () => {
  const { hit, near } = detect(overFloor(atLevel(readWav("ask-files"), -58)), { sensitivity: "medium" });
  assert.equal(hit, null);
  assert.ok(near.length >= 1, "at least one near miss");
  for (const n of near) {
    assert.deepEqual(Object.keys(n).sort(), ["bar_db", "floor_db", "level_db", "min_db", "ms", "reason", "snr_db", "voiced_ms"]);
    assert.ok(["snr", "level", "periodicity", "flatness", "band", "short", "density", "modulation"].includes(n.reason), n.reason);
    assert.ok(n.ms >= 120);
    assert.equal(n.bar_db, wake.SENSITIVITY_NATIVE.medium.snrDb);
  }
  // A wake is not also reported as a near miss.
  assert.equal(detect(overFloor(atLevel(readWav("ask-later"), -40)), { sensitivity: "medium" }).near.filter((n) => n.voiced_ms >= 300).length, 0);
});

test("floor: a 400 ms warm-up measures it (never from zeros or the first frame); a seed caps it", () => {
  const noiseAt = (dbfs, n, seed = 3) => macFloor(n, dbfs, seed);
  // Zeros (muted, blocked) are never a floor.
  const zeros = wake.createVad({ sampleRate: SR, profile: "native", floorDb: -60 });
  for (let i = 0; i < 200; i++) zeros.process(new Float32Array(F));
  assert.equal(zeros.floorDb, null);
  // A quiet start-up frame does not set it: the warm-up's 20th percentile does.
  const v = wake.createVad({ sampleRate: SR, profile: "native" });
  const room = noiseAt(-50, samples(1000));
  const first = room.subarray(0, F).map((x) => x * 0.05); // 26 dB quieter first frame
  v.process(first);
  for (let o = F; o + F <= room.length; o += F) v.process(room.subarray(o, o + F));
  assert.ok(v.floorDb > -62, `floor ${v.floorDb} follows the room, not the first frame`);
  // Seeded from the live mic: capped at seed + 6 dB (speech at arm time is not the floor).
  const seeded = wake.createVad({ sampleRate: SR, profile: "native", floorDb: -70 });
  for (let o = 0; o + F <= room.length; o += F) seeded.process(room.subarray(o, o + F));
  assert.ok(seeded.floorDb <= -64 + 0.5, `seeded floor ${seeded.floorDb}`);
});

test("a steady, periodic room hum right after arming never wakes (measured failure: first-frame floor)", () => {
  // Hum harmonics above the high-pass (180, 240, 300 Hz) at a steady -55 dBFS, as measured.
  const n = samples(10_000);
  const x = macFloor(n, -58, 21);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    x[i] += 0.0018 * (Math.sin(2 * Math.PI * 180 * t) + 0.7 * Math.sin(2 * Math.PI * 240 * t + 1) + 0.5 * Math.sin(2 * Math.PI * 300 * t + 2));
  }
  for (let i = 0; i < F; i++) x[i] *= i / F * 0.1; // a start-up ramp
  for (const s of ["low", "medium", "high"]) assert.equal(detect(x, { sensitivity: s }).hit, null, s);
});

test("floor tracker: the device's quiet level (10th percentile, high-passed), not its speech", () => {
  const tr = wake.createFloorTracker({ sampleRate: SR });
  assert.equal(tr.floorDb, null);
  const sig = overFloor(atLevel(readWav("ask-count"), -35), -55, 3000);
  for (let o = 0; o + F <= sig.length; o += F) tr.push(sig.subarray(o, o + F));
  for (let i = 0; i < 100; i++) tr.push(new Float32Array(F)); // zeros ignored
  const floor = tr.floorDb;
  assert.ok(floor !== null && floor < -58 && floor > -80, `floor ${floor}`);
  // Seeded with it, speech right after sleep starts wakes at once.
  const { hit } = detect(overFloor(atLevel(readWav("decide-name"), -45), -55, 200), { sensitivity: "medium", floorDb: floor });
  assert.ok(hit !== null);
  tr.reset();
  assert.equal(tr.floorDb, null);
});
