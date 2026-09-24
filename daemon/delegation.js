// Delegation state machine (SPEC §6.9). Pure logic: all I/O goes through the
// injected `effects`, all time through the injected `clock`.
//
// Flow: session.delegation.created (E1) → settle (E2) → build text + inbox
// write (E3) → hooks track delivery (E4/E5) → Stop routes the result (E6).
//
// Review fixes on top of the SPEC (see docs/SPEC-DEVIATIONS.md, "Review fixes"):
// - Every record remembers the Live session it was created in (`live_id`).
//   Delegation ids are only known to that session, so anything about a record
//   from an earlier session is appended with delegation_id null (`idFor`).
// - Staleness is judged against `sentRev`, the newest request that actually
//   reached Claude, not against every delegation (echoes, empties, failures).
// - Voice records remember the `prompt_id` of the turn they started. Stop is
//   matched to records by prompt_id; a message sent while Claude was busy
//   counts as part of the turn only if the transcript shows it was absorbed.
//   (Probed on CLI 2.1.281: a message absorbed mid-turn fires UserPromptSubmit
//   with the SAME prompt_id as the running turn; a queued one runs later as its
//   own prompt with a new prompt_id.) The fixed STOP_DEFER_MS wait is only a
//   fallback for CLIs without prompt_id or an unreadable transcript.
// - A new UserPromptSubmit closes the previous turn: records delivered in a
//   turn that ended without Stop (Esc) become `interrupted`.
// - Subagent hooks (agent_id present) never touch the busy state.
import { VOICE_MARKER, BG } from "./config.js";
import { clip } from "./speech.js";
import { groupFragments, joinUserFragments } from "./transcript.js";
import { isBackgroundLaunch } from "./policy.js";

export const FINAL_STATUSES = new Set(["answered", "answered_stale", "superseded", "dropped_echo", "dropped_empty", "failed", "orphaned", "interrupted"]);
const IN_FLIGHT = new Set(["sent", "delivered", "held_suspected"]);

export const SETTLE_MIN_MS = 600;
// Trailing-words window: after session.delegation.created, wait until the
// user has been quiet this long (measured word deltas arrive 200-1200 ms
// apart in continuous speech). Words after the cap are not lost: they are
// after consumedThroughMs and go with the next request.
export const SETTLE_QUIET_MS = 600;
export const SETTLE_MAX_MS = 3000;
/**
 * A request is ALL user speech since the previous one was sent (people pause
 * mid-thought; the Live model delegates after the last pause), bounded to the
 * newest REQUEST_LOOKBACK_MS of session time and REQUEST_MAX_CHARS.
 */
export const REQUEST_LOOKBACK_MS = 90_000;
export const REQUEST_MAX_CHARS = 2000;
export const HELD_MS = 8000;
export const STOP_DEFER_MS = 2500;
/** Transcript writes lag: re-read once this long after Stop if a busy-sent message is unaccounted for. */
export const STOP_RECHECK_MS = 1200;
/** A request still in flight after this long is given up on (orphaned). */
export const MAX_IN_FLIGHT_MS = 30 * 60_000;
const REPEAT_WINDOW_MS = 10 * 60_000;

/** Background launches remembered for matching their task-notification later. */
const MAX_LAUNCHES = 200;
const TASK_NOTE = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const tag = (body, name) => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body); return m ? m[1].trim() : ""; };

/**
 * Task notifications in a prompt. Probed on CLI 2.1.281: a background agent's
 * or command's completion reaches the session as a UserPromptSubmit whose
 * prompt is "<task-notification>…<tool-use-id>…<status>…<summary>…" (absorbed
 * into a running turn with its prompt_id, or as its own new prompt).
 */
export function parseTaskNotifications(prompt) {
  const out = [];
  if (typeof prompt !== "string" || !prompt.trimStart().startsWith("<task-notification>")) return out;
  for (const m of prompt.matchAll(TASK_NOTE)) {
    out.push({ taskId: tag(m[1], "task-id"), toolUseId: tag(m[1], "tool-use-id"), status: tag(m[1], "status"), summary: tag(m[1], "summary") });
  }
  return out;
}

const words = (t) => String(t).trim().split(/\s+/).filter(Boolean);
const isSubagent = (body) => !!body && typeof body.agent_id === "string" && body.agent_id !== "";

export class DelegationEngine {
  /**
   * @param {object} o
   * @param {object} o.clock       {now, setTimeout, clearTimeout}
   * @param {import('./transcript.js').Transcript} o.transcript
   * @param {object} o.effects     see voice.js for the concrete implementation:
   *   inboxSend({content, msgId}) → Promise<{ok, code?, message?}>
   *   append(kind, content, delegationId)
   *   route(source, payload)
   *   createPendingContext(), removePendingContext()
   *   setLastError(code, message), notice(level, code, text)
   *   checkLiveness(), onChange(record), project(), ownerSocket(), counters
   *   liveId()        → id of the current Live session, or null      (optional)
   *   marker()        → voice marker incl. the per-bind nonce        (optional)
   *   absorbed(transcriptPath, contents) → Set|null|Promise           (optional)
   *   vocabularyHint(text) → one-line note on likely misheard names, or null (optional)
   * @param {object} [o.log]
   */
  constructor({ clock, transcript, effects, log }) {
    this.clock = clock;
    this.transcript = transcript;
    this.fx = effects;
    this.log = log || { info() {}, debug() {}, warn() {} };
    this.records = [];
    this.rev = 0;
    this.sentRev = 0;
    this.consumedThroughMs = 0;
    this.claudeBusy = false;
    this.promptId = null; // prompt_id of the turn in progress (from UserPromptSubmit)
    this.stoppedPrompts = [];
    this.lastSentContent = null;
    this.lastSentAt = 0;
    this.lastHookAt = 0;
    this.timers = new Set();
    // prompt_id → {origin: "voice"|"typed"|"task", tasks: [...]} (last 50 prompts)
    this.turns = new Map();
    // tool_use_id of a background launch → {origin, requestText} of the turn that launched it
    this.launches = new Map();
  }

  // ---- helpers -------------------------------------------------------------
  timer(fn, ms) {
    const h = this.clock.setTimeout(() => { this.timers.delete(h); fn(); }, ms);
    this.timers.add(h);
    return h;
  }
  sleep(ms) { return new Promise((r) => this.timer(r, ms)); }
  setStatus(rec, status, extra = {}) {
    const from = rec.status;
    rec.status = status;
    Object.assign(rec, extra);
    this.log.info("delegation", { id: rec.id, rev: rec.rev, from, to: status });
    this.fx.onChange?.(rec);
  }
  get(id) { return this.records.find((r) => r.id === id); }
  hasCollecting() { return this.records.some((r) => r.status === "collecting"); }
  inFlight() { return this.records.filter((r) => IN_FLIGHT.has(r.status)); }
  marker() { return this.fx.marker?.() || VOICE_MARKER; }
  liveId() { return this.fx.liveId?.() ?? null; }
  /**
   * Was `rec` created in the Live session that is current now? (Without a
   * liveId effect, e.g. in unit tests of other parts, every record is current.)
   */
  isCurrentLive(rec) {
    if (!rec) return false;
    if (!this.fx.liveId) return true;
    return rec.live_id != null && rec.live_id === this.liveId();
  }
  /** The delegation id to append with: the record's own only in its own Live session. */
  idFor(rec) { return this.isCurrentLive(rec) ? rec.id : null; }
  wasStopped(promptId) { return typeof promptId === "string" && this.stoppedPrompts.includes(promptId); }

  /** New Live session: its timeline restarts at 0. */
  resetTimeline() { this.consumedThroughMs = 0; }

  /** Forget what we believe about Claude's turn (owner switch, voice off). */
  resetClaudeState() {
    this.claudeBusy = false;
    this.lastHookAt = 0;
    this.promptId = null;
  }

  /** Give up on requests that have been in flight for too long (e.g. an Esc we never saw). */
  sweepStale(maxAgeMs = MAX_IN_FLIGHT_MS) {
    const now = this.clock.now();
    for (const r of this.inFlight()) if (r.sent_at && now - r.sent_at > maxAgeMs) this.setStatus(r, "orphaned");
  }

  /** In-flight requests younger than maxAgeMs (idle close waits for these). */
  pendingWork(maxAgeMs = MAX_IN_FLIGHT_MS) {
    const now = this.clock.now();
    return this.inFlight().filter((r) => !r.sent_at || now - r.sent_at <= maxAgeMs);
  }

  /** Last n records, newest first, for /status (timestamps as ISO). */
  list(n = 10) {
    const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
    return this.records.slice(-n).reverse().map((r) => ({
      id: r.id, rev: r.rev, status: r.status, text: r.text ?? "", sent_at: iso(r.sent_at), answered_at: iso(r.answered_at),
    }));
  }

  // ---- E1 ------------------------------------------------------------------
  onCreated(evt) {
    const d = evt && evt.delegation;
    if (!d || d.target !== "client" || !d.id) return null;
    if (this.get(d.id)) return null; // duplicate event
    this.rev += 1;
    const rec = {
      id: d.id, rev: this.rev, created_at: this.clock.now(), offset_ms: Number(evt.offset_ms) || 0,
      status: "collecting", text: null, content: null, msg_id: null, sent_at: 0, sent_while_busy: false,
      delivered_at: 0, answered_at: 0, owner_socket: this.fx.ownerSocket?.() ?? null,
      live_id: this.liveId(), prompt_id: null,
    };
    this.records.push(rec);
    if (this.records.length > 200) this.records.splice(0, this.records.length - 200);
    this.fx.counters.delegations++;
    this.log.info("delegation", { id: rec.id, rev: rec.rev, to: "collecting", offset_ms: rec.offset_ms });
    this.fx.onChange?.(rec);
    this.timer(() => this.checkSettle(rec), SETTLE_MIN_MS);
    return rec;
  }

  // ---- E2 ------------------------------------------------------------------
  checkSettle(rec) {
    if (rec.status !== "collecting" || rec._settling) return;
    const now = this.clock.now();
    const hardAt = rec.created_at + SETTLE_MAX_MS;
    const lastDelta = this.transcript.lastUserSpeechAt || 0;
    if (now >= hardAt || now - lastDelta >= SETTLE_QUIET_MS) { this.settle(rec); return; }
    const next = Math.min(hardAt, lastDelta + SETTLE_QUIET_MS);
    this.timer(() => this.checkSettle(rec), Math.max(1, next - now));
  }

  // ---- E3 ------------------------------------------------------------------
  async settle(rec) {
    if (rec.status !== "collecting" || rec._settling) return;
    rec._settling = true;
    // A newer delegation covers this speech too (a request is everything
    // since the previous send), whether it is still collecting or its timer
    // happened to fire first and already took the words.
    if (this.records.some((r) => r.rev > rec.rev)) {
      this.setStatus(rec, "superseded");
      return;
    }
    const req = collectRequest(this.transcript, this.consumedThroughMs, rec.offset_ms);
    const { text } = req;
    rec.text = text;
    if (req.trimmed || req.echoLines) {
      this.log.info("delegation.request", { id: rec.id, rev: rec.rev, chars: text.length, trimmed_chars: req.trimmed, echo_lines: req.echoLines });
    }
    const consume = () => { this.consumedThroughMs = Math.max(this.consumedThroughMs, req.consumedTo); };

    if (!text && req.echoLines) {
      consume(); // never re-send the echo with the next request
      this.setStatus(rec, "dropped_echo");
      this.fx.append("thinking", ECHO_NOTE, this.idFor(rec));
      return;
    }
    if (!text) {
      this.setStatus(rec, "dropped_empty");
      this.fx.append("commentary", "I didn't catch the request clearly. Could you say it again?", this.idFor(rec));
      return;
    }
    if (this.transcript.isEcho(text)) {
      consume();
      this.setStatus(rec, "dropped_echo");
      // Close the Live-side delegation quietly so the model does not wait on it.
      this.fx.append("thinking", ECHO_NOTE, this.idFor(rec));
      return;
    }

    let content = `${this.marker()} ${text}`;
    const now = this.clock.now();
    if (words(text).length <= 6 && this.transcript.lastAssistantSpeechAt && now - this.transcript.lastAssistantSpeechAt <= 15000) {
      const line = this.transcript.lastAssistantLine();
      if (line && line.text.trim()) {
        content += `\n(Replying to the voice assistant, which had just said: "${clip(line.text, 200).replace(/"/g, "'")}")`;
      }
    }
    // Likely mishearings of glossary names ("in peccable" → impeccable), as a
    // note after the user's words; the words themselves are never changed.
    let hint = null;
    try { hint = this.fx.vocabularyHint?.(text) || null; } catch { hint = null; }
    if (hint) content += `\n${hint}`;
    if (content === this.lastSentContent && now - this.lastSentAt < REPEAT_WINDOW_MS) content += " (repeated)";

    rec.content = content;
    rec.msg_id = `clv-${rec.id}-${rec.rev}`;
    consume();

    let res;
    try { res = await this.fx.inboxSend({ content, msgId: rec.msg_id }); } catch (e) { res = { ok: false, code: "error", message: String(e && e.message) }; }
    if (rec.status !== "collecting") return; // orphaned while writing

    if (res && res.ok) {
      const busy = this.claudeBusy;
      this.setStatus(rec, "sent", { sent_at: this.clock.now(), sent_while_busy: busy });
      this.sentRev = Math.max(this.sentRev, rec.rev);
      this.lastSentContent = content;
      this.lastSentAt = rec.sent_at;
      if (busy) this.fx.createPendingContext();
      this.fx.counters.inbox_sent++;
      this.fx.append("thinking", `[sotto] Request sent to Claude Code: "${clip(text, 300).replace(/"/g, "'")}". Claude Code is working on it; there is no result yet.`, this.idFor(rec));
      if (!busy) this.timer(() => this.checkHeld(rec), HELD_MS);
    } else {
      const code = (res && res.code) || "error";
      this.setStatus(rec, "failed");
      this.fx.counters.inbox_failed++;
      const gone = code === "no_socket" || code === "refused";
      this.fx.append("commentary", gone
        ? `I couldn't reach Claude Code for ${this.fx.project?.() || "this project"}. Voice is turning off.`
        : "I couldn't reach Claude Code. Please try again.", this.idFor(rec));
      if (gone) this.fx.checkLiveness?.();
    }
  }

  // Held timer (§6.9 E3.7): no hook since the send → the message is probably held.
  checkHeld(rec) {
    if (rec.status !== "sent" || this.lastHookAt >= rec.sent_at) return;
    this.setStatus(rec, "held_suspected");
    this.fx.append("commentary", "That request hasn't reached Claude Code. It may be waiting for approval in the terminal, or the session may be set to hold messages from other sessions.", this.idFor(rec));
    this.fx.setLastError?.("inbox_held", "A voice request did not reach Claude Code. If the session uses bypass permissions, set crossSessionInbound to accept.");
    this.fx.notice?.("warn", "inbox_held", "Claude Code has not picked up the voice request. If it keeps happening, set crossSessionInbound to accept in your Claude Code settings.");
  }

  // ---- E4/E5 hooks ---------------------------------------------------------
  /** Any owner hook. Returns nothing; Stop/StopFailure use their own methods. */
  onHook(event, body = {}) {
    // Subagent tool hooks run with the same env, but say nothing about the
    // main thread's turn (a background agent can run after the main Stop).
    if (isSubagent(body)) return;
    if (event === "UserPromptSubmit" || event === "PreToolUse" || event === "MessageDisplay" || event === "Stop") {
      this.lastHookAt = this.clock.now();
    }
    if (event === "PreToolUse") this.noteLaunch(body);
    if (event === "UserPromptSubmit") this.onUserPromptSubmit(body);
    // MessageDisplay never starts a turn and its POST can land after Stop, so
    // it does not set busy; neither does any hook of a turn already stopped.
    else if ((event === "PreToolUse" || event === "PermissionRequest") && !this.wasStopped(body.prompt_id)) this.claudeBusy = true;
  }

  onUserPromptSubmit(body) {
    const pid = typeof body.prompt_id === "string" ? body.prompt_id : null;
    if (pid && this.wasStopped(pid)) return; // a late POST for a finished turn
    // A new prompt means the previous turn is over. If it never sent Stop
    // (Esc interrupt), its voice requests will never be answered by it.
    if (pid && this.promptId && pid !== this.promptId) {
      for (const r of this.records) {
        if (r.status === "delivered" && r.prompt_id === this.promptId) this.setStatus(r, "interrupted");
      }
      this.fx.removePendingContext();
    }
    if (pid) this.promptId = pid;
    this.claudeBusy = true;
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    const marker = this.marker();
    const notes = parseTaskNotifications(prompt);
    if (notes.length) {
      // Background work finished. Absorbed into a running turn, the turn keeps
      // its own origin; as a new prompt, the turn is a "task" turn whose Stop
      // is routed by who launched the work (onStop).
      const t = this.turnFor(pid, "task");
      t.tasks.push(...notes);
      const said = notes.map((n) => clip(n.summary || `task ${n.status || "finished"}`, 160)).join("; ");
      this.fx.append("thinking", `${BG}Background task update: ${said}`, null);
      return;
    }
    this.turnFor(pid, prompt.startsWith(marker) ? "voice" : "typed");
    if (prompt.startsWith(marker)) {
      const waiting = this.records.filter((r) => r.status === "sent" || r.status === "held_suspected");
      const match = waiting.find((r) => r.content === prompt) || waiting.find((r) => r.content && r.content.trim() === prompt.trim()) || waiting[0];
      if (match) this.setStatus(match, "delivered", { delivered_at: this.clock.now(), prompt_id: pid });
      // This UserPromptSubmit already injected the voice context; the
      // PreToolUse fallback flag is only needed while a busy-sent one is unseen.
      if (!this.records.some((r) => r.status === "sent" && r.sent_while_busy)) this.fx.removePendingContext();
      return;
    }
    if (prompt && !prompt.startsWith("/") && !prompt.includes("<pasted_content")) {
      this.fx.append("thinking", `${BG}The user typed to Claude Code: ${clip(prompt, 300)}`, null);
    }
  }

  // ---- turn origins and background launches (§6.10.1) -------------------------
  /** The turn record for prompt `pid`, created with `origin` if new. */
  turnFor(pid, origin) {
    const key = pid || "_";
    let t = this.turns.get(key);
    if (!t) {
      t = { origin, tasks: [] };
      this.turns.set(key, t);
      while (this.turns.size > 50) this.turns.delete(this.turns.keys().next().value);
    }
    return t;
  }

  /** The voice request a turn is answering (a record delivered in prompt `pid`). */
  voiceRecordFor(pid) {
    const recs = this.records.filter((r) => pid && r.prompt_id === pid && (IN_FLIGHT.has(r.status) || r.status === "answered" || r.status === "interrupted"));
    return recs.length ? recs.reduce((a, b) => (b.rev > a.rev ? b : a)) : null;
  }

  /** Delegation id to attach a spoken prompt to: the voice request in flight in turn `pid`. */
  activeVoiceId(pid) {
    const r = this.voiceRecordFor(pid);
    return r && IN_FLIGHT.has(r.status) ? this.idFor(r) : null;
  }

  /** PreToolUse on the main thread: remember background launches and who asked for them. */
  noteLaunch(body) {
    if (!isBackgroundLaunch(body.tool_name, body.tool_input) || typeof body.tool_use_id !== "string") return;
    const pid = typeof body.prompt_id === "string" ? body.prompt_id : null;
    const t = this.turns.get(pid || "_");
    const rec = this.voiceRecordFor(pid);
    // A launch from a task turn inherits the origin of the work that turn reports.
    const inherited = t && t.origin === "task" ? this.taskOrigin(t) : null;
    const origin = rec ? "voice" : inherited ? inherited.origin : t ? t.origin : "unknown";
    this.launches.set(body.tool_use_id, { origin, requestText: rec ? rec.text : inherited ? inherited.requestText : "" });
    while (this.launches.size > MAX_LAUNCHES) this.launches.delete(this.launches.keys().next().value);
  }

  /**
   * Who asked for the work reported by a task turn: "voice" if any of its
   * tasks was launched while answering a voice request, else "typed" if one
   * was launched in a typed turn, else "unknown".
   */
  taskOrigin(t) {
    let origin = "unknown";
    let requestText = "";
    for (const n of t.tasks) {
      const l = n.toolUseId && this.launches.get(n.toolUseId);
      if (!l) continue;
      if (l.origin === "voice") return { origin: "voice", requestText: l.requestText };
      if (l.origin === "typed") origin = "typed";
    }
    return { origin, requestText };
  }

  // ---- E6 ------------------------------------------------------------------
  async onStop(body = {}) {
    this.lastHookAt = this.clock.now();
    this.claudeBusy = false;
    this.fx.removePendingContext();
    const pid = typeof body.prompt_id === "string" ? body.prompt_id : null;
    if (pid) {
      this.stoppedPrompts.push(pid);
      if (this.stoppedPrompts.length > 50) this.stoppedPrompts.shift();
      if (this.promptId === pid) this.promptId = null;
    }
    const stopAt = this.clock.now();
    const text = typeof body.last_assistant_message === "string" ? body.last_assistant_message : "";

    const cand = pid ? await this.candidatesByPrompt(pid, stopAt, body.transcript_path) : await this.candidatesByTimer(stopAt);
    if (!cand.length) {
      // Nobody is waiting on this turn by voice: route by its origin.
      const t = this.turns.get(pid || "_");
      let source = "typed_result";
      const payload = { text };
      if (pid && !t) source = "other_result";
      else if (t && t.origin === "task") {
        const o = this.taskOrigin(t);
        source = o.origin === "voice" ? "background_voice" : o.origin === "typed" ? "background_result" : "other_result";
        payload.requestText = o.requestText;
      }
      if (pid) this.turns.delete(pid);
      this.fx.route(source, payload);
      return { source };
    }
    if (pid) this.turns.delete(pid);
    const target = cand.reduce((a, b) => (b.rev > a.rev ? b : a));
    for (const r of cand) if (r !== target) this.setStatus(r, "superseded");
    // Current = no newer request reached Claude and none is being collected.
    const current = target.rev >= this.sentRev && !this.hasCollecting();
    const earlier = !this.isCurrentLive(target);
    const answered_at = this.clock.now();
    const payload = { text, delegationId: earlier ? null : target.id, requestText: target.text, earlier };
    if (current) {
      this.setStatus(target, "answered", { answered_at });
      this.fx.route("voice_result", payload);
      return { source: "voice_result", id: target.id, earlier };
    }
    this.setStatus(target, "answered_stale", { answered_at });
    this.fx.route("stale_result", payload);
    return { source: "stale_result", id: target.id, earlier };
  }

  /**
   * Records answered by the Stop of prompt `pid`:
   *  - records delivered by this turn's UserPromptSubmit (prompt_id match,
   *    including one wrongly marked interrupted because Stop's POST lost a race);
   *  - records delivered without a prompt_id (older CLI);
   *  - sent-but-undelivered records that the transcript shows were absorbed
   *    into this turn. Others stay in flight: they are queued behind it.
   * Records delivered by a different, earlier prompt are interrupted.
   */
  async candidatesByPrompt(pid, stopAt, transcriptPath) {
    const out = [];
    const undelivered = [];
    for (const r of this.records) {
      if (r.prompt_id === pid && (IN_FLIGHT.has(r.status) || r.status === "interrupted")) { out.push(r); continue; }
      if (!IN_FLIGHT.has(r.status) || r.sent_at > stopAt) continue;
      if (r.status === "delivered") {
        if (!r.prompt_id) out.push(r);
        else this.setStatus(r, "interrupted"); // its own turn ended without a Stop
      } else {
        undelivered.push(r);
      }
    }
    if (!undelivered.length) return out;

    let found = await this.absorbed(transcriptPath, undelivered);
    if (found === null) {
      // Transcript unreadable: fall back to the SPEC's timing heuristic.
      return out.concat(await this.filterQueuedByTimer(undelivered, stopAt));
    }
    const missing = () => undelivered.filter((r) => IN_FLIGHT.has(r.status) && r.status !== "delivered" && !found.has(r.content));
    if (missing().length) {
      // The transcript is written asynchronously; look once more after a beat.
      // A queued message's own UserPromptSubmit may also arrive meanwhile.
      await this.sleep(STOP_RECHECK_MS);
      const again = await this.absorbed(transcriptPath, undelivered);
      if (again) found = again;
    }
    for (const r of undelivered) {
      if (r.status !== "sent" && r.status !== "held_suspected") continue; // delivered/closed meanwhile
      if (found.has(r.content)) out.push(r);
    }
    return out;
  }

  async absorbed(transcriptPath, recs) {
    if (!this.fx.absorbed || !transcriptPath) return null;
    try {
      const r = await this.fx.absorbed(transcriptPath, recs.map((x) => x.content));
      return r instanceof Set ? r : null;
    } catch {
      return null;
    }
  }

  /** SPEC E6 fallback (no prompt_id): everything in flight, minus late-queued messages. */
  async candidatesByTimer(stopAt) {
    const cand = this.inFlight().filter((r) => r.sent_at <= stopAt);
    const keep = await this.filterQueuedByTimer(cand, stopAt);
    return keep;
  }

  /** Wait STOP_DEFER_MS if a busy-sent message may be queued; drop those delivered meanwhile. */
  async filterQueuedByTimer(cand, stopAt) {
    const queued = cand.filter((r) => r.status === "sent" && r.sent_while_busy);
    if (!queued.length) return cand;
    await this.sleep(STOP_DEFER_MS);
    const excluded = new Set(queued.filter((r) => r.delivered_at && r.delivered_at >= stopAt).map((r) => r.id));
    return cand.filter((r) => IN_FLIGHT.has(r.status) && !excluded.has(r.id));
  }

  // ---- E7 ------------------------------------------------------------------
  onStopFailure(body = {}) {
    this.claudeBusy = false;
    this.fx.removePendingContext();
    const pid = typeof body.prompt_id === "string" ? body.prompt_id : null;
    if (pid) {
      this.stoppedPrompts.push(pid);
      if (this.stoppedPrompts.length > 50) this.stoppedPrompts.shift();
      if (this.promptId === pid) this.promptId = null;
    }
    let live = this.records.filter((r) => r.status === "sent" || r.status === "delivered");
    if (pid && live.some((r) => r.prompt_id === pid)) live = live.filter((r) => r.prompt_id === pid);
    const target = live.length ? live.reduce((a, b) => (b.rev > a.rev ? b : a)) : null;
    if (target) this.setStatus(target, "answered", { answered_at: this.clock.now() });
    const lead = target && !this.isCurrentLive(target) && target.text ? `About your earlier request "${clip(target.text, 120).replace(/"/g, "'")}": ` : "";
    this.fx.append("commentary", `${lead}Claude Code hit an error: ${humanizeError(body.error)}.`, target ? this.idFor(target) : null);
    return target;
  }

  // ---- E8 ------------------------------------------------------------------
  orphanAll() {
    for (const r of this.records) if (!FINAL_STATUSES.has(r.status)) this.setStatus(r, "orphaned");
  }

  dispose() {
    for (const h of this.timers) this.clock.clearTimeout(h);
    this.timers.clear();
  }
}

const ECHO_NOTE = "[sotto] Not a request: that was your own voice picked up by the microphone. Nothing was sent to Claude Code. Ignore it and do not mention it.";

/**
 * The text of a request (SPEC §6.9 E3.1, as amended in SPEC-DEVIATIONS
 * "Utterance grouping"): every user fragment after `consumedMs` (speech not
 * yet sent to Claude), joined in order. Only input_transcript fragments are
 * used, so the Live model's own acknowledgements never leak in; a line
 * (1500 ms grouping) that is an echo of the assistant, judged against what
 * the assistant said just before that line was heard, is left out.
 * Bounded to the newest REQUEST_LOOKBACK_MS before `offsetMs` and the newest
 * REQUEST_MAX_CHARS; a trimmed request starts with "...".
 * @returns {{text:string, frags:object[], consumedTo:number, trimmed:number, echoLines:number}}
 */
export function collectRequest(transcript, consumedMs, offsetMs) {
  const fresh = transcript.userFragmentsAfter(consumedMs);
  const consumedTo = fresh.reduce((m, f) => Math.max(m, f.end_ms), consumedMs);
  // joinUserFragments: a leading wake-clip fragment (§6.15) is joined without the words repeated at the seam.
  const norm = (fs) => joinUserFragments(fs).replace(/\s+/g, " ").trim();
  let trimmed = 0;
  let frags = fresh.filter((f) => f.end_ms > offsetMs - REQUEST_LOOKBACK_MS);
  if (frags.length < fresh.length) trimmed += norm(fresh.filter((f) => !frags.includes(f))).length;

  // Echo check per line (same 1500 ms grouping as the transcript model).
  let echoLines = 0;
  const kept = [];
  for (const line of groupFragments(frags)) {
    const members = frags.filter((f) => f.start_ms >= line.start_ms && f.end_ms <= line.end_ms);
    if (words(line.text).length >= 3 && transcript.isEcho(line.text, 20000, line.at)) { echoLines++; continue; }
    kept.push(...members);
  }
  frags = kept;

  // Keep the newest fragments that fit; the latest words finish the request.
  let text = norm(frags);
  while (text.length > REQUEST_MAX_CHARS && frags.length > 1) {
    trimmed += frags[0].text.length;
    frags = frags.slice(1);
    text = norm(frags);
  }
  if (text.length > REQUEST_MAX_CHARS) {
    const cut = text.slice(text.length - REQUEST_MAX_CHARS).replace(/^\S*\s*/, "");
    trimmed += text.length - cut.length;
    text = cut;
  }
  if (trimmed && text) text = `... ${text}`;
  return { text, frags, consumedTo, trimmed, echoLines };
}

export function humanizeError(code) {
  switch (code) {
    case "rate_limit": return "it hit a rate limit";
    case "overloaded": return "the service is overloaded";
    case "authentication_failed": return "it isn't signed in";
    case "max_output_tokens": return "its reply was too long";
    default: return "an API error";
  }
}
