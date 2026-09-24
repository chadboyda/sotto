// Voice transcript model (SPEC §6.8): fragments, grouping into lines, rolling
// cross-session history, speech timestamps, and echo detection.

const GAP_MS = 1500;
// A delegated request can span up to ~90 s of speech (delegation.js
// REQUEST_LOOKBACK_MS) interleaved with assistant fragments, so keep enough.
const MAX_FRAGMENTS = 1200;
const MAX_HISTORY = 60;

export function normalizeWords(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/'/g, "")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Join user fragments into one request text. A leading wake-clip fragment
 * (`prefix`, §6.15) usually overlaps the first words heard live ("Hey, can
 * you" + "Can you ask Claude …"): the repeated words at the seam are dropped.
 */
export function joinUserFragments(frags) {
  const list = Array.isArray(frags) ? frags : [];
  if (!list.length || !list[0].prefix) return list.map((f) => f.text).join("");
  const head = list[0].text.trim();
  const tail = list.slice(1).map((f) => f.text).join("").trim();
  if (!tail) return head;
  const hw = normalizeWords(head);
  const tokens = tail.split(/\s+/);
  const tw = tokens.map((t) => normalizeWords(t).join(""));
  for (let k = Math.min(6, hw.length, tw.length); k >= 1; k--) {
    if (hw.slice(-k).join(" ") === tw.slice(0, k).join(" ")) return `${head} ${tokens.slice(k).join(" ")}`.trim();
  }
  return `${head} ${tail}`;
}

/** Group fragments (same role, gap ≤ 1500 ms) into lines. */
export function groupFragments(fragments, gapMs = GAP_MS) {
  const lines = [];
  for (const f of fragments) {
    const last = lines[lines.length - 1];
    if (last && last.role === f.role && f.start_ms - last.end_ms <= gapMs) {
      last.text += f.text;
      last.end_ms = Math.max(last.end_ms, f.end_ms);
      last.at = f.at;
    } else {
      lines.push({ role: f.role, text: f.text, start_ms: f.start_ms, end_ms: f.end_ms, at: f.at });
    }
  }
  return lines;
}

export class Transcript {
  constructor({ clock }) {
    this.clock = clock;
    this.fragments = [];
    this.history = []; // finished lines from earlier Live sessions (plus current, on demand)
    this.lastUserSpeechAt = 0;
    this.lastAssistantSpeechAt = 0;
  }

  /** Start a new Live session: session timelines restart at 0. */
  newSession() {
    this.history = [...this.history, ...this.lines().map((l) => ({ role: l.role, text: l.text.trim() }))].filter((l) => l.text).slice(-MAX_HISTORY);
    this.fragments = [];
  }

  add(role, text, start_ms, end_ms) {
    if (typeof text !== "string" || !text) return;
    const at = this.clock.now();
    const s = Number(start_ms) || 0;
    const e = Number(end_ms) || s;
    this.fragments.push({ role, text, start_ms: s, end_ms: e, at });
    if (this.fragments.length > MAX_FRAGMENTS) this.fragments.splice(0, this.fragments.length - MAX_FRAGMENTS);
    if (role === "user") this.lastUserSpeechAt = at;
    else this.lastAssistantSpeechAt = at;
  }

  /**
   * Insert user words that were spoken before this Live session could hear
   * them (the wake clip, §6.15) at the start of the session's timeline, so
   * delegation text built from user fragments starts with them.
   */
  prepend(role, text) {
    if (typeof text !== "string" || !text.trim()) return;
    const at = this.clock.now();
    this.fragments.unshift({ role, text: text.trim() + " ", start_ms: 0, end_ms: 1, at, prefix: true });
    if (this.fragments.length > MAX_FRAGMENTS) this.fragments.splice(1, this.fragments.length - MAX_FRAGMENTS);
    if (role === "user") this.lastUserSpeechAt = at;
    else this.lastAssistantSpeechAt = at;
  }

  lines() {
    return groupFragments(this.fragments);
  }

  /** Rolling history across sessions + the current session, oldest first, trimmed text. */
  recentLines(n = 30) {
    const cur = this.lines().map((l) => ({ role: l.role, text: l.text.trim() })).filter((l) => l.text);
    return [...this.history, ...cur].slice(-n);
  }

  /** User fragments with end_ms > afterMs, in order. */
  userFragmentsAfter(afterMs) {
    return this.fragments.filter((f) => f.role === "user" && f.end_ms > afterMs);
  }

  /** The most recent assistant line (grouped), or null. */
  lastAssistantLine() {
    const lines = this.lines();
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].role === "assistant") return lines[i];
    return null;
  }

  /** Concatenated assistant text from fragments received within the last `windowMs`. */
  assistantTextSince(windowMs) {
    const since = this.clock.now() - windowMs;
    return this.fragments.filter((f) => f.role === "assistant" && f.at >= since).map((f) => f.text).join("");
  }

  /** Concatenated assistant text received in the `windowMs` before wall time `atMs`. */
  assistantTextBefore(atMs, windowMs) {
    return this.fragments.filter((f) => f.role === "assistant" && f.at >= atMs - windowMs && f.at <= atMs).map((f) => f.text).join("");
  }

  /**
   * Echo check: ≥ 3 words and ≥ 80 % of them appear, in order, inside the
   * assistant speech of the 20 s before `atMs` (default: now), as a
   * subsequence match. `atMs` lets an older line of a long request be checked
   * against what the assistant was saying when that line was heard.
   */
  isEcho(text, windowMs = 20000, atMs = this.clock.now()) {
    const words = normalizeWords(text);
    if (words.length < 3) return false;
    const ref = normalizeWords(this.assistantTextBefore(atMs, windowMs));
    if (!ref.length) return false;
    let j = 0;
    let matched = 0;
    for (const w of words) {
      let k = j;
      while (k < ref.length && ref[k] !== w) k++;
      if (k < ref.length) { matched++; j = k + 1; }
    }
    return matched / words.length >= 0.8;
  }
}
