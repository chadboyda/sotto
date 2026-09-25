// Voice-session orchestrator (SPEC §6.4 actions, §6.5 owner, §6.11 lifecycle,
// §6.13 shutdown). Wires the sideband, transcript, delegation engine, narrator,
// page (SSE) and Chrome window together. All time goes through `clock`.
import { randomBytes } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { normalizeConfig, POLICIES, VOICES, VOICE_INFO, ECHO_GUARD_MODES, openaiBase, wssBase, VERSION, MAX_APPEND_TOKENS, voiceMarker, BG } from "./config.js";
import { estTokens, fitTokens, tokenChunks, speakable, summary, clip, awaitingQuestion } from "./speech.js";
import { makeOwner, ownerStatus, isOwnerAlive } from "./owner.js";
import { writeActive, removeActive, createPendingContext, removePendingContext, setApprovalPending, readUsage, writeUsage, localDate, StatusFileWriter } from "./statefiles.js";
import { Transcript } from "./transcript.js";
import { DelegationEngine, parseTaskNotifications } from "./delegation.js";
import { Mirror, MIRROR_MODES } from "./mirror.js";
import { materialOf } from "./phrasing.js";
import { StyleWatch } from "./stylewatch.js";
import { Narrator, elicitationSpeech, serverName, ToolLine, AgentTracker, TopLevelWork, reportSentence, isBackgroundLaunch, agentsText, cardText, permissionLabel, reminderSpeech } from "./policy.js";
import { Approvals, commandFingerprint, findRunning } from "./approvals.js";
import { SpeechQueue, COMMENTARY_PREROLL_MS } from "./speaker.js";
import { renderForPolicy, buildSeedInput, greeting, ownerSwitchInstruction, voiceSwitchGreeting, personaSwitchGreeting, vocabularyUpdateInstruction, updateGreeting, cantHearInstruction, RECENT_GREETING_MS } from "./prompt.js";
import { readPrefs, writePrefs, resolveVoice, normalizeVoice, voiceListMessage, unknownVoiceMessage, normalizeWindow, resolveWindowPref, personaVoiceOn } from "./prefs.js";
import { loadPersonas, findPersona, resolvePersona, personaSummary, personaListMessage, unknownPersonaMessage } from "./personas.js";
import { collectVocabulary, renderVocabulary, vocabularyHint, TIER } from "./vocabulary.js";
import { buildSessionBody, createLiveSession, Sideband } from "./live.js";
import { PrimarySession, buildPrimaryStart } from "./live-ws.js";
import { PreviewCache, recordPreview, previewText } from "./preview.js";
import { readTranscriptTail, readAbsorbed, gitBranch } from "./claude-context.js";
import { truncate } from "./log.js";
import { usageToday } from "./format.js";
import { WakeGovernor, WAKE_SOURCES, sleepDecision, idleSecondsOf } from "./wake.js";
import { QUIET_MS } from "./update.js";
import { decodeWavB64, wavDurationMs, transcribeWithFallback, wakeInstruction } from "./transcribe.js";
import { normalizeKeyInput, validateKey, keyWhere } from "./apikey.js";

/** The voice says "I can't hear you well" at most this often (§7.5). */
const CANT_HEAR_SAY_MS = 10 * 60 * 1000;
// A silent-mic window swap (SPEC §6.16 "Silent mic") at most this often.
const MIC_SILENT_SWAP_MS = 60 * 1000;
/** How long a confirmed /control persona|voice waits for the new session (toggle.sh curl -m is longer). */
const CONFIRM_MS = 5000;
/** How often a deferred stale-app swap re-checks for a quiet moment (scheduleStaleSwap). */
const STALE_SWAP_POLL_MS = 5000;
// What /talk status and the page say when macOS blocks the app's microphone.
export const APP_MIC_BLOCKED = "Sotto can't use the microphone: allow it in System Settings > Privacy & Security > Microphone";
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
const RESULT_SOURCES = new Set(["voice_result", "typed_result", "permission", "approval_reminder", "question", "attention", "background_voice", "background_result", "voice_notice", "mirror_result"]);
const ASK_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
/** Approval probe period while a Bash approval is pending (§6.10.4). */
const APPROVAL_PROBE_MS = 4000;
/** An approval reminder waits until the user has been quiet this long. */
const REMIND_USER_QUIET_MS = 2500;
/** A UserPromptSubmit that Claude Code submitted itself (a background task's
 *  notice, a subagent hand-back) or a voice message: not the user answering a
 *  subagent's prompt in the terminal. */
const AUTO_PROMPT = /^\s*(?:<task-notification>|<agent-message\b|\[sotto voice\b)/;

/** `ps` for the approval probe: pid and full command line of every process. */
function defaultProcessList() {
  return new Promise((resolve) => {
    execFileCb("/bin/ps", ["-axww", "-o", "pid=,command="], { timeout: 2000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? "" : String(stdout || "")));
  });
}
// States in which a Live session exists or is being created right now.
// ("reconnecting" is not one: it only waits for the page to start a new one.)
const LIVE_STATES = new Set(["connecting", "live"]);
/** Vocabulary: collection deadline (it starts at bind time, off the critical path) and reuse window. */
const VOCAB_DEADLINE_MS = 1500;
const VOCAB_REUSE_MS = 5 * 60_000;
/** Native app (docs/NATIVE.md §4.2): backoff before a replacement primary session, by attempt (1-3). */
const NATIVE_RECONNECT_BACKOFF_MS = [500, 1000, 2000];
/** Self-update with the app attached: the successor waits this long for the app's hello (§4.4). */
const APP_RESTORE_WAIT_MS = 10_000;

export const MSG = {
  noSocket: "sotto: ERROR this session has no inbox socket (CLAUDE_CODE_MESSAGING_SOCKET is unset), so voice cannot reach it.",
  usage: "sotto: usage: /talk [on|off|status|restart|quiet|milestones|walkthrough|voice [name]|persona [name]|app|window [auto|app|chrome]|key]",
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
   * @param {() => Promise<string>} [o.processList] `ps -axo pid=,command=` output (approval probe, §6.10.4)
   */
  constructor(o) {
    Object.assign(this, {
      paths: o.paths, port: o.port, pluginRoot: o.pluginRoot, daemonKey: o.daemonKey, env: o.env || {},
      clock: o.clock, fetchImpl: o.fetchImpl, WebSocketImpl: o.WebSocketImpl, inbox: o.inbox, chrome: o.chrome,
      log: o.log, getApiKey: o.getApiKey, keys: o.keys || null, sse: o.sse, onExit: o.onExit || (() => {}),
      probe: o.owner || {}, execFile: o.execFile, requestRestart: o.requestRestart || null,
      processList: o.processList || defaultProcessList,
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
    this.swapping = false; // a window swap (stale or silent app) is quitting the app
    this.micSilentAt = undefined;
    this.staleRestarted = false;
    this.reconnects = [];
    this.offGen = 0;
    this.timers = {};
    this.lastSessionCreateAt = 0;
    // Voice chosen while live: the replacement session greets with "Switched to <voice>".
    this.voiceSwitch = null;
    // Persona chosen while live (SPEC §4.6): the replacement greets in the new personality.
    this.personaSwitch = null;
    this.switchGen = 0;
    // userConfig's voice (the fallback below prefs.json); config.voice is the voice in effect.
    this.configVoice = this.config.voice;
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
      // Claude's words only: a relay frame ("tell the user…") as a background
      // note would invite the voice to announce it after all.
      demote: (a) => this.sendAppend({ ...a, kind: "thinking", content: BG + materialOf(a.content) }),
      // Not wired to output audio: measured on gpt-live-1 (e2e, 2026-09-23),
      // output audio chunks arrive continuously, silence included (the last
      // chunk was 42 ms old when the voice had been quiet for 1.2 s), which
      // held a voice answer for 9 s. The output transcript, with its
      // session-timeline end_ms, tracks audible speech.
    });
    this.narrator = new Narrator({ clock: this.clock, policy: () => this.policy, emit: (a) => this.deliver(a) });
    // The voice's own speech: a tag line, a repeated phrase or a banned opener
    // gets one silent corrective instruction (stylewatch.js, SPEC §8.1).
    this.style = new StyleWatch({
      clock: this.clock, log: this.log,
      correct: (content) => { if (this.sideband) this.deliver({ kind: "instructions", content, delegationId: null }); },
    });
    this.cantHearVariant = 0;
    this.reminderVariant = 0; // rotates the approval reminder line (phrasing.js)
    // The Claude card (SPEC-DEVIATIONS "Claude card"): the parent session's own
    // words first, a deduped plain-words tool line, and a count of background agents.
    this.toolLine = new ToolLine();
    this.agents = new AgentTracker({ clock: this.clock });
    this.work = new TopLevelWork(); // what the parent launched, for "X is done" (policy.js)
    this.reports = new Map(); // agent_id → its SubagentHandback report
    this.agentsShown = 0;
    this.cardSaid = "";
    // Tool approvals Claude Code is waiting on (SPEC §6.10.4): the card, the
    // spoken reminder and the PostToolUse gate follow this, not the last event.
    this.approvals = new Approvals({ clock: this.clock });
    this.probing = false;
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
        onChange: (r) => { this.emitPage({ type: "delegation", id: r.id, status: r.status, text: r.text || "" }); this.changed(); },
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
    // Native app (docs/NATIVE.md §4.2): who carries the audio. "app" = the
    // native app over /api/native (the daemon owns a primary WebSocket
    // session); "page" = the Chrome page (WebRTC + sideband); null = none yet.
    this.audioClient = null;
    this.native = null; // NativeController (native-session.js), set by setNativeController()
    this.muteWanted = false; // the app's mute, re-applied to every new primary session
    this.awaitApp = false; // self-update successor waiting for the app's hello (§4.4)
    this.nativeGen = 0;
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
        voice: this.config.voice, persona: this.personaIdForStatus(), idle_minutes: this.config.idle_minutes, idle_seconds: idleSecondsOf(this.config), speaking_policy: this.policy,
        daily_cap_minutes: this.config.daily_cap_minutes, wake_sensitivity: this.config.wake_sensitivity, mirror: this.mirrorMode(),
        echo_guard: this.echoGuardMode(),
      },
      claude: { busy: this.delegation.claudeBusy, last_event_at: iso(this.lastClaudeEventAt), awaiting_input: !!this.awaiting, approval: this.approvalStatus() },
      page: { connected: this.sse.count > 0 || false, clients: this.sse.count },
      delegations: this.delegation.list(10),
      counters: { ...this.counters },
      last_error: this.lastError ? { ...this.lastError } : null,
      wake: { ...this.governor.status(this.config.wake_sensitivity), queued: this.wakeQueue.length },
      api_key: { source: this.keyInfo().source },
      echo: this.echoState ? { ...this.echoState } : null,
      audio_client: this.pageStatus().audio_client,
      native: this.native ? this.native.status() : null,
    };
  }

  /** The approval the card shows (§6.10.4), or null. */
  approvalStatus() {
    const p = this.approvals?.current();
    return p ? { label: p.label, agent: p.agent, since: iso(p.at), pending: this.approvals.size } : null;
  }

  pageStatus() {
    return {
      state: this.state,
      owner: this.owner ? { project: this.owner.project, cwd: this.owner.cwd } : null,
      voice: this.config.voice,
      persona: this.personaIdForStatus(),
      speaking_policy: this.policy,
      idle_minutes: this.config.idle_minutes,
      idle_seconds: idleSecondsOf(this.config),
      echo_guard: this.echoGuardMode(),
      echo_heard_ms_ago: this.selfEchoAt ? this.clock.now() - this.selfEchoAt : null,
      wake: this.governor.pageConfig(this.config.wake_sensitivity, true),
      live: this.live ? { session_id: this.live.id, expires_at: this.live.expires_at, usage_seconds: this.live.usage_seconds, muted: this.live.muted } : null,
      today: { seconds: Math.round(this.todaySeconds() * 10) / 10, cap_minutes: this.config.daily_cap_minutes },
      claude: { busy: this.delegation.claudeBusy, approval: this.approvalStatus() },
      last_error: this.lastError ? { code: this.lastError.code, message: this.lastError.message } : null,
      key: { ...this.keyInfo(), setup: this.keySetup },
      audio_client: this.appAttached() ? "app" : this.audioClient === "page" ? "page" : null,
    };
  }

  // ---- native app link (docs/NATIVE.md) ---------------------------------------------------
  setNativeController(c) { this.native = c; }
  /** The native app is connected and carries the audio. */
  appAttached() { return this.audioClient === "app" && !!this.native?.connected; }
  /** Something that can carry voice is listening: an SSE page or the attached app. */
  hasListener() { return this.sse.count > 0 || this.appAttached(); }
  /** Everything the page gets over SSE also goes to the native app (§3.1). */
  emitPage(msg) {
    this.sse.broadcast(msg);
    if (this.native) { try { this.native.onBroadcast(msg); } catch (e) { this.log.error("native.fanout_error", { message: String(e && e.message) }); } }
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
    this.emitPage({ type: "status", status: this.pageStatus() });
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

  notice(level, code, text) { this.emitPage({ type: "notice", level, code, text }); }
  activity(kind, text, extra = null) { this.emitPage({ type: "activity", kind, text: text || "", ...extra }); }
  /** Broadcast the background-agent count when it changes. */
  syncAgents() {
    const n = this.agents.count();
    if (n === this.agentsShown) return;
    this.agentsShown = n;
    this.activity("agents", agentsText(n), { count: n });
  }
  command(command, reason) {
    this.log.info("page.command", { command, reason });
    this.emitPage({ type: "command", command, reason: reason || "" });
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
      this.emitPage({ type: "result_pending", text: content });
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
    if (this.state !== "sleeping" || !this.owner || this.capReached() || !this.hasListener()) return false;
    if (this.timers.notifyWatch) return true; // already asked
    this.log.info("wake.request", { kind, queued: this.wakeQueue.length });
    if (this.appAttached()) this.startNativeSession(kind === "wake" ? "wake" : "notify");
    else this.command("connect", kind);
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
    // `via: "cli"`: bin/sotto (Claude acting on the user's spoken request), logged on persona.set / voice.set.
    const via = req.via === "cli" ? "cli" : "control";
    this.log.info("control", { action, state: this.state, ...(via === "cli" ? { via } : {}) });
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
      case "voice": r = req.voice == null || req.voice === "" ? { ok: true, message: voiceListMessage(this.currentVoice(req.config)) } : this.setVoice(req.voice, via); break;
      case "persona": {
        if (req.persona == null || req.persona === "") {
          const list = this.personaList(req.session);
          r = { ok: true, message: personaListMessage(this.currentPersona(list).id, list) };
        } else r = this.setPersona(req.persona, via, { session: req.session });
        break;
      }
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
    // `confirm` (toggle.sh for /talk persona|voice <name>, so bin/sotto): a
    // switch is reported done only once a session runs in it (controlConfirmed).
    const pending = r.ok && (r.switching || this.state === "connecting" || this.state === "reconnecting");
    if (req.confirm === true && pending && (action === "persona" || action === "voice") && (r.persona || r.voice)) {
      const what = action === "persona" ? `persona ${r.persona}` : `voice ${r.voice}`;
      out.confirm = {
        action, persona: action === "persona" ? r.persona : null, voice: r.voice,
        done: action === "persona"
          ? `sotto: persona set to ${r.persona} with the ${r.voice} voice. The live session now runs as ${r.persona}.`
          : `sotto: voice set to ${r.voice}. The live session now speaks in it.`,
        what,
      };
    }
    return out;
  }

  /**
   * /control, waiting for a confirmed switch (SPEC §5.9): the answer to
   * `sotto persona <x>` / `sotto voice <x>` says the switch happened only
   * after a Live session was created in it; otherwise it is an ERROR line
   * (the choice is saved, but the CLI must not claim success).
   */
  async controlConfirmed(req = {}) {
    const out = this.control(req);
    const c = out.confirm;
    delete out.confirm;
    if (!c) return out;
    const t0 = this.clock.now();
    const done = () => !!this.live && this.live.voice === c.voice && (c.persona === null || this.live.persona === c.persona);
    const ok = await new Promise((resolve) => {
      const check = () => {
        if (done()) return resolve(true);
        if (this.clock.now() - t0 >= CONFIRM_MS || this.state === "off" || this.state === "paused" || this.state === "sleeping") return resolve(false);
        this.clock.setTimeout(check, 100);
      };
      check();
    });
    this.log.info("control.confirm", { action: c.action, ok, ms: this.clock.now() - t0, persona: c.persona, voice: c.voice, state: this.state });
    out.ok = ok;
    out.state = this.state;
    out.message = ok ? c.done : `sotto: ERROR ${c.what} is saved, but the live session did not switch to it within ${CONFIRM_MS / 1000} s (state ${this.state}). See the daemon log.`;
    return out;
  }

  statusMessage() {
    const u = fmtUsage(this.todaySeconds());
    const app = this.appNote();
    if (this.state === "off" || !this.owner) return `sotto: voice is off. ${u}.${app ? ` ${app}.` : ""}`;
    const st = this.state === "live" ? "ON" : this.state;
    let m = `sotto: voice ${st} (${this.owner.project}) | ${u} | voice ${this.config.voice} | persona ${this.personaIdForStatus()} | ${this.policy}`;
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
      // The install replaced the bundle under a running app: swap it for the
      // new one, but only at a quiet moment (below).
      this.scheduleStaleSwap("install");
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
    // prefs.json (/talk voice, the page, the CLI) beats userConfig (§4.5), and
    // the persona's own voice beats both while it applies (effectiveVoice).
    this.configVoice = this.config.voice;
    this.config.voice = this.effectiveVoice();
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
      this.agents.reset(); this.work.reset(); this.reports.clear(); this.toolLine.reset(); this.agentsShown = 0;
      this.clearApprovals();
      removePendingContext(this.paths);
      this.owner = next;
      this.log.info("owner.switch", { from: old.project, to: next.project, session_id: next.session_id });
      // Commentary, not instructions: an instructions append can cut off the
      // voice mid-sentence (guide-live-delegation "Send the right kind of
      // update"); commentary is fitted into the conversation by the model.
      if (this.sideband) this.deliver({ kind: "commentary", content: ownerSwitchInstruction(next.project), delegationId: null, source: "owner_switch" });
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
    if (this.appAttached()) {
      // The app is connected (its panel may be hidden after the last off):
      // the daemon starts the session itself and shows the panel.
      this.startNativeSession("start");
      if (this.config.open_browser) this.chrome.showApp?.();
    } else if (this.sse.count > 0) {
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
        if (this.appAttached()) this.startNativeSession("start");
        else this.command("connect", "key");
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
    return this.effectiveVoice(config?.voice ?? this.configVoice);
  }

  /**
   * The voice a session is created in, resolved from prefs.json every time
   * (SPEC §4.5, §4.6): the persona's own voice while "switch to the persona's
   * voice" is on and the persona names one, else prefs.voice > userConfig >
   * default. prefs.json is the one source of truth, so the persona's voice
   * survives every re-creation (reconnect, wake, restart, handover) instead of
   * living in a copy that one path forgets.
   */
  effectiveVoice(configVoice = this.configVoice ?? this.config.voice, list = null) {
    const prefs = readPrefs(this.paths);
    return this.personaOwnVoice(prefs, list) || resolveVoice({ prefs, configVoice });
  }

  /**
   * The chosen persona's own voice when it applies (a persona was chosen, the
   * toggle is on), else null. `list`: the caller's persona list (an unbound
   * /talk persona sees its own project's personas).
   */
  personaOwnVoice(prefs = readPrefs(this.paths), list = null) {
    if (!prefs.persona || !personaVoiceOn(prefs)) return null;
    const p = findPersona(list || this.cachedPersonaList(), prefs.persona);
    return p ? normalizeVoice(p.voice) : null;
  }

  /**
   * {voices, current, live, live_voice, info} for GET /api/voices, the app's
   * settings and get_voices. `info` (added in 0.4.x) maps each voice to
   * {description, tone, presentation, accent} for the pickers.
   */
  voices() {
    return {
      voices: [...VOICES],
      current: this.currentVoice(),
      live: !!(this.live && this.sideband),
      live_voice: this.live?.voice || null,
      info: VOICE_INFO,
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
    // An explicit voice choice beats the persona's own voice: it turns that
    // toggle off, so prefs.json says what is in effect (the toggle shows it).
    const patch = { voice: v };
    const own = this.personaOwnVoice();
    if (own && own !== v) patch.persona_voice = false;
    try { writePrefs(this.paths, patch); } catch (e) { this.log.error("prefs.write_error", { message: e.message }); }
    this.config = { ...this.config, voice: this.effectiveVoice() };
    this.log.info("voice.set", { voice: v, from: prev, source, state: this.state, ...(patch.persona_voice === false ? { persona_voice: false } : {}) });
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
    this.voiceSwitch = v;
    this.recreateLive("voice_change", `Switching to the ${v} voice.`);
  }

  /**
   * Same re-creation for a persona (SPEC §4.6): instructions are immutable per
   * Live session too. When the persona brought its own voice, that changes in
   * the same swap; the greeting is the persona line either way.
   */
  switchLivePersona(p) {
    this.log.info("persona.switch", { persona: p.id, from: this.live?.persona || null, voice: this.config.voice });
    this.personaSwitch = p.id;
    if (this.live && this.live.voice !== this.config.voice) this.voiceSwitch = this.config.voice;
    this.recreateLive("persona_change", `Switching to ${p.name}.`);
  }

  /** Close the live session and have the page re-offer (switches; §6.14 steps 2-3). */
  recreateLive(reasonCode, text) {
    const old = this.sideband;
    this.sideband = null;
    this.native?.sessionGone(old, "voice_change");
    this.stopLiveTimers();
    this.speech.suspend();
    this.live = null;
    this.notice("info", reasonCode, text);
    this.setState("reconnecting");
    // Close first, reconnect after session.closed (at most SWITCH_CLOSE_WAIT_MS):
    // the page's reconnect tears down the old peer connection, and a server that
    // sees the media drop before it has processed session.close ends the
    // session as connection_lost / remote_hangup.
    const gen = ++this.switchGen;
    const t0 = this.clock.now();
    const go = (confirmed) => {
      if (gen !== this.switchGen || this.state !== "reconnecting" || this.sideband) return;
      this.log.info("voice.switch_closed", { confirmed, ms: this.clock.now() - t0, reason: reasonCode });
      this.requestReconnect(reasonCode);
    };
    if (!old) { go(false); return; }
    old.close(SWITCH_CLOSE_WAIT_MS).then((r) => go(!!r?.confirmed), () => go(false));
  }

  // ---- persona (§4.6) -------------------------------------------------------------------------
  /** Built-in plus custom personas, read fresh (a file edit applies to the next session). */
  personaList(session = null) {
    const o = this.owner || (session && typeof session === "object" ? session : null);
    const projectDir = o ? (o.project_dir || o.cwd || null) : null;
    // Status reads rescan every few seconds: warn about a bad file once, not on every scan.
    this.personaWarned ??= new Set();
    const warn = (ev, f) => {
      const k = `${ev}|${f.source}|${f.file || f.id}|${f.code}`;
      if (this.personaWarned.has(k)) return;
      this.personaWarned.add(k);
      this.log.warn(ev, f);
    };
    const list = loadPersonas({ dataDir: this.paths.dir, projectDir, log: { warn } });
    this.personaCache = { at: this.clock.now(), projectDir, list };
    return list;
  }

  /** The current persona's id for status lines (sent on every change): a directory scan at most every 5 s. */
  personaIdForStatus() {
    return this.currentPersona(this.cachedPersonaList()).id;
  }

  /** The persona list, rescanned at most every 5 s (status lines, the native settings). */
  cachedPersonaList() {
    const c = this.personaCache;
    const projectDir = this.owner ? (this.owner.project_dir || this.owner.cwd || null) : null;
    return c && c.projectDir === projectDir && this.clock.now() - c.at < 5000 ? c.list : this.personaList();
  }

  /** The persona in effect: prefs.json's choice if it (still) exists, else the default. */
  currentPersona(list = this.personaList()) {
    return resolvePersona(list, readPrefs(this.paths).persona);
  }

  /** {personas, current, use_voice, live, live_persona} for GET /api/personas (never the bodies). */
  personas({ cached = false } = {}) {
    const list = cached ? this.cachedPersonaList() : this.personaList();
    return {
      personas: list.map(personaSummary),
      current: this.currentPersona(list).id,
      use_voice: personaVoiceOn(readPrefs(this.paths)),
      live: !!(this.live && this.sideband),
      live_persona: this.live?.persona || null,
    };
  }

  /** Whether choosing a persona also switches to its voice (persisted). */
  setPersonaVoice(on) {
    try { writePrefs(this.paths, { persona_voice: !!on }); } catch (e) { this.log.error("prefs.write_error", { message: e.message }); }
    const v = this.effectiveVoice();
    const changedVoice = v !== this.config.voice;
    this.log.info("persona.use_voice", { on: !!on, voice: v });
    if (changedVoice) {
      this.config = { ...this.config, voice: v };
      if (this.state === "live" && this.sideband && this.live && this.live.voice !== v) this.switchLiveVoice(v);
      else if (this.state === "reconnecting") this.voiceSwitch = v;
    }
    this.changed();
    return { ok: true, use_voice: !!on };
  }

  /**
   * Persist a persona choice and apply it, like setVoice: a live session is
   * re-created with the new instructions (seeded, no repeat of the last
   * update). With "use the persona's voice" on (the default), a persona that
   * names a voice also sets that voice, in the same swap.
   * Returns {ok, message, persona, voice, switching}.
   */
  setPersona(name, source = "control", { session = null } = {}) {
    const list = this.personaList(session);
    const p = findPersona(list, name);
    if (!p) return { ok: false, message: unknownPersonaMessage(name, list), code: "bad_persona" };
    const prev = this.currentPersona(list).id;
    const prevVoice = this.currentVoice();
    // Only the persona is stored: its voice follows from it (effectiveVoice),
    // and prefs.voice keeps the user's own choice for when the toggle is off.
    try { writePrefs(this.paths, { persona: p.id }); } catch (e) { this.log.error("prefs.write_error", { message: e.message }); }
    if (readPrefs(this.paths).persona !== p.id) {
      this.log.error("persona.set_failed", { persona: p.id, via: source });
      return { ok: false, message: `sotto: ERROR could not save the persona to ${this.paths.prefs}.`, code: "prefs_write" };
    }
    const effective = this.effectiveVoice(undefined, list);
    const voice = effective !== prevVoice ? effective : null;
    this.config = { ...this.config, voice: effective };
    this.log.info("persona.set", { persona: p.id, from: prev, source: p.source, via: source, voice: effective, voice_changed: !!voice, state: this.state });
    const live = this.state === "live" && !!this.sideband && !!this.live;
    const switching = live && (this.live.persona !== p.id || this.live.voice !== this.config.voice);
    if (switching) this.switchLivePersona(p);
    else if (this.state === "reconnecting") { this.personaSwitch = p.id; if (voice) this.voiceSwitch = voice; }
    this.changed();
    const withVoice = voice ? ` with the ${voice} voice` : "";
    let message;
    if (switching) message = `sotto: persona set to ${p.id}${withVoice}. Switching the live session now.`;
    else if (prev === p.id && !voice && (!this.live || this.live.persona === p.id)) message = `sotto: persona is already ${p.id}.`;
    else if (LIVE_STATES.has(this.state) || this.state === "reconnecting") message = `sotto: persona set to ${p.id}${withVoice}. The session switches as soon as it is ready.`;
    else message = `sotto: persona set to ${p.id}${withVoice}. It applies to the next voice session.`;
    return { ok: true, message, persona: p.id, voice: this.config.voice, switching };
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
    this.trackApprovals(event, b);

    // Notification-style events (§6.10.1). They never touch busy/delivery
    // state. SubagentStop always carries agent_id, so it is handled here,
    // before the subagent branch below.
    if (this.handleNoticeHook(event, b)) { this.statusFile.mark(); return true; }

    // Subagent hooks (agent_id set: subagents, workflow agents) run in the
    // owner's env too. The user watches the parent session, not its agents
    // (SPEC-DEVIATIONS "Claude card"), so they never touch busy/delivery
    // state, the held main-thread message or the card's text; they only count
    // toward "N background agents working". Permission prompts and questions
    // are still announced: the terminal asks the user those.
    if (typeof b.agent_id === "string" && b.agent_id) {
      this.agents.seen(b.agent_id);
      this.syncAgents();
      // A subagent that hands back through SubagentHandback delivers its report
      // as that call's message (last_assistant_message is then only its closing text).
      if (event === "PreToolUse" && b.tool_name === "SubagentHandback" && typeof b.tool_input?.message === "string") {
        this.reports.set(b.agent_id, b.tool_input.message);
        while (this.reports.size > 50) this.reports.delete(this.reports.keys().next().value);
      }
      if (event === "PreToolUse" && ASK_TOOLS.has(b.tool_name)) this.onAsk(b);
      else if (event === "PermissionRequest") this.onPermissionRequest(b);
      this.statusFile.mark();
      return true;
    }

    switch (event) {
      case "UserPromptSubmit":
        this.delegation.onHook(event, b);
        // A task-notification naming a background agent is its completion,
        // if its SubagentStop did not already count it.
        for (const note of parseTaskNotifications(b.prompt)) {
          if (this.agents.complete(note.taskId)) this.syncAgents();
          const rec = this.work.bind(note.toolUseId, note.taskId) || this.work.byAgent(note.taskId);
          if (this.work.finish(rec)) {
            const ok = !note.status || note.status === "completed";
            this.narrator.onAgentDone({ label: rec.label, result: ok ? reportSentence(note.result || note.summary) : `It ${note.status === "killed" ? "was stopped" : note.status}.` });
          }
        }
        if (!this.delegation.wasStopped(b.prompt_id)) {
          this.narrator.onTurnStart();
          this.clearAwaiting();
        }
        this.toolLine.reset();
        this.cardSaid = "";
        this.activity("turn_start", "Claude is working");
        break;
      case "PreToolUse": {
        this.delegation.onHook(event, b);
        if (ASK_TOOLS.has(b.tool_name)) { this.onAsk(b); break; }
        if (b.tool_name === "Agent" || b.tool_name === "Task") { this.agents.launched(); this.syncAgents(); }
        // Top-level background work, by name, for "Fixing X is done" later.
        if (["Agent", "Task", "Workflow", "Bash"].includes(b.tool_name) && isBackgroundLaunch(b.tool_name, b.tool_input)) this.work.launch(b.tool_use_id, b.tool_name, b.tool_input);
        this.narrator.onToolUse(b.tool_name, b.tool_input);
        const line = this.toolLine.push(b.tool_name, b.tool_input);
        if (line) this.activity("tool", line);
        break;
      }
      case "PermissionRequest":
        this.delegation.onHook(event, b);
        this.onPermissionRequest(b);
        break;
      case "PostToolUse":
      case "PermissionDenied":
        // Forwarded for the approval lifecycle only (trackApprovals above).
        break;
      case "MessageDisplay":
        // Hook POSTs race; a batch of a message/turn that already ended is dropped.
        if (!this.narrator.onMessageDisplay(b)) { this.log.debug("hook.late", { event }); break; }
        this.delegation.onHook(event, b);
        {
          // Claude's own words so far (not the raw delta: batches split words
          // and markdown), sanitized like speech, first sentence or two.
          const said = cardText(this.narrator.messageSoFar(b.message_id));
          if (said && said !== this.cardSaid) { this.cardSaid = said; this.activity("text", said); }
        }
        break;
      case "Stop": {
        this.agents.noteTasks(b.background_tasks);
        this.work.bindTasks(b.background_tasks);
        const q = awaitingQuestion(b.last_assistant_message);
        if (q) this.setAwaiting(q, "stop");
        else if (this.awaiting) { this.awaiting = null; this.changed(); } // an AskUserQuestion answered in the terminal
        this.narrator.flushMilestones();
        this.narrator.onStop(b);
        // The final message as markdown, for the finished card (rendered safely by the page).
        this.activity("turn_end", "Claude finished", typeof b.last_assistant_message === "string" && b.last_assistant_message.trim() ? { summary: b.last_assistant_message.slice(0, 4000) } : null);
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

  // ---- tool approvals (SPEC §6.10.4) --------------------------------------------------
  /** PermissionRequest (main thread or a subagent): announce it, show it, remind about it. */
  onPermissionRequest(b) {
    if (ASK_TOOLS.has(b.tool_name)) { this.onAsk(b); return; }
    const label = permissionLabel(b.tool_name, b.tool_input);
    const { approval: p, fresh } = this.approvals.onRequest(b, label);
    if (!fresh) return;
    this.log.info("approval.pending", { id: p.id, agent: p.agent, tool: p.tool, pending: this.approvals.size });
    this.narrator.onPermission(b.tool_name, b.tool_input, { id: p.id, agent: p.agent });
    this.showApproval(p);
    this.approvalsChanged();
  }

  showApproval(p) {
    this.activity("permission", `${p.agent ? "A background agent" : "Claude"} needs approval to ${p.label}`, { agent: p.agent });
  }

  /** Evidence that approvals were answered (see approvals.js). */
  trackApprovals(event, b) {
    if (!this.approvals.size && event !== "PreToolUse") return;
    let done = [];
    switch (event) {
      case "PreToolUse": done = this.approvals.onPreToolUse(b); break;
      case "PostToolUse": case "PostToolUseFailure": case "PermissionDenied": done = this.approvals.onToolDone(b); break;
      case "Stop": case "StopFailure": if (!(typeof b.agent_id === "string" && b.agent_id)) done = this.approvals.onThreadEnd(b); break;
      case "SubagentStop": if (typeof b.agent_id === "string" && b.agent_id) done = this.approvals.onThreadEnd(b); break;
      case "UserPromptSubmit":
        // Typed in the terminal: every prompt there is answered. Prompts Claude
        // Code submits itself answer only the main thread's (a subagent's
        // dialog can still be open behind a task notification).
        if (AUTO_PROMPT.test(typeof b.prompt === "string" ? b.prompt : "")) done = this.approvals.onThreadEnd({});
        else done = this.approvals.onUserPrompt();
        break;
      default: break;
    }
    this.approvalsResolved(done);
  }

  approvalsResolved(done) {
    if (!done.length) return;
    const now = this.clock.now();
    for (const p of done) this.log.info("approval.resolved", { id: p.id, agent: p.agent, reason: p.reason, held_ms: now - p.at, pending: this.approvals.size });
    // An announcement or reminder still waiting in the speech queue is no longer true.
    const keys = new Set(done.flatMap((p) => [`approval:${p.id}`, `reminder:${p.id}`]));
    this.speech.cancel((a) => typeof a.dedupeKey === "string" && [...keys].some((k) => a.dedupeKey.startsWith(k)));
    const next = this.approvals.current();
    if (next) this.showApproval(next);
    else this.activity("approval_cleared", "", { busy: this.delegation.claudeBusy });
    this.approvalsChanged();
  }

  /** After any change: the PostToolUse gate, the reminder, the probe and the status. */
  approvalsChanged() {
    const any = this.approvals.size > 0;
    if (any !== !!this.approvalFlag) { this.approvalFlag = any; setApprovalPending(this.paths, any); }
    this.scheduleApprovalReminder();
    if (this.approvals.probeable().length) { if (!this.timers.approvalProbe) this.interval("approvalProbe", () => this.probeApprovals(), APPROVAL_PROBE_MS); }
    else this.clear("approvalProbe");
    this.changed();
  }

  clearApprovals() {
    this.approvals.clear();
    this.clear("approvalRemind");
    this.clear("approvalProbe");
    if (this.approvalFlag) { this.approvalFlag = false; setApprovalPending(this.paths, false); }
  }

  scheduleApprovalReminder() {
    const at = this.approvals.nextDueAt();
    if (at === null) { this.clear("approvalRemind"); return; }
    this.timer("approvalRemind", () => this.remindApprovals(), Math.max(0, at - this.clock.now()));
  }

  /**
   * "By the way, Claude's still waiting on your approval…" at 2 and 5 min
   * (Claude Code never times a permission prompt out). Never over the user:
   * while they speak it waits; the speech queue waits for the voice.
   */
  remindApprovals() {
    const now = this.clock.now();
    if (now - this.transcript.lastUserSpeechAt < REMIND_USER_QUIET_MS) {
      this.timer("approvalRemind", () => this.remindApprovals(), 1000);
      return;
    }
    const due = this.approvals.takeDue(now);
    for (const p of due) p.reminders++;
    if (due.length) {
      this.log.info("approval.remind", { ids: due.map((p) => p.id), waited_ms: due.map((p) => now - p.at) });
      this.deliver({ kind: "commentary", content: reminderSpeech(due, this.reminderVariant++), delegationId: null, source: "approval_reminder", dedupeKey: `reminder:${due.map((p) => p.id).join(",")}:${due[0].reminders}` });
    }
    this.scheduleApprovalReminder();
  }

  /** A pending Bash approval whose command is running was approved (approvals.js). */
  async probeApprovals() {
    if (this.probing) return;
    const list = this.approvals.probeable();
    if (!list.length) { this.clear("approvalProbe"); return; }
    this.probing = true;
    let ps = "";
    try { ps = await this.processList(); } catch { ps = ""; } finally { this.probing = false; }
    const done = [];
    for (const p of list) {
      if (!this.approvals.pending.has(p.id)) continue;
      if (findRunning(ps, commandFingerprint(p.command), [process.pid])) done.push(...this.approvals.resolve(p.id, "running"));
    }
    this.approvalsResolved(done);
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
        // Only a real agent finishing counts, once per id (AgentTracker): the
        // internal progress-line agent Claude Code runs every ~30 s beside a
        // background agent also fires SubagentStop, with an id that is none
        // of the session's agents. Spoken only as "A background agent
        // finished", and only if the parent does not speak for it
        // (policy.js onAgentDone); the parent's own summary (its turn, or the
        // task-notification turn) is what the user hears.
        this.agents.noteTasks(b.background_tasks);
        this.work.bindTasks(b.background_tasks);
        if (!this.agents.complete(b.agent_id)) {
          this.log.info("agent.stop_ignored", { why: this.agents.isDone(b.agent_id) ? "already_done" : "not_an_agent" });
          return true;
        }
        this.syncAgents();
        // Announced only for work the parent launched; a nested agent (a
        // subagent's own, or a workflow's) is counted but never spoken.
        const rec = this.work.byAgent(b.agent_id);
        const report = this.reports.get(b.agent_id) || b.last_assistant_message;
        this.reports.delete(b.agent_id);
        if (this.work.finish(rec)) this.narrator.onAgentDone({ label: rec.label, result: reportSentence(report), detail: detail ? `${name[0].toUpperCase()}${name.slice(1)}: ${detail}` : "" });
        else this.log.info("agent.stop_nested", {});
        return true;
      }
      case "TaskCompleted": {
        // A TaskCompleted naming one of our background agents is that agent
        // finishing (counted once, like its SubagentStop); anything else is
        // a checklist task.
        if (typeof b.task_id === "string" && this.agents.isKnown(b.task_id)) {
          if (this.agents.complete(b.task_id)) this.syncAgents();
          const rec = this.work.byAgent(b.task_id);
          if (this.work.finish(rec)) this.narrator.onAgentDone({ label: rec.label, result: "" });
          return true;
        }
        // A checklist tick (TaskCreate/TaskUpdate) is Claude's bookkeeping: the
        // card shows it, the voice model never gets it (it narrated them).
        const subject = clip(speakable(b.task_subject || "").replace(/[.!?…]+$/, ""), 80);
        if (subject) this.activity("task", `Task done: ${subject}`);
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
        const app = msg.host === "app";
        this.log.warn("page.mic_error", { name: truncate(String(msg.name || ""), 40), message: truncate(String(msg.message || ""), 200), host: app ? "app" : "browser" });
        // In the app every refusal is macOS privacy for "Sotto" (lib.micFailureKind).
        this.setLastError(denied ? "mic_denied" : "mic_error", denied && app ? APP_MIC_BLOCKED : truncate(String(msg.message || msg.name || "microphone error"), 200));
        this.clear("waitingPage");
        if (this.state !== "off" && this.state !== "closing") this.setState("paused");
        break;
      }
      case "rtc_state": this.onRtcState(msg.state); break;
      case "dc_open": case "dc_closed": break;
      case "muted": if (this.live) { this.live.muted = !!msg.muted; this.changed(); } break;
      case "activity": this.noteLocalSpeech(); break;
      case "cant_hear": this.onCantHear(msg); break;
      case "mic_silent": this.onMicSilent(msg).catch((e) => this.log.error("mic_silent.error", { message: String(e && e.message) })); break;
      case "mic_fallback":
        this.log.warn("page.mic_fallback", {
          from: truncate(String(msg.from || ""), 16), to: truncate(String(msg.to || ""), 16), reason: truncate(String(msg.reason || ""), 32),
          input: truncate(String(msg.input_label || ""), 120), ok: msg.ok === undefined ? undefined : !!msg.ok,
          ms: Number.isFinite(Number(msg.ms)) ? Number(msg.ms) : undefined,
          permission: msg.permission === undefined ? undefined : truncate(String(msg.permission), 16),
          bundle_replaced: msg.bundle_replaced === undefined ? undefined : !!msg.bundle_replaced,
        });
        break;
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
        // A window swap quits the app on purpose: the session moves, it does not pause.
        if (this.sideband && !this.swapping) this.pause("unload", { command: false });
        break;
      default: break;
    }
  }

  /**
   * The page cannot hear the user (§7.5 "Can't hear you"): log it and have the
   * voice say so once per session, at most once per CANT_HEAR_SAY_MS.
   */
  onCantHear(msg) {
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
    this.log.warn("page.cant_hear", {
      kind: truncate(String(msg.kind || ""), 32), input: truncate(String(msg.input_label || ""), 120),
      peak_rms: num(msg.peak_rms), speech_ms: num(msg.speech_ms), since_ms: num(msg.since_ms),
    });
    const now = this.clock.now();
    if (this.state !== "live" || !this.live || this.live.cantHearSaid) return;
    if (this.cantHearSaidAt !== undefined && now - this.cantHearSaidAt < CANT_HEAR_SAY_MS) return;
    this.live.cantHearSaid = true;
    this.cantHearSaidAt = now;
    this.deliver({ kind: "instructions", content: cantHearInstruction(this.cantHearVariant++), delegationId: null });
  }

  /**
   * Swap a stale app after an install only at a quiet moment, with the same
   * gate as the self-update (restartBlocker, QUIET_MS of no speech, no
   * delegation or Claude work in flight): quitting it mid-conversation dropped
   * the voice for about 2.7 s while a request was in flight (v0.3.2 install).
   * With no voice session nothing is at risk, so it swaps at once. An old app
   * that is actually broken (only digital silence from its mic) is swapped at
   * once by onMicSilent, not here.
   */
  scheduleStaleSwap(reason) {
    const attempt = (first) => {
      const why = this.owner ? this.restartBlocker(QUIET_MS) : null;
      if (why === null || why === "no_owner") {
        this.clear("staleSwap");
        this.staleSwapWaiting = null;
        this.checkStaleApp(reason).catch((e) => this.log.error("app.stale_error", { message: String(e && e.message) }));
        return;
      }
      if (first) this.log.info("app.swap_deferred", { reason, blocker: why });
      this.staleSwapWaiting = why;
      this.timer("staleSwap", () => attempt(false), STALE_SWAP_POLL_MS);
    };
    attempt(true);
  }

  /**
   * Quit app processes that run a replaced bundle (SPEC §6.16 "Stale app"):
   * at daemon start and after every install. One that hosts our page moves
   * the voice to a fresh app window; others just quit.
   */
  async checkStaleApp(reason) {
    const w = this.chrome;
    if (typeof w?.staleApps !== "function") return false;
    // appLaunched: this daemon (or its predecessor, §6.17) opened the app, whose page may be connected or reconnecting.
    if (w.appLaunched) {
      const stale = await w.staleApps();
      if (!stale.length) return false;
      this.staleRestarted = true;
      return this.swapWindow(`stale_app_${reason}`, { chrome: false });
    }
    return (await w.quitStaleApps(reason)) > 0;
  }

  /**
   * The page hears only digital silence (all-zero samples) from its mic
   * (SPEC §6.16 "Silent mic"). In the app: a stale app (replaced bundle)
   * restarts once; otherwise the voice moves to Chrome. Never sit silent.
   */
  async onMicSilent(msg = {}) {
    const input = truncate(String(msg.input_label || ""), 120);
    const app = msg.host === "app";
    this.log.warn("page.mic_silent", { input, source: truncate(String(msg.source || ""), 24), ms: Number.isFinite(Number(msg.ms)) ? Number(msg.ms) : undefined, host: app ? "app" : "browser" });
    this.setLastError("mic_silent", `The microphone (${input || "unknown"}) delivered only silence`);
    const w = this.chrome;
    // appAttached: the native app may have been opened by the user, not launched by this daemon.
    if (!app || !(w?.appLaunched || this.appAttached()) || typeof w.replaceApp !== "function") return false;
    const now = this.clock.now();
    if (this.micSilentAt !== undefined && now - this.micSilentAt < MIC_SILENT_SWAP_MS) return false;
    this.micSilentAt = now;
    const stale = this.staleRestarted ? [] : await w.staleApps();
    if (stale.length) {
      this.staleRestarted = true;
      return this.swapWindow("mic_silent_stale_app", { chrome: false });
    }
    return this.swapWindow("mic_silent", { chrome: true });
  }

  /**
   * Quit the app and reopen the voice window (a fresh app, or Chrome), keeping
   * the voice on: a live session reconnects in the new window.
   */
  async swapWindow(reason, { chrome = false } = {}) {
    if (this.swapping || typeof this.chrome?.replaceApp !== "function") return false;
    this.swapping = true;
    this.log.warn("window.swap", { reason, to: chrome ? "chrome" : "app", state: this.state });
    try {
      await this.chrome.replaceApp({ reason, chrome });
    } catch (e) {
      this.log.error("window.swap_error", { message: String(e && e.message) });
    } finally {
      this.swapping = false;
    }
    // To Chrome: the page is the audio client from now on (a native app no longer holds the voice).
    if (chrome && this.audioClient === "app") this.audioClient = null;
    if (!this.owner || this.state === "off" || this.state === "closing") return true;
    if (LIVE_STATES.has(this.state)) this.reconnect(reason);
    // Open the new window now instead of after RECONNECT_OPEN_MS.
    this.clear("reconnectOpen");
    if (this.config.open_browser !== false) this.chrome.open({ force: true });
    return true;
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
    // One audio client (docs/NATIVE.md §4.2): the attached native app owns the voice.
    if (this.appAttached()) return { status: 409, body: { error: { code: "app_took_over", message: "Voice is in the Sotto app." } } };
    const p = await this.prepareSession(reason, wake);
    if (!p.ok) return { status: p.status, body: p.body };
    const { why, owner, apiKey, instructions, seed, voice, persona } = p;
    const body = buildSessionBody({ instructions, seed, voice, sdp });
    this.lastSessionCreateAt = this.clock.now();
    const res = await createLiveSession({ base: this.base, apiKey, body, fetchImpl: this.fetchImpl, clock: this.clock });
    this.log.info("session.create", { ms: res.ms, status: res.status ?? null, ok: res.ok, model: body.session.model, live_id: res.id || null, code: res.code || null, reason: why, voice, persona: persona.id });

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
    this.audioClient = "page";
    this.beginLive(res.id, why, voice, persona);
    this.attachSideband(res.id, why, apiKey);
    this.changed();
    return { status: 201, body: { session_id: res.id, sdp: res.sdp } };
  }

  /**
   * The transport-independent part of a session start (docs/NATIVE.md §4.2):
   * owner/cap/key/restart checks, closing an older session, the seed (voice
   * history, pending result, backlog), the glossary and the instructions.
   * Returns {ok:false, status, body} or {ok:true, why, owner, apiKey, instructions, seed, voice}.
   * `gen` (native path): a newer start supersedes this one while it awaits.
   */
  async prepareSession(reason, wake, { gen = null } = {}) {
    if (!this.owner) return { ok: false, status: 409, body: { error: { code: "not_active", message: "Voice is not on. Run /talk on in Claude Code." } } };
    if (this.capReached()) return { ok: false, status: 429, body: { error: { code: "daily_cap", message: `Daily voice cap reached (${this.config.daily_cap_minutes} min).` } } };
    const apiKey = this.getApiKey();
    if (!apiKey) {
      this.setLastError("no_api_key", "OPENAI_API_KEY was not found");
      return { ok: false, status: 503, body: { error: { code: "no_api_key", message: "OPENAI_API_KEY was not found." } } };
    }
    if (this.restarting) return { ok: false, status: 503, body: { error: { code: "restarting", message: "Sotto is updating; the voice comes back in a moment." } } };
    const why = SESSION_REASONS.includes(reason) ? reason : "start";
    this.clear("waitingPage");
    this.clear("notifyWatch");
    if (why === "wake" || why === "notify") this.logWakeRequest(why, wake);

    // An older session still open: close it, but do not wait.
    if (this.sideband) {
      const old = this.sideband;
      this.sideband = null;
      this.native?.sessionGone(old, "session_end");
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
    if (this.owner !== owner || this.state !== "connecting" || (gen !== null && gen !== this.nativeGen)) {
      return { ok: false, status: 409, body: { error: { code: "not_active", message: "Voice was turned off." } } };
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
    const persona = this.currentPersona();
    const instructions = renderForPolicy(owner.project, this.policy, vocab.text, persona);
    // Resolved from prefs.json for every session (start, reconnect, wake, restart, handover).
    const voice = this.effectiveVoice();
    this.config.voice = voice;
    return { ok: true, why, owner, apiKey, instructions, seed, voice, persona };
  }

  /** Bookkeeping for a new Live session (both transports). `id` is null on the primary socket until session.started. */
  beginLive(id, why, voice, persona = null) {
    this.counters.sessions_created++;
    // Words of the old session not yet sent anywhere go now: the new session's
    // timeline restarts at 0 (§6.18).
    this.mirror.flush("new_session");
    this.transcript.newSession();
    this.delegation.resetTimeline();
    this.mirror.resetTimeline();
    const now = this.clock.now();
    this.live = { id, started_at: now, expires_at: Math.floor(now / 1000) + 7200, usage_seconds: 0, muted: false, reason: why, greeted: false, voice, persona: persona?.id ?? null, personaName: persona?.name ?? null, wakeHandled: false };
    this.governor.onWake(why === "wake" ? "voice" : why === "notify" ? "notify" : why);
    if (id) this.usageSeen.set(id, 0);
    // pendingResult and backlog were seeded into the new session.
    this.pendingResult = null;
    this.backlog = [];
    if (this.lastError && /^openai_|page_timeout|mic_/.test(this.lastError.code)) this.lastError = null;
  }

  /**
   * Start a Live session on the primary WebSocket for the native app
   * (docs/NATIVE.md §4.2-§4.3): the daemon's own replacement for the page's
   * POST /api/session. Never waits for session.started. Returns
   * {ok:true} or {ok:false, status, body} like prepareSession.
   */
  async startNativeSession(reason, { wake } = {}) {
    const gen = ++this.nativeGen;
    this.audioClient = "app";
    this.clear("nativeRetry");
    const p = await this.prepareSession(reason, wake, { gen });
    if (!p.ok) {
      const code = p.body?.error?.code;
      this.log.info("session.native_skip", { reason, code });
      if (code === "daily_cap") {
        this.setLastError("daily_cap", `Daily voice cap reached (${this.config.daily_cap_minutes} min)`);
        if (this.owner && this.state !== "off" && this.state !== "closing") this.setState("paused");
      } else if (code === "no_api_key" && this.owner && this.state !== "off" && this.state !== "closing") {
        this.setState("paused");
      }
      return p;
    }
    const { why, apiKey, instructions, seed, voice, persona } = p;
    const start = buildPrimaryStart({ instructions, seed, voice });
    this.lastSessionCreateAt = this.clock.now();
    this.log.info("session.create", { transport: "websocket", ok: true, model: start.session.model, reason: why, voice, persona: persona.id });
    this.beginLive(null, why, voice, persona);
    const sb = new PrimarySession({
      url: `${wssBase(this.base)}/live/sessions`, apiKey, start,
      WebSocketImpl: this.WebSocketImpl, clock: this.clock, log: this.log, counters: this.counters, debug: this.debug,
    });
    this.sideband = sb;
    sb.primary = true;
    sb.startReason = reason; // native-session.js: a reconnect or wake keeps "heard" (lib.createHearingMonitor)
    sb.on("ready", (r) => this.onSidebandReady(sb, why, r));
    sb.on("event", (evt) => this.onLiveEvent(sb, evt));
    sb.on("session_closed", (r) => this.onSessionClosed(sb, r));
    sb.on("append_failed", (f) => this.onAppendFailed(sb, f));
    sb.on("lost", (info) => { this.onPrimaryLost(sb, info).catch((e) => this.log.error("live.lost_error", { message: String(e && e.message) })); });
    this.native?.bindSession(sb);
    sb.connect();
    this.changed();
    return { ok: true };
  }

  /**
   * The primary socket closed without session.closed. Before session.started
   * it is a start failure (handshake refused, bad config): the key is checked
   * once to tell a rejected key from an OpenAI problem, and voice pauses.
   * After it, the session is lost: reconnect with the usual limiter.
   */
  async onPrimaryLost(sb, { code, started, error } = {}) {
    if (this.sideband !== sb) return;
    this.sideband = null;
    this.native?.sessionGone(sb, "session_end");
    if (started) { this.reconnect("primary_lost"); return; }
    this.stopLiveTimers();
    this.live = null;
    let lastCode = "openai_error";
    let message = error?.message ? `OpenAI refused the voice session: ${truncate(error.message, 200)}` : `Could not start the voice session with OpenAI (socket closed${code ? ` ${code}` : ""}).`;
    const apiKey = this.getApiKey();
    if (apiKey) {
      const v = await validateKey({ base: this.base, key: apiKey, fetchImpl: this.fetchImpl, clock: this.clock });
      this.log.info("session.start_failed", { code, key_ok: v.ok, key_code: v.code || null, error_code: error?.code || null });
      if (!v.ok && (v.code === "invalid_key" || v.code === "key_forbidden" || v.code === "no_model_access")) { lastCode = "openai_auth"; message = v.message; }
      else if (!v.ok && v.code === "rate_limited") { lastCode = "openai_rate_limit"; message = v.message; }
    }
    if (this.sideband || this.state === "off" || this.state === "closing") return;
    this.setLastError(lastCode, message);
    this.notice("error", lastCode, message);
    if (this.owner) this.setState("paused");
  }

  /** The app is the audio client now (NativeController.attach, after hello). */
  onAppAttached() {
    this.audioClient = "app";
    this.clear("appRestore");
    const restoring = this.awaitApp;
    this.awaitApp = false;
    const sb = this.sideband;
    if (sb && !sb.primary) {
      // A page holds the session (WebRTC): it hands the voice to the app.
      this.log.info("native.took_over", { state: this.state });
      this.sse.broadcast({ type: "command", command: "disconnect", reason: "app_took_over" });
      this.sse.broadcast({ type: "notice", level: "info", code: "app_took_over", text: "Voice is in the Sotto app." });
      this.sideband = null;
      this.stopLiveTimers();
      sb.close(3000).catch(() => {});
      this.live = null;
      this.speech.suspend();
      this.setState("reconnecting");
      this.startNativeSession("reconnect");
      return;
    }
    if (!this.owner) { this.changed(); return; }
    if (!this.sideband && (this.state === "waiting_page" || this.state === "reconnecting")) {
      this.startNativeSession(this.state === "reconnecting" || restoring ? "reconnect" : "start");
      return;
    }
    this.changed();
  }

  /** The app link closed. With a session it keeps running on silence until the grace period ends (pacer). */
  onAppDetached() { this.changed(); }

  /** The app was gone longer than the grace period (§4.4): pause; a page that connects later works as today. */
  onAppGone() {
    this.log.info("native.app_gone", { state: this.state, audio_client: this.audioClient });
    // The voice already moved to a page (a silent-mic swap to Chrome): nothing to pause.
    if (this.audioClient !== "app") { this.changed(); return; }
    this.audioClient = null;
    if (this.sideband?.primary || this.state === "connecting" || this.state === "live" || this.state === "reconnecting") this.pause("app_gone");
    else this.changed();
  }

  /** cmd mute from the app: the primary session's input mute (§3.3). */
  setMuted(on) {
    this.muteWanted = !!on;
    const sb = this.sideband;
    // Before session.started the new session applies it on ready (onSidebandReady).
    if (sb && sb.state !== "closed" && sb.ready) {
      sb.send(on ? "session.input_audio.mute" : "session.input_audio.unmute");
      if (this.live) this.live.muted = !!on;
    }
    this.changed();
    return { muted: !!on };
  }

  /** cmd resume / wake (a user tap) from the app. */
  resumeFromApp(reason = "resume") {
    if (!this.owner || this.state === "off" || this.state === "closing") return { ok: false, code: "not_active", message: "Voice is not on. Run /talk on in Claude Code." };
    if (this.capReached()) return { ok: false, code: "daily_cap", message: `Daily voice cap reached (${this.config.daily_cap_minutes} min).` };
    if (this.sideband || this.state === "connecting" || this.state === "live") return { ok: true };
    this.startNativeSession(reason);
    return { ok: true };
  }

  /** cmd open_browser: drop the app as audio client and open the Chrome page (manual fallback). */
  openBrowserFromApp() {
    this.log.info("native.open_browser", { state: this.state });
    this.audioClient = null;
    const hadSession = !!this.sideband || this.state === "connecting" || this.state === "live" || this.state === "reconnecting";
    const done = () => {
      if (this.owner && this.state !== "off" && this.state !== "closing") {
        this.setState("waiting_page");
        this.timer("waitingPage", () => this.onPageTimeout(), WAITING_PAGE_MS);
      }
      return this.chrome.open({ want: "chrome" });
    };
    if (hadSession) {
      this.clear("nativeRetry");
      return this.closeLive(3000, "session_end").then(done);
    }
    return Promise.resolve(done());
  }

  /** Mac sleep (app `system {event:"sleep"}`): a graceful close; sleeping, or paused with wake off (§3.2). */
  onSystemSleep() {
    this.log.info("native.system_sleep", { state: this.state });
    if (!this.owner) return;
    if (this.sideband || this.state === "live" || this.state === "connecting" || this.state === "reconnecting") {
      this.pause("mac_sleep", { sleep: this.config.wake_sensitivity !== "off" });
    }
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
      // Silent context (thinking), not instructions: a glossary is reasoning
      // material and an instructions append can cut off the voice mid-sentence.
      if (content) this.deliver({ kind: "thinking", content, delegationId: null });
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
    if (sb.primary) {
      // The primary socket learns its session id from session.started.
      this.live.id = sb.id;
      if (sb.id && !this.usageSeen.has(sb.id)) this.usageSeen.set(sb.id, 0);
      if (this.muteWanted) { sb.send("session.input_audio.mute"); this.live.muted = true; }
    }
    this.liveStartedAt = this.clock.now();
    this.setState("live");
    // The voice changed while this session was being created: switch again
    // right away (no greeting in the voice the user just left).
    if (this.live.voice !== this.config.voice) {
      this.switchLiveVoice(this.config.voice);
      return;
    }
    // Same for the persona (§4.6).
    const persona = this.currentPersona();
    if (this.live.persona !== persona.id) {
      this.switchLivePersona(persona);
      return;
    }
    if (!this.live.greeted) {
      this.live.greeted = true;
      const switched = reason === "reconnect" && this.voiceSwitch === this.live.voice;
      const personaSwitched = reason === "reconnect" && this.personaSwitch === this.live.persona;
      this.voiceSwitch = null;
      this.personaSwitch = null;
      // The first session after a self-update (§6.17) says so, once.
      const updated = this.updateCue && (reason === "reconnect" || reason === "resume");
      this.updateCue = false;
      // Several starts in a few minutes (closing and reopening the window) greet
      // with a short, varied line instead of the same full sentence each time.
      const now = this.clock.now();
      this.greetedAt = (this.greetedAt || []).filter((t) => now - t < RECENT_GREETING_MS);
      const g = personaSwitched ? personaSwitchGreeting(this.live.personaName) : switched ? voiceSwitchGreeting(this.live.voice) : updated ? updateGreeting() : greeting(reason, this.policy, this.owner?.project, { recent: this.greetedAt.length });
      if (g && reason === "start" && !switched && !personaSwitched && !updated) this.greetedAt.push(now);
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
        this.style.onOutput(evt.delta);
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
  async closeLive(timeoutMs = 15000, flushReason = "session_end") {
    this.stopLiveTimers();
    const sb = this.sideband;
    this.sideband = null;
    if (sb) this.native?.sessionGone(sb, flushReason);
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
    this.clear("nativeRetry");
    await this.closeLive(15000, sleep ? "sleep" : "pause");
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
    const sleep = this.config.wake_sensitivity !== "off" && this.hasListener();
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
      lastLocalSpeechAt: this.lastPageActivityAt,
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

  /**
   * The local mic detector heard speech while live (the page's "activity", or
   * the app's relayed mic in native-session.js): holds off idle sleep and the
   * false-wake verdict (§6.15) even while no transcript arrives.
   */
  noteLocalSpeech() { this.lastPageActivityAt = this.clock.now(); }

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
      this.emitPage({ type: "wake_heard", text });
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
    await this.closeLive(3000, "session_end");
    if (this.state !== "reconnecting") return;
    this.requestReconnect("expiry");
  }

  /**
   * Ask the page for a replacement session. The SSE command is one-shot, so
   * if no page is listening, open the window (it auto-connects in the
   * "reconnecting" state), and if nothing starts a session within 30 s,
   * pause with a notice instead of sitting in "reconnecting" forever.
   */
  requestReconnect(reason, { delayMs = 0 } = {}) {
    if (this.audioClient === "app" && (this.native?.connected || this.awaitApp)) {
      // Native app: the daemon starts the replacement itself (docs/NATIVE.md §4.2).
      if (this.native?.connected) {
        const go = () => { if (this.state === "reconnecting" && !this.sideband) this.startNativeSession("reconnect"); };
        if (delayMs > 0) this.timer("nativeRetry", go, delayMs); else go();
      }
      this.timer("reconnectWatch", () => {
        if (this.state !== "reconnecting" || this.sideband) return;
        this.log.warn("reconnect.timeout", { reason });
        this.setLastError("connection_lost", "The voice connection did not come back");
        this.setState("paused");
        this.notice("warn", "connection_lost", "The voice connection dropped and did not come back, so voice is paused. Resume when ready.");
      }, RECONNECT_WATCH_MS);
      return;
    }
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
    if (old) this.native?.sessionGone(old, "session_end");
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
    this.requestReconnect(reason, { delayMs: NATIVE_RECONNECT_BACKOFF_MS[this.reconnects.length - 1] ?? 2000 });
  }

  onSessionClosed(sb, { reason, seconds }) {
    if (seconds != null) this.onUsage(sb.id, seconds, { persist: true });
    else this.persistUsage();
    if (this.sideband !== sb || sb.closing) return; // expected (we asked)
    // The server ended the session on its own.
    this.sideband = null;
    this.native?.sessionGone(sb, "session_end");
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
    this.clear("nativeRetry");
    this.clear("appRestore");
    this.awaitApp = false;
    await this.closeLive(15000, "off");
    if (gen !== this.offGen) return; // re-bound while closing
    this.delegation.orphanAll();
    this.delegation.resetClaudeState(); // a later /talk on may be another session
    this.narrator.dispose();
    this.narrator.resetTurn();
    this.agents.reset(); this.work.reset(); this.reports.clear(); this.toolLine.reset(); this.agentsShown = 0;
    this.clearApprovals();
    this.speech.drain();
    this.style.reset();
    this.nonce = null;
    this.voiceSwitch = null;
    this.personaSwitch = null;
    this.awaiting = null;
    this.muteWanted = false;
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
    this.clear("nativeRetry");
    if (this.sideband || this.live) {
      this.command("disconnect", "update");
      await this.closeLive(3000, "session_end");
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
      // The native app carried the audio (docs/NATIVE.md §4.4): the successor waits for its hello.
      audio_client: this.appAttached() ? "app" : this.audioClient === "page" ? "page" : null,
      muted: !!this.muteWanted,
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
    this.configVoice = this.config.voice;
    this.config.voice = this.effectiveVoice();
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
    this.muteWanted = snap.muted === true;
    if (snap.audio_client === "app") this.audioClient = "app";
    if (snap.resume === "live" && snap.audio_client === "app") {
      // The app reconnects to the successor (close 4005, then re-bootstrap):
      // its hello starts the session (onAppAttached). No app within 10 s:
      // fall back to the page path.
      this.updateCue = true;
      this.awaitApp = true;
      this.setState("reconnecting");
      this.timer("appRestore", () => {
        if (!this.awaitApp) return;
        this.awaitApp = false;
        this.log.warn("update.app_missing", {});
        this.audioClient = null;
        if (this.state === "reconnecting" && !this.sideband) this.requestReconnect("update");
      }, APP_RESTORE_WAIT_MS);
    } else if (snap.resume === "live") {
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
    this.style.reset();
    this.statusFile.stop();
  }
}
