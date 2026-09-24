// Voice transcript model (SPEC §6.8): fragments, grouping into lines, rolling
// cross-session history, speech timestamps, and echo detection (echo.js, §6.8.1).
import { analyzeEcho, sessionReference, ECHO_WINDOW_MS } from "./echo.js";

const GAP_MS = 1500;
// A delegated request can span up to ~90 s of speech (delegation.js
// REQUEST_LOOKBACK_MS) interleaved with assistant fragments, so keep enough.
const MAX_FRAGMENTS = 1200;
const MAX_HISTORY = 60;
/** Speech kept for the echo filter without a shared timeline (earlier sessions, samples). */
const SPOKEN_KEEP_MS = 60000;

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
    // What was played aloud without a place on this session's timeline (§6.8.1):
    // the previous sessions' assistant speech, voice samples, the echo test.
    this.spoken = [];
  }

  /** Start a new Live session: session timelines restart at 0. */
  newSession() {
    this.history = [...this.history, ...this.lines().map((l) => ({ role: l.role, text: l.text.trim() }))].filter((l) => l.text).slice(-MAX_HISTORY);
    for (const f of this.fragments) if (f.role === "assistant") this.spoken.push({ text: f.text, at: f.at, source: "session" });
    this.pruneSpoken();
    this.fragments = [];
  }

  /** Something sotto plays aloud outside the Live session (a voice sample, the echo test). */
  addSpoken(text, source = "other") {
    if (typeof text !== "string" || !text.trim()) return;
    this.spoken.push({ text, at: this.clock.now(), source });
    this.pruneSpoken();
  }

  pruneSpoken() {
    const since = this.clock.now() - SPOKEN_KEEP_MS;
    this.spoken = this.spoken.filter((s) => s.at >= since).slice(-400);
  }

  /**
   * Echo filter for user fragments (one line or a whole request, §6.8.1):
   * compared with the assistant speech of this session around the same time
   * and with anything else played aloud recently.
   * @returns see echo.js analyzeEcho
   */
  filterEcho(frags) {
    const list = Array.isArray(frags) ? frags : [];
    const assistant = this.fragments.filter((f) => f.role === "assistant");
    const firstAt = Math.min(...list.map((f) => f.at || Infinity));
    const lastAt = Math.max(0, ...list.map((f) => f.at || 0));
    this.pruneSpoken();
    const ledger = this.spoken.filter((s) => s.at >= firstAt - ECHO_WINDOW_MS - 5000 && s.at <= lastAt + 3000);
    const r = analyzeEcho(list, { session: sessionReference(assistant, list), ledger });
    // The Live model transcribed its own voice (a time-aligned run): the
    // evidence the page's echo guard waits for in `auto` (§7.7).
    const self = r.runs.filter((x) => x.src === "session");
    if (self.length && this.onSelfEcho) {
      try { this.onSelfEcho({ words: self.reduce((n, x) => n + x.n, 0), delay_ms: self[0].delay_ms }); } catch { /* observer only */ }
    }
    return r;
  }

  /** Echo filter for a text without timing (the wake clip): recent speech by wall clock. */
  filterEchoText(text, atMs = this.clock.now(), windowMs = ECHO_WINDOW_MS + 5000) {
    const since = atMs - windowMs;
    this.pruneSpoken();
    const ledger = [
      ...this.spoken.filter((s) => s.at >= since),
      ...this.fragments.filter((f) => f.role === "assistant" && f.at >= since).map((f) => ({ text: f.text, at: f.at })),
    ];
    return analyzeEcho([{ text: String(text ?? ""), start_ms: 0, end_ms: 0, at: atMs, prefix: true }], { ledger }, { timed: false });
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
   * Echo check for a bare text (no timing): the text is an echo when, after
   * removing runs of ≥ 3 words that match (in order, allowing for ASR
   * spelling) the assistant speech of the `windowMs` before `atMs` (default
   * now), fewer than two meaningful words are left (§6.8.1).
   */
  isEcho(text, windowMs = 20000, atMs = this.clock.now()) {
    if (normalizeWords(text).length < 3) return false;
    const ref = this.assistantTextBefore(atMs, windowMs);
    const ledger = this.spoken.filter((s) => s.at >= atMs - windowMs && s.at <= atMs).map((s) => s.text).join(" ");
    const all = [ref, ledger].filter((x) => x.trim()).join(" ");
    if (!all.trim()) return false;
    return analyzeEcho([{ text, start_ms: 0, end_ms: 0 }], { ledger: [{ text: all, at: 0 }] }, { timed: false }).verdict === "echo";
  }
}
