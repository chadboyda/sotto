// "What did I miss?" (SPEC §6.15 "Recap"). Pure, clock-free.
//
// The voice sleeps between updates and every wake is a new Live session, so
// the model alone cannot list what it told the user an hour ago. The daemon
// keeps the last RECAP_MAX updates spoken in the owner session (Claude's own
// words, with the time each was said), hands them to every new session as
// background, and answers a spoken "what did I miss?" itself if the voice
// does not (the mic-check pattern, §6.18).
import { clip } from "./speech.js";
import { RELAY_MARK, materialOf } from "./phrasing.js";

export const RECAP_MAX = 20;
/** The voice gets this long to answer a recap request before the daemon gives it the recap to say. */
export const RECAP_ANSWER_MS = 4_000;

const RECAP = /\b(?:what (?:did|have) i miss(?:ed)?|what i missed|what(?:'s| has) happened(?: while i was (?:away|gone|out))?|catch me up|fill me in|any (?:news|updates)|anything new|what'?s new|recap|while i was (?:away|gone|out))\b/;

/** Is this line the user asking for a recap of recent updates? */
export function isRecapRequest(text) {
  const t = String(text || "").toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.split(" ").length > 14) return false;
  return RECAP.test(t);
}

/** Time of day as the voice says it ("4:43 PM"), in the daemon's local time zone. */
export function clockTime(at) {
  const d = new Date(at);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

/** The last RECAP_MAX updates said to the user, newest last. */
export class UpdateLog {
  constructor(max = RECAP_MAX) { this.max = max; this.items = []; }
  /** A spoken update: the commentary sent to the voice (its relay frame is dropped). */
  add(content, at, source = null) {
    const text = clip(materialOf(content).replace(/\s+/g, " ").trim(), 300);
    if (!text) return;
    const last = this.items.at(-1);
    if (last && last.text === text) { last.at = at; return; }
    this.items.push({ text, at, source });
    if (this.items.length > this.max) this.items.shift();
  }
  recent(n = this.max) { return this.items.slice(-n); }
  clear() { this.items = []; }
  get size() { return this.items.length; }
}

/** Background for a new session's seed: what the user was already told, with times. */
export function recapSeedLine(items) {
  if (!items.length) return null;
  const list = items.map((it) => `[${clockTime(it.at)}] ${it.text}`).join(" | ");
  return `Updates already told to the user, oldest first (for "what did I miss?"; do not repeat them unprompted): ${list}`;
}

/** The commentary that makes the voice give a recap (or say there is nothing new). */
export function recapCommentary(items, { since = 0 } = {}) {
  const fresh = items.filter((it) => it.at >= since);
  const use = (fresh.length ? fresh : items).slice(-6);
  if (!use.length) return "The user asked what they missed. Nothing new has come in from Claude: say so in a few words, in your persona's own voice.";
  const list = use.map((it) => `[${clockTime(it.at)}] ${it.text}`).join("\n");
  return "The user asked what they missed. Give a short recap of these updates, newest last, in one to three sentences in your own words and your persona's voice; say roughly when only if it helps. Don't read the times or any formatting aloud.\n" +
    `${RELAY_MARK}${list}`;
}
