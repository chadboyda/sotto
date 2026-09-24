// Echo measurement and echo guard DSP (web/echo.js, SPEC §7.7), on synthetic
// speech: noise shaped by a syllable-rate envelope, like a voice's level.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLeakEstimator, createEchoGate, classifyLeak, guardDecision, echoTestVerdict, isHeadphones,
  meanSquare, QUANTUM, BLOCK_QUANTA, AUTO_OFF_MS,
} from "../../web/echo.js";

const SR = 48000;
const db = (p) => 10 * Math.log10(Math.max(p, 1e-12));

/** Seeded PRNG so the tests are repeatable. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** "Speech": noise × on/off syllables (120-320 ms on, 60-200 ms off), at `dbfs` while on. */
function speech(seconds, dbfs, seed, { from = 0, to = seconds } = {}) {
  const r = rng(seed);
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const amp = Math.pow(10, dbfs / 20) * Math.sqrt(3); // uniform noise RMS = amp/sqrt(3)
  let i = Math.round(from * SR);
  const end = Math.round(to * SR);
  while (i < end) {
    const on = Math.round((0.12 + r() * 0.2) * SR);
    for (let k = 0; k < on && i + k < end; k++) {
      const env = Math.sin((Math.PI * k) / on); // soft syllable shape
      out[i + k] = (r() * 2 - 1) * amp * env;
    }
    i += on + Math.round((0.06 + r() * 0.14) * SR);
  }
  return out;
}
function noise(seconds, dbfs, seed) {
  const r = rng(seed);
  const amp = Math.pow(10, dbfs / 20) * Math.sqrt(3);
  return Float32Array.from({ length: Math.round(seconds * SR) }, () => (r() * 2 - 1) * amp);
}
/** `x` delayed by `ms` and scaled by `gainDb`. */
function echoOf(x, ms, gainDb) {
  const d = Math.round((ms / 1000) * SR);
  const g = Math.pow(10, gainDb / 20);
  const out = new Float32Array(x.length);
  for (let i = d; i < x.length; i++) out[i] = x[i - d] * g;
  return out;
}
const mix = (...xs) => { const out = new Float32Array(xs[0].length); for (const x of xs) for (let i = 0; i < out.length; i++) out[i] += x[i]; return out; };

/** Feed mic/ref through the estimator in blocks, return the final estimate. */
function estimate(mic, ref) {
  const est = createLeakEstimator({ blockMs: (QUANTUM * BLOCK_QUANTA * 1000) / SR, windowMs: 6000 });
  const B = QUANTUM * BLOCK_QUANTA;
  for (let i = 0; i + B <= mic.length; i += B) est.push(meanSquare(mic.subarray(i, i + B)), meanSquare(ref.subarray(i, i + B)));
  return est.estimate();
}

/** Run the gate over mic/ref; returns the output and the per-quantum gains. */
function runGate(mic, ref, { engaged = true, model } = {}) {
  const gate = createEchoGate({ sampleRate: SR });
  gate.engaged = engaged;
  if (model) gate.setModel(model);
  const out = new Float32Array(mic.length);
  const gains = [];
  for (let i = 0; i + QUANTUM <= mic.length; i += QUANTUM) {
    gains.push(gate.process(mic.subarray(i, i + QUANTUM), ref.subarray(i, i + QUANTUM), out.subarray(i, i + QUANTUM)));
  }
  return { out, gains, gate };
}
const energy = (x, a, b) => meanSquare(x.subarray(Math.round(a * SR), Math.round(b * SR)));

test("estimator: an uncancelled echo (-20 dB, 80 ms) is found, measured and called high", () => {
  const ref = speech(8, -20, 1);
  const mic = mix(echoOf(ref, 80, -20), noise(8, -70, 2));
  const e = estimate(mic, ref);
  assert.ok(e.valid);
  assert.ok(e.corr > 0.8, `corr ${e.corr}`);
  assert.ok(Math.abs(e.lagMs - 80) <= 12, `lag ${e.lagMs}`);
  assert.ok(Math.abs(e.leakDb - -20) <= 3, `leak ${e.leakDb}`);
  assert.equal(classifyLeak(e), "high");
});

test("estimator: echo cancelled below the noise floor is low", () => {
  const ref = speech(8, -20, 3);
  const mic = mix(echoOf(ref, 60, -60), noise(8, -62, 4));
  const e = estimate(mic, ref);
  assert.equal(classifyLeak(e), "low", JSON.stringify(e));
});

test("estimator: the user talking over the voice, no echo, is not echo", () => {
  const ref = speech(8, -20, 5);
  const mic = mix(speech(8, -22, 6), noise(8, -70, 7));
  const e = estimate(mic, ref);
  assert.ok(e.corr < 0.4, `corr ${e.corr}`);
  assert.notEqual(classifyLeak(e), "high");
});

test("estimator: double talk does not hide a strong echo", () => {
  const ref = speech(8, -20, 8);
  const mic = mix(echoOf(ref, 120, -15), speech(8, -25, 9, { from: 2, to: 5 }), noise(8, -70, 10));
  const e = estimate(mic, ref);
  assert.ok(Math.abs(e.lagMs - 120) <= 12, `lag ${e.lagMs}`);
  assert.equal(classifyLeak(e), "high", JSON.stringify(e));
});

test("estimator: nothing to judge without the assistant's voice", () => {
  const mic = speech(4, -20, 11);
  assert.equal(classifyLeak(estimate(mic, new Float32Array(mic.length))), "unknown");
});

test("gate: not engaged, the mic passes untouched", () => {
  const ref = speech(3, -20, 12);
  const mic = mix(echoOf(ref, 80, -10), noise(3, -70, 13));
  const { out } = runGate(mic, ref, { engaged: false, model: { leakDb: -10, lagMs: 80 } });
  for (let i = 0; i < mic.length; i += 997) assert.equal(out[i], mic[i]);
});

test("gate: engaged, echo alone is pushed down by at least 15 dB", () => {
  const ref = speech(6, -20, 14);
  const mic = mix(echoOf(ref, 80, -10), noise(6, -70, 15));
  const { out } = runGate(mic, ref, { model: { leakDb: -10, lagMs: 80 } });
  const drop = db(energy(mic, 1, 6)) - db(energy(out, 1, 6));
  assert.ok(drop >= 15, `echo attenuated ${drop.toFixed(1)} dB`);
});

test("gate: double talk passes the user (full duplex) and opens within 20 ms", () => {
  // Echo at -10 dB of the voice (a bad case: echo cancellation not working);
  // the user talks over the assistant at a normal level from 2 s to 5 s.
  const ref = speech(7, -20, 16);
  const user = speech(7, -22, 17, { from: 2, to: 5 });
  const echo = echoOf(ref, 80, -10);
  const mic = mix(echo, user, noise(7, -70, 18));
  const { out, gains } = runGate(mic, ref, { model: { leakDb: -10, lagMs: 80 } });
  // The user's words: output energy vs input energy where the user is louder than the echo.
  let inE = 0;
  let outE = 0;
  for (let i = 2 * SR; i < 5 * SR; i += QUANTUM) {
    const u = meanSquare(user.subarray(i, i + QUANTUM));
    if (u > 4 * meanSquare(echo.subarray(i, i + QUANTUM))) { inE += meanSquare(mic.subarray(i, i + QUANTUM)); outE += meanSquare(out.subarray(i, i + QUANTUM)); }
  }
  const loss = db(inE) - db(outE);
  assert.ok(loss <= 1, `user speech lost ${loss.toFixed(2)} dB`);
  // Attack: from each user syllable onset to gain ≥ 0.9.
  const qMs = (QUANTUM * 1000) / SR;
  let worst = 0;
  let prevOn = false;
  for (let q = Math.round((2 * SR) / QUANTUM); q < Math.round((5 * SR) / QUANTUM); q++) {
    const u = meanSquare(user.subarray(q * QUANTUM, (q + 1) * QUANTUM));
    const on = u > 4 * meanSquare(echo.subarray(q * QUANTUM, (q + 1) * QUANTUM)) + 1e-7;
    if (on && !prevOn) {
      let k = q;
      while (k < gains.length && gains[k] < 0.9) k++;
      worst = Math.max(worst, (k - q) * qMs);
    }
    prevOn = on;
  }
  assert.ok(worst <= 20, `attack ${worst.toFixed(1)} ms`);
});

test("gate: the user 4 dB under the voice, over a -10 dB echo (the failing real case), loses ≤ 1 dB", () => {
  const ref = speech(7, -18, 24);
  const user = speech(7, -22, 25, { from: 1.5, to: 5.5 });
  const echo = echoOf(ref, 50, -10);
  const mic = mix(echo, user, noise(7, -70, 26));
  const { out } = runGate(mic, ref, { model: { leakDb: -10, lagMs: 50 } });
  const loss = db(energy(mic, 1.5, 5.5)) - db(energy(out, 1.5, 5.5));
  assert.ok(loss <= 1, `double talk lost ${loss.toFixed(2)} dB`);
});

test("gate: a quiet backchannel over a loud echo still gets through mostly", () => {
  const ref = speech(5, -18, 19);
  const user = speech(5, -30, 20, { from: 2, to: 2.6 }); // "mm-hm", 12 dB under the voice
  const echo = echoOf(ref, 60, -25);
  const mic = mix(echo, user, noise(5, -72, 21));
  const { out } = runGate(mic, ref, { model: { leakDb: -25, lagMs: 60 } });
  const loss = db(energy(mic, 2, 2.6)) - db(energy(out, 2, 2.6));
  assert.ok(loss <= 2, `backchannel lost ${loss.toFixed(2)} dB`);
});

test("gate: with the assistant silent nothing is ever attenuated", () => {
  const user = speech(4, -35, 22);
  const mic = mix(user, noise(4, -70, 23));
  const { gains } = runGate(mic, new Float32Array(mic.length), { model: { leakDb: 0, lagMs: 50 } });
  assert.ok(gains.every((g) => g === 1));
});

test("guardDecision: off/on/auto, headphones, echo test, hysteresis", () => {
  assert.deepEqual(guardDecision({ mode: "off", testLevel: "heavy", highStreak: 9 }), { engaged: false, reason: "off" });
  assert.deepEqual(guardDecision({ mode: "on", headphones: true }), { engaged: true, reason: "on" });
  assert.equal(guardDecision({ mode: "auto", headphones: true, highStreak: 5 }).engaged, false);
  assert.equal(guardDecision({ mode: "auto", highStreak: 1, heard: true }).engaged, false, "one reading is not enough");
  assert.deepEqual(guardDecision({ mode: "auto", highStreak: 5 }), { engaged: false, reason: "not_heard" }, "a loud leak the model ignores is left alone");
  assert.equal(guardDecision({ mode: "auto", highStreak: 2, heard: true }).engaged, true);
  assert.equal(guardDecision({ mode: "auto", testLevel: "heavy", heard: true }).reason, "echo_test");
  assert.equal(guardDecision({ mode: "auto", testLevel: "heavy" }).engaged, false);
  assert.equal(guardDecision({ mode: "auto", engaged: true, lowSpeechMs: AUTO_OFF_MS - 1 }).engaged, true);
  assert.equal(guardDecision({ mode: "auto", engaged: true, lowSpeechMs: AUTO_OFF_MS }).engaged, false);
});

test("echo test verdicts and headphone labels", () => {
  assert.equal(echoTestVerdict("high").level, "heavy");
  assert.equal(echoTestVerdict("some").level, "some");
  assert.equal(echoTestVerdict("low").level, "good");
  assert.equal(echoTestVerdict("unknown").level, "unknown");
  assert.ok(isHeadphones("AirPods Max"));
  assert.ok(isHeadphones("External Headphones"));
  assert.ok(!isHeadphones("MacBook Pro Speakers"));
  assert.ok(!isHeadphones(""));
});
