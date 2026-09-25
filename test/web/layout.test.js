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
import { CHROME, openPage, until } from "../helpers/web-page.js";

const SETUP = `
  const lib = await import("/lib.js");
  const panel = await import("/panel.js");
  const $ = (id) => document.getElementById(id);
  const el = {
    body: document.body, claude: $("claude"), claudeTitle: $("claude-title"), claudeAgents: $("claude-agents"), claudeTime: $("claude-time"),
    claudeTimeValue: $("claude-time-value"), claudeMoon: $("claude-moon"), claudeDetail: $("claude-detail"), claudePage: $("claude-page"),
    claudeFlow: $("claude-flow"), claudeScroll: $("claude-scroll"), claudeThumb: $("claude-thumb"), claudeJump: $("claude-jump"),
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
    // Quiet states keep the page and speak on the caption line (lib.inlineCard): no card.
    sleeping: [{ phase: "idle", state: "sleeping", sleep: { title: "Sleeping", body: "Voice wakes up when you speak.", listening: true } }, { busy: false, summary: "Done." }],
    paused: [{ phase: "idle", state: "paused", pausedReason: "idle", idleMinutes: 5 }, { busy: false, summary: "Done." }],
    // A notice takes the caption line (panel.paintBanner): nothing floats, nothing moves.
    cantHear: [{ banner: { level: "warn", text: "I can't hear you \u2014 using OBSBOT Meet 2 Microphone.", action: { label: "Switch mic" } } }, { busy: false, summary: "Done." }],
  };
  const out = {};
  for (const [name, [p, c]] of Object.entries(states)) {
    const v = lib.pageView({ phase: "live", state: "live", ...p });
    const b = document.body.dataset;
    b.view = v.view; b.dial = v.dial; b.floor = v.floor; b.card = v.card?.kind || ""; b.status = v.header.key; b.inline = String(lib.inlineCard(v));
    $("status-label").textContent = lib.statusWord(v); $("project").textContent = "claude-live";
    const h = lib.headline(v, { attention: !!p.attention, busy: !!c.busy, tool: "Running the tests" });
    panel.paintHeadline($("stage-word"), h, { fade: false });
    const note = lib.captionNote(v) || lib.inlineNote(v);
    $("stage-sub").hidden = !note; $("stage-sub").textContent = note || "";
    $("overlay").hidden = !v.card || lib.inlineCard(v);
    if (p.banner) panel.paintBanner($("banners"), p.banner, { enter: false }); else $("banners").replaceChildren();
    const m = lib.claudeView(c);
    let pg = lib.pushPage({ msgs: [], turnStart: 0 }, "I read the spec.");
    if (c.says) pg = lib.pushPage(pg, c.says);
    if (m.summary) pg = lib.pushPage(pg, m.summary);
    panel.paintClaude(el, { m, head: lib.claudeHead(m), entries: lib.pageEntries(pg), says: c.says || "",
      time: c.busy ? "4:12" : null, requestLine: m.request ? { tone: "", text: "Asked: " + m.request.text } : null });
    await frames();
    out[name] = {
      word: h.word, wordTop: top("stage-word"), wordH: $("stage-word").offsetHeight, peg: top("mute-btn"), caption: top("captions-panel"),
      head: top(document.querySelector(".claude-head")), page: top("claude-page"), pageH: $("claude-page").offsetHeight,
      footer: top(document.querySelector(".bottom")), chip: top("persona-chip"), gear: top("settings-btn"),
      project: Math.round($("project").getBoundingClientRect().left * 10) / 10, overlay: !$("overlay").hidden,
      note: $("stage-sub").hidden ? null : $("stage-sub").textContent,
      banner: $("banners").firstElementChild ? [top($("banners").querySelector(".banner-text")), getComputedStyle($("captions-panel")).visibility] : null,
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
    assert.equal(rows.length, 11);
    for (const key of ["wordTop", "wordH", "peg", "caption", "head", "page", "pageH", "footer", "chip", "gear", "project"]) {
      const vals = new Set(rows.map((r) => r[key]));
      assert.equal(vals.size, 1, `${w}x${h}: ${key} moved across states: ${JSON.stringify(Object.fromEntries(Object.entries(m).map(([k, r]) => [k, r[key]])))}`);
    }
    assert.equal(m.working.word, "Claude is testing");
    assert.equal(m.approval.word, "Approve in the terminal");
    assert.equal(m.muted.word, "Muted");
    // Asleep and paused: no card, the state on the caption line, the page in place.
    assert.equal(m.sleeping.overlay, false);
    assert.equal(m.sleeping.note, "Just start talking. Nothing is sent or billed until then.");
    assert.equal(m.paused.overlay, false);
    assert.equal(m.paused.note, "Paused after 5 minutes of silence. Press Space to resume.");
    // The notice sits on the caption line and hides the caption under it.
    assert.deepEqual(m.cantHear.banner, [m.cantHear.caption, "hidden"]);
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
  panel.paintClaude(el, { m, head: lib.claudeHead(m), entries: [], says: "It renders every concept at both sizes and in both themes, then compares them.",
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

// Claude's page is a fixed region that scrolls (SPEC-DEVIATIONS "scrolling page"): a
// long reply never moves or resizes it; it follows the latest words, stops when the
// reader scrolls up (a wheel, as a trackpad would) and shows "Jump to latest", resumes
// at the bottom or from the pill; the thumb shows while scrolling and hides after ~1 s;
// a finished reply taller than the page reads from its first line. Silent Chrome.
const PARA = "The refresh timer now uses the fake clock, so it can no longer fire in the middle of an assertion. I ran the auth suite fifty times in a loop and it passed every time.";
const FILL = `(async () => {
  ${SETUP}
  const v = lib.pageView({ phase: "live", state: "live" });
  const b = document.body.dataset;
  b.view = v.view; b.dial = v.dial; b.floor = v.floor; b.card = ""; b.inline = "false";
  $("overlay").hidden = true;
  const box = () => { const r = $("claude-page").getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((x) => Math.round(x * 10) / 10); };
  const S = { pg: { msgs: [], turnStart: 0 } };
  S.paint = (kind, extra = {}) => {
    const last = S.pg.msgs[S.pg.msgs.length - 1] || "";
    const m = lib.claudeView(kind === "finished" ? { busy: false, summary: last } : kind === "approval"
      ? { busy: true, kind: "permission", text: "Bash: rm -rf node_modules && npm ci" } : { busy: true, says: last });
    panel.paintClaude(el, { m, head: lib.claudeHead(m), entries: lib.pageEntries(S.pg), says: kind === "approval" ? "${PARA}" : "", time: "1:00", requestLine: null, ...extra });
  };
  S.state = async () => { await frames(); return { ...el.follow.state(), box: box(), pageShown: !!$("claude-page").offsetParent }; };
  S.push = async (text, kind = "working") => { S.pg = lib.pushPage(S.pg, text); S.paint(kind); return S.state(); };
  S.lib = lib; S.el = el;
  window.__t = S;
  S.pg = lib.pageTurn(S.pg);
  S.paint("working", { newTurn: true });
  const empty = await S.state();
  for (let i = 1; i <= 8; i++) { S.pg = lib.pushPage(S.pg, "Step " + i + ". ${PARA}"); S.paint("working"); await frames(); }
  const long = await S.state();
  const sc = $("claude-scroll");
  return { empty, long, scrollH: sc.scrollHeight, clientH: sc.clientHeight, tones: [...$("claude-flow").children].map((n) => n.dataset.tone),
    thumbW: $("claude-thumb").getBoundingClientRect().width, gutter: parseFloat(getComputedStyle(sc).paddingRight),
    scrollbar: sc.offsetWidth - sc.clientWidth };
})()`;
const STATE = `window.__t.state()`;

test("Claude's page: a long reply scrolls in a fixed region; follow, unfollow, jump to latest", { skip: fs.existsSync(CHROME) ? false : "Chrome not installed", timeout: 60000 }, async (t) => {
  const page = await openPage(t, { width: 420, height: 640 });
  await page.setSize(420, 640);
  const r = await page.eval(FILL);
  assert.deepEqual(r.long.box, r.empty.box, `the region moved or resized with its content: ${JSON.stringify(r)}`);
  assert.ok(r.scrollH > r.clientH * 2, `the reply overflows: ${JSON.stringify(r)}`);
  assert.deepEqual(r.tones, ["turn", "turn", "turn", "turn", "turn", "turn", "turn", "latest"]);
  assert.equal(r.scrollbar, 0, "no native scrollbar takes room: the thumb is the scroller");
  assert.ok(r.gutter >= r.thumbW + 4, `the thumb sits in a gutter clear of the text: ${JSON.stringify(r)}`);
  // Following: at the end, a fade above, none below, no pill, the thumb hidden at rest.
  const f0 = r.long;
  assert.equal(f0.following, true);
  assert.ok(Math.abs(f0.scrollTop - f0.target) <= 1, JSON.stringify(f0));
  assert.deepEqual([f0.above, f0.below, f0.jump, f0.thumb], [true, false, false, false]);

  // The reader scrolls up with the wheel: following stops, the pill and the thumb show.
  const [x, y] = await page.eval(`(() => { const r = document.getElementById("claude-scroll").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: -500 });
  const up = await until(async () => { const s = await page.eval(STATE); return s.scrollTop < f0.scrollTop - 100 && !s.following ? s : null; }, 5000);
  assert.ok(up, "the wheel scrolled the page up and stopped following");
  assert.deepEqual([up.jump, up.below, up.thumb], [true, true, true], JSON.stringify(up));
  assert.deepEqual(up.box, r.empty.box);
  // New words while the reader is up there: their place is kept.
  const kept = await page.eval(`window.__t.push("Step 9. ${PARA}")`);
  assert.equal(kept.following, false);
  assert.ok(Math.abs(kept.scrollTop - up.scrollTop) <= 1, `the reader's place moved: ${up.scrollTop} -> ${kept.scrollTop}`);
  // The thumb fades about a second after the scrolling stops.
  const hidden = await until(async () => { const s = await page.eval(STATE); return s.thumb ? null : s; }, 3000);
  assert.ok(hidden, "the thumb hides after scrolling stops");

  // Back to the bottom by hand: following again, the pill goes.
  await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: 5000 });
  const down = await until(async () => { const s = await page.eval(STATE); return s.following && !s.jump ? s : null; }, 5000);
  assert.ok(down, "scrolling to the bottom resumes following");
  const next = await page.eval(`window.__t.push("Step 10. ${PARA}")`);
  assert.ok(next.following && Math.abs(next.scrollTop - next.target) <= 1, `new words follow: ${JSON.stringify(next)}`);

  // Up again, then "Jump to latest".
  await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: -800 });
  assert.ok(await until(async () => (await page.eval(STATE)).jump, 5000), "the pill shows");
  await page.eval(`document.getElementById("claude-jump").click()`);
  const jumped = await until(async () => { const s = await page.eval(STATE); return s.following && Math.abs(s.scrollTop - s.target) <= 1 && !s.jump ? s : null; }, 5000);
  assert.ok(jumped, "Jump to latest scrolls to the newest words and follows");

  // A finished reply taller than the page reads from its first line (still following).
  const longReply = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}. ${PARA}`).join("\\n\\n");
  const fin = await page.eval(`(async () => { window.__t.pg = window.__t.lib.pushPage(window.__t.pg, ${JSON.stringify("## Done\n\n")} + "${longReply}"); window.__t.paint("finished"); return window.__t.state(); })()`);
  const top = await page.eval(`document.getElementById("claude-flow").lastElementChild.offsetTop`);
  assert.equal(fin.following, true);
  assert.ok(Math.abs(fin.scrollTop - (top - 28)) <= 1, `the finished reply shows from its start, under the fade: ${fin.scrollTop} vs ${top}`);
  assert.equal(fin.below, true);
  assert.deepEqual(fin.box, r.empty.box);

  // A new turn follows again even if the reader had scrolled away.
  await page.eval(`document.getElementById("claude-scroll").scrollTop = 0`);
  assert.ok(await until(async () => !(await page.eval(STATE)).following, 3000));
  const turn = await page.eval(`(async () => { const t = window.__t; t.pg = t.lib.pageTurn(t.pg); t.pg = t.lib.pushPage(t.pg, "Looking at it."); t.paint("working", { newTurn: true }); return t.state(); })()`);
  assert.ok(turn.following && Math.abs(turn.scrollTop - turn.target) <= 1, JSON.stringify(turn));
  const tones = await page.eval(`[...document.getElementById("claude-flow").children].map((n) => n.dataset.tone)`);
  assert.equal(tones.at(-1), "latest");
  assert.ok(tones.slice(0, -1).every((x) => x === "past"), JSON.stringify(tones));
});

// Small windows: the page gives way first. At 360 x 420 the approval still shows the
// command and fits inside the Claude zone; a long page stays a fixed region.
test("Claude's page at 360 x 420: the approval fits, the page region shrinks first", { skip: fs.existsSync(CHROME) ? false : "Chrome not installed", timeout: 60000 }, async (t) => {
  const page = await openPage(t, { width: 360, height: 420 });
  await page.setSize(360, 420);
  const r = await page.eval(FILL);
  assert.ok(r.long.pageShown, "the page region is still there at 360 x 420");
  assert.ok(r.long.box[3] >= 40, `the page keeps a few lines: ${JSON.stringify(r.long.box)}`);
  assert.deepEqual(r.long.box, r.empty.box);
  assert.equal(r.long.following, true);
  await page.eval(`window.__t.paint("approval")`);
  // Measured once the style has settled: two frames were not always enough on a
  // loaded CI runner (the scroll region read "visible" there, CI 2026-09-25).
  const measure = () => page.eval(`(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const $ = (id) => document.getElementById(id);
    const zone = $("claude").getBoundingClientRect(), pg = $("claude-page").getBoundingClientRect(), cmd = $("claude-command").getBoundingClientRect();
    const footer = document.querySelector(".bottom").getBoundingClientRect();
    return { ask: !$("claude-ask").hidden, cmd: [cmd.top, cmd.bottom, cmd.height], page: [pg.top, pg.bottom], zone: [zone.top, zone.bottom], footer: footer.top,
      scroll: getComputedStyle($("claude-scroll")).visibility, jump: getComputedStyle($("claude-jump")).visibility };
  })()`);
  const a = (await until(async () => { const m = await measure(); return m.scroll === "hidden" && m.jump === "hidden" ? m : null; }, 3000)) || (await measure());
  assert.equal(a.ask, true);
  assert.ok(a.cmd[2] > 10, `the command shows: ${JSON.stringify(a)}`);
  assert.ok(a.cmd[0] >= a.page[0] - 0.5 && a.cmd[1] <= a.page[1] + 0.5, `the command fits the page: ${JSON.stringify(a)}`);
  assert.ok(a.zone[1] <= a.footer + 0.5, `the zone stays above the footer: ${JSON.stringify(a)}`);
  assert.equal(a.scroll, "hidden", "the question takes the region");
  assert.equal(a.jump, "hidden");
});

// The footer's device buttons (SPEC-DEVIATIONS "Devices in the footer"): 40 px targets,
// nothing overlapping or past the window at 360 px, and the picker opens over the panel,
// above the footer, without moving any zone.
const FOOTER = `(async () => {
  ${SETUP}
  const v = lib.pageView({ phase: "live", state: "live" });
  const b = document.body.dataset;
  b.view = v.view; b.dial = v.dial; b.floor = v.floor; b.card = ""; b.inline = "false";
  $("overlay").hidden = true;
  $("chip-name").textContent = "Sotto"; $("chip-voice").textContent = "marin";
  const rect = (n) => { const r = (typeof n === "string" ? $(n) : n).getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
  const zones = () => ({ claude: rect("claude"), footer: rect(document.querySelector(".bottom")), chip: rect("persona-chip"), mic: rect("mic-btn"), spk: rect("speaker-btn") });
  await frames();
  const closed = zones();
  const devs = [{ kind: "audioinput", deviceId: "default", label: "Default - MacBook Pro Microphone" }, { kind: "audioinput", deviceId: "mbp", label: "MacBook Pro Microphone" },
    { kind: "audioinput", deviceId: "usb", label: "A USB microphone with a very long name that must not widen the picker" }];
  panel.paintDevicePicker($("dev-picker"), { kind: "audioinput", items: lib.deviceMenu(devs, "audioinput", "usb") });
  $("dev-picker").hidden = false;
  await frames();
  const open = zones();
  const picker = rect("dev-picker");
  const rows = [...$("dev-picker").querySelectorAll(".dev-item")].map((n) => [n.textContent, n.getAttribute("aria-checked")]);
  $("dev-picker").hidden = true;
  return { closed, open, picker, rows, vw: document.documentElement.clientWidth, vh: innerHeight, sw: document.documentElement.scrollWidth };
})()`;

test("footer devices: 40 px buttons fit at 360 px; the picker opens above the footer and moves nothing", { skip: fs.existsSync(CHROME) ? false : "Chrome not installed", timeout: 60000 }, async (t) => {
  const page = await openPage(t, { width: 360, height: 640 });
  for (const [w, h] of [[360, 420], [360, 640], [420, 640], [640, 900]]) {
    await page.setSize(w, h);
    const r = await page.eval(FOOTER);
    const { chip, mic, spk, footer } = r.closed;
    for (const [n, b] of [["mic", mic], ["speaker", spk]]) {
      assert.equal(Math.round(b.w), 40, `${w}x${h}: ${n} is a 40 px target`);
      assert.equal(Math.round(b.h), 40, `${w}x${h}: ${n} is a 40 px target`);
      assert.ok(b.t >= footer.t - 0.5 && b.b <= footer.b + 0.5, `${w}x${h}: ${n} inside the footer`);
    }
    assert.ok(chip.r <= mic.l + 0.5, `${w}x${h}: the chip runs into the mic button ${JSON.stringify(r.closed)}`);
    assert.ok(mic.r <= spk.l + 0.5);
    assert.ok(r.sw <= r.vw, `${w}x${h}: horizontal scroll`);
    assert.deepEqual(r.open, r.closed, `${w}x${h}: a zone moved when the picker opened`);
    assert.ok(r.picker.l >= 0 && r.picker.r <= r.vw + 0.5 && r.picker.t >= 0, `${w}x${h}: the picker is inside the window ${JSON.stringify(r.picker)}`);
    assert.ok(r.picker.b <= footer.t + 0.5, `${w}x${h}: the picker sits above the footer`);
    assert.equal(r.rows[0][0], "System default (MacBook Pro Microphone)");
    assert.deepEqual(r.rows.map((x) => x[1]), ["false", "false", "true", null], "the check on the chosen mic; Sound settings last");
  }
});
