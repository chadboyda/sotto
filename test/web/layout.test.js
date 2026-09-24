// Layout stability of the hybrid panel (design/concepts-v2/hybrid; SPEC-DEVIATIONS
// "hybrid panel"): every zone is a fixed box. The headline, the peg, the caption line,
// the Claude row, Claude's page and the footer must not move by a pixel across the
// live states (listening, hearing you, speaking, Claude working, the approval,
// finished, muted). Measured in real headless Chrome on the real index.html +
// styles.css, filled through web/panel.js and lib.js (the code app.js runs). app.js
// itself is replaced by an empty module (no daemon, no microphone, no audio).
// Skipped where Chrome is not installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CHROME, openPage } from "../helpers/web-page.js";

const SETUP = `
  const lib = await import("/lib.js");
  const panel = await import("/panel.js");
  const $ = (id) => document.getElementById(id);
  const el = {
    body: document.body, claude: $("claude"), claudeTitle: $("claude-title"), claudeAgents: $("claude-agents"), claudeTime: $("claude-time"),
    claudeTimeValue: $("claude-time-value"), claudeMoon: $("claude-moon"), claudeDetail: $("claude-detail"), claudePage: $("claude-page"),
    claudeFlow: $("claude-flow"), claudeHistory: $("claude-history"), claudeStep: $("claude-step"), summary: $("summary"), moreBtn: $("more-btn"),
    claudeAsk: $("claude-ask"), claudeCommand: $("claude-command"), claudeWhy: $("claude-why"), claudeNote: $("claude-note"), claudeRequest: $("claude-request"),
  };
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const top = (id) => Math.round((typeof id === "string" ? $(id) : id).getBoundingClientRect().top * 10) / 10;
`;

const MEASURE = `(async () => {
  ${SETUP}
  const li = $("cap-latest"); li.hidden = false; li.className = "line assistant latest";
  li.firstElementChild.textContent = "Sotto"; li.lastElementChild.textContent = "Sure, asking Claude now.";
  $("captions-empty").hidden = true;
  const WORK = "Found the race: the token refresh in \`withSession()\` resolves **after** the assertion runs.\\n\\n- Await the refresh\\n- Run the suite";
  const req = { text: "Fix the flaky test", status: "delivered" };
  const states = {
    listening: [{}, { busy: false, summary: "Done." }],
    you: [{ floor: "you" }, { busy: false, summary: "Done." }],
    voice: [{ floor: "voice" }, { busy: false, summary: "Done." }],
    working: [{}, { busy: true, says: WORK, request: req }],
    approval: [{ attention: true }, { busy: true, kind: "permission", text: "rm -rf node_modules && npm ci", request: req }],
    finished: [{}, { busy: false, summary: "**Done.** The suite passes: 412 tests in 38 s." }],
    muted: [{ muted: true }, { busy: false, summary: "Done." }],
    approvalMuted: [{ muted: true, attention: true }, { busy: true, kind: "permission", text: "git push" }],
  };
  const out = {};
  for (const [name, [p, c]] of Object.entries(states)) {
    const v = lib.pageView({ phase: "live", state: "live", ...p });
    const b = document.body.dataset;
    b.view = v.view; b.dial = v.dial; b.floor = v.floor; b.card = ""; b.status = v.header.key;
    const h = lib.headline(v, { attention: !!p.attention, busy: !!c.busy, tool: "Running the tests" });
    panel.paintHeadline($("stage-word"), h, { fade: false });
    const note = lib.captionNote(v);
    $("stage-sub").hidden = !note; $("stage-sub").textContent = note || "";
    $("overlay").hidden = true;
    const m = lib.claudeView(c);
    panel.paintClaude(el, { m, head: lib.claudeHead(m), history: ["I read the spec."], says: c.says || "", summary: m.summary || null, expanded: false,
      time: c.busy ? "4:12" : null, requestLine: m.request ? { tone: "", text: "Asked: " + m.request.text } : null });
    await frames();
    out[name] = {
      word: h.word, wordTop: top("stage-word"), wordH: $("stage-word").offsetHeight, peg: top("mute-btn"), caption: top("captions-panel"),
      head: top(document.querySelector(".claude-head")), page: top("claude-page"), pageH: $("claude-page").offsetHeight,
      footer: top(document.querySelector(".bottom")), chip: top("persona-chip"), gear: top("settings-btn"),
    };
  }
  return out;
})()`;

test("live view: no zone moves across the states (listening to approval to muted)", { skip: fs.existsSync(CHROME) ? false : "Chrome not installed", timeout: 60000 }, async (t) => {
  const page = await openPage(t, { width: 420, height: 640 });
  for (const [w, h] of [[420, 640], [360, 640], [420, 760], [640, 900], [360, 480]]) {
    // The override lands asynchronously; setSize waits for the new viewport and a layout.
    await page.setSize(w, h);
    const m = await page.eval(MEASURE);
    const rows = Object.values(m);
    assert.equal(rows.length, 8);
    for (const key of ["wordTop", "wordH", "peg", "caption", "head", "page", "pageH", "footer", "chip", "gear"]) {
      const vals = new Set(rows.map((r) => r[key]));
      assert.equal(vals.size, 1, `${w}x${h}: ${key} moved across states: ${JSON.stringify(Object.fromEntries(Object.entries(m).map(([k, r]) => [k, r[key]])))}`);
    }
    assert.equal(m.working.word, "Claude is testing");
    assert.equal(m.approval.word, "Approve in the terminal");
    assert.equal(m.muted.word, "Muted");
  }
});

// The approval at its most crowded (a background agent's prompt, five agents, a long
// command without spaces) stays inside the frame at every width: nothing past the
// Claude zone's box, the zone inside the viewport, no horizontal scroll.
const CROWDED = `(async () => {
  ${SETUP}
  const v = lib.pageView({ phase: "live", state: "live", attention: true });
  const b = document.body.dataset;
  b.view = v.view; b.dial = v.dial; b.floor = v.floor; b.card = "";
  const m = lib.claudeView({ busy: true, kind: "permission", agent: true, agents: 5,
    text: "cd /tmp && O=/Users/someone/dev/project/design/concepts-v2/concept-3/stills && rm -f $O/*.png && python3 render_frames_with_a_very_long_script_name_without_spaces.py" });
  panel.paintClaude(el, { m, head: lib.claudeHead(m), history: [], says: "It renders every concept at both sizes and in both themes, then compares them.", summary: null, expanded: false,
    time: "7:00", requestLine: { tone: "", text: "Asked: \\u201CRender every concept at both sizes and in both themes, then compare them\\u201D" } });
  await frames();
  const zone = $("claude").getBoundingClientRect();
  const out = [];
  for (const node of $("claude").querySelectorAll("*")) {
    if (node.hidden || node.closest("[hidden]")) continue;
    const r = node.getBoundingClientRect();
    if (!r.width) continue;
    if (r.right > zone.right + 0.5 || r.left < zone.left - 0.5) out.push((node.id || node.className.baseVal || node.className) + " " + Math.round(r.left) + ".." + Math.round(r.right));
  }
  return { out, title: $("claude-title").textContent, zone: [zone.left, zone.right], vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth };
})()`;

test("approval: a crowded head and a long command stay inside the frame at 360-640 px", { skip: fs.existsSync(CHROME) ? false : "Chrome not installed", timeout: 60000 }, async (t) => {
  const page = await openPage(t, { width: 360, height: 760 });
  for (const w of [360, 400, 420, 480, 560, 640]) {
    await page.setSize(w, 760);
    const m = await page.eval(CROWDED);
    assert.equal(m.title, "A background agent is waiting for you");
    assert.deepEqual(m.out, [], `${w}px: past the Claude zone: ${JSON.stringify(m)}`);
    assert.ok(m.zone[0] >= 0 && m.zone[1] <= m.vw + 0.5, `${w}px: zone outside the viewport ${JSON.stringify(m)}`);
    assert.ok(m.sw <= m.vw, `${w}px: horizontal scroll ${m.sw} > ${m.vw}`);
  }
});
