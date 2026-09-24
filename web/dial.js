// sotto web page: the voice instrument (the dial around the mute button).
//
// Rings, from the centre out. Each voice has its own FORM, not only its own colour:
//   inner ring  - you: 48 short, thick capsules driven by the mic spectrum, jagged and
//                 asymmetric, with peak-hold dots. Muted: they collapse into violet dots.
//                 Sleeping: they follow the local wake detector's level (wake.js).
//   channel     - an empty band (>= 0.06 R) so the two voices never merge.
//   outer ring  - Sotto: a continuous, mirror-symmetric filled envelope with a
//                 crisp edge over 144 hairlines, driven by the level of an UNPLAYED clone
//                 of the remote track (app.js); the <audio> element stays the
//                 echo-cancellation reference (SPEC §7.3).
//   bezel       - 120 fine ticks, majors every 30 degrees. It ratchets one tick per
//                 second while someone talks. While Claude Code works, a chase of 16
//                 bezel ticks lights up in blue and travels round: the bezel is Claude
//                 Code's ring.
//   rim         - grey sweep while connecting / reconnecting; dashed amber pulse while
//                 Claude waits for approval; a static amber tick at 10 o'clock points at
//                 Chrome's microphone bubble.
//   bloom       - a soft halo whose strength follows the loudest talker (a pale tint in
//                 light mode, never a dark smudge).
//
// Cost model (measured, see design/final/index.html): only sound needs per-frame
// drawing. The level rings live on one 2D canvas that is redrawn only while a level,
// a peak or a state morph is moving; a quiet listening window draws nothing at all.
// Everything that moves without sound (bezel, chase, sweep, approval pulse) and the
// bloom are drawn ONCE into their own layers and moved with CSS transform/opacity on
// the compositor (styles.css, .dial-layer). Budgeted redraws (a morph with no sound,
// the sleeping breath) are scheduled with a timer, never with rAF-and-skip, so an idle
// or sleeping window does not wake the main thread at 60 Hz.
// prefers-reduced-motion: levels snap to rest / mid / full, CSS motion stops, and every
// state still has its own static shape.
//
// Failure is contained: without a 2D context this returns a no-op dial, and a missing
// createConicGradient (WebKit before 16.4) falls back to a flat arc. app.js also wraps
// createDial() so the voice client never depends on the decoration.
//
// No dependency on app.js state: app.js calls set() and input().

import { smoothLevel, quantizeLevel } from "./lib.js";

const TAU = Math.PI * 2;
const TOP = -Math.PI / 2;
const N_IN = 48;
const N_OUT = 72; // envelope control points (the voice meter's symmetric profile)
const N_HAIR = 144; // outer hairlines, double density
const N_BEZEL = 120;
const N_CHASE = 16;
const MORPH_MS = 70; // time constant: a shape change settles in ~200 ms
const PEAK_HOLD_MS = 520;
const PEAK_FALL = 1.4; // of full length per second
const MORPH_FRAME_MS = 33; // a state morph with no sound runs at 30 fps
const BREATH_FRAME_MS = 200; // sleeping breathes at 5 fps (sub-pixel steps)
const BREATH_PERIOD_MS = 6400;

// Geometry, as fractions of the dial radius. The mute button covers ~0.405 R.
export const GEOMETRY = Object.freeze({
  inR: 0.48,
  inRest: 0.04,
  inMax: 0.12, // inner max 0.64 R (+ peak dot)
  outR: 0.72, // channel 0.64 .. 0.72 stays empty
  outRest: 0.028,
  outMax: 0.165, // outer max ~0.91 R
  bezelR: 0.975,
  bezelTick: 0.028,
  bezelMajor: 0.05,
  rimR: 0.992,
});
const G = GEOMETRY;

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

const rgba = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
const approach = (cur, target, k) => cur + (target - cur) * k;

/** A dial that draws nothing: the page keeps working when the canvas is unavailable. */
export function nullDial() {
  return { set() {}, input() {}, refreshColors() {}, animating: false };
}

/**
 * @param {HTMLCanvasElement} canvas  the level canvas; its parent is the dial box
 * @param {{reducedMotion?: boolean}} [opts]
 */
export function createDial(canvas, opts = {}) {
  const box = canvas?.parentElement;
  const ctx = canvas?.getContext?.("2d");
  if (!box || !ctx) return nullDial();
  let reduced = !!opts.reducedMotion;
  let size = 0;
  let dpr = 1;
  let raf = 0;
  let timer = 0;
  let lastDraw = 0;
  let colors = null;

  // Compositor layers: drawn once per size/theme, moved by CSS only.
  const layer = (cls, before = canvas) => {
    const c = document.createElement("canvas");
    c.className = `dial-layer ${cls}`;
    c.setAttribute("aria-hidden", "true");
    box.insertBefore(c, before);
    return c;
  };
  const bloomEl = layer("dial-bloom");
  const bezelEl = layer("dial-bezel");
  const workEl = layer("dial-work");
  const sweepEl = layer("dial-sweep");
  const attnEl = layer("dial-attn");
  const layers = [bloomEl, bezelEl, workEl, sweepEl, attnEl];

  // Target state from app.js.
  const target = { floor: "off", working: false, attention: false, hint: null, voiceDown: false };
  // Inputs.
  let micBands = null;
  let voiceBands = null;
  let micIn = 0;
  let voiceIn = 0;
  // Smoothed values.
  let mic = 0;
  let voice = 0;
  let bloomKey = "";
  let bloomShown = -1;
  const inLen = new Float32Array(N_IN);
  const inPeak = new Float32Array(N_IN);
  const inPeakAt = new Float64Array(N_IN);
  const outLen = new Float32Array(N_OUT);
  const env = new Float32Array(N_HAIR);
  // Morphing shape parameters (0..1), eased toward their targets.
  const shape = { inVis: 0, outVis: 0, dots: 0, dashed: 0, dormant: 1, attn: 0 };
  // Colours, eased too (channel-wise), so a state change crossfades.
  const col = { inner: null, outer: null };

  function readColors() {
    const cs = getComputedStyle(box);
    const v = (name) => parseColor(cs.getPropertyValue(name));
    colors = {
      live: v("--live"),
      voice: v("--voice"),
      voiceRest: v("--voice-rest"),
      work: v("--work"),
      attn: v("--attn"),
      mute: v("--mute"),
      rest: v("--tick-rest"),
      fg3: v("--fg-3"),
      line: v("--line"),
      bloom: {
        you: v("--bloom-you"),
        voice: v("--bloom-voice"),
        muted: v("--bloom-mute"),
        attn: v("--bloom-attn"),
      },
    };
    for (const k of Object.keys(col)) col[k] = null; // snap on a theme change
    bloomKey = "";
    paintLayers();
    kick();
  }

  function resize() {
    const rect = box.getBoundingClientRect();
    const s = Math.round(Math.min(rect.width, rect.height));
    const d = Math.min(3, window.devicePixelRatio || 1);
    if (!s || (s === size && d === dpr)) return;
    size = s;
    dpr = d;
    for (const c of [canvas, ...layers]) c.width = c.height = Math.max(1, Math.round(s * d));
    bloomKey = "";
    if (!colors) readColors();
    else paintLayers();
    draw(performance.now());
  }

  // ---- the static layers ----------------------------------------------------------
  function prep(c) {
    const g = c.getContext("2d");
    if (!g) return null;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);
    return g;
  }

  function ticks(g, from, to, count, len, width, color, alphaFor, major) {
    const R = size / 2;
    for (let i = from; i < to; i++) {
      const a = TOP + (i / count) * TAU;
      const r1 = G.bezelR * R;
      const r2 = r1 - (major && i % 10 === 0 ? G.bezelMajor : len) * R;
      g.beginPath();
      g.moveTo(R + Math.cos(a) * r1, R + Math.sin(a) * r1);
      g.lineTo(R + Math.cos(a) * r2, R + Math.sin(a) * r2);
      g.lineWidth = width;
      g.strokeStyle = rgba(color, alphaFor(i));
      g.stroke();
    }
  }

  function paintLayers() {
    if (!size || !colors) return;
    const R = size / 2;
    const scale = size / 208;
    // Bezel: hairline circle + 120 fine ticks, majors every 30 degrees.
    let g = prep(bezelEl);
    if (g) {
      g.beginPath();
      g.arc(R, R, G.bezelR * R, 0, TAU);
      g.lineWidth = 1;
      g.strokeStyle = rgba(colors.line, 1);
      g.stroke();
      g.beginPath();
      for (let i = 0; i < N_BEZEL; i++) {
        const a = TOP + (i / N_BEZEL) * TAU;
        const r1 = G.bezelR * R;
        const r2 = r1 - (i % 10 === 0 ? G.bezelMajor : G.bezelTick) * R;
        g.moveTo(R + Math.cos(a) * r1, R + Math.sin(a) * r1);
        g.lineTo(R + Math.cos(a) * r2, R + Math.sin(a) * r2);
      }
      g.lineCap = "butt";
      g.lineWidth = Math.max(0.75, 0.9 * scale);
      g.strokeStyle = rgba(colors.fg3, 0.45);
      g.stroke();
    }
    // Work chase: 16 bezel ticks lit in blue, head at 12 o'clock, tail fading
    // counter-clockwise. CSS turns the layer in 3-degree steps, so the lit ticks
    // always sit exactly on bezel ticks.
    g = prep(workEl);
    if (g) {
      g.lineCap = "round";
      ticks(g, N_BEZEL - N_CHASE + 1, N_BEZEL + 1, N_BEZEL, G.bezelMajor * 1.35, 2.5 * scale, colors.work, (i) => 0.18 + 0.82 * ((i - (N_BEZEL - N_CHASE)) / N_CHASE) ** 1.6, false);
    }
    // Connecting sweep: a grey comet on the rim.
    g = prep(sweepEl);
    if (g) comet(g, G.rimR * R - 1.5 * scale, 1.8 * scale, colors.fg3, 0.3);
    // Approval: a dashed amber ring on the rim (CSS pulses its opacity).
    g = prep(attnEl);
    if (g) {
      g.setLineDash([10 * scale, 5 * scale]);
      g.beginPath();
      g.arc(R, R, G.rimR * R - 1.5 * scale, 0, TAU);
      g.lineWidth = 3 * scale;
      g.strokeStyle = rgba(colors.attn, 1);
      g.stroke();
    }
  }

  /** An arc with a fading tail; the head sits at `spanTurns` (CSS rotates the layer). */
  function comet(g, r, width, color, spanTurns) {
    const R = size / 2;
    const head = TOP + spanTurns * TAU;
    if (typeof g.createConicGradient === "function") {
      const grad = g.createConicGradient(TOP, R, R);
      grad.addColorStop(0, rgba(color, 0));
      grad.addColorStop(spanTurns * 0.55, rgba(color, 0.28));
      grad.addColorStop(spanTurns, rgba(color, 1));
      grad.addColorStop(Math.min(1, spanTurns + 0.0005), rgba(color, 0));
      g.strokeStyle = grad;
    } else {
      g.strokeStyle = rgba(color, 0.6); // WebKit < 16.4: a flat arc still reads as a sweep
    }
    g.beginPath();
    g.arc(R, R, r, TOP, head);
    g.lineWidth = width;
    g.lineCap = "butt";
    g.stroke();
    g.beginPath();
    g.arc(R + Math.cos(head) * r, R + Math.sin(head) * r, width * 0.9, 0, TAU);
    g.fillStyle = rgba(color, 1);
    g.fill();
  }

  /** The bloom is a pre-drawn halo; only its CSS opacity follows the level. */
  function paintBloom(key) {
    if (key === bloomKey || !size || !colors) return;
    bloomKey = key;
    const g = prep(bloomEl);
    if (!g) return;
    const c = colors.bloom[key] || colors.bloom.you;
    const R = size / 2;
    const grad = g.createRadialGradient(R, R, 0.4 * R, R, R, R);
    grad.addColorStop(0, rgba(c, c[3]));
    grad.addColorStop(0.55, rgba(c, c[3] * 0.4));
    grad.addColorStop(1, rgba(c, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }

  function setBloom(glow) {
    const f = target.floor;
    const key = target.attention ? "attn" : f === "muted" ? "muted" : f === "voice" || (voice > mic && voice > 0.02) ? "voice" : "you";
    paintBloom(key);
    let a = glow + (f === "muted" ? 0.3 : 0) + (target.attention ? 0.35 : 0);
    a = reduced ? (a > 0.05 ? 0.6 : 0) : Math.min(1, a);
    const q = Math.round(a * 50) / 50;
    if (q === bloomShown) return;
    bloomShown = q;
    bloomEl.style.opacity = String(q);
  }

  /** CSS carries the level-free motion; dial.js only flips attributes. */
  function syncLayers() {
    const f = target.floor;
    const b = box.dataset;
    const talking = f === "you" || f === "voice";
    b.spin = String(!reduced && talking && !target.working);
    b.work = target.working && !target.attention ? (target.voiceDown ? "dim" : "true") : "false";
    b.sweep = String(f === "connecting" || f === "reconnecting");
    b.attn = String(target.attention);
  }

  // ---- targets per floor ---------------------------------------------------------
  function targets() {
    const f = target.floor;
    const live = f === "listening" || f === "you" || f === "voice" || f === "muted";
    const linking = f === "connecting" || f === "reconnecting";
    const sleeping = f === "sleeping";
    const c = colors;
    return {
      t: {
        inVis: live ? 1 : linking ? 0.7 : sleeping ? 0.8 : 0.55,
        outVis: live ? 1 : linking ? 0.8 : sleeping ? 0.35 : 0.55,
        dots: f === "muted" ? 1 : 0,
        dashed: linking ? 1 : 0,
        dormant: live ? 0 : sleeping ? 0.6 : 1,
        attn: target.attention ? 1 : 0,
      },
      inner: f === "muted" ? c.mute : live || sleeping ? c.live : c.rest,
      outer: f === "voice" ? c.voice : live ? c.voiceRest : c.rest,
    };
  }

  const breathing = () => !reduced && target.floor === "sleeping";
  const levelsMoving = () => micIn > 0.002 || voiceIn > 0.002 || mic > 0.002 || voice > 0.002;

  // ---- loop ------------------------------------------------------------------------
  function schedule(delay) {
    if (raf || timer) return;
    if (delay > 0) {
      timer = setTimeout(() => {
        timer = 0;
        raf = requestAnimationFrame(frame);
      }, delay);
    } else raf = requestAnimationFrame(frame);
  }

  /** Something changed: draw on the next frame (cancels a pending budgeted redraw). */
  function kick() {
    if (!size) return;
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    schedule(0);
  }

  function frame(now) {
    raf = 0;
    const dt = lastDraw ? Math.min(250, now - lastDraw) : 16;
    const moving = step(now, dt);
    draw(now);
    lastDraw = now;
    // Sound gets every frame; a morph with no sound 30 fps; the sleeping breath 5 fps.
    if (levelsMoving()) schedule(0);
    else if (moving) schedule(MORPH_FRAME_MS);
    else if (breathing()) schedule(BREATH_FRAME_MS);
    else lastDraw = 0;
  }

  /** Advance smoothing and tweens. Returns true while anything is still moving. */
  function step(now, dt) {
    const tg = targets();
    const k = reduced ? 1 : 1 - Math.exp(-dt / MORPH_MS);
    let moving = false;
    for (const key of Object.keys(shape)) {
      const next = approach(shape[key], tg.t[key], k);
      const done = Math.abs(next - tg.t[key]) <= 0.002;
      shape[key] = done ? tg.t[key] : next;
      if (!done) moving = true;
    }
    for (const key of ["inner", "outer"]) {
      const want = tg[key];
      if (!col[key]) col[key] = want.slice();
      for (let i = 0; i < 3; i++) {
        const n = approach(col[key][i], want[i], k);
        const done = Math.abs(n - want[i]) <= 0.5;
        col[key][i] = done ? want[i] : n;
        if (!done) moving = true;
      }
    }

    // Levels. Muted: the inner ring ignores the mic (the service hears nothing).
    const micT = target.floor === "muted" ? 0 : micIn;
    if (reduced) {
      mic = quantizeLevel(micT);
      voice = quantizeLevel(voiceIn);
    } else {
      mic = smoothLevel(mic, micT, dt, 40, 220);
      voice = smoothLevel(voice, voiceIn, dt, 60, 320);
    }
    if (mic < 0.002) mic = 0;
    if (voice < 0.002) voice = 0;
    if (mic || voice || micIn || voiceIn) moving = true;

    for (let i = 0; i < N_IN; i++) {
      const band = micBands ? micBands[i % micBands.length] : 1;
      // Jagged: each capsule follows its own band, no spatial smoothing.
      const want = reduced ? mic : mic * (0.22 + 0.78 * band ** 1.4);
      inLen[i] = reduced ? want : smoothLevel(inLen[i], want, dt, 30, 200);
      if (inLen[i] < 0.002) inLen[i] = 0;
      if (inLen[i] >= inPeak[i]) {
        inPeak[i] = inLen[i];
        inPeakAt[i] = now;
      } else if (now - inPeakAt[i] > PEAK_HOLD_MS) {
        inPeak[i] = Math.max(inLen[i], inPeak[i] - (PEAK_FALL * dt) / 1000);
      }
      if (inLen[i] || inPeak[i] > 0.002) moving = true;
    }
    for (let i = 0; i < N_OUT; i++) {
      const band = voiceBands ? voiceBands[i % voiceBands.length] : 1;
      // Calm: the bands arrive mirrored and blurred (lib.symmetricProfile).
      const want = reduced ? voice : voice * (0.12 + 0.88 * band ** 1.8);
      outLen[i] = reduced ? want : smoothLevel(outLen[i], want, dt, 70, 300);
      if (outLen[i] < 0.002) outLen[i] = 0;
      if (outLen[i]) moving = true;
    }
    // Cosine-interpolate the 72 control points onto the 144 hairlines: one smooth contour.
    for (let j = 0; j < N_HAIR; j++) {
      const x = (j * N_OUT) / N_HAIR;
      const i0 = Math.floor(x) % N_OUT;
      const i1 = (i0 + 1) % N_OUT;
      const f = (1 - Math.cos((x - Math.floor(x)) * Math.PI)) / 2;
      env[j] = outLen[i0] * (1 - f) + outLen[i1] * f;
    }
    setBloom(Math.max(mic, voice) * 0.9);
    return moving;
  }

  // ---- drawing ---------------------------------------------------------------------
  function draw(now) {
    if (!size || !colors) return;
    const R = size / 2;
    const scale = size / 208; // stroke widths are tuned at the default 208 px dial
    const c = colors;
    const inner = col.inner || c.rest;
    const outer = col.outer || c.rest;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    // Sleeping breath: a slow swell of the inner rest capsules only.
    const breath = breathing() ? 0.5 - 0.5 * Math.cos((now / BREATH_PERIOD_MS) * TAU) : 0;
    const dormantA = 1 - shape.dormant * 0.4;
    const dashed = shape.dashed > 0.5;
    // A compact dial (the 124 px layouts) draws every other tick, so the rings stay
    // rings of ticks instead of blurring into solid bands.
    const every = size < 160 ? 2 : 1;

    // ---- outer ring (Sotto): hairlines under a filled, mirrored envelope ----
    const r0 = G.outR * R;
    const rest = G.outRest * R * shape.outVis;
    ctx.lineCap = "butt";
    ctx.beginPath();
    for (let j = 0; j < N_HAIR; j += every) {
      if (dashed && j % 4 >= 2) continue;
      const a = TOP + (j / N_HAIR) * TAU;
      const len = rest + env[j] * G.outMax * R;
      if (len < 0.4) continue;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      ctx.moveTo(R + cos * r0, R + sin * r0);
      ctx.lineTo(R + cos * (r0 + len), R + sin * (r0 + len));
    }
    ctx.lineWidth = Math.max(0.75, 1.1 * scale);
    // Under the envelope the hairlines are texture, not weight.
    ctx.strokeStyle = rgba(outer, dormantA * (voice > 0 ? 0.3 : 0.9));
    ctx.stroke();
    if (voice > 0.01) {
      ctx.beginPath();
      for (let j = 0; j <= N_HAIR; j++) {
        const a = TOP + (j / N_HAIR) * TAU;
        const r = r0 + rest + env[j % N_HAIR] * G.outMax * R;
        const x = R + Math.cos(a) * r;
        const y = R + Math.sin(a) * r;
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      // Fill the band between the contour and the ring's base circle.
      ctx.moveTo(R + r0, R);
      ctx.arc(R, R, r0, 0, -TAU, true);
      ctx.fillStyle = rgba(outer, 0.08 + 0.1 * voice);
      ctx.fill("evenodd");
      ctx.beginPath();
      for (let j = 0; j <= N_HAIR; j++) {
        const a = TOP + (j / N_HAIR) * TAU;
        const r = r0 + rest + env[j % N_HAIR] * G.outMax * R;
        const x = R + Math.cos(a) * r;
        const y = R + Math.sin(a) * r;
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(1, 1.5 * scale);
      ctx.strokeStyle = rgba(outer, Math.min(1, 0.35 + voice));
      ctx.stroke();
    }

    // ---- inner ring (you): thick capsules; muted -> violet dots ----
    const vis = shape.inVis * (1 - shape.dots) * (1 + breath * 1.1);
    const ri = G.inR * R;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let i = 0; i < N_IN; i += every) {
      if (dashed && (i / every) % 2 === 1) continue;
      const a = TOP + (i / N_IN) * TAU;
      const len = G.inRest * R * vis + inLen[i] * G.inMax * R;
      if (len < 0.4) continue;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      ctx.moveTo(R + cos * ri, R + sin * ri);
      ctx.lineTo(R + cos * (ri + len), R + sin * (ri + len));
    }
    ctx.lineWidth = 3.4 * scale;
    ctx.strokeStyle = rgba(inner, dormantA * (target.floor === "sleeping" ? 0.55 + 0.35 * breath : 1));
    ctx.stroke();
    if (shape.dots > 0.01) {
      ctx.beginPath();
      const rr = ri + G.inRest * R * 0.5;
      const dr = 1.9 * scale * shape.dots;
      for (let i = 0; i < N_IN; i += 2) {
        const a = TOP + (i / N_IN) * TAU;
        const x = R + Math.cos(a) * rr;
        const y = R + Math.sin(a) * rr;
        ctx.moveTo(x + dr, y);
        ctx.arc(x, y, dr, 0, TAU);
      }
      ctx.fillStyle = rgba(c.mute, shape.dots);
      ctx.fill();
    }

    // Peak-hold dots just past each capsule; they hang, then fall.
    if (!reduced && target.floor !== "muted") {
      ctx.beginPath();
      let any = false;
      for (let i = 0; i < N_IN; i++) {
        if (inPeak[i] < 0.08 || inPeak[i] - inLen[i] < 0.03) continue;
        const a = TOP + (i / N_IN) * TAU;
        const r = ri + G.inRest * R * vis + inPeak[i] * G.inMax * R + 3.5 * scale;
        const x = R + Math.cos(a) * r;
        const y = R + Math.sin(a) * r;
        ctx.moveTo(x + 1.3 * scale, y);
        ctx.arc(x, y, 1.3 * scale, 0, TAU);
        any = true;
      }
      if (any) {
        ctx.fillStyle = rgba(inner, 0.9);
        ctx.fill();
      }
    }

    // Allow-microphone: a static amber pointer at 10 o'clock, toward Chrome's bubble.
    if (target.hint === "prompt") {
      const a = TOP - TAU / 6;
      const r1 = G.outR * R;
      const r2 = G.rimR * R;
      ctx.beginPath();
      ctx.moveTo(R + Math.cos(a) * r1, R + Math.sin(a) * r1);
      ctx.lineTo(R + Math.cos(a) * r2, R + Math.sin(a) * r2);
      ctx.lineCap = "round";
      ctx.lineWidth = 4 * scale;
      ctx.strokeStyle = rgba(c.attn, 1);
      ctx.stroke();
      const tip = r2 + 2 * scale;
      const w = 0.09;
      ctx.beginPath();
      ctx.moveTo(R + Math.cos(a) * (tip + 7 * scale), R + Math.sin(a) * (tip + 7 * scale));
      ctx.lineTo(R + Math.cos(a - w) * tip, R + Math.sin(a - w) * tip);
      ctx.lineTo(R + Math.cos(a + w) * tip, R + Math.sin(a + w) * tip);
      ctx.closePath();
      ctx.fillStyle = rgba(c.attn, 1);
      ctx.fill();
    }
  }

  // ---- wiring ------------------------------------------------------------------------
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => resize()) : null;
  ro?.observe(box);
  window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", () => readColors());
  const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  if (motion && opts.reducedMotion === undefined) reduced = motion.matches;
  motion?.addEventListener?.("change", (e) => {
    reduced = e.matches;
    syncLayers();
    kick();
  });
  resize();
  syncLayers();

  return {
    /** @param {{floor?:string, working?:boolean, attention?:boolean, hint?:string|null, voiceDown?:boolean}} s */
    set(s) {
      let changed = false;
      for (const k of ["floor", "working", "attention", "hint", "voiceDown"]) {
        if (s[k] !== undefined && target[k] !== s[k]) {
          target[k] = s[k];
          changed = true;
        }
      }
      if (!changed) return;
      syncLayers();
      kick();
    },
    /** Levels are 0..1 (after lib.gateLevel); bands are Float32Array 0..1 or null. */
    input(micLevel, voiceLevel, mBands, vBands) {
      const was = micIn > 0 || voiceIn > 0;
      micIn = micLevel || 0;
      voiceIn = voiceLevel || 0;
      micBands = mBands || null;
      voiceBands = vBands || null;
      if (micIn > 0 || voiceIn > 0) {
        if (!raf) kick();
      } else if (was) kick();
    },
    refreshColors: readColors,
    get animating() {
      return raf !== 0 || timer !== 0;
    },
  };
}
