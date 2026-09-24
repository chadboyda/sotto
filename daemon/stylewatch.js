// Style watch on the voice's own speech (SPEC §8.1 "How you talk"). Pure:
// time comes from the injected clock.
//
// The daemon cannot edit what gpt-live-1 says; it only sees the output
// transcript. Observed live: after every silent "background work finished"
// note, the voice volunteered it and closed with the same tag line ("No
// action for you.", 17 times in 30 minutes, once "No input needed from you."
// three times in one breath), and it opened reply after reply with "You're
// right, I did…". The prompt forbids both; this catches the model doing it
// anyway and sends one short corrective instruction, so the next turn changes.
//
// What counts, per utterance (output deltas split by a pause):
//  - repeat:  the same sentence, or the same run of 4+ words, twice in one utterance;
//  - tagline: a stock "nothing needed from you" line, or the same short closing
//             sentence as an earlier utterance;
//  - opener:  a banned opener (reflexive agreement or apology, "Update:", …),
//             or the same first two words as an earlier utterance.
// Each phrase is corrected once per session (stock tag lines are one family:
// "no action for you", "nothing for you to do" … share one correction, plus
// one reminder if they keep coming), at most one correction per
// CORRECTION_GAP_MS (later findings wait for the next utterance).
import { isTagline } from "./phrasing.js";

/** Output deltas this far apart (wall time) belong to different utterances. */
export const UTTERANCE_GAP_MS = 1500;
/** At most one correction per this long. */
export const CORRECTION_GAP_MS = 15000;
/** Earlier utterances are compared within this window. */
export const STYLE_WINDOW_MS = 30 * 60_000;
/** Utterances kept for comparison. */
export const STYLE_HISTORY_N = 40;
/** A stock tag line that keeps coming after its correction gets one reminder after this many more. */
export const STOCK_REMIND_AFTER = 3;

// Openers the prompt forbids: reflexive agreement, apology, or the old
// written-report frames. Matched on the start of an utterance.
export const BANNED_OPENERS = [
  /^you'?re (?:absolutely |totally |completely |quite |so )?right\b/i,
  /^(?:right|yeah|yes|okay|ok),? (?:that'?s|that is) (?:fair|true|right)\b/i,
  /^(?:that'?s|that is) (?:fair|a fair point|true)\b/i,
  /^fair (?:point|enough)\b/i,
  /^(?:sorry|i'?m sorry|i apologi[sz]e|apologies|my apologies|my bad)\b/i,
  /^(?:great|good|excellent) question\b/i,
  /^(?:certainly|absolutely|of course)\b/i,
  /^claude code'?s answer\b/i,
  /^update\s*:/i,
];
export const isBannedOpener = (text) => BANNED_OPENERS.some((re) => re.test(String(text || "").trim()));

const words = (s) => String(s || "").toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
const splitSentences = (t) => String(t || "").replace(/\s+/g, " ").trim().split(/(?<=[.!?…])\s+/).filter(Boolean);
// Function words alone don't make a repeated phrase ("and then it", "of the").
const LIGHT = new Set("a an the and or but so of to in on at by for with from as is are was were be it its it's this that i you we they he she my your our their just now then there here".split(" "));

/** A phrase said twice in one utterance, or null. */
export function repeatedPhrase(text) {
  const ss = splitSentences(text);
  const seen = new Set();
  for (const s of ss) {
    const k = words(s).join(" ");
    if (k.split(" ").length >= 3 && seen.has(k)) return s.replace(/[.!?…]+$/, "");
    if (k) seen.add(k);
  }
  const w = words(text);
  const N = 4;
  const at = new Map();
  for (let i = 0; i + N <= w.length; i++) {
    const g = w.slice(i, i + N);
    if (g.every((x) => LIGHT.has(x))) continue;
    const k = g.join(" ");
    const prev = at.get(k);
    if (prev !== undefined && i - prev >= N) return k;
    if (prev === undefined) at.set(k, i);
  }
  return null;
}

/** The last sentence as a comparison key ("Still no action for you." → "no action for you"). */
export function closingKey(text) {
  const ss = splitSentences(text);
  // A closing tag often rides on the last clause: "…, no action for you."
  const last = (ss[ss.length - 1] || "").split(/[,;—–]\s+/).pop();
  const w = words(last);
  while (w.length && /^(?:and|so|still|again|also|but|oh)$/.test(w[0])) w.shift();
  return w.length && w.length <= 8 ? w.join(" ") : "";
}

/** The first two words as a comparison key ("You're right, I did…" → "you're right"). */
export function openerKey(text) {
  const w = words(text);
  return w.length >= 5 ? w.slice(0, 2).join(" ") : "";
}

/**
 * Findings for one finished utterance against earlier ones (newest last).
 * @returns {{why: "repeat"|"tagline"|"opener", phrase: string}[]}
 */
export function findings(text, earlier = []) {
  const out = [];
  const rep = repeatedPhrase(text);
  if (rep) out.push({ why: "repeat", phrase: rep });
  const ss = splitSentences(text);
  const lastClause = (ss[ss.length - 1] || "").split(/[,;—–]\s+/).pop();
  const ck = closingKey(text);
  if (isTagline(lastClause) || ss.some((s) => isTagline(s))) {
    const tag = ss.find((s) => isTagline(s)) || lastClause;
    out.push({ why: "tagline", stock: true, phrase: tag.replace(/^(?:and|so|still|again|also|but)[, ]+/i, "").replace(/[.!…]+$/, "").trim() });
  } else if (ck && ck.split(" ").length >= 3 && earlier.some((e) => closingKey(e) === ck)) {
    out.push({ why: "tagline", phrase: ck });
  }
  const trimmed = String(text || "").trim();
  if (isBannedOpener(trimmed)) out.push({ why: "opener", phrase: trimmed.split(/[,.!?]/)[0].trim() });
  else {
    const ok = openerKey(text);
    if (ok && earlier.some((e) => openerKey(e) === ok)) out.push({ why: "opener", phrase: ok });
  }
  return out;
}

const q = (p) => `"${String(p).replace(/"/g, "'").slice(0, 80)}"`;

/** The corrective instruction for a finding (sent as a silent instructions append). */
export function correction({ why, phrase }) {
  const tail = "This is a note about your speaking style, not something the user said: don't answer it or mention it, just apply it from now on.";
  switch (why) {
    case "repeat":
      return `You said ${q(phrase)} more than once in one reply. Say each thing once. ${tail}`;
    case "tagline":
      return `You keep adding tag lines like ${q(phrase)}. Stop: never close an update with a reassurance, and if nothing is needed from the user, say nothing about it. Don't repeat a phrase you've already said this session. ${tail}`;
    case "opener":
    default:
      return `You started a reply with ${q(phrase)}. Don't open with reflexive agreement, apology or a stock phrase, and don't start two replies the same way: acknowledge feedback at most once per topic, then just answer or act. ${tail}`;
  }
}

export class StyleWatch {
  /**
   * @param {object} o
   * @param {object} o.clock
   * @param {(text: string, finding: object) => void} o.correct  send the correction
   * @param {object} [o.log]
   */
  constructor({ clock, correct, log }) {
    this.clock = clock;
    this.correct = correct;
    this.log = log || { info() {} };
    this.cur = null; // {text, lastAt}
    this.timer = null;
    this.history = []; // [{text, at}]
    this.corrected = new Set(); // "why:phrase" keys already corrected
    this.stockSince = 0; // stock tag lines said since their correction
    this.lastCorrectionAt = -Infinity;
    this.pending = []; // findings waiting for the correction gap
  }

  /** One output transcript delta. */
  onOutput(delta) {
    if (typeof delta !== "string" || !delta) return;
    const now = this.clock.now();
    if (this.cur && now - this.cur.lastAt > UTTERANCE_GAP_MS) this.finish();
    if (!this.cur) this.cur = { text: "", lastAt: now };
    this.cur.text += delta;
    this.cur.lastAt = now;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => { this.timer = null; this.finish(); }, UTTERANCE_GAP_MS);
  }

  /** The current utterance ended: check it, remember it, maybe correct. */
  finish() {
    if (this.timer) { this.clock.clearTimeout(this.timer); this.timer = null; }
    const u = this.cur;
    this.cur = null;
    if (!u || !u.text.trim()) return [];
    const now = this.clock.now();
    this.history = this.history.filter((h) => now - h.at <= STYLE_WINDOW_MS).slice(-STYLE_HISTORY_N);
    const found = findings(u.text, this.history.map((h) => h.text));
    this.history.push({ text: u.text.trim(), at: now });
    for (const f of found) {
      let key = f.stock ? "tagline:stock" : `${f.why}:${f.phrase.toLowerCase()}`;
      if (f.stock && this.corrected.has(key)) {
        if (++this.stockSince < STOCK_REMIND_AFTER) continue;
        key = "tagline:stock:reminder";
      }
      if (this.corrected.has(key) || this.pending.some((p) => p.key === key)) continue;
      this.pending.push({ ...f, key });
    }
    return this.flush(now);
  }

  /** Send the first pending correction if the gap allows. */
  flush(now = this.clock.now()) {
    if (!this.pending.length || now - this.lastCorrectionAt < CORRECTION_GAP_MS) return [];
    const f = this.pending.shift();
    this.corrected.add(f.key);
    this.lastCorrectionAt = now;
    this.log.info("style.correction", { why: f.why, phrase: f.phrase.slice(0, 80) });
    const text = correction(f);
    this.correct(text, f);
    return [f];
  }

  /** New conversation (voice off/on): forget what was said. Corrections are kept per session by the prompt. */
  reset() {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.cur = null;
    this.history = [];
    this.corrected.clear();
    this.stockSince = 0;
    this.pending = [];
    this.lastCorrectionAt = -Infinity;
  }
}
