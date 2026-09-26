// Uplink level control and per-device speech calibration for the native
// app's mic (SPEC §6.19). Pure, no I/O except the injected profile store.
//
// Why: the app captures raw (no AGC) and gpt-live-1 has a hard level floor.
// Measured on the native path (test/e2e/native-bt.mjs, 2026-09-25, speech
// fixtures as a Bluetooth headset delivers them): word recall 100 % at -31
// and -40 dBFS, 97 % at -45, and 0 % at -50 dBFS: nothing transcribed, no
// reply. Chrome's getUserMedia AGC hid this on the web page; FaceTime and
// Zoom apply AGC too. So the daemon brings the user's speech to about
// TARGET_DB before it goes to the model, on every mic alike (no device is
// special-cased), and never attenuates.
//
// Only VOICED speech teaches it the level. Measured on a real capture
// (AirPods Max in call mode, 0.4.3, `sotto debug capture`, 2026-09-25): the
// user's speech peaked at -15 to -21 dBFS (voiced frames: periodicity about
// 0.75, 95 % of the power under 1 kHz) and was transcribed; the "-50 dBFS
// speech" 0.4.3 had learned was keyboard typing and breath (periodicity about
// 0.38, 13 % of the power under 1 kHz, 58 % at 2-4 kHz), which no transcriber
// reads as words. Learning from those frames set +24 to +28 dB of gain: the
// typing reached the model near -25 dBFS and every real word hit the peak
// limiter. So a frame counts as voiced only with pitch (periodicity >=
// VOICED_PERIODICITY) and most of its power in the voice band
// (>= VOICED_LOW_SHARE under 1 kHz), and an utterance is learned only when
// at least VOICED_SHARE of its active frames are voiced.
//
// Levels are measured on a 150 Hz high-passed copy (web/wake.js, the wake
// detector's units), so mains hum and rumble neither count as speech nor
// hold the gain down. The gain is applied to the untouched signal.
import { createHighPass, frameFeatures } from "../web/wake.js";

/** Where the user's speech is brought to (dBFS, speech-frame level). */
export const TARGET_DB = -26;
/** Most gain ever applied. */
export const MAX_GAIN_DB = 30;
/** The gain never lifts the (high-passed) noise floor above this. */
export const MAX_FLOOR_OUT_DB = -52;
/** A frame is speech when it is this far over the floor (and over SPEECH_MIN_DB). */
export const SPEECH_OVER_FLOOR_DB = 12;
export const SPEECH_MIN_DB = -68;
/** For the speech test the floor counts as no lower than this (a gated headset's floor is digital silence). */
const FLOOR_REF_MIN_DB = -85;
/** Gains under this are not worth applying: a normal mic passes untouched. */
const DEADBAND_DB = 3;
/** The speech level is the median of the last this many voiced frames of learned utterances (20 ms each: 5 s)... */
const EST_FRAMES = 250;
/** ...and an unknown device gets a first estimate inside its first utterance after this many voiced frames (0.5 s). */
const EST_MIN_FRAMES = 25;
/** Voiced frame: pitch periodicity at least this (keyboard clicks: median 0.38; speech: 0.75)... */
export const VOICED_PERIODICITY = 0.5;
/** ...and at least this share of its power in 80-1000 Hz (clicks: 0.13; speech: 0.95). */
export const VOICED_LOW_SHARE = 0.5;
/** An utterance is speech when at least this share of its active frames is voiced (speech 60-70 %, typing 5 %). */
export const VOICED_SHARE = 0.3;
/** "Talking": at least this many of the latest TALK_WINDOW active frames were voiced (speech: about 17; typing: 1 or 2). */
const TALK_VOICED = 8;
const TALK_WINDOW = 25;
/** The analysis window for the voicing test: the frame plus the previous frame's tail (a power of two). */
const VOICE_WIN = 512;
/** Gain slew per 20 ms frame: up 0.3 dB (15 dB/s), down 1.5 dB (75 dB/s). */
const SLEW_UP_DB = 0.3;
const SLEW_DOWN_DB = 1.5;
/** Output peak ceiling (about -1 dBFS). */
const PEAK_MAX = 0.89;
/** Floor: 10th percentile of this many recent non-zero frames (8 s). */
const FLOOR_FRAMES = 400;
/** An utterance: speech frames with gaps of at most this many frames (200 ms)... */
const RUN_GAP_FRAMES = 10;
/** ...and at least this much speech in it (ms). */
const UTTERANCE_MIN_MS = 400;
/** Profiles learned before voicing was required (0.4.3) are ignored: they measured typing, not speech. */
export const PROFILE_METHOD = "voiced";
/** A device counts as calibrated after this many utterances. */
export const CALIBRATED_UTTERANCES = 5;
/** Utterances weighed in the running speech level (older ones fade). */
const PROFILE_WINDOW = 12;

const dbOf = (p) => 10 * Math.log10(p + 1e-12);

/**
 * Streaming AGC over 20 ms PCM16 frames.
 * @param {object} [o]
 * @param {number} [o.sampleRate=24000]
 * @param {number|null} [o.speechDb]  the device's learned speech level (starts at the right gain)
 * @param {number|null} [o.floorDb]   the device's learned floor
 */
export function createUplinkAgc({ sampleRate = 24000, speechDb = null, floorDb = null, targetDb = TARGET_DB, maxGainDb = MAX_GAIN_DB } = {}) {
  let hpf = createHighPass(sampleRate);
  let levels = [];
  let floor = Number.isFinite(floorDb) ? floorDb : null;
  let floorCountdown = 0;
  let est = Number.isFinite(speechDb) ? speechDb : null;
  let recent = []; // levels of the voiced frames of the latest learned utterances
  let gainDb = 0;
  let prevLin = 1;
  let run = null; // {frames, voiced: [levels], gap}
  let tail = new Float32Array(VOICE_WIN); // the latest high-passed samples (voicing window)
  let recentVoiced = []; // voiced flags of the latest active frames (TALK_WINDOW)

  function wanted() {
    if (est === null) return 0;
    let g = Math.min(maxGainDb, Math.max(0, targetDb - est));
    if (floor !== null) g = Math.min(g, Math.max(0, MAX_FLOOR_OUT_DB - floor));
    return g < DEADBAND_DB ? 0 : g;
  }
  gainDb = wanted();
  prevLin = 10 ** (gainDb / 20);

  // Digital zeros count as a very low level: a headset that gates its mic to
  // exact zeros between words (AirPods in call mode: about 20 % of samples)
  // has no audible floor to lift, and its rare ungated blocks are not the room.
  function updateFloor(level) {
    levels.push(level);
    if (levels.length > FLOOR_FRAMES) levels.shift();
    if (--floorCountdown > 0 && floor !== null) return;
    floorCountdown = 25;
    if (levels.length < 25) return;
    const s = [...levels].sort((a, b) => a - b);
    floor = s[Math.floor(s.length * 0.1)];
  }

  return {
    get gainDb() { return gainDb; },
    get speechDb() { return est; },
    get floorDb() { return floor; },
    /** A new capture (route change): filter state and the utterance in progress start over. */
    resetStream() { hpf = createHighPass(sampleRate); run = null; tail = new Float32Array(VOICE_WIN); recentVoiced = []; },
    /** Another device: forget everything, optionally start from its profile. */
    setDevice({ speechDb: s = null, floorDb: f = null } = {}) {
      hpf = createHighPass(sampleRate);
      levels = [];
      floor = Number.isFinite(f) ? f : null;
      est = Number.isFinite(s) ? s : null;
      recent = [];
      run = null;
      tail = new Float32Array(VOICE_WIN);
      recentVoiced = [];
      gainDb = wanted();
      prevLin = 10 ** (gainDb / 20);
    },
    /**
     * One frame. `learn` false (the assistant is audible, or the stream has
     * not settled) keeps the level estimate and utterances untouched.
     * @param {Buffer} pcm PCM16 LE
     * `speech`: the frame is over the floor (voice, typing, a cough); `voiced`: it has
     * pitch and voice-band power; `talking`: a voiced frame in a stretch that is mostly
     * voiced (the user is talking, not typing). `utterance` ends a speech run that was
     * mostly voiced; `rejected` one that was not (typing, breath, rustling).
     * @returns {{pcm: Buffer, db: number, speech: boolean, voiced: boolean, talking: boolean, gainDb: number,
     *   utterance: null|{ms:number, speechDb:number, voiced:number}, rejected: null|{ms:number, db:number, voiced:number}}}
     */
    process(pcm, { learn = true } = {}) {
      const n = pcm.length >> 1;
      const x = new Float32Array(n);
      let zero = true;
      for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2); x[i] = v / 32768; if (v !== 0) zero = false; }
      const h = hpf.process(x);
      let e = 0;
      for (let i = 0; i < n; i++) e += h[i] * h[i];
      const level = zero ? -Infinity : dbOf(e / Math.max(1, n));
      if (learn) updateFloor(zero ? -120 : level);
      // Voicing window: this frame after the previous one's tail.
      if (n >= VOICE_WIN) tail = h.slice(n - VOICE_WIN);
      else { tail.copyWithin(0, n); tail.set(h, VOICE_WIN - n); }
      const speech = !zero && floor !== null && level >= Math.max(floor, FLOOR_REF_MIN_DB) + SPEECH_OVER_FLOOR_DB && level >= SPEECH_MIN_DB;
      let voiced = false;
      if (speech) {
        const f = frameFeatures(tail, sampleRate);
        voiced = f.periodicity >= VOICED_PERIODICITY && f.voiceRatio >= VOICED_LOW_SHARE;
        recentVoiced.push(voiced);
        if (recentVoiced.length > TALK_WINDOW) recentVoiced.shift();
      }
      const talking = voiced && recentVoiced.filter(Boolean).length >= TALK_VOICED;
      let utterance = null;
      let rejected = null;
      let first = false;
      const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
      if (learn) {
        if (speech) {
          if (!run) run = { frames: [], voiced: [], gap: 0 };
          run.frames.push(level);
          if (voiced) run.voiced.push(level);
          run.gap = 0;
          // An unknown device: the first clearly voiced half second sets the level
          // (the opening words matter most); afterwards only whole utterances teach it.
          if (est === null && run.voiced.length >= EST_MIN_FRAMES && run.voiced.length >= VOICED_SHARE * run.frames.length) {
            first = true;
            est = median(run.voiced);
          }
        } else if (run && ++run.gap > RUN_GAP_FRAMES) {
          const ms = run.frames.length * 20;
          const share = run.voiced.length / run.frames.length;
          if (ms >= UTTERANCE_MIN_MS) {
            if (share >= VOICED_SHARE && run.voiced.length * 20 >= UTTERANCE_MIN_MS / 2) {
              utterance = { ms, speechDb: Math.round(median(run.voiced) * 10) / 10, voiced: Math.round(share * 100) / 100 };
              recent.push(...run.voiced);
              if (recent.length > EST_FRAMES) recent.splice(0, recent.length - EST_FRAMES);
              est = median(recent);
            } else {
              rejected = { ms, db: Math.round(median(run.frames) * 10) / 10, voiced: Math.round(share * 100) / 100 };
            }
          }
          run = null;
        }
      }
      // Gain: slew toward the wanted gain, then keep the peak under the ceiling.
      const w = wanted();
      // The first speech on an unknown device sets the gain at once (the
      // opening words matter most); after that it slews.
      if (first) gainDb = w;
      else gainDb = w > gainDb ? Math.min(w, gainDb + SLEW_UP_DB) : Math.max(w, gainDb - SLEW_DOWN_DB);
      let peak = 0;
      for (let i = 0; i < n; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
      let lin = 10 ** (gainDb / 20);
      if (lin === 1 && prevLin === 1) return { pcm, db: level, speech, voiced, talking, gainDb, utterance, rejected };
      // Ramp from the last frame's gain (no step at the frame edge), unless
      // that would clip: then one safe gain for the whole frame.
      let from = prevLin;
      if (peak * Math.max(lin, prevLin) > PEAK_MAX) { lin = Math.min(lin, PEAK_MAX / peak); from = lin; }
      const out = Buffer.alloc(pcm.length);
      for (let i = 0; i < n; i++) {
        const g = from + ((lin - from) * (i + 1)) / n;
        out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * g * 32768))), i * 2);
      }
      prevLin = lin;
      return { pcm: out, db: level, speech, voiced, talking, gainDb, utterance, rejected };
    },
  };
}

/**
 * Learned speech levels per input device, persisted in `D/mic-levels.json`
 * ({devices: {<name>: {speech_db, floor_db, utterances, updated, method}}}).
 * A profile without `method: PROFILE_METHOD` (0.4.3 learned typing as speech)
 * is ignored and relearned. The
 * store is injected (`load()` / `save(obj)`) so tests need no files.
 */
export function createMicProfiles({ load = () => null, save = () => {}, clock = { now: () => Date.now() }, maxDevices = 20 } = {}) {
  let data = null;
  let dirty = false;
  const devices = () => {
    if (!data) {
      let o = null;
      try { o = load(); } catch { o = null; }
      data = { devices: o && typeof o.devices === "object" && o.devices && !Array.isArray(o.devices) ? { ...o.devices } : {} };
    }
    return data.devices;
  };
  const valid = (p) => p && p.method === PROFILE_METHOD && Number.isFinite(p.speech_db) && Number.isFinite(p.utterances);
  return {
    /** The profile of `name`, or null. */
    get(name) {
      if (!name) return null;
      const p = devices()[name];
      return valid(p) ? { ...p, calibrated: p.utterances >= CALIBRATED_UTTERANCES } : null;
    },
    /** One utterance heard on `name`. Returns the updated profile. */
    learn(name, utterance, floorDb = null) {
      if (!name || !utterance || !Number.isFinite(utterance.speechDb)) return null;
      const d = devices();
      const p = valid(d[name]) ? { ...d[name] } : { speech_db: utterance.speechDb, floor_db: null, utterances: 0, method: PROFILE_METHOD };
      p.utterances += 1;
      const k = Math.min(p.utterances, PROFILE_WINDOW);
      p.speech_db = Math.round((p.speech_db + (utterance.speechDb - p.speech_db) / k) * 10) / 10;
      if (Number.isFinite(floorDb)) p.floor_db = Math.round(floorDb * 10) / 10;
      p.updated = clock.now();
      d[name] = p;
      const names = Object.keys(d);
      if (names.length > maxDevices) {
        names.sort((a, b) => (d[a].updated || 0) - (d[b].updated || 0));
        for (const old of names.slice(0, names.length - maxDevices)) delete d[old];
      }
      dirty = true;
      return { ...p, calibrated: p.utterances >= CALIBRATED_UTTERANCES };
    },
    /** Write if anything changed. */
    flush() {
      if (!dirty) return false;
      dirty = false;
      try { save({ devices: devices() }); return true; } catch { return false; }
    },
  };
}
