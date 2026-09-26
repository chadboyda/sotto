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

/**
 * Presets for the native app's relayed mic (daemon/native-session.js, profile
 * "native"). The page's presets were tuned on Chrome's getUserMedia with AGC
 * and noise suppression: a quiet floor near -70 dBFS and speech boosted to
 * about -30. The app captures raw (split mode: no voice processing, no AGC).
 * Measured on a MacBook Pro microphone: a floor of about -55 dBFS, most of it
 * mains hum and rumble under 150 Hz, and conversational speech at 1 m around
 * -45 to -35 dBFS, so speech sat 10 dB or less above the floor and only a
 * shout cleared medium's 11 dB bar (the one wake that fired: level -32.6,
 * SNR 24). For this profile the detector analyses a 150 Hz high-passed copy
 * (the uplink is untouched), which removes most of that floor, and the bars
 * are set for speech at -45 dBFS or louder over it. The other gates
 * (periodicity, flatness, band share, syllabic swing, voiced density,
 * minimum voiced time) are the same, so clicks, fans and steady tones stay out.
 */
export const SENSITIVITY_NATIVE = Object.freeze({
  low: Object.freeze({ snrDb: 11, minDb: -54, minSpeechMs: 400 }),
  medium: Object.freeze({ snrDb: 7, minDb: -62, minSpeechMs: 300 }),
  high: Object.freeze({ snrDb: 5, minDb: -68, minSpeechMs: 240 }),
});
/**
 * Native profile with a calibrated device (daemon/agc.js learned the user's
 * median speech level on this input while live): a frame counts as loud
 * enough this many dB below that level, per sensitivity, instead of the fixed
 * `minDb`. Soft speech on a quiet mic (AirPods in call mode: about -31 dBFS
 * conversational, -46 to -51 soft) and a loud one are judged alike.
 */
export const CALIBRATED_BELOW_DB = Object.freeze({ low: 10, medium: 15, high: 20 });
/** The native profile's analysis high-pass (4th-order Butterworth). */
export const NATIVE_HPF_HZ = 150;
/**
 * Native profile: the first WARMUP_MS after arming only measure the floor
 * (20th percentile of those frames; never above a seeded floor + 6 dB). The
 * first frame alone is no floor: measured on a MacBook Pro mic, a start-up
 * frame 15 dB below the room seeded -70 dBFS, and the room's steady, periodic
 * hum then sat 11 dB above it and woke the detector within a second.
 */
const WARMUP_MS = 400;
const SEED_LEEWAY_DB = 6;
/** A near miss is reported for a candidate at least this long (shorter blips are not worth a line). */
const NEAR_MIN_MS = 120;
/** Frames within this many dB of the SNR bar (and of minDb) count toward a near-miss candidate. */
const NEAR_MARGIN_DB = 5;

// Frame classification. Voiced speech is harmonic (strong periodicity at a
// 70-400 Hz pitch), concentrated in 80-4000 Hz and not noise-flat. Keyboard
// clicks and fans are broadband and aperiodic; a click is also too short.
const BAND_LO_HZ = 80;
const BAND_HI_HZ = 4000;
/** Upper edge of the voice band (pitch and first formant): voiced speech keeps most of its power under it, keyboard clicks do not. */
const VOICE_HI_HZ = 1000;
const MIN_BAND_RATIO = 0.5;
const MIN_PERIODICITY = 0.35;
const MAX_FLATNESS = 0.45;
/**
 * Native profile: a voiced frame also keeps this share of its power in 80-1000 Hz.
 * Keyboard typing at a headset (live capture 2026-09-25, AirPods Max) has pitch-like
 * periodicity around 0.38 but only 13 % of its power there (speech: 95 %), and it
 * woke the voice with nothing to transcribe.
 */
const NATIVE_MIN_VOICE_RATIO = 0.4;
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
/** Frames at the start of a run left out of its level swing (see MIN_MODULATION_DB). */
const ONSET_SKIP_FRAMES = 2;
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
 *   zcr: zero crossings per second; voiceRatio: share of power in 80-1000 Hz.
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
  if (level < -100) return { db: level, bandRatio: 0, flatness: 1, periodicity: 0, zcr, voiceRatio: 0 };

  // Spectrum (Hann window).
  const w = hann(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = frame[i] * w[i];
  fft(re, im);
  const binHz = sampleRate / n;
  const lo = Math.max(1, Math.round(BAND_LO_HZ / binHz));
  const hi = Math.min(n / 2 - 1, Math.round(BAND_HI_HZ / binHz));
  const vhi = Math.min(n / 2 - 1, Math.round(VOICE_HI_HZ / binHz));
  let total = 0;
  let band = 0;
  let voice = 0;
  let logSum = 0;
  for (let k = 1; k < n / 2; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    total += p;
    if (k >= lo && k < vhi) voice += p;
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
  return { db: level, bandRatio, flatness, periodicity, zcr, voiceRatio: total > 0 ? voice / total : 0 };
}

/** Preset for a sensitivity name; unknown names fall back to medium. `off` → null. */
export function sensitivityPreset(name, profile = "page") {
  if (name === "off") return null;
  const table = profile === "native" ? SENSITIVITY_NATIVE : SENSITIVITY;
  return table[name] || table.medium;
}

/**
 * Streaming 4th-order Butterworth high-pass (two RBJ biquads), for analysis
 * only: `process(frame)` returns a filtered copy and keeps its state between
 * frames.
 */
export function createHighPass(sampleRate, hz = NATIVE_HPF_HZ) {
  const stages = [0.5411961, 1.306563].map((q) => {
    const w0 = (2 * Math.PI * hz) / sampleRate;
    const c = Math.cos(w0);
    const al = Math.sin(w0) / (2 * q);
    const a0 = 1 + al;
    return { b0: (1 + c) / 2 / a0, b1: -(1 + c) / a0, b2: (1 + c) / 2 / a0, a1: (-2 * c) / a0, a2: (1 - al) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
  });
  return {
    process(frame) {
      const out = new Float32Array(frame.length);
      for (let i = 0; i < frame.length; i++) {
        let v = frame[i];
        for (const st of stages) {
          const y = st.b0 * v + st.b1 * st.x1 + st.b2 * st.x2 - st.a1 * st.y1 - st.a2 * st.y2;
          st.x2 = st.x1; st.x1 = v; st.y2 = st.y1; st.y1 = y;
          v = y;
        }
        out[i] = v;
      }
      return out;
    },
  };
}

/**
 * The device's noise floor, for seeding a detector (profile "native"): the
 * 10th percentile of the analysis level over the last `windowMs`, so speech
 * and the assistant's voice on the mic don't raise it. Digital zeros (muted
 * or blocked frames) are ignored.
 */
export function createFloorTracker({ sampleRate = 24000, windowMs = 8000, hz = NATIVE_HPF_HZ } = {}) {
  const hpf = createHighPass(sampleRate, hz);
  let levels = [];
  let keep = 0;
  return {
    push(frame) {
      const x = hpf.process(frame);
      let e = 0;
      for (let i = 0; i < x.length; i++) e += x[i] * x[i];
      const d = db(e / x.length);
      if (d < -100) return;
      if (!keep) keep = Math.max(1, Math.round((windowMs / 1000) * (sampleRate / frame.length)));
      levels.push(d);
      if (levels.length > keep) levels.shift();
    },
    /** dBFS, or null until 1 s of frames was seen. */
    get floorDb() {
      if (!keep || levels.length < keep / 8) return null;
      const sorted = [...levels].sort((a, b) => a - b);
      return Math.min(FLOOR_MAX_DB, Math.max(FLOOR_MIN_DB, sorted[Math.floor(sorted.length * 0.1)]));
    },
    reset() { levels = []; },
  };
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
 *
 * `profile: "native"` (the app's raw mic, relayed to the daemon) analyses a
 * 150 Hz high-passed copy with SENSITIVITY_NATIVE; `floorDb` seeds the floor
 * (the device's floor measured while live). Either way digital zeros (muted
 * or blocked frames) never move the floor.
 *
 * A candidate that got close but did not wake (a burst of frames within
 * NEAR_MARGIN_DB of the bars, at least NEAR_MIN_MS long) is reported once,
 * when it ends, as `near: {ms, voiced_ms, level_db, snr_db, floor_db, bar_db, reason}`,
 * `reason` naming what held it back: `snr` or `level` (too quiet), `periodicity`,
 * `flatness` or `band` (not voice-like), `short` (voiced, but under minSpeechMs),
 * `density` or `modulation` (a long run that failed the speech-shape checks).
 */
export function createVad({ sampleRate = 48000, sensitivity = "medium", boostDb = 0, floorDb = null, profile = "page", speechDb = null } = {}) {
  const native = profile === "native";
  const fallback = native ? SENSITIVITY_NATIVE.medium : SENSITIVITY.medium;
  let preset = sensitivityPreset(sensitivity, profile) || fallback;
  let sensName = sensitivity;
  // Calibrated (native only): the level bar follows the user's speech on this device.
  const cal = native && Number.isFinite(speechDb) ? speechDb : null;
  const minDb = () => (cal !== null ? cal - (CALIBRATED_BELOW_DB[sensName] ?? CALIBRATED_BELOW_DB.medium) : preset.minDb);
  let boost = Number(boostDb) || 0;
  const clampFloor = (v) => Math.min(FLOOR_MAX_DB, Math.max(FLOOR_MIN_DB, v));
  const seed = Number.isFinite(floorDb) ? clampFloor(floorDb) : null;
  let floor = native ? null : seed;
  const hpf = native ? createHighPass(sampleRate) : null;
  let warm = native ? [] : null; // warm-up levels (native), null once the floor is set
  let samples = 0;
  let run = null;
  let recent = []; // runs that ended lately: {onset, end, voicedMs}
  let cand = null; // near-miss candidate: {start, last, frames, voicedMs, maxDb, maxSnr, fails:{}, runFail, fired}
  const msOf = (n) => (n / sampleRate) * 1000;

  function endCandidate() {
    const c = cand;
    cand = null;
    if (!c || c.fired) return null;
    const ms = msOf(c.last - c.start);
    if (ms < NEAR_MIN_MS) return null;
    let reason = c.runFail;
    if (!reason && c.voicedMs > 0) reason = "short";
    if (!reason) {
      let best = 0;
      for (const [k, v] of Object.entries(c.fails)) if (v > best) { best = v; reason = k; }
    }
    return {
      ms: Math.round(ms), voiced_ms: Math.round(c.voicedMs), level_db: Math.round(c.maxDb * 10) / 10,
      snr_db: Math.round(c.maxSnr * 10) / 10, floor_db: Math.round(floor * 10) / 10,
      bar_db: preset.snrDb + boost, min_db: Math.round(minDb() * 10) / 10, reason: reason || "snr",
    };
  }

  return {
    get floorDb() {
      return floor;
    },
    get samples() {
      return samples;
    },
    get profile() {
      return native ? "native" : "page";
    },
    get minDb() {
      return minDb();
    },
    get calibrated() {
      return cal !== null;
    },
    setSensitivity(name) {
      preset = sensitivityPreset(name, profile) || fallback;
      sensName = name;
    },
    setBoost(v) {
      boost = Math.max(0, Number(v) || 0);
    },
    reset() {
      run = null;
      recent = [];
      cand = null;
    },
    /**
     * @returns {{db:number, floorDb:number, snrDb:number, voiced:boolean, speaking:boolean,
     *            trigger:boolean, onsetSample:number|null, voicedMs:number, near:object|null}}
     */
    process(frame) {
      const f = frameFeatures(hpf ? hpf.process(frame) : frame, sampleRate);
      const start = samples;
      samples += frame.length;
      const frameMs = msOf(frame.length);
      const zero = f.db < -100; // digital silence: muted, blocked or a gap, never the room
      if (warm) {
        if (!zero) warm.push(f.db);
        if (msOf(samples) >= WARMUP_MS && warm.length >= 5) {
          const sorted = warm.slice(2).sort((x, y) => x - y); // the high-pass settles over the first frames
          let v = sorted[Math.floor(sorted.length * 0.2)];
          if (seed !== null) v = Math.min(v, seed + SEED_LEEWAY_DB);
          floor = clampFloor(v);
          warm = null;
        }
      } else if (floor === null && !zero) floor = clampFloor(f.db);
      const snr = floor === null ? 0 : f.db - floor;
      const bar = preset.snrDb + boost;
      const loudEnough = f.db >= minDb();
      const aboveBar = snr >= bar;
      const voiceLike = f.bandRatio >= MIN_BAND_RATIO && f.periodicity >= MIN_PERIODICITY && f.flatness <= MAX_FLATNESS
        && (!native || f.voiceRatio >= NATIVE_MIN_VOICE_RATIO);
      const voiced = !zero && floor !== null && loudEnough && aboveBar && voiceLike;

      let trigger = false;
      let runFail = null;
      if (voiced) {
        if (!run) run = { onset: start, lastVoiced: start, voicedMs: 0, frames: 0, minDb: Infinity, maxDb: -Infinity, fired: false };
        run.voicedMs += frameMs;
        run.lastVoiced = start;
      }
      if (run) {
        run.frames++;
        // The swing is measured after the onset: the first frames straddle the
        // start of any sound, so a steady tone that begins abruptly would
        // otherwise show a "syllable" there.
        if (run.frames > ONSET_SKIP_FRAMES) {
          run.minDb = Math.min(run.minDb, f.db);
          run.maxDb = Math.max(run.maxDb, f.db);
        }
        if (!voiced && msOf(start - run.lastVoiced) > HANGOVER_MS) {
          if (run.voicedMs >= CHAIN_MIN_MS) recent.push({ onset: run.onset, end: run.lastVoiced + frame.length, voicedMs: run.voicedMs });
          run = null;
        } else if (!run.fired && run.voicedMs >= preset.minSpeechMs) {
          const density = run.voicedMs / (run.frames * frameMs);
          const swing = run.maxDb > run.minDb ? run.maxDb - run.minDb : 0;
          if (density >= MIN_DENSITY && swing >= MIN_MODULATION_DB) {
            run.fired = true;
            trigger = true;
            // Chain back over the short runs just before this one (same utterance).
            let onset = run.onset;
            for (let i = recent.length - 1; i >= 0; i--) {
              if (msOf(onset - recent[i].end) > CHAIN_GAP_MS) break;
              onset = recent[i].onset;
            }
            run.onset = onset;
          } else runFail = density < MIN_DENSITY ? "density" : "modulation";
        }
      }

      // Near-miss bookkeeping (log only): frames close to the bars form a candidate.
      let near = null;
      const close = !zero && floor !== null && snr >= bar - NEAR_MARGIN_DB && f.db >= minDb() - NEAR_MARGIN_DB;
      if (close || voiced) {
        if (!cand) cand = { start, last: start, frames: 0, voicedMs: 0, maxDb: f.db, maxSnr: snr, fails: {}, runFail: null, fired: false };
        cand.last = start + frame.length;
        cand.frames++;
        cand.maxDb = Math.max(cand.maxDb, f.db);
        cand.maxSnr = Math.max(cand.maxSnr, snr);
        if (voiced) cand.voicedMs += frameMs;
        else {
          const why = !aboveBar ? "snr" : !loudEnough ? "level" : f.periodicity < MIN_PERIODICITY ? "periodicity" : f.flatness > MAX_FLATNESS ? "flatness" : native && f.voiceRatio < NATIVE_MIN_VOICE_RATIO ? "voice_band" : "band";
          cand.fails[why] = (cand.fails[why] || 0) + 1;
        }
        if (runFail) cand.runFail = runFail;
        if (trigger) cand.fired = true;
      } else if (cand && msOf(start - cand.last) > HANGOVER_MS) {
        near = endCandidate();
      }

      // Forget ended runs older than the pre-roll (the audio is gone anyway).
      while (recent.length && msOf(samples - recent[0].end) > PRE_ROLL_MS) recent.shift();
      if (!run && !voiced && !zero && floor !== null) {
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
        near,
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
