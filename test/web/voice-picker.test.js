// The Settings voice and persona pickers show what each option is while you browse
// (daemon/config.js VOICE_INFO via GET /api/voices `info`; persona descriptions):
// panel.paintListPicker's open list has the description under every name, grouped
// by presentation for voices, keyboard navigable, laid over the drawer so nothing
// moves. Also "Hear the voices" chips with the tone under each name. Measured in
// real headless Chrome on the real index.html + styles.css, painted by web/panel.js
// (the code app.js runs). SOTTO_SHOT_DIR=<dir> keeps screenshots of the open
// pickers. Skipped without Chrome.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CHROME, openPage } from "../helpers/web-page.js";
import { VOICES, VOICE_INFO } from "../../daemon/config.js";
import { BUILTIN_PERSONAS } from "../../daemon/personas.js";

const VOICES_BODY = JSON.stringify({ voices: [...VOICES], current: "marin", live: true, live_voice: "marin", info: VOICE_INFO });
const PERSONAS = JSON.stringify({ personas: BUILTIN_PERSONAS.map((p) => ({ id: p.id, name: p.name, description: p.description, voice: p.voice, source: "builtin" })), current: "sotto" });
const SKIP = fs.existsSync(CHROME) ? false : "Chrome not installed";

const SETUP = `
  const panel = await import("/panel.js");
  const $ = (id) => document.getElementById(id);
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const settle = () => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  const rect = (n) => { const b = n.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
  const v = ${VOICES_BODY};
  const dlg = $("settings");
  if (!dlg.open) dlg.showModal();
  window.__chosen = window.__chosen || [];
  panel.paintVoiceSelect($("voice-select"), v);
  const vp = panel.paintListPicker($("voice-picker"), { groups: panel.voicePickerModel(v), value: "marin", label: "Voice" }, { onChoose: (id) => window.__chosen.push(["voice", id]) });
  const pp = panel.paintListPicker($("persona-picker"), { groups: panel.personaPickerModel(${PERSONAS}), value: "sotto", label: "Persona" }, { onChoose: (id) => window.__chosen.push(["persona", id]) });
  await frames(); await settle();
`;

const PICKERS = `(async () => {
  ${SETUP}
  const key = (target, k) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const below = [...document.querySelectorAll("#settings .field")].map(rect);
  const closed = rect(vp.btn);
  // Voice: open with the keyboard; the current one is active; every row has its description.
  vp.btn.focus();
  key(vp.btn, "ArrowDown");
  await frames();
  const vOpen = {
    open: !vp.list.hidden, expanded: vp.btn.getAttribute("aria-expanded"), focus: document.activeElement === vp.list,
    active: vp.list.querySelector('[data-active="true"]')?.dataset.id,
    heads: [...vp.list.querySelectorAll(".lp-group")].map((h) => h.textContent),
    rows: [...vp.list.querySelectorAll('[role="option"]')].map((o) => [o.dataset.id, o.querySelector(".lp-name").textContent, o.querySelector(".lp-desc").textContent, o.getAttribute("aria-selected"), o.getBoundingClientRect().height]),
    below: [...document.querySelectorAll("#settings .field")].map(rect), btn: rect(vp.btn),
    list: rect(vp.list), dlg: rect(dlg),
  };
  // Browse: Down twice, Up once, then Escape closes the list and not the drawer; nothing chosen.
  key(vp.list, "ArrowDown"); key(vp.list, "ArrowDown"); key(vp.list, "ArrowUp");
  const browsed = vp.list.querySelector('[data-active="true"]')?.dataset.id;
  key(vp.list, "Escape");
  await frames();
  const afterEsc = { open: !vp.list.hidden, dlgOpen: dlg.open, focus: document.activeElement === vp.btn, chosen: window.__chosen.length };
  // Open again, End, Enter chooses the last voice.
  key(vp.btn, "Enter"); vp.btn.click(); await frames();
  const reopened = !vp.list.hidden;
  key(vp.list, "End"); key(vp.list, "Enter");
  await frames();
  const chosen = [...window.__chosen];
  // Persona: open by click; rows carry the description and voice.
  pp.btn.click();
  await frames();
  const pOpen = {
    open: !pp.list.hidden,
    rows: [...pp.list.querySelectorAll('[role="option"]')].map((o) => [o.dataset.id, o.querySelector(".lp-desc").textContent, o.getAttribute("aria-selected")]),
    below: [...document.querySelectorAll("#settings .field")].map(rect),
  };
  // A click outside closes it.
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  await frames();
  return { closed, below, vOpen, browsed, afterEsc, reopened, chosen, pOpen, pClosed: pp.list.hidden, btnDesc: vp.btn.querySelector(".lp-desc").textContent,
    sw: document.documentElement.scrollWidth, vw: innerWidth };
})()`;

const CHIPS = `(async () => {
  ${SETUP}
  const grid = $("voice-grid");
  $("voice-samples").open = true;
  const chips = panel.paintVoiceGrid(grid, v, {});
  for (const b of chips) { b.dataset.state = "idle"; b.setAttribute("aria-current", String(b.dataset.voice === v.current)); }
  await frames(); await settle();
  const before = chips.map(rect);
  chips[3].dataset.state = "playing";
  await frames();
  const playing = chips.map(rect);
  chips[3].dataset.state = "idle";
  return {
    heads: [...grid.querySelectorAll(".voice-group")].map((h) => h.textContent),
    descs: chips.map((b) => [b.dataset.voice, b.querySelector(".chip-desc").textContent, b.querySelector(".chip-desc").scrollHeight <= b.querySelector(".chip-desc").clientHeight + 1]),
    heights: [...new Set(before.map((r) => r[3]))],
    before, playing,
    sw: document.documentElement.scrollWidth, vw: innerWidth,
  };
})()`;

async function shoot(page, name, setup) {
  const dir = process.env.SOTTO_SHOT_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  for (const theme of ["light", "dark"]) {
    await page.eval(`(async () => { document.documentElement.dataset.theme = "${theme}"; ${setup}; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); })()`);
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(dir, `${name}--${theme}.png`), Buffer.from(shot.result.data, "base64"));
  }
}

for (const [w, h] of [[360, 640], [420, 760]]) {
  test(`pickers at ${w} x ${h}: the open list shows every option's description, keyboard works, nothing moves`, { skip: SKIP, timeout: 60000 }, async (t) => {
    const page = await openPage(t, { width: w, height: h });
    await page.setSize(w, h);
    const r = await page.eval(PICKERS);
    const o = r.vOpen;
    assert.ok(o.open && o.expanded === "true" && o.focus, "ArrowDown opens the list and focuses it");
    assert.equal(o.active, "marin", "the current voice is highlighted");
    assert.deepEqual(o.heads, ["Feminine", "Masculine", "Androgynous"]);
    assert.equal(o.rows.length, VOICES.length);
    for (const [id, name, desc, , hgt] of o.rows) {
      assert.equal(name, id[0].toUpperCase() + id.slice(1));
      assert.equal(desc, `${VOICE_INFO[id].tone} · ${VOICE_INFO[id].accent}`, `${id}: its description under the name`);
      assert.ok(hgt >= 30, `${id}: a two-line row (${hgt})`);
    }
    assert.deepEqual(o.rows.filter((x) => x[3] === "true").map((x) => x[0]), ["marin"]);
    assert.deepEqual(o.below, r.below, "opening the list moves nothing in the drawer");
    assert.deepEqual(o.btn, r.closed, "the button keeps its size");
    assert.ok(o.list[2] > 0 && o.list[3] > 100, "the list has room");
    assert.equal(r.btnDesc, `${VOICE_INFO.marin.tone} · ${VOICE_INFO.marin.accent}`, "the button shows the current voice's description");
    const order = o.rows.map((x) => x[0]);
    assert.equal(r.browsed, order[order.indexOf("marin") + 1], "arrows move the highlight");
    assert.deepEqual(r.afterEsc, { open: false, dlgOpen: true, focus: true, chosen: 0 }, "Escape closes the list only; browsing chooses nothing");
    assert.ok(r.reopened);
    assert.deepEqual(r.chosen, [["voice", order.at(-1)]], "End + Enter chooses the last voice");
    assert.ok(r.pOpen.open);
    assert.equal(r.pOpen.rows.length, 10);
    for (const [id, desc] of r.pOpen.rows) assert.match(desc, /\S.* · [A-Z][a-z]+ voice$/, `${id}: persona description and voice`);
    assert.deepEqual(r.pOpen.below, r.below, "the persona list moves nothing");
    assert.ok(r.pClosed, "a click outside closes it");
    assert.ok(r.sw <= r.vw, "no horizontal scroll");
    const open = (id) => `const b = document.querySelector("#${id} .lp-button"); b.scrollIntoView({ block: "start" }); document.getElementById("settings").scrollBy(0, -60); if (document.querySelector("#${id} .lp-list").hidden) b.click()`;
    await shoot(page, `web-voice-picker-open-${w}x${h}`, open("voice-picker"));
    await page.eval(`document.querySelector("#voice-picker .lp-button").click()`);
    await shoot(page, `web-persona-picker-open-${w}x${h}`, open("persona-picker"));
  });

  test(`voice samples at ${w} x ${h}: tone under each name, same-height chips, nothing moves while a sample plays`, { skip: SKIP, timeout: 60000 }, async (t) => {
    const page = await openPage(t, { width: w, height: h });
    await page.setSize(w, h);
    const r = await page.eval(CHIPS);
    assert.deepEqual(r.heads, ["Feminine", "Masculine", "Androgynous"]);
    for (const [id, desc, fits] of r.descs) {
      assert.equal(desc, VOICE_INFO[id].tone, id);
      assert.ok(fits, `${id}: its tone fits in the chip's two lines`);
    }
    assert.equal(r.heights.length, 1, `every chip is the same height: ${r.heights}`);
    assert.deepEqual(r.playing, r.before, "a playing sample moves nothing");
    assert.ok(r.sw <= r.vw, "no horizontal scroll");
    await shoot(page, `web-voice-samples-${w}x${h}`, `document.getElementById("voice-samples").scrollIntoView({ block: "start" })`);
  });
}
