// Voice-session orchestrator (SPEC §6.4 actions, §6.5 owner, §6.11 lifecycle,
// §6.13 shutdown). Wires the sideband, transcript, delegation engine, narrator,
// page (SSE) and Chrome window together. All time goes through `clock`.
import { randomBytes } from "node:crypto";
import { normalizeConfig, POLICIES, VOICES, ECHO_GUARD_MODES, openaiBase, wssBase, VERSION, MAX_APPEND_TOKENS, voiceMarker, BG } from "./config.js";
import { estTokens, fitTokens, tokenChunks, speakable, summary, clip, awaitingQuestion } from "./speech.js";
import { makeOwner, ownerStatus, isOwnerAlive } from "./owner.js";
import { writeActive, removeActive, createPendingContext, removePendingContext, readUsage, writeUsage, localDate, StatusFileWriter } from "./statefiles.js";
import { Transcript } from "./transcript.js";
import { DelegationEngine } from "./delegation.js";
import { Mirror, MIRROR_MODES } from "./mirror.js";
import { Narrator, milestoneLabel, elicitationSpeech, serverName } from "./policy.js";
import { SpeechQueue, COMMENTARY_PREROLL_MS } from "./speaker.js";
import { renderForPolicy, buildSeedInput, greeting, ownerSwitchInstruction, voiceSwitchGreeting, vocabularyUpdateInstruction, updateGreeting } from "./prompt.js";
import { readPrefs, writePrefs, resolveVoice, normalizeVoice, voiceListMessage, unknownVoiceMessage, normalizeWindow, resolveWindowPref } from "./prefs.js";
import { collectVocabulary, renderVocabulary, vocabularyHint, TIER } from "./vocabulary.js";
import { buildSessionBody, createLiveSession, Sideband } from "./live.js";
import { PreviewCache, recordPreview, previewText } from "./preview.js";
import { readTranscriptTail, readAbsorbed, gitBranch } from "./claude-context.js";
import { truncate } from "./log.js";
import { usageToday } from "./format.js";
import { WakeGovernor, WAKE_SOURCES, sleepDecision, idleSecondsOf } from "./wake.js";
import { decodeWavB64, wavDurationMs, transcribeWithFallback, wakeInstruction } from "./transcribe.js";
import { normalizeKeyInput, validateKey, keyWhere } from "./apikey.js";

// Idle/sleep is checked this often while live. Short, because the idle
// timeout is now tens of seconds, not minutes (§6.15).
const IDLE_TICK_MS = 2000;
/** A voice wake whose clip never arrives gets a "nothing captured" note after this long. */
const WAKE_NOTE_MS = 12000;
/** A notify wake the page does not act on within this long is dropped (the result stays pending). */
const NOTIFY_WATCH_MS = 30000;
const MAX_WAKE_QUEUE = 10;
const SESSION_REASONS = ["start", "resume", "reconnect", "wake", "notify"];
const LIVENESS_MS = 30000;
const WAITING_PAGE_MS = 30000;
const EXIT_AFTER_OFF_MS = 3000;
const CLOSE_WINDOW_KILL_MS = 1500;
const RTC_DISCONNECT_MS = 8000;
const RECONNECT_WINDOW_MS = 10 * 60_000;
const RECONNECT_MAX = 3;
/** The page must start the replacement session within this long, or voice pauses. */
const RECONNECT_WATCH_MS = 30000;
/** How long a missing page may take to come back before the window is reopened. */
const RECONNECT_OPEN_MS = 4000;
// Voice switch: wait this long for the old session's session.closed before the
// page reconnects. Tearing the WebRTC peer down at the same moment as
// session.close made the server end the old session as connection_lost /
// remote_hangup instead of close_requested (e2e, 2026-09-23).
const SWITCH_CLOSE_WAIT_MS = 2000;
const RESULT_SOURCES = new Set(["voice_result", "typed_result", "permission", "question", "attention", "background_voice", "background_result", "voice_notice", "mirror_result"]);
const ASK_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
// States in which a Live session exists or is being created right now.
// ("reconnecting" is not one: it only waits for the page to start a new one.)
const LIVE_STATES = new Set(["connecting", "live"]);
/** Vocabulary: collection deadline (it starts at bind time, off the critical path) and reuse window. */
const VOCAB_DEADLINE_MS = 1500;
const VOCAB_REUSE_MS = 5 * 60_000;

export const MSG = {
  noSocket: "sotto: ERROR this session has no inbox socket (CLAUDE_CODE_MESSAGING_SOCKET is unset), so voice cannot reach it.",
  usage: "sotto: usage: /talk [on|off|status|restart|quiet|milestones|walkthrough|voice [name]|app|window [auto|app|chrome]|key]",
  noKeyNoWindow: "sotto: ERROR OPENAI_API_KEY was not found. Run /talk key to add it, or export it before starting Claude Code.",
};

/** Why a restart waits, in words for /talk restart (SPEC §9.2). */
const RESTART_WAIT_WORDS = {
  delegation: "a voice request is still with Claude",
  claude_busy: "Claude is working",
  speaking: "the conversation",
  recent_speech: "the conversation",
  speech_queued: "the conversation",
  wake_queue: "a message is waiting to be spoken",
  key_check: "the API key check",
  voice_sample: "a voice sample",
};

export function newCounters() {
  return {
    delegations: 0, inbox_sent: 0, inbox_failed: 0, thinking_sent: 0, commentary_sent: 0, instructions_sent: 0,
    appends_acked: 0, appends_failed: 0, hooks: 0, sessions_created: 0, mirror_sent: 0, mirror_failed: 0, echo_guard_on: 0, echo_heard: 0,
  };
}

const fmtUsage = (seconds) => usageToday(seconds);
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

export class Voice {
  /**
   * @param {object} o
   * @param {object} o.paths       dataPaths(D)
   * @param {number} o.port
   * @param {string} o.pluginRoot
   * @param {string} o.daemonKey   written into D/active for hook.sh
   * @param {object} o.env
   * @param {object} o.clock
   * @param {Function} o.fetchImpl
   * @param {Function} o.WebSocketImpl
   * @param {{send: Function}} o.inbox
   * @param {object} o.chrome      createChrome() API
   * @param {object} o.log
   * @param {() => string|null} o.getApiKey
   * @param {object} [o.keys]      apikey.js KeyStore (sources, Keychain save/remove)
   * @param {object} o.sse         SseHub
   * @param {(reason:string) => void} o.onExit
   * @param {object} [o.owner]     liveness probe overrides {kill, statSync}
   * @param {Function} [o.execFile] for git
   */
  constructor(o) {
    Object.assign(this, {
      paths: o.paths, port: o.port, pluginRoot: o.pluginRoot, daemonKey: o.daemonKey, env: o.env || {},
      clock: o.clock, fetchImpl: o.fetchImpl, WebSocketImpl: o.WebSocketImpl, inbox: o.inbox, chrome: o.chrome,
      log: o.log, getApiKey: o.getApiKey, keys: o.keys || null, sse: o.sse, onExit: o.onExit || (() => {}),
      probe: o.owner || {}, execFile: o.execFile, requestRestart: o.requestRestart || null,
    });
    this.debug = this.env.SOTTO_DEBUG === "1";
    this.base = openaiBase(this.env);
    this.state = "off";
    this.owner = null;
    this.config = normalizeConfig({});
    this.runtimePolicy = null;
    this.live = null; // {id, started_at, expires_at, usage_seconds, muted, reason, greeted}
    this.sideband = null;
    this.counters = newCounters();
    this.lastError = null;
    // Key setup (SPEC §4.3): the page shows the "add your API key" card while
    // this is set (first run without a key, or /talk key).
    this.keySetup = false;
    this.keySaving = false;
    this.pendingResult = null;
    this.backlog = [];
    this.usage = readUsage(this.paths);
    this.usageSeen = new Map(); // live id → last usage.seconds
    this.capWarnedDate = null;
    this.lastPageActivityAt = 0;
    this.liveStartedAt = 0;
    this.lastClaudeEventAt = 0;
    this.pageHello = false;
    this.reconnects = [];
    this.offGen = 0;
    this.timers = {};
    this.lastSessionCreateAt = 0;
    // Voice chosen while live: the replacement session greets with "Switched to <voice>".
    this.voiceSwitch = null;
    this.switchGen = 0;
    this.config.voice = resolveVoice({ prefs: readPrefs(this.paths), configVoice: this.config.voice });
    // Per-bind nonce in the voice marker ("[sotto voice <nonce>]"), so a
    // peer message or typed text that merely contains the marker is not taken
    // for the user's speech. Written to D/active for hook.sh.
    this.nonce = null;
    this.retriedAppends = new Set(); // content keys already retried after append_failed
    // Glossary of names the user may say (vocabulary.js), rebuilt at every
    // session start and owner switch. Its terms also annotate delegated
    // prompts with likely mishearings.
    this.vocab = { terms: [], text: "" };
    this.vocabJob = null; // {key, at, promise}: collection started at bind time (prewarm)
    // Sleep/wake (§6.15): false-wake adaptation, and messages that must be
    // spoken although no session is open (they wake one).
    this.governor = new WakeGovernor({ clock: this.clock });
    this.wakeQueue = [];

    // Voice samples for the picker (preview.js): one small Live session per
    // voice, then a cached WAV. Never touches the live session.
    this.previews = new PreviewCache({
      dir: this.paths.previews, log: this.log,
      record: (voice) => recordPreview({
        base: this.base, apiKey: this.getApiKey(), voice, WebSocketImpl: this.WebSocketImpl, clock: this.clock, log: this.log,
        // Billed like any Live session (per second, no minimum on a WebSocket): today's usage.
        onClosed: ({ live_id, seconds }) => {
          this.log.info("preview.closed", { voice, live_id, seconds });
          if (Number.isFinite(seconds)) this.onUsage(live_id, seconds, { persist: true });
        },
      }),
    });

    this.transcript = new Transcript({ clock: this.clock });
    // The model heard its own voice (echo filter, §6.8.1): tell the page, whose
    // echo guard in `auto` engages only with this evidence (§7.7).
    this.selfEchoAt = 0;
    this.transcript.onSelfEcho = ({ words, delay_ms }) => {
      const now = this.clock.now();
      const first = now - this.selfEchoAt > 10_000;
      this.selfEchoAt = now;
      if (first) {
        this.counters.echo_heard++;
        this.log.info("echo.heard", { words, delay_ms });
        this.changed();
      }
    };
    // Every commentary goes through the speech queue, so a spoken update never
    // cuts off what the assistant is saying (§6.10.2).
    this.speech = new SpeechQueue({
      clock: this.clock, log: this.log,
      send: (a) => {
        const at = this.sideband?.lastOutputAudioAt;
        this.log.info("speech.send", { source: a.source || null, audio_age_ms: Number.isFinite(at) ? this.clock.now() - at : null });
        this.sendAppend(a);
      },
      demote: (a) => this.sendAppend({ ...a, kind: "thinking", content: BG + a.content }),
      // Not wired to output audio: measured on gpt-live-1 (e2e, 2026-09-23),
      // output audio chunks arrive continuously, silence included (the last
      // chunk was 42 ms old when the voice had been quiet for 1.2 s), which
      // held a voice answer for 9 s. The output transcript, with its
      // session-timeline end_ms, tracks audible speech.
    });
    this.narrator = new Narrator({ clock: this.clock, policy: () => this.policy, emit: (a) => this.deliver(a) });
    this.delegation = new DelegationEngine({
      clock: this.clock, transcript: this.transcript, log: this.log,
      effects: {
        inboxSend: ({ content, msgId }) => this.inboxSend(content, msgId),
        // With a delegation id it is about a voice request (an error, a held
        // message): that ranks with answers in the speech queue.
        append: (kind, content, id) => this.deliver({ kind, content, delegationId: id, source: id != null ? "voice_notice" : undefined }),
        route: (source, payload) => this.narrator.route(source, payload),
        createPendingContext: () => createPendingContext(this.paths),
        removePendingContext: () => removePendingContext(this.paths),
        setLastError: (code, message) => this.setLastError(code, message),
        notice: (level, code, text) => this.notice(level, code, text),
        checkLiveness: () => this.checkLiveness(),
        onChange: (r) => { this.sse.broadcast({ type: "delegation", id: r.id, status: r.status, text: r.text || "" }); this.changed(); },
        project: () => this.owner?.project,
        ownerSocket: () => this.owner?.socket,
        counters: this.counters,
        // Delegation ids are only valid in the Live session that created them.
        liveId: () => (this.sideband && this.sideband.state !== "closed" ? this.sideband.id : null),
        marker: () => voiceMarker(this.nonce),
        absorbed: (transcriptPath, contents) => readAbsorbed(transcriptPath, contents),
        vocabularyHint: (text) => vocabularyHint(text, this.vocab.terms),
        // A late delegation of words the mirror already sent (§6.18).
        claimMirror: () => this.mirror.claimRecent(),
      },
    });
    // Claude is waiting for the user's answer (§6.10.3): {text, at, via} or null.
    this.awaiting = null;
    // Undelegated user speech → Claude as FYI (§6.18).
    this.mirror = new Mirror({
      clock: this.clock, transcript: this.transcript, delegation: this.delegation, log: this.log,
      effects: {
        mode: () => this.mirrorMode(),
        live: () => !!(this.sideband && this.sideband.state !== "closed"),
        marker: () => voiceMarker(this.nonce),
        awaiting: () => !!this.awaiting,
        send: ({ content, msgId }) => this.inboxSend(content, msgId, "later"),
        sent: (r) => this.onMirrorSent(r),
        vocabularyHint: (text) => vocabularyHint(text, this.vocab.terms),
      },
    });
    this.statusFile = new StatusFileWriter({ paths: this.paths, clock: this.clock, get: () => this.status() });
    // Self-update (§6.17): set while this process hands over to its successor;
    // `updateCue` makes the successor's first session say it updated itself,
    // `helloNotice` is the toast for the page when it reconnects.
    this.restarting = false;
    this.updateCue = false;
    this.helloNotice = null;
  }

  get policy() { return this.runtimePolicy || this.config.speaking_policy; }

  // ---- status ------------------------------------------------------------------
  todaySeconds() { return this.usage.days[localDate(this.clock.now())] || 0; }

  status() {
    const today = localDate(this.clock.now());
    return {
      state: this.state,
      owner: ownerStatus(this.owner),
      live: this.live ? {
        session_id: this.live.id, started_at: iso(this.live.started_at), expires_at: this.live.expires_at,
        usage_seconds: this.live.usage_seconds, muted: this.live.muted,
      } : null,
      today: { date: today, seconds: Math.round(this.todaySeconds() * 10) / 10, cap_minutes: this.config.daily_cap_minutes },
      config: {
        voice: this.config.voice, idle_minutes: this.config.idle_minutes, idle_seconds: idleSecondsOf(this.config), speaking_policy: this.policy,
        daily_cap_minutes: this.config.daily_cap_minutes, wake_sensitivity: this.config.wake_sensitivity, mirror: this.mirrorMode(),
        echo_guard: this.echoGuardMode(),
      },
      claude: { busy: this.delegation.claudeBusy, last_event_at: iso(this.lastClaudeEventAt), awaiting_input: !!this.awaiting },
      page: { connected: this.sse.count > 0 || false, clients: this.sse.count },
      delegations: this.delegation.list(10),
      counters: { ...this.counters },
      last_error: this.lastError ? { ...this.lastError } : null,
      wake: { ...this.governor.status(this.config.wake_sensitivity), queued: this.wakeQueue.length },
      api_key: { source: this.keyInfo().source },
      echo: this.echoState ? { ...this.echoState } : null,
    };
  }

  pageStatus() {
    return {
      state: this.state,
      owner: this.owner ? { project: this.owner.project, cwd: this.owner.cwd } : null,
      voice: this.config.voice,
      speaking_policy: this.policy,
      idle_minutes: this.config.idle_minutes,
      idle_seconds: idleSecondsOf(this.config),
      echo_guard: this.echoGuardMode(),
      echo_heard_ms_ago: this.selfEchoAt ? this.clock.now() - this.selfEchoAt : null,
      wake: this.governor.pageConfig(this.config.wake_sensitivity, true),
      live: this.live ? { session_id: this.live.id, expires_at: this.live.expires_at, usage_seconds: this.live.usage_seconds, muted: this.live.muted } : null,
      today: { seconds: Math.round(this.todaySeconds() * 10) / 10, cap_minutes: this.config.daily_cap_minutes },
      claude: { busy: this.delegation.claudeBusy },
      last_error: this.lastError ? { code: this.lastError.code, message: this.lastError.message } : null,
      key: { ...this.keyInfo(), setup: this.keySetup },
    };
  }

  /** Key facts for the page and /talk key: never the key, at most its last four characters. */
  keyInfo() {
    if (this.keys) return this.keys.info();
    const present = !!this.getApiKey?.();
    return { present, source: present ? "env" : null, file: null, hint: null, label: null, can_change: false, can_remove: false, keychain: false };
  }

  healthz() {
    // api_key (a boolean, never the key) lets toggle.sh restart a key-less
    // daemon when the plugin settings now hold a key (it came in at spawn).
    return { ok: true, name: "sotto", version: VERSION, pid: process.pid, port: this.port, data_dir: this.paths.dir, plugin_root: this.pluginRoot, state: this.state, api_key: !!this.getApiKey() };
  }

  changed() {
    this.sse.broadcast({ type: "status", status: this.pageStatus() });
    this.statusFile.mark();
  }

  setState(s) {
    if (this.state === s) return;
    this.log.info("state", { from: this.state, to: s });
    this.state = s;
    // The speech queue waits (suspended) only across a session swap; if the
    // swap ends in anything but a new session, release what it holds (to
    // pendingResult / backlog, as without a swap).
    if (this.speech?.paused && !["reconnecting", "connecting", "live"].includes(s)) this.speech.resume();
    this.changed();
  }

  setLastError(code, message) {
    this.lastError = { code, message: message || code, at: iso(this.clock.now()) };
    this.changed();
  }

  notice(level, code, text) { this.sse.broadcast({ type: "notice", level, code, text }); }
  activity(kind, text) { this.sse.broadcast({ type: "activity", kind, text: text || "" }); }
  command(command, reason) {
    this.log.info("page.command", { command, reason });
    this.sse.broadcast({ type: "command", command, reason: reason || "" });
  }

  timer(name, fn, ms) {
    this.clear(name);
    this.timers[name] = { h: this.clock.setTimeout(() => { delete this.timers[name]; fn(); }, ms), interval: false };
  }
  interval(name, fn, ms) {
    this.clear(name);
    this.timers[name] = { h: this.clock.setInterval(fn, ms), interval: true };
  }
  clear(name) {
    const t = this.timers[name];
    if (!t) return;
    if (t.interval) this.clock.clearInterval(t.h); else this.clock.clearTimeout(t.h);
    delete this.timers[name];
  }

  // ---- outbound appends ------------------------------------------------------------
  /** Sink for every append: commentary is queued (§6.10.2), the rest goes out now. */
  deliver(action) {
    if (action.kind === "commentary") { this.speech.enqueue(action); return; }
    this.sendAppend(action);
  }

  /** Send one append. Without a Live session, results wait in pendingResult. */
  sendAppend(action) {
    const { kind, content, delegationId = null, source } = action;
    // Something the user must hear while no session is open (§6.15): queue it
    // and wake a session to say it. It is still stored as pendingResult below,
    // so the page shows it and a failed wake loses nothing.
    const wakeWorthy = kind === "commentary" && typeof content === "string" && (WAKE_SOURCES.has(source) || action.wake === true);
    if (wakeWorthy && !this.sideband && (this.state === "sleeping" || this.state === "connecting")) {
      this.wakeQueue.push({ kind, content, source: source || null });
      if (this.wakeQueue.length > MAX_WAKE_QUEUE) this.wakeQueue.shift();
      this.log.info("wake.queue", { source, queued: this.wakeQueue.length, content: truncate(content, 200) });
      if (this.state === "sleeping") this.requestWake("notify");
    }
    if (this.sideband && this.sideband.state !== "closed") {
      // Something for the model to say (a result, a note): the model needs a
      // moment to speak it, so it counts as activity for idle sleep (§6.15).
      if (kind !== "thinking") this.lastDeliverAt = this.clock.now();
      for (const part of this.fitAppend(kind, content)) {
        try { this.sideband.append(kind, part, delegationId); } catch (e) { this.log.error("append.invalid", { message: String(e.message) }); }
      }
      return;
    }
    if (kind === "commentary" && (RESULT_SOURCES.has(source) || wakeWorthy)) {
      this.pendingResult = { text: content, at: this.clock.now() };
      this.sse.broadcast({ type: "result_pending", text: content });
      this.log.info("result.pending", { source, content: truncate(content, 200) });
    } else if (kind === "thinking") {
      this.backlog.push(content);
      if (this.backlog.length > 50) this.backlog.shift();
    }
  }

  /**
   * Generic "say this to the user" (§6.15): spoken now when a session is open,
   * otherwise queued and a sleeping session is woken to say it. For features
   * that must reach the user while voice sleeps (permission prompts, questions,
   * spoken notifications). Returns "spoken" | "queued" | "pending".
   */
  notifyUser(content, { source = "notify" } = {}) {
    if (typeof content !== "string" || !content.trim()) return "pending";
    const live = !!(this.sideband && this.sideband.state !== "closed");
    this.deliver({ kind: "commentary", content, delegationId: null, source, wake: true });
    if (live) return "spoken";
    return this.wakeQueue.length ? "queued" : "pending";
  }

  /**
   * Ask the page to open a session so queued messages can be spoken.
   * Only from `sleeping` with a page listening and the daily cap not reached.
   */
  requestWake(kind = "notify") {
    if (this.state !== "sleeping" || !this.owner || this.capReached() || this.sse.count === 0) return false;
    if (this.timers.notifyWatch) return true; // already asked
    this.log.info("wake.request", { kind, queued: this.wakeQueue.length });
    this.command("connect", kind);
    this.timer("notifyWatch", () => {
      if (this.state !== "sleeping") return;
      this.log.warn("wake.request_timeout", { kind, queued: this.wakeQueue.length });
      this.wakeQueue = []; // still visible as pendingResult; seeded on the next resume
    }, NOTIFY_WATCH_MS);
    return true;
  }

  /**
   * Keep every append under the 500-token API limit (estimated). Instructions
   * are clipped; thinking/commentary over budget are split into chunks.
   */
  fitAppend(kind, content, maxTokens = MAX_APPEND_TOKENS) {
    if (typeof content !== "string" || estTokens(content) <= maxTokens) return [content];
    if (kind === "instructions") return [fitTokens(content, maxTokens)];
    return tokenChunks(content, maxTokens).slice(0, 3);
  }

  /**
   * The server rejected an append (safety net, retried at most once per text):
   *  - too long → split in half-budget chunks and resend;
   *  - otherwise, with a delegation id → resend with delegation_id null (the id
   *    may belong to an earlier Live session, which this one does not know).
   */
  onAppendFailed(sb, { kind, content, delegation_id: delegationId, error } = {}) {
    if (this.sideband !== sb || typeof content !== "string" || !content) return;
    // context_injection_incomplete while we close the session is expected noise.
    if (sb.closing) return;
    const key = `${kind}\u0000${content}`;
    if (this.retriedAppends.has(key)) return;
    this.retriedAppends.add(key);
    if (this.retriedAppends.size > 200) this.retriedAppends.delete(this.retriedAppends.values().next().value);
    const msg = `${error?.code || ""} ${error?.param || ""} ${error?.message || ""}`;
    if (/token|too long|length|exceed|maximum|max_/i.test(msg) && content.length > 40) {
      this.log.info("append.retry", { kind, reason: "too_long" });
      for (const part of this.fitAppend(kind, content, Math.floor(MAX_APPEND_TOKENS / 2))) {
        try { sb.append(kind, part, delegationId ?? null); } catch { /* ignore */ }
      }
      return;
    }
    if (delegationId != null && (kind === "commentary" || kind === "thinking")) {
      this.log.info("append.retry", { kind, reason: "delegation_id", delegation_id: delegationId });
      try { sb.append(kind, content, null); } catch { /* ignore */ }
    }
  }

  async inboxSend(content, msgId, priority = "next") {
    const o = this.owner;
    if (!o) return { ok: false, code: "no_owner" };
    const r = await this.inbox.send({ socket: o.socket, token: o.token, content, msgId, priority, log: this.log });
    this.log.info("inbox.send", { ok: r.ok, code: r.code, msg_id: msgId, length: content.length, priority });
    return r;
  }

  // ---- transcript mirror (§6.18) and "Claude is waiting" (§6.10.3) ---------------------
  /** userConfig `mirror`, overridden by env SOTTO_MIRROR (tests, e2e). */
  mirrorMode() {
    const e = this.env.SOTTO_MIRROR;
    return MIRROR_MODES.includes(e) ? e : this.config.mirror || "all";
  }

  /** userConfig `echo_guard` (§7.7), overridden by env SOTTO_ECHO_GUARD (tests, e2e). */
  echoGuardMode() {
    const e = this.env.SOTTO_ECHO_GUARD;
    return ECHO_GUARD_MODES.includes(e) ? e : this.config.echo_guard || "auto";
  }

  /**
   * Echo reports from the page (§7.7): the measured leak, the guard turning
   * on or off, and echo-test results. Logged, and the latest kept for /status.
   */
  onPageEcho(msg) {
    const num = (v, d = 1) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10 ** d) / 10 ** d : null);
    const kind = ["leak", "guard", "test", "aec"].includes(msg.kind) ? msg.kind : "leak";
    const f = {
      kind, level: typeof msg.level === "string" ? truncate(msg.level, 16) : null,
      leak_db: num(msg.leak_db), corr: num(msg.corr, 2), lag_ms: num(msg.lag_ms, 0), speech_s: num(msg.speech_s),
      engaged: typeof msg.engaged === "boolean" ? msg.engaged : undefined, reason: typeof msg.reason === "string" ? truncate(msg.reason, 40) : undefined,
      mode: typeof msg.mode === "string" ? truncate(msg.mode, 16) : undefined, output: typeof msg.output === "string" ? truncate(msg.output, 80) : undefined,
      aec: msg.aec === undefined ? undefined : truncate(String(msg.aec), 16), attenuated_pct: num(msg.attenuated_pct),
      results: Array.isArray(msg.results) ? msg.results.slice(0, 4).map((r) => ({ aec: truncate(String(r?.aec ?? ""), 16), leak_db: num(r?.leak_db), corr: num(r?.corr, 2), level: truncate(String(r?.level ?? ""), 16) })) : undefined,
    };
    for (const k of Object.keys(f)) if (f[k] === undefined || f[k] === null) delete f[k];
    this.log.info(`echo.${kind}`, f);
    this.echoState = { ...(this.echoState || {}), [kind]: { ...f, at: iso(this.clock.now()) } };
    if (kind === "guard" && f.engaged === true) this.counters.echo_guard_on++;
  }

  /** The page played something aloud outside the session (a voice sample, the echo test): the echo filter knows its words (§6.8.1). */
  onPagePlayed(msg) {
    const v = normalizeVoice(msg.voice);
    if (msg.what === "sample" || msg.what === "echo_test") {
      if (v) this.transcript.addSpoken(previewText(v), msg.what);
      this.log.info("page.played", { what: msg.what, voice: v || null });
    }
  }

  onMirrorSent({ text, lines, dropped, reason, ok, code }) {
    this.log.info("mirror.send", { ok, code: code || null, reason, lines, dropped, chars: text.length, text: truncate(text, 300) });
    if (!ok) { this.counters.mirror_failed++; return; }
    this.counters.mirror_sent++;
    if (this.delegation.claudeBusy) createPendingContext(this.paths);
    // Tell the voice model, so it can truthfully say Claude has it.
    this.deliver({ kind: "thinking", content: `[sotto] What the user just said was also passed to Claude Code as background, not as a request: "${clip(text, 240).replace(/"/g, "'")}". Claude Code will act on any decision or request in it.`, delegationId: null });
  }

  /** Claude ended its turn with a question, or asked one (AskUserQuestion): its answer matters. */
  setAwaiting(text, via) {
    const q = clip(String(text || "").trim(), 300);
    if (!q) return;
    this.awaiting = { text: q, at: this.clock.now(), via };
    this.log.info("claude.awaiting", { via, chars: q.length });
    const how = via === "ask" ? "Claude Code asked the user a question in the terminal and is waiting for the answer" : "Claude Code ended its turn with a question and is waiting for the user's answer";
    this.deliver({ kind: "thinking", content: `${BG}${how}: "${q.replace(/"/g, "'")}". The user's next words may be that answer. An answer is a decision for Claude Code: delegate it.`, delegationId: null });
    this.changed();
  }

  clearAwaiting() {
    if (!this.awaiting) return;
    this.awaiting = null;
    this.log.info("claude.awaiting", { cleared: true });
    this.deliver({ kind: "thinking", content: `${BG}Claude Code got a new message and is working again; it is no longer waiting for an answer.`, delegationId: null });
    this.changed();
  }

  // ---- /control ---------------------------------------------------------------------
  control(req = {}) {
    const action = req.action;
    this.log.info("control", { action, state: this.state });
    // Every /talk (re)starts a missing desktop-app install (SPEC §6.16), so a
    // failed or interrupted one never waits for a window to open.
    if (action !== "shutdown" && action !== "app") {
      try { this.chrome.ensureInstalled?.(); } catch (e) { this.log.warn("app.ensure_error", { message: e.message }); }
    }
    let r;
    switch (action) {
      case "toggle": {
        const s = req.session;
        r = this.owner && s && this.owner.socket === s.socket && this.state !== "off" ? this.off("user") : this.on(s, req.config);
        break;
      }
      case "on": r = this.on(req.session, req.config); break;
      case "off": r = this.off("user"); break;
      case "status": r = { ok: true, message: this.statusMessage() }; break;
      case "policy": r = this.setPolicy(req.policy); break;
      case "voice": r = req.voice == null || req.voice === "" ? { ok: true, message: voiceListMessage(this.currentVoice(req.config)) } : this.setVoice(req.voice, "control"); break;
      case "restart": r = this.manualRestart(); break;
      case "key": r = this.keyControl(req); break;
      case "window": r = this.setWindow(req.window); break;
      case "app": r = this.appControl(req); break;
      case "shutdown": {
        this.gracefulOff("shutdown");
        r = { ok: true, message: "sotto: daemon stopped." };
        break;
      }
      default: r = { ok: false, message: MSG.usage };
    }
    const out = { ok: r.ok, state: this.state, message: r.message };
    this.log.info("control.result", { action, ok: out.ok, state: out.state });
    return out;
  }

  statusMessage() {
    const u = fmtUsage(this.todaySeconds());
    const app = this.appNote();
    if (this.state === "off" || !this.owner) return `sotto: voice is off. ${u}.${app ? ` ${app}.` : ""}`;
    const st = this.state === "live" ? "ON" : this.state;
    let m = `sotto: voice ${st} (${this.owner.project}) | ${u} | voice ${this.config.voice} | ${this.policy}`;
    if (app) m += ` | ${app}`;
    if (this.lastError) m += ` | last error: ${this.lastError.message}`;
    return m;
  }

  // ---- voice window: desktop app or Chrome (SPEC §6.16) ------------------------------
  /** The window preference: prefs.json > userConfig > auto. */
  windowPref(config) {
    return resolveWindowPref({ prefs: readPrefs(this.paths), configWindow: config?.window ?? this.config.window });
  }

  /** The desktop app's state, in words, when it matters (not installed, installing, failed); else "". */
  appNote() {
    const a = this.chrome.appStatus?.();
    if (!a || this.windowPref() === "chrome" || this.windowPref() === "default") return "";
    if (a.state === "installing") return "desktop app installing";
    if (a.state === "failed") return `desktop app couldn't be installed (${a.message}); using Chrome. Retry with /talk app`;
    if (a.state === "missing" || a.state === "stale") return "desktop app not installed yet; /talk app installs it";
    return "";
  }

  /** /talk window [mode]: show or persist where the voice window opens. */
  setWindow(mode) {
    if (mode == null || mode === "") {
      const a = this.chrome.appStatus?.();
      const st = a ? ` (desktop app: ${a.state === "failed" ? `couldn't be installed, ${a.message}` : a.state})` : "";
      return { ok: true, message: `sotto: window is ${this.windowPref()}${st}. Change it with /talk window <auto|app|chrome>.` };
    }
    const w = normalizeWindow(mode);
    if (!w) return { ok: false, message: `sotto: unknown window "${String(mode).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20)}". Choose auto, app or chrome.` };
    try { writePrefs(this.paths, { window: w }); } catch (e) {
      this.log.error("prefs.write_error", { message: e.message });
      return { ok: false, message: `sotto: ERROR could not save the window choice to ${this.paths.prefs}.` };
    }
    this.log.info("window.pref", { window: w });
    let extra = "";
    if (w === "app" || w === "auto") {
      const a = this.chrome.ensureInstalled?.();
      if (a?.state === "installing") extra = " The desktop app is installing.";
    }
    return { ok: true, message: `sotto: window set to ${w}. It applies the next time the voice window opens.${extra}` };
  }

  /**
   * /talk app: persist window=app, (re)try the install, and open the voice in
   * the app. While a Chrome window hosts the voice, the switch happens at the
   * next /talk: the Live session lives in that page.
   */
  appControl(req) {
    try { writePrefs(this.paths, { window: "app" }); } catch (e) { this.log.error("prefs.write_error", { message: e.message }); }
    this.log.info("window.pref", { window: "app", via: "app" });
    let a;
    try { a = this.chrome.ensureInstalled?.({ force: true }); } catch (e) { this.log.warn("app.ensure_error", { message: e.message }); }
    if (a?.state === "unsupported") return { ok: false, message: "sotto: the desktop app needs macOS; the voice window stays in the browser." };
    if (this.owner && this.state !== "off" && this.sse.count > 0) {
      if (this.chrome.appLaunched) return { ok: true, message: "sotto: voice is already in the desktop app." };
      const when = a?.state === "installing" ? " The desktop app is installing;" : "";
      return { ok: true, message: `sotto: window set to app.${when} The voice moves to the desktop app at the next /talk (turn it off and on).` };
    }
    return this.on(req.session, req.config);
  }

  /** The detached installer finished (window.js): tell the page. */
  appInstallResult(r) {
    if (r.ok) {
      if (this.sse.count > 0 && !this.chrome.appLaunched) this.notice("info", "app_ready", "The Sotto desktop app is installed. The next /talk opens it.");
      return;
    }
    const n = { level: "warn", code: "app_install_failed", text: `Desktop app couldn't be installed: ${r.message}. Using Chrome.` };
    if (this.sse.count > 0) this.notice(n.level, n.code, n.text);
    else this.helloNotice = n;
  }

  on(session, config) {
    if (!session || typeof session.socket !== "string" || !session.socket) return { ok: false, message: MSG.noSocket };
    const prevConfig = this.config;
    this.config = normalizeConfig(config, prevConfig);
    // prefs.json (/talk voice, the page, the CLI) beats userConfig (§4.5).
    this.config.voice = resolveVoice({ prefs: readPrefs(this.paths), configVoice: this.config.voice });
    this.clear("exit");
    if (this.state === "closing") this.offGen++; // cancel the tail of an in-flight off

    const old = this.owner;
    const same = !!old && old.socket === session.socket;
    const next = makeOwner(session, same ? old.since : this.clock.now());
    if (!same || !this.nonce) this.nonce = randomBytes(6).toString("hex");
    if (same) {
      this.owner = next;
    } else if (old) {
      // Owner switch (§6.5): orphan old requests, rebind, tell the voice model.
      // Nothing about the old session's turn carries over: its Stop will never
      // reach us (hook.sh gates on the owner), and its pending-context flag
      // must not be claimed by the new owner's next tool call.
      this.delegation.orphanAll();
      this.delegation.resetClaudeState();
      this.mirror.discard(); // words said to the old project are not the new one's business
      this.awaiting = null;
      this.narrator.resetTurn();
      removePendingContext(this.paths);
      this.owner = next;
      this.log.info("owner.switch", { from: old.project, to: next.project, session_id: next.session_id });
      if (this.sideband) this.deliver({ kind: "instructions", content: ownerSwitchInstruction(next.project), delegationId: null });
      this.refreshVocabulary(next);
    } else {
      this.owner = next;
      this.log.info("owner.bind", { project: next.project, session_id: next.session_id });
    }
    try { writeActive(this.paths, { socket: next.socket, port: this.port, key: this.daemonKey, nonce: this.nonce }); } catch (e) { this.log.error("active.write_error", { message: e.message }); }
    this.vocabularyFor(next);
    this.interval("liveness", () => { this.delegation.sweepStale(); this.checkLiveness(); }, LIVENESS_MS);
    const project = next.project;
    const moved = !same && old ? `sotto: voice ON (${project}), moved from ${old.project}.` : null;
    // A session exists or is being created. "reconnecting" without a sideband
    // is NOT live: the page may have missed the one-shot reconnect command, so
    // it falls through to the connect/open-window path below.
    const hasLive = !!this.sideband || LIVE_STATES.has(this.state);

    this.keys?.refresh(); // a key added to the Keychain from a terminal counts at once
    if (!this.getApiKey()) {
      // First run: bind, stay paused, and open the window at the key setup
      // card (SPEC §4.3). Saving a key there connects.
      this.setLastError("no_api_key", "OPENAI_API_KEY was not found");
      if (!hasLive) this.setState("paused");
      if (!this.keyInfo().keychain) return { ok: false, message: MSG.noKeyNoWindow };
      return { ok: false, message: this.openKeySetup(`sotto: voice ON (${project}), but there is no OpenAI API key yet.`) };
    }
    this.keySetup = false;
    if (this.capReached()) {
      this.setLastError("daily_cap", "Daily voice cap reached");
      if (!hasLive) this.setState("paused");
      return { ok: false, message: `sotto: daily voice cap reached (${this.config.daily_cap_minutes} min). Raise daily_cap_minutes in /config to continue.` };
    }
    if (this.lastError && (this.lastError.code === "no_api_key" || this.lastError.code === "daily_cap")) this.lastError = null;

    if (hasLive) {
      this.changed();
      if (same && this.state === "live") return { ok: true, message: `sotto: voice is already ON here (${project}).` };
      return { ok: true, message: moved || `sotto: voice ON (${project}).` };
    }

    // No Live session: ask the page to connect, or open the window.
    this.setState("waiting_page");
    this.changed();
    let msg = `sotto: voice ON (${project}).`;
    if (this.sse.count > 0) {
      this.command("connect", "on");
    } else if (this.config.open_browser) {
      const r = this.chrome.open();
      if (r && r.mode !== "none") msg = `sotto: voice ON (${project}). Opening the voice window.`;
      if (r?.pending) msg = `sotto: voice ON (${project}). Installing the desktop app (signed release, about 350 KB); the window opens when it is ready.`;
      else if (r?.installError) {
        msg = `sotto: voice ON (${project}). Desktop app couldn't be installed (${r.installError.message}); using Chrome.`;
        this.helloNotice = { level: "warn", code: "app_install_failed", text: `Desktop app couldn't be installed: ${r.installError.message}. Using Chrome.` };
      }
      if (r && r.warn) this.log.warn("chrome.fallback", { message: "Google Chrome not found; echo cancellation may be worse in the default browser" });
    }
    this.timer("waitingPage", () => this.onPageTimeout(), WAITING_PAGE_MS);
    return { ok: true, message: moved || msg };
  }

  onPageTimeout() {
    if (this.state !== "waiting_page") return;
    // The window is held for a desktop-app install in flight (window.js): it
    // opens (app, or Chrome at the wait's deadline) before any page can come.
    if (this.chrome.pending) { this.timer("waitingPage", () => this.onPageTimeout(), WAITING_PAGE_MS); return; }
    this.setLastError("page_timeout", "The voice window did not connect");
    this.notice("warn", "page_timeout", "The voice window did not connect.");
    this.chrome.notify?.("Voice window did not connect");
  }

  off(reason) {
    if (this.state === "off" && !this.owner) return { ok: true, message: "sotto: voice is already off." };
    const msg = `sotto: voice OFF. ${fmtUsage(this.todaySeconds())}.`;
    this.gracefulOff(reason);
    return { ok: true, message: msg };
  }

  setPolicy(policy) {
    if (!POLICIES.includes(policy)) return { ok: false, message: MSG.usage };
    this.runtimePolicy = policy;
    this.log.info("policy", { policy });
    if (this.sideband) this.narrator.route("policy_change", { policy });
    this.changed();
    return { ok: true, message: `sotto: speaking policy is now ${policy}.` };
  }

  // ---- API key (§4.3) -----------------------------------------------------------------------
  /**
   * Show the key setup card: in the connected page, or in a newly opened
   * window. Returns `lead` plus where to type the key.
   */
  openKeySetup(lead) {
    this.keySetup = true;
    this.changed();
    if (this.sse.count > 0) return `${lead} Add it in the voice window; it is saved in your macOS Keychain.`;
    if (this.config.open_browser === false) return `${lead} Run /talk key to add it.`;
    const r = this.chrome.open();
    if (r && r.mode === "none") return `${lead} Open the voice window to add it.`;
    return `${lead} Opening the voice window so you can add it; it is saved in your macOS Keychain.`;
  }

  /**
   * /talk key: where the key comes from. `setup` (the user typed something
   * after "key", which is never read) or no key at all opens the setup card.
   */
  keyControl(req) {
    this.keys?.refresh();
    const info = this.keyInfo();
    this.log.info("key.status", { source: info.source, setup: !!req.setup });
    const setup = !!req.setup || !info.present;
    if (!setup) {
      const change = info.can_change ? " Change or remove it in the voice window settings." : info.source === "env" ? " Change it where OPENAI_API_KEY is exported." : " Change it in that file.";
      return { ok: true, message: `sotto: using the OpenAI API key ending in ${info.hint || "????"} from ${keyWhere(info)}.${change}` };
    }
    const lead = req.setup
      ? "sotto: API keys are never read from /talk arguments (what you typed stays in your prompt history; rotate the key if it was real)."
      : "sotto: no OpenAI API key found.";
    if (!info.keychain) return { ok: false, message: `${lead} Export OPENAI_API_KEY or add it to ${this.pluginRoot}/.env, then run /talk on.` };
    if (info.present && !info.can_change) {
      return { ok: true, message: `${lead} The key in use comes from ${keyWhere(info)}; change it there.` };
    }
    return { ok: !!req.setup || info.present, message: this.openKeySetup(lead) };
  }

  /**
   * POST /api/key from the page: check the key with OpenAI, store it in the
   * Keychain, and connect if voice is waiting for it. Returns {status, body};
   * the body never contains the key.
   */
  async saveKey(raw) {
    const err = (status, code, message) => ({ status, body: { error: { code, message } } });
    const key = normalizeKeyInput(raw);
    if (!key) return err(400, "bad_key_format", "That does not look like an OpenAI API key. Keys start with sk-.");
    if (!this.keys || !this.keyInfo().keychain) return err(501, "keychain_unavailable", "Saving a key needs the macOS Keychain. Export OPENAI_API_KEY before starting Claude Code instead.");
    if (this.keySaving) return err(409, "busy", "Already checking a key.");
    this.keySaving = true;
    const t0 = this.clock.now();
    try {
      const v = await validateKey({ base: this.base, key, fetchImpl: this.fetchImpl, clock: this.clock });
      this.log.info("key.check", { ok: v.ok, code: v.code, ms: this.clock.now() - t0 });
      if (!v.ok) return err(v.code === "network" ? 504 : 400, v.code, v.message);
      const saved = this.keys.save(key);
      if (!saved.ok) {
        this.log.error("key.save_error", { message: saved.message });
        return err(500, "keychain_error", `Could not save the key in the macOS Keychain. ${saved.message}`);
      }
      const info = this.keyInfo();
      this.log.info("key.saved", { source: info.source });
      this.keySetup = false;
      if (this.lastError && (this.lastError.code === "no_api_key" || this.lastError.code === "openai_auth")) this.lastError = null;
      let connecting = false;
      // paused: the first run (on() without a key). waiting_page: a page whose
      // session create failed with no_api_key (the key was removed meanwhile).
      if (this.owner && (this.state === "paused" || this.state === "waiting_page") && !this.capReached()) {
        this.setState("waiting_page");
        this.command("connect", "key");
        this.timer("waitingPage", () => this.onPageTimeout(), WAITING_PAGE_MS);
        connecting = true;
      }
      this.changed();
      let message = connecting ? "Key saved. Connecting…" : this.owner ? "Key saved." : "Key saved. Run /talk on in Claude Code to start talking.";
      if (info.source !== "keychain") message = `Key saved in the Keychain, but the key from ${keyWhere(info)} is used first.`;
      return { status: 200, body: { ok: true, connecting, message, key: info } };
    } finally {
      this.keySaving = false;
    }
  }

  /** POST /api/key/remove: delete the Keychain key (the only source the page may change). */
  removeKey() {
    const before = this.keyInfo();
    if (!before.can_remove) {
      return { status: 409, body: { error: { code: "not_removable", message: `The key in use comes from ${keyWhere(before)}; sotto can only remove a key it saved in the Keychain.` } } };
    }
    const r = this.keys.remove();
    const info = this.keyInfo();
    this.log.info("key.removed", { ok: r.ok, source: info.source });
    if (!r.ok) return { status: 500, body: { error: { code: "keychain_error", message: "Could not remove the key from the macOS Keychain." } } };
    this.changed();
    const message = info.present
      ? `Key removed from the Keychain. Now using the key from ${keyWhere(info)}.`
      : "Key removed. The current voice session keeps running; the next one needs a key.";
    return { status: 200, body: { ok: true, message, key: info } };
  }

  // ---- voice (§4.5, §6.14) ------------------------------------------------------------------
  /**
   * The voice in effect. While an owner is bound it is the session config
   * (already merged with prefs); otherwise prefs > the caller's userConfig > default.
   */
  currentVoice(config) {
    if (this.owner) return this.config.voice;
    return resolveVoice({ prefs: readPrefs(this.paths), configVoice: config?.voice ?? this.config.voice });
  }

  /** {voices, current, live, switching} for GET /api/voices. */
  voices() {
    return {
      voices: [...VOICES],
      current: this.currentVoice(),
      live: !!(this.live && this.sideband),
      live_voice: this.live?.voice || null,
    };
  }

  /**
   * A short sample of `name` for GET /api/voice-preview. Returns
   * {status, wav} or {status, body:{error}}. The first request per voice
   * records it (about 4 s, billed about 4 s and booked to today's usage);
   * later ones read the cached file.
   */
  async voicePreview(name, { cachedOnly = false } = {}) {
    const v = normalizeVoice(name);
    if (!v) return { status: 400, body: { error: { code: "bad_voice", message: unknownVoiceMessage(name) } } };
    if (cachedOnly && !this.previews.has(v)) return { status: 404, body: { error: { code: "not_cached", message: "No sample of this voice has been recorded yet." } } };
    if (!this.previews.has(v)) {
      if (!this.getApiKey()) return { status: 503, body: { error: { code: "no_api_key", message: "OPENAI_API_KEY was not found." } } };
      if (this.capReached()) return { status: 429, body: { error: { code: "daily_cap", message: `Daily voice cap reached (${this.config.daily_cap_minutes} min).` } } };
    }
    const r = await this.previews.get(v);
    this.log.info("preview.serve", { voice: v, ok: r.ok, cached: !!r.cached, bytes: r.wav ? r.wav.length : 0 });
    if (!r.ok) return { status: 502, body: { error: { code: r.code || "preview_failed", message: r.message || "The voice sample failed." } } };
    return { status: 200, wav: r.wav };
  }

  /**
   * Persist a voice choice (prefs.json) and apply it. gpt-live-1's
   * audio.output.voice cannot change after startup (Live API reference,
   * developers.openai.com/api/reference/resources/live/primary-websocket:
   * voice and format "are immutable after startup"), so a live session is re-created:
   * the old one is closed, the page is asked to reconnect, and the new
   * session is seeded with the recent conversation and confirms in the new voice.
   * Returns {ok, message, voice, switching}.
   */
  setVoice(name, source = "control") {
    const v = normalizeVoice(name);
    if (!v) return { ok: false, message: unknownVoiceMessage(name), code: "bad_voice" };
    const prev = this.currentVoice();
    try { writePrefs(this.paths, { voice: v }); } catch (e) { this.log.error("prefs.write_error", { message: e.message }); }
    this.config = { ...this.config, voice: v };
    this.log.info("voice.set", { voice: v, from: prev, source, state: this.state });
    const switching = this.state === "live" && !!this.sideband && !!this.live && this.live.voice !== v;
    if (switching) this.switchLiveVoice(v);
    else if (this.state === "reconnecting") this.voiceSwitch = v; // the replacement confirms the new voice
    this.changed();
    let message;
    if (switching) message = `sotto: voice set to ${v}. Switching the live session now.`;
    else if (prev === v && (!this.live || this.live.voice === v)) message = `sotto: voice is already ${v}.`;
    else if (LIVE_STATES.has(this.state) || this.state === "reconnecting") message = `sotto: voice set to ${v}. The session switches as soon as it is ready.`;
    else message = `sotto: voice set to ${v}. It applies to the next voice session.`;
    return { ok: true, message, voice: v, switching };
  }

  /**
   * Re-create the Live session in the configured voice. Same shape as the
   * reconnect path (§6.11) but not counted against the 3-per-10-min limit:
   * the old session is closed without waiting (its session.closed still
   * books usage), and the page re-offers with reason "reconnect", so the seed
   * carries the recent voice history. The greeting is voiceSwitchGreeting.
   */
  switchLiveVoice(v) {
    this.log.info("voice.switch", { voice: v, from: this.live?.voice || null });
    const old = this.sideband;
    this.sideband = null;
    this.stopLiveTimers();
    this.speech.suspend();
    this.live = null;
    this.voiceSwitch = v;
    this.notice("info", "voice_change", `Switching to the ${v} voice.`);
    this.setState("reconnecting");
    // Close first, reconnect after session.closed (at most SWITCH_CLOSE_WAIT_MS):
    // the page's reconnect tears down the old peer connection, and a server that
    // sees the media drop before it has processed session.close ends the
    // session as connection_lost / remote_hangup.
    const gen = ++this.switchGen;
    const t0 = this.clock.now();
    const go = (confirmed) => {
      if (gen !== this.switchGen || this.state !== "reconnecting" || this.sideband) return;
      this.log.info("voice.switch_closed", { confirmed, ms: this.clock.now() - t0 });
      this.requestReconnect("voice_change");
    };
    if (!old) { go(false); return; }
    old.close(SWITCH_CLOSE_WAIT_MS).then((r) => go(!!r?.confirmed), () => go(false));
  }

  // ---- owner liveness / SessionEnd --------------------------------------------------------
  checkLiveness() {
    if (!this.owner) return true;
    const alive = isOwnerAlive(this.owner, this.probe);
    if (!alive) {
      this.log.info("owner.gone", { project: this.owner.project });
      if (this.state !== "closing") this.gracefulOff("owner_gone");
    }
    return alive;
  }

  onSessionEnd(reason) {
    if (reason === "clear" || reason === "resume") return;
    const owner = this.owner;
    this.timer("sessionEnd", () => {
      if (this.owner !== owner || !owner) return;
      if (isOwnerAlive(owner, this.probe)) return;
      this.deliver({ kind: "commentary", content: `The Claude Code session for ${owner.project} ended, so voice is turning off.`, delegationId: null });
      this.timer("sessionEndOff", () => { if (this.owner === owner) this.gracefulOff("owner_gone"); }, 4000);
    }, 3000);
  }

  // ---- hooks --------------------------------------------------------------------------------
  handleHook(event, body, socketHeader, bytes = 0) {
    this.counters.hooks++;
    const b = body && typeof body === "object" ? body : {};
    const f = { event, bytes };
    if (b.tool_name) f.tool_name = b.tool_name;
    this.log.info("hook", f);
    if (this.debug) this.log.debug("hook.body", { event, body: b });
    if (!this.owner || socketHeader !== this.owner.socket) return false;
    if (typeof b.session_id === "string") this.owner.session_id = b.session_id;
    if (typeof b.transcript_path === "string") this.owner.transcript_path = b.transcript_path;
    this.lastClaudeEventAt = this.clock.now();
    const wasBusy = this.delegation.claudeBusy;

    // Notification-style events (§6.10.1). They never touch busy/delivery
    // state. SubagentStop always carries agent_id, so it is handled here,
    // before the subagent branch below.
    if (this.handleNoticeHook(event, b)) { this.statusFile.mark(); return true; }

    // Subagent hooks (agent_id set) run in the owner's env too. They say
    // nothing about the main thread's turn, so they never touch busy/delivery
    // state or the held main-thread message; only show progress, and still
    // announce permission prompts and questions (the user must answer those).
    if (typeof b.agent_id === "string" && b.agent_id) {
      if (event === "PreToolUse" && ASK_TOOLS.has(b.tool_name)) this.onAsk(b);
      else if (event === "PreToolUse") this.activity("tool", `helper agent: ${milestoneLabel(b.tool_name, b.tool_input)}`);
      else if (event === "PermissionRequest") {
        if (ASK_TOOLS.has(b.tool_name)) this.onAsk(b);
        const label = this.narrator.onPermission(b.tool_name, b.tool_input);
        if (label) this.activity("permission", `Claude needs approval to ${label}`);
      }
      this.statusFile.mark();
      return true;
    }

    switch (event) {
      case "UserPromptSubmit":
        this.delegation.onHook(event, b);
        if (!this.delegation.wasStopped(b.prompt_id)) {
          this.narrator.onTurnStart();
          this.clearAwaiting();
        }
        this.activity("turn_start", "Claude is working");
        break;
      case "PreToolUse": {
        this.delegation.onHook(event, b);
        if (ASK_TOOLS.has(b.tool_name)) { this.onAsk(b); break; }
        const label = this.narrator.onToolUse(b.tool_name, b.tool_input);
        this.activity("tool", label);
        break;
      }
      case "PermissionRequest": {
        this.delegation.onHook(event, b);
        if (ASK_TOOLS.has(b.tool_name)) this.onAsk(b);
        const label = this.narrator.onPermission(b.tool_name, b.tool_input);
        if (label) this.activity("permission", `Claude needs approval to ${label}`);
        break;
      }
      case "MessageDisplay":
        // Hook POSTs race; a batch of a message/turn that already ended is dropped.
        if (!this.narrator.onMessageDisplay(b)) { this.log.debug("hook.late", { event }); break; }
        this.delegation.onHook(event, b);
        if (typeof b.delta === "string" && b.delta.trim()) this.activity("text", truncate(b.delta.trim(), 160));
        break;
      case "Stop": {
        const q = awaitingQuestion(b.last_assistant_message);
        if (q) this.setAwaiting(q, "stop");
        else if (this.awaiting) { this.awaiting = null; this.changed(); } // an AskUserQuestion answered in the terminal
        this.narrator.flushMilestones();
        this.narrator.onStop(b);
        this.activity("turn_end", "Claude finished");
        this.delegation.onStop(b).catch((e) => this.log.error("stop.error", { message: String(e && e.message) }));
        break;
      }
      case "StopFailure":
        this.narrator.onStop(b);
        this.activity("turn_end", "Claude hit an error");
        this.delegation.onStopFailure(b);
        break;
      case "SessionEnd":
        this.onSessionEnd(b.reason);
        break;
      default:
        return false;
    }
    if (wasBusy !== this.delegation.claudeBusy) this.changed();
    else this.statusFile.mark();
    return true;
  }

  /** AskUserQuestion / ExitPlanMode: speak the question (attached to the voice request it serves). */
  onAsk(b) {
    const delegationId = typeof b.agent_id === "string" && b.agent_id ? null : this.delegation.activeVoiceId(b.prompt_id);
    const text = this.narrator.onQuestion(b.tool_name, b.tool_input, { toolUseId: b.tool_use_id, delegationId });
    if (text) this.setAwaiting(text.replace(/^Claude's asking: /, "").replace(/ Answer in the terminal\.$/, ""), "ask");
    if (text) this.activity("question", b.tool_name === "ExitPlanMode" ? "Claude's plan needs your approval" : "Claude is asking you a question");
  }

  /**
   * Notification, Elicitation, SubagentStop, TaskCompleted, TeammateIdle and
   * PostToolUseFailure (§6.10.1). Returns false for any other event.
   */
  handleNoticeHook(event, b) {
    switch (event) {
      case "Notification": {
        const r = this.narrator.onNotification(b);
        this.log.info("notification", { type: typeof b.notification_type === "string" ? b.notification_type : null, result: r });
        if (r === "spoken") this.activity("attention", "Claude Code needs your attention");
        return true;
      }
      case "Elicitation": {
        const delegationId = this.delegation.activeVoiceId(b.prompt_id);
        if (this.narrator.onAttention("elicitation", elicitationSpeech(b), delegationId)) this.activity("attention", `${serverName(b.mcp_server_name)} needs your input`);
        return true;
      }
      case "SubagentStop": {
        // Internal agents (prompt suggestions, /btw) report an empty agent_type.
        const type = typeof b.agent_type === "string" ? b.agent_type.trim() : "";
        if (!type) return true;
        const bg = Array.isArray(b.background_tasks) ? b.background_tasks.find((t) => t && t.id === b.agent_id) : null;
        const name = clip(speakable(bg && bg.description ? `the "${bg.description}" agent` : `the ${type} agent`).replace(/[.!?…]+$/, ""), 80);
        const detail = typeof b.last_assistant_message === "string" ? summary(b.last_assistant_message, 300) : "";
        // A background agent's completion also arrives as a task-notification
        // turn whose Stop is spoken (background_voice/background_result), so
        // announcing it here too would say the same thing twice.
        this.narrator.onCompletion({ what: name, detail, level: bg ? "walkthrough" : "milestones" });
        this.activity("subagent", `${name} finished`);
        return true;
      }
      case "TaskCompleted": {
        const subject = clip(speakable(b.task_subject || "").replace(/[.!?…]+$/, ""), 80);
        if (!subject) return true;
        const who = typeof b.teammate_name === "string" && b.teammate_name ? clip(speakable(b.teammate_name).replace(/[.!?…]+$/, ""), 40) : "";
        // A checklist tick is frequent: spoken in walkthrough; a teammate's task at milestones.
        this.narrator.onCompletion({ what: who ? `${who}'s task "${subject}"` : `the task "${subject}"`, detail: "", level: who ? "milestones" : "walkthrough" });
        this.activity("task", `Task done: ${subject}`);
        return true;
      }
      case "TeammateIdle": {
        const who = clip(speakable(b.teammate_name || "").replace(/[.!?…]+$/, ""), 40);
        if (who) this.narrator.onCompletion({ what: `the ${who} teammate`, detail: "", level: "walkthrough" });
        return true;
      }
      case "PostToolUseFailure": {
        if (b.is_interrupt === true) return true;
        if (typeof b.agent_id === "string" && b.agent_id) return true; // a helper agent handles its own failures
        const label = this.narrator.onToolFailure(b.tool_name, b.tool_input, b.error);
        this.activity("tool_failed", `${label} failed`);
        return true;
      }
      default:
        return false;
    }
  }

  // ---- page events ----------------------------------------------------------------------
  handlePage(msg = {}) {
    const t = msg.type;
    if (t !== "activity" && t !== "log" && t !== "wake_audio" && t !== "wake_timing" && t !== "echo" && t !== "played") this.log.info("page", { type: t, state: msg.state, name: msg.name, muted: msg.muted });
    switch (t) {
      case "hello":
        this.pageHello = true;
        if (this.helloNotice) { const n = this.helloNotice; this.helloNotice = null; this.notice(n.level, n.code, n.text); }
        this.changed();
        break;
      case "mic_ok": this.log.info("page.mic_ok", { input: truncate(msg.input_label, 120), output: truncate(msg.output_label, 120), aec: msg.aec === undefined ? undefined : truncate(String(msg.aec), 16) }); break;
      case "mic_error": {
        const denied = /NotAllowed|Permission|Security/i.test(String(msg.name || ""));
        this.setLastError(denied ? "mic_denied" : "mic_error", truncate(String(msg.message || msg.name || "microphone error"), 200));
        this.clear("waitingPage");
        if (this.state !== "off" && this.state !== "closing") this.setState("paused");
        break;
      }
      case "rtc_state": this.onRtcState(msg.state); break;
      case "dc_open": case "dc_closed": break;
      case "muted": if (this.live) { this.live.muted = !!msg.muted; this.changed(); } break;
      case "activity": this.lastPageActivityAt = this.clock.now(); break;
      case "pause": this.pause("pause"); break;
      case "stop": this.off("user"); break;
      case "set_policy": this.setPolicy(msg.policy); break;
      case "set_wake": this.setWakeSensitivity(msg.sensitivity); break;
      case "wake_audio": this.onWakeAudio(msg).catch((e) => this.log.error("wake.error", { message: String(e && e.message) })); break;
      case "wake_timing": this.onWakeTiming(msg); break;
      case "echo": this.onPageEcho(msg); break;
      case "played": this.onPagePlayed(msg); break;
      case "log": {
        const lvl = msg.level === "error" ? "error" : msg.level === "warn" ? "warn" : "info";
        this.log[lvl]("page.log", { src: "page", message: truncate(String(msg.message ?? ""), 500) });
        break;
      }
      case "unload":
        if (this.sideband) this.pause("unload", { command: false });
        break;
      default: break;
    }
  }

  onRtcState(state) {
    if (state === "failed") {
      this.clear("rtcDisconnect");
      if (this.state === "live") this.reconnect("rtc_failed");
    } else if (state === "disconnected") {
      if (this.state === "live") this.timer("rtcDisconnect", () => { if (this.state === "live") this.reconnect("rtc_disconnected"); }, RTC_DISCONNECT_MS);
    } else if (state === "connected") {
      this.clear("rtcDisconnect");
    }
  }

  // ---- Live session creation (/api/session) --------------------------------------------
  capReached() {
    const cap = this.config.daily_cap_minutes;
    return cap > 0 && this.todaySeconds() >= cap * 60;
  }

  /** Returns {status, body}. Never waits for the sideband. */
  async createSession({ sdp, reason, wake } = {}) {
    if (typeof sdp !== "string" || !sdp.trim()) return { status: 400, body: { error: { code: "bad_sdp", message: "Missing SDP offer" } } };
    if (!this.owner) return { status: 409, body: { error: { code: "not_active", message: "Voice is not on. Run /talk on in Claude Code." } } };
    if (this.capReached()) return { status: 429, body: { error: { code: "daily_cap", message: `Daily voice cap reached (${this.config.daily_cap_minutes} min).` } } };
    const apiKey = this.getApiKey();
    if (!apiKey) {
      this.setLastError("no_api_key", "OPENAI_API_KEY was not found");
      return { status: 503, body: { error: { code: "no_api_key", message: "OPENAI_API_KEY was not found." } } };
    }
    if (this.restarting) return { status: 503, body: { error: { code: "restarting", message: "Sotto is updating; the voice comes back in a moment." } } };
    const why = SESSION_REASONS.includes(reason) ? reason : "start";
    this.clear("waitingPage");
    this.clear("notifyWatch");
    if (why === "wake" || why === "notify") this.logWakeRequest(why, wake);

    // An older session still open: close it, but do not wait.
    if (this.sideband) {
      const old = this.sideband;
      this.sideband = null;
      old.close(15000).catch(() => {});
    }
    this.stopLiveTimers();
    this.setState("connecting");

    const owner = this.owner;
    const branchP = gitBranch(owner.cwd, this.execFile ? { execFile: this.execFile } : {});
    const [branch, exchanges, vocab] = await Promise.all([
      branchP,
      Promise.resolve().then(() => readTranscriptTail(owner.transcript_path)),
      this.vocabularyFor(owner, branchP),
    ]);
    if (this.owner !== owner || this.state !== "connecting") {
      return { status: 409, body: { error: { code: "not_active", message: "Voice was turned off." } } };
    }
    // Queued messages are spoken right after the session is ready (flushed as
    // commentary), so the pending result is not seeded a second time.
    // The voice history goes in as assistant/user messages (already spoken);
    // a pending result the voice already said is not handed over again.
    const pending = this.pendingResult && !this.wakeQueue.length && !this.speech.wasSpoken(this.pendingResult.text) ? this.pendingResult.text : null;
    const seed = buildSeedInput({
      project: owner.project, cwd: owner.cwd, branch, reason: why, exchanges,
      voiceHistory: this.transcript.recentLines(30),
      pendingResult: pending,
      backlog: this.backlog,
      awaiting: this.awaiting ? this.awaiting.text : null,
      estTokens,
    });
    this.vocab = vocab;
    const instructions = renderForPolicy(owner.project, this.policy, vocab.text);
    const voice = this.config.voice;
    const body = buildSessionBody({ instructions, seed, voice, sdp });
    this.lastSessionCreateAt = this.clock.now();
    const res = await createLiveSession({ base: this.base, apiKey, body, fetchImpl: this.fetchImpl, clock: this.clock });
    this.log.info("session.create", { ms: res.ms, status: res.status ?? null, ok: res.ok, model: body.session.model, live_id: res.id || null, code: res.code || null, reason: why, voice });

    if (!res.ok) {
      this.setLastError(res.code, res.message);
      this.notice("error", res.code, res.message);
      if (this.state === "connecting") this.setState("paused");
      return { status: res.httpStatus, body: { error: { code: res.code, message: res.message } } };
    }
    if (this.owner !== owner || this.state !== "connecting") {
      // Turned off while the POST was in flight: attach just to close it.
      this.attachSideband(res.id, why, apiKey).close(15000).catch(() => {});
      this.sideband = null;
      return { status: 409, body: { error: { code: "not_active", message: "Voice was turned off." } } };
    }

    this.counters.sessions_created++;
    // Words of the old session not yet sent anywhere go now: the new session's
    // timeline restarts at 0 (§6.18).
    this.mirror.flush("new_session");
    this.transcript.newSession();
    this.delegation.resetTimeline();
    this.mirror.resetTimeline();
    const now = this.clock.now();
    this.live = { id: res.id, started_at: now, expires_at: Math.floor(now / 1000) + 7200, usage_seconds: 0, muted: false, reason: why, greeted: false, voice, wakeHandled: false };
    this.governor.onWake(why === "wake" ? "voice" : why === "notify" ? "notify" : why);
    this.usageSeen.set(res.id, 0);
    // pendingResult and backlog were seeded into the new session.
    this.pendingResult = null;
    this.backlog = [];
    if (this.lastError && /^openai_|page_timeout|mic_/.test(this.lastError.code)) this.lastError = null;
    this.attachSideband(res.id, why, apiKey);
    this.changed();
    return { status: 201, body: { session_id: res.id, sdp: res.sdp } };
  }

  /**
   * Glossary for `owner` (vocabulary.js). Collection starts when the owner
   * binds (`on`), long before the page asks for a session, so a cold file
   * cache or a large plugin cache does not delay the session start; measured
   * in a cold daemon, a 200 ms deadline at session start cut plugins off. A
   * result younger than 5 minutes for the same session and folder is reused
   * (resume, reconnect). Never throws. SOTTO_VOCAB=0 turns it off.
   */
  vocabularyFor(owner, branch) {
    const key = `${owner.socket}\n${owner.cwd || ""}`;
    const j = this.vocabJob;
    if (j && j.key === key && this.clock.now() - j.at < VOCAB_REUSE_MS) return j.promise;
    const branchP = branch ?? gitBranch(owner.cwd, this.execFile ? { execFile: this.execFile } : {});
    const promise = this.loadVocabulary(owner, branchP);
    this.vocabJob = { key, at: this.clock.now(), promise };
    return promise;
  }

  async loadVocabulary(owner, branch) {
    if (this.env.SOTTO_VOCAB === "0") return { terms: [], text: "" };
    try {
      const v = await collectVocabulary({ home: this.env.HOME, cwd: owner.cwd, dataDir: this.paths.dir, project: owner.project, branch, deadlineMs: VOCAB_DEADLINE_MS });
      const text = renderVocabulary(v.terms);
      this.log.info("vocabulary", { terms: v.terms.length, counts: v.counts, ms: v.ms, partial: v.partial, tokens: Math.round(estTokens(text)) });
      return { terms: v.terms, text };
    } catch (e) {
      this.log.warn("vocabulary.error", { message: e && e.message });
      return { terms: [], text: "" };
    }
  }

  /** After an owner switch: new terms for matching, and the new project's own names for the running session. */
  refreshVocabulary(owner) {
    this.vocabularyFor(owner).then((v) => {
      if (this.owner?.socket !== owner.socket) return;
      this.vocab = v;
      if (!this.sideband) return;
      // The switch instruction already names the project itself.
      const own = v.terms.filter((t) => t.tier <= TIER.folder && t.kinds[0] !== "project");
      const content = vocabularyUpdateInstruction(renderVocabulary(own, { maxTokens: 380 }));
      if (content) this.deliver({ kind: "instructions", content, delegationId: null });
    }).catch(() => {});
  }

  attachSideband(id, reason, apiKey) {
    const sb = new Sideband({
      id, url: `${wssBase(this.base)}/live/sessions/${encodeURIComponent(id)}/attach`, apiKey,
      WebSocketImpl: this.WebSocketImpl, clock: this.clock, log: this.log, counters: this.counters, debug: this.debug,
    });
    this.sideband = sb;
    sb.on("ready", (r) => this.onSidebandReady(sb, reason, r));
    sb.on("event", (evt) => this.onLiveEvent(sb, evt));
    sb.on("session_closed", (r) => this.onSessionClosed(sb, r));
    sb.on("append_failed", (f) => this.onAppendFailed(sb, f));
    sb.on("lost", () => { if (this.sideband === sb) { this.sideband = null; this.reconnect("sideband_lost"); } });
    sb.connect();
    return sb;
  }

  onSidebandReady(sb, reason, { expires_at }) {
    if (this.sideband !== sb || !this.live) return;
    if (expires_at) this.live.expires_at = expires_at;
    this.liveStartedAt = this.clock.now();
    this.setState("live");
    // The voice changed while this session was being created: switch again
    // right away (no greeting in the voice the user just left).
    if (this.live.voice !== this.config.voice) {
      this.switchLiveVoice(this.config.voice);
      return;
    }
    if (!this.live.greeted) {
      this.live.greeted = true;
      const switched = reason === "reconnect" && this.voiceSwitch === this.live.voice;
      this.voiceSwitch = null;
      // The first session after a self-update (§6.17) says so, once.
      const updated = this.updateCue && (reason === "reconnect" || reason === "resume");
      this.updateCue = false;
      const g = switched ? voiceSwitchGreeting(this.live.voice) : updated ? updateGreeting() : greeting(reason, this.policy, this.owner?.project);
      if (g) this.deliver({ kind: "instructions", content: g, delegationId: null });
      // Held and carried commentary follows the greeting.
      this.speech.resume({ prerollMs: g ? COMMENTARY_PREROLL_MS : 0 });
      if (reason === "wake") {
        // The page posts the wake clip once it sees session.started; if that
        // never comes, still tell the model so it is not left waiting.
        this.timer("wakeNote", () => this.injectWakeText(sb, null, "timeout"), WAKE_NOTE_MS);
      }
    }
    this.speech.resume();
    this.flushWakeQueue();
    this.interval("idle", () => this.idleTick(), IDLE_TICK_MS);
    this.scheduleExpiry();
    this.changed();
  }

  onLiveEvent(sb, evt) {
    if (this.sideband !== sb) return;
    switch (evt.type) {
      case "session.input_transcript.delta":
        this.transcript.add("user", evt.delta, evt.start_ms, evt.end_ms);
        this.mirror.onUserSpeech();
        if (typeof evt.delta === "string" && /[\p{L}\p{N}]/u.test(evt.delta)) this.governor.onHeardUser();
        break;
      case "session.output_transcript.delta":
        this.transcript.add("assistant", evt.delta, evt.start_ms, evt.end_ms);
        this.speech.onOutput(evt.delta, evt.start_ms, evt.end_ms);
        break;
      case "session.delegation.created": this.delegation.onCreated(evt); break;
      case "session.usage.updated": this.onUsage(sb.id, Number(evt.usage?.seconds)); break;
      case "session.input_audio.muted": if (this.live) { this.live.muted = true; this.changed(); } break;
      case "session.input_audio.unmuted": if (this.live) { this.live.muted = false; this.changed(); } break;
      default: break;
    }
  }

  // ---- usage / daily cap ------------------------------------------------------------------
  onUsage(liveId, seconds, { persist = false } = {}) {
    if (!Number.isFinite(seconds)) return;
    const seen = this.usageSeen.get(liveId) || 0;
    const delta = seconds - seen;
    if (delta > 0) {
      this.usageSeen.set(liveId, seconds);
      const d = localDate(this.clock.now());
      this.usage.days[d] = (this.usage.days[d] || 0) + delta;
      if (persist || this.clock.now() - (this.lastUsageWrite || 0) >= 5000) this.persistUsage();
    }
    if (this.live && this.live.id === liveId) this.live.usage_seconds = seconds;
    this.checkCap();
    this.statusFile.mark();
  }

  persistUsage() {
    this.lastUsageWrite = this.clock.now();
    try { writeUsage(this.paths, this.usage, this.clock.now()); } catch (e) { this.log.warn("usage.write_error", { message: e.message }); }
  }

  checkCap() {
    const cap = this.config.daily_cap_minutes;
    if (!cap) return;
    const used = this.todaySeconds();
    const date = localDate(this.clock.now());
    if (used >= cap * 60) {
      if (this.sideband && this.state !== "closing" && !this.capClosing) {
        this.capClosing = true;
        this.log.info("cap", { reached: true, seconds: used, cap_minutes: cap });
        this.setLastError("daily_cap", `Daily voice cap reached (${cap} min)`);
        this.notice("warn", "daily_cap", `Daily voice cap reached (${cap} min). Raise daily_cap_minutes in /config to continue.`);
        this.pause("daily_cap").finally(() => { this.capClosing = false; });
      }
      return;
    }
    if (used >= cap * 60 * 0.8 && this.capWarnedDate !== date && this.sideband) {
      this.capWarnedDate = date;
      this.log.info("cap", { warn: true, seconds: used, cap_minutes: cap });
      this.deliver({ kind: "commentary", content: "Heads up: you've used 80 percent of today's voice time.", delegationId: null });
    }
  }

  // ---- closing / pausing / reconnecting -------------------------------------------------
  stopLiveTimers() {
    this.clear("idle");
    this.clear("expiry");
    this.clear("expiryWatch");
    this.clear("rtcDisconnect");
    this.clear("reconnectWatch");
    this.clear("reconnectOpen");
    this.clear("wakeNote");
  }

  /** Graceful close of the current Live session (§6.11). */
  async closeLive(timeoutMs = 15000) {
    this.stopLiveTimers();
    const sb = this.sideband;
    this.sideband = null;
    if (sb) {
      const r = await sb.close(timeoutMs);
      if (!r.confirmed) this.log.warn("session.finalization_unconfirmed", { live_id: sb.id });
    }
    this.live = null;
    this.persistUsage();
    this.changed();
  }

  /**
   * Close the Live session and wait in `paused` (idle, page pause, cap, unload),
   * or in `sleeping` (idle with local voice wake armed, §6.15).
   */
  async pause(reason, { command = true, sleep = false, detail } = {}) {
    if (this.state === "off" || this.state === "closing") return;
    this.log.info(reason === "idle" ? "idle.close" : "pause", { reason, sleep, detail });
    this.pauseReason = reason;
    if (reason !== "idle") this.governor.onEnd();
    await this.closeLive();
    if (this.state === "off" || this.state === "closing" || !this.owner) return;
    if (this.sideband) return; // a new session started meanwhile
    this.setState(sleep ? "sleeping" : "paused");
    if (command) this.command("disconnect", reason);
  }

  /**
   * Idle close (§6.11, §6.15). Sleeps (wake armed) when wake is enabled and a
   * page is there to listen; otherwise pauses as before.
   */
  goToSleep(why) {
    this.governor.onSleep(why);
    const sleep = this.config.wake_sensitivity !== "off" && this.sse.count > 0;
    return this.pause("idle", { sleep, detail: why });
  }

  idleTick() {
    if (this.state !== "live") return;
    // ARCHITECTURE §7: never idle-close while a delegation is pending, i.e. being
    // collected or still being worked on by Claude (bounded: a request in
    // flight for over 30 min no longer keeps a paid session open).
    const busy = this.delegation.hasCollecting() || this.delegation.pendingWork().length > 0;
    const why = sleepDecision({
      now: this.clock.now(), idleMs: idleSecondsOf(this.config) * 1000, liveStartedAt: this.liveStartedAt,
      lastUserAt: this.transcript.lastUserSpeechAt, lastAssistantAt: this.transcript.lastAssistantSpeechAt,
      lastPageActivityAt: Math.max(this.lastPageActivityAt, this.lastDeliverAt || 0), busy, wokeBy: this.governor.wokeBy, heardUser: this.governor.heardUser,
    });
    if (why) this.goToSleep(why);
  }

  // ---- wake (§6.15) ---------------------------------------------------------------------
  setWakeSensitivity(v) {
    if (!["off", "low", "medium", "high"].includes(v)) return;
    this.config = { ...this.config, wake_sensitivity: v };
    this.log.info("wake.sensitivity", { sensitivity: v });
    // Turning wake off while asleep: nothing will wake us, so it is a plain pause.
    if (v === "off" && this.state === "sleeping") this.setState("paused");
    this.changed();
  }

  logWakeRequest(why, w) {
    const f = { reason: why };
    if (w && typeof w === "object") {
      for (const k of ["onset_to_post_ms", "trigger_ms", "snr_db", "level_db", "voiced_ms", "boost_db"]) {
        if (Number.isFinite(Number(w[k]))) f[k] = Math.round(Number(w[k]) * 10) / 10;
      }
      if (typeof w.sensitivity === "string") f.sensitivity = truncate(w.sensitivity, 12);
    }
    this.log.info("wake.session", f);
  }

  /** Speak what was queued while no session was open. */
  flushWakeQueue() {
    if (!this.wakeQueue.length || !this.sideband) return;
    const q = this.wakeQueue;
    this.wakeQueue = [];
    this.pendingResult = null;
    this.log.info("wake.flush", { count: q.length });
    // Delegation ids of earlier sessions are unknown to this one: always null.
    for (const m of q) this.deliver({ kind: m.kind, content: m.content, delegationId: null, source: m.source || undefined });
  }

  /** The page's wake clip (onset until live): transcribe it and hand the words to the model. */
  async onWakeAudio(msg) {
    const sb = this.sideband;
    const live = this.live;
    if (!sb || !live || live.reason !== "wake" || live.wakeHandled || (msg.session_id && msg.session_id !== live.id)) {
      this.log.info("wake.audio_ignored", { reason: live?.reason ?? null, handled: !!live?.wakeHandled });
      return;
    }
    live.wakeHandled = true;
    this.clear("wakeNote");
    const wav = decodeWavB64(msg.audio);
    const apiKey = this.getApiKey();
    let text = null;
    if (wav && apiKey) {
      const r = await transcribeWithFallback({
        base: this.base, apiKey, wav, fetchImpl: this.fetchImpl, clock: this.clock,
        model: this.env.SOTTO_WAKE_TRANSCRIBE_MODEL || undefined,
        prompt: `A developer talking to a voice assistant about the coding project ${this.owner?.project || ""}.`,
      });
      text = r.ok ? r.text : null;
      this.log.info("wake.transcribe", {
        ok: r.ok, ms: r.ms, model: r.model, status: r.status ?? null, code: r.code ?? null, clip_ms: wavDurationMs(wav),
        chars: text ? text.length : 0, text: text ? truncate(text, 300) : "", fallback_from: r.fallback_from ?? null,
      });
    } else {
      this.log.warn("wake.audio_invalid", { bytes: typeof msg.audio === "string" ? msg.audio.length : 0 });
    }
    this.injectWakeText(sb, text, "clip");
  }

  injectWakeText(sb, text, via) {
    if (this.sideband !== sb || !this.live) return;
    this.live.wakeHandled = true;
    this.clear("wakeNote");
    if (text) {
      // The clip is checked against what was played aloud just before
      // (§6.8.1): a voice sample or the end of the last session is not the user.
      const e = this.transcript.filterEchoText(text);
      if (e.verdict !== "clean") {
        this.log.info("wake.echo", { verdict: e.verdict, words: e.words, echo_words: e.echoWords + e.phraseWords });
        text = e.verdict === "echo" ? null : e.frags.map((f) => f.text).join(" ").replace(/\s+/g, " ").trim() || null;
      }
    }
    if (text) {
      this.governor.onHeardUser();
      // Part of the user's turn: the delegation text (built from user
      // fragments) must include these words, ahead of anything heard live.
      this.transcript.prepend("user", text);
      this.sse.broadcast({ type: "wake_heard", text });
    }
    this.deliver({ kind: "instructions", content: wakeInstruction(text), delegationId: null });
    this.log.info("wake.inject", { via, chars: text ? text.length : 0 });
  }

  onWakeTiming(msg) {
    const f = {};
    for (const [k, v] of Object.entries(msg || {})) {
      if (/^[a-z_]{1,40}$/.test(k) && k !== "type" && Number.isFinite(Number(v)) && typeof v !== "boolean") f[k] = Math.round(Number(v));
    }
    this.log.info("wake.timing", f);
  }

  scheduleExpiry() {
    if (!this.live) return;
    const exp = this.live.expires_at * 1000;
    const startAt = exp - 300_000;
    this.timer("expiry", () => this.expiryWatch(), Math.max(0, startAt - this.clock.now()));
  }

  expiryWatch() {
    if (this.state !== "live" || !this.live) return;
    const exp = this.live.expires_at * 1000;
    const now = this.clock.now();
    const quiet = now - Math.max(this.transcript.lastUserSpeechAt, this.transcript.lastAssistantSpeechAt) >= 2000;
    if (quiet || now >= exp - 60_000) { this.expiryReconnect(); return; }
    this.timer("expiryWatch", () => this.expiryWatch(), 500);
  }

  async expiryReconnect() {
    this.log.info("reconnect", { reason: "expiry" });
    this.speech.suspend();
    this.setState("reconnecting");
    await this.closeLive(3000);
    if (this.state !== "reconnecting") return;
    this.requestReconnect("expiry");
  }

  /**
   * Ask the page for a replacement session. The SSE command is one-shot, so
   * if no page is listening, open the window (it auto-connects in the
   * "reconnecting" state), and if nothing starts a session within 30 s,
   * pause with a notice instead of sitting in "reconnecting" forever.
   */
  requestReconnect(reason) {
    this.command("reconnect", reason);
    // A page between event-stream retries comes back within a few seconds and
    // then connects on its own (it sees "reconnecting"); only open a window if
    // none has come back by then.
    this.timer("reconnectOpen", () => {
      if (this.state !== "reconnecting" || this.sideband || this.sse.count > 0 || !this.config.open_browser) return;
      this.log.info("reconnect.no_page", { reason });
      this.chrome.open();
    }, RECONNECT_OPEN_MS);
    this.timer("reconnectWatch", () => {
      if (this.state !== "reconnecting" || this.sideband) return;
      this.log.warn("reconnect.timeout", { reason });
      this.setLastError("connection_lost", "The voice window did not reconnect");
      this.setState("paused");
      this.notice("warn", "connection_lost", "The voice connection dropped and did not come back, so voice is paused. Resume when ready.");
    }, RECONNECT_WATCH_MS);
  }

  /** Unexpected loss: at most 3 attempts per 10 min, then paused with a notice. */
  reconnect(reason) {
    if (!this.owner || this.state === "off" || this.state === "closing") return;
    const now = this.clock.now();
    this.reconnects = this.reconnects.filter((t) => now - t < RECONNECT_WINDOW_MS);
    const old = this.sideband;
    this.sideband = null;
    this.stopLiveTimers();
    if (old) old.close(3000).catch(() => {});
    this.live = null;
    if (this.reconnects.length >= RECONNECT_MAX) {
      this.log.warn("reconnect.give_up", { reason });
      this.setLastError("connection_lost", "The voice connection kept dropping");
      this.setState("paused");
      this.notice("warn", "connection_lost", "The voice connection kept dropping, so voice is paused. Resume when ready.");
      this.command("disconnect", "connection_lost");
      return;
    }
    this.reconnects.push(now);
    this.log.info("reconnect", { reason, attempt: this.reconnects.length });
    this.speech.suspend();
    this.setState("reconnecting");
    this.requestReconnect(reason);
  }

  onSessionClosed(sb, { reason, seconds }) {
    if (seconds != null) this.onUsage(sb.id, seconds, { persist: true });
    else this.persistUsage();
    if (this.sideband !== sb || sb.closing) return; // expected (we asked)
    // The server ended the session on its own.
    this.sideband = null;
    sb.shutdownSocket();
    this.stopLiveTimers();
    const wasLive = this.state === "live";
    this.live = null;
    if (reason === "content") {
      this.setLastError("content", "The voice session was ended by a safety filter");
      this.notice("error", "content", "The voice session was ended by a safety filter.");
      this.setState("paused");
      this.command("disconnect", "content");
    } else if ((reason === "expired" || reason === "connection_lost" || reason === "remote_hangup") && this.owner && wasLive) {
      this.reconnect(reason);
    } else {
      this.setState(this.owner ? "paused" : "off");
      this.command("disconnect", reason);
    }
  }

  /** Graceful off (§6.13). reason: user | owner_gone | shutdown. */
  async gracefulOff(reason) {
    const gen = ++this.offGen;
    this.log.info("off", { reason });
    this.keySetup = false;
    // The user's last undelegated words still reach Claude (the owner is still bound).
    if (reason === "user" && this.owner) this.mirror.flush("off");
    this.clear("waitingPage");
    this.clear("sessionEnd");
    this.clear("sessionEndOff");
    this.clear("exit");
    this.setState("closing");
    if (reason === "shutdown") this.timer("hardExit", () => this.onExit("shutdown_timeout"), 16000);
    await this.closeLive();
    if (gen !== this.offGen) return; // re-bound while closing
    this.delegation.orphanAll();
    this.delegation.resetClaudeState(); // a later /talk on may be another session
    this.narrator.dispose();
    this.narrator.resetTurn();
    this.speech.drain();
    this.nonce = null;
    this.voiceSwitch = null;
    this.awaiting = null;
    this.mirror.dispose();
    this.wakeQueue = [];
    this.governor.onEnd();
    this.clear("notifyWatch");
    removeActive(this.paths);
    removePendingContext(this.paths);
    if (this.owner) this.log.info("owner.release", { reason, project: this.owner.project });
    this.owner = null;
    this.clear("liveness");
    this.changed();
    this.command("close_window", reason);
    const killed = new Promise((resolve) => this.clock.setTimeout(() => { Promise.resolve(this.chrome.kill()).catch(() => 0).then(resolve); }, CLOSE_WINDOW_KILL_MS));
    if (reason === "shutdown") {
      await killed;
      this.onExit("shutdown");
      return;
    }
    this.setState("off");
    this.timer("exit", () => { if (this.state === "off" && !this.owner) this.onExit("off"); }, EXIT_AFTER_OFF_MS);
  }

  // ---- self-update (§6.17) ----------------------------------------------------------------
  /**
   * Is now a quiet moment to restart? null = yes, else the reason it is not.
   * Quiet means: an owner is bound; sleeping or paused, or live with nobody
   * speaking for `quietMs` (both sides, the page's voice activity and our own
   * appends count); no voice request with Claude, Claude not mid-turn, nothing
   * queued to be spoken, no key check or voice sample in flight. Never
   * mid-speech, never mid-delegation.
   */
  restartBlocker(quietMs) {
    if (this.restarting) return "restarting";
    if (!this.owner) return "no_owner";
    const st = this.state;
    if (st !== "live" && st !== "sleeping" && st !== "paused") return `state_${st}`;
    if (this.delegation.hasCollecting() || this.delegation.pendingWork().length > 0) return "delegation";
    if (this.delegation.claudeBusy) return "claude_busy";
    if (this.wakeQueue.length || this.timers.notifyWatch) return "wake_queue";
    if (this.speech.size > 0) return "speech_queued";
    // The page is waiting on these answers; a swap would drop the request
    // (and a voice sample's billed seconds would never be booked).
    if (this.keySaving) return "key_check";
    if (this.previews.inflight.size > 0) return "voice_sample";
    if (st === "live") {
      const now = this.clock.now();
      if (this.speech.isSpeaking(now)) return "speaking";
      const last = Math.max(this.transcript.lastUserSpeechAt, this.transcript.lastAssistantSpeechAt,
        this.lastPageActivityAt, this.lastDeliverAt || 0, this.liveStartedAt);
      if (now - last < quietMs) return "recent_speech";
    }
    return null;
  }

  /** /talk restart. */
  manualRestart() {
    if (!this.owner || this.state === "off" || this.state === "closing") {
      return { ok: true, message: "sotto: voice is off. The next /talk on starts the latest code." };
    }
    if (!this.requestRestart) return { ok: false, message: "sotto: restart is turned off for this daemon (SOTTO_UPDATE=0)." };
    const r = this.requestRestart();
    if (r === "disabled") return { ok: false, message: "sotto: restart is turned off for this daemon (SOTTO_UPDATE=0)." };
    if (r === "now") return { ok: true, message: "sotto: restarting the voice daemon now. Voice picks up where it left off." };
    const words = RESTART_WAIT_WORDS[r] || "the voice connection to settle";
    return { ok: true, message: `sotto: the voice daemon restarts at the next pause (waiting for ${words}).` };
  }

  /**
   * First step of a restart: block new sessions and close the Live session
   * (the page is told to disconnect and keeps its mic). Returns what the
   * successor needs to resume: {resume: "live"|"sleeping"|"paused"}.
   */
  async prepareRestart(reason) {
    const resume = this.state;
    this.restarting = true;
    this.log.info("update.prepare", { reason, state: resume });
    this.clear("waitingPage");
    // Unsent words go to Claude now: the successor starts a new timeline (§6.18).
    if (this.owner) this.mirror.flush("restart");
    if (this.sideband || this.live) {
      this.command("disconnect", "update");
      await this.closeLive(3000);
    } else {
      this.stopLiveTimers();
    }
    this.persistUsage();
    return { resume, reason };
  }

  /** The restart failed (the new code did not start): carry on here. */
  abortRestart(prep) {
    this.restarting = false;
    this.log.warn("update.abort", { resume: prep?.resume || null });
    if (!this.owner) return;
    this.notice("warn", "update_failed", "Sotto could not start its new code, so it keeps running the old one. See the daemon log.");
    if (prep?.resume === "live") {
      this.setState("reconnecting");
      this.requestReconnect("update_failed");
    }
    this.changed();
  }

  /**
   * The state the successor process resumes from (sent over a pipe, never
   * written to disk: it holds the inbox token). Called after prepareRestart.
   */
  snapshot(prep) {
    const o = this.owner;
    return {
      resume: prep?.resume || this.state,
      reason: prep?.reason || "update",
      owner: o ? { ...o } : null,
      config: { ...this.config },
      runtime_policy: this.runtimePolicy,
      nonce: this.nonce,
      history: this.transcript.recentLines(60),
      last_user_speech_at: this.transcript.lastUserSpeechAt,
      last_assistant_speech_at: this.transcript.lastAssistantSpeechAt,
      pending_result: this.pendingResult,
      backlog: [...this.backlog],
      counters: { ...this.counters },
      last_error: this.lastError,
      pause_reason: this.pauseReason || null,
      window_app: !!this.chrome?.appLaunched,
      awaiting: this.awaiting ? { ...this.awaiting } : null,
      // The page shows the key card: a paused first run (no key yet) keeps it.
      key_setup: !!this.keySetup,
    };
  }

  /**
   * Successor side: take over from the snapshot. The owner binding, nonce and
   * D/active are unchanged (same key and port), so hooks and the marker keep
   * working. A live session is re-created (the page reconnects on its own,
   * the new session is seeded with the conversation and says it updated);
   * sleeping and paused stay as they were.
   */
  restore(snap) {
    if (!snap || !snap.owner || typeof snap.owner.socket !== "string") return false;
    this.config = { ...this.config, ...(snap.config || {}) };
    this.config.voice = resolveVoice({ prefs: readPrefs(this.paths), configVoice: this.config.voice });
    this.runtimePolicy = POLICIES.includes(snap.runtime_policy) ? snap.runtime_policy : null;
    this.owner = { ...snap.owner };
    this.nonce = typeof snap.nonce === "string" && /^[0-9a-f]+$/.test(snap.nonce) ? snap.nonce : randomBytes(6).toString("hex");
    if (Array.isArray(snap.history)) {
      this.transcript.history = snap.history.filter((l) => l && (l.role === "user" || l.role === "assistant") && typeof l.text === "string").slice(-60);
    }
    this.transcript.lastUserSpeechAt = Number(snap.last_user_speech_at) || 0;
    this.transcript.lastAssistantSpeechAt = Number(snap.last_assistant_speech_at) || 0;
    this.pendingResult = snap.pending_result && typeof snap.pending_result.text === "string" ? snap.pending_result : null;
    this.backlog = Array.isArray(snap.backlog) ? snap.backlog.filter((b) => typeof b === "string").slice(-50) : [];
    if (snap.counters && typeof snap.counters === "object") {
      for (const k of Object.keys(this.counters)) if (Number.isFinite(snap.counters[k])) this.counters[k] = snap.counters[k];
    }
    if (snap.last_error && typeof snap.last_error.code === "string") this.lastError = snap.last_error;
    this.pauseReason = snap.pause_reason || null;
    // Claude is still waiting for the user's answer (§6.10.3): the next session's seed says so.
    this.awaiting = snap.awaiting && typeof snap.awaiting.text === "string" ? { text: clip(snap.awaiting.text, 300), at: Number(snap.awaiting.at) || 0, via: snap.awaiting.via === "ask" ? "ask" : "stop" } : null;
    // Key setup card (§4.3): still wanted only while there is no key.
    this.keySetup = !!snap.key_setup && !this.getApiKey();
    if (snap.window_app) this.chrome?.adoptApp?.();
    try { writeActive(this.paths, { socket: this.owner.socket, port: this.port, key: this.daemonKey, nonce: this.nonce }); } catch (e) { this.log.error("active.write_error", { message: e.message }); }
    this.vocabularyFor(this.owner);
    this.interval("liveness", () => { this.delegation.sweepStale(); this.checkLiveness(); }, LIVENESS_MS);
    const manual = snap.reason === "manual";
    this.helloNotice = { level: "info", code: "updated", text: manual ? "Sotto restarted." : "Sotto updated itself to the latest code." };
    this.log.info("update.restore", { resume: snap.resume, reason: snap.reason, project: this.owner.project, history: this.transcript.history.length });
    if (snap.resume === "live") {
      // Spoken only when the user was talking with it (not asleep, not paused).
      this.updateCue = true;
      this.setState("reconnecting");
      this.requestReconnect("update");
    } else if (snap.resume === "sleeping") {
      this.setState("sleeping");
    } else {
      this.setState("paused");
    }
    this.changed();
    return true;
  }

  /** Stop every timer (tests and final exit). */
  dispose() {
    for (const name of Object.keys(this.timers)) this.clear(name);
    this.delegation.dispose();
    this.mirror.dispose();
    this.narrator.dispose();
    this.speech.drain();
    this.statusFile.stop();
  }
}
