// Watches (SPEC §6.15 "Watches"). Pure, clock-injected.
//
// "Tell me when the deploy finishes": Claude registers a watch (the
// mcp__sotto__watch tool, or `sotto watch` in Bash). A watch fires once,
// when Claude says it happened (op "done"), or when a later turn's result
// names it and says it finished; its update is then spoken under every
// speaking policy, quiet included, waking a sleeping voice, and the watch is
// cleared.
import { clip } from "./speech.js";

export const MAX_WATCHES = 10;
/** A watch nobody fired is dropped after this long. */
export const WATCH_TTL_MS = 12 * 60 * 60_000;

// Words that say what to do, not what to watch for: never keywords.
const STOP = new Set(("a an the this that these those it its is are was were be been being to of for in on at by with from and or but " +
  "me my i you your we our us tell let know when once after as soon until whenever if please can could would will should " +
  "finish finishes finished finishing done complete completes completed completion ready happen happens happened " +
  "notify ping alert say speak update watch wait up out back get gets got goes going").split(" "));
// A result that names a watch fires it only if it also says the thing ended.
const ENDED = /\b(?:finish(?:ed|es)?|done|complete[ds]?|completed|succeed(?:ed|s)?|success(?:ful(?:ly)?)?|pass(?:ed|es)?|fail(?:ed|s|ure)?|merged|deployed|shipped|released|published|up and running|(?:is|are) (?:up|live|ready|out)|ready|error(?:ed)?|crashed|timed out|exit(?:ed)? (?:with )?(?:code|0)|landed|went (?:out|live)|over)\b/i;

const stem = (w) => w.replace(/(?:ing|ed|es|s)$/, "") || w;
const words = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9 -]+/g, " ").split(/[\s-]+/).filter(Boolean);

/** Keywords for a watch: the ones Claude gave, else the description's content words. */
export function watchKeywords(description, keywords = null) {
  const given = Array.isArray(keywords) ? keywords.flatMap(words).filter((w) => !STOP.has(w)) : [];
  const ks = given.length ? given : words(description).filter((w) => !STOP.has(w) && w.length > 1);
  return [...new Set(ks.map(stem))].slice(0, 4);
}

export class Watches {
  constructor({ clock }) { this.clock = clock; this.list = []; this.seq = 0; }

  /**
   * Register a watch. `duringTurn`: Claude is mid-turn (it is that turn that
   * sets the watch), so that turn's own result ("I'll tell you when the deploy
   * finishes") never fires it. → the watch, or null when the description is empty.
   */
  add({ description, keywords = null, duringTurn = false } = {}) {
    const d = clip(String(description || "").replace(/\s+/g, " ").trim(), 160);
    if (!d) return null;
    this.prune();
    const same = this.list.find((w) => w.description.toLowerCase() === d.toLowerCase());
    if (same) return same;
    const w = { id: `w${++this.seq}`, description: d, keywords: watchKeywords(d, keywords), at: this.clock.now(), skipNext: !!duringTurn };
    this.list.push(w);
    if (this.list.length > MAX_WATCHES) this.list.shift();
    return w;
  }

  /** The watch `idOrText` names (an id, or a description that matches). */
  find(idOrText) {
    const q = String(idOrText || "").trim().toLowerCase();
    if (!q) return this.list.length === 1 ? this.list[0] : null;
    return this.list.find((w) => w.id === q) || this.list.find((w) => w.description.toLowerCase() === q)
      || this.list.find((w) => w.description.toLowerCase().includes(q)) || null;
  }

  remove(w) { this.list = this.list.filter((x) => x !== w); }
  clear() { const n = this.list.length; this.list = []; return n; }
  active() { this.prune(); return this.list.map((w) => ({ id: w.id, description: w.description, since: w.at })); }

  /**
   * The first watch a turn's result reports: every keyword is in it and it
   * says the thing ended. A watch set during a turn skips that turn's result.
   */
  match(text) {
    const t = String(text || "");
    if (!t || !ENDED.test(t)) return null;
    const have = new Set(words(t).map(stem));
    for (const w of this.list) {
      if (w.skipNext) continue;
      if (w.keywords.length && w.keywords.every((k) => have.has(k))) return w;
    }
    return null;
  }

  /** A main-thread turn ended (after its result was matched): watches set during it are armed. */
  turnEnded() { for (const w of this.list) w.skipNext = false; }

  prune() {
    const now = this.clock.now();
    this.list = this.list.filter((w) => now - w.at <= WATCH_TTL_MS);
  }
}
