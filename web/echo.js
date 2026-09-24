// Echo measurement and the echo guard (SPEC §7.7). Pure: no DOM, no WebAudio.
// Imported by web/app.js (decisions, the echo test verdict) and by
// web/echo-worklet.js (the per-block DSP on the audio thread), and unit-tested
// in test/web/echo.test.js.
//
// Full duplex is the product, so the first defense is the browser's echo
// canceller (Chrome AEC3, or Apple voice processing in the desktop app), tied
// to the real output through the one <audio> element (§7.3). What it leaves
// behind is measured here, continuously, from two signals the page already
// has: the remote voice (an unplayed clone of the remote track) and the mic
// after echo cancellation. The echo guard is a last resort for when that
// residue stays high (for example the canceller's reference is the wrong
// device): a soft residual-echo suppressor with double-talk detection, the
// way conferencing apps do it, not a mute. It only lowers the mic while the
// assistant is talking AND the mic is no louder than the echo predicted from
// the assistant's own voice; anything louder (the user talking over it,
// a backchannel) opens it within one audio quantum (2.7 ms at 48 kHz).

export const QUANTUM = 128;
/** Estimator block: 4 quanta (512 samples, 10.7 ms at 48 kHz). */
export const BLOCK_QUANTA = 4;
/** The remote voice counts as talking above this level (dBFS, block RMS). */
export const REF_ACTIVE_DB = -50;
/** Echo delays searched: acoustic path + output and capture buffers. */
export const MAX_LAG_MS = 400;

const db = (p) => 10 * Math.log10(Math.max(p, 1e-12));
export const meanSquare = (buf) => {
  if (!buf || !buf.length) return 0;
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return s / buf.length;
};

function percentile(xs, q) {
  if (!xs.length) return NaN;
  const s = Float64Array.from(xs).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

/**
 * Leak estimator: how much of the remote voice the (echo-cancelled) mic
 * still hears. Fed one block at a time (mean-square powers of mic and remote
 * voice); `estimate()` finds the echo delay by correlating the two level
 * envelopes and measures the echo level relative to the voice.
 *  - corr: Pearson correlation of the dB envelopes at the best delay (echo ≈ 1,
 *    the user's own speech or noise ≈ 0);
 *  - leakDb: mic level minus voice level at that delay (30th percentile, so a
 *    user talking over the voice does not inflate it); when the echo is under
 *    the mic's noise floor, an upper bound (`belowFloor`).
 */
export function createLeakEstimator({ blockMs = (QUANTUM * BLOCK_QUANTA * 1000) / 48000, windowMs = 6000, maxLagMs = MAX_LAG_MS } = {}) {
  const maxLag = Math.max(1, Math.round(maxLagMs / blockMs));
  const win = Math.max(50, Math.round(windowMs / blockMs));
  const size = win + maxLag + 1;
  const mic = new Float32Array(size);
  const ref = new Float32Array(size);
  let n = 0;
  let floor = null; // mic noise floor (power)
  const up = Math.pow(10, (3 * blockMs) / 1000 / 10); // floor rises at most 3 dB/s

  return {
    blockMs,
    get blocks() { return n; },
    push(micPow, refPow) {
      mic[n % size] = db(micPow);
      ref[n % size] = db(refPow);
      if (floor === null) floor = Math.max(micPow, 1e-10);
      else if (micPow < floor) floor = 0.5 * floor + 0.5 * Math.max(micPow, 1e-10);
      else floor *= up;
      n++;
    },
    reset() { n = 0; floor = null; },
    estimate() {
      const len = Math.min(n - maxLag, win);
      const out = { valid: false, corr: 0, lagMs: 0, leakDb: null, belowFloor: false, activeMs: 0, floorDb: floor === null ? null : db(floor), refDb: null };
      if (len < 50) return out;
      const start = n - len;
      let best = { corr: -2, lag: 0, count: 0 };
      for (let lag = 0; lag <= maxLag; lag++) {
        let c = 0; let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0;
        for (let k = start; k < n; k++) {
          const y = ref[(k - lag) % size];
          if (y < REF_ACTIVE_DB) continue;
          const x = mic[k % size];
          c++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
        }
        if (c < 40) continue;
        const vx = sxx - (sx * sx) / c;
        const vy = syy - (sy * sy) / c;
        const r = vx > 1e-9 && vy > 1e-9 ? (sxy - (sx * sy) / c) / Math.sqrt(vx * vy) : 0;
        if (r > best.corr) best = { corr: r, lag, count: c };
      }
      if (best.count < 40) return out;
      const floorDb = db(floor);
      const refs = [];
      const ratios = [];
      for (let k = start; k < n; k++) {
        const y = ref[(k - best.lag) % size];
        if (y < REF_ACTIVE_DB) continue;
        refs.push(y);
        const x = mic[k % size];
        if (x > floorDb + 4) ratios.push(x - y);
      }
      const refDb = percentile(refs, 0.5);
      // Double talk lowers the envelope correlation of a real echo (the
      // user's words are loud where the echo is not). Measure it again
      // without the blocks the user clearly dominates (mic 8 dB or more over
      // the echo level), and take the better of the two once the plain one
      // already shows a relation.
      if (best.corr >= 0.3 && ratios.length >= 40) {
        const cut = percentile(ratios, 0.3) + 8;
        let c = 0; let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0;
        for (let k = start; k < n; k++) {
          const y = ref[(k - best.lag) % size];
          const x = mic[k % size];
          if (y < REF_ACTIVE_DB || x <= floorDb + 4 || x - y > cut) continue;
          c++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
        }
        const vx = sxx - (sx * sx) / c;
        const vy = syy - (sy * sy) / c;
        if (c >= 40 && vx > 1e-9 && vy > 1e-9) out.corrClean = (sxy - (sx * sy) / c) / Math.sqrt(vx * vy);
      }
      out.valid = true;
      out.corr = Math.max(best.corr, out.corrClean ?? -1);
      out.corrAll = best.corr;
      out.lagMs = best.lag * blockMs;
      out.activeMs = best.count * blockMs;
      out.refDb = refDb;
      if (ratios.length < 0.2 * refs.length) {
        out.belowFloor = true;
        out.leakDb = floorDb + 4 - refDb;
      } else {
        out.leakDb = percentile(ratios, 0.3);
      }
      return out;
    },
  };
}

/** Enough of the assistant's voice heard to judge (ms of remote speech in the window). */
export const MIN_ACTIVE_MS = 1500;

/**
 * "unknown" | "low" | "some" | "high" from an estimate. High means the mic
 * clearly hears the assistant after echo cancellation (loud and correlated);
 * that is what makes gpt-live-1 transcribe its own voice.
 */
export function classifyLeak(e) {
  if (!e || !e.valid || e.activeMs < MIN_ACTIVE_MS || e.leakDb === null) return "unknown";
  if (e.belowFloor) return "low";
  if (e.corr >= 0.6 && e.leakDb >= -30) return "high";
  if (e.corr >= 0.4 && e.leakDb >= -45) return "some";
  return "low";
}

/** Echo test verdict from one or more measurements. */
export function echoTestVerdict(level) {
  if (level === "high") return { level: "heavy", title: "Heavy echo", advice: "The microphone hears the speaker. Use headphones or turn the speaker down; the echo guard keeps Sotto from answering itself." };
  if (level === "some") return { level: "some", title: "Some echo", advice: "Echo cancellation catches most of it and Sotto filters the rest. Headphones are best." };
  if (level === "low") return { level: "good", title: "Good", advice: "The microphone does not hear the speaker. You can talk over Sotto at any time." };
  return { level: "unknown", title: "Not sure", advice: "Too quiet to measure. Try again with the speaker a little louder." };
}

const HEADPHONES = /airpods|headphone|headset|earbud|earphone|buds\b|beats|bluetooth|hands-free|pods\b|bose|sony wh|wh-1000|jabra|plantronics|shokz/i;
/** A device label that is headphones (no echo path). */
export const isHeadphones = (label) => HEADPHONES.test(String(label || ""));

/**
 * Should the echo guard be on? (§7.7)
 *   mode "off" never, "on" always; "auto" only with two kinds of evidence:
 *   echo cancellation is not enough on this output (two estimates in a row
 *   say "high", or this output's echo test said "heavy") AND the echo does
 *   harm: the daemon's echo filter caught the Live model transcribing its own
 *   voice in the last HEARD_RECENT_MS (`heard`). gpt-live-1 ignored its own
 *   voice even at 0 dB of echo in every measured run, so a loud leak alone is
 *   not a reason to touch the user's audio. Headphones never. Once on in
 *   auto, it stays on until the leak has read "low" for AUTO_OFF_MS of the
 *   assistant's speech (not wall time: silence proves nothing).
 * @param {object} s  {mode, headphones, testLevel, engaged, highStreak, lowSpeechMs, heard}
 * @returns {{engaged:boolean, reason:string}}
 */
export const AUTO_OFF_MS = 20000;
export const HEARD_RECENT_MS = 120000;
export function guardDecision(s) {
  if (s.mode === "off") return { engaged: false, reason: "off" };
  if (s.mode === "on") return { engaged: true, reason: "on" };
  if (s.headphones) return { engaged: false, reason: "headphones" };
  if (s.engaged) return s.lowSpeechMs >= AUTO_OFF_MS ? { engaged: false, reason: "leak_low" } : { engaged: true, reason: s.reason || "leak_high" };
  const leaky = s.testLevel === "heavy" || s.highStreak >= 2;
  if (!leaky) return { engaged: false, reason: "leak_ok" };
  if (!s.heard) return { engaged: false, reason: "not_heard" };
  return { engaged: true, reason: s.testLevel === "heavy" && !(s.highStreak >= 2) ? "echo_test" : "leak_high" };
}

/**
 * The echo guard's DSP, one 128-sample quantum at a time: a full-band
 * residual-echo suppressor with double-talk detection.
 *   predicted echo P = leak × (remote voice power, smoothed over 10 ms, at the
 *   echo delay ±1 quantum, held with a short decay for the room's tail);
 *   near-end speech = mic power (this quantum, or smoothed over 5 ms) >
 *   NEAR_MARGIN × P (3 dB over the echo), or within HOLD_MS after it: gain 1,
 *   reached within the same quantum; otherwise a Wiener-like gain 1 − 2P/mic,
 *   floored at GAIN_FLOOR (-18 dB), falling with a 60 ms release. With the
 *   assistant silent, P is 0 and the gain is 1.
 * Tuned for full duplex first (measured with gpt-live-1, SPEC-DEVIATIONS "Echo
 * guard"): a first version (6 dB margin over a peak-held prediction, -24 dB
 * floor) cut the user's words under a -10 dB echo in one of two real runs.
 * Not engaged: the output is the input (it still tracks, so it can engage at once).
 */
export const NEAR_MARGIN = 2; // 3 dB
export const GAIN_FLOOR = Math.pow(10, -18 / 20);
export const HOLD_MS = 150;
export function createEchoGate({ sampleRate = 48000, quantum = QUANTUM, maxLagMs = MAX_LAG_MS } = {}) {
  const qMs = (quantum * 1000) / sampleRate;
  const size = Math.ceil((maxLagMs + 60) / qMs) + 4;
  const hist = new Float32Array(size);
  let q = 0;
  let leak = Math.pow(10, -20 / 10); // prior until measured: -20 dB
  let lagQ = Math.round(60 / qMs);
  const spreadQ = 1;
  const refA = 1 - Math.exp(-qMs / 10);
  const micA = 1 - Math.exp(-qMs / 5);
  let refSm = 0;
  let micSm = 0;
  const decay = Math.pow(10, -(40 / 150) * qMs / 10); // -40 dB over 150 ms
  const release = 1 - Math.exp(-qMs / 60);
  const holdQ = Math.round(HOLD_MS / qMs);
  let tail = 0;
  let g = 1;
  let hold = 0;
  let floor = null;
  // quanta: all; ref: the assistant talking (remote voice ≥ REF_ACTIVE_DB); echoQuanta: echo
  // predicted over the mic's floor; near: of those, the user louder; attenuated: of `ref`, gain < 0.5 while engaged.
  const stats = { quanta: 0, ref: 0, echoQuanta: 0, attenuated: 0, near: 0 };
  const refActive = Math.pow(10, REF_ACTIVE_DB / 10);
  const gate = {
    engaged: false,
    qMs,
    get gain() { return g; },
    setModel({ leakDb, lagMs }) {
      if (Number.isFinite(leakDb)) leak = Math.pow(10, Math.min(6, Math.max(-60, leakDb)) / 10);
      if (Number.isFinite(lagMs)) lagQ = Math.max(0, Math.min(size - spreadQ - 2, Math.round(lagMs / qMs)));
    },
    /** Predicted echo power for the current quantum (after pushing the reference). */
    predicted() { return leak * tail; },
    process(mic, ref, out) {
      const len = out ? out.length : mic ? mic.length : quantum;
      const refPow = meanSquare(ref);
      refSm += (refPow - refSm) * refA;
      hist[q % size] = refSm;
      q++;
      let m = 0;
      for (let d = lagQ - spreadQ; d <= lagQ + spreadQ; d++) {
        if (d < 0 || d >= size || q - 1 - d < 0) continue;
        const v = hist[(q - 1 - d) % size];
        if (v > m) m = v;
      }
      tail = Math.max(tail * decay, m);
      const P = leak * tail;
      const micPow = meanSquare(mic);
      micSm += (micPow - micSm) * micA;
      if (floor === null) floor = Math.max(micPow, 1e-10);
      else if (micPow < floor) floor = 0.5 * floor + 0.5 * Math.max(micPow, 1e-10);
      else floor *= 1.0005;
      const echoy = P > 2 * floor;
      const micNow = Math.max(micPow, micSm);
      const near = micNow > NEAR_MARGIN * P && micNow > 2 * floor;
      if (near && echoy) hold = holdQ;
      let target = 1;
      if (!gate.engaged || near || hold > 0) target = 1;
      else if (echoy) target = Math.max(GAIN_FLOOR, Math.min(1, 1 - (2 * P) / (micPow + 1e-12)));
      // Silence between syllables: keep the gain (reopening there would let
      // every echo syllable's onset through). Speech of any kind is `near`.
      else if (micPow < 4 * floor) target = g;
      if (hold > 0) hold--;
      const next = target >= g ? target : g + (target - g) * release;
      if (out) {
        if (mic) for (let i = 0; i < len; i++) out[i] = mic[i] * (g + ((next - g) * (i + 1)) / len);
        else out.fill(0);
      }
      g = next;
      stats.quanta++;
      if (refPow >= refActive) stats.ref++;
      if (echoy) stats.echoQuanta++;
      if (echoy && near) stats.near++;
      if (gate.engaged && g < 0.5 && refPow >= refActive) stats.attenuated++;
      return g;
    },
    stats() { return { ...stats }; },
    resetStats() { stats.quanta = stats.ref = stats.echoQuanta = stats.attenuated = stats.near = 0; },
  };
  return gate;
}
