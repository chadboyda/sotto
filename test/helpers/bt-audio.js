// Bluetooth headset (hands-free profile) mic simulation for tests: turns a
// clean 24 kHz PCM16 speech fixture into what the app relays from AirPods.
//
// Measured on AirPods Max in call mode (macOS, raw AUHAL capture at the
// device's 24 kHz, 2026-09-25; confirmed on a `sotto debug capture` of the
// user talking): conversational speech at about -30 dBFS (active-frame
// median; loudest frames -15 to -21), a room floor near -80 dBFS, digital
// zeros between words (the headset's noise gate), and little energy above
// 8 kHz. The "-46 to -51 dBFS" once read as soft speech was keyboard typing
// (`keyboardTyping` below). Pure and deterministic (seeded noise), so unit tests and the e2e
// build identical fixtures.

const RATE = 24000;
const db = (p) => 10 * Math.log10(p + 1e-12);

function lcg(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** PCM16 LE Buffer -> Float64Array in [-1, 1). */
export function pcmToFloat(pcm) {
  const n = pcm.length >> 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}

/** Float samples -> PCM16 LE Buffer (clipped). */
export function floatToPcm(x) {
  const out = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32768))), i * 2);
  return out;
}

/** Windowed-sinc low-pass (Blackman), zero phase. */
export function lowPass(x, cutoffHz, rate = RATE, taps = 63) {
  const h = new Float64Array(taps);
  const m = (taps - 1) / 2;
  const fc = cutoffHz / rate;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const k = i - m;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let acc = 0;
    for (let j = 0; j < taps; j++) {
      const t = i + j - m;
      if (t >= 0 && t < x.length) acc += h[j] * x[t];
    }
    out[i] = acc;
  }
  return out;
}

/** Median level (dBFS) of the 20 ms frames louder than `activeDb` (the speech level). */
export function activeLevelDb(x, { frame = 480, activeDb = -60 } = {}) {
  const levels = [];
  for (let i = 0; i + frame <= x.length; i += frame) {
    let e = 0;
    for (let j = 0; j < frame; j++) e += x[i + j] * x[i + j];
    const d = db(e / frame);
    if (d > activeDb) levels.push(d);
  }
  if (!levels.length) return -Infinity;
  levels.sort((a, b) => a - b);
  return levels[Math.floor(levels.length / 2)];
}

/**
 * A speech fixture as a Bluetooth headset mic delivers it.
 * @param {Buffer} pcm PCM16 LE 24 kHz, clean speech
 * @param {object} [o]
 * @param {number} [o.speechDb=-31]   active speech level (dBFS)
 * @param {number} [o.floorDb=-80]    room noise level
 * @param {number} [o.bandHz=8000]    headset bandwidth
 * @param {number} [o.gateDb=-72]     10 ms blocks under this become exact zeros (noise gate)
 * @param {number} [o.seed=7]
 * @returns {Buffer} PCM16 LE 24 kHz
 */
const cache = new Map();

export function bluetoothMic(pcm, { speechDb = -31, floorDb = -80, bandHz = 8000, gateDb = -72, seed = 7 } = {}) {
  // Tests build the same fixture many times: keep the CPU for the code under test
  // (npm test runs files in parallel next to timing-sensitive tests).
  const key = `${pcm.length}:${pcm.length > 8 ? pcm.readInt32LE((pcm.length >> 2) & ~1) : 0}:${speechDb}:${floorDb}:${bandHz}:${gateDb}:${seed}`;
  const hit = cache.get(key);
  if (hit) return Buffer.from(hit);
  const out = bluetoothMicUncached(pcm, { speechDb, floorDb, bandHz, gateDb, seed });
  if (cache.size > 64) cache.clear();
  cache.set(key, out);
  return Buffer.from(out);
}

function bluetoothMicUncached(pcm, { speechDb, floorDb, bandHz, gateDb, seed }) {
  let x = pcmToFloat(pcm);
  const src = activeLevelDb(x, { activeDb: -45 });
  if (bandHz && bandHz < RATE / 2) x = lowPass(x, bandHz);
  const gain = Number.isFinite(src) ? 10 ** ((speechDb - src) / 20) : 1;
  const rnd = lcg(seed);
  const noiseAmp = 10 ** (floorDb / 20) * Math.sqrt(3); // uniform noise with that RMS
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] * gain + (rnd() * 2 - 1) * noiseAmp;
  const block = 240;
  for (let i = 0; i < y.length; i += block) {
    let e = 0;
    const end = Math.min(y.length, i + block);
    for (let j = i; j < end; j++) e += y[j] * y[j];
    if (db(e / (end - i)) < gateDb) y.fill(0, i, end);
  }
  return floatToPcm(y);
}

/** `ms` of the headset's idle signal (gated floor): mostly exact zeros with rare noise blocks. */
export function bluetoothSilence(ms, o = {}) {
  const n = Math.round((ms / 1000) * RATE);
  return bluetoothMic(Buffer.alloc(n * 2), o);
}

/**
 * Keyboard typing as a headset mic next to a laptop picks it up: keystrokes
 * (a short noise burst ringing around 2-4 kHz, then a softer key release 60-110
 * ms later) at about `rate` per second, on the headset's gated floor. Shaped
 * after a real capture (AirPods Max in call mode, `sotto debug capture`,
 * 2026-09-25): loudest frames about -25 dBFS, active-frame median about -43,
 * 13 % of the power under 1 kHz, pitch periodicity about 0.4 (speech: 95 %
 * and 0.75), 5 % of its frames passing daemon/agc.js's voicing test. This one
 * is a little harsher (a desk thump under each key: about 9 %). 0.4.3's AGC
 * took the real one for the user's speech at -50 dBFS.
 * @param {number} ms
 * @param {object} [o]
 * @param {number} [o.peakDb=-25]  level of the loudest keystroke frames (dBFS)
 * @param {number} [o.rate=7]      keystrokes per second
 * @param {number} [o.seed=11]
 * @returns {Buffer} PCM16 LE 24 kHz
 */
export function keyboardTyping(ms, { peakDb = -25, rate = 7, seed = 11, floorDb = -80, gateDb = -72 } = {}) {
  const n = Math.round((ms / 1000) * RATE);
  const rnd = lcg(seed);
  const y = new Float64Array(n);
  // Two-pole resonator around fc (the keycap and case ring).
  const click = (at, amp, fc, r = 0.93) => {
    const c = 2 * r * Math.cos((2 * Math.PI * fc) / RATE);
    let y1 = 0, y2 = 0;
    const len = Math.round(0.03 * RATE);
    for (let i = 0; i < len && at + i < n; i++) {
      const env = Math.exp(-i / (0.004 * RATE));
      const e = (rnd() * 2 - 1) * env;
      const v = e + c * y1 - r * r * y2;
      y2 = y1; y1 = v;
      y[at + i] += v * amp;
    }
  };
  let t = Math.round(rnd() * RATE / rate);
  while (t < n) {
    const amp = 0.5 + rnd() * 0.5;
    click(t, amp, 2200 + rnd() * 1800);
    click(t, amp * 0.03, 180 + rnd() * 250, 0.985); // the desk thump under it
    click(t + Math.round((0.06 + rnd() * 0.05) * RATE), amp * 0.35, 2600 + rnd() * 1400);
    t += Math.round(((0.4 + rnd() * 1.2) / rate) * RATE);
  }
  // Scale so the loudest 20 ms frames sit at peakDb.
  let best = 0;
  for (let i = 0; i + 480 <= n; i += 480) {
    let e = 0;
    for (let j = 0; j < 480; j++) e += y[i + j] * y[i + j];
    best = Math.max(best, e / 480);
  }
  const g = best > 0 ? Math.sqrt(10 ** (peakDb / 10) / best) : 0;
  const noiseAmp = 10 ** (floorDb / 20) * Math.sqrt(3);
  for (let i = 0; i < n; i++) y[i] = y[i] * g + (rnd() * 2 - 1) * noiseAmp;
  for (let i = 0; i < n; i += 240) {
    let e = 0;
    const end = Math.min(n, i + 240);
    for (let j = i; j < end; j++) e += y[j] * y[j];
    if (db(e / (end - i)) < gateDb) y.fill(0, i, end);
  }
  return floatToPcm(y);
}

/** Word recall of `heard` against `expected` (order-free bag of words, lower-cased, punctuation stripped). */
export function wordRecall(expected, heard) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean);
  const want = norm(expected);
  const got = new Map();
  for (const w of norm(heard)) got.set(w, (got.get(w) || 0) + 1);
  let hit = 0;
  for (const w of want) {
    const c = got.get(w) || 0;
    if (c > 0) { hit++; got.set(w, c - 1); }
  }
  return want.length ? hit / want.length : 0;
}
