// Spoken-append queue (SPEC §6.10.2). Pure: time comes from the injected clock.
//
// A `session.commentary.append` makes the Live model speak about 0.6 s later,
// and it cuts off whatever the model is saying at that moment. Observed live:
// an answer to a voice request was cut off 3 s in by the "Claude Code
// finished" summary of an unrelated turn. So every commentary goes through
// this queue:
//  - while the assistant is speaking (output transcript deltas, timed by their
//    session-timeline end_ms, plus a short hangover), commentary is held;
//  - held items are released one at a time, highest priority first, each after
//    the previous one has been spoken (a pre-roll covers the gap between the
//    append and the first output delta);
//  - only `urgent` items (a question or an approval Claude is blocked on) may
//    go out while the assistant is still talking, and even they wait for a
//    sentence boundary, for at most URGENT_WAIT_MS;
//  - low/normal items held longer than HOLD_MAX_MS are demoted to silent
//    thinking (the voice can still answer "what happened?" from them);
//  - answers to voice requests are never demoted (that would lose the answer
//    the user asked for): after HOLD_MAX_MS they go out at the next boundary.
// Thinking and instructions appends never pass through here (they are silent).
//
// Session swaps (voice switch, reconnect, expiry): the queue is suspended while
// no Live session is open, so held items wait for the replacement instead of
// falling into pendingResult (where the seed would hand them to the new session
// AND the queue would lose all but the last). The commentary sent last is
// carried over only if no output speech followed it (the user never heard it).
// Anything already spoken (output speech observed after its append) is never
// queued again: observed live, a replacement session re-spoke the last update.

import { firstSentences } from "./speech.js";

export const PRIORITY = Object.freeze({ low: 1, normal: 2, high: 3 });

/** How long after the last output delta the assistant still counts as speaking. */
export const SPEAK_HANGOVER_MS = 1200;
/** After sending a commentary, assume speech starts within this long. */
export const COMMENTARY_PREROLL_MS = 2500;
/** Held longer than this: low/normal → thinking; answers go out anyway. */
export const HOLD_MAX_MS = 20000;
/** An urgent item waits at most this long for a sentence boundary. */
export const URGENT_WAIT_MS = 3000;
export const PUMP_MS = 250;
/** Around a session swap, a commentary whose text was spoken this recently is not queued again. */
export const DEDUPE_MS = 120000;
/** "Around a swap": while suspended and this long after resume. Outside it a
 *  repeated text is a new event (a second approval prompt) and is spoken. */
export const SWAP_WINDOW_MS = 20000;
/** At a session swap, the last commentary is carried if sent this recently and never heard. */
export const CARRY_MS = 30000;

/** Content key for de-duplication: case and whitespace do not matter. */
export const speechKey = (content) => String(content ?? "").toLowerCase().replace(/\s+/g, " ").trim();

// ---- repeat detection ------------------------------------------------------------------
// Observed live: an answer was held in this queue while the voice talked; the
// voice meanwhile spoke it from the silent full reply ("The pills never made
// it into the native app… it ships as 0.3.2"), then the released commentary
// made it say it again ("Short version: the native app gets those same three
// pills…"). Also a mirror reply that restated the voice answer spoken 10 s
// before. Exact text keys cannot catch a paraphrase, so a commentary is also
// compared, by content words, with what was said recently (our commentaries
// and the voice's own output transcript).

/** How many recent spoken items (commentaries and voice utterances) are kept. */
export const RECENT_SPOKEN_N = 8;
/** A commentary is compared with what was said this recently. */
export const REPEAT_WINDOW_MS = 60000;
/** Share of a commentary's lead words already said that makes it a repeat. */
export const REPEAT_SIMILARITY = 0.55;
/** Lower bar for what the voice said after the item was queued: it can only
 *  have known that from the item's own silent context (measured: the voice's
 *  paraphrase of a held answer covered 47% of its lead words; unrelated
 *  replies on the same topic scored 18-20%). */
export const REPEAT_SIMILARITY_SINCE = 0.4;
/** Fewer content words than this: too short to judge (never a repeat). */
export const REPEAT_MIN_WORDS = 6;
// Spoken leads that carry no content ("Claude Code's answer: …").
const LEADS = /^(?:claude code's answer|claude code, on what you just said|claude code finished|background work finished|update on your earlier request(?: "[^"]*")?|result for your earlier request(?: "[^"]*")?|still working|short version)\s*:\s*/i;
const STOP = new Set(("a an the and or but so of to in on at by for with from as is are was were be been being it its it's this that that's these those there " +
  "here i i'm i've i'll i'd me my you you're you'll you've you'd your we we'll we've we're our they their he she his her them us not no yes yeah ok okay just now right still also too " +
  "very really will would can could should do does did done have has had got get gets getting going gone go about into over up out than then " +
  "what which who how why when where all any some one more most much many like well sure agreed exactly already being built change changes " +
  "claude code voice thing things bit quick short version update next say says said").split(" "));

/** Content words of a text: lower case, no punctuation, no filler, plural/-ing folded. */
export function contentWords(text) {
  const out = new Set();
  for (let w of String(text || "").toLowerCase().replace(/[’']/g, "'").split(/[^a-z0-9.']+/)) {
    w = w.replace(/^[.']+|[.']+$/g, "");
    if (!w || STOP.has(w) || (w.length < 3 && !/\d/.test(w))) continue;
    w = w.replace(/'s$/, "").replace(/(?<=\w{3})(?:ing|ed|es|s)$/, "");
    if (w && !STOP.has(w)) out.add(w);
  }
  return out;
}

/** The part of a commentary the voice actually says: its lead sentences, without the "Claude Code's answer:" frame. */
export function spokenLead(content) {
  return firstSentences(String(content || "").replace(LEADS, ""), 3).slice(0, 400);
}

/** Share of `text`'s content words (its spoken lead) found in `said` (a Set). */
export function repeatScore(text, said) {
  const w = contentWords(spokenLead(text));
  if (w.size < REPEAT_MIN_WORDS) return 0;
  let hit = 0;
  for (const x of w) {
    if (said.has(x)) hit++;
    else if (/\d/.test(x)) return 0; // a number not said yet is news ("3 files", "version 0.3.2")
  }
  return hit / w.size;
}

// Informational sources that may be dropped as a repeat. Questions, approvals
// and notices are never: saying those twice is a new event.
const REPEATABLE = new Set(["voice_result", "typed_result", "other_result", "mirror_result", "background_voice", "background_result",
  "progress_text", "completion", "agents_done", "idle", "tool_failure", "stale_result"]);

// Sources whose commentary is an answer or something the user must act on.
// An approval reminder (SPEC §6.10.4) ranks with them but waits for silence.
const HIGH = new Set(["voice_result", "background_voice", "question", "permission", "attention", "voice_notice", "approval_reminder"]);
const URGENT = new Set(["question", "permission", "attention"]);
const LOW = new Set(["typed_result", "background_result", "progress_text", "completion", "idle", "tool_failure", "tool_milestone"]);

/** Priority of a commentary by its routing source (unknown sources are normal). */
export function priorityOf(source) {
  if (HIGH.has(source)) return PRIORITY.high;
  if (LOW.has(source)) return PRIORITY.low;
  return PRIORITY.normal;
}
export const isUrgent = (source) => URGENT.has(source);

const BOUNDARY = /[.!?…:;]["'”’)\]]*\s*$/;

export class SpeechQueue {
  /**
   * @param {object} o
   * @param {object} o.clock
   * @param {(action) => void} o.send     release one commentary action
   * @param {(action) => void} o.demote   turn a held action into silent context
   * @param {() => number|null} [o.audioAt] wall time of the last output audio
   *   chunk. Optional and NOT wired in voice.js: gpt-live-1 streams output
   *   audio continuously, silence included (measured), so it cannot tell speech.
   * @param {object} [o.log]
   */
  constructor({ clock, send, demote, audioAt, log }) {
    Object.assign(this, { clock, send, demote, audioAt: audioAt || (() => null), log: log || { info() {}, debug() {} } });
    this.items = [];
    this.seq = 0;
    this.timer = null;
    this.speakingUntil = 0; // from output transcript timing
    this.prerollUntil = 0; // after our own commentary append
    this.burst = null; // {wall, startMs}: first delta of the current utterance
    this.tail = ""; // last output text, for sentence boundaries
    this.paused = false; // suspended between Live sessions (swap)
    this.lastSent = null; // {action, key, priority, urgent, at, heard}
    this.spoken = new Map(); // key → wall time its speech was observed
    this.resumedAt = -Infinity; // end of the last swap
    this.recent = []; // [{kind: "commentary"|"voice", text, at, lastAt}] newest last
  }

  /** Remember something that was said (for repeat detection). */
  remember(kind, text, now) {
    this.recent.push({ kind, text: String(text || ""), at: now, lastAt: now });
    while (this.recent.length > RECENT_SPOKEN_N) this.recent.shift();
  }

  /**
   * Is this queued item a paraphrase of something already said? Compared with
   * our recent commentaries and the voice's recent utterances. An answer the
   * user asked for (voice_result) is compared with voice speech only after the
   * answer arrived: before that the voice could not know it, and its "I'll ask
   * Claude whether the tests pass" must not swallow "The tests pass."
   */
  isRepeat(item, now = this.clock.now()) {
    const source = item.action.source;
    if (!REPEATABLE.has(source) || item.urgent) return false;
    const said = new Set(); // everything said in the window (voice speech before an answer arrived excluded)
    const since = new Set(); // what the voice said after this item was queued
    for (const r of this.recent) {
      if (now - r.lastAt > REPEAT_WINDOW_MS) continue;
      const after = r.kind === "voice" && r.lastAt >= item.at;
      if (r.kind === "voice" && source === "voice_result" && !after) continue;
      for (const w of contentWords(r.text)) { said.add(w); if (after) since.add(w); }
    }
    if (!said.size) return false;
    return repeatScore(item.action.content, said) >= REPEAT_SIMILARITY || (since.size > 0 && repeatScore(item.action.content, since) >= REPEAT_SIMILARITY_SINCE);
  }

  /** Output transcript delta from the Live session (the assistant is talking). */
  onOutput(delta, startMs, endMs) {
    const now = this.clock.now();
    const fresh = !this.burst || now > this.speakingUntil;
    if (fresh) this.burst = Number.isFinite(startMs) ? { wall: now, startMs } : null;
    if (typeof delta === "string" && delta) {
      const last = this.recent[this.recent.length - 1];
      if (!fresh && last && last.kind === "voice") { last.text += delta; last.lastAt = now; }
      else this.remember("voice", delta, now);
    }
    let until = now + SPEAK_HANGOVER_MS;
    // The transcript may run ahead of playback: end_ms on the session timeline,
    // measured from the burst's first delta, says when this audio ends.
    if (this.burst && Number.isFinite(endMs) && endMs >= this.burst.startMs) {
      until = Math.max(until, this.burst.wall + (endMs - this.burst.startMs) + SPEAK_HANGOVER_MS);
    }
    this.speakingUntil = Math.max(this.speakingUntil, until);
    this.prerollUntil = 0; // speech has started: the delta timing takes over
    // Output after our last commentary: the user heard (at least the start of) it.
    if (this.lastSent && !this.lastSent.heard) {
      this.lastSent.heard = true;
      this.spoken.set(this.lastSent.key, now);
    }
    if (typeof delta === "string" && delta) this.tail = (this.tail + delta).slice(-200);
    this.schedule();
  }

  isSpeaking(now = this.clock.now()) {
    const a = this.audioAt();
    if (Number.isFinite(a) && now - a < SPEAK_HANGOVER_MS) return true;
    return now < this.speakingUntil || now < this.prerollUntil;
  }

  atBoundary() { return BOUNDARY.test(this.tail); }

  get size() { return this.items.length; }

  /** True when this text was spoken within DEDUPE_MS. */
  wasSpoken(content, now = this.clock.now()) {
    const at = this.spoken.get(speechKey(content));
    return at != null && now - at < DEDUPE_MS;
  }

  /**
   * Why an item with this content must not be queued, or null: an identical
   * item is already waiting, was just sent (in flight), or was spoken recently.
   */
  duplicateOf(key, now) {
    if (!key) return null;
    if (this.items.some((it) => it.key === key)) return "queued";
    if (!this.paused && !(now - this.resumedAt < SWAP_WINDOW_MS)) return null;
    if (this.lastSent && this.lastSent.key === key && !this.lastSent.heard && now - this.lastSent.at < CARRY_MS) return "in_flight";
    const at = this.spoken.get(key);
    if (at != null && now - at < DEDUPE_MS) return "spoken";
    return null;
  }

  /**
   * Queue one commentary action ({kind, content, delegationId, source,
   * priority?, urgent?, dedupeKey?}). `dedupeKey` replaces the text key: an
   * approval prompt is keyed by its approval, so a second prompt with the same
   * words is still spoken (SPEC §6.10.4).
   */
  enqueue(action) {
    const now = this.clock.now();
    const key = action.dedupeKey ? `k:${action.dedupeKey}` : speechKey(action.content);
    const dup = this.duplicateOf(key, now);
    if (dup) {
      this.log.info("speech.duplicate", { source: action.source || null, why: dup });
      return;
    }
    const priority = action.priority ?? priorityOf(action.source);
    const urgent = action.urgent ?? isUrgent(action.source);
    this.items.push({ action, key, priority, urgent, at: now, seq: this.seq++ });
    this.pump();
  }

  /**
   * No Live session until resume(): hold everything. The last commentary goes
   * back to the front of the queue if no speech followed it (the closing
   * session never said it). Speaking state belongs to the old session.
   */
  suspend() {
    const now = this.clock.now();
    this.clearTimer();
    this.paused = true;
    const last = this.lastSent;
    this.lastSent = null;
    if (last && !last.heard && now - last.at < CARRY_MS && !this.items.some((it) => it.key === last.key)) {
      this.items.push({ action: last.action, key: last.key, priority: last.priority, urgent: last.urgent, at: now, seq: -1 - this.seq++ });
      this.log.info("speech.carried", { source: last.action.source || null, sent_ms_ago: now - last.at });
    }
    this.speakingUntil = 0;
    this.prerollUntil = 0;
    this.burst = null;
    this.tail = "";
  }

  /**
   * A session is ready again. `prerollMs`: something (the greeting) was just
   * sent and will be spoken first, so held items wait for it.
   */
  resume({ prerollMs = 0 } = {}) {
    if (!this.paused) return;
    this.paused = false;
    const now = this.clock.now();
    this.resumedAt = now;
    // Hold times restart: waiting for a session is not waiting for silence.
    for (const it of this.items) it.at = now;
    if (prerollMs > 0) this.prerollUntil = now + prerollMs;
    this.pump();
  }

  /** Release what may be released now; re-arm the poll timer while items wait. */
  pump() {
    this.clearTimer();
    if (this.paused) return;
    const now = this.clock.now();
    for (const [k, at] of this.spoken) if (now - at >= DEDUPE_MS) this.spoken.delete(k);
    // Demote stale low/normal items first (answers and urgent items never are).
    for (const it of [...this.items]) {
      if (it.priority < PRIORITY.high && !it.urgent && now - it.at >= HOLD_MAX_MS) {
        this.items.splice(this.items.indexOf(it), 1);
        this.log.info("speech.demoted", { source: it.action.source || null, held_ms: now - it.at });
        this.demote(it.action);
      }
    }
    if (!this.items.length) return;
    this.items.sort((a, b) => b.priority - a.priority || (b.urgent - a.urgent) || a.seq - b.seq);
    // Checked at release, not only at enqueue: while an item waits, the voice
    // may already say the same thing from the silent context that came with it.
    while (this.items.length && this.isRepeat(this.items[0], now)) this.dropRepeat(this.items.shift());
    if (!this.items.length) return;
    const head = this.items[0];
    const speaking = this.isSpeaking(now);
    let go = !speaking;
    if (!go && head.urgent) go = this.atBoundary() || now - head.at >= URGENT_WAIT_MS;
    if (!go && head.priority >= PRIORITY.high && now - head.at >= HOLD_MAX_MS) go = this.atBoundary() || now - head.at >= HOLD_MAX_MS + URGENT_WAIT_MS;
    if (go) {
      this.items.shift();
      if (speaking) this.log.info("speech.cut_in", { source: head.action.source || null, held_ms: now - head.at });
      else if (now > head.at) this.log.info("speech.released", { source: head.action.source || null, held_ms: now - head.at });
      this.prerollUntil = now + COMMENTARY_PREROLL_MS;
      this.tail = "";
      this.lastSent = { action: head.action, key: head.key, priority: head.priority, urgent: head.urgent, at: now, heard: false };
      this.remember("commentary", head.action.content, now);
      this.send(head.action);
    }
    this.schedule();
  }

  /**
   * Drop held items that are no longer true (an approval answered before the
   * voice got to say it). Returns how many were dropped.
   */
  cancel(pred) {
    const before = this.items.length;
    this.items = this.items.filter((it) => !pred(it.action));
    const n = before - this.items.length;
    if (n) this.log.info("speech.cancelled", { count: n });
    return n;
  }

  /** A repeat is not spoken; it goes to the voice model as silent context. */
  dropRepeat(it) {
    this.log.info("speech.duplicate", { source: it.action.source || null, why: "similar" });
    this.demote({ ...it.action, delegationId: null });
  }

  schedule() {
    if (this.timer || !this.items.length || this.paused) return;
    this.timer = this.clock.setTimeout(() => { this.timer = null; this.pump(); }, PUMP_MS);
  }

  clearTimer() {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  /** Remove and return every held action (session closing). */
  drain() {
    this.clearTimer();
    const out = this.items.sort((a, b) => a.seq - b.seq).map((it) => it.action);
    this.items = [];
    this.speakingUntil = 0;
    this.prerollUntil = 0;
    this.burst = null;
    this.tail = "";
    this.paused = false;
    this.lastSent = null;
    return out;
  }
}
