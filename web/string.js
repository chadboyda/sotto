// sotto web page: the string (design/concepts-v2/hybrid, "Filament + Orrery").
//
// One lit string runs from the mute button (the peg) across the panel to a bridge
// on the right. It is a damped 1D wave equation (96 points, stepped at 240 Hz):
//   you       your mic plucks it from below near the peg: jagged, one-sided kicks.
//   Sotto     the voice (an UNPLAYED clone of the remote track, app.js) rings it in
//             the persona's harmonics, smooth and two-sided, and sheds up to three
//             tidal contours in the persona's envelope. Personas are tunings.
//   Claude    a bead travels along it while Claude works. Each step Claude reports
//             leaves a small fixed star (lib.milestoneStars); the stars flash once,
//             left to right, when Claude finishes.
//   approval  the eclipse: 300 ms of stillness, then the bead glides back into your
//             peg and covers it, a diamond-ring flash, a gold corona, and the string
//             turns gold and runs out to frame the question (hybrid IMPLEMENTATION §4.1).
//   sleeping  the peg shows its night side; waking is a sunrise (§4.2).
//   muted     the string is cut at the peg and its free end droops.
//
// Cost model (hybrid §5): the idle panel is a still image. Nothing is drawn unless
// sound, a transition, the working bead (10 fps, skipped when it moved < 0.25 px)
// or the approval's corona shimmer (24 fps, clipped to the corona) needs it. Every
// frame is scheduled only while needed: an idle or hidden window draws nothing.
// prefers-reduced-motion: no freeze, glide, flash or shimmer; the approval appears
// complete, levels snap to static shapes, and every state keeps its own shape.
//
// Failure is contained: without a 2D context this returns a no-op string, and
// app.js wraps createString() so the voice client never depends on the decoration.
// No dependency on app.js state: app.js calls set(), input() and relayout().

import { beadPosition, starAlpha, quantizeLevel } from "./lib.js";

const N = 96;
const DT = 1 / 240;
const TAU = Math.PI * 2;

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - clamp(t), 3);
const easeInOut = (t) => {
  t = clamp(t);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
const expo = (t) => (t >= 1 ? 1 : t <= 0 ? 0 : 1 - Math.pow(2, -10 * t));
const bell = (x, w) => (x <= 0 || x >= w ? 0 : Math.sin((Math.PI * x) / w));
function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
function vnoise(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash(i), hash(i + 1), u);
}

// ---- personas: each is a tuning of the one string (hybrid, concept-3 §personas) ----
// w: harmonic weights; f: fundamental (Hz); width: line width; damp: decay; amp: loudness.
export const TUNINGS = Object.freeze({
  sotto: { w: [1, 0, 0.38, 0, 0.14], f: 1.25, width: 1.3, damp: 1.7, amp: 1 },
  june: { w: [0.55, 0, 0.55, 0, 0.42, 0, 0.3], f: 1.45, width: 1.2, damp: 1.5, amp: 1, bloom: 1.6 },
  moss: { w: [1, 0, 0.16], f: 0.82, width: 2.4, damp: 2.3, amp: 0.9 },
  tempo: { w: [0.45, 0.2, 0.6, 0, 0.55, 0, 0.35], f: 2.1, width: 1.25, damp: 1.4, amp: 1.1 },
  koan: { w: [1], f: 0.62, width: 1, damp: 1.1, amp: 0.85 },
  vic: { w: [1, 0, 0.22], f: 1.6, width: 1.6, damp: 5, amp: 0.7 },
  pip: { w: [0.8, 0, 0.42], f: 1.75, width: 1.25, damp: 1.6, amp: 1, flutter: 1 },
  fern: { w: [0.9, 0, 0.3, 0, 0.2], f: 1.08, width: 1, damp: 1.6, amp: 1, doubled: 1 },
});
const ORDER = ["sotto", "june", "moss", "tempo", "koan", "vic", "pip", "fern"];

/** A persona's tuning; a custom persona gets a built-in one picked by its id. */
export function tuningFor(id) {
  const k = String(id || "sotto");
  return TUNINGS[k] || TUNINGS[ORDER[detentFor(k)]];
}
/** The peg's tuning mark: one of 8 detents, 45 degrees apart. */
export function detentFor(id) {
  const k = String(id || "sotto");
  const i = ORDER.indexOf(k);
  if (i >= 0) return i;
  let h = 0;
  for (const ch of k) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % ORDER.length;
}
/** The footer chip's glyph: the persona's tuning as a tiny string (SVG path in a 30 x 20 box). */
export function chipWavePath(id) {
  const tn = tuningFor(id);
  const n = 22;
  const pts = [];
  let mx = 0;
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    let v = 0;
    tn.w.forEach((wk, k) => (v += wk * Math.sin((k + 1) * Math.PI * s) * Math.cos((k + 1) * 0.9 + k * 0.9)));
    pts.push(v);
    mx = Math.max(mx, Math.abs(v));
  }
  const A = 5.2 * clamp(tn.amp, 0.5, 1.1);
  return pts.map((v, i) => `${i ? "L" : "M"}${(8 + (i / n) * 18).toFixed(2)} ${(10 - (v / (mx || 1)) * A).toFixed(2)}`).join("");
}
// The persona's harmonic envelope |Σ w_k sin(kπs)|, normalized: the shape its tides take.
function envelopeOf(tn) {
  const raw = [];
  let mx = 0;
  for (let i = 0; i < N; i++) {
    const s = i / (N - 1);
    let v = 0;
    for (let k = 0; k < tn.w.length; k++) v += tn.w[k] * Math.sin((k + 1) * Math.PI * s);
    raw.push(Math.abs(v));
    mx = Math.max(mx, Math.abs(v));
  }
  return raw.map((v) => v / (mx || 1));
}

function parseColor(str) {
  const s = String(str || "").trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [...m[1].split("").map((c) => parseInt(c + c, 16)), 1];
  m = /rgba?\(([^)]+)\)/i.exec(s);
  if (m) {
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], Number.isFinite(p[3]) ? p[3] : 1];
  }
  return [128, 128, 128, 1];
}
const rgba = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(c[3] * a).toFixed(3)})`;
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];
const PALE = [255, 222, 168, 1]; // corona-pale

/** A string that draws nothing: the page keeps working when the canvas is unavailable. */
export function nullString() {
  return { set() {}, input() {}, relayout() {}, refreshColors() {}, frame() {}, animating: false };
}

/**
 * @param {HTMLCanvasElement} canvas  fixed over the panel, pointer-events: none
 * @param {{measure: () => ({w:number,h:number,pegX:number,pegY:number,pegR:number,x1:number,frameB:number}|null),
 *          reducedMotion?: boolean, clock?: () => number, manual?: boolean}} opts
 *   measure: geometry in the canvas's CSS pixels (app.js reads it from the layout).
 *   clock/manual: a capture harness drives time itself and calls frame().
 */
export function createString(canvas, opts = {}) {
  const ctx = canvas?.getContext?.("2d");
  if (!ctx || typeof opts.measure !== "function") return nullString();
  const clock = typeof opts.clock === "function" ? opts.clock : () => performance.now();
  const manual = !!opts.manual;
  let reduced = !!opts.reducedMotion;
  let G = null; // geometry
  let dpr = 1;
  let C = null; // colors
  let raf = 0;
  let timer = 0;

  // ---- inputs and state ----
  const st = { view: "card", floor: "starting", attention: false, working: false, workSince: null, persona: "sotto", cantHear: false, stars: [] };
  let started = false; // the first set() is the baseline: nothing already on screen animates in
  let mic = 0;
  let voice = 0;
  let room = 0; // the wake detector's level while sleeping
  const ev = { appr: null, resolve: null, resolveFromWork: false, finish: null, finishFrom: 0.9, flash: null, wake: null, persona: null, personaFrom: null, muted: null, connect: null, frozenBead: null };
  const sim = { u: new Float32Array(N), v: new Float32Array(N), you: 0, voice: 0, peak: 0, peakT: 0, phase: 0, t: 0 };
  let simAt = null; // clock seconds the sim has been stepped to
  let seed = 7;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let tides = []; // {born, lv}
  let lastTide = -1;
  let lastBeadX = null;
  let envCache = { id: null, env: null };

  const now = () => clock() / 1000;
  const sc = () => (G ? G.pegR / 22 : 1);

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const get = (k) => parseColor(cs.getPropertyValue(`--${k}`));
    C = {};
    for (const k of ["ground", "ink", "string", "bead", "you", "voice", "need", "muted", "star", "night"]) C[k] = get(k);
    C.glow = parseFloat(cs.getPropertyValue("--glow")) || 0.35;
    C.dark = C.glow >= 1;
    draw();
  }

  function resize() {
    const g = opts.measure();
    if (!g || !(g.w > 0) || !(g.h > 0)) {
      G = null;
      return;
    }
    G = g;
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const W = Math.round(g.w * dpr);
    const H = Math.round(g.h * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    draw();
  }

  // ---- the moment: every derived amount is a pure function of the clock ----
  function amounts(t) {
    const rm = reduced;
    const a = { need: 0, frame: 0, dim: 0, eclipse: 0, corona: 0, contact: 0, freeze: false, flashDR: 0 };
    if (ev.appr != null) {
      const lt = t - ev.appr;
      if (rm) Object.assign(a, { need: 1, frame: 1, dim: 1, eclipse: 1, corona: 1 });
      else {
        a.freeze = lt < 0.3;
        a.need = clamp((lt - 0.75) / 0.2);
        a.frame = expo((lt - 0.95) / 0.75);
        a.dim = easeOut((lt - 0.3) / 0.45);
        a.eclipse = lt >= 0.75 ? 1 : 0;
        a.corona = expo((lt - 0.78) / 0.9);
        a.contact = clamp((lt - 0.62) / 0.13);
        a.flashDR = bell(lt - 0.75 + 0.1, 0.34);
      }
    } else if (ev.resolve != null && !rm) {
      const lr = t - ev.resolve;
      a.need = 1 - clamp(lr / 0.4);
      a.frame = 1 - easeOut(lr / 0.4);
      a.dim = 1 - easeOut(lr / 0.5);
      a.eclipse = 1 - clamp((lr - 0.15) / 0.2);
      a.corona = 1 - easeOut(lr / 0.45);
    }
    return a;
  }

  /** The bead: {s, a, peg} (peg > 0: leaving the string onto the peg), or null. */
  function bead(t) {
    const rm = reduced;
    const workS = () => (st.workSince == null ? 0.05 : beadPosition(Date.now() - st.workSince));
    if (ev.appr != null) {
      if (rm) return null;
      const lt = t - ev.appr;
      if (lt >= 0.75) return null;
      const from = ev.frozenBead ?? 0.9;
      const g = lt < 0.3 ? 0 : easeInOut((lt - 0.3) / 0.45);
      return g < 0.8 ? { s: from * (1 - g / 0.8), a: 1, peg: 0 } : { s: 0, a: 1, peg: (g - 0.8) / 0.2 };
    }
    if (ev.resolve != null && !rm) {
      const lr = t - ev.resolve;
      if (lr < 0.15) return null;
      if (lr < 0.35) return { s: 0, a: 1, peg: 1 - easeOut((lr - 0.15) / 0.2) };
      const target = st.working ? workS() : 1;
      const k = easeInOut((lr - 0.35) / 0.55);
      if (lr < 0.9) return { s: target * k, a: 1, peg: 0 };
      if (st.working) return { s: workS(), a: 1, peg: 0 };
      return lr < 1.4 ? { s: 1, a: clamp(1 - (lr - 0.9) / 0.5), peg: 0 } : null;
    }
    if (ev.finish != null && !rm) {
      const lf = t - ev.finish;
      if (lf < 0.55) return { s: lerp(ev.finishFrom, 1, easeInOut(lf / 0.55)), a: 1, peg: 0 };
      if (lf < 1.05) return { s: 1, a: clamp(1 - (lf - 0.55) / 0.5), peg: 0 };
      return null;
    }
    if (st.working && st.view === "live") return { s: rm ? 0.5 : workS(), a: 1, peg: 0 };
    return null;
  }

  function tuning(t) {
    const B = tuningFor(st.persona);
    if (ev.persona == null || reduced) return { ...B, r: 1, from: B, to: B };
    const A = tuningFor(ev.personaFrom);
    const r = easeInOut((t - ev.persona - 0.3) / 0.7);
    const L = Math.max(A.w.length, B.w.length);
    const w = [];
    for (let k = 0; k < L; k++) w.push(lerp(A.w[k] || 0, B.w[k] || 0, r));
    return {
      w, r, from: A, to: B,
      f: lerp(A.f, B.f, r), width: lerp(A.width, B.width, r), damp: lerp(A.damp, B.damp, r), amp: lerp(A.amp, B.amp, r),
      bloom: lerp(A.bloom || 1, B.bloom || 1, r), doubled: lerp(A.doubled || 0, B.doubled || 0, r), flutter: lerp(A.flutter || 0, B.flutter || 0, r),
    };
  }

  // ---- the wave ----
  function step(t, tn, am) {
    if (am.freeze) return; // the freeze: the string holds its exact shape mid-motion
    const live = st.view === "live";
    const yl = live && st.floor !== "muted" ? mic : 0;
    const vl = live ? voice : 0;
    const rl = st.floor === "sleeping" ? room : 0;
    sim.you += (yl - sim.you) * (yl > sim.you ? 0.45 : 0.016);
    sim.voice += (vl - sim.voice) * 0.05;
    if (sim.you >= sim.peak) {
      sim.peak = sim.you;
      sim.peakT = sim.t;
    } else if (sim.t - sim.peakT > 1.2) sim.peak = Math.max(sim.you, sim.peak - 0.004);
    const flut = tn.flutter ? 1 + 0.06 * Math.sin(sim.t * TAU * 7) * tn.flutter : 1;
    sim.phase += TAU * tn.f * flut * DT;
    const k0 = sc();
    // Your voice plucks the string from below, near the peg: irregular, asymmetric kicks.
    if (yl > 0.02 && rnd() < yl * 0.24) {
      const k = 2 + Math.floor(rnd() * 9);
      const a = (0.45 + rnd()) * yl * 16 * k0 * (rnd() < 0.22 ? -0.55 : 1);
      sim.u[k - 1] -= a * 0.5;
      sim.u[k] -= a;
      sim.u[k + 1] -= a * 0.5;
    }
    // Room sound while sleeping: the wake meter is the string shivering.
    if (rl > 0.02 && rnd() < 0.05 + rl * 0.2) {
      const k = 4 + Math.floor(rnd() * (N - 8));
      sim.u[k] += (rnd() - 0.5) * (1.2 + 6 * rl) * k0;
    }
    let damp = st.floor === "you" ? 3.2 : tn.damp;
    if (ev.appr != null) damp = 28; // pulled taut
    if (st.floor === "muted" || st.cantHear) damp = Math.max(damp, 6);
    const keep = Math.exp(-damp * DT);
    const c2 = 0.26;
    const { u, v } = sim;
    for (let i = 1; i < N - 1; i++) v[i] = (v[i] + c2 * (u[i - 1] - 2 * u[i] + u[i + 1])) * keep;
    for (let i = 1; i < N - 1; i++) {
      u[i] += v[i];
      if (u[i] > 40) u[i] = 40;
      else if (u[i] < -40) u[i] = -40;
    }
    u[0] = u[N - 1] = 0;
    sim.t += DT;
  }

  function simulate(t, tn, am) {
    if (reduced) {
      simAt = t;
      sim.you = st.view === "live" && st.floor !== "muted" ? quantizeLevel(mic) : 0;
      sim.voice = st.view === "live" ? quantizeLevel(voice) : 0;
      sim.u.fill(0);
      sim.v.fill(0);
      return;
    }
    if (simAt == null || t - simAt > 0.25) simAt = t - DT;
    while (simAt + DT <= t + 1e-9) {
      step(simAt, tn, am);
      simAt += DT;
    }
  }

  function energy() {
    let m = 0;
    for (let i = 0; i < N; i++) m = Math.max(m, Math.abs(sim.u[i]), Math.abs(sim.v[i]) * 4);
    return m;
  }

  // Static shapes for reduced motion: every state keeps its own geometry.
  const rmPluck = (i) => {
    const s = i / (N - 1);
    return s < 0.55 ? -Math.sin(i * 1.7) * Math.sin(i * 0.43 + 1) * 9 * (1 - s / 0.55) * (0.6 + hash(i) * 0.6) : 0;
  };

  // ---- drawing ----
  function transient(t) {
    const rm = reduced;
    if (rm) return false;
    const within = (at, d) => at != null && t - at < d;
    if (within(ev.appr, 1.8) || within(ev.resolve, 2.3) || within(ev.finish, 2.3) || within(ev.flash, 1.6)) return true;
    if (within(ev.wake, 1.0) || within(ev.persona, 2.3) || within(ev.muted, 0.8) || within(ev.connect, 1.5)) return true;
    if (tides.some((d) => t - d.born < 1.15)) return true;
    const ms = Date.now();
    if (st.stars.some((s) => ms - s.born < 450)) return true;
    return false;
  }

  let lastDraw = { t: 0 };
  /** Draw the whole moment; `clip` limits the repaint to a rectangle (the corona's shimmer). */
  function draw(clip = null) {
    if (!G || !C) return;
    const t = now();
    const tn = tuning(t);
    const am = amounts(t);
    simulate(t, tn, am);
    // Garbage-collect finished one-shots so the scheduler can rest.
    if (ev.resolve != null && t - ev.resolve > 2.3) ev.resolve = null;
    if (ev.finish != null && t - ev.finish > 2.3) ev.finish = null;
    if (ev.persona != null && t - ev.persona > 2.3) ev.persona = null;
    tides = tides.filter((d) => t - d.born < 1.15);
    // Voice tides: one per 340 ms of voice, at most three in flight.
    if (!reduced && st.view === "live" && sim.voice > 0.05 && am.need < 0.5 && t - lastTide >= 0.34) {
      tides.push({ born: t, lv: sim.voice });
      if (tides.length > 3) tides.shift();
      lastTide = t;
    }
    const W = G.w;
    const H = G.h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    if (clip) {
      ctx.beginPath();
      ctx.rect(clip.x, clip.y, clip.w, clip.h);
      ctx.clip();
      ctx.clearRect(clip.x, clip.y, clip.w, clip.h);
    } else ctx.clearRect(0, 0, W, H);
    try {
      paint(t, tn, am);
    } finally {
      ctx.restore();
    }
    lastDraw = { t };
  }

  function paint(t, tn, am) {
    const k = sc();
    const kk = Math.max(k, 0.8);
    const R = G.pegR;
    const y = G.pegY;
    const x0 = G.pegX + R + 10 * Math.max(k, 0.7);
    const x1 = G.x1;
    const live = st.view === "live";
    const dark = C.dark;
    const { need, frame, dim } = am;
    drawUmbra(am);

    // String alpha per state: the dormant string of a card view is slack and faint.
    let alpha = 1;
    const sleeping = st.floor === "sleeping";
    const wakeT = ev.wake == null ? null : t - ev.wake;
    if (sleeping) alpha = 0.3;
    else if (!live) alpha = 0.32;
    else if (st.floor === "connecting" || st.floor === "reconnecting") alpha = 0.5;
    if (st.cantHear && live) alpha = 0.8;
    if (wakeT != null && wakeT < 0.35 && !reduced) alpha = lerp(0.3, alpha, easeOut(wakeT / 0.35));
    alpha *= 1 - 0.62 * dim * (1 - need);

    // Slack: sleeping and card views hang in a catenary; waking pulls tension out from the peg.
    const slackAt = (s) => {
      if (!(sleeping || !live) && !(wakeT != null && wakeT < 0.4 && !reduced)) return 0;
      if (sleeping || !live) return 1;
      const front = wakeT / 0.35;
      return clamp((s - front) / 0.12);
    };
    // The muted cut: the free end droops (a damped settle when it happens).
    const muted = live && st.floor === "muted";
    let startX = x0;
    let droop = 0;
    if (muted) {
      startX = x0 + 16 * Math.max(k, 0.7);
      const lm = ev.muted == null || reduced ? 9 : t - ev.muted;
      droop = 20 * k * (1 - Math.exp(-lm / 0.09) * Math.cos(lm * 16));
    }
    // Connecting: the string draws itself out from the peg once.
    let reveal = 1;
    if (live && (st.floor === "connecting" || st.floor === "reconnecting") && ev.connect != null && !reduced) reveal = easeInOut((t - ev.connect) / 1.4);

    // Harmonic ring (finish) and the wake ping.
    let ring = 0;
    let ringK = 1;
    const ringAt = ev.finish != null ? ev.finish + 0.55 : ev.resolve != null && !st.working ? ev.resolve + 0.9 : null;
    if (ringAt != null && t > ringAt && !reduced) {
      const q = t - ringAt;
      ring = 10 * k * Math.exp(-q / 0.38) * Math.cos(TAU * 2.6 * q);
    }
    if (wakeT != null && wakeT > 0.35 && !reduced) {
      const q = wakeT - 0.35;
      ring += 4 * k * Math.exp(-q / 0.22) * Math.cos(TAU * 6 * q);
      ringK = 2;
    }

    const A = sim.voice * 38 * k * tn.amp;
    let gliss = 0;
    if (ev.persona != null && !reduced) gliss = Math.sin(Math.PI * clamp((t - ev.persona - 0.3) / 0.75)) * 20 * k * (sim.voice > 0.05 ? 1 : 0.35);
    const bd = bead(t);
    const xs = [];
    const ys = [];
    const wy = [];
    const wv = [];
    for (let i = 0; i < N; i++) {
      const s = i / (N - 1);
      let hv = 0;
      for (let q = 0; q < tn.w.length; q++) if (tn.w[q]) hv += tn.w[q] * Math.sin((q + 1) * Math.PI * s) * Math.cos((q + 1) * sim.phase + q * 0.9);
      let h = hv * (A + gliss);
      let uu = sim.u[i];
      if (reduced) {
        uu = live && st.floor === "you" ? rmPluck(i) * k * (sim.you || 0.5) : 0;
        h = 0;
        if (live && sim.voice > 0) {
          let hv2 = 0;
          for (let q = 0; q < tn.w.length; q++) hv2 += tn.w[q] * Math.sin((q + 1) * Math.PI * s);
          h = hv2 * 14 * k * tn.amp * sim.voice;
        }
      }
      if (muted) h *= s; // the cut end cannot ring
      h += ring * Math.sin(ringK * Math.PI * s);
      let b = 0;
      if (bd && !bd.peg && bd.s > 0 && bd.s < 1) {
        const d = 3.6 * k;
        b += (s < bd.s ? (d * s) / bd.s : (d * (1 - s)) / (1 - bd.s)) * bd.a;
      }
      b += 8 * k * 4 * s * (1 - s) * slackAt(s);
      // Soft limit: a loud harmonic never crosses the caption below or the word above.
      let dd = (uu + h) * (1 - need);
      const lim = (dd > 0 ? 14 : 26) * k;
      dd = lim * Math.tanh(dd / lim);
      xs.push(lerp(startX, x1, s));
      ys.push(y + dd + b + droop * (1 - s) * (1 - s));
      wy.push(clamp(Math.abs(uu) / (5 * k)));
      wv.push(clamp(Math.abs(h) / (7 * k)));
    }
    const nPts = Math.max(2, Math.round(N * reveal));

    // Color along the string: rest color, tinted toward "you" or "voice" where it moves, gold in approval.
    const grad = ctx.createLinearGradient(startX, 0, x1, 0);
    for (let j = 0; j <= 16; j++) {
      const i = Math.round((j / 16) * (N - 1));
      let c = mix(C.string, [C.you[0], C.you[1], C.you[2], 1], wy[i]);
      c = mix(c, [C.voice[0], C.voice[1], C.voice[2], 1], wv[i]);
      c = mix(c, [C.need[0], C.need[1], C.need[2], 1], need);
      grad.addColorStop(j / 16, rgba(c, alpha));
    }
    const energyNow = Math.max(sim.you * 1.2, sim.voice, need, st.working && live ? 0.35 : 0);
    const lw = lerp(tn.width, 2, need) * kk;
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(xs[0], ys[0]);
      for (let i = 1; i < nPts; i++) ctx.lineTo(xs[i], ys[i]);
    };
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // Can't hear: no signal reaches the string, so it is drawn broken. Calm, never red.
    if (st.cantHear && live) ctx.setLineDash([2 * kk, 6 * kk]);
    const bloomC = need > 0.5 ? C.need : sim.voice > sim.you ? C.voice : sim.you > 0.05 ? C.you : C.ink;
    ctx.save();
    ctx.shadowColor = rgba(bloomC, (0.25 + 0.6 * energyNow) * C.glow * alpha * (tn.bloom || 1));
    ctx.shadowBlur = (6 + 14 * energyNow) * Math.max(k, 0.7) * dpr;
    ctx.strokeStyle = grad;
    ctx.lineWidth = lw;
    path();
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = grad;
    ctx.lineWidth = lw;
    path();
    ctx.stroke();
    ctx.setLineDash([]);
    if (tn.doubled > 0.01 && live) {
      // Fern: a doubled string, two fine lines that shimmer against each other.
      ctx.save();
      ctx.globalAlpha = 0.55 * tn.doubled * alpha;
      ctx.lineWidth = lw * 0.8;
      ctx.beginPath();
      for (let i = 0; i < nPts; i++) {
        const s = i / (N - 1);
        const off = 3 * k * Math.sin(Math.PI * s);
        if (i) ctx.lineTo(xs[i], ys[i] + off);
        else ctx.moveTo(xs[i], ys[i] + off);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Voice tides: symmetric contours in the persona's envelope, travelling outward and fading.
    if (envCache.id !== st.persona) envCache = { id: st.persona, env: envelopeOf(tuningFor(st.persona)) };
    const env = envCache.env;
    const tide = (d, a) => {
      ctx.strokeStyle = rgba(C.voice, a);
      ctx.lineWidth = kk;
      for (const sgn of [-1, 1]) {
        ctx.beginPath();
        for (let i = 0; i < nPts; i++) {
          const e = env[i] * (muted ? i / (N - 1) : 1);
          const yy = ys[i] + sgn * d * e;
          if (i) ctx.lineTo(xs[i], yy);
          else ctx.moveTo(xs[i], yy);
        }
        ctx.stroke();
      }
    };
    if (!reduced && need < 0.5) {
      for (const d of tides) {
        const q = (t - d.born) / 1.15;
        if (q < 0 || q > 1) continue;
        tide((4 + 14 * (1 - (1 - q) * (1 - q))) * k, d.lv * Math.pow(1 - q, 1.8) * (dark ? 0.5 : 0.4) * alpha);
      }
    } else if (reduced && live && sim.voice > 0 && need < 0.5) {
      tide(8 * k, 0.32 * alpha);
      tide(15 * k, 0.14 * alpha);
    }

    // Persona switch: the old tuning's shape lifts off and drifts away; the new tuning's nodes show like frets.
    if (ev.persona != null && live) {
      const lp = t - ev.persona;
      if (lp > 0.3 && lp < 1.5 && !reduced) {
        const q = (lp - 0.3) / 1.2;
        const Aw = tn.from.w;
        ctx.strokeStyle = rgba(C.voice, 0.6 * Math.pow(1 - q, 1.4));
        ctx.lineWidth = kk;
        ctx.beginPath();
        for (let i = 0; i < N; i++) {
          const s = i / (N - 1);
          let hv = 0;
          Aw.forEach((wk, q2) => (hv += wk * Math.sin((q2 + 1) * Math.PI * s) * Math.cos(q2 * 0.9)));
          const yy = y - easeOut(q) * 20 * k - hv * 11 * k;
          if (i) ctx.lineTo(xs[i], yy);
          else ctx.moveTo(xs[i], yy);
        }
        ctx.stroke();
      }
      const fenv = reduced ? 0 : clamp((lp - 0.25) / 0.25) * clamp((2.2 - lp) / 0.5);
      if (fenv > 0.01) {
        const nodes = new Set();
        tn.to.w.forEach((wk, q) => {
          if (wk >= 0.2 && q > 0) for (let j = 1; j <= q; j++) nodes.add(+(j / (q + 1)).toFixed(4));
        });
        if (!nodes.size) nodes.add(0.5);
        ctx.strokeStyle = rgba(C.voice, 0.85 * fenv);
        ctx.lineWidth = 1.2 * kk;
        const hgt = 7 * Math.max(k, 0.7);
        for (const s of nodes) {
          const x = lerp(startX, x1, s);
          ctx.beginPath();
          ctx.moveTo(x, y - hgt - 6);
          ctx.lineTo(x, y - 6);
          ctx.moveTo(x, y + 6);
          ctx.lineTo(x, y + hgt + 6);
          ctx.stroke();
        }
      }
    }

    // Milestone stars: fixed on the string, riding its motion; they flash in sequence when Claude finishes.
    const ms = Date.now();
    const stars = [...st.stars].sort((a, b) => a.s - b.s);
    const flashAt = ev.flash;
    stars.forEach((star, j) => {
      const fi = clamp(star.s) * (N - 1);
      const i0 = Math.floor(fi);
      const f = fi - i0;
      const i1 = Math.min(N - 1, i0 + 1);
      const sx = lerp(xs[i0], xs[i1], f);
      const sy = lerp(ys[i0], ys[i1], f);
      const age = (ms - star.born) / 1000;
      const pop = !reduced && age < 0.45 && age >= 0 ? 1 + 0.9 * (1 - age / 0.45) : 1;
      const fl = flashAt != null && !reduced ? bell(t - flashAt - j * 0.06, 0.24) : 0;
      const r = 3.3 * Math.max(k, 0.7) * pop * (1 + 1.1 * fl);
      const a = starAlpha(ms - star.born) * (1 - 0.55 * dim) * Math.max(alpha, 0.45);
      if (dark && (fl > 0 || pop > 1)) {
        const gg = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 3.2);
        gg.addColorStop(0, rgba(C.star, 0.38 * Math.max(fl, pop - 1)));
        gg.addColorStop(1, rgba(C.star, 0));
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = gg;
        ctx.fillRect(sx - r * 3.5, sy - r * 3.5, r * 7, r * 7);
        ctx.restore();
      }
      // A small gap of ground around each star: a knot on the line, not a thickening of it.
      ctx.fillStyle = rgba(C.ground, 0.9 * clamp(a * 1.4));
      ctx.beginPath();
      ctx.arc(sx, sy, r * 0.55, 0, TAU);
      ctx.fill();
      ctx.fillStyle = rgba(C.star, clamp(a + 0.3 * fl));
      ctx.beginPath();
      ctx.moveTo(sx, sy - r);
      ctx.quadraticCurveTo(sx, sy, sx + r, sy);
      ctx.quadraticCurveTo(sx, sy, sx, sy + r);
      ctx.quadraticCurveTo(sx, sy, sx - r, sy);
      ctx.quadraticCurveTo(sx, sy, sx, sy - r);
      ctx.fill();
    });
    if (flashAt != null && t - flashAt > 0.3 + stars.length * 0.06) ev.flash = null;

    // Sunrise glint: the tension front carries a point of light out from the peg.
    if (wakeT != null && wakeT < 0.5 && !reduced) {
      const fr = clamp(wakeT / 0.35);
      const gi = Math.min(N - 1, Math.round(fr * (N - 1)));
      const a = Math.sin(Math.PI * clamp(wakeT / 0.45));
      const gg = ctx.createRadialGradient(xs[gi], ys[gi], 0, xs[gi], ys[gi], 16 * k);
      gg.addColorStop(0, rgba(dark ? C.star : C.voice, 0.8 * a));
      gg.addColorStop(1, rgba(C.star, 0));
      ctx.save();
      if (dark) ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = gg;
      ctx.fillRect(xs[gi] - 16 * k, ys[gi] - 16 * k, 32 * k, 32 * k);
      ctx.restore();
    }
    // Muted: a short stub stays on the peg; the gap between it and the string is the cut.
    if (muted) {
      ctx.strokeStyle = rgba(C.muted, 1);
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(x0 - 4, y);
      ctx.lineTo(x0 + 2, y);
      ctx.stroke();
      ctx.fillStyle = rgba(C.string, 1);
      ctx.beginPath();
      ctx.arc(startX, ys[0], 1.6 * kk, 0, TAU);
      ctx.fill();
    }
    // The bridge.
    ctx.fillStyle = rgba(mix(C.string, C.need, need), alpha);
    ctx.beginPath();
    ctx.arc(x1, ys[N - 1], 2 * kk, 0, TAU);
    ctx.fill();

    // Claude's bead (the moon).
    let pegBead = null;
    if (bd && bd.peg > 0) {
      pegBead = () => {
        const h = easeInOut(bd.peg);
        const bx = lerp(startX, G.pegX, h);
        const rr = lerp(3.2 * Math.max(k, 0.75), R * 1.03, h * h);
        ctx.save();
        ctx.shadowColor = rgba(C.bead, (1 - h) * 0.9 * Math.max(C.glow, 0.5));
        ctx.shadowBlur = 14 * Math.max(k, 0.7) * dpr;
        ctx.fillStyle = rgba(mix(C.bead, C.night, h), 1);
        ctx.beginPath();
        ctx.arc(bx, y, rr, 0, TAU);
        ctx.fill();
        ctx.restore();
      };
    } else if (bd && bd.a > 0.01) {
      const i = Math.round(clamp(bd.s) * (N - 1));
      const bx = lerp(startX, x1, clamp(bd.s));
      const by = ys[i];
      lastBeadX = bx;
      ctx.save();
      ctx.shadowColor = rgba(C.bead, 0.9 * Math.max(C.glow, 0.5));
      ctx.shadowBlur = 14 * Math.max(k, 0.7) * dpr;
      ctx.fillStyle = rgba(C.bead, bd.a * Math.max(alpha, 0.6));
      ctx.beginPath();
      ctx.arc(bx, by, 3.2 * Math.max(k, 0.75), 0, TAU);
      ctx.fill();
      ctx.restore();
      // A short comet of light behind it, so it reads as travelling even in a still.
      const tg = ctx.createLinearGradient(bx - 46 * k, 0, bx, 0);
      tg.addColorStop(0, rgba(C.bead, 0));
      tg.addColorStop(1, rgba(C.bead, 0.55 * bd.a));
      ctx.strokeStyle = tg;
      ctx.lineWidth = lw + 0.6;
      ctx.beginPath();
      const i0 = Math.max(0, i - 14);
      for (let q = i0; q <= i; q++) (q === i0 ? ctx.moveTo : ctx.lineTo).call(ctx, xs[q], ys[q]);
      ctx.stroke();
    }

    // Approval: the string's two ends run down and meet, framing the question in one rectangle of light.
    if (frame > 0.001 && live && G.frameB > y + R + 60) {
      const top = y + R + 6 * Math.max(k, 0.7);
      const B = G.frameB;
      const r = 12 * Math.max(k, 0.6);
      const poly = roundedPoly([[G.pegX, top], [G.pegX, B], [x1, B], [x1, y]], r);
      const L = polyLen(poly);
      const half = (L / 2) * frame + (frame >= 0.999 ? 2 : 0);
      ctx.save();
      ctx.strokeStyle = rgba(C.need, 0.96);
      ctx.lineWidth = 2 * Math.max(k, 0.75);
      ctx.shadowColor = rgba(C.need, dark ? 0.75 : 0.35);
      ctx.shadowBlur = (dark ? 16 : 6) * Math.max(k, 0.6) * dpr;
      for (const p of [trimPoly(poly, half), trimPoly(poly.slice().reverse(), half)]) {
        ctx.beginPath();
        p.forEach(([px, py], q) => (q ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
        ctx.stroke();
      }
      ctx.restore();
      if (dark) {
        // A faint wash of the same light inside the frame (dark only: on white it reads as peach).
        const wash = ctx.createLinearGradient(0, y, 0, B);
        wash.addColorStop(0, rgba(C.need, 0.07 * frame));
        wash.addColorStop(1, rgba(C.need, 0));
        ctx.fillStyle = wash;
        ctx.fillRect(G.pegX + 1, y, x1 - G.pegX - 2, B - y);
      }
    }
    drawPeg(t, tn, am, wakeT);
    if (pegBead) pegBead();
  }

  // The umbra: at totality the world goes dark around the peg, inside 2.45 peg radii.
  function drawUmbra(am) {
    const U = Math.max(am.eclipse, am.corona, C.dark ? am.dim * 0.6 : am.contact);
    if (U <= 0.001) return;
    const x = G.pegX;
    const y = G.pegY;
    const R = G.pegR;
    // Dark: a soft falloff into space. Light: a crisp printed disc of night (a soft gradient on white reads as a smudge).
    const ro = C.dark ? R * 2.45 : R * 1.62;
    const ug = ctx.createRadialGradient(x, y, R * 0.9, x, y, ro);
    if (C.dark) {
      ug.addColorStop(0, rgba(C.night, 0.75 * U));
      ug.addColorStop(0.5, rgba(C.night, 0.4 * U));
      ug.addColorStop(1, rgba(C.night, 0));
    } else {
      ug.addColorStop(0, rgba(C.night, U));
      ug.addColorStop(0.86, rgba(C.night, U));
      ug.addColorStop(1, rgba(C.night, 0));
    }
    ctx.fillStyle = ug;
    ctx.beginPath();
    ctx.arc(x, y, ro, 0, TAU);
    ctx.fill();
  }

  function drawPeg(t, tn, am, wakeT) {
    const k = Math.max(sc(), 0.75);
    const x = G.pegX;
    const y = G.pegY;
    const R = G.pegR;
    const live = st.view === "live";
    const muted = live && st.floor === "muted";
    const need = am.need;
    const sleeping = st.floor === "sleeping";
    // Tick ring: the meter for your mic, lit clockwise from the top; the peak tick lingers 1.2 s.
    const n = 36;
    const r1 = R + 4.5 * k;
    const r2 = R + 8.5 * k;
    let lvl = clamp(sim.you * 1.35);
    let peak = reduced ? lvl : clamp(sim.peak * 1.35);
    if (sleeping) {
      lvl = clamp(room * 2);
      peak = lvl;
    }
    if (!muted && need < 0.5) {
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (i / n) * TAU;
        const c = Math.cos(a);
        const s = Math.sin(a);
        if (st.cantHear && live) {
          ctx.fillStyle = rgba(C.ink, 0.5);
          ctx.beginPath();
          ctx.arc(x + c * (r1 + 2 * k), y + s * (r1 + 2 * k), 0.9 * k, 0, TAU);
          ctx.fill();
          continue;
        }
        const lit = i < lvl * n;
        const isPeak = !lit && Math.abs(i - Math.floor(peak * n)) < 1 && peak > 0.05;
        const rest = sleeping || !live ? 0.07 : 0.13;
        ctx.strokeStyle = lit ? rgba(sleeping ? C.ink : C.you, sleeping ? 0.5 : 1) : isPeak ? rgba(C.you, 0.7) : rgba(C.ink, rest);
        ctx.lineWidth = (lit ? 1.6 : 1) * k;
        ctx.beginPath();
        ctx.moveTo(x + c * r1, y + s * r1);
        ctx.lineTo(x + c * (lit ? r2 + 1 : r2), y + s * (lit ? r2 + 1 : r2));
        ctx.stroke();
      }
    }
    // The peg body: flat, with a knurled rim.
    ctx.fillStyle = rgba(C.ground, 1);
    ctx.beginPath();
    ctx.arc(x, y, R, 0, TAU);
    ctx.fill();
    const rim = muted ? C.muted : need > 0.5 ? C.need : C.ink;
    ctx.strokeStyle = rgba(rim, muted || need > 0.5 ? 0.95 : 0.22);
    ctx.lineWidth = (muted || need > 0.5 ? 1.5 : 1) * k;
    ctx.stroke();
    const rot = detentFor(st.persona) * (Math.PI / 4);
    const rotNow = ev.persona != null && !reduced ? lerp(detentFor(ev.personaFrom) * (Math.PI / 4), rot, tn.r) : rot;
    ctx.strokeStyle = rgba(C.ink, 0.16);
    ctx.lineWidth = 0.9 * k;
    for (let i = 0; i < 28; i++) {
      const a = rotNow + (i / 28) * TAU;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * (R - 3.2 * k), y + Math.sin(a) * (R - 3.2 * k));
      ctx.lineTo(x + Math.cos(a) * (R - 0.8), y + Math.sin(a) * (R - 0.8));
      ctx.stroke();
    }
    // Tuning mark: which persona the string is tuned to.
    const ma = rotNow - Math.PI / 2;
    ctx.fillStyle = rgba(muted ? C.muted : C.ink, 0.9);
    ctx.beginPath();
    ctx.arc(x + Math.cos(ma) * (R - 7 * k), y + Math.sin(ma) * (R - 7 * k), 1.9 * k, 0, TAU);
    ctx.fill();
    // Sunrise: asleep, the night side with a thin lit limb; on wake the terminator sweeps across in 600 ms.
    const night = sleeping ? 1 : wakeT != null && !reduced ? 1 - easeInOut(wakeT / 0.6) : 0;
    if (night > 0.001) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, R - 0.5, 0, TAU);
      ctx.clip();
      const edge = x - R * 0.7 + 2.1 * R * (1 - night);
      const sh = ctx.createLinearGradient(edge - 5 * k, 0, edge + 3 * k, 0);
      sh.addColorStop(0, rgba(C.night, 0));
      sh.addColorStop(1, rgba(C.night, C.dark ? 0.72 : 0.14));
      ctx.fillStyle = sh;
      ctx.fillRect(edge - 5 * k, y - R, x + R - edge + 5 * k, R * 2);
      ctx.restore();
      ctx.strokeStyle = rgba(C.dark ? C.star : C.ink, (C.dark ? 0.55 : 0.5) * night);
      ctx.lineWidth = 1.2 * k;
      ctx.beginPath();
      ctx.arc(x, y, R - 0.6, Math.PI * 0.62, Math.PI * 1.38);
      ctx.stroke();
    }
    if (wakeT != null && wakeT < 0.9 && !reduced) {
      const w = wakeT / 0.9;
      const rr = R * (1.1 + 2.1 * easeOut(w));
      const a = Math.sin(Math.PI * w);
      ctx.save();
      if (C.dark) {
        ctx.globalCompositeOperation = "lighter";
        const gg = ctx.createRadialGradient(x, y, R, x, y, rr);
        gg.addColorStop(0, `rgba(200,216,255,${(0.26 * a).toFixed(3)})`);
        gg.addColorStop(1, "rgba(200,216,255,0)");
        ctx.fillStyle = gg;
        ctx.beginPath();
        ctx.arc(x, y, rr, 0, TAU);
        ctx.fill();
      } else {
        ctx.strokeStyle = rgba(C.voice, 0.45 * (1 - w));
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(x, y, rr, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();
    }
    drawEclipse(t, am, x, y, R, k);
  }

  // The eclipse: the moon's disc over the peg, a gold corona around it, a diamond-ring flash at contact.
  function drawEclipse(t, am, x, y, R, k) {
    const E = am.eclipse;
    const c = am.corona;
    if (E <= 0.001 && c <= 0.001) return;
    const gold = C.need;
    ctx.save();
    if (C.dark) ctx.globalCompositeOperation = "lighter";
    if (c > 0) {
      const gg = ctx.createRadialGradient(x, y, R * 0.96, x, y, R * 2.35);
      gg.addColorStop(0, rgba(gold, 0.95 * c));
      gg.addColorStop(0.12, rgba(gold, 0.5 * c));
      gg.addColorStop(0.42, rgba(gold, 0.14 * c));
      gg.addColorStop(1, rgba(gold, 0));
      ctx.fillStyle = gg;
      ctx.beginPath();
      ctx.arc(x, y, R * 2.35, 0, TAU);
      ctx.fill();
      // Streamers: 120 hairline rays whose lengths come from slow value noise. The noise
      // drifts once per 3.2 s: the shimmer, the only motion held while approval waits.
      const ph = reduced || ev.appr == null ? 0 : (t - ev.appr) / 3.2;
      ctx.lineWidth = 0.8;
      for (let i = 0; i < 120; i++) {
        const a = (i / 120) * TAU + 0.013 * Math.sin(i * 1.7);
        const len = R * (0.1 + 1.2 * Math.pow(vnoise(i * 0.61 + ph), 2.3)) * c;
        const r0 = R * 1.02;
        const xa = x + Math.cos(a) * r0;
        const ya = y + Math.sin(a) * r0;
        const xe = x + Math.cos(a) * (r0 + len);
        const ye = y + Math.sin(a) * (r0 + len);
        const gl = ctx.createLinearGradient(xa, ya, xe, ye);
        gl.addColorStop(0, rgba(PALE, 0.6 * c));
        gl.addColorStop(1, rgba(gold, 0));
        ctx.strokeStyle = gl;
        ctx.beginPath();
        ctx.moveTo(xa, ya);
        ctx.lineTo(xe, ye);
        ctx.stroke();
      }
      ctx.strokeStyle = rgba(PALE, 0.95 * c);
      ctx.lineWidth = 1.5 * k;
      ctx.beginPath();
      ctx.arc(x, y, R * 1.03, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
    if (E > 0) {
      ctx.fillStyle = rgba(C.night, E);
      ctx.beginPath();
      ctx.arc(x, y, R * 1.02, 0, TAU);
      ctx.fill();
    }
    const b = am.flashDR;
    if (b > 0) {
      const ba = -0.72;
      const bx = x + Math.cos(ba) * R * 1.02;
      const by = y + Math.sin(ba) * R * 1.02;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const gg = ctx.createRadialGradient(bx, by, 0, bx, by, R * 1.3 * b);
      gg.addColorStop(0, `rgba(255,255,255,${b.toFixed(3)})`);
      gg.addColorStop(0.25, rgba(PALE, 0.8 * b));
      gg.addColorStop(1, rgba(gold, 0));
      ctx.fillStyle = gg;
      ctx.beginPath();
      ctx.arc(bx, by, R * 1.3 * b, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = `rgba(255,244,222,${(0.7 * b).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx - R * 2.2 * b, by);
      ctx.lineTo(bx + R * 2.2 * b, by);
      ctx.moveTo(bx, by - R * 1.2 * b);
      ctx.lineTo(bx, by + R * 1.2 * b);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---- scheduling: draw only while something moves ----
  function plan() {
    if (!G || !C) return null;
    const t = now();
    const live = st.view === "live";
    // Reduced motion: levels snap, so set() and input() redraw on a change and nothing runs.
    if (reduced) return null;
    const sound = mic > 0 || voice > 0 || (st.floor === "sleeping" && room > 0.02);
    const oneShot = transient(t);
    if (oneShot || sound || energy() > 0.03 || sim.you > 0.004 || sim.voice > 0.004) {
      // Sleeping: the wake shiver needs no more than 15 fps.
      return { rate: st.floor === "sleeping" && !oneShot ? 66 : 0 };
    }
    if (ev.appr != null && !reduced && live) return { rate: 1000 / 24, clip: "corona" };
    if (st.working && live && !reduced) return { rate: 100, bead: true };
    return null;
  }

  function coronaClip() {
    const R = G.pegR * 2.6;
    return { x: G.pegX - R, y: G.pegY - R, w: 2 * R, h: 2 * R };
  }

  function tick() {
    raf = 0;
    timer = 0;
    if (typeof document !== "undefined" && document.hidden) return; // resumed by visibilitychange
    const p = plan();
    if (!p) {
      draw();
      settle();
      return;
    }
    if (p.clip === "corona") draw(coronaClip());
    else if (p.bead) {
      const bd = bead(now());
      const bx = bd ? lerp(G.pegX + G.pegR + 10, G.x1, clamp(bd.s)) : null;
      if (bx == null || lastBeadX == null || Math.abs(bx - lastBeadX) >= 0.25) draw();
    } else draw();
    schedule(p);
  }

  function schedule(p = plan()) {
    if (manual || raf || timer || !p) return;
    if (p.rate > 0) timer = setTimeout(tick, p.rate);
    else raf = requestAnimationFrame(tick);
  }

  function settle() {
    // The wave went quiet: zero the residue so the next idle check is exact.
    if (energy() < 0.03) {
      sim.u.fill(0);
      sim.v.fill(0);
    }
  }

  function kick() {
    if (manual) return;
    if (raf || timer) return;
    raf = requestAnimationFrame(tick);
  }

  // ---- wiring ----
  const refresh = () => {
    resize();
    kick();
  };
  if (!manual) {
    if (typeof ResizeObserver === "function") new ResizeObserver(refresh).observe(canvas);
    window.addEventListener("resize", refresh);
    window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", readColors);
    window.matchMedia?.("(prefers-contrast: more)")?.addEventListener?.("change", readColors);
    // Settings > Appearance flips <html data-theme> without an OS change.
    if (typeof MutationObserver === "function") new MutationObserver(readColors).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (motion && opts.reducedMotion === undefined) reduced = motion.matches;
    motion?.addEventListener?.("change", (e) => {
      reduced = e.matches;
      kick();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) kick();
    });
  }
  readColors();
  resize();

  return {
    /**
     * @param {{view?:string, floor?:string, attention?:boolean, working?:boolean, workSince?:number|null,
     *          persona?:string, cantHear?:boolean, stars?:Array<{s:number,born:number}>}} s
     */
    set(s) {
      const t = now();
      const prev = { ...st };
      for (const k of Object.keys(st)) if (s[k] !== undefined) st[k] = s[k];
      if (!started) {
        // Baseline: whatever is on screen at load is shown as it is, never animated in.
        started = true;
        if (st.attention && st.view === "live") ev.appr = t - 10;
        kick();
        return;
      }
      const live = st.view === "live";
      if (st.attention && live && !(prev.attention && prev.view === "live")) {
        const bd = bead(t);
        ev.frozenBead = bd && !bd.peg ? bd.s : st.working ? beadPosition(Date.now() - (st.workSince ?? Date.now())) : 0.9;
        ev.appr = t;
        ev.resolve = null;
      } else if ((!st.attention || !live) && ev.appr != null) {
        ev.appr = null;
        ev.resolve = live ? t : null;
        if (!st.working && live) ev.flash = t + 0.95;
      }
      if (prev.working && !st.working && ev.resolve == null && ev.appr == null && live) {
        const bd = bead(t);
        ev.finishFrom = bd ? clamp(bd.s) : 0.9;
        ev.finish = t;
        ev.flash = t + 0.6;
      } else if (prev.working && !st.working && ev.resolve != null && t - ev.resolve < 0.1) {
        ev.flash = ev.resolve + 0.95;
      }
      if (prev.floor === "sleeping" && st.floor !== "sleeping") ev.wake = t;
      if (st.floor === "muted" && prev.floor !== "muted") ev.muted = t;
      if ((st.floor === "connecting" || st.floor === "reconnecting") && prev.floor !== st.floor && prev.floor !== "sleeping") ev.connect = t;
      if (st.persona !== prev.persona && prev.persona && live) {
        ev.personaFrom = prev.persona;
        ev.persona = t;
      }
      if (st.view !== "live") tides = [];
      kick();
    },
    /** Levels are 0..1 (after lib.gateLevel). `wake`: the wake detector's level while sleeping. */
    input(micLevel, voiceLevel, wake = 0) {
      const was = mic > 0 || voice > 0 || room > 0.02;
      const q = `${quantizeLevel(mic)}|${quantizeLevel(voice)}`;
      mic = micLevel || 0;
      voice = voiceLevel || 0;
      room = wake || 0;
      // Reduced motion shows three static levels: redraw only when one changes.
      if (reduced) {
        if (q !== `${quantizeLevel(mic)}|${quantizeLevel(voice)}`) kick();
        return;
      }
      if (mic > 0 || voice > 0 || room > 0.02 || was) kick();
    },
    relayout: refresh,
    refreshColors: readColors,
    /** Draw now (the capture harness drives the clock itself). */
    frame() {
      draw();
    },
    get animating() {
      return raf !== 0 || timer !== 0;
    },
  };
}

// ---- small geometry helpers (the approval frame) ----
function roundedPoly(pts, r) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const [cx, cy] = pts[i + 1];
    const d1 = Math.hypot(bx - ax, by - ay);
    const d2 = Math.hypot(cx - bx, cy - by);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    const p1 = [bx - ((bx - ax) / d1) * rr, by - ((by - ay) / d1) * rr];
    const p2 = [bx + ((cx - bx) / d2) * rr, by + ((cy - by) / d2) * rr];
    out.push(p1);
    for (let k = 1; k < 8; k++) {
      const t = k / 8;
      out.push([(1 - t) * (1 - t) * p1[0] + 2 * (1 - t) * t * bx + t * t * p2[0], (1 - t) * (1 - t) * p1[1] + 2 * (1 - t) * t * by + t * t * p2[1]]);
    }
    out.push(p2);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
function trimPoly(pts, len) {
  const out = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc + d >= len) {
      const t = (len - acc) / d;
      out.push([lerp(pts[i - 1][0], pts[i][0], t), lerp(pts[i - 1][1], pts[i][1], t)]);
      return out;
    }
    acc += d;
    out.push(pts[i]);
  }
  return out;
}
function polyLen(p) {
  let a = 0;
  for (let i = 1; i < p.length; i++) a += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return a;
}
