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

// The approval card at its most crowded (the user's 0.3.2 screenshot: a background
// agent's prompt, "5 background agents working", "7 min 0 sec", a long command)
// stays inside the panel at every width: nothing past the card's content box,
// the card inside the viewport, no horizontal scroll.
const CROWDED = `(async () => {
  const lib = await import("/lib.js");
  const $ = (id) => document.getElementById(id);
  const b = document.body.dataset;
  const v = lib.pageView({ phase: "live", state: "live", attention: true });
  b.view = v.view; b.dial = v.dial; b.floor = v.floor; b.card = "";
  $("stage-word").textContent = v.word;
  const m = lib.claudeView({ busy: true, kind: "permission", agent: true, agents: 5,
    text: "cd /tmp && O=/Users/someone/dev/project/design/concepts-v2/concept-3/stills && rm -f $O/*.png && python3 render_frames_with_a_very_long_script_name_without_spaces.py" });
  b.claude = m.kind;
  $("claude-title").textContent = m.title;
  $("claude-agents").hidden = false; $("claude-agents").textContent = m.agents;
  $("claude-time").textContent = "7 min 0 sec";
  $("claude-step").hidden = true;
  $("claude-command").hidden = false; $("claude-command").textContent = m.command;
  $("claude-note").hidden = false;
  $("claude-request").hidden = false; $("claude-request").textContent = "Asked: \\u201CRender every concept at both sizes and in both themes, then compare them\\u201D";
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const card = $("claude").getBoundingClientRect();
  const cs = getComputedStyle($("claude"));
  const inner = { left: card.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth), right: card.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth) };
  const out = [];
  for (const el of $("claude").querySelectorAll("*")) {
    if (el.hidden || el.closest("[hidden]")) continue;
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    if (r.right > inner.right + 0.5 || r.left < inner.left - 0.5) out.push((el.id || el.className) + " " + Math.round(r.left) + ".." + Math.round(r.right));
  }
  const tt = $("claude-title");
  return { out, titleCut: tt.scrollWidth > tt.clientWidth + 1, card: [card.left, card.right], vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth, title: $("claude-title").textContent };
})()`;

test("approval card: a crowded head and a long command stay inside the panel at 360-640 px", { skip: fs.existsSync(CHROME) ? false : "Chrome not installed", timeout: 60000 }, async (t) => {
  const page = await openPage(t, { width: 360, height: 760 });
  for (const w of [360, 400, 420, 480, 560, 640]) {
    await page.setSize(w, 760);
    const m = await page.eval(CROWDED);
    assert.equal(m.title, "A background agent needs your approval");
    if (w >= 560) assert.equal(m.titleCut, false, `${w}px: the agents chip gives way before the title`);
    assert.deepEqual(m.out, [], `${w}px: past the card's content box: ${JSON.stringify(m)}`);
    assert.ok(m.card[0] >= 0 && m.card[1] <= m.vw + 0.5, `${w}px: card outside the viewport ${JSON.stringify(m)}`);
    assert.ok(m.sw <= m.vw, `${w}px: horizontal scroll ${m.sw} > ${m.vw}`);
  }
});
