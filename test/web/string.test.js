// The string's cost model (hybrid IMPLEMENTATION §5): the idle panel is a still
// image. With the real web/string.js on the real page in silent headless Chrome:
// an idle live window schedules no frames at all; sound runs frames and they stop
// once the string is quiet again; a held approval keeps only its corona shimmer.
// Skipped where Chrome is not installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CHROME, openPage } from "../helpers/web-page.js";

const RUN = `(async () => {
  const { createString } = await import("/string.js");
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let draws = 0;
  const measure = () => {
    const c = $("string-canvas").getBoundingClientRect(), p = $("mute-btn").getBoundingClientRect(), row = $("dial").getBoundingClientRect(), f = document.querySelector(".bottom").getBoundingClientRect();
    return { w: c.width, h: c.height, pegX: p.left + p.width / 2, pegY: p.top + p.height / 2, pegR: 22, x1: row.right, frameB: f.top - 12 };
  };
  const s = createString($("string-canvas"), { measure, reducedMotion: false });
  const ctx = $("string-canvas").getContext("2d");
  const clear = ctx.clearRect.bind(ctx);
  ctx.clearRect = (...a) => { draws++; return clear(...a); };
  const out = {};
  s.set({ view: "live", floor: "listening", persona: "sotto", stars: [] });
  await wait(600);
  draws = 0; await wait(1000);
  out.idle = { draws, animating: s.animating };
  for (let i = 0; i < 30; i++) { s.input(0, 0.5); await wait(16); }
  out.speaking = { animating: s.animating };
  s.input(0, 0);
  await wait(6000);
  draws = 0; await wait(800);
  out.afterSound = { draws, animating: s.animating };
  s.set({ attention: true, working: true, workSince: Date.now() - 60000 });
  await wait(2500);
  // The frame cap is what string.js asks for (its tick's timer delay, no rAF), not the
  // draws counted in a wall-clock second: a software-rendered canvas on a slow CI runner
  // draws fewer frames than it schedules (9 in a second was seen on the macOS runner).
  const st = window.setTimeout, raf = window.requestAnimationFrame;
  const delays = []; let rafs = 0;
  window.setTimeout = (fn, ms, ...rest) => { if (fn && fn.name === "tick") delays.push(ms); return st(fn, ms, ...rest); };
  window.requestAnimationFrame = (fn) => { if (fn && fn.name === "tick") rafs++; return raf(fn); };
  draws = 0; await wait(1000);
  window.setTimeout = st; window.requestAnimationFrame = raf;
  out.approvalHeld = { draws, animating: s.animating, minDelay: Math.min(...delays), frames: delays.length, rafs };
  s.set({ attention: false, working: false });
  await wait(3500);
  draws = 0; await wait(800);
  out.resolved = { draws, animating: s.animating };
  return out;
})()`;

test("string: the idle panel draws nothing; sound and a held approval draw, then it rests", { skip: fs.existsSync(CHROME) ? false : "Chrome not installed", timeout: 60000 }, async (t) => {
  const page = await openPage(t, { width: 420, height: 640 });
  const m = await page.eval(RUN);
  assert.deepEqual(m.idle, { draws: 0, animating: false }, JSON.stringify(m));
  assert.equal(m.speaking.animating, true, JSON.stringify(m));
  assert.deepEqual(m.afterSound, { draws: 0, animating: false }, JSON.stringify(m));
  // The shimmer: it keeps drawing, on a timer of about 24 fps (never display rate), and
  // never more than 24 frames in a second.
  const a = m.approvalHeld;
  assert.equal(a.animating, true, JSON.stringify(m));
  assert.ok(a.draws >= 3 && a.draws <= 30, JSON.stringify(m));
  assert.equal(a.rafs, 0, `no display-rate frames: ${JSON.stringify(m)}`);
  assert.ok(a.frames >= 3 && a.minDelay >= 40 && a.minDelay <= 45, `a ~24 fps timer: ${JSON.stringify(m)}`);
  assert.deepEqual(m.resolved, { draws: 0, animating: false }, JSON.stringify(m));
});
