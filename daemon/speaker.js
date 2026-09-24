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

// Sources whose commentary is an answer or something the user must act on.
const HIGH = new Set(["voice_result", "background_voice", "question", "permission", "attention", "voice_notice"]);
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
  }

  /** Output transcript delta from the Live session (the assistant is talking). */
  onOutput(delta, startMs, endMs) {
    const now = this.clock.now();
    if (!this.burst || now > this.speakingUntil) this.burst = Number.isFinite(startMs) ? { wall: now, startMs } : null;
    let until = now + SPEAK_HANGOVER_MS;
    // The transcript may run ahead of playback: end_ms on the session timeline,
    // measured from the burst's first delta, says when this audio ends.
    if (this.burst && Number.isFinite(endMs) && endMs >= this.burst.startMs) {
      until = Math.max(until, this.burst.wall + (endMs - this.burst.startMs) + SPEAK_HANGOVER_MS);
    }
    this.speakingUntil = Math.max(this.speakingUntil, until);
    this.prerollUntil = 0; // speech has started: the delta timing takes over
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

  /** Queue one commentary action ({kind, content, delegationId, source, priority?, urgent?}). */
  enqueue(action) {
    const priority = action.priority ?? priorityOf(action.source);
    const urgent = action.urgent ?? isUrgent(action.source);
    this.items.push({ action, priority, urgent, at: this.clock.now(), seq: this.seq++ });
    this.pump();
  }

  /** Release what may be released now; re-arm the poll timer while items wait. */
  pump() {
    this.clearTimer();
    const now = this.clock.now();
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
      this.send(head.action);
    }
    this.schedule();
  }

  schedule() {
    if (this.timer || !this.items.length) return;
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
    return out;
  }
}
