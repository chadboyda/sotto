// The header's DOM helpers, shared by app.js and the layout tests
// (test/web/header.test.js), so the tests measure the code the page runs.

/**
 * Fill one usage pill from lib.usagePills (`v`: {text, wide} or null for "not
 * shown"). Only the figure's text changes while it ticks; the box resizes only
 * when `wide` flips (the hour). Returns true when the pill's size or presence
 * changed, the only time the header needs fitHeader() again.
 */
export function setPill(pill, v) {
  const shown = v ? "1" : "";
  let resized = (pill.dataset.shown || "") !== shown;
  pill.dataset.shown = shown;
  if (!v) {
    pill.hidden = true;
    return resized;
  }
  const fig = pill.querySelector(".pill-value");
  if (fig.textContent !== v.text) fig.textContent = v.text;
  if (fig.hasAttribute("data-wide") !== v.wide) {
    fig.toggleAttribute("data-wide", v.wide);
    resized = true;
  }
  return resized;
}

/**
 * Header items by priority (status word > money > session > today > detail > project):
 * when the row is short of room, whole items hide instead of being cut to "claude…"
 * and "$0.…". The money is never hidden or truncated. Everything is shown and then
 * hidden again in one synchronous pass, so nothing flickers; with fixed-width pills
 * the outcome only changes when a pill resizes or the window does.
 * `h`: {top, statusText, project, statusDetail, pills: [today, session]}.
 */
export function fitHeader(h) {
  const { top, statusText: text, project, statusDetail } = h;
  // Only the pills that have something to show take part (Session is hidden off-live).
  const items = h.pills.filter((it) => it.dataset.shown === "1");
  project.hidden = !project.textContent;
  statusDetail.hidden = !statusDetail.textContent;
  for (const it of items) it.hidden = false;
  // Too tight: the row overflows, the word or the detail is clipped, or the project
  // has ellipsized to a stub (under ~6 characters) that no longer names anything.
  const over = () =>
    top.scrollWidth > top.clientWidth ||
    text.scrollWidth > text.clientWidth + 0.5 ||
    (!project.hidden && project.scrollWidth > project.clientWidth + 0.5 && project.clientWidth < 56);
  if (!over()) return;
  project.hidden = true;
  if (!over()) return;
  statusDetail.hidden = true;
  for (const it of items) {
    if (!over()) return;
    it.hidden = true;
  }
}
