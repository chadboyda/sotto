// The panel's DOM painters (the Filament + Orrery layout), shared by app.js and the
// layout tests (test/web/layout.test.js), so the tests measure the code the page runs.
// Pure view models come from lib.js; these only write them into fixed boxes. Every
// write is skipped when nothing changed, so a 1 s tick never restarts an animation.
import * as lib from "./lib.js";

const setText = (node, text) => {
  if (node.textContent !== text) node.textContent = text;
};
const setHtml = (node, html) => {
  if (node.dataset.html !== html) {
    node.innerHTML = html;
    node.dataset.html = html;
  }
};
const msg = (md) => `<div class="msg">${lib.renderMarkdown(md, { code: "omit" })}</div>`;

/** The headline (lib.headline output). A new word fades in over the old one in the same slot. */
export function paintHeadline(word, h, { fade = true } = {}) {
  if (word.textContent !== h.word) {
    word.dataset.fade = "false";
    word.textContent = h.word;
    if (fade) requestAnimationFrame(() => (word.dataset.fade = "true"));
  }
  word.dataset.tone = h.tone || "";
}

/**
 * Claude's zone: the head row (moon phase, "Claude · Working", the time), the request
 * line, and the page (Claude's messages as rendered markdown, in a fixed region that
 * scrolls) or the question.
 * @param {object} el  the elements (see app.js `el`)
 * @param {{m:object, head:object, entries:{text:string,tone:string}[], says:string,
 *          time:string|null, requestLine:{text:string,tone:string}|null, newTurn?:boolean}} s
 */
export function paintClaude(el, s) {
  const { m, head } = s;
  el.body.dataset.claude = m.kind;
  el.claudeMoon.dataset.phase = head.phase;
  setText(el.claudeTitle, head.label);
  setText(el.claudeDetail, head.detail || "");
  el.claudeAgents.hidden = !m.agents;
  setText(el.claudeAgents, m.agents || "");
  el.claudeTime.hidden = !s.time;
  setText(el.claudeTimeValue, s.time || "");

  const req = s.requestLine;
  el.claudeRequest.hidden = !req;
  el.claudeRequest.dataset.tone = req?.tone || "";
  setText(el.claudeRequest, req?.text || "");

  // The page: every message kept (this turn's and the recent ones), newest last. While
  // an approval waits, the page stays exactly as it was (CSS dims it while the moon
  // crosses) and the question takes its place.
  const approval = m.kind === "approval";
  const working = m.kind === "working";
  const entries = s.entries || [];
  const thisTurn = entries.some((e) => e.tone !== "past");
  const thinking = working && !thisTurn ? `<div class="msg" data-tone="latest"><p class="md-omitted">Thinking</p></div>` : "";
  const html = entries.map((e) => `<div class="msg" data-tone="${e.tone}">${lib.renderMarkdown(e.text, { code: "block" })}</div>`).join("") + thinking;
  const changed = el.claudeFlow.dataset.html !== html;
  setHtml(el.claudeFlow, html);

  el.claudeAsk.hidden = !approval;
  el.claudeCommand.hidden = !(approval && m.command);
  setText(el.claudeCommand, approval ? m.command || "" : "");
  el.claudeWhy.hidden = !(approval && s.says);
  setHtml(el.claudeWhy, approval && s.says ? lib.renderMarkdown(s.says, { code: "omit" }) : "");
  el.claudeNote.hidden = !approval;

  const f = pageFollow(el);
  if (s.newTurn) f.follow();
  f.update({ changed, finished: m.kind === "finished" });
}

/**
 * The scrolling page's behaviour (the native ClaudeScroll does the same): it follows
 * the latest words like a chat; the reader scrolling up stops that and shows "Jump to
 * latest"; scrolling back down to the latest (or the pill) resumes it. The thumb is
 * invisible at rest and shows while the reader scrolls or points near the right edge,
 * fading out 1 s later. Created once per page; returns the controller.
 */
/** The page's edge fade (styles.css .claude-scroll --fade-top). */
const FADE = 28;

export function pageFollow(el) {
  if (el.follow) return el.follow;
  const sc = el.claudeScroll, page = el.claudePage, thumb = el.claudeThumb, jump = el.claudeJump, flow = el.claudeFlow;
  const reduce = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const st = { following: true, finished: false, auto: false, jumping: false, near: false, drag: null, hideTimer: null };
  const metrics = () => ({ scrollTop: sc.scrollTop, scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight });
  // A finished reply taller than the page reads from its first line, just under the top
  // fade (the fade falls on the message before it).
  const latestTop = () => {
    if (!st.finished) return null;
    const last = flow.lastElementChild;
    return last && last.offsetHeight > sc.clientHeight ? Math.max(0, last.offsetTop - FADE) : null;
  };
  const target = () => lib.followTarget({ ...metrics(), latestTop: latestTop() });
  const setTop = (top) => {
    if (Math.abs(sc.scrollTop - top) < 0.5) return;
    st.auto = true;
    sc.scrollTop = top;
    requestAnimationFrame(() => (st.auto = false));
  };
  const hideSoon = () => {
    clearTimeout(st.hideTimer);
    st.hideTimer = setTimeout(() => {
      if (st.near || st.drag) return;
      thumb.dataset.show = "false";
    }, 1000);
  };
  const show = () => {
    if (!lib.scrollThumb(metrics())) return;
    thumb.dataset.show = "true";
    hideSoon();
  };
  const chrome = () => {
    const mt = metrics();
    const max = Math.max(0, mt.scrollHeight - mt.clientHeight);
    page.dataset.above = String(mt.scrollTop > 1);
    page.dataset.below = String(mt.scrollTop < max - 1);
    jump.hidden = st.following || max <= 1;
    const r = lib.scrollThumb(mt);
    if (!r) { thumb.dataset.show = "false"; thumb.style.height = "0px"; return; }
    thumb.style.height = `${r.height}px`;
    thumb.style.translate = `0 ${r.top}px`;
  };
  sc.addEventListener("scroll", () => {
    if (!st.auto) {
      const on = lib.isFollowing(sc.scrollTop, target());
      if (st.jumping) { if (on) st.jumping = false; }
      else st.following = on;
      if (!st.jumping) show();
    }
    chrome();
  }, { passive: true });
  // A wheel or trackpad flick at an end scrolls nothing but still shows where you are.
  sc.addEventListener("wheel", () => { st.jumping = false; show(); }, { passive: true });
  page.addEventListener("pointermove", (e) => {
    const r = page.getBoundingClientRect();
    const near = e.clientX >= r.right - 16;
    if (near && !st.near) { st.near = true; show(); }
    else if (!near && st.near) { st.near = false; hideSoon(); }
  });
  page.addEventListener("pointerleave", () => { st.near = false; hideSoon(); });
  thumb.addEventListener("pointerdown", (e) => {
    const mt = metrics(), r = lib.scrollThumb(mt);
    if (!r) return;
    e.preventDefault();
    thumb.setPointerCapture?.(e.pointerId);
    st.drag = { y: e.clientY, top: sc.scrollTop, ratio: (mt.scrollHeight - mt.clientHeight) / Math.max(1, mt.clientHeight - 12 - r.height) };
    thumb.dataset.drag = "true";
  });
  thumb.addEventListener("pointermove", (e) => {
    if (st.drag) sc.scrollTop = st.drag.top + (e.clientY - st.drag.y) * st.drag.ratio;
  });
  const endDrag = () => { if (!st.drag) return; st.drag = null; thumb.dataset.drag = "false"; hideSoon(); };
  thumb.addEventListener("pointerup", endDrag);
  thumb.addEventListener("pointercancel", endDrag);
  jump.addEventListener("click", () => ctl.jump());

  const ctl = {
    get following() { return st.following; },
    /** Follow the latest again (a new turn, or "Jump to latest"). */
    follow() { st.following = true; st.jumping = false; },
    jump() {
      st.following = true;
      const t = target();
      st.jumping = !reduce() && Math.abs(sc.scrollTop - t) >= 1;
      if (st.jumping && typeof sc.scrollTo === "function") sc.scrollTo({ top: t, behavior: "smooth" });
      else setTop(t);
      chrome();
      el.claudeScroll.focus?.({ preventScroll: true });
    },
    /** After a paint: new words scroll into view while following; otherwise the reader's place is kept. */
    update({ changed = false, finished = st.finished } = {}) {
      st.finished = !!finished;
      if (!page.offsetParent) return;
      if (changed && st.following) { st.jumping = false; setTop(target()); }
      chrome();
    },
    /** A new size: keep following (never pull a reader back above where they are reading). */
    relayout() {
      if (!page.offsetParent) return;
      if (st.following) setTop(Math.max(sc.scrollTop, target()));
      chrome();
    },
    state() { return { following: st.following, ...metrics(), target: target(), jump: !jump.hidden, above: page.dataset.above === "true", below: page.dataset.below === "true", thumb: thumb.dataset.show === "true" }; },
  };
  el.follow = ctl;
  return ctl;
}

/**
 * The footer's persona chip: the tuning's tiny string, the name and the voice.
 * `voiceDesc` (VOICE_INFO description) goes in the tooltip and the label.
 */
export function paintChip(el, { name, voice, wave, voiceDesc = "" }) {
  setText(el.chipName, name || "Sotto");
  setText(el.chipVoice, voice || "");
  if (wave && el.chipWave.getAttribute("d") !== wave) el.chipWave.setAttribute("d", wave);
  const title = voice && voiceDesc ? `${voice}: ${voiceDesc}` : "";
  if (el.chipVoice.title !== title) el.chipVoice.title = title;
  el.personaChip.setAttribute("aria-label", `Persona: ${name || "Sotto"}${voice ? `, voice ${voice}${voiceDesc ? ` (${voiceDesc})` : ""}` : ""}. Opens Settings`);
}

/**
 * The Settings voice picker (GET /api/voices): a <select> grouped by presentation
 * (<optgroup> Feminine, Masculine, Androgynous), each option saying what the voice
 * sounds like (lib.voiceGroups). Rebuilt only when the list or info changes.
 */
export function paintVoiceSelect(select, voices) {
  const groups = lib.voiceGroups(voices);
  const key = JSON.stringify(groups);
  if (select.dataset.groups !== key) {
    select.dataset.groups = key;
    select.replaceChildren(...groups.flatMap((g) => {
      const opts = g.items.map((it) => {
        const o = document.createElement("option");
        o.value = it.id;
        o.textContent = it.label;
        if (it.description) o.title = it.description;
        return o;
      });
      if (!g.title) return opts;
      const og = document.createElement("optgroup");
      og.label = g.title;
      og.append(...opts);
      return [og];
    }));
  }
  const cur = voices?.current;
  select.value = Array.isArray(voices?.voices) && voices.voices.includes(cur) ? cur : "";
}

/**
 * The Settings voice list for paintListPicker: groups by presentation, each row the
 * name over what the voice sounds like (tone · accent).
 */
export function voicePickerModel(voices) {
  return lib.voiceGroups(voices).map((g) => ({
    title: g.title,
    items: g.items.map((it) => ({ id: it.id, name: it.name, desc: it.tone ? it.label.slice(it.name.length + 3) : "", title: it.description })),
  }));
}

/**
 * The Settings persona list for paintListPicker (GET /api/personas): each row the
 * name over its description and voice; the button's second line is just the voice
 * (the help line under the picker has the full description).
 */
export function personaPickerModel(personas, label = (p) => p.name) {
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const list = Array.isArray(personas?.personas) ? personas.personas : [];
  return [{ title: "", items: list.map((p) => {
    const desc = String(p.description || "").replace(/\.$/, "");
    const voice = p.voice ? `${cap(p.voice)} voice` : "";
    return { id: p.id, name: label(p), desc: [desc, voice].filter(Boolean).join(" · "), short: voice, title: p.description || "" };
  }) }];
}

/**
 * A picker whose open list shows every option's description under its name while
 * you browse (a <select> can show one line only). `root` is an empty container: it
 * gets a button (the current option's name over its description, two fixed lines)
 * and a listbox popover laid over what follows, so opening it moves nothing.
 * Keyboard: Enter, Space or the arrows open it; Up/Down/Home/End move; Enter or
 * Space chooses; Escape or Tab closes. `m` = {groups:[{title, items:[{id, name,
 * desc, short?, title?}]}], value, disabled, label}; `short`, when set, is the button's line instead of `desc`. `onChoose(id)` runs for a new choice.
 */
export function paintListPicker(root, m, { onChoose = null } = {}) {
  let st = root._lp;
  if (!st) {
    st = root._lp = { open: false, active: null, onChoose };
    root.classList.add("lp");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lp-button";
    btn.id = `${root.id || "lp"}-button`;
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = '<span class="lp-text"><span class="lp-name"></span><span class="lp-desc"></span></span><span class="lp-chev" aria-hidden="true"></span>';
    const list = document.createElement("div");
    list.className = "lp-list";
    list.id = `${root.id || "lp"}-list`;
    list.setAttribute("role", "listbox");
    list.tabIndex = -1;
    list.hidden = true;
    btn.setAttribute("aria-controls", list.id);
    root.append(btn, list);
    st.btn = btn;
    st.list = list;
    const options = () => [...list.querySelectorAll('[role="option"]')];
    const setActive = (o) => {
      for (const x of options()) x.dataset.active = String(x === o);
      st.active = o || null;
      if (o) { list.setAttribute("aria-activedescendant", o.id); o.scrollIntoView({ block: "nearest" }); }
      else list.removeAttribute("aria-activedescendant");
    };
    const close = (focusBtn = true) => {
      if (!st.open) return;
      st.open = false;
      list.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", st.outside, true);
      if (focusBtn) btn.focus();
    };
    const open = () => {
      if (st.open || btn.disabled) return;
      st.open = true;
      list.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      // Below the button, or above it when the window has no room below.
      const r = btn.getBoundingClientRect();
      const h = Math.min(list.scrollHeight, 360);
      root.dataset.side = window.innerHeight - r.bottom < h + 12 && r.top > window.innerHeight - r.bottom ? "up" : "down";
      setActive(options().find((o) => o.getAttribute("aria-selected") === "true") || options()[0]);
      list.focus({ preventScroll: true });
      document.addEventListener("pointerdown", st.outside, true);
    };
    const choose = (o) => {
      if (!o) return;
      const id = o.dataset.id;
      close();
      if (id !== st.value && st.onChoose) st.onChoose(id);
    };
    st.outside = (e) => { if (!root.contains(e.target)) close(false); };
    st.close = close;
    btn.addEventListener("click", () => (st.open ? close() : open()));
    btn.addEventListener("keydown", (e) => {
      if (["ArrowDown", "ArrowUp"].includes(e.key)) { e.preventDefault(); open(); }
    });
    list.addEventListener("keydown", (e) => {
      const opts = options();
      const i = opts.indexOf(st.active);
      const go = (j) => { e.preventDefault(); setActive(opts[Math.max(0, Math.min(opts.length - 1, j))]); };
      if (e.key === "ArrowDown") go(i + 1);
      else if (e.key === "ArrowUp") go(i - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(opts.length - 1);
      else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(st.active); }
      // Escape closes the list, not the drawer around it.
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === "Tab") close(false);
    });
    list.addEventListener("click", (e) => choose(e.target.closest('[role="option"]')));
    list.addEventListener("pointermove", (e) => { const o = e.target.closest('[role="option"]'); if (o && o !== st.active) setActive(o); });
  }
  st.onChoose = onChoose || st.onChoose;
  st.value = m.value;
  const { btn, list } = st;
  const key = JSON.stringify(m.groups);
  if (list.dataset.groups !== key) {
    list.dataset.groups = key;
    let n = 0;
    list.replaceChildren(...m.groups.flatMap((g) => {
      const rows = g.items.map((it) => {
        const o = document.createElement("div");
        o.className = "lp-option";
        o.id = `${list.id}-${n++}`;
        o.setAttribute("role", "option");
        o.dataset.id = it.id;
        o.innerHTML = '<svg class="lp-check" aria-hidden="true"><use href="#i-check"/></svg><span class="lp-text"><span class="lp-name"></span><span class="lp-desc"></span></span>';
        o.querySelector(".lp-name").textContent = it.name;
        o.querySelector(".lp-desc").textContent = it.desc || "";
        if (it.title) o.title = it.title;
        return o;
      });
      if (!g.title) return rows;
      const h = document.createElement("div");
      h.className = "lp-group";
      h.setAttribute("role", "presentation");
      h.textContent = g.title;
      return [h, ...rows];
    }));
  }
  const all = m.groups.flatMap((g) => g.items);
  const cur = all.find((it) => it.id === m.value);
  for (const o of list.querySelectorAll('[role="option"]')) o.setAttribute("aria-selected", String(o.dataset.id === m.value));
  setText(btn.querySelector(".lp-name"), cur?.name || m.value || "");
  setText(btn.querySelector(".lp-desc"), cur?.short ?? cur?.desc ?? "");
  if (cur?.title) btn.title = cur.title; else btn.removeAttribute("title");
  if (m.label) { list.setAttribute("aria-label", m.label); btn.setAttribute("aria-label", `${m.label}: ${cur?.name || m.value || "none"}${cur?.desc ? `, ${cur.desc}` : ""}`); }
  btn.disabled = !!m.disabled;
  if (btn.disabled && st.open) st.close(false);
  return st;
}

/**
 * "Hear the voices": a heading per presentation group, then one play chip per voice
 * with its name and, under it, its tone in calm secondary text. Every chip reserves
 * two description lines (styles.css .chip-desc), so nothing moves as samples play.
 * `onPlay(id)` runs on a click. Returns the chips (state is set by the caller).
 */
export function paintVoiceGrid(grid, voices, { onPlay = null } = {}) {
  const groups = lib.voiceGroups(voices);
  const key = JSON.stringify(groups);
  if (grid.dataset.groups !== key) {
    grid.dataset.groups = key;
    grid.replaceChildren(...groups.flatMap((g) => {
      const chips = g.items.map((it) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "voice-chip";
        b.dataset.voice = it.id;
        // Play and stop both stay in the DOM and crossfade on data-state (styles.css).
        b.innerHTML = '<span class="chip-icons" aria-hidden="true"><svg class="chip-play"><use href="#i-play"/></svg><svg class="chip-stop"><use href="#i-stop"/></svg></span><span class="chip-text"><span class="chip-name"></span><span class="chip-desc"></span></span>';
        b.querySelector(".chip-name").textContent = it.name;
        b.querySelector(".chip-desc").textContent = it.tone;
        if (it.description) b.title = it.description;
        if (onPlay) b.addEventListener("click", () => onPlay(it.id));
        return b;
      });
      if (!g.title) return chips;
      const h = document.createElement("p");
      h.className = "voice-group";
      h.textContent = g.title;
      return [h, ...chips];
    }));
  }
  return [...grid.querySelectorAll(".voice-chip")];
}

/**
 * A notice on the caption line (styles.css .banners): its words (the whole text in a
 * tooltip when the line cuts it), "+N" when more wait, its one action and a dismiss. The
 * app's CaptionLine .banner, the same order. `b` = {text, level, action?:{label}}.
 */
export function paintBanner(container, b, { more = 0, enter = true, onAction = null, onDismiss = null } = {}) {
  const div = document.createElement("div");
  div.className = "banner";
  div.dataset.level = b.level || "info";
  div.dataset.enter = String(!!enter);
  div.setAttribute("role", b.level === "error" ? "alert" : "status");
  const text = document.createElement("span");
  text.className = "banner-text";
  text.textContent = b.text;
  text.title = b.text;
  div.append(text);
  if (more > 0) {
    const m = document.createElement("span");
    m.className = "banner-more";
    m.textContent = `+${more}`;
    m.title = `${more} more`;
    div.append(m);
  }
  if (b.action) {
    const act = document.createElement("button");
    act.type = "button";
    act.className = "btn banner-action";
    act.textContent = b.action.label;
    if (onAction) act.onclick = onAction;
    div.append(act);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "icon-btn";
  close.setAttribute("aria-label", "Dismiss");
  close.title = "Dismiss";
  close.innerHTML = '<svg aria-hidden="true"><use href="#i-close"/></svg>';
  if (onDismiss) close.onclick = onDismiss;
  div.append(close);
  container.replaceChildren(div);
  return div;
}

/**
 * The footer's device picker (the app's DevicePicker): a heading, "System default (name)"
 * first, every device, a check on the one in use, a live level on the microphone in use,
 * then "Sound settings…". `items` from lib.deviceMenu. Returns the level bar (or null).
 */
export function paintDevicePicker(container, { kind, items }, { onChoose = null, onSettings = null } = {}) {
  const input = kind === "audioinput";
  const head = document.createElement("div");
  head.className = "dev-head";
  head.setAttribute("role", "presentation");
  head.textContent = input ? "Microphone" : "Speaker";
  const rows = [head];
  let level = null;
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dev-item";
    b.setAttribute("role", "menuitemradio");
    b.setAttribute("aria-checked", String(!!it.checked));
    b.dataset.id = it.id;
    b.innerHTML = '<svg aria-hidden="true"><use href="#i-check"/></svg>';
    const name = document.createElement("span");
    name.className = "dev-name";
    name.textContent = it.label;
    name.title = it.label;
    b.append(name);
    if (input && it.checked) {
      const bar = document.createElement("span");
      bar.className = "dev-level";
      bar.setAttribute("aria-hidden", "true");
      level = document.createElement("i");
      bar.append(level);
      b.append(bar);
    }
    if (onChoose) b.onclick = () => onChoose(it.id);
    rows.push(b);
  }
  const sep = document.createElement("div");
  sep.className = "dev-sep";
  sep.setAttribute("role", "separator");
  const more = document.createElement("button");
  more.type = "button";
  more.className = "dev-item dev-more";
  more.setAttribute("role", "menuitem");
  more.textContent = "Sound settings…";
  if (onSettings) more.onclick = onSettings;
  rows.push(sep, more);
  container.setAttribute("aria-label", input ? "Microphones" : "Speakers");
  container.replaceChildren(...rows);
  return level;
}
