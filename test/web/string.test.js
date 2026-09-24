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
  draws = 0; await wait(1000);
  out.approvalHeld = { draws, animating: s.animating };
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
  // The shimmer: about 24 fps, and no more than that.
  assert.ok(m.approvalHeld.draws >= 10 && m.approvalHeld.draws <= 30, JSON.stringify(m));
  assert.deepEqual(m.resolved, { draws: 0, animating: false }, JSON.stringify(m));
});
