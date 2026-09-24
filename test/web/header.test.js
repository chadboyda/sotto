// Header pills (SPEC-DEVIATIONS "header pills"): Session, Today and Cost tick every
// second, but nothing in the header may move while they do. Measured in real headless
// Chrome on the real index.html + styles.css, filled through web/header.js (the code
// app.js runs) from lib.usagePills(). The clocks tick through every digit-count
// change up to the hour: only the hour rollover (m:ss -> h:mm:ss) may widen a pill,
// once. Skipped where Chrome is not installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CHROME, openPage } from "../helpers/web-page.js";

const TICKS = [9, 10, 59, 60, 61, 599, 600, 601, 3599, 3600, 3601, 35_999, 36_000];

const MEASURE = (live) => `(async () => {
  const lib = await import("/lib.js");
  const header = await import("/header.js");
  const $ = (id) => document.getElementById(id);
  document.body.dataset.status = "live";
  $("status-label").textContent = "Listening";
  $("project").textContent = "sotto";
  $("usage").hidden = false;
  const h = { top: document.querySelector(".top"), statusText: $("status-label").parentElement, project: $("project"), statusDetail: $("status-detail"), pills: [$("usage-today"), $("usage-session")] };
  const box = (id) => { const e = $(id); if (e.hidden) return null; const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 100) / 100); };
  // Each run starts from a fresh header, as a new page would.
  for (const id of ["usage-session", "usage-today", "usage-cost"]) { $(id).dataset.shown = ""; $(id).querySelector(".pill-value").removeAttribute("data-wide"); }
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  await frame(); await frame();
  const out = [];
  for (const s of ${JSON.stringify(TICKS)}) {
    // Today runs ahead of the session, as it does in a real day; the cost holds a
    // billed reading of the same seconds.
    const p = lib.usagePills({ sessionSeconds: ${live} ? s : null, todaySeconds: s, costSeconds: s });
    let changed = header.setPill($("usage-session"), p.session);
    changed = header.setPill($("usage-today"), p.today) || changed;
    changed = header.setPill($("usage-cost"), p.cost) || changed;
    if (changed || !out.length) header.fitHeader(h);
    await frame(); await frame();
    const fig = (id) => { const f = $(id).querySelector(".pill-value"); return f.scrollWidth <= f.clientWidth; };
    const wide = ["usage-session", "usage-today", "usage-cost"].map((id) => $(id).querySelector(".pill-value").hasAttribute("data-wide"));
    out.push({ s, texts: [p.session?.text, p.today.text, p.cost.text], wide, session: box("usage-session"), today: box("usage-today"), cost: box("usage-cost"), gear: box("settings-btn"), fits: fig("usage-session") && fig("usage-today") && fig("usage-cost") });
  }
  return out;
})()`;

test("header pills: ticking never moves a pill; only the hour widens one, once", { skip: fs.existsSync(CHROME) ? false : "Chrome not installed", timeout: 60000 }, async (t) => {
  const page = await openPage(t);
  for (const [w, h] of [[420, 640], [360, 420], [560, 900]]) {
    await page.setSize(w, h);
    for (const live of [true, false]) {
      const rows = await page.eval(MEASURE(live));
      const where = `${w}x${h} ${live ? "live" : "off-live"}`;
      for (const r of rows) assert.ok(r.fits, `${where}: a figure overflows its box at ${r.s} s: ${JSON.stringify(r)}`);
      // The cost pill and the gear never move (the cost here stays under $100).
      for (const key of ["cost", "gear"]) {
        assert.equal(new Set(rows.map((r) => JSON.stringify(r[key]))).size, 1, `${where}: ${key} moved: ${JSON.stringify(rows.map((r) => [r.s, r.texts, r.wide, r[key]]))}`);
      }
      // Session and Today: constant below the hour, constant from the hour on, and
      // one change at the rollover (or hidden throughout for want of room).
      for (const key of ["session", "today"]) {
        const before = new Set(rows.filter((r) => r.s < 3600).map((r) => JSON.stringify(r[key])));
        const after = new Set(rows.filter((r) => r.s >= 3600).map((r) => JSON.stringify(r[key])));
        assert.equal(before.size, 1, `${where}: ${key} moved below the hour: ${JSON.stringify(rows.map((r) => [r.s, r.texts, r.wide, r[key]]))}`);
        assert.equal(after.size, 1, `${where}: ${key} moved after the hour: ${JSON.stringify(rows.map((r) => [r.s, r.texts, r.wide, r[key]]))}`);
      }
      // The money is always there.
      assert.ok(rows.every((r) => r.cost), `${where}: the cost pill hid`);
      if (live && w >= 420) assert.ok(rows.every((r) => r.session && r.today), `${where}: room for all three pills`);
      const first = rows.find((r) => r.s === 3599);
      const hour = rows.find((r) => r.s === 3600);
      if (hour.today && first.today) assert.ok(hour.today[2] > first.today[2], `${where}: Today widens at the hour`);
    }
  }
});
