// Layout stability of the live view (SPEC-DEVIATIONS "status word"): the word
// under the dial changes with the floor ("Listening", "Hearing you",
// "Speaking", "Muted", an approval), but the Claude card and the captions
// below it must never move. Measured in real headless Chrome on the real
// index.html + styles.css, with the stage filled from lib.pageView() the way
// app.js renderStage() fills it. app.js itself is replaced by an empty module
// (no daemon, no microphone, no audio). Skipped where Chrome is not installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CHROME, openPage } from "../helpers/web-page.js";

// Fill the stage the way app.js renderStage() does, then measure.
const MEASURE = `(async () => {
  const lib = await import("/lib.js");
  const $ = (id) => document.getElementById(id);
  const b = document.body.dataset;
  // A working Claude card and two caption lines, as in a real session.
  b.claude = "working";
  $("claude-title").textContent = "Claude is working";
  $("claude-step").hidden = false;
  $("claude-step").textContent = "I found the bug in voice.js. Fixing it now.";
  for (const [id, who, text] of [["cap-prev", "You", "Can you check the tests"], ["cap-latest", "Sotto", "Sure, asking Claude now."]]) {
    const li = $(id); li.hidden = false; li.firstElementChild.textContent = who; li.lastElementChild.textContent = text;
  }
  $("captions-empty").hidden = true;
  const out = {};
  const states = { listening: {}, you: { floor: "you" }, voice: { floor: "voice" }, muted: { muted: true }, approval: { attention: true }, approvalMuted: { attention: true, muted: true } };
  for (const [name, s] of Object.entries(states)) {
    const v = lib.pageView({ phase: "live", state: "live", ...s });
    b.view = v.view; b.dial = v.dial; b.floor = v.floor; b.card = "";
    $("stage-word").textContent = v.word;
    $("stage-word").dataset.tone = v.wordTone || "";
    $("stage-sub").hidden = v.view === "live" ? false : !v.sub;
    $("stage-sub").textContent = v.sub || "";
    $("key-hint").hidden = false;
    $("connect-steps").hidden = true;
    $("overlay").hidden = true;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    out[name] = {
      word: v.word,
      captions: Math.round($("captions-panel").getBoundingClientRect().top * 10) / 10,
      claude: Math.round($("claude").getBoundingClientRect().top * 10) / 10,
      hint: Math.round($("key-hint").getBoundingClientRect().top * 10) / 10,
    };
  }
  return out;
})()`;

test("live view: the Claude card and the captions never move when the status word changes", { skip: fs.existsSync(CHROME) ? false : "Chrome not installed", timeout: 60000 }, async (t) => {
  // openPage stops Chrome and waits for it to exit before removing its profile
  // (test/helpers/silent-chrome.js stopChrome; this file used to race that).
  const page = await openPage(t, { width: 420, height: 760 });
  for (const [w, h] of [[420, 760], [360, 640], [560, 900]]) {
    // The override lands asynchronously; on a slow runner (CI) the first state
    // was measured at the previous size. setSize waits for the new viewport and a layout.
    await page.setSize(w, h);
    const m = await page.eval(MEASURE);
    const rows = Object.values(m);
    assert.equal(rows.length, 6);
    for (const key of ["captions", "claude", "hint"]) {
      const tops = new Set(rows.map((r) => r[key]));
      assert.equal(tops.size, 1, `${w}x${h}: ${key} top moved across states: ${JSON.stringify(m)}`);
    }
  }
});
