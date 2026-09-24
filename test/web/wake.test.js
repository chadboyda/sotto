// Local voice wake (web/wake.js, SPEC §7.6): VAD on synthetic signals,
// pre-roll clip capture, WAV/base64 encoding and the listening gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as wake from "../../web/wake.js";

const SR = 48000;
const F = wake.FRAME_SIZE;

// ---- deterministic synthetic signals ----------------------------------------------
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}
const amp = (dbfs) => 10 ** (dbfs / 20);
const n = (ms) => Math.round((ms * SR) / 1000);

function noise(ms, dbfs, seed = 7) {
  const r = rng(seed);
  const x = new Float32Array(n(ms));
  const a = amp(dbfs) * Math.sqrt(3); // uniform noise RMS = a/sqrt(3)
  for (let i = 0; i < x.length; i++) x[i] = r() * a;
  return x;
}
const silence = (ms) => noise(ms, -70, 3);

/**
 * Speech-like: a pitched harmonic source (f0 with vibrato) shaped by three
 * formants, with a 4 Hz syllable envelope that dips ~20 dB, on a -70 dB floor.
 */
function speech(ms, dbfs = -25, { f0 = 120, seed = 11 } = {}) {
  const x = new Float32Array(n(ms));
  const formants = [[700, 1], [1200, 0.6], [2600, 0.25]];
  let ph = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    const f = f0 * (1 + 0.06 * Math.sin(2 * Math.PI * 3 * t));
    ph += (2 * Math.PI * f) / SR;
    let s = 0;
    for (let h = 1; h * f < 4000; h++) {
      let g = 0;
      for (const [fc, a] of formants) g += a / (1 + ((h * f - fc) / 150) ** 2);
      s += ((g + 0.05) * Math.sin(h * ph)) / h;
    }
    x[i] = s * (0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t - Math.PI / 2));
  }
  let e = 0;
  for (const v of x) e += v * v;
  const k = amp(dbfs) / Math.sqrt(e / x.length);
  const floor = noise(ms, -70, seed);
  for (let i = 0; i < x.length; i++) x[i] = x[i] * k + floor[i];
  return x;
}

/** Keyboard clicks: 6 ms decaying broadband bursts every `everyMs`. */
function clicks(ms, everyMs = 140, dbfs = -12) {
  const x = silence(ms);
  const r = rng(5);
  const len = n(6);
  for (let s = 0; s < x.length; s += n(everyMs)) {
    for (let i = 0; i < len && s + i < x.length; i++) x[s + i] += r() * amp(dbfs) * 3 * Math.exp(-i / (len / 4));
  }
  return x;
}

/** Steady music-like tone (fundamental + harmonics), no syllabic modulation. */
function tone(ms, dbfs = -25, f = 220) {
  const x = new Float32Array(n(ms));
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    x[i] = (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t) + 0.3 * Math.sin(6 * Math.PI * f * t)) * amp(dbfs);
  }
  return x;
}

function cat(...parts) {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Run a signal through a fresh VAD; returns per-frame results and the first trigger. */
function detect(sig, opts = {}) {
  const vad = wake.createVad({ sampleRate: SR, ...opts });
  const frames = [];
  for (let i = 0; i + F <= sig.length; i += F) frames.push(vad.process(sig.subarray(i, i + F)));
  const idx = frames.findIndex((r) => r.trigger);
  return { vad, frames, idx, hit: idx >= 0 ? frames[idx] : null, atMs: idx >= 0 ? ((idx + 1) * F * 1000) / SR : null };
}

// ---- features ----------------------------------------------------------------------
test("fft: a bin-centred sine lands in its bin", () => {
  const N = 64;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = Math.sin((2 * Math.PI * 5 * i) / N);
  wake.fft(re, im);
  const mag = [...re].map((v, k) => Math.hypot(v, im[k]));
  const peak = mag.indexOf(Math.max(...mag.slice(0, N / 2)));
  assert.equal(peak, 5);
  assert.ok(Math.abs(mag[5] - N / 2) < 1e-6);
});

test("frameFeatures separate voiced speech from white noise", () => {
  const sp = wake.frameFeatures(speech(100).subarray(n(40), n(40) + F), SR);
  const wn = wake.frameFeatures(noise(100, -30).subarray(0, F), SR);
  assert.ok(sp.periodicity > 0.8, `speech periodicity ${sp.periodicity}`);
  assert.ok(sp.bandRatio > 0.9, `speech band ratio ${sp.bandRatio}`);
  assert.ok(sp.flatness < 0.2, `speech flatness ${sp.flatness}`);
  assert.ok(wn.periodicity < 0.35 && wn.bandRatio < 0.3 && wn.flatness > 0.45, JSON.stringify(wn));
  assert.ok(Math.abs(wn.db - -30) < 1.5, `white noise level ${wn.db}`);
});

// ---- detection ---------------------------------------------------------------------
test("speech after silence wakes within ~0.5 s, with the onset located", () => {
  const { hit, atMs } = detect(cat(silence(1000), speech(1500)));
  assert.ok(hit, "triggered");
  assert.ok(atMs > 1250 && atMs < 1500, `trigger at ${atMs} ms (speech starts at 1000 ms)`);
  const onsetMs = (hit.onsetSample / SR) * 1000;
  assert.ok(Math.abs(onsetMs - 1000) <= 50, `onset ${onsetMs} ms`);
  assert.ok(hit.snrDb > 30);
});

test("fires once per speech run", () => {
  const { frames } = detect(cat(silence(500), speech(3000)));
  assert.equal(frames.filter((r) => r.trigger).length, 1);
});

test("a new run after a pause can fire again", () => {
  const { frames } = detect(cat(silence(500), speech(800), silence(800), speech(800)));
  assert.equal(frames.filter((r) => r.trigger).length, 2);
});

test("a short word, a pause, then speech: the onset goes back to the first word", () => {
  // "Hey," (250 ms, too short to wake on its own) … 300 ms pause … "can you ask …"
  const { hit } = detect(cat(silence(1000), speech(250, -25, { f0: 140 }), silence(300), speech(1500)));
  assert.ok(hit);
  const onsetMs = (hit.onsetSample / SR) * 1000;
  assert.ok(Math.abs(onsetMs - 1000) <= 50, `onset ${onsetMs} ms: the "Hey" is kept`);
  // A long gap is a separate utterance.
  const far = detect(cat(silence(1000), speech(250), silence(1500), speech(1500))).hit;
  assert.ok(Math.abs((far.onsetSample / SR) * 1000 - 2750) <= 50, "not chained over 1.5 s");
});

test("white noise does not wake", () => {
  assert.equal(detect(cat(silence(1000), noise(3000, -30))).hit, null);
});

test("keyboard clicks do not wake", () => {
  assert.equal(detect(cat(silence(1000), clicks(3000))).hit, null);
  assert.equal(detect(cat(silence(1000), clicks(3000, 60, -6))).hit, null, "fast loud typing");
});

test("a steady tone (music/TV hum) does not wake", () => {
  const { hit, frames } = detect(cat(silence(1000), tone(3000)));
  assert.equal(hit, null);
  assert.ok(frames.some((r) => r.voiced), "it is voiced, but lacks syllabic modulation");
});

test("a short sound ('uh', 200 ms) does not wake", () => {
  assert.equal(detect(cat(silence(1000), speech(200), silence(1000))).hit, null);
});

test("the noise floor adapts: speech over fan noise still wakes, the fan alone does not", () => {
  const fan = noise(6000, -45, 9);
  assert.equal(detect(cat(silence(500), fan)).hit, null);
  const sp = speech(1500, -22);
  const mixed = cat(silence(500), noise(4000, -45, 9), sp.map((v, i) => v + fan[i % fan.length]));
  const { hit, frames } = detect(mixed);
  assert.ok(hit, "speech 23 dB over the fan wakes");
  const before = frames[Math.floor(n(4500) / F) - 1].floorDb;
  assert.ok(before > -52, `floor followed the fan (${before} dB)`);
});

test("sensitivity: quiet speech wakes on high, not on low; off falls back to medium in the VAD", () => {
  const quiet = cat(silence(1000), speech(1500, -50));
  assert.ok(detect(quiet, { sensitivity: "high" }).hit, "high");
  assert.equal(detect(quiet, { sensitivity: "low" }).hit, null, "low: below its -46 dBFS floor");
  assert.equal(wake.sensitivityPreset("off"), null);
  assert.deepEqual(wake.sensitivityPreset("bogus"), wake.SENSITIVITY.medium);
});

test("boost (after false wakes) raises the bar", () => {
  const sig = cat(silence(1000), speech(1500, -58));
  // -58 dBFS speech over a -70 dB floor: 12 dB SNR.
  assert.ok(detect(sig, { sensitivity: "high" }).hit, "wakes with no boost");
  assert.equal(detect(sig, { sensitivity: "high", boostDb: 8 }).hit, null, "7 + 8 dB bar is above 12 dB SNR");
});

// ---- clip capture -----------------------------------------------------------------
test("clip recorder keeps a pre-roll, then captures from the requested sample", () => {
  const rec = wake.createClipRecorder({ sampleRate: 1000, preRollMs: 500, maxCaptureMs: 2000 });
  const frame = (v) => new Float32Array(100).fill(v);
  for (let i = 0; i < 20; i++) rec.push(frame(i)); // 2000 samples; keeps the last ~500
  assert.equal(rec.totalSamples, 2000);
  rec.startCapture(1200); // older than the pre-roll: clamped to what is kept
  assert.ok(rec.capturing);
  for (let i = 20; i < 25; i++) rec.push(frame(i));
  const clip = rec.finish();
  assert.equal(clip[0], 15, "starts at the oldest retained frame");
  assert.equal(clip.length, 1000);
  assert.equal(clip[clip.length - 1], 24);
  assert.ok(!rec.capturing);
});

test("clip recorder: exact start inside the pre-roll, and the capture cap", () => {
  const rec = wake.createClipRecorder({ sampleRate: 1000, preRollMs: 1000, maxCaptureMs: 300 });
  for (let i = 0; i < 10; i++) rec.push(new Float32Array(100).fill(i));
  rec.startCapture(950);
  for (let i = 10; i < 20; i++) rec.push(new Float32Array(100).fill(i));
  const clip = rec.finish();
  assert.equal(clip.length, 300, "capped");
  assert.equal(clip[0], 9);
  assert.equal(clip[50], 10);
  assert.equal(rec.finish().length, 0, "nothing without a capture");
});

test("VAD onset + recorder: the clip starts just before the speech", () => {
  const sig = cat(silence(2000), speech(1200));
  const vad = wake.createVad({ sampleRate: SR });
  const rec = wake.createClipRecorder({ sampleRate: SR });
  let clip = null;
  for (let i = 0; i + F <= sig.length; i += F) {
    const f = sig.subarray(i, i + F);
    rec.push(f);
    const r = vad.process(f);
    if (r.trigger) rec.startCapture(r.onsetSample - n(wake.ONSET_PAD_MS));
  }
  clip = rec.finish();
  const firstLoud = clip.findIndex((v) => Math.abs(v) > amp(-40));
  assert.ok(firstLoud > n(150) && firstLoud < n(350), `speech starts ${((firstLoud / SR) * 1000).toFixed(0)} ms into the clip`);
});

// ---- encoding ----------------------------------------------------------------------
test("encodeWav: 16 kHz PCM16 mono header and resampled length", () => {
  const src = speech(1000);
  const wav = wake.encodeWav(src, SR);
  const dv = new DataView(wav.buffer);
  const str = (o, l) => String.fromCharCode(...wav.slice(o, o + l));
  assert.equal(str(0, 4), "RIFF");
  assert.equal(str(8, 4), "WAVE");
  assert.equal(dv.getUint16(22, true), 1);
  assert.equal(dv.getUint32(24, true), 16000);
  assert.equal(dv.getUint16(34, true), 16);
  assert.equal(dv.getUint32(40, true), 16000 * 2);
  assert.equal(wav.length, 44 + 32000);
});

test("resample preserves a low tone and handles upsampling", () => {
  const x = tone(100, -6, 200);
  const y = wake.resample(x, 48000, 16000);
  assert.equal(y.length, x.length / 3);
  const peak = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(Math.abs(peak(y) - peak(x)) < 0.05);
  assert.equal(wake.resample(new Float32Array([0, 1]), 8000, 16000).length, 4);
  assert.equal(wake.resample(new Float32Array(0), 48000).length, 0);
});

test("bytesToBase64 matches Buffer for every padding case", () => {
  for (const len of [0, 1, 2, 3, 4, 5, 255]) {
    const b = new Uint8Array(len).map((_, i) => (i * 37 + 11) & 255);
    assert.equal(wake.bytesToBase64(b), Buffer.from(b).toString("base64"), `len ${len}`);
  }
});

// ---- gate and view -----------------------------------------------------------------
test("shouldListen: only while sleeping, idle page, stream up, unmuted, wake enabled", () => {
  const ok = { state: "sleeping", phase: "idle", sseUp: true, muted: false, wake: { enabled: true, sensitivity: "medium" } };
  assert.equal(wake.shouldListen(ok), true);
  for (const change of [{ state: "paused" }, { state: "live" }, { phase: "connecting" }, { phase: "error" }, { sseUp: false }, { muted: true },
    { wake: { enabled: false, sensitivity: "medium" } }, { wake: { enabled: true, sensitivity: "off" } }, { wake: undefined }]) {
    assert.equal(wake.shouldListen({ ...ok, ...change }), false, JSON.stringify(change));
  }
});

test("cooldownLeft and sleepView", () => {
  assert.equal(wake.cooldownLeft({ not_before: 5000 }, 2000), 3000);
  assert.equal(wake.cooldownLeft({ not_before: 0 }, 2000), 0);
  assert.equal(wake.cooldownLeft(undefined, 2000), 0);
  const v = wake.sleepView({});
  assert.equal(v.title, "Sleeping — just start talking");
  assert.equal(v.listening, true);
  assert.equal(wake.sleepView({ muted: true }).listening, false);
  assert.match(wake.sleepView({ muted: true }).body, /Press M/);
  assert.match(wake.sleepView({ cooldownMs: 9100 }).body, /10 s/);
  assert.match(wake.sleepView({ enabled: false }).body, /wake is off/);
  assert.match(wake.sleepView({ micError: "NotAllowedError" }).body, /NotAllowedError/);
});

test("wake.js and the worklet are DOM- and network-free", () => {
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  for (const f of ["wake.js", "wake-worklet.js"]) {
    const src = strip(readFileSync(new URL(`../../web/${f}`, import.meta.url), "utf8"));
    for (const word of ["document.", "window.", "navigator.", "fetch(", "localStorage", "http://", "https://"]) {
      assert.ok(!src.includes(word), `${f}: ${word}`);
    }
  }
});
