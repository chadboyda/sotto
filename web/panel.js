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
 * line, and the page (Claude's own words as rendered markdown) or the question.
 * @param {object} el  the elements (see app.js `el`)
 * @param {{m:object, head:object, history:string[], says:string, summary:string|null,
 *          expanded:boolean, time:string|null, requestLine:{text:string,tone:string}|null}} s
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

  // The page. While an approval waits, the working page stays exactly as it was (CSS
  // dims it while the moon crosses) and the question takes its place.
  const approval = m.kind === "approval";
  const working = m.kind === "working";
  const finished = m.kind === "finished";
  setHtml(el.claudeHistory, (working || approval || finished ? s.history : []).map(msg).join(""));
  const stepMd = working || approval ? s.says || "" : "";
  el.claudeStep.hidden = !(working || approval) || (!stepMd && !working);
  setHtml(el.claudeStep, stepMd ? msg(stepMd) : working ? `<div class="msg"><p class="md-omitted">Thinking</p></div>` : "");
  el.summary.hidden = !finished;
  setHtml(el.summary, finished ? lib.renderMarkdown(s.summary || "", { code: s.expanded ? "block" : "omit" }) : "");
  el.claude.dataset.expanded = String(!!s.expanded && finished);

  el.claudeAsk.hidden = !approval;
  el.claudeCommand.hidden = !(approval && m.command);
  setText(el.claudeCommand, approval ? m.command || "" : "");
  el.claudeWhy.hidden = !(approval && s.says);
  setHtml(el.claudeWhy, approval && s.says ? lib.renderMarkdown(s.says, { code: "omit" }) : "");
  el.claudeNote.hidden = !approval;
  fitPage(el, m.kind, !!s.expanded);
}

/**
 * The page is a fixed box: when the flow is taller, it slides up under a top fade so
 * the newest words stay in view (a finished summary shows from its first line), and
 * "More" opens the rest in place. Never a scroller over live text.
 */
export function fitPage(el, kind, expanded) {
  const page = el.claudePage;
  const flow = el.claudeFlow;
  if (!page.offsetParent) return;
  const finished = kind === "finished";
  if (expanded && finished) {
    flow.style.translate = "";
    page.dataset.clipped = "false";
    el.moreBtn.hidden = false;
    setText(el.moreBtn, "Less");
    el.moreBtn.setAttribute("aria-expanded", "true");
    return;
  }
  el.moreBtn.hidden = true;
  const P = page.clientHeight;
  let H = flow.offsetHeight;
  let shift = Math.max(0, H - P);
  if (finished) {
    shift = Math.max(0, Math.min(shift, el.summary.offsetTop));
    // More: the summary runs past the page, or a code block is folded away.
    const more = H - shift > P + 1 || !!el.summary.querySelector(".md-omitted");
    if (more) {
      el.moreBtn.hidden = false;
      setText(el.moreBtn, "More");
      el.moreBtn.setAttribute("aria-expanded", "false");
      H = flow.offsetHeight;
      shift = Math.max(0, Math.min(Math.max(0, H - P), el.summary.offsetTop));
    }
  }
  flow.style.translate = shift ? `0 ${-Math.round(shift)}px` : "";
  page.dataset.clipped = String(shift > 0);
}

/** The footer's persona chip: the tuning's tiny string, the name and the voice. */
export function paintChip(el, { name, voice, wave }) {
  setText(el.chipName, name || "Sotto");
  setText(el.chipVoice, voice || "");
  if (wave && el.chipWave.getAttribute("d") !== wave) el.chipWave.setAttribute("d", wave);
  el.personaChip.setAttribute("aria-label", `Persona: ${name || "Sotto"}${voice ? `, voice ${voice}` : ""}. Opens Settings`);
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
