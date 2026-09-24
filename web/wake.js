// sotto web page: local voice wake (pure helpers, SPEC §7.6).
//
// While the daemon is `sleeping` there is no Live session (nothing is billed).
// The page keeps the microphone open locally and runs this voice-activity
// detector on it; sustained voiced speech wakes the Live session. The audio
// from speech onset until the new session is live is kept here and sent to
// the daemon, which transcribes it and hands the words to the model.
//
// Like lib.js, this module is free of DOM, WebAudio and network access, so
// node:test can drive it with synthetic signals (test/web/wake.test.js).

/** Samples per analysis frame (the worklet posts frames of exactly this size). */
export const FRAME_SIZE = 1024;
/** Rolling pre-roll kept while listening, so the opening words survive the wake. */
export const PRE_ROLL_MS = 3000;
/** The clip starts this long before the detected onset (soft consonants, breath). */
export const ONSET_PAD_MS = 250;
/** Hard cap on one wake clip (onset until the session is live). */
export const MAX_CLIP_MS = 15000;
/** Sample rate of the clip sent to the daemon (speech-to-text wants 16 kHz). */
export const CLIP_RATE = 16000;

/**
 * Wake sensitivity presets. `snrDb`: voiced energy above the adaptive noise
 * floor; `minDb`: absolute level (dBFS) below which nothing counts; `minSpeechMs`:
 * voiced time needed before waking. `off` disables local wake.
 */
export const SENSITIVITY = Object.freeze({
  low: Object.freeze({ snrDb: 16, minDb: -46, minSpeechMs: 420 }),
  medium: Object.freeze({ snrDb: 11, minDb: -54, minSpeechMs: 320 }),
  high: Object.freeze({ snrDb: 7, minDb: -62, minSpeechMs: 240 }),
});
export const SENSITIVITIES = Object.freeze(["off", "low", "medium", "high"]);

// Frame classification. Voiced speech is harmonic (strong periodicity at a
// 70-400 Hz pitch), concentrated in 80-4000 Hz and not noise-flat. Keyboard
// clicks and fans are broadband and aperiodic; a click is also too short.
const BAND_LO_HZ = 80;
const BAND_HI_HZ = 4000;
const MIN_BAND_RATIO = 0.5;
const MIN_PERIODICITY = 0.35;
const MAX_FLATNESS = 0.45;
const PITCH_MIN_HZ = 70;
const PITCH_MAX_HZ = 400;
/** Gaps (unvoiced consonants, short pauses) shorter than this keep a speech run going. */
const HANGOVER_MS = 160;
/**
 * Speech is syllabic: its level swings several dB within a few hundred ms.
 * Steady music, hum and TV tones mostly don't, so a run must show this much
 * level range (voiced frames and the dips between them) before it may wake.
 */
const MIN_MODULATION_DB = 5;
/** At least this share of a run's frames must be voiced. */
const MIN_DENSITY = 0.55;
/**
 * A short voiced run just before the one that triggers ("Hey," then a pause,
 * then "can you ...") is part of the same utterance: the reported onset goes
 * back to it when the gap is at most this long (e2e: "Hey" was lost without it).
 */
const CHAIN_GAP_MS = 700;
/** Runs shorter than this never extend the onset (a click or pop that passed as voiced). */
const CHAIN_MIN_MS = 60;
const FLOOR_MIN_DB = -90;
const FLOOR_MAX_DB = -20;

const db = (power) => 10 * Math.log10(power + 1e-12);

/** In-place iterative radix-2 FFT (re/im arrays of the same power-of-two length). */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const hannCache = new Map();
function hann(n) {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hannCache.set(n, w);
  }
  return w;
}

/**
 * Features of one frame (length must be a power of two).
 * @returns {{db:number, bandRatio:number, flatness:number, periodicity:number, zcr:number}}
 *   db: frame level in dBFS; bandRatio: share of power in 80-4000 Hz;
 *   flatness: spectral flatness in that band (0 tonal .. ~0.56 white noise);
 *   periodicity: best normalized autocorrelation at a 70-400 Hz pitch lag;
 *   zcr: zero crossings per second.
 */
export function frameFeatures(frame, sampleRate) {
  const n = frame.length;
  let energy = 0;
  let crossings = 0;
  for (let i = 0; i < n; i++) {
    energy += frame[i] * frame[i];
    if (i > 0 && (frame[i] >= 0) !== (frame[i - 1] >= 0)) crossings++;
  }
  const level = db(energy / n);
  const zcr = (crossings * sampleRate) / n;
  if (level < -100) return { db: level, bandRatio: 0, flatness: 1, periodicity: 0, zcr };

  // Spectrum (Hann window).
  const w = hann(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = frame[i] * w[i];
  fft(re, im);
  const binHz = sampleRate / n;
  const lo = Math.max(1, Math.round(BAND_LO_HZ / binHz));
  const hi = Math.min(n / 2 - 1, Math.round(BAND_HI_HZ / binHz));
  let total = 0;
  let band = 0;
  let logSum = 0;
  for (let k = 1; k < n / 2; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    total += p;
    if (k >= lo && k <= hi) {
      band += p;
      logSum += Math.log(p + 1e-20);
    }
  }
  const bins = hi - lo + 1;
  const bandRatio = total > 0 ? band / total : 0;
  const flatness = band > 0 ? Math.exp(logSum / bins) / (band / bins) : 1;

  // Periodicity on a ~16 kHz box-decimated copy (cheap, and pitch lives far below 8 kHz).
  const d = Math.max(1, Math.round(sampleRate / 16000));
  const m = Math.floor(n / d);
  const x = new Float64Array(m);
  let mean = 0;
  for (let i = 0; i < m; i++) {
    let s = 0;
    for (let j = 0; j < d; j++) s += frame[i * d + j];
    x[i] = s / d;
    mean += x[i];
  }
  mean /= m;
  for (let i = 0; i < m; i++) x[i] -= mean;
  const rate = sampleRate / d;
  const minLag = Math.max(2, Math.floor(rate / PITCH_MAX_HZ));
  const maxLag = Math.min(m - 16, Math.ceil(rate / PITCH_MIN_HZ));
  let periodicity = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let i = 0; i + lag < m; i++) {
      xy += x[i] * x[i + lag];
      xx += x[i] * x[i];
      yy += x[i + lag] * x[i + lag];
    }
    const r = xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0;
    if (r > periodicity) periodicity = r;
  }
  return { db: level, bandRatio, flatness, periodicity, zcr };
}

/** Preset for a sensitivity name; unknown names fall back to medium. `off` → null. */
export function sensitivityPreset(name) {
  if (name === "off") return null;
  return SENSITIVITY[name] || SENSITIVITY.medium;
}

/**
 * Streaming voice-activity detector for local wake.
 *
 *   const vad = createVad({sampleRate: 48000, sensitivity: "medium"});
 *   const r = vad.process(frame);   // frame: Float32Array(FRAME_SIZE)
 *   if (r.trigger) wake(r.onsetSample);
 *
 * Time is counted in samples, so it is deterministic in tests and unaffected
 * by main-thread jank. The noise floor tracks quiet frames (fast down, slow
 * up), so a fan or air conditioner raises the bar instead of waking.
 * `boostDb` raises the SNR bar (the daemon raises it after false wakes).
 * A trigger fires once per speech run.
 */
export function createVad({ sampleRate = 48000, sensitivity = "medium", boostDb = 0, floorDb = null } = {}) {
  let preset = sensitivityPreset(sensitivity) || SENSITIVITY.medium;
  let boost = Number(boostDb) || 0;
  let floor = floorDb;
  let samples = 0;
  let run = null;
  let recent = []; // runs that ended lately: {onset, end, voicedMs}
  const msOf = (n) => (n / sampleRate) * 1000;

  return {
    get floorDb() {
      return floor;
    },
    get samples() {
      return samples;
    },
    setSensitivity(name) {
      preset = sensitivityPreset(name) || SENSITIVITY.medium;
    },
    setBoost(v) {
      boost = Math.max(0, Number(v) || 0);
    },
    reset() {
      run = null;
      recent = [];
    },
    /**
     * @returns {{db:number, floorDb:number, snrDb:number, voiced:boolean, speaking:boolean,
     *            trigger:boolean, onsetSample:number|null, voicedMs:number}}
     */
    process(frame) {
      const f = frameFeatures(frame, sampleRate);
      const start = samples;
      samples += frame.length;
      const frameMs = msOf(frame.length);
      if (floor === null) floor = Math.min(FLOOR_MAX_DB, Math.max(FLOOR_MIN_DB, f.db));
      const snr = f.db - floor;
      const voiced =
        f.db >= preset.minDb &&
        snr >= preset.snrDb + boost &&
        f.bandRatio >= MIN_BAND_RATIO &&
        f.periodicity >= MIN_PERIODICITY &&
        f.flatness <= MAX_FLATNESS;

      let trigger = false;
      if (voiced) {
        if (!run) run = { onset: start, lastVoiced: start, voicedMs: 0, frames: 0, minDb: f.db, maxDb: f.db, fired: false };
        run.voicedMs += frameMs;
        run.lastVoiced = start;
      }
      if (run) {
        run.frames++;
        run.minDb = Math.min(run.minDb, f.db);
        run.maxDb = Math.max(run.maxDb, f.db);
        if (!voiced && msOf(start - run.lastVoiced) > HANGOVER_MS) {
          if (run.voicedMs >= CHAIN_MIN_MS) recent.push({ onset: run.onset, end: run.lastVoiced + frame.length, voicedMs: run.voicedMs });
          run = null;
        } else if (!run.fired && run.voicedMs >= preset.minSpeechMs) {
          const density = run.voicedMs / (run.frames * frameMs);
          if (density >= MIN_DENSITY && run.maxDb - run.minDb >= MIN_MODULATION_DB) {
            run.fired = true;
            trigger = true;
            // Chain back over the short runs just before this one (same utterance).
            let onset = run.onset;
            for (let i = recent.length - 1; i >= 0; i--) {
              if (msOf(onset - recent[i].end) > CHAIN_GAP_MS) break;
              onset = recent[i].onset;
            }
            run.onset = onset;
          }
        }
      }
      // Forget ended runs older than the pre-roll (the audio is gone anyway).
      while (recent.length && msOf(samples - recent[0].end) > PRE_ROLL_MS) recent.shift();
      if (!run && !voiced) {
        // Minimum tracking: follow quiet frames down quickly, up slowly (~2.7 s).
        const a = f.db < floor ? 0.2 : 0.008;
        floor = Math.min(FLOOR_MAX_DB, Math.max(FLOOR_MIN_DB, floor + a * (f.db - floor)));
      }
      return {
        db: f.db,
        floorDb: floor,
        snrDb: snr,
        voiced,
        speaking: !!run,
        trigger,
        onsetSample: run ? run.onset : null,
        voicedMs: run ? run.voicedMs : 0,
      };
    },
  };
}

/**
 * Rolling pre-roll plus capture of the wake utterance.
 *   push(frame)            every frame; keeps the last `preRollMs` while idle
 *   startCapture(sample)   from that absolute sample index (clamped to what is kept)
 *   finish()               the captured audio (Float32Array) and stop capturing
 * Capture is capped at `maxCaptureMs`; later frames are dropped.
 */
export function createClipRecorder({ sampleRate = 48000, preRollMs = PRE_ROLL_MS, maxCaptureMs = MAX_CLIP_MS } = {}) {
  const keep = Math.ceil((preRollMs / 1000) * sampleRate);
  const cap = Math.ceil((maxCaptureMs / 1000) * sampleRate);
  let chunks = []; // {start, data}
  let total = 0;
  let from = null;
  const retainedStart = () => (chunks.length ? chunks[0].start : total);
  const capturedLength = () => (from === null ? 0 : total - from);

  return {
    get totalSamples() {
      return total;
    },
    get capturing() {
      return from !== null;
    },
    get capturedMs() {
      return (Math.min(capturedLength(), cap) / sampleRate) * 1000;
    },
    push(frame) {
      if (from !== null && capturedLength() >= cap) {
        total += frame.length;
        return;
      }
      chunks.push({ start: total, data: Float32Array.from(frame) });
      total += frame.length;
      if (from === null) {
        while (chunks.length && chunks[0].start + chunks[0].data.length <= total - keep) chunks.shift();
      }
    },
    startCapture(sample) {
      const s = Number.isFinite(sample) ? sample : total;
      from = Math.min(total, Math.max(retainedStart(), s));
    },
    finish() {
      if (from === null) return new Float32Array(0);
      const end = Math.min(total, from + cap);
      const out = new Float32Array(Math.max(0, end - from));
      for (const c of chunks) {
        const a = Math.max(from, c.start);
        const b = Math.min(end, c.start + c.data.length);
        if (b > a) out.set(c.data.subarray(a - c.start, b - c.start), a - from);
      }
      from = null;
      chunks = [];
      return out;
    },
    reset() {
      chunks = [];
      from = null;
    },
  };
}

/** Resample mono float audio (box filter when decimating, linear interpolation otherwise). */
export function resample(samples, inRate, outRate = CLIP_RATE) {
  if (!samples || !samples.length) return new Float32Array(0);
  if (inRate === outRate) return Float32Array.from(samples);
  const ratio = inRate / outRate;
  const n = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(n);
  if (ratio > 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * ratio);
      const b = Math.min(samples.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
      let s = 0;
      for (let j = a; j < b; j++) s += samples[j];
      out[i] = s / (b - a);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const p = i * ratio;
      const a = Math.floor(p);
      const b = Math.min(samples.length - 1, a + 1);
      out[i] = samples[a] + (samples[b] - samples[a]) * (p - a);
    }
  }
  return out;
}

/** 16-bit PCM mono WAV (Uint8Array) at `outRate` from float samples at `inRate`. */
export function encodeWav(samples, inRate, outRate = CLIP_RATE) {
  const pcm = resample(samples, inRate, outRate);
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const v = new DataView(bytes.buffer);
  const str = (o, s) => {
    for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i);
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, outRate, true);
  v.setUint32(28, outRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 of a byte array (no btoa: works the same in the page and in node:test). */
export function bytesToBase64(bytes) {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + "=";
  }
  return out;
}

/**
 * Should the page listen for a wake right now? Pure gate over page + daemon state.
 * @param {{state?:string, phase?:string, sseUp?:boolean, muted?:boolean, wake?:{enabled?:boolean, sensitivity?:string}}} o
 */
export function shouldListen({ state, phase, sseUp, muted, wake } = {}) {
  return state === "sleeping" && phase === "idle" && !!sseUp && !muted && !!wake?.enabled && wake?.sensitivity !== "off";
}

/** Milliseconds until a wake is allowed again (daemon back-off after false wakes). */
export function cooldownLeft(wake, now) {
  const nb = Number(wake?.not_before) || 0;
  return nb > now ? nb - now : 0;
}

/**
 * Sleeping card text (§7.6). The redesign may restyle it; keep the states.
 * @returns {{title:string, body:string, listening:boolean}}
 */
export function sleepView({ muted = false, enabled = true, cooldownMs = 0, micError = null } = {}) {
  if (!enabled) return { title: "Sleeping", body: "Voice wake is off. Press Space or Wake now to continue.", listening: false };
  if (micError) return { title: "Sleeping", body: `The microphone is unavailable (${micError}). Press Space to resume.`, listening: false };
  if (muted) return { title: "Sleeping (muted)", body: "Not listening for your voice. Press M to listen again, or Space to resume.", listening: false };
  if (cooldownMs > 0) {
    const s = Math.ceil(cooldownMs / 1000);
    return { title: "Sleeping", body: `Heard only noise a few times, so listening again in ${s} s. Press Space to resume now.`, listening: false };
  }
  return { title: "Sleeping — just start talking", body: "Voice wakes up when you speak. Nothing is sent or billed until then.", listening: true };
}
