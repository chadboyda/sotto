// Transcript mirror (SPEC §6.18): user speech the Live model did not delegate
// still reaches Claude, as a clearly labeled FYI.
//
// Why: in a real session (2026-09-23) gpt-live-1 answered many utterances
// itself that Claude needed: the project's name decision ("Sotto is a clever
// name"), "I agree with you, the public repo is fine …", "let me know when you
// auto restart", "why did that get cut off? that seems like a bug". A request
// used to carry all speech since the previous send, but only within 90 s of
// the next delegation, so a decision followed by minutes of other talk never
// arrived. Worse, the model promised things it never delegated ("I'll mark
// Sato as your pick"). The prompt now asks it to delegate all of that
// (prompt.js), and this mirror is the safety net that does not depend on the
// model: MIRROR_QUIET_MS after the user stops talking, every word not yet sent
// to Claude (by a delegation or an earlier mirror) goes out in one message
//   "[sotto voice <code>] (said to the voice assistant, not delegated) <words>"
// with inbox priority "later", minus backchannels/filler, voice-only commands
// ("slow down", "repeat that") and echoes of the assistant. The voice context
// (scripts/voice-context.txt) tells Claude these are FYI: act on decisions and
// requests, answer project questions, otherwise reply only "Noted.".
//
// Words are never sent twice: sending advances the delegation engine's
// consumedThroughMs (synchronously, before the inbox write), which is the same
// watermark a delegation collects from.
//
// Pure apart from the injected effects; time comes from `clock`.
import { groupFragments, joinUserFragments, normalizeWords } from "./transcript.js";
import { MIRROR_MODES } from "./config.js";

export const MIRROR_TAG = "(said to the voice assistant, not delegated)";
export { MIRROR_MODES };
/** Quiet time after the user's last word before undelegated speech is mirrored. */
export const MIRROR_QUIET_MS = 6000;
/** While a delegation is collecting, look again this often (it takes the words itself). */
export const MIRROR_RECHECK_MS = 1000;
export const MIRROR_MAX_CHARS = 2000;
/** The assistant line before the user's words is quoted if it ended this recently before them. */
const CONTEXT_WINDOW_MS = 20000;

// Backchannels, fillers and small talk. A line made only of these (and the
// function words below) is not worth a Claude turn.
const BACKCHANNEL = new Set((
  "um umm uh uhh er erm hmm hm mm mmm mhm mmhm mmhmm uhhuh uhuh ah aha ahh oh ooh huh wow whoa " +
  "ok okay k kay alright allright yeah yea yep yup yes right sure cool nice great awesome perfect good fine " +
  "sweet neat lovely amazing thanks thank ty cheers hey hi hello bye gotcha interesting totally exactly true " +
  "indeed lol haha heh see got it"
).split(" "));
const FUNCTION = new Set((
  "i im you youre we it its that thats this the a an and but or so like just well what was is are be to of " +
  "in on at for with me my your our then there here too very really much oh now um"
).split(" "));
/** Words that make a short line a possible answer when Claude is waiting for one. */
const ANSWERS = new Set("yes yeah yep yup sure ok okay no nope fine agreed correct right".split(" "));

// Requests about the voice itself, handled by the voice model (instructions,
// §8.1 "Do not delegate"): never Claude's business. Anchored, short lines only.
const VOICE_ONLY = new RegExp(
  "^(?:(?:please|hey|ok|okay|so|um|uh|can you|could you|would you|will you|just)\\s+)*(?:" + [
    "stop talking", "be quiet", "quiet", "shh+", "shush", "hush", "shut up", "pause",
    "hold on", "hang on", "wait", "one sec(?:ond)?", "just a sec(?:ond)?", "give me a (?:sec(?:ond)?|minute|moment)",
    "slow down", "speed up", "(?:speak|talk) (?:slower|faster|louder|softer|up|more slowly|more quickly|more quietly)",
    "(?:say|repeat) (?:that|it|this)(?: again)?", "say (?:it|that) again", "repeat",
    "what did you (?:just )?say", "what was that", "come again", "pardon", "sorry what",
    "can you hear me", "are you (?:there|still there|listening)", "you there", "say something",
    "keep going", "go on", "continue", "never ?mind", "forget it",
    "be (?:brief|briefer|shorter|more concise)", "shorter", "less detail", "louder", "quieter", "slower", "faster",
  ].join("|") + ")\\b",
);
const VOICE_ONLY_MAX_WORDS = 12;

// Decision-like lines (mirror mode "decisions"): decisions, preferences,
// approvals, corrections, feedback and requests.
const DECISION = new RegExp("\\b(?:" + [
  "agree", "agreed", "disagree", "decid\\w*", "decision", "pick", "picked", "choose", "chose", "chosen", "go with", "going with",
  "lets", "let us", "we should", "should we", "should be", "we could", "i want", "i wanted", "id like", "i would like", "i prefer", "prefer",
  "rather", "i like", "i love", "i hate", "i dont like", "dont", "do not", "never", "always", "instead",
  "approve\\w*", "ship it", "merge", "go ahead", "do it", "sounds good", "looks good", "that works", "fine with", "im fine",
  "yes", "no", "nope", "correct", "wrong", "not what", "mistake", "bug", "broken", "doesnt work", "isnt working", "not working",
  "cut off", "fix", "let me know", "tell me when", "remind", "make sure", "please", "can you", "could you", "would you",
  "can we", "need", "needs", "must", "keep", "drop", "remove", "add", "change", "rename", "call it", "name", "use",
].join("|") + ")\\b");

/**
 * What a user line is, for the mirror.
 * @returns {"noise"|"filler"|"voice_only"|"fragment"|"decision"|"other"}
 */
export function classifyLine(text, { awaiting = false } = {}) {
  const w = normalizeWords(text);
  if (!w.length) return "noise";
  // Recognition debris in a script the user is not speaking ("我ん", "</").
  if (w.length <= 3 && !/[a-z0-9]/.test(w.join(""))) return "noise";
  const joined = w.join(" ");
  if (awaiting && w.length <= 4 && w.some((x) => ANSWERS.has(x))) return "decision";
  if (w.length <= 8 && w.every((x) => BACKCHANNEL.has(x) || FUNCTION.has(x))) return "filler";
  if (w.length <= VOICE_ONLY_MAX_WORDS && VOICE_ONLY.test(joined)) return "voice_only";
  if (DECISION.test(joined)) return "decision";
  // A few words that are no decision are the start of a thought cut by a
  // pause ("Should the", 9 s before the rest in the real session): the rest,
  // and whatever the model does with it, carries them.
  return w.length <= 3 ? "fragment" : "other";
}

/** Should a line with this class be mirrored under `mode`? */
export function mirrorWants(cls, mode) {
  if (mode === "off") return false;
  if (cls === "decision") return true;
  return mode === "all" && cls === "other";
}

/** The last ~max chars of `text`, cut at a word ("… Viva, Roger and Sato. Tell me what you like."). */
function tail(text, max) {
  const t = String(text).replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return "…" + t.slice(t.length - max + 1).replace(/^\S*\s+/, "");
}

export class Mirror {
  /**
   * @param {object} o
   * @param {object} o.clock
   * @param {import('./transcript.js').Transcript} o.transcript
   * @param {import('./delegation.js').DelegationEngine} o.delegation  owns consumedThroughMs
   * @param {object} o.effects
   *   mode()       → "all" | "decisions" | "off"
   *   live()       → true while a Live session is attached
   *   marker()     → "[sotto voice <nonce>]"
   *   awaiting()   → truthy while Claude waits for the user's answer
   *   send({content, msgId}) → Promise<{ok, code?}>   inbox write, priority "later"
   *   sent({text, content, lines, dropped, ok})      after the write (log, note to the model)
   *   vocabularyHint(text) → one-line note or null    (optional)
   * @param {object} [o.log]
   */
  constructor({ clock, transcript, delegation, effects, log }) {
    this.clock = clock;
    this.transcript = transcript;
    this.delegation = delegation;
    this.fx = effects;
    this.log = log || { info() {}, debug() {}, warn() {} };
    this.timer = null;
    this.checkedMs = 0; // session time up to which lines were judged (sent or not)
    this.seq = 0;
    this.last = null; // {text, content, at, msgId}: the latest mirror, for a late delegation (§6.18)
  }

  mode() {
    const m = this.fx.mode?.();
    return MIRROR_MODES.includes(m) ? m : "all";
  }

  /** New Live session: its timeline restarts at 0. */
  resetTimeline() { this.checkedMs = 0; }

  schedule(ms) {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => { this.timer = null; this.check(); }, Math.max(1, ms));
  }

  /** Every user input-transcript delta: (re)arm the quiet timer. */
  onUserSpeech() {
    if (this.mode() === "off") return;
    this.schedule(MIRROR_QUIET_MS);
  }

  check() {
    if (this.mode() === "off" || !this.fx.live?.()) return;
    const quietFor = this.clock.now() - (this.transcript.lastUserSpeechAt || 0);
    if (quietFor < MIRROR_QUIET_MS) { this.schedule(MIRROR_QUIET_MS - quietFor); return; }
    // A delegation in progress takes every unsent word itself (§6.9 E3).
    if (this.delegation.hasCollecting()) { this.schedule(MIRROR_RECHECK_MS); return; }
    this.flush("quiet");
  }

  /**
   * Mirror what is unsent now (quiet timer, or before the session's timeline
   * is reset). Returns the message content, or null when nothing was sent.
   */
  flush(reason = "quiet") {
    if (this.timer) { this.clock.clearTimeout(this.timer); this.timer = null; }
    const mode = this.mode();
    if (mode === "off") return null;
    const from = Math.max(this.delegation.consumedThroughMs, this.checkedMs);
    const frags = this.transcript.userFragmentsAfter(from);
    if (!frags.length) return null;
    const endMs = frags.reduce((m, f) => Math.max(m, f.end_ms), from);
    const awaiting = !!this.fx.awaiting?.();
    const kept = [];
    const dropped = {};
    for (const line of groupFragments(frags)) {
      const members = frags.filter((f) => f.start_ms >= line.start_ms && f.end_ms <= line.end_ms);
      const text = joinUserFragments(members).replace(/\s+/g, " ").trim();
      let cls = classifyLine(text, { awaiting });
      if (cls !== "noise" && normalizeWords(text).length >= 3 && this.transcript.isEcho(text, 20000, line.at)) cls = "echo";
      if (mirrorWants(cls, mode)) kept.push({ text, line });
      else dropped[cls] = (dropped[cls] || 0) + 1;
    }
    this.checkedMs = endMs;
    if (!kept.length) {
      // Nothing worth a Claude turn. The words stay unconsumed, so a later
      // delegation still carries them as context (its 90 s lookback).
      this.log.debug("mirror.skip", { reason, dropped });
      return null;
    }
    let text = kept.map((k) => k.text).join(" ");
    if (text.length > MIRROR_MAX_CHARS) text = `... ${text.slice(text.length - MIRROR_MAX_CHARS).replace(/^\S*\s*/, "")}`;
    // Consume BEFORE the async write: a delegation settling meanwhile must not re-send these words.
    this.delegation.consumedThroughMs = Math.max(this.delegation.consumedThroughMs, endMs);

    let content = `${this.fx.marker()} ${MIRROR_TAG} ${text}`;
    const before = this.assistantLineBefore(kept[0].line);
    if (before) content += `\n(The voice assistant had just said: "${tail(before, 240).replace(/"/g, "'")}")`;
    let hint = null;
    try { hint = this.fx.vocabularyHint?.(text) || null; } catch { hint = null; }
    if (hint) content += `\n${hint}`;

    const msgId = `clv-mirror-${++this.seq}`;
    this.last = { text, content, at: this.clock.now(), msgId };
    const lines = kept.length;
    Promise.resolve()
      .then(() => this.fx.send({ content, msgId }))
      .catch((e) => ({ ok: false, code: "error", message: String(e && e.message) }))
      .then((res) => this.fx.sent?.({ text, content, lines, dropped, reason, ok: !!(res && res.ok), code: res && res.code }));
    return content;
  }

  /** The assistant's line just before `line` (by wall time), if it ended within CONTEXT_WINDOW_MS. */
  assistantLineBefore(line) {
    const firstAt = this.transcript.fragments.find((f) => f.role === "user" && f.start_ms === line.start_ms)?.at ?? line.at;
    let best = null;
    for (const l of this.transcript.lines()) {
      if (l.role !== "assistant" || l.at > firstAt) continue;
      if (!best || l.at > best.at) best = l;
    }
    return best && firstAt - best.at <= CONTEXT_WINDOW_MS ? best.text.trim() : null;
  }

  /** Treat everything heard so far as handled without sending it (owner switch). */
  discard() {
    if (this.timer) { this.clock.clearTimeout(this.timer); this.timer = null; }
    const end = this.transcript.fragments.reduce((m, f) => (f.role === "user" ? Math.max(m, f.end_ms) : m), 0);
    this.checkedMs = Math.max(this.checkedMs, end);
    this.delegation.consumedThroughMs = Math.max(this.delegation.consumedThroughMs, end);
    this.last = null;
  }

  /**
   * The latest mirror, if sent within `withinMs` and not yet claimed: a
   * delegation that arrives after its words were mirrored takes it (§6.18).
   */
  claimRecent(withinMs = 20000) {
    const m = this.last;
    if (!m || this.clock.now() - m.at > withinMs) return null;
    this.last = null;
    return m;
  }

  dispose() {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}
