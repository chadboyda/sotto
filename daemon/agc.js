// Uplink level control and per-device speech calibration for the native
// app's mic (SPEC §6.19). Pure, no I/O except the injected profile store.
//
// Why: the app captures raw (no AGC) and gpt-live-1 has a hard level floor.
// Measured on the native path (test/e2e/native-bt.mjs, 2026-09-25, speech
// fixtures as a Bluetooth headset delivers them): word recall 100 % at -31
// and -40 dBFS, 97 % at -45, and 0 % at -50 dBFS: nothing transcribed, no
// reply. AirPods Max in call mode deliver conversational speech around -31
// dBFS and softer speech at -46 to -51 (the live wake log), right at that
// cliff, so the voice "heard" some sentences and ignored others. Chrome's
// getUserMedia AGC hid this on the web page; FaceTime and Zoom apply AGC too.
// So the daemon brings the user's speech to about TARGET_DB before it goes
// to the model, on every mic alike (no device is special-cased), and never
// attenuates.
//
// Levels are measured on a 150 Hz high-passed copy (web/wake.js, the wake
// detector's units), so mains hum and rumble neither count as speech nor
// hold the gain down. The gain is applied to the untouched signal.
import { createHighPass } from "../web/wake.js";

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
/** The speech level is the median of the last this many speech frames (20 ms each: 5 s of speech)... */
const EST_FRAMES = 250;
/** ...once there are at least this many (0.5 s of speech). */
const EST_MIN_FRAMES = 25;
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
  let recent = []; // levels of the latest speech frames
  let gainDb = 0;
  let prevLin = 1;
  let run = null; // {speech: [levels], gap}

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
    resetStream() { hpf = createHighPass(sampleRate); run = null; },
    /** Another device: forget everything, optionally start from its profile. */
    setDevice({ speechDb: s = null, floorDb: f = null } = {}) {
      hpf = createHighPass(sampleRate);
      levels = [];
      floor = Number.isFinite(f) ? f : null;
      est = Number.isFinite(s) ? s : null;
      recent = [];
      run = null;
      gainDb = wanted();
      prevLin = 10 ** (gainDb / 20);
    },
    /**
     * One frame. `learn` false (the assistant is audible, or the stream has
     * not settled) keeps the level estimate and utterances untouched.
     * @param {Buffer} pcm PCM16 LE
     * @returns {{pcm: Buffer, db: number, speech: boolean, gainDb: number, utterance: null|{ms:number, speechDb:number}}}
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
      const speech = !zero && floor !== null && level >= Math.max(floor, FLOOR_REF_MIN_DB) + SPEECH_OVER_FLOOR_DB && level >= SPEECH_MIN_DB;
      let utterance = null;
      let first = false;
      if (learn) {
        if (speech) {
          recent.push(level);
          if (recent.length > EST_FRAMES) recent.shift();
          if (recent.length >= EST_MIN_FRAMES) {
            first = est === null;
            const s = [...recent].sort((a, b) => a - b);
            est = s[Math.floor(s.length / 2)];
          }
          if (!run) run = { speech: [], gap: 0 };
          run.speech.push(level);
          run.gap = 0;
        } else if (run && ++run.gap > RUN_GAP_FRAMES) {
          const ms = run.speech.length * 20;
          if (ms >= UTTERANCE_MIN_MS) {
            const s = [...run.speech].sort((a, b) => a - b);
            utterance = { ms, speechDb: Math.round(s[Math.floor(s.length / 2)] * 10) / 10 };
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
      if (lin === 1 && prevLin === 1) return { pcm, db: level, speech, gainDb, utterance };
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
      return { pcm: out, db: level, speech, gainDb, utterance };
    },
  };
}

/**
 * Learned speech levels per input device, persisted in `D/mic-levels.json`
 * ({devices: {<name>: {speech_db, floor_db, utterances, updated}}}). The
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
  const valid = (p) => p && Number.isFinite(p.speech_db) && Number.isFinite(p.utterances);
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
      const p = valid(d[name]) ? { ...d[name] } : { speech_db: utterance.speechDb, floor_db: null, utterances: 0 };
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
