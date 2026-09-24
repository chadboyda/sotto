// sotto web page: WebRTC voice client, daemon event stream, and UI.
//
// Contract: docs/SPEC.md §7. The daemon owns the Live session lifecycle; this page
// owns the microphone, the WebRTC peer connection and the display. The page never
// sends the Live "start" event (the SDP POST starts the session) and only sends
// `session.close` itself on unload or when the daemon has been unreachable for 20 s.

import * as lib from "./lib.js";
import * as wakeLib from "./wake.js";
import { createDial } from "./dial.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ICE_TIMEOUT_MS = 10_000; // §7.3 step 4
const START_TIMEOUT_MS = 25_000; // no `session.started` after the SDP answer -> give up
const SSE_LOST_MS = 20_000; // §7.3 exception 2
const SSE_DOWN_LABEL_MS = 1_500; // grace before the header says "Disconnected"
const CLOSE_WAIT_MS = 2_000; // how long a page-initiated close waits for `session.closed`
const MUTE_ACK_MS = 3_000;
const BANNER_MS = 8_000;
const KEY_INPUT = "clv.inputDeviceId";
const KEY_OUTPUT = "clv.outputDeviceId";
/** Post the wake latency report at the first model output, or after this long. */
const WAKE_TIMING_MAX_MS = 20_000;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = {
  body: document.body,
  audio: $("remote-audio"),
  statusLabel: $("status-label"),
  statusDetail: $("status-detail"),
  project: $("project"),
  clock: $("clock"),
  usage: $("usage"),
  banners: $("banners"),
  dialCanvas: $("dial-canvas"),
  muteBtn: $("mute-btn"),
  stageWord: $("stage-word"),
  stageSub: $("stage-sub"),
  connectSteps: $("connect-steps"),
  keyHint: $("key-hint"),
  keyHintVerb: $("key-hint-verb"),
  keyHintSpace: $("key-hint-space"),
  micHint: $("mic-hint"),
  overlay: $("overlay"),
  overlayTitle: $("overlay-title"),
  overlayBody: $("overlay-body"),
  overlaySteps: $("overlay-steps"),
  overlayPending: $("overlay-pending"),
  overlayPendingText: $("overlay-pending-text"),
  overlayNote: $("overlay-note"),
  overlayScroll: $("overlay-scroll"),
  overlayBtn: $("overlay-btn"),
  overlayKbd: $("overlay-kbd"),
  wakeSelect: $("wake-select"),
  promptPointer: $("prompt-pointer"),
  keyField: $("key-field"),
  keyInput: $("api-key-input"),
  keySave: $("api-key-save"),
  keyError: $("api-key-error"),
  keySummary: $("key-summary"),
  keyChangeBtn: $("key-change-btn"),
  keyRemoveBtn: $("key-remove-btn"),
  keyEdit: $("key-edit"),
  keyEditInput: $("key-edit-input"),
  keyEditSave: $("key-edit-save"),
  keyHelp: $("key-help"),
  claude: $("claude"),
  claudeTitle: $("claude-title"),
  claudeTime: $("claude-time"),
  claudeStep: $("claude-step"),
  claudeCommand: $("claude-command"),
  claudeNote: $("claude-note"),
  summary: $("summary"),
  moreBtn: $("more-btn"),
  claudeRequest: $("claude-request"),
  captions: $("captions"),
  captionsPanel: $("captions-panel"),
  capPrev: $("cap-prev"),
  capLatest: $("cap-latest"),
  captionsEmpty: $("captions-empty"),
  announcer: $("announcer"),
  alertAnnouncer: $("alert-announcer"),
  top: document.querySelector(".top"),
  settings: $("settings"),
  settingsBtn: $("settings-btn"),
  settingsClose: $("settings-close"),
  policy: $("policy"),
  policyHelp: $("policy-help"),
  voiceSelect: $("voice-select"),
  voiceHelp: $("voice-help"),
  inputSelect: $("input-select"),
  outputSelect: $("output-select"),
  pauseBtn: $("pause-btn"),
  stopBtn: $("stop-btn"),
};

// The voice instrument around the mute button (web/dial.js). Decoration must never
// take the voice client down: if the canvas cannot be created (no 2D context, a
// WebKit without an API it uses), the page runs with a dial that draws nothing.
let dial;
try {
  dial = createDial(el.dialCanvas);
} catch (err) {
  console.warn("[sotto] dial unavailable:", err?.message || err);
  dial = { set() {}, input() {} };
}

// Inside the Sotto desktop app (SPEC §6.16) the bridge defines this before
// app.js runs. Only the microphone copy depends on it: there is no Chrome there.
const HOST = window.sottoHost?.platform === "macos-app" ? "app" : "browser";

// localStorage can throw (blocked storage); every access goes through here.
const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value === null || value === undefined || value === "") localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
};

// Page credentials (§6.4 bootstrap). The daemon opens this window with a
// one-time launch code in the URL fragment (#k=...). It is traded at
// /api/bootstrap for the persistent page secret, which is kept for this tab in
// sessionStorage so re-bootstrapping after a daemon restart keeps working.
const KEY_SECRET = "clv.pageSecret";
const creds = {
  launch: null,
  secret: null,
  init() {
    try {
      this.secret = sessionStorage.getItem(KEY_SECRET);
    } catch {
      /* storage blocked */
    }
    const m = /(?:^#|&)k=([0-9a-f]{16,})/i.exec(location.hash || "");
    if (m) {
      this.launch = m[1];
      // Remove the code from the address bar and history.
      try {
        history.replaceState(null, "", location.pathname + location.search);
      } catch {
        /* ignore */
      }
    }
  },
  headers() {
    const h = {};
    if (this.secret) h["X-Sotto-Boot"] = this.secret;
    if (this.launch) h["X-Sotto-Launch"] = this.launch;
    return h;
  },
  accept(secret) {
    this.launch = null; // single use: consumed by the successful bootstrap
    if (!secret) return;
    this.secret = secret;
    try {
      sessionStorage.setItem(KEY_SECRET, secret);
    } catch {
      /* ignore */
    }
  },
};
creds.init();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
/**
 * phase (local, page-side):
 *   boot       - before the first bootstrap
 *   idle       - no peer connection; the overlay reflects the daemon state
 *   connecting - mic + SDP exchange in flight, or waiting for session.started
 *   live       - session.started received
 *   error      - mic or session start failed; waits for the user or a daemon command
 *   lost       - daemon unreachable for 20 s while live; torn down
 *   closed     - daemon said close_window
 *   replaced   - a newer sotto page took over (BroadcastChannel)
 */
const S = {
  phase: "boot",
  build: null, // web/ hash the daemon served this page with (§6.17 reload)
  gen: 0, // bumps on every connect/teardown; stale async steps check it
  token: null,
  status: null,
  booted: false,
  // event stream
  sse: null,
  sseUp: false,
  sseDownSince: null,
  sseAttempt: 0,
  sseTimer: null,
  lostTimer: null,
  // media
  pc: null,
  dc: null,
  sender: null,
  mic: null,
  inputHint: null,
  liveSessionId: null,
  startedAt: null,
  dcUsage: 0,
  startTimer: null,
  closedWaiters: [],
  unauthorized: false, // bootstrap refused: this window was not opened by the daemon
  // mute
  muted: false,
  wantMuted: false,
  mutePending: null,
  connectReason: null,
  // display
  errorText: null,
  pausedReason: null,
  pendingResult: null,
  busy: false,
  activity: { text: "Claude is idle", tone: "info" },
  summary: null,
  captions: [],
  delegations: [],
  // redesign (design/AUDIT.md): view inputs
  micPrompt: false, // Chrome's mic prompt is open (permissions.query said "prompt")
  micFailure: null, // lib.micFailureKind() of the last getUserMedia failure
  errorCode: null, // daemon error code of the last failed connect (e.g. no_api_key)
  connectStage: null, // "mic" | "network" | "session" while connecting
  floor: null, // "you" | "voice" | null, from the level meters
  claudeKind: null, // last SSE activity kind
  claudeText: "",
  workSince: null,
  summaryExpanded: false,
  voices: null, // GET /api/voices
  view: null, // last lib.pageView()
};

// ---------------------------------------------------------------------------
// Daemon API
// ---------------------------------------------------------------------------
function pageHeaders() {
  return { "Content-Type": "application/json", "X-Sotto-Page": S.token || "" };
}

/** Fire-and-forget page event (§6.4 POST /api/page). Never throws. */
function post(type, fields = {}) {
  if (!S.token) return;
  fetch("/api/page", {
    method: "POST",
    headers: pageHeaders(),
    body: JSON.stringify({ type, ...fields }),
    keepalive: true,
  }).catch(() => {});
}

/** Console + daemon log for warnings and errors (§10). */
function logRemote(level, message) {
  const text = String(message).slice(0, 2000);
  (level === "error" ? console.error : level === "warn" ? console.warn : console.info)("[sotto]", text);
  if (level === "error" || level === "warn" || level === "info") post("log", { level, message: text });
}

async function fetchJson(url, init) {
  const res = await fetch(url, { cache: "no-store", ...init });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return { ok: res.ok, status: res.status, body };
}

// ---------------------------------------------------------------------------
// Event stream (SSE) with re-bootstrap, so a daemon restart (new page token) heals.
// ---------------------------------------------------------------------------
function scheduleEvents() {
  clearTimeout(S.sseTimer);
  if (S.phase === "replaced") return;
  S.sseTimer = setTimeout(startEvents, lib.backoffDelay(S.sseAttempt++));
}

async function startEvents() {
  clearTimeout(S.sseTimer);
  if (S.phase === "replaced") return;
  let boot;
  try {
    boot = await fetchJson("/api/bootstrap", { headers: creds.headers() });
  } catch {
    boot = null;
  }
  if (boot && boot.status === 403) {
    if (!S.unauthorized) {
      S.unauthorized = true;
      render();
    }
    markSseDown();
    scheduleEvents();
    return;
  }
  if (!boot || !boot.ok || !boot.body?.page_token) {
    markSseDown();
    scheduleEvents();
    return;
  }
  creds.accept(boot.body.page_secret);
  if (S.unauthorized) S.unauthorized = false;
  // Self-update (§6.17): a daemon that restarted with a different web/ serves
  // a new page. Reload into it while no session is up (the daemon closed it
  // before restarting); the secret in sessionStorage survives the reload.
  const build = typeof boot.body.build === "string" ? boot.body.build : null;
  if (lib.shouldReloadForBuild(S.build, build, !!S.pc)) {
    logRemote("info", "page: new build after a daemon update; reloading");
    location.replace(lib.reloadUrl(location.pathname, location.search));
    return;
  }
  if (build) S.build = build;
  const restarted = S.token !== null && boot.body.page_token !== S.token;
  S.token = boot.body.page_token;
  loadVoices();
  if (restarted) {
    // A new daemon knows nothing about our old Live session (its sideband is gone),
    // so close it rather than keep paying for an orphan.
    if (S.pc) {
      showBanner("info", "The sotto daemon restarted.", "daemon_restart");
      await closeSessionAndTeardown();
    }
  }

  const es = new EventSource(`/api/events?token=${encodeURIComponent(S.token)}`);
  S.sse = es;
  es.onopen = () => {
    if (S.sse !== es) return;
    S.sseAttempt = 0;
    markSseUp();
    post("hello", { user_agent: navigator.userAgent });
  };
  es.onmessage = (e) => {
    if (S.sse !== es) return;
    const msg = lib.parseEventData(e.data);
    if (msg) handleDaemonMessage(msg);
  };
  es.onerror = () => {
    if (S.sse !== es) return;
    // Handle every failure the same way: drop this stream and re-bootstrap, because
    // a restarted daemon rejects the old token with 403 (EventSource would give up).
    es.close();
    S.sse = null;
    markSseDown();
    scheduleEvents();
  };

  applyStatus(boot.body.status);
  if (!S.booted) {
    S.booted = true;
    const auto = new URLSearchParams(location.search).get("autostart") === "1";
    const st = S.status?.state;
    if (S.phase === "boot") setPhase("idle");
    // "reconnecting": the daemon may have reopened this window because the
    // one-shot reconnect command had no listener; start the replacement now.
    if (auto || st === "waiting_page" || st === "reconnecting") connect(lib.connectReason(st));
  }
}

function markSseUp() {
  S.sseUp = true;
  S.sseDownSince = null;
  clearTimeout(S.lostTimer);
  if (S.phase === "lost") setPhase("idle");
  render();
}

function markSseDown() {
  if (S.sseUp || S.sseDownSince === null) {
    S.sseUp = false;
    S.sseDownSince = S.sseDownSince ?? Date.now();
    clearTimeout(S.lostTimer);
    S.lostTimer = setTimeout(onDaemonLost, SSE_LOST_MS);
    setTimeout(render, SSE_DOWN_LABEL_MS + 50);
  }
  render();
}

/** The daemon has been unreachable for 20 s. If we are holding a session, close it (billing safety). */
async function onDaemonLost() {
  if (S.sseUp) return;
  if (S.pc) {
    logRemote("warn", "daemon unreachable for 20 s; closing the voice session");
    await closeSessionAndTeardown();
    setPhase("lost");
  }
}

function handleDaemonMessage(msg) {
  switch (msg.type) {
    case "status":
      applyStatus(msg.status);
      break;
    case "command":
      handleCommand(msg.command, msg.reason);
      break;
    case "activity": {
      const v = lib.activityView(msg);
      S.activity = { text: v.text, tone: v.tone };
      if (v.busy !== null) setBusy(v.busy);
      if (v.summary) {
        S.summary = v.summary;
        S.summaryExpanded = false;
      }
      S.claudeKind = msg.kind || null;
      S.claudeText = msg.text || "";
      if (msg.kind === "turn_start") announce("Claude is working.");
      else if (msg.kind === "permission") announce(`Claude needs your approval in the terminal${msg.text ? `: ${lib.truncate(msg.text, 120)}` : ""}.`);
      else if (msg.kind === "turn_end") announce("Claude finished.");
      render();
      break;
    }
    case "delegation":
      S.delegations = lib.upsertDelegation(S.delegations, msg);
      renderClaude();
      break;
    case "notice":
      showBanner(msg.level || "info", msg.text || msg.code || "Notice", msg.code);
      break;
    case "wake_heard":
      // The words spoken before the woken session could hear them (§7.6).
      if (msg.text) {
        S.captions = lib.reduceCaptions(S.captions, { role: "user", text: String(msg.text), start_ms: 0, end_ms: 1, session: S.liveSessionId });
        renderCaptions();
      }
      break;
    case "result_pending":
      S.pendingResult = msg.text || null;
      if (msg.text) S.summary = lib.truncate(msg.text, 420);
      render();
      break;
    default:
      break;
  }
}

function applyStatus(st) {
  if (!st || typeof st !== "object") return;
  S.status = st;
  if (st.claude && typeof st.claude.busy === "boolean") setBusy(st.claude.busy);
  if (S.voices && st.voice && S.voices.current !== st.voice) {
    S.voices = { ...S.voices, current: st.voice };
    renderVoices();
  }
  if (st.state === "paused" && st.last_error?.code === "daily_cap") S.pausedReason = "daily_cap";
  renderKeySettings();
  if (st.state === "off" && S.pc) {
    // Voice was turned off; the daemon has closed (or is closing) the session.
    teardown();
  }
  if (st.state === "off") wake.release();
  // A fresh bind while this page is idle: connect (the daemon also sends a command,
  // and connect() ignores duplicates). Errors wait for the user or an explicit command
  // so a failing session create is never retried in a loop (each create bills 15 s).
  if (st.state === "waiting_page" && S.booted && ["idle", "lost", "closed"].includes(S.phase)) {
    connect("start");
  }
  // The daemon waits for a replacement session, but the one-shot "reconnect"
  // command may have been missed (event stream down at that moment). An idle
  // page that sees the state starts it; connect() de-duplicates the command.
  if (st.state === "reconnecting" && S.booted && ["idle", "lost", "closed"].includes(S.phase)) {
    connect("reconnect");
  }
  render();
}

function handleCommand(command, reason) {
  switch (command) {
    case "connect":
      if (S.phase === "connecting" || S.phase === "live") return;
      connect(lib.connectReason(S.status?.state, reason));
      break;
    case "disconnect":
      // Keep the mic: if the daemon is going to sleep, it listens for the wake.
      teardown({ keepMic: true });
      S.pausedReason = reason || "pause";
      setPhase("idle");
      break;
    case "reconnect":
      // Already reconnecting (started from the status update): don't restart it.
      if (S.phase === "connecting" && S.connectReason === "reconnect") return;
      connect("reconnect");
      break;
    case "close_window":
      teardown();
      wake.release();
      setPhase("closed");
      // Chrome allows scripts to close a single-page app window; if it refuses, the
      // overlay tells the user it is safe to close, and the daemon kills the window.
      setTimeout(() => {
        try {
          window.close();
        } catch {
          /* ignore */
        }
      }, 150);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Microphone and devices
// ---------------------------------------------------------------------------
class MicError extends Error {
  constructor(name, message) {
    super(message);
    this.name = name;
  }
}

/** "granted" | "denied" | "prompt" | null (Permissions API unavailable). Watches changes once. */
let micPermStatus = null;
async function micPermission() {
  try {
    micPermStatus ??= await navigator.permissions.query({ name: "microphone" });
    if (!micPermStatus.onchange) {
      micPermStatus.onchange = () => {
        // Allowed from site settings while an error card is up: offer the retry at once.
        if (micPermStatus.state === "granted" && S.phase === "error" && S.micFailure) render();
      };
    }
    return micPermStatus.state;
  } catch {
    return null;
  }
}

async function listDevices() {
  try {
    return await navigator.mediaDevices.enumerateDevices();
  } catch {
    return [];
  }
}

async function openMic(deviceId) {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
  if (deviceId) audio.deviceId = { exact: deviceId };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio });
  } catch (err) {
    // The chosen device vanished between enumerate and open: fall back to the default once.
    if (deviceId && (err?.name === "OverconstrainedError" || err?.name === "NotFoundError")) {
      delete audio.deviceId;
      return navigator.mediaDevices.getUserMedia({ audio });
    }
    throw err;
  }
}

/**
 * Open the mic per §7.3 step 1 / §7.5 "Default mic". Device labels (needed for the
 * Bluetooth -> built-in rule) only exist after permission, so on a first run we open
 * the default device, re-enumerate, and switch if the rule picks another device.
 */
async function acquireMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new MicError("NotSupportedError", "This browser cannot capture audio.");
  }
  const saved = store.get(KEY_INPUT);
  let devices = await listDevices();
  let stream = null;
  const labelled = devices.some((d) => d.kind === "audioinput" && d.label);
  if (!labelled) {
    // Chrome is about to ask: show the Allow-microphone state while it does (AUDIT #1).
    S.micPrompt = (await micPermission()) === "prompt";
    if (S.micPrompt) render();
    try {
      stream = await openMic(null);
    } finally {
      if (S.micPrompt) {
        S.micPrompt = false;
        render();
      }
    }
    devices = await listDevices();
  }
  const pick = lib.pickInputDevice(devices, saved);
  S.inputHint = pick.hint;
  if (stream) {
    const current = stream.getAudioTracks()[0]?.getSettings?.().deviceId;
    const wanted = pick.deviceId;
    if (wanted && wanted !== "default" && current !== wanted) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  }
  // "default" follows the system default device, which is what no deviceId does too.
  if (!stream) stream = await openMic(pick.deviceId === "default" ? null : pick.deviceId);
  fillDeviceSelects(devices);
  return stream;
}

function fillSelect(select, options, value) {
  const prev = select.value;
  select.replaceChildren(
    ...options.map(([v, label]) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      return o;
    }),
  );
  const want = value ?? prev;
  select.value = options.some(([v]) => v === want) ? want : "";
}

function fillDeviceSelects(devices) {
  const inputs = devices.filter((d) => d.kind === "audioinput" && d.deviceId !== "communications");
  const outputs = devices.filter((d) => d.kind === "audiooutput" && d.deviceId !== "default" && d.deviceId !== "communications");
  const savedIn = store.get(KEY_INPUT) || "";
  fillSelect(
    el.inputSelect,
    [["", "Automatic"], ...inputs.filter((d) => d.deviceId).map((d, i) => [d.deviceId, lib.deviceLabel(d, i)])],
    inputs.some((d) => d.deviceId === savedIn) ? savedIn : "",
  );
  fillSelect(
    el.outputSelect,
    [["", "System default"], ...outputs.filter((d) => d.deviceId).map((d, i) => [d.deviceId, lib.deviceLabel(d, i)])],
    lib.pickOutputDevice(devices, store.get(KEY_OUTPUT)),
  );
}

async function refreshDevices() {
  const devices = await listDevices();
  fillDeviceSelects(devices);
  await applySink();
  // If the device we are using disappeared (unplugged), move to the automatic choice.
  const track = S.mic?.getAudioTracks()[0];
  if (S.pc && track) {
    const id = track.getSettings?.().deviceId;
    if (track.readyState === "ended" || (id && !devices.some((d) => d.kind === "audioinput" && d.deviceId === id))) {
      switchMic(store.get(KEY_INPUT));
    }
  }
}

/** Replace the mic mid-session without renegotiating (RTCRtpSender.replaceTrack). */
async function switchMic(savedId) {
  if (!S.pc || !S.sender) return;
  const gen = S.gen;
  try {
    const devices = await listDevices();
    const pick = lib.pickInputDevice(devices, savedId);
    S.inputHint = pick.hint;
    const stream = await openMic(pick.deviceId === "default" ? null : pick.deviceId);
    if (gen !== S.gen || !S.sender) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const track = stream.getAudioTracks()[0];
    await S.sender.replaceTrack(track);
    const old = S.mic;
    S.mic = stream;
    watchTrack(track);
    old?.getTracks().forEach((t) => t.stop());
    meter.attach(stream);
    post("mic_ok", { input_label: track.label || "", output_label: selectedText(el.outputSelect) });
    render();
  } catch (err) {
    logRemote("warn", `mic switch failed: ${err?.name || ""} ${err?.message || err}`);
    showBanner("warn", lib.micErrorMessage(err?.name), "mic_switch");
  }
}

function watchTrack(track) {
  track.onended = () => {
    if (S.mic?.getAudioTracks()[0] === track && S.pc) switchMic(store.get(KEY_INPUT));
  };
}

async function applySink() {
  const id = el.outputSelect.value || "";
  if (typeof el.audio.setSinkId !== "function") return;
  try {
    if (el.audio.sinkId !== id) await el.audio.setSinkId(id);
  } catch (err) {
    logRemote("warn", `setSinkId failed: ${err?.name || ""} ${err?.message || err}`);
  }
}

function selectedText(select) {
  return select.selectedOptions?.[0]?.textContent || "";
}

// ---------------------------------------------------------------------------
// Level meters + local speech activity (§7.5). Neither analyser is connected to
// the destination: they only measure, they never play anything. The voice meter
// reads a CLONE of the remote track, so the <audio> element stays the only
// playback path and Chrome's echo-cancellation reference (§7.3 step 2).
// ---------------------------------------------------------------------------
const meter = {
  ctx: null,
  source: null,
  analyser: null,
  buf: null,
  freq: null,
  vTrack: null,
  vSource: null,
  vAnalyser: null,
  vBuf: null,
  vFreq: null,
  vPeak: 0,
  vFrames: 0,
  raf: 0,
  level: 0,
  voice: 0,
  detector: lib.createActivityDetector({ threshold: 0.02, holdMs: 300, minIntervalMs: 10_000 }),
  floor: lib.createFloorTracker(),

  analyserFor(source) {
    const a = this.ctx.createAnalyser();
    a.fftSize = 512;
    a.smoothingTimeConstant = 0.55;
    source.connect(a);
    return a;
  },

  attach(stream) {
    // Mic only: a mid-session mic switch keeps the voice meter.
    this.stopTick();
    try {
      this.source?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
      this.source = this.ctx.createMediaStreamSource(stream);
      this.analyser = this.analyserFor(this.source);
      this.buf = new Float32Array(this.analyser.fftSize);
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      this.raf = requestAnimationFrame(this.tick);
    } catch (err) {
      logRemote("warn", `level meter unavailable: ${err?.message || err}`);
    }
  },

  attachVoice(track) {
    this.detachVoice();
    if (!this.ctx || !track) return;
    try {
      this.vTrack = track.clone();
      this.vSource = this.ctx.createMediaStreamSource(new MediaStream([this.vTrack]));
      this.vAnalyser = this.analyserFor(this.vSource);
      this.vBuf = new Float32Array(this.vAnalyser.fftSize);
      this.vFreq = new Uint8Array(this.vAnalyser.frequencyBinCount);
      this.vPeak = 0;
      this.vFrames = 0;
    } catch (err) {
      logRemote("warn", `voice meter unavailable: ${err?.message || err}`);
      this.detachVoice();
    }
  },

  detachVoice() {
    // One line per session: proof that the unplayed clone of the remote track really
    // carries the model's audio into WebAudio (test/e2e/smoke.mjs checks the peak).
    if (this.vAnalyser && this.vFrames > 0) logRemote("info", `voice meter: peak ${this.vPeak.toFixed(3)} over ${this.vFrames} reads`);
    this.vPeak = 0;
    this.vFrames = 0;
    try {
      this.vSource?.disconnect();
    } catch {
      /* ignore */
    }
    this.vTrack?.stop();
    this.vTrack = this.vSource = this.vAnalyser = null;
    this.voice = 0;
  },

  detach() {
    this.stopTick();
    try {
      this.source?.disconnect();
    } catch {
      /* ignore */
    }
    this.detachVoice();
    this.source = null;
    this.analyser = null;
    this.level = 0;
    this.detector.reset();
    this.floor.reset();
    dial.input(0, 0, null, null);
    setFloor(null);
  },

  tick() {
    if (!this.analyser) return;
    this.analyser.getFloatTimeDomainData(this.buf);
    const value = lib.rms(this.buf);
    const mic = lib.levelFromRms(value);
    let voice = 0;
    if (this.vAnalyser) {
      this.vAnalyser.getFloatTimeDomainData(this.vBuf);
      voice = lib.levelFromRms(lib.rms(this.vBuf));
      this.vFrames++;
      if (voice > this.vPeak) this.vPeak = voice;
    }
    const live = S.phase === "live";
    // Spectra only when there is something to show: a quiet window costs two RMS sums per frame.
    let mBands = null;
    let vBands = null;
    if (live && mic > 0.12) {
      this.analyser.getByteFrequencyData(this.freq);
      mBands = lib.bandLevels(this.freq, 48, { minBin: 2, maxBin: 120 });
    }
    if (live && voice > 0.08) {
      this.vAnalyser.getByteFrequencyData(this.vFreq);
      vBands = lib.symmetricProfile(lib.bandLevels(this.vFreq, 12, { minBin: 2, maxBin: 90 }), 72);
    }
    dial.input(live ? lib.gateLevel(mic) : 0, live ? lib.gateLevel(voice, 0.08) : 0, mBands, vBands);
    if (live) setFloor(this.floor.update(S.muted ? 0 : mic, voice, performance.now()));
    if (live && !S.muted && this.detector.update(value, performance.now())) post("activity");
    // Quiet: poll at 20 Hz (enough for the floor word and the activity detector);
    // sound: every frame, so the dial follows the voice.
    const quiet = lib.gateLevel(mic) === 0 && lib.gateLevel(voice, 0.08) === 0;
    if (quiet) this.raf = -setTimeout(this.tick, 50);
    else this.raf = requestAnimationFrame(this.tick);
  },

  stopTick() {
    if (this.raf < 0) clearTimeout(-this.raf);
    else cancelAnimationFrame(this.raf);
    this.raf = 0;
  },
};

meter.tick = meter.tick.bind(meter);

/** Who has the floor changed: update the dial word, not the whole page. */
function setFloor(floor) {
  if (S.floor === floor) return;
  S.floor = floor;
  if (S.phase === "live") {
    // No "Sotto is speaking" announcement: it would talk over the voice it describes.
    renderStage();
  }
}

// ---------------------------------------------------------------------------
// Local voice wake (§7.6). While the daemon is `sleeping` there is no Live
// session; the mic stays open here (no network, nothing billed) and a local
// voice-activity detector (wake.js) listens. Speech re-creates the session, and
// the audio from speech onset until it is live is posted as `wake_audio` so the
// daemon can transcribe the opening words for the model.
// ---------------------------------------------------------------------------
function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

const wake = {
  stream: null, // mic held while sleeping (kept from the last session, or opened to listen)
  source: null,
  node: null,
  vad: null,
  rec: null,
  sr: 48000,
  moduleCtx: null,
  listening: false,
  opening: false,
  triggered: false,
  gen: 0,
  micError: null,
  timing: null,
  timingTimer: 0,
  shown: -1,

  hold(stream) {
    if (this.stream && this.stream !== stream) stopStream(this.stream);
    this.stream = stream;
  },

  /** The held stream for a new session, if its track is still live. The capture keeps running. */
  takeStream() {
    const s = this.stream;
    this.stream = null;
    if (s && s.getAudioTracks()[0]?.readyState === "live") return s;
    stopStream(s);
    return null;
  },

  release() {
    this.stop();
    stopStream(this.stream);
    this.stream = null;
  },

  async start() {
    const gen = ++this.gen;
    this.opening = true;
    try {
      let stream = this.stream;
      if (!stream || stream.getAudioTracks()[0]?.readyState !== "live") {
        stopStream(stream);
        this.stream = null;
        stream = await acquireMic();
        if (gen !== this.gen) {
          stopStream(stream);
          return;
        }
        this.stream = stream;
      }
      meter.ctx ??= new AudioContext();
      const ctx = meter.ctx;
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      if (this.moduleCtx !== ctx) {
        await ctx.audioWorklet.addModule("wake-worklet.js");
        this.moduleCtx = ctx;
      }
      if (gen !== this.gen) return;
      const cfg = S.status?.wake || {};
      this.sr = ctx.sampleRate;
      this.vad = wakeLib.createVad({ sampleRate: ctx.sampleRate, sensitivity: cfg.sensitivity, boostDb: cfg.boost_db });
      this.rec = wakeLib.createClipRecorder({ sampleRate: ctx.sampleRate });
      this.source = ctx.createMediaStreamSource(stream);
      this.node = new AudioWorkletNode(ctx, "clv-wake-tap", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: "explicit" });
      this.node.port.onmessage = (e) => this.onFrame(e.data);
      this.source.connect(this.node);
      this.listening = true;
      this.triggered = false;
      this.micError = null;
      logRemote("info", `wake: listening (sensitivity ${cfg.sensitivity || "medium"}, boost ${cfg.boost_db || 0} dB, ${ctx.sampleRate} Hz)`);
    } catch (err) {
      if (gen !== this.gen) return;
      this.micError = err?.name || "error";
      logRemote("warn", `wake: cannot listen: ${err?.name || ""} ${err?.message || err}`);
    } finally {
      if (gen === this.gen) this.opening = false;
      render();
    }
  },

  /** Stop analysing (the stream itself is kept or released by the caller). */
  stop() {
    this.gen++;
    this.opening = false;
    this.listening = false;
    this.triggered = false;
    try {
      this.source?.disconnect();
    } catch {
      /* ignore */
    }
    if (this.node) this.node.port.onmessage = null;
    this.source = this.node = null;
    this.vad = null;
    this.rec?.reset();
    this.rec = null;
    this.paint(0);
  },

  /** A wake-triggered connect failed: drop the capture. */
  abort() {
    if (this.triggered) this.stop();
    this.timing = null;
  },

  onFrame(frame) {
    if (!this.vad || !(frame instanceof Float32Array)) return;
    this.rec.push(frame);
    const r = this.vad.process(frame);
    this.paint(lib.levelFromRms(10 ** (r.db / 20)));
    if (this.triggered || !this.listening || !r.trigger) return;
    const cfg = S.status?.wake;
    if (wakeLib.cooldownLeft(cfg, Date.now()) > 0) return;
    const now = performance.now();
    const onsetAgo = ((this.vad.samples - r.onsetSample) / this.sr) * 1000;
    this.triggered = true;
    this.rec.startCapture(r.onsetSample - Math.round((wakeLib.ONSET_PAD_MS / 1000) * this.sr));
    this.timing = { onset: now - onsetAgo, trigger: now, snr: r.snrDb, level: r.db, voiced: r.voicedMs };
    logRemote("info", `wake: speech detected (${Math.round(r.voicedMs)} ms voiced, ${r.snrDb.toFixed(1)} dB over the noise floor)`);
    connect("wake", {
      wakeMeta: {
        onset_to_post_ms: now - this.timing.onset, trigger_ms: now - this.timing.onset, snr_db: r.snrDb, level_db: r.db,
        voiced_ms: r.voicedMs, boost_db: cfg?.boost_db || 0, sensitivity: cfg?.sensitivity || "medium",
      },
    });
  },

  /** The woken session is live: send the captured opening words to the daemon. */
  onLive(sessionId) {
    if (!this.triggered || !this.rec) return;
    const samples = this.rec.finish();
    const sr = this.sr;
    this.stop();
    const t = this.timing || {};
    t.live = performance.now();
    const wav = wakeLib.encodeWav(samples, sr);
    // Not post(): keepalive requests are limited to 64 KB, and a clip is larger.
    fetch("/api/page", {
      method: "POST",
      headers: pageHeaders(),
      body: JSON.stringify({ type: "wake_audio", session_id: sessionId, clip_ms: Math.round((samples.length / sr) * 1000), audio: wakeLib.bytesToBase64(wav) }),
    }).catch((err) => logRemote("warn", `wake: clip upload failed: ${err?.message || err}`));
    t.posted = performance.now();
    this.timing = t;
    clearTimeout(this.timingTimer);
    this.timingTimer = setTimeout(() => this.report(), WAKE_TIMING_MAX_MS);
  },

  onFirstOutput() {
    if (!this.timing?.live || this.timing.output) return;
    this.timing.output = performance.now();
    this.report();
  },

  /** Wake latency (onset -> trigger -> live -> model speaking), logged by the daemon. */
  report() {
    clearTimeout(this.timingTimer);
    const t = this.timing;
    this.timing = null;
    if (!t?.live) return;
    const f = {
      onset_to_trigger_ms: t.trigger - t.onset,
      trigger_to_live_ms: t.live - t.trigger,
      onset_to_live_ms: t.live - t.onset,
      clip_encode_ms: t.posted - t.live,
    };
    if (t.output) {
      f.live_to_first_output_ms = t.output - t.live;
      f.onset_to_first_output_ms = t.output - t.onset;
    }
    post("wake_timing", f);
  },

  /** Sleeping: the dial's inner ring shows what the wake detector hears (no audio leaves the machine). */
  paint(level) {
    const q = Math.round(level * 25) / 25;
    if (q === this.shown) return;
    this.shown = q;
    if (S.phase !== "live") dial.input(lib.gateLevel(q), 0, null, null);
  },
};

/** Arm, retune or disarm local wake listening to match the daemon and page state. */
function syncWake() {
  const st = daemonState();
  const cfg = S.status?.wake;
  const want = wakeLib.shouldListen({ state: st, phase: S.phase, sseUp: S.sseUp, muted: S.wantMuted, wake: cfg });
  if (want) {
    // After a mic failure, wait for the next sleep (or Space) instead of retrying in a loop.
    if (!wake.listening && !wake.opening && !wake.micError) wake.start();
    else if (wake.vad) {
      wake.vad.setSensitivity(cfg.sensitivity);
      wake.vad.setBoost(cfg.boost_db);
    }
    return;
  }
  if (wake.triggered) return; // our own wake is connecting: keep capturing until live
  if (wake.listening || wake.opening) wake.stop();
  if (st !== "sleeping") wake.micError = null;
  // A session that just closed hands its mic over while the daemon still says
  // live/connecting; it decides sleep vs pause a moment later (and a reconnect
  // reuses it). Otherwise release it: no open mic while paused or off.
  const transitional = ["live", "connecting", "sleeping", "reconnecting"].includes(st) && S.phase === "idle" && !S.wantMuted && cfg?.enabled !== false;
  if (wake.stream && !transitional) wake.release();
}

// ---------------------------------------------------------------------------
// Connect / teardown (§7.3)
// ---------------------------------------------------------------------------
async function connect(reason, { wakeMeta = null } = {}) {
  if (S.phase === "replaced") return;
  if ((S.phase === "connecting" || S.phase === "live") && reason !== "reconnect") return;
  teardown({ keepMic: true });
  const gen = ++S.gen;
  S.errorText = null;
  S.errorCode = null;
  S.micFailure = null;
  S.pausedReason = null;
  S.connectReason = reason;
  S.connectStage = "mic";
  setPhase("connecting");

  // 1. Microphone (the one kept open while sleeping, if still live: no reopen delay)
  let stream = wake.takeStream();
  try {
    stream ??= await acquireMic();
  } catch (err) {
    if (gen !== S.gen) return;
    const name = err?.name || "Error";
    post("mic_error", { name, message: String(err?.message || err) });
    S.micFailure = lib.micFailureKind(name, err?.message, await micPermission(), HOST);
    if (gen !== S.gen) return;
    fail(lib.micErrorMessage(name));
    return;
  }
  if (gen !== S.gen) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  S.mic = stream;
  const track = stream.getAudioTracks()[0];
  watchTrack(track);
  meter.attach(stream);
  await applySink();
  post("mic_ok", { input_label: track?.label || "", output_label: selectedText(el.outputSelect) });
  S.connectStage = "network";
  render();

  try {
    // 2. Peer connection; remote audio goes to the persistent <audio> element only.
    const pc = new RTCPeerConnection();
    S.pc = pc;
    pc.ontrack = (e) => {
      if (gen !== S.gen) return;
      el.audio.srcObject = new MediaStream([e.track]);
      // The dial meters an unplayed clone; the <audio> element stays the AEC reference.
      meter.attachVoice(e.track);
      el.audio.play().catch(() => audioBlocked());
    };
    pc.onconnectionstatechange = () => {
      if (gen !== S.gen) return;
      post("rtc_state", { state: pc.connectionState });
      if (pc.connectionState === "failed") logRemote("warn", "WebRTC connection failed");
      render();
    };
    S.sender = pc.addTrack(track, stream);

    // 3. Data channel, listeners registered before the offer.
    const dc = pc.createDataChannel("oai-events");
    S.dc = dc;
    dc.onopen = () => gen === S.gen && post("dc_open");
    dc.onclose = () => {
      if (gen !== S.gen) return;
      post("dc_closed");
      render();
    };
    dc.onmessage = (e) => gen === S.gen && handleDataChannel(e.data);

    // 4. Offer + complete ICE gathering.
    await pc.setLocalDescription(await pc.createOffer());
    await iceComplete(pc, ICE_TIMEOUT_MS);
    if (gen !== S.gen) return;
    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new Error("The browser produced no SDP offer.");

    // 5. SDP via the daemon.
    const res = await fetchJson("/api/session", {
      method: "POST",
      headers: pageHeaders(),
      body: JSON.stringify(wakeMeta ? { sdp, reason, wake: wakeMeta } : { sdp, reason }),
    });
    if (gen !== S.gen) return;
    if (!res.ok || !res.body?.sdp) {
      const code = res.body?.error?.code;
      if (code === "daily_cap") S.pausedReason = "daily_cap";
      S.errorCode = code || null;
      throw new Error(res.body?.error?.message || `The voice session could not be created (HTTP ${res.status}).`);
    }
    S.liveSessionId = res.body.session_id || null;
    S.dcUsage = 0;

    // 6. Answer. The SDP POST started the session; nothing else is sent to start it.
    await pc.setRemoteDescription({ type: "answer", sdp: res.body.sdp });
    if (gen !== S.gen) return;
    S.connectStage = "session";
    render();

    // 7. Live when `session.started` arrives on the data channel.
    S.startTimer = setTimeout(() => {
      if (gen !== S.gen || S.phase !== "connecting") return;
      logRemote("warn", "no session.started within 25 s of the SDP answer");
      post("pause"); // let the daemon close whatever it created
      fail("The voice session did not start.");
    }, START_TIMEOUT_MS);
  } catch (err) {
    if (gen !== S.gen) return;
    if (S.errorCode === "restarting") {
      // The daemon is swapping to new code (§6.17); its successor tells us
      // what to do next (reconnect, or keep sleeping), so wait quietly.
      logRemote("info", "connect: daemon is restarting");
      teardown({ keepMic: true });
      S.errorCode = null;
      setPhase("idle");
      return;
    }
    logRemote("error", `connect failed: ${err?.message || err}`);
    // fetch() rejects with a TypeError when the daemon is unreachable.
    fail(err instanceof TypeError ? "Could not reach the sotto daemon." : err?.message || "The voice session could not be started.");
  }
}

function fail(message) {
  const { micFailure, errorCode } = S;
  teardown();
  wake.abort();
  S.micFailure = micFailure;
  S.errorCode = errorCode;
  S.errorText = message;
  setPhase("error");
}

function iceComplete(pc, timeoutMs) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", check);
      reject(new Error("Timed out while gathering network candidates."));
    }, timeoutMs);
    function check() {
      if (pc.iceGatheringState !== "complete") return;
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    }
    pc.addEventListener("icegatheringstatechange", check);
  });
}

/**
 * Stop everything local. Does not send `session.close` (the daemon owns closing);
 * see closeSessionAndTeardown() for the two exceptions.
 */
function teardown({ keepMic = false } = {}) {
  S.gen++;
  clearTimeout(S.startTimer);
  clearTimeout(S.mutePending?.timer);
  S.mutePending = null;
  const { pc, dc, mic } = S;
  S.pc = S.dc = S.sender = S.mic = null;
  if (dc) {
    dc.onopen = dc.onclose = dc.onmessage = null;
    try {
      dc.close();
    } catch {
      /* ignore */
    }
  }
  if (pc) {
    pc.ontrack = pc.onconnectionstatechange = null;
    try {
      pc.close();
    } catch {
      /* ignore */
    }
  }
  // keepMic: hand the stream to the wake listener instead of stopping it; it is
  // released there unless the daemon goes to sleep (§7.6).
  if (keepMic && mic && mic.getAudioTracks()[0]?.readyState === "live") wake.hold(mic);
  else mic?.getTracks().forEach((t) => t.stop());
  meter.detach();
  el.audio.srcObject = null;
  dismissBannerKey("autoplay");
  S.muted = false;
  S.startedAt = null;
  S.liveSessionId = null;
  flushClosedWaiters();
  if (S.phase === "connecting" || S.phase === "live") S.phase = "idle";
  render();
}

/** Page-initiated close (unload excluded): send `session.close`, wait briefly for `session.closed`, tear down. */
async function closeSessionAndTeardown() {
  const dc = S.dc;
  if (dc && dc.readyState === "open") {
    try {
      dc.send(JSON.stringify({ type: "session.close", event_id: "clv_page_close" }));
      await new Promise((resolve) => {
        const t = setTimeout(resolve, CLOSE_WAIT_MS);
        S.closedWaiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    } catch {
      /* ignore */
    }
  }
  teardown();
}

function flushClosedWaiters() {
  const waiters = S.closedWaiters;
  S.closedWaiters = [];
  waiters.forEach((fn) => fn());
}

// ---------------------------------------------------------------------------
// Data channel events (§7.4)
// ---------------------------------------------------------------------------
function handleDataChannel(data) {
  const ev = lib.parseEventData(data);
  if (!ev) return;
  switch (ev.type) {
    case "session.started":
      clearTimeout(S.startTimer);
      if (ev.session?.id) S.liveSessionId = ev.session.id;
      S.startedAt = Date.now();
      S.pendingResult = null;
      S.pausedReason = null;
      S.connectStage = null;
      setPhase("live");
      announce("Connected. Listening.");
      // A new session starts unmuted server-side. Keep the user's mute across a
      // transparent reconnect; a start or resume begins unmuted (they chose to talk).
      if (S.connectReason === "reconnect" && S.wantMuted) sendMute(true);
      else S.wantMuted = false;
      if (S.connectReason === "wake") wake.onLive(S.liveSessionId);
      break;
    case "session.input_transcript.delta":
    case "session.output_transcript.delta":
      if (ev.type === "session.output_transcript.delta") wake.onFirstOutput();
      S.captions = lib.reduceCaptions(S.captions, {
        role: ev.type === "session.output_transcript.delta" ? "assistant" : "user",
        text: ev.delta ?? "",
        start_ms: ev.start_ms,
        end_ms: ev.end_ms,
        session: S.liveSessionId,
      });
      renderCaptions();
      break;
    case "session.input_audio.muted":
    case "session.input_audio.unmuted": {
      const muted = ev.type === "session.input_audio.muted";
      clearTimeout(S.mutePending?.timer);
      S.mutePending = null;
      // Announce the acknowledged change (not the optimistic send): M and Space work
      // from anywhere, and so does the desktop app's menu-bar mute (AUDIT #11).
      if (muted !== S.muted) announce(muted ? "Muted. Sotto can't hear you." : "Unmuted.");
      S.muted = muted;
      post("muted", { muted });
      render(); // the floor word, header and dial all follow mute
      break;
    }
    case "session.usage.updated":
      S.dcUsage = Number(ev.usage?.seconds) || S.dcUsage;
      renderHeader();
      break;
    case "session.closed": {
      if (typeof ev.usage?.seconds === "number") S.dcUsage = ev.usage.seconds;
      const text = lib.closedReasonMessage(ev.reason);
      if (ev.reason === "content") showBanner("error", text, "content");
      else if (text && ev.reason !== "expired") showBanner("info", text, `closed_${ev.reason}`);
      flushClosedWaiters();
      // The session is over. The daemon decides what comes next (sleep, pause
      // overlay, reconnect command, or close_window); the mic is kept only if
      // it goes to sleep (syncWake releases it otherwise).
      teardown({ keepMic: true });
      break;
    }
    case "error": {
      const detail = ev.error ? `${ev.error.code || ""} ${ev.error.message || ""}`.trim() : JSON.stringify(ev).slice(0, 500);
      logRemote("warn", `live error: ${detail}`);
      const banner = lib.errorBannerText(ev);
      if (banner) showBanner("error", banner, ev.error?.code || "live_error");
      break;
    }
    case "info":
      console.info("[sotto] live info", ev.code, ev.message);
      post("log", { level: "info", message: `live info: ${ev.code || ""} ${ev.message || ""}`.trim() });
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Mute (server-side mute on the data channel; the mic is never gated locally)
// ---------------------------------------------------------------------------
function toggleMute() {
  if (S.phase !== "live") return;
  const desired = !(S.mutePending ? S.mutePending.muted : S.muted);
  S.wantMuted = desired;
  sendMute(desired);
}

function sendMute(muted) {
  const dc = S.dc;
  if (!dc || dc.readyState !== "open") return;
  try {
    dc.send(JSON.stringify({ type: muted ? "session.input_audio.mute" : "session.input_audio.unmute", event_id: `clv_page_mute_${Date.now()}` }));
  } catch (err) {
    logRemote("warn", `mute send failed: ${err?.message || err}`);
    return;
  }
  clearTimeout(S.mutePending?.timer);
  S.mutePending = {
    muted,
    timer: setTimeout(() => {
      S.mutePending = null;
      render();
    }, MUTE_ACK_MS),
  };
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function setPhase(phase) {
  S.phase = phase;
  render();
}

function setBusy(busy) {
  if (busy && !S.busy) S.workSince = Date.now();
  if (!busy) S.workSince = null;
  S.busy = busy;
}

/** Polite screen-reader announcement: floor changes, Claude milestones, approvals (AUDIT #11). */
function announce(text) {
  el.announcer.textContent = "";
  requestAnimationFrame(() => (el.announcer.textContent = text));
}

function daemonState() {
  return S.status?.state || "off";
}

function sseDownLong() {
  return !S.sseUp && S.sseDownSince !== null && Date.now() - S.sseDownSince >= SSE_DOWN_LABEL_MS;
}

function attention() {
  return S.claudeKind === "permission" && !!S.busy;
}

function viewMuted() {
  return S.mutePending ? S.mutePending.muted : S.muted;
}

/** Everything visible derives from this snapshot (lib.pageView is pure and tested). */
function computeView() {
  const st = daemonState();
  return lib.pageView({
    phase: S.phase,
    state: st,
    sseDown: sseDownLong(),
    unauthorized: S.unauthorized && !S.pc,
    muted: viewMuted(),
    floor: S.floor,
    connectStage: S.connectStage,
    connectReason: S.connectReason,
    micPrompt: S.micPrompt,
    micFailure: S.micFailure,
    errorText: S.errorText,
    errorCode: S.errorCode,
    key: S.status?.key || null,
    pausedReason: S.pausedReason,
    idleMinutes: S.status?.idle_minutes,
    idleSeconds: S.status?.idle_seconds,
    capMinutes: S.status?.today?.cap_minutes,
    pendingResult: S.pendingResult,
    lastError: S.status?.last_error,
    attention: attention(),
    host: HOST,
    sleep:
      st === "sleeping"
        ? wakeLib.sleepView({
            muted: S.wantMuted,
            enabled: !!S.status?.wake?.enabled,
            cooldownMs: wakeLib.cooldownLeft(S.status?.wake, Date.now()),
            micError: wake.micError,
          })
        : null,
  });
}

/** Visible, enabled and still in the page: a place focus can stay. */
function focusable(node) {
  return !!node && node.isConnected && !node.disabled && node.offsetParent !== null;
}

/**
 * The control that had focus was hidden or disabled by this render (Pause after a
 * click, the card's button after Resume): move focus somewhere meaningful instead of
 * letting it fall to <body> (AUDIT #11).
 */
function restoreFocus(v) {
  const targets = v.card ? [el.overlayBtn, el.overlayTitle] : [el.muteBtn, el.stageWord];
  for (const t of targets) {
    if (t === el.overlayTitle || t === el.stageWord ? t.offsetParent !== null : focusable(t)) {
      t.focus({ preventScroll: true });
      return;
    }
  }
}

let lastCardKey = null;
/** Card changes are spoken: title plus the first sentence; errors interrupt (role=alert). */
function announceCard(v) {
  const key = v.card ? `${v.card.kind}|${v.card.title}` : null;
  if (key === lastCardKey) return;
  const first = lastCardKey === null && S.phase === "boot";
  lastCardKey = key;
  if (!v.card || first) return;
  const a = lib.cardAnnouncement(v.card);
  if (!a) return;
  if (a.assertive) {
    el.alertAnnouncer.textContent = "";
    requestAnimationFrame(() => (el.alertAnnouncer.textContent = a.text));
  } else announce(a.text);
}

function render() {
  syncWake();
  const prevFocus = document.activeElement;
  const hadFocus = prevFocus && prevFocus !== document.body && !el.settings.contains(prevFocus);
  const v = computeView();
  S.view = v;
  renderHeader(v);
  renderStage(v);
  renderMic(v);
  renderClaude();
  renderFooter(v);
  syncTicker();
  announceCard(v);
  if (hadFocus && !focusable(prevFocus) && prevFocus !== el.overlayTitle && prevFocus !== el.stageWord) restoreFocus(v);
}

/**
 * Header items by priority (status word > money > time > project > detail > "today"):
 * when the row is short of room, whole items hide instead of being cut to "claude…"
 * and "$0.…". The money is never truncated.
 */
function fitHeader() {
  const top = el.top;
  const text = el.statusLabel.parentElement;
  const suffix = el.usage.querySelector(".usage-suffix");
  el.project.hidden = !el.project.textContent;
  el.statusDetail.hidden = !el.statusDetail.textContent;
  if (suffix) suffix.hidden = false;
  // Too tight: the row overflows, the word or the detail is clipped, or the project
  // has ellipsized to a stub (under ~6 characters) that no longer names anything.
  const over = () =>
    top.scrollWidth > top.clientWidth ||
    text.scrollWidth > text.clientWidth + 0.5 ||
    (!el.project.hidden && el.project.scrollWidth > el.project.clientWidth + 0.5 && el.project.clientWidth < 56);
  if (!over()) return;
  el.project.hidden = true;
  if (!over()) return;
  el.statusDetail.hidden = true;
  if (!over() || !suffix) return;
  suffix.hidden = true;
}

function clockText() {
  return S.phase === "live" && S.startedAt ? lib.sessionText(Date.now() - S.startedAt) : "";
}

/**
 * Today's usage as one chip: "14 min · $0.71 today", the figures in the strong ink and
 * the units quieter. The reading is throttled (lib.stableUsage) so the cents don't
 * tick with every data-channel update.
 */
let usageShown = null;
let usageText = "";
function renderUsage() {
  if (!S.status) {
    el.usage.hidden = true;
    usageText = "";
    return false;
  }
  usageShown = lib.stableUsage(usageShown, lib.todaySeconds(S.status, S.dcUsage, S.liveSessionId), Date.now());
  const time = lib.formatDuration(usageShown.seconds);
  const cost = lib.formatCost(usageShown.seconds);
  const text = `${time} · ${cost} today`;
  el.usage.hidden = false;
  if (text === usageText) return false;
  usageText = text;
  const strong = (t) => Object.assign(document.createElement("span"), { className: "usage-fig", textContent: t });
  const quiet = (t, cls = "usage-unit") => Object.assign(document.createElement("span"), { className: cls, textContent: t });
  // "14 min" -> figure "14" + unit " min"; "under a minute" stays one quiet phrase.
  const timeNodes = time.split(/(\d+)/).filter(Boolean).map((t) => (/^\d+$/.test(t) ? strong(t) : quiet(t)));
  el.usage.replaceChildren(...timeNodes, quiet(" · ", "usage-sep"), strong(cost), quiet(" today", "usage-suffix"));
  return true;
}

function renderHeader(v = S.view || computeView()) {
  el.body.dataset.phase = S.phase;
  el.body.dataset.state = daemonState();
  el.body.dataset.status = v.header.key;
  el.statusLabel.textContent = v.header.label;
  el.statusDetail.textContent = v.header.detail || "";

  const owner = S.status?.owner;
  el.project.textContent = owner?.project || "";
  el.project.title = owner?.cwd || "";
  el.clock.textContent = clockText();
  renderUsage();
  fitHeader();
  document.title = lib.windowTitle(v, attention());
}

/** "M or Space to mute": Space is left out while a keyboard-focused button would take it. */
function renderKeyHint() {
  const a = document.activeElement;
  el.keyHintSpace.hidden = !!a && a.tagName === "BUTTON" && a.matches(":focus-visible");
}

function renderStage(v = computeView()) {
  S.view = v;
  const b = el.body.dataset;
  b.view = v.view;
  b.dial = v.dial;
  b.floor = v.floor;
  b.card = v.card?.kind || "";
  b.listening = String(!!v.card?.listening);
  const linking = v.floor === "connecting" || v.floor === "reconnecting";
  dial.set({
    floor: v.floor,
    working: !!S.busy && v.view === "live",
    attention: attention() && v.view === "live" && !linking,
    hint: v.dialHint,
    voiceDown: linking,
  });

  el.stageWord.textContent = v.word;
  el.stageWord.dataset.tone = v.wordTone || "";
  el.stageSub.hidden = !v.sub;
  el.stageSub.textContent = v.sub || "";
  el.keyHint.hidden = S.phase !== "live";
  el.keyHintVerb.textContent = v.floor === "muted" ? "to unmute" : "to mute";
  renderKeyHint();
  el.connectSteps.hidden = !v.steps;
  if (v.steps) {
    el.connectSteps.replaceChildren(
      ...v.steps.map((step) => {
        const li = document.createElement("li");
        li.dataset.state = step.state;
        li.textContent = step.label;
        return li;
      }),
    );
  }

  const c = v.card;
  el.overlay.hidden = !c;
  if (!c) return;
  el.overlay.dataset.tone = c.tone;
  el.overlayTitle.textContent = c.title;
  el.overlayBody.textContent = c.body || "";
  el.overlayBody.hidden = !c.body;
  el.overlaySteps.hidden = !c.steps;
  el.overlaySteps.replaceChildren(
    ...(c.steps || []).map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }),
  );
  el.overlayPending.hidden = !c.pending;
  el.overlayPendingText.textContent = c.pending ? lib.truncate(c.pending, 420) : "";
  el.overlayNote.hidden = !c.note;
  el.overlayNote.textContent = c.note || "";
  el.promptPointer.hidden = !c.arrow;
  const keyShown = !el.keyField.hidden;
  el.keyField.hidden = !c.keyInput;
  if (!c.keyInput) {
    el.keyError.hidden = true;
  } else if (!keyShown && !el.settings.open) {
    // The key card just appeared: the input is the only thing to do here.
    requestAnimationFrame(() => el.keyInput.focus());
  }
  el.overlayBtn.hidden = !c.button;
  el.overlayBtn.textContent = c.button || "";
  el.overlayBtn.dataset.action = c.action || "";
  el.overlayBtn.classList.toggle("secondary", !!c.secondary);
  el.overlayKbd.hidden = !c.kbd;
}

function renderMic() {
  const live = S.phase === "live";
  const muted = live && viewMuted();
  el.muteBtn.disabled = !live;
  // Stable name "Mute"; aria-pressed carries the state (AUDIT #12).
  el.muteBtn.setAttribute("aria-pressed", String(muted));
  el.muteBtn.dataset.pending = String(!!S.mutePending);
  el.micHint.hidden = !S.inputHint;
  el.micHint.textContent = S.inputHint || "";
}

const REQUEST_ACTIVE = new Set(["collecting", "sent", "delivered", "held_suspected", "failed"]);

function renderClaude() {
  const d = S.delegations[0] || null;
  const m = lib.claudeView({ busy: !!S.busy, kind: S.claudeKind, text: S.claudeText, summary: S.summary, request: d });
  el.body.dataset.claude = m.kind;
  el.claudeTitle.textContent = m.title;
  el.claudeStep.hidden = m.kind !== "working";
  el.claudeStep.textContent = m.step || "";
  el.claudeCommand.hidden = !(m.kind === "approval" && m.command);
  el.claudeCommand.textContent = m.command || "";
  el.claudeNote.hidden = m.kind !== "approval";
  // While the paused card shows the pending result, don't repeat it.
  const showSummary = m.kind === "finished";
  el.summary.hidden = !showSummary;
  el.summary.textContent = showSummary ? m.summary : "";
  el.claude.dataset.expanded = String(S.summaryExpanded);
  el.moreBtn.hidden = !showSummary || m.summary.length < 150;
  el.moreBtn.textContent = S.summaryExpanded ? "Less" : "More";
  el.moreBtn.setAttribute("aria-expanded", String(S.summaryExpanded));
  const req = m.request;
  const showReq = !!req && (m.kind === "working" || m.kind === "approval" || REQUEST_ACTIVE.has(d?.status));
  el.claudeRequest.hidden = !showReq;
  el.claudeRequest.dataset.tone = req?.tone || "";
  el.claudeRequest.textContent = showReq ? `${req.tone === "error" || req.tone === "warn" ? req.label : "Asked"}: “${req.text}”` : "";
  renderClaudeTime();
}

function renderClaudeTime() {
  el.claudeTime.textContent = S.busy && S.workSince ? lib.formatElapsed(Date.now() - S.workSince) : "";
}

// One 1 s ticker for the session line, the usage chip and the working time; stopped when none shows.
let ticker = 0;
function syncTicker() {
  const need = (S.phase === "live" && S.startedAt) || S.busy;
  if (need && !ticker) {
    ticker = setInterval(() => {
      if (S.phase === "live" && S.startedAt) el.clock.textContent = clockText();
      // A held usage reading (lib.stableUsage) catches up within ~10 s even when no new
      // status or data-channel usage arrives.
      if (renderUsage()) fitHeader();
      renderClaudeTime();
    }, 1000);
  } else if (!need && ticker) {
    clearInterval(ticker);
    ticker = 0;
  }
}

// Captions (design/c-ambient): exactly two lines, the previous one dimmer and the
// latest one large. No fade mask and no scroller: a line that does not fit is dropped
// whole, and a latest line that is too long for the room keeps its newest words.
function fillLine(li, line) {
  li.hidden = !line;
  if (!line) return;
  li.className = `line ${line.role}${li === el.capLatest ? " latest" : ""}`;
  li.firstElementChild.textContent = lib.speakerLabel(line.role);
  li.lastElementChild.textContent = line.text;
}

/** The panel bottom-aligns its list, so overflow goes UP (never into scrollHeight): compare heights. */
function overflowing() {
  const room = el.captionsPanel.clientHeight - (parseFloat(getComputedStyle(el.captionsPanel).paddingBottom) || 0);
  return el.captions.offsetHeight > room + 1;
}

function fitCaptions() {
  const lines = S.captions;
  const latest = lines[lines.length - 1];
  const prev = lines[lines.length - 2];
  fillLine(el.capPrev, prev);
  fillLine(el.capLatest, latest);
  el.captionsEmpty.hidden = lines.length > 0;
  if (!latest || el.captionsPanel.offsetParent === null) return;
  el.capPrev.classList.toggle("new-session", !!prev && prev.session !== latest.session);
  if (!overflowing()) return;
  el.capPrev.hidden = true;
  if (!overflowing()) return;
  // Keep the newest words of the latest line: the largest tail that fits, cut at a word.
  const text = latest.text;
  const out = el.capLatest.lastElementChild;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    out.textContent = `…${text.slice(mid).replace(/^\S*\s+/, "")}`;
    if (overflowing()) lo = mid + 1;
    else hi = mid;
  }
  out.textContent = `…${text.slice(lo).replace(/^\S*\s+/, "")}`;
  el.capLatest.hidden = overflowing();
}

function renderCaptions() {
  fitCaptions();
}

const POLICY_HELP = {
  quiet: "Speaks only when you talk to it.",
  milestones: "Mentions finished work, approvals and errors.",
  walkthrough: "Narrates Claude's progress as it goes.",
};

function renderFooter(v = S.view || computeView()) {
  const policy = S.status?.speaking_policy || "milestones";
  for (const b of el.policy.querySelectorAll("button[data-policy]")) {
    const on = b.dataset.policy === policy;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
  }
  el.policyHelp.textContent = POLICY_HELP[policy] || "";
  const st = daemonState();
  const connected = S.sseUp && st !== "off" && S.phase !== "replaced";
  el.policy.querySelectorAll("button").forEach((b) => (b.disabled = !connected));
  el.voiceSelect.disabled = !S.voices || !S.sseUp;
  const pausable = S.phase === "live" || S.phase === "connecting" || st === "live" || st === "connecting";
  // Card views have their own primary action; Pause would be the wrong one there.
  el.pauseBtn.hidden = v.view !== "live";
  el.pauseBtn.disabled = !connected || !pausable || !!S.micPrompt;
  // Nothing to end when voice is off or the daemon is out of reach.
  el.stopBtn.hidden = !connected;
  el.stopBtn.disabled = !connected || st === "closing";
  if (el.wakeSelect) {
    const sens = S.status?.wake?.sensitivity || "medium";
    if (el.wakeSelect.value !== sens && document.activeElement !== el.wakeSelect) el.wakeSelect.value = sens;
    el.wakeSelect.disabled = !connected;
  }
}

// ---------------------------------------------------------------------------
// Banners (SSE notices, errors). One visible at a time with a count of the rest
// (AUDIT #14). info/warn auto-dismiss after 8 s; errors stay until dismissed.
// ---------------------------------------------------------------------------
const banners = [];

/**
 * @param {{action?:{label:string, run:Function}|null, sticky?:boolean}} [opts]
 *   action: one recovery button (AUDIT #14); sticky: stays until dismissed or resolved.
 */
function showBanner(level, text, code, opts = {}) {
  if (!text) return;
  const key = code || text;
  const i = banners.findIndex((b) => b.key === key);
  if (i >= 0) {
    clearTimeout(banners[i].timer);
    banners.splice(i, 1);
  }
  // A banner that tells the user to try again gets the button for it, when there is
  // no session to retry into already.
  let action = opts.action || null;
  if (!action && /try again/i.test(text) && S.phase !== "live" && S.phase !== "connecting") action = { label: "Try again", run: resume };
  const b = { level, text, key, timer: 0, action };
  if (level !== "error" && !opts.sticky) b.timer = setTimeout(() => dismissBanner(b), BANNER_MS);
  // Errors go first: they are the ones that need reading.
  if (level === "error") banners.unshift(b);
  else banners.push(b);
  while (banners.length > 5) clearTimeout(banners.pop().timer);
  renderBanners();
}

function dismissBannerKey(key) {
  const b = banners.find((x) => x.key === key);
  if (b) dismissBanner(b);
}

// Autoplay blocked (no user gesture yet): the session bills but nothing is heard, so
// the banner stays until audio actually plays, and a key works as well as a click.
function audioBlocked() {
  const unlock = () => {
    el.audio
      .play()
      .then(() => {
        dismissBannerKey("autoplay");
        document.removeEventListener("pointerdown", unlock, true);
        document.removeEventListener("keydown", unlock, true);
      })
      .catch(() => {});
  };
  showBanner("warn", "Click anywhere in this window to turn on the voice audio.", "autoplay", { sticky: true, action: { label: "Turn on audio", run: unlock, keep: true } });
  document.addEventListener("pointerdown", unlock, true);
  document.addEventListener("keydown", unlock, true);
}

function dismissBanner(b) {
  const i = banners.indexOf(b);
  if (i < 0) return;
  clearTimeout(b.timer);
  banners.splice(i, 1);
  renderBanners();
}

function renderBanners() {
  const b = banners[0];
  if (!b) {
    el.banners.replaceChildren();
    return;
  }
  const div = document.createElement("div");
  div.className = "banner";
  div.dataset.level = b.level;
  div.setAttribute("role", b.level === "error" ? "alert" : "status");
  // Static markup only; the banner text itself goes in through textContent.
  div.innerHTML = '<svg aria-hidden="true"><use href="#i-alert"/></svg>';
  const text = document.createElement("span");
  text.className = "banner-text";
  text.textContent = b.text;
  div.append(text);
  if (banners.length > 1) {
    const more = document.createElement("span");
    more.className = "banner-more";
    more.textContent = `+${banners.length - 1}`;
    more.title = `${banners.length - 1} more`;
    div.append(more);
  }
  if (b.action) {
    const act = document.createElement("button");
    act.type = "button";
    act.className = "btn banner-action";
    act.textContent = b.action.label;
    act.onclick = () => {
      if (!b.action.keep) dismissBanner(b);
      b.action.run();
    };
    div.append(act);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "icon-btn";
  close.setAttribute("aria-label", "Dismiss");
  close.innerHTML = '<svg aria-hidden="true"><use href="#i-close"/></svg>';
  close.onclick = () => dismissBanner(b);
  div.append(close);
  el.banners.replaceChildren(div);
}

// ---------------------------------------------------------------------------
// Voice picker (§6.4 GET /api/voices, POST /api/voice). The daemon announces a
// live switch itself (notice voice_change + reconnect); the page only follows.
// ---------------------------------------------------------------------------
async function loadVoices() {
  try {
    const res = await fetchJson("/api/voices", { headers: pageHeaders() });
    if (!res.ok || !Array.isArray(res.body?.voices)) return;
    S.voices = res.body;
    renderVoices();
    renderFooter();
  } catch {
    /* the picker stays disabled */
  }
}

function renderVoices() {
  const v = S.voices;
  if (!v) return;
  const cap = (name) => name.charAt(0).toUpperCase() + name.slice(1);
  fillSelect(el.voiceSelect, v.voices.map((name) => [name, cap(name)]), v.current);
}

async function chooseVoice(name) {
  if (!name || name === S.voices?.current) return;
  el.voiceHelp.textContent = "Switching the voice…";
  try {
    const res = await fetchJson("/api/voice", { method: "POST", headers: pageHeaders(), body: JSON.stringify({ voice: name }) });
    if (!res.ok) throw new Error(res.body?.error?.message || `HTTP ${res.status}`);
    S.voices = { ...S.voices, current: res.body.voice || name };
    el.voiceHelp.textContent = res.body.switching
      ? `Switching to ${name}. The conversation carries over.`
      : `New sessions use ${name}.`;
  } catch (err) {
    el.voiceHelp.textContent = "Changing it restarts the voice session; the conversation carries over.";
    showBanner("error", String(err?.message || err).replace(/^sotto: /, ""), "voice_pick");
  }
  renderVoices();
}

// ---------------------------------------------------------------------------
// User actions
// ---------------------------------------------------------------------------
function resume() {
  if (S.phase === "connecting" || S.phase === "live") return;
  connect(lib.connectReason(daemonState()));
}

el.muteBtn.addEventListener("click", toggleMute);

el.overlayBtn.addEventListener("click", () => {
  if (el.overlayBtn.dataset.action === "reload") location.reload();
  else resume();
});

el.pauseBtn.addEventListener("click", () => {
  S.pausedReason = "user";
  post("pause");
});

el.stopBtn.addEventListener("click", () => post("stop"));

el.policy.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-policy]");
  if (!b || b.disabled) return;
  if (S.status) S.status = { ...S.status, speaking_policy: b.dataset.policy };
  post("set_policy", { policy: b.dataset.policy });
  renderFooter();
});

// Radiogroup arrow-key navigation.
el.policy.addEventListener("keydown", (e) => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
  const buttons = [...el.policy.querySelectorAll("button[data-policy]")];
  const i = buttons.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const next = buttons[(i + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length];
  next.focus();
  next.click();
});

el.inputSelect.addEventListener("change", () => {
  store.set(KEY_INPUT, el.inputSelect.value);
  if (S.pc) switchMic(el.inputSelect.value || null);
  else if (wake.stream) {
    // Sleeping on the old device: reopen listening on the new one.
    wake.release();
    render();
  }
});

el.wakeSelect?.addEventListener("change", () => {
  const v = el.wakeSelect.value;
  if (S.status?.wake) S.status = { ...S.status, wake: { ...S.status.wake, sensitivity: v, enabled: v !== "off" } };
  post("set_wake", { sensitivity: v });
  render();
});

el.outputSelect.addEventListener("change", () => {
  store.set(KEY_OUTPUT, el.outputSelect.value);
  applySink();
});

el.voiceSelect.addEventListener("change", () => chooseVoice(el.voiceSelect.value));

el.moreBtn.addEventListener("click", () => {
  S.summaryExpanded = !S.summaryExpanded;
  renderClaude();
});

// ---------------------------------------------------------------------------
// OpenAI API key (SPEC §4.3). The key goes to the daemon once (POST /api/key,
// page-token auth), which checks it with OpenAI and keeps it in the macOS
// Keychain. The page never gets it back: only its last four characters.
// ---------------------------------------------------------------------------
let keyBusy = false;
let keyEditing = false;
let keyHelpError = "";
let removeArmed = null;

/** Send the key typed into `input`; `report(text)` shows an error ("" clears). Returns true when saved. */
async function submitKey(input, button, report) {
  const key = input.value.trim();
  if (!key) {
    report("Paste your OpenAI API key first.");
    input.focus();
    return false;
  }
  if (keyBusy) return false;
  keyBusy = true;
  const label = button.textContent;
  input.disabled = true;
  button.disabled = true;
  button.textContent = "Checking…";
  report("");
  let res = null;
  try {
    res = await fetchJson("/api/key", { method: "POST", headers: pageHeaders(), body: JSON.stringify({ key }) });
  } catch {
    res = null;
  }
  keyBusy = false;
  input.disabled = false;
  button.disabled = false;
  button.textContent = label;
  if (!res || !res.ok) {
    report(res?.body?.error?.message || "Could not reach the sotto daemon.");
    input.focus();
    input.select();
    return false;
  }
  input.value = "";
  if (S.errorCode === "no_api_key" || S.errorCode === "openai_auth") {
    S.errorCode = null;
    S.errorText = null;
    if (S.phase === "error") S.phase = "idle";
  }
  if (res.body?.key && S.status) S.status = { ...S.status, key: { ...res.body.key, setup: false } };
  const msg = res.body?.message || "Key saved.";
  showBanner("info", msg, "key_saved");
  announce(msg);
  render();
  renderKeySettings();
  return true;
}

function renderKeySettings() {
  const k = lib.keySettingsView(S.status?.key || null);
  el.keySummary.textContent = k.text;
  el.keyChangeBtn.textContent = k.changeLabel;
  el.keyChangeBtn.hidden = !k.change || keyEditing;
  el.keyRemoveBtn.hidden = !k.remove || keyEditing;
  if (!k.remove && removeArmed) disarmRemove();
  el.keyEdit.hidden = !keyEditing;
  el.keyHelp.textContent = keyHelpError || k.help;
  el.keyHelp.dataset.tone = keyHelpError ? "err" : "";
  el.keyHelp.hidden = !el.keyHelp.textContent;
}

function reportKeyHelp(text) {
  keyHelpError = text;
  renderKeySettings();
}

function stopKeyEdit() {
  keyEditing = false;
  keyHelpError = "";
  el.keyEditInput.value = "";
  renderKeySettings();
}

function disarmRemove() {
  clearTimeout(removeArmed);
  removeArmed = null;
  el.keyRemoveBtn.textContent = "Remove";
}

el.keyField.addEventListener("submit", (e) => {
  e.preventDefault();
  submitKey(el.keyInput, el.keySave, (text) => {
    el.keyError.textContent = text;
    el.keyError.hidden = !text;
  });
});

el.keyChangeBtn.addEventListener("click", () => {
  keyEditing = true;
  keyHelpError = "";
  renderKeySettings();
  el.keyEditInput.focus();
});

el.keyEdit.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (await submitKey(el.keyEditInput, el.keyEditSave, reportKeyHelp)) stopKeyEdit();
});

// Esc inside the key input cancels the edit, not the whole drawer.
el.keyEditInput.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || keyBusy) return;
  e.preventDefault();
  e.stopPropagation();
  stopKeyEdit();
  el.keyChangeBtn.focus();
});

el.keyRemoveBtn.addEventListener("click", async () => {
  // Two clicks: the first arms it for 4 s ("Confirm remove").
  if (!removeArmed) {
    el.keyRemoveBtn.textContent = "Confirm remove";
    removeArmed = setTimeout(disarmRemove, 4000);
    return;
  }
  disarmRemove();
  el.keyRemoveBtn.disabled = true;
  let res = null;
  try {
    res = await fetchJson("/api/key/remove", { method: "POST", headers: pageHeaders(), body: "{}" });
  } catch {
    res = null;
  }
  el.keyRemoveBtn.disabled = false;
  if (!res || !res.ok) {
    reportKeyHelp(res?.body?.error?.message || "Could not reach the sotto daemon.");
    return;
  }
  if (res.body?.key && S.status) S.status = { ...S.status, key: { ...S.status.key, ...res.body.key } };
  keyHelpError = "";
  showBanner("info", res.body?.message || "Key removed.", "key_removed");
  renderKeySettings();
});

// Settings drawer: a modal <dialog> gives Esc-to-close and focus return for free.
el.settingsBtn.addEventListener("click", () => {
  if (el.settings.open) return;
  el.settings.showModal();
  if (!S.voices && S.token) loadVoices();
});
el.settingsClose.addEventListener("click", () => el.settings.close());
el.settings.addEventListener("close", () => {
  if (!keyBusy) stopKeyEdit();
  disarmRemove();
});
el.settings.addEventListener("click", (e) => {
  // A click on the backdrop (the dialog box itself, outside its content) closes it.
  if (e.target !== el.settings) return;
  const r = el.settings.getBoundingClientRect();
  if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) el.settings.close();
});

document.addEventListener("keydown", (e) => {
  const t = e.target;
  let tag = t?.tagName;
  // A button focused by a mouse click (Chrome focuses it) must not swallow Space:
  // the hint under the dial promises Space mutes. A keyboard-focused button keeps
  // its native Space activation.
  const mouseFocused = tag === "BUTTON" && !t.matches(":focus-visible");
  if (mouseFocused) tag = "DIV";
  const isM = e.key === "m" || e.key === "M" || e.code === "KeyM";
  // The settings drawer is modal, but M is not used inside it (outside a select's
  // type-ahead). The desktop app's menu-bar mute sends a synthetic M (bridge.js),
  // which must work whatever is open.
  if (el.settings.open && !(isM && (!e.isTrusted || (tag !== "SELECT" && tag !== "INPUT")))) return;
  const action = lib.hotkeyAction(
    { key: e.key, code: e.code, targetTag: tag, repeat: e.repeat, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey },
    {
      live: S.phase === "live",
      paused: !el.overlay.hidden && !el.overlayBtn.hidden && el.overlayBtn.dataset.action === "resume",
      sleeping: daemonState() === "sleeping" && S.phase === "idle",
    },
  );
  if (!action) return;
  e.preventDefault();
  if (mouseFocused) t.blur();
  if (action === "mute" && S.phase !== "live") {
    // Sleeping: M stops or restarts listening for the wake (the mic is released while muted).
    S.wantMuted = !S.wantMuted;
    announce(S.wantMuted ? "Not listening for your voice." : "Listening for your voice again.");
    render();
  } else if (action === "mute") toggleMute();
  else if (action === "resume") resume();
});

// The key hint drops "Space" while a keyboard-focused button would take it.
document.addEventListener("focusin", renderKeyHint);
document.addEventListener("focusout", () => requestAnimationFrame(renderKeyHint));

navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  refreshDevices();
});

// §7.3 exception 1: closing the window ends the paid session immediately.
window.addEventListener("pagehide", () => {
  const dc = S.dc;
  if (dc && dc.readyState === "open") {
    try {
      dc.send(JSON.stringify({ type: "session.close", event_id: "clv_page_unload" }));
    } catch {
      /* ignore */
    }
  }
  if (S.token && S.phase !== "replaced") {
    try {
      navigator.sendBeacon(
        `/api/page?token=${encodeURIComponent(S.token)}`,
        new Blob([JSON.stringify({ type: "unload" })], { type: "application/json" }),
      );
    } catch {
      /* ignore */
    }
  }
});

// ---------------------------------------------------------------------------
// Single active window per browser profile. A newer sotto page takes over; the
// older one pauses its session (billing-safe) and goes inactive.
// ---------------------------------------------------------------------------
function claimWindow() {
  if (typeof BroadcastChannel !== "function") return;
  const id = crypto.randomUUID?.() || String(Math.random());
  const bc = new BroadcastChannel("sotto");
  bc.onmessage = (e) => {
    if (e.data?.type !== "claim" || e.data.id === id || S.phase === "replaced") return;
    if (S.pc) post("pause");
    teardown();
    S.sse?.close();
    S.sse = null;
    clearTimeout(S.sseTimer);
    clearTimeout(S.lostTimer);
    setPhase("replaced");
  };
  bc.postMessage({ type: "claim", id });
}

// ---------------------------------------------------------------------------
// Boot (§7.2)
// ---------------------------------------------------------------------------
claimWindow();
fillDeviceSelects([]);
listDevices().then((d) => {
  if (d.length) fillDeviceSelects(d);
  applySink();
});
render();
renderKeySettings();
renderCaptions();
// The caption panel's height comes from the layout, not its content, so refitting on
// resize cannot loop.
if (typeof ResizeObserver === "function") new ResizeObserver(() => fitCaptions()).observe(el.captionsPanel);
startEvents();
