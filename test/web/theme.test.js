// Settings > Appearance (SPEC-DEVIATIONS "appearance"): System / Light / Dark.
// The choice is applied before first paint by an inline script in <head>, so a
// window never flashes the other theme; data-theme beats prefers-color-scheme.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHROME, openPage, until } from "../helpers/web-page.js";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const read = (f) => fs.readFileSync(path.join(WEB, f), "utf8");

test("the theme is applied in <head> before the stylesheet and before app.js", () => {
  const html = read("index.html");
  const head = html.slice(0, html.indexOf("</head>"));
  const inline = head.search(/<script>[^<]*localStorage\.getItem\("clv\.theme"\)/);
  assert.ok(inline > 0, "inline theme script in <head>");
  assert.ok(inline < head.indexOf('<link rel="stylesheet" href="styles.css">'), "before the stylesheet");
  assert.ok(inline < head.indexOf('<script type="module" src="app.js">'), "before app.js");
  // app.js stores the same key.
  assert.match(read("app.js"), /const KEY_THEME = "clv\.theme";/);
  // The appearance control: System is the default.
  assert.match(html, /data-theme-choice="system" aria-checked="true"/);
});

test("styles.css: data-theme wins over the OS, and both dark blocks are identical", () => {
  const css = read("styles.css");
  const block = (re) => {
    const m = css.match(re);
    assert.ok(m, String(re));
    return m[1].split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
  };
  const media = block(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/);
  const forced = block(/\n:root\[data-theme="dark"\] \{([^}]*)\}/);
  assert.equal(forced, media);
  assert.match(media, /color-scheme: dark;/);
  // No other rule may key on the OS alone (it would ignore a forced Light).
  const bare = [...css.matchAll(/@media \(prefers-color-scheme: dark\) \{\s*([^{]+)\{/g)].map((m) => m[1].trim());
  assert.deepEqual(bare, [':root:not([data-theme="light"])']);
});

const PROBE = `(() => {
  // Runs before any page script: record data-theme the moment <body> exists (before
  // the first paint can happen).
  window.__themeAtBody = "unset";
  new MutationObserver((_, obs) => {
    if (document.body) { window.__themeAtBody = document.documentElement.getAttribute("data-theme"); obs.disconnect(); }
  }).observe(document, { childList: true, subtree: true });
})()`;

test("no flash: a stored choice is on <html> before <body> exists; System follows the OS live", { skip: fs.existsSync(CHROME) ? false : "Chrome not installed", timeout: 60000 }, async (t) => {
  const page = await openPage(t);
  await page.send("Page.enable");
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
  const bg = () => page.eval(`getComputedStyle(document.body).backgroundColor`);
  const reload = async () => {
    // Mark the old document so the wait below cannot see it as the reloaded one.
    await page.eval(`window.__old = true, location.reload(), true`).catch(() => {});
    assert.ok(await until(() => page.eval(`!window.__old && document.readyState === "complete"`), 10000), "reloaded");
    await page.frames();
  };
  const LIGHT = "rgb(251, 252, 253)";
  const DARK = "rgb(5, 7, 12)";
  for (const [os, stored, attr, want] of [
    ["light", "dark", "dark", DARK],
    ["dark", "light", "light", LIGHT],
    ["dark", null, null, DARK],
    ["light", null, null, LIGHT],
    ["light", "bogus", null, LIGHT],
  ]) {
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: os }] });
    await page.eval(stored == null ? `localStorage.removeItem("clv.theme"), true` : `localStorage.setItem("clv.theme", ${JSON.stringify(stored)}), true`);
    await reload();
    assert.equal(await page.eval(`window.__themeAtBody`), attr, `OS ${os}, stored ${stored}: data-theme when <body> appeared`);
    assert.equal(await bg(), want, `OS ${os}, stored ${stored}: page background`);
  }
  // System: an OS change applies live, with no reload.
  // (The emulated OS change reaches the renderer asynchronously: poll briefly.)
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  assert.ok(await until(async () => (await bg()) === DARK, 5000), `System follows the OS to dark: ${await bg()}`);
  // A forced Light ignores the OS change.
  await page.eval(`document.documentElement.setAttribute("data-theme", "light"), true`);
  await page.frames();
  assert.equal(await bg(), LIGHT);
  assert.equal(await page.eval(`getComputedStyle(document.documentElement).colorScheme`), "light");
});
