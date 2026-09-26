// sotto web page: pure helpers.
//
// Everything in this module is free of DOM and network access so it can be
// imported both by app.js (in Chrome) and by node:test (test/web/*.test.js).
// Keep it that way: no `document`, `window`, `navigator` or `fetch` here.

/** Captions: same-role fragments closer than this (session timeline ms) merge into one line. */
export const CAPTION_GAP_MS = 1500;
/** Captions: keep at most this many lines on screen. */
export const MAX_CAPTION_LINES = 60;
/** Price of gpt-live-1 per minute of connected time (USD). */
export const PRICE_PER_MINUTE = 0.05;

const STATUS_LABELS = {
  off: "Off",
  waiting_page: "Opening",
  connecting: "Connecting",
  live: "Live",
  paused: "Paused",
  sleeping: "Sleeping",
  reconnecting: "Reconnecting",
  closing: "Closing",
};

/** Human label for a daemon state (§7.5). Unknown states are title-cased, never blank. */
export function statusLabel(state) {
  if (Object.hasOwn(STATUS_LABELS, state)) return STATUS_LABELS[state];
  if (typeof state !== "string" || state === "") return "Unknown";
  const words = state.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Every daemon state the page knows about (used by tests and styles). */
export const KNOWN_STATES = Object.freeze(Object.keys(STATUS_LABELS));

/** Round half-up at two decimals without the 0.075 -> "0.07" float surprise. */
function money(x) {
  return (Math.round((x + Number.EPSILON) * 100 + 1e-7) / 100).toFixed(2);
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Human-readable duration for a number of seconds. Whole minutes, rounded down, so the
 * reading changes once a minute and never shows a decimal ("14.2 min" read as nothing).
 *   0 -> "0 min", 1..59 s -> "under a minute", 14 min -> "14 min",
 *   65 min -> "1 hr 5 min", 120 min -> "2 hr".
 * `{ long: true }` spells the units out for sentences: "5 minutes", "1 hour 5 minutes".
 * daemon/format.js mirrors this for the /talk status line (test/daemon/format.test.js).
 */
export function formatDuration(seconds, { long = false } = {}) {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  if (s === 0) return long ? "0 minutes" : "0 min";
  if (s < 60) return "under a minute";
  const total = Math.floor(s / 60 + 1e-9);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const mins = long ? plural(m, "minute") : `${m} min`;
  if (h === 0) return mins;
  const hrs = long ? plural(h, "hour") : `${h} hr`;
  return m === 0 ? hrs : `${hrs} ${mins}`;
}

/** "$0.71" for dollars; a non-zero amount under half a cent reads "<$0.01", never "$0.00". */
export function formatMoney(dollars) {
  const d = Number.isFinite(dollars) && dollars > 0 ? dollars : 0;
  if (d > 0 && d < 0.005) return "<$0.01";
  return `$${money(d)}`;
}

/** Cost of a number of billed seconds, formatted. */
export function formatCost(seconds) {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  return formatMoney((s / 60) * PRICE_PER_MINUTE);
}

/** `"<duration> · <$>"` for a number of billed seconds, e.g. 852 -> "14 min · $0.71". */
export function formatUsage(seconds) {
  return `${formatDuration(seconds)} · ${formatCost(seconds)}`;
}

/**
 * Throttle for the header's usage reading, so the cost doesn't tick every data-channel
 * update: a new reading is taken when the whole minute changes, when the day rolls
 * over (seconds go down), or at most every `everyMs`. Returns the reading to show
 * (`prev` itself when nothing should change).
 */
export function stableUsage(prev, seconds, now, everyMs = 10_000) {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  if (!prev) return { seconds: s, at: now };
  if (s === prev.seconds) return prev;
  const minuteChanged = Math.floor(s / 60) !== Math.floor(prev.seconds / 60);
  if (minuteChanged || s < prev.seconds || now - prev.at >= everyMs) return { seconds: s, at: now };
  return prev;
}

/**
 * A live timer as a clock: "0:05", "14:02", "1:05:09" (whole seconds, rounded
 * down). Prose keeps formatDuration()'s words ("14 min"); only the header's
 * ticking timers use this (SPEC-DEVIATIONS "timers").
 */
export function formatClock(seconds) {
  const t = Math.floor(Number.isFinite(seconds) && seconds > 0 ? seconds + 1e-9 : 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/**
 * The header's usage pills (SPEC-DEVIATIONS "header pills"): Session (only while
 * live), Today and Cost, each a label over a figure in a fixed-width box. `wide`
 * says when the box needs its one wider size: a clock from the first hour on
 * (h:mm:ss; styles.css reserves 4.6ch for m:ss/mm:ss and 7ch for h:mm:ss/hh:mm:ss),
 * the cost from $100 (6ch holds "$00.00" and "<$0.01"). Ticking within a magnitude
 * never changes a pill's width, so nothing in the header moves.
 */
export function usagePills({ sessionSeconds = null, todaySeconds = 0, costSeconds = 0 } = {}) {
  const clock = (sec) => {
    const text = formatClock(sec);
    return { text, wide: text.length > 5 };
  };
  const cost = formatCost(costSeconds);
  return {
    session: sessionSeconds == null ? null : clock(sessionSeconds),
    today: clock(todaySeconds),
    cost: { text: cost, wide: cost.length > 6 },
  };
}

/** Settings > Appearance: "system" (the default), "light" or "dark". */
export const THEMES = ["system", "light", "dark"];
export function normalizeTheme(v) {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return THEMES.includes(s) ? s : "system";
}

/**
 * The value of <html data-theme> for a choice: "light" / "dark", or null for System
 * (the attribute is removed and prefers-color-scheme decides, following the OS live).
 * index.html's inline head script applies the same rule before first paint.
 */
export function themeAttr(choice) {
  const t = normalizeTheme(choice);
  return t === "system" ? null : t;
}

/** The theme actually shown: the choice, or the OS's when the choice is System. */
export function resolveTheme(choice, systemDark) {
  return themeAttr(choice) || (systemDark ? "dark" : "light");
}

/**
 * Today's billed seconds for the ticking header clock: the last daemon/data-channel
 * reading (`reading` from stableUsage), advanced by wall time while a session is
 * live, but never more than `maxAheadS` past it (billing is confirmed by the next
 * reading) and never backwards within a day.
 */
export function tickingToday(reading, now, { live = false, shown = null, maxAheadS = 15 } = {}) {
  if (!reading) return 0;
  const ahead = live ? Math.min(maxAheadS, Math.max(0, (now - reading.at) / 1000)) : 0;
  const v = reading.seconds + ahead;
  // A lower reading by more than a minute is a new day; otherwise hold the clock still.
  if (shown != null && v < shown && shown - v < 60) return shown;
  return v;
}

/**
 * The status word's slow summary of who has the floor (SPEC-DEVIATIONS
 * "status word"): a new floor is shown only once it has held for `holdMs`,
 * so the word does not flip between "Listening", "Hearing you" and "Speaking"
 * on every pause. update(floor, now) → the floor to show.
 */
export function createWordHold({ holdMs = 1300 } = {}) {
  let shown;
  let cand;
  let since = 0;
  return {
    update(floor, now) {
      const f = floor ?? null;
      if (shown === undefined) { shown = f; cand = f; return shown; }
      if (f === shown) { cand = f; return shown; }
      if (f !== cand) { cand = f; since = now; }
      if (now - since >= holdMs) shown = cand;
      return shown;
    },
    reset(floor = null) { shown = floor; cand = floor; since = 0; },
    get shown() { return shown ?? null; },
  };
}

/**
 * Today's billed seconds, combining the daemon's figure with fresher usage the page
 * saw on the data channel. The daemon's `today.seconds` already includes
 * `live.usage_seconds` for the current session, so only the part of the data-channel
 * figure beyond that is added.
 */
export function todaySeconds(status, dcUsageSeconds = 0, dcSessionId = null) {
  const base = Number(status?.today?.seconds) || 0;
  const live = status?.live;
  if (!live || !dcSessionId || live.session_id !== dcSessionId) return base;
  const extra = (Number(dcUsageSeconds) || 0) - (Number(live.usage_seconds) || 0);
  return extra > 0 ? base + extra : base;
}

/**
 * Captions reducer (§7.4). Returns a NEW array; never mutates `lines`.
 * A fragment joins the last line when the role matches, it belongs to the same Live
 * session, and `start_ms - last.end_ms <= 1500`. Deltas are appended exactly as
 * received (the API says to preserve spaces). Empty deltas are ignored.
 *
 * @param {Array<{role:string,text:string,start_ms:number,end_ms:number,session?:string|null}>} lines
 * @param {{role:string,text:string,start_ms:number,end_ms:number,session?:string|null}} frag
 */
export function reduceCaptions(lines, frag, max = MAX_CAPTION_LINES) {
  const list = Array.isArray(lines) ? lines : [];
  if (!frag || typeof frag.text !== "string" || frag.text === "") return list;
  const role = frag.role === "assistant" ? "assistant" : "user";
  const start = Number(frag.start_ms) || 0;
  const end = Number.isFinite(Number(frag.end_ms)) ? Number(frag.end_ms) : start;
  const session = frag.session ?? null;
  const last = list[list.length - 1];
  let next;
  if (last && last.role === role && (last.session ?? null) === session && start - last.end_ms <= CAPTION_GAP_MS) {
    const merged = { ...last, text: last.text + frag.text, end_ms: Math.max(last.end_ms, end) };
    next = list.slice(0, -1);
    next.push(merged);
  } else {
    next = list.slice();
    next.push({ role, text: frag.text.replace(/^\s+/, ""), start_ms: start, end_ms: end, session });
  }
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Speaker label for a caption line. */
export function speakerLabel(role) {
  return role === "assistant" ? "Sotto" : "You";
}

const BLUETOOTH_RE = /airpods|bluetooth|headset|hands-free|buds/i;
// Webcams, phones (Continuity) and virtual/loopback devices (labels only; the
// mic choice never skips them, pickInputDevice). Seen live (2026-09-24): Chrome
// opened "OBSBOT Meet 2 Microphone" (a webcam across the room) when opened
// without a deviceId while the Mac's system default was the MacBook Pro mic.
const AVOID_RE = /virtual|zoomaudio|teams audio|blackhole|loopback|soundflower|prism|krisp|aggregate|obsbot|webcam|camera|brio|facetime|iphone|ipad|continuity/i;

/** True if a device label looks like a Bluetooth/headset mic (hands-free profile). */
export function isBluetoothLabel(label) {
  return BLUETOOTH_RE.test(String(label || ""));
}

/** True if a device label looks like a webcam, phone or virtual device. */
export function isAvoidedLabel(label) {
  return AVOID_RE.test(String(label || ""));
}

const PSEUDO_IDS = new Set(["default", "communications"]);

/** The real name behind Chrome's "Default - <name>" pseudo device. */
export function stripDefaultPrefix(label) {
  return String(label || "").replace(/^Default\s*-\s*/, "").trim();
}

/**
 * Choose the microphone (§7.5 "Default mic"): exactly the mic the user chose,
 * else the system default input, whatever it is. No device is second-guessed:
 * a Bluetooth headset's mic is used when it is the choice or the default (the
 * reason to wear one), a webcam when the user picked it.
 * 1. the saved id, if present ("default" = follow the system default);
 * 2. the system default input (Chrome's "default" pseudo device);
 * 3. no "default" pseudo device (not Chrome): the first input listed, which is
 *    the browser's default.
 *
 * The system default is opened BY ID ("default"), never by leaving deviceId
 * out: Chrome then uses its own per-profile device ranking
 * (media.audio_input.user_preference_ranking), which can put a webcam first
 * whatever macOS says (seen live 2026-09-24).
 *
 * `devices` is the enumerateDevices() output (any kinds).
 *
 * @returns {{deviceId:string|null, rule:"saved"|"default"|"fallback"|"none", hint:string|null, label:string, savedMissing:boolean}}
 */
export function pickInputDevice(devices, savedId) {
  const inputs = (Array.isArray(devices) ? devices : []).filter((d) => d && d.kind === "audioinput");
  const real = inputs.filter((d) => !PSEUDO_IDS.has(d.deviceId));
  const def = inputs.find((d) => d.deviceId === "default") || null;
  const out = (deviceId, rule, label, hint = null) => ({ deviceId, rule, hint, label: String(label || ""), savedMissing: !!(savedId && rule !== "saved") });
  if (inputs.length === 0) return out(null, "none", "");
  if (savedId && inputs.some((d) => d.deviceId === savedId)) {
    const d = inputs.find((x) => x.deviceId === savedId);
    return out(savedId, "saved", savedId === "default" ? stripDefaultPrefix(def?.label) : d.label);
  }
  const missingHint = savedId ? "The microphone you chose isn't connected." : null;
  if (def) return out("default", "default", stripDefaultPrefix(def.label), missingHint);
  const first = real[0] || inputs[0];
  return out(first.deviceId, "fallback", first.label, missingHint);
}

/** Drawer option text for an input: "System default (MacBook Pro Microphone)" for the pseudo device. */
export function inputOptionLabel(device, index = 0) {
  if (device?.deviceId === "default") {
    const name = stripDefaultPrefix(device.label);
    return name ? `System default (${name})` : "System default";
  }
  return deviceLabel(device, index);
}

/** Pick the saved speaker if it still exists, else "" (the system default sink). */
export function pickOutputDevice(devices, savedId) {
  const outputs = (Array.isArray(devices) ? devices : []).filter((d) => d && d.kind === "audiooutput");
  if (savedId && outputs.some((d) => d.deviceId === savedId)) return savedId;
  return "";
}

/**
 * The voice picker's groups (GET /api/voices `info`, daemon/config.js VOICE_INFO):
 * Feminine, Masculine, Androgynous, in the daemon's order within each; voices with
 * no info (an older daemon) go last under "Other". Each item:
 * {id, name, tone, description, label} where `label` is the <option> text
 * ("Coral · Bright, lively, upbeat · American"; the group names the presentation).
 */
export const VOICE_GROUPS = Object.freeze([["feminine", "Feminine"], ["masculine", "Masculine"], ["androgynous", "Androgynous"]]);
export function voiceGroups(voices) {
  const list = Array.isArray(voices?.voices) ? voices.voices : [];
  const info = voices?.info && typeof voices.info === "object" ? voices.info : {};
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const item = (id) => {
    const i = info[id];
    const name = cap(id);
    if (!i || typeof i.tone !== "string") return { id, name, tone: "", description: "", label: name };
    const desc = String(i.description || "");
    // The option text drops the presentation: the group heading says it.
    return { id, name, tone: i.tone, description: desc, label: i.accent ? `${name} · ${i.tone} · ${i.accent}` : `${name} · ${i.tone}` };
  };
  const groups = VOICE_GROUPS.map(([key, title]) => ({ key, title, items: list.filter((id) => info[id]?.presentation === key).map(item) }));
  const rest = list.filter((id) => !VOICE_GROUPS.some(([key]) => info[id]?.presentation === key));
  if (rest.length) groups.push({ key: "other", title: groups.some((g) => g.items.length) ? "Other" : "", items: rest.map(item) });
  return groups.filter((g) => g.items.length);
}

/** Display name for a device; labels are empty until mic permission is granted. */
export function deviceLabel(device, index = 0) {
  const label = String(device?.label || "").trim();
  if (label) return label;
  if (device?.deviceId === "default") return "System default";
  return device?.kind === "audiooutput" ? `Speaker ${index + 1}` : `Microphone ${index + 1}`;
}

/**
 * Reason sent with POST /api/session when the daemon asks the page to connect (§7.5).
 * A `connect` command with reason "notify" (the daemon woke a sleeping session to
 * say something, §6.15) is passed through; a manual resume from sleep is "resume".
 */
export function connectReason(state, commandReason) {
  if (commandReason === "notify") return "notify";
  if (state === "paused" || state === "sleeping") return "resume";
  return state === "reconnecting" ? "reconnect" : "start";
}

const DELEGATION_LABELS = {
  collecting: ["Listening", "active"],
  sent: ["Sent to Claude", "active"],
  delivered: ["Claude is on it", "active"],
  held_suspected: ["Not picked up yet", "warn"],
  answered: ["Answered", "done"],
  answered_stale: ["Answered (earlier request)", "done"],
  superseded: ["Replaced by a newer request", "muted"],
  dropped_echo: ["Ignored (echo)", "muted"],
  dropped_empty: ["Didn't catch that", "muted"],
  mirrored: ["Already with Claude", "active"],
  failed: ["Couldn't reach Claude", "error"],
  orphaned: ["Dropped", "muted"],
};

/** `{label, tone}` for a delegation status; tone is one of active|warn|done|muted|error. */
export function delegationLabel(status) {
  const hit = DELEGATION_LABELS[status];
  if (hit) return { label: hit[0], tone: hit[1] };
  return { label: statusLabel(status), tone: "muted" };
}

/**
 * Keep the newest `max` delegations, updating in place by id (newest first).
 * An update without `text` keeps the earlier text.
 */
export function upsertDelegation(list, ev, max = 3) {
  const prev = Array.isArray(list) ? list : [];
  if (!ev || !ev.id) return prev;
  const old = prev.find((d) => d.id === ev.id);
  const merged = { id: ev.id, status: ev.status ?? old?.status ?? "collecting", text: ev.text || old?.text || "" };
  return [merged, ...prev.filter((d) => d.id !== ev.id)].slice(0, max);
}

/** Text for a Live `session.closed` reason, or null when nothing needs saying. */
export function closedReasonMessage(reason) {
  switch (reason) {
    case "close_requested":
      return null;
    case "content":
      return "The voice session was ended by a safety filter.";
    case "expired":
      return "The voice session reached its time limit.";
    case "remote_hangup":
      return "The voice service hung up.";
    case "connection_lost":
      return "The voice connection was lost.";
    default:
      return reason ? `The voice session ended (${reason}).` : "The voice session ended.";
  }
}

/** User-facing text for a getUserMedia failure (DOMException name). */
export function micErrorMessage(name) {
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone access is blocked. Allow the microphone in Chrome settings, then try again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone was found. Connect one, then try again.";
    case "NotReadableError":
    case "AbortError":
      return "The microphone is busy or unavailable. Close other apps using it, then try again.";
    default:
      return "The microphone could not be opened.";
  }
}

/** Headline for the paused overlay. `idleSeconds` (when given) wins over `idleMinutes`. */
export function pausedMessage(reason, idleMinutes, idleSeconds) {
  if (reason === "idle") {
    const s = Number(idleSeconds);
    // Under two minutes and not a whole minute ("90 seconds") stays in seconds; otherwise
    // whole minutes/hours, never a decimal ("2.5 minutes").
    if (Number.isFinite(s) && s > 0 && s < 120 && Math.round(s) % 60 !== 0) return `Paused after ${Math.round(s)} seconds of silence`;
    const min = Number.isFinite(s) && s > 0 ? Math.round(s / 60) : Number(idleMinutes) > 0 ? Math.round(Number(idleMinutes)) : 0;
    return min > 0 ? `Paused after ${formatDuration(min * 60, { long: true })} of silence` : "Paused after a stretch of silence";
  }
  if (reason === "daily_cap") return "Paused: today's voice limit is reached";
  if (reason === "user" || reason === "pause" || !reason) return "Paused";
  if (reason === "error") return "Voice stopped";
  return `Paused (${String(reason).replace(/_/g, " ")})`;
}

/**
 * Error banner text for a data-channel `error` event, or null.
 * Only command-less errors get a banner (§7.4); errors tied to a client command
 * (a `client_event_id`, top level or inside `error`) are logged, not shown.
 */
export function errorBannerText(ev) {
  if (!ev || ev.type !== "error") return null;
  if (ev.client_event_id || ev.error?.client_event_id) return null;
  const msg = ev.error?.message || ev.message || "The voice service reported an error.";
  return String(msg);
}

/** Shorten to `n` chars on a word boundary where possible, with an ellipsis. */
export function truncate(text, n = 160) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.]+$/, "") + "…";
}

/**
 * Map an SSE `activity` message to the activity line.
 * @returns {{text:string, busy:boolean|null, summary:string|null, tone:"work"|"done"|"attention"|"info"}}
 *   busy: new busy hint (null = leave as is); summary: text to keep as "last Claude summary".
 */
export function activityView(ev) {
  const text = truncate(ev?.text || "", 180);
  switch (ev?.kind) {
    case "turn_start":
      return { text: text ? `Claude is working: ${text}` : "Claude is working", busy: true, summary: null, tone: "work" };
    case "tool":
      return { text: text ? `Claude: ${text}` : "Claude is working", busy: true, summary: null, tone: "work" };
    case "text":
      return { text: text ? `Claude: ${text}` : "Claude is writing", busy: true, summary: null, tone: "work" };
    case "permission":
      return {
        text: text ? `Waiting for your approval in the terminal: ${text}` : "Waiting for your approval in the terminal",
        busy: true,
        summary: null,
        tone: "attention",
      };
    case "approval_cleared":
      // The approval was answered (SPEC §6.10.4): back to what Claude is doing.
      return { text: ev?.busy === true ? "Claude is working" : "", busy: typeof ev?.busy === "boolean" ? ev.busy : null, summary: null, tone: ev?.busy === true ? "work" : "info" };
    case "turn_end":
      // `summary` is Claude's final message as markdown (the page renders it with
      // renderMarkdown); an older daemon only sent `text`.
      return { text: "Claude finished", busy: false, summary: typeof ev?.summary === "string" && ev.summary.trim() ? ev.summary.slice(0, 4000) : ev?.text ? truncate(ev.text, 420) : null, tone: "done" };
    case "agents":
      return { text: "", busy: null, summary: null, tone: "info" };
    default:
      return { text: text || "", busy: null, summary: null, tone: "info" };
  }
}

/**
 * Keyboard shortcuts (§7.5). `M` toggles mute while live; `Space` resumes while paused
 * and also toggles mute while live. Ignored in form fields, on buttons for Space (the
 * button's own activation wins), and with modifier keys.
 *
 * @param {{key:string, code?:string, targetTag?:string, repeat?:boolean, meta?:boolean, ctrl?:boolean, alt?:boolean}} ev
 * While sleeping (§7.6) `M` mutes/unmutes local wake listening.
 *
 * @param {{live:boolean, paused:boolean, sleeping?:boolean}} ctx
 * @returns {"mute"|"resume"|null}
 */
export function hotkeyAction(ev, ctx) {
  if (!ev || ev.repeat || ev.meta || ev.ctrl || ev.alt) return null;
  const tag = String(ev.targetTag || "").toUpperCase();
  if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA") return null;
  const isSpace = ev.key === " " || ev.code === "Space";
  const isM = ev.key === "m" || ev.key === "M" || ev.code === "KeyM";
  if (isSpace) {
    if (tag === "BUTTON" || tag === "SUMMARY" || tag === "A") return null;
    if (ctx?.paused) return "resume";
    if (ctx?.live) return "mute";
    return null;
  }
  if (isM && (ctx?.live || ctx?.sleeping)) return "mute";
  return null;
}

/** Root-mean-square of a time-domain Float32 sample buffer (values in -1..1). */
export function rms(samples) {
  if (!samples || samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Map RMS to a 0..1 meter level on a dB scale (-60 dB -> 0, -10 dB -> 1). */
export function levelFromRms(value) {
  if (!(value > 0)) return 0;
  const db = 20 * Math.log10(value);
  return Math.min(1, Math.max(0, (db + 60) / 50));
}

/**
 * "Can't hear you" detector (§7.5 "Can't hear you"; SPEC-DEVIATIONS "can't hear
 * you, only before the first words"). It only ever warns while the user has NOT yet
 * been heard (no input transcript) since connecting or since the last mic change:
 * once the model has heard them on this device, quiet is a choice, never a fault,
 * however long it lasts. The heard state is kept across start() on the same device
 * (a transparent reconnect, a wake from sleep onto the same mic) and cleared only by
 * reset() (a new connect, a mic change, a lost device) or a start() on a different
 * device. Digital silence (exact zeros, a dead track) is a separate detector
 * (createDigitalSilenceDetector) that works at any time. Two symptoms, each checked
 * only while live and unmuted, and reported at most once until start():
 *  - "silent": for `silentMs` after going live (or unmuting, or switching the
 *    mic) the mic's RMS never reached `silentRms` and the user was not heard:
 *    a dead, muted-in-hardware or far-away mic.
 *  - "no_transcript": the mic carried voice-level sound (`speechRms`, not
 *    while the assistant was talking, which is echo) for `speechMs` in total,
 *    yet no input transcript arrived for `gapMs`: the model is not hearing
 *    what the mic hears (seen live 2026-09-24: a webcam mic across the room,
 *    five minutes of talking, no transcript).
 * Clock-free: pass `now` (ms) to every call.
 */
export const HEARING_DEFAULTS = Object.freeze({ silentMs: 20_000, silentRms: 0.003, speechRms: 0.01, speechMs: 6_000, gapMs: 40_000, voiceLevel: 0.08 });

/**
 * Digital silence (SPEC §6.16 "Silent mic"): every mic reading is EXACTLY
 * zero for `thresholdMs` (6 s: longer than the app's own 2 s native -> WebKit
 * fallback plus a Bluetooth profile switch). A working microphone never does that (even a quiet
 * room has a noise floor); a mic that macOS refuses does (the app's capture
 * after its bundle was replaced delivered only zero samples while macOS still
 * said "authorized"). Readings while the audio context is not running do not
 * count (the analyser is frozen then). Fires once per start().
 * @returns {{start(now:number):void, sample(r:{rms:number, now:number, running?:boolean}): null|{ms:number}}}
 */
export function createDigitalSilenceDetector({ thresholdMs = 6000 } = {}) {
  let since = null; // first exactly-zero reading of the current run
  let fired = false;
  let armed = false;
  return {
    start() {
      since = null;
      fired = false;
      armed = true;
    },
    stop() {
      armed = false;
      since = null;
    },
    sample({ rms, now, running = true }) {
      if (!armed || fired) return null;
      if (!running || !Number.isFinite(rms) || rms !== 0) {
        since = null;
        return null;
      }
      if (since === null) since = now;
      if (now - since < thresholdMs) return null;
      fired = true;
      return { ms: Math.round(now - since) };
    },
  };
}

export function createHearingMonitor(opts = {}) {
  const o = { ...HEARING_DEFAULTS, ...opts };
  let armedAt = null; // start of the current "silent" window (null: not live)
  let liveAt = null;
  let peak = 0;
  let heardOn = undefined; // the device the user was heard on (undefined: not heard)
  let device = null;
  let speechMs = 0;
  let lastAt = null;
  let fired = null;
  let wasMuted = false;
  const isHeard = () => heardOn !== undefined && heardOn === device;
  return {
    /**
     * Live (again) on `dev` (a device id or label; null when unknown). Re-arms both
     * checks; a user already heard on this same device stays heard.
     */
    start(now, dev = null) {
      device = dev;
      if (heardOn !== undefined && heardOn !== dev) heardOn = undefined;
      armedAt = liveAt = now;
      peak = 0;
      speechMs = 0;
      lastAt = null;
      fired = null;
      wasMuted = false;
    },
    /** A new connect, a mic change or a lost device: not heard yet. */
    reset() {
      heardOn = undefined;
    },
    stop() {
      armedAt = liveAt = null;
      lastAt = null;
    },
    /** An input transcript arrived: the model hears the user on this device. */
    heard() {
      heardOn = device;
      speechMs = 0;
    },
    /** True once the user was heard on the current device. */
    get hasHeard() {
      return isHeard();
    },
    get fired() {
      return fired;
    },
    /**
     * One meter reading. `rms` raw mic RMS, `voice` the assistant's output level (0..1),
     * `speech` (optional; the native app's voicing test, daemon/agc.js) false when the
     * sound is not voiced speech (typing): then it does not count as the user talking.
     * @returns {null | {kind:"silent"|"no_transcript", peak_rms:number, speech_ms:number, since_ms:number}}
     */
    sample({ rms, muted = false, voice = 0, now, speech = true }) {
      if (liveAt === null || fired || isHeard()) return null;
      const dt = lastAt === null ? 0 : Math.min(250, Math.max(0, now - lastAt));
      lastAt = now;
      if (muted) {
        wasMuted = true;
        return null;
      }
      if (wasMuted) {
        // Unmuted: the silent window starts over; speech counting continues.
        wasMuted = false;
        armedAt = now;
        peak = 0;
      }
      const v = Number(rms) || 0;
      if (v > peak) peak = v;
      if (speech && v >= o.speechRms && !(voice > o.voiceLevel)) speechMs += dt;
      if (armedAt !== null && now - armedAt >= o.silentMs) {
        if (peak < o.silentRms) {
          fired = { kind: "silent", peak_rms: peak, speech_ms: speechMs, since_ms: now - armedAt };
          return fired;
        }
        armedAt = null; // the mic works: only the transcript check from here
      }
      if (speechMs >= o.speechMs && now - liveAt >= o.gapMs) {
        fired = { kind: "no_transcript", peak_rms: peak, speech_ms: speechMs, since_ms: now - liveAt };
        return fired;
      }
      return null;
    },
  };
}

/**
 * Local speech activity detector (§7.5): fires when RMS stays above `threshold` for
 * more than `holdMs`, at most once per `minIntervalMs`. Clock-free: pass `now`.
 */
export function createActivityDetector({ threshold = 0.02, holdMs = 300, minIntervalMs = 10_000 } = {}) {
  let aboveSince = null;
  let lastFired = -Infinity;
  return {
    update(value, now) {
      if (value > threshold) {
        if (aboveSince === null) aboveSince = now;
        if (now - aboveSince > holdMs && now - lastFired >= minIntervalMs) {
          lastFired = now;
          return true;
        }
      } else {
        aboveSince = null;
      }
      return false;
    },
    reset() {
      aboveSince = null;
    },
  };
}

/** Reconnect backoff for the daemon event stream: 0.5 s, 1 s, 2 s, 4 s, then 5 s. */
/**
 * Reload into a new page after a daemon self-update (§6.17)? Only when a build
 * was already known, the daemon now serves a different one, and no session is
 * up (a reload would drop it).
 */
export function shouldReloadForBuild(known, next, hasSession) {
  return typeof known === "string" && !!known && typeof next === "string" && !!next && known !== next && !hasSession;
}

/** The address to reload: same page without `autostart` (a reload must not start a session on its own). */
export function reloadUrl(pathname, search) {
  const q = new URLSearchParams(search || "");
  q.delete("autostart");
  const rest = q.toString();
  return `${pathname || "/"}${rest ? `?${rest}` : ""}`;
}

export function backoffDelay(attempt) {
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(5000, 500 * 2 ** n);
}

/** Parse an SSE `data:` payload; returns null for anything that is not a typed object. */
export function parseEventData(data) {
  try {
    const v = JSON.parse(data);
    return v && typeof v === "object" && typeof v.type === "string" ? v : null;
  } catch {
    return null;
  }
}

// ===========================================================================
// Voice window view models (UI redesign, design/AUDIT.md). Pure functions that
// turn page state into what the window shows, so app.js only copies strings and
// flags into the DOM. Append-only on purpose: other branches edit the helpers
// above, and keeping these separate keeps their rebases clean.
// ===========================================================================

/**
 * Attack/release smoothing for a 0..1 level (exponential, frame-rate independent).
 * Meters rise fast (attack ~40 ms) and fall slowly (release ~220 ms).
 */
export function smoothLevel(prev, target, dtMs, attackMs = 40, releaseMs = 220) {
  const p = Number.isFinite(prev) ? prev : 0;
  const t = Number.isFinite(target) ? Math.min(1, Math.max(0, target)) : 0;
  const dt = Math.max(0, Number(dtMs) || 0);
  const tau = t > p ? attackMs : releaseMs;
  if (tau <= 0) return t;
  return p + (t - p) * (1 - Math.exp(-dt / tau));
}

/**
 * Noise gate for the dial: room noise (below `floor`, about -54 dB on the
 * levelFromRms scale) reads as silence, so a quiet, listening window draws
 * nothing; above it the level is rescaled to keep the full 0..1 range.
 */
export function gateLevel(level, floor = 0.12) {
  const v = Number(level) || 0;
  if (v <= floor) return 0;
  return Math.min(1, (v - floor) / (1 - floor));
}

/** Reduced motion: meters snap to three lengths (rest, mid, full) instead of moving continuously. */
export function quantizeLevel(level) {
  if (!(level > 0.15)) return 0;
  return level < 0.6 ? 0.5 : 1;
}

/**
 * `count` band levels (0..1) from AnalyserNode.getByteFrequencyData output, on
 * log-spaced bins between `minBin` and `maxBin` (speech lives in the low bins).
 */
export function bandLevels(bytes, count, { minBin = 2, maxBin = null } = {}) {
  const out = new Float32Array(Math.max(0, count | 0));
  const n = bytes?.length || 0;
  if (!n || !out.length) return out;
  const lo = Math.max(0, Math.min(minBin, n - 1));
  const hi = Math.max(lo + 1, Math.min(maxBin ?? n, n));
  const ratio = hi / Math.max(1, lo);
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(Math.max(1, lo) * ratio ** (i / out.length));
    const b = Math.max(a + 1, Math.floor(Math.max(1, lo) * ratio ** ((i + 1) / out.length)));
    let peak = 0;
    for (let k = a; k < b && k < n; k++) if (bytes[k] > peak) peak = bytes[k];
    out[i] = peak / 255;
  }
  return out;
}

/**
 * A smooth, mirror-symmetric ring profile of `n` values from `bands`: the bands
 * run 0 -> top, mirrored left/right and repeated `lobes / 2` times, then blurred
 * so neighbouring ticks swell together (the assistant's ring is calm by design).
 */
export function symmetricProfile(bands, n, { lobes = 4, blur = 2 } = {}) {
  const out = new Float32Array(Math.max(0, n | 0));
  const m = bands?.length || 0;
  if (!m || !out.length) return out;
  const seg = out.length / lobes; // ticks per lobe
  for (let i = 0; i < out.length; i++) {
    // Distance from the lobe's middle, sampled at tick centres (0 middle .. 1 edge),
    // in integer-friendly form so mirrored ticks round identically.
    const j = Math.floor(i % seg);
    const edge = (Math.abs(2 * j + 1 - seg) * m) / seg;
    out[i] = bands[Math.min(m - 1, Math.floor(edge + 1e-9))]; // low (loud) bands swell mid-lobe
  }
  if (blur > 0) {
    const src = Float32Array.from(out);
    for (let i = 0; i < out.length; i++) {
      let s = 0;
      for (let k = -blur; k <= blur; k++) s += src[(i + k + out.length) % out.length];
      out[i] = s / (2 * blur + 1);
    }
  }
  return out;
}

/**
 * Who has the floor, from the mic level and the assistant's output level
 * (both 0..1, levelFromRms scale). Hysteresis in level and time so the word under
 * the dial does not flicker between syllables. Clock-free: pass `now`.
 *
 * update(mic, voice, now) -> "you" | "voice" | null
 */
export function createFloorTracker({ onLevel = 0.36, offLevel = 0.2, attackMs = 90, releaseMs = 500 } = {}) {
  const ch = () => ({ active: false, since: null });
  const you = ch();
  const voice = ch();
  function step(c, level, now) {
    if (!c.active) {
      if (level > onLevel) {
        c.since ??= now;
        if (now - c.since >= attackMs) {
          c.active = true;
          c.since = null;
        }
      } else c.since = null;
    } else if (level < offLevel) {
      c.since ??= now;
      if (now - c.since >= releaseMs) {
        c.active = false;
        c.since = null;
      }
    } else c.since = null;
  }
  let last = { mic: 0, voice: 0 };
  return {
    update(micLevel, voiceLevel, now) {
      const m = Number(micLevel) || 0;
      const v = Number(voiceLevel) || 0;
      step(you, m, now);
      step(voice, v, now);
      last = { mic: m, voice: v };
      if (voice.active && you.active) return m > v + 0.08 ? "you" : "voice";
      if (voice.active) return "voice";
      if (you.active) return "you";
      return null;
    },
    reset() {
      you.active = voice.active = false;
      you.since = voice.since = null;
      last = { mic: 0, voice: 0 };
    },
    get last() {
      return last;
    },
  };
}

/**
 * Classify a getUserMedia failure (AUDIT #6). Chrome reports a dismissed prompt,
 * a site block and a macOS privacy block all as NotAllowedError; the message and
 * the Permissions API state tell them apart:
 *   "Permission dismissed"          + state "prompt"  -> dismissed (retry is enough)
 *   "Permission denied"             + state "denied"  -> chrome (site settings)
 *   "Permission denied by system"   (state "granted") -> macos (System Settings)
 * In the Sotto app (`host` "app") every refusal is the macOS one.
 * @returns {"dismissed"|"chrome"|"macos"|"notfound"|"busy"|"unsupported"|"other"}
 */
export function micFailureKind(name, message, permState, host = "browser") {
  const msg = String(message || "");
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      // The Sotto app grants its own origin itself (Panel.swift); the only
      // prompt or block there is macOS privacy for "Sotto".
      if (host === "app") return "macos";
      if (/by system/i.test(msg)) return "macos";
      if (permState === "denied") return "chrome";
      if (/dismiss/i.test(msg) || permState === "prompt") return "dismissed";
      if (permState === "granted") return "macos";
      return "chrome";
    case "NotFoundError":
    case "OverconstrainedError":
      return "notfound";
    case "NotReadableError":
    case "AbortError":
      return "busy";
    case "NotSupportedError":
      return "unsupported";
    default:
      return "other";
  }
}

/** System Settings > Privacy & Security > Microphone (the app opens it; Chrome asks first). */
export const MIC_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

const MIC_FAILURES = {
  dismissed: {
    title: "The microphone prompt closed",
    body: "Chrome asked for the microphone, but the prompt closed before you chose. Ask again, then click Allow.",
    steps: null,
    button: "Ask again",
    header: "Allow mic",
  },
  chrome: {
    title: "Chrome is blocking the microphone",
    body: "This window is not allowed to use the microphone. Voice is paused and not billing.",
    steps: [
      "Open this window's menu (the three dots at the top right) and choose Site settings.",
      "Set Microphone to Allow.",
      "Come back here and click Try again.",
    ],
    button: "Try again",
    header: "Mic blocked",
  },
  macos: {
    title: "macOS is blocking the microphone",
    body: "Chrome allows it, but your Mac doesn't. Voice is paused and not billing.",
    steps: [
      "Open System Settings, then Privacy & Security, then Microphone.",
      "Turn on Google Chrome.",
      "Quit and reopen Chrome, then run /talk on.",
    ],
    button: "Try again",
    link: { href: MIC_SETTINGS_URL, label: "Open System Settings" },
    header: "Mic blocked",
  },
  notfound: {
    title: "No microphone found",
    body: "Connect a microphone or headset, then try again.",
    steps: null,
    button: "Try again",
    header: "No mic",
  },
  busy: {
    title: "The microphone is busy",
    body: "Another app may be using it. Close apps that use the microphone, then try again.",
    steps: null,
    button: "Try again",
    header: "Mic busy",
  },
  unsupported: {
    title: "This browser can't use the microphone",
    body: "Open the voice window in Google Chrome with /talk on.",
    steps: null,
    button: null,
    header: "Mic error",
  },
  other: {
    title: "The microphone could not be opened",
    body: "Check that a microphone is connected, then try again.",
    steps: null,
    button: "Try again",
    header: "Mic error",
  },
};

// The same failures inside the Sotto desktop app (WKWebView, SPEC §6.16):
// no Chrome, no site settings; macOS asks for and blocks "Sotto".
const MIC_FAILURES_APP = {
  macos: {
    title: "Sotto can't use the microphone",
    body: "Allow it in System Settings > Privacy & Security > Microphone. Voice is paused and not billing.",
    steps: [
      "Click Open System Settings (or open System Settings, then Privacy & Security, then Microphone).",
      "Turn on Sotto.",
      "Quit Sotto from its menu-bar icon, then run /talk on.",
    ],
    button: "Try again",
    link: { href: MIC_SETTINGS_URL, label: "Open System Settings" },
    header: "Mic blocked",
  },
  unsupported: {
    title: "This window can't use the microphone",
    body: "Run /talk on again, or set window to chrome in /config (sotto).",
    steps: null,
    button: null,
    header: "Mic error",
  },
};

/** Card copy for a mic failure kind: {title, body, steps|null, button|null, link?, header}. */
export function micFailureView(kind, host = "browser") {
  if (host === "app" && MIC_FAILURES_APP[kind]) return MIC_FAILURES_APP[kind];
  return MIC_FAILURES[kind] || MIC_FAILURES.other;
}

/** The Allow-microphone card: Chrome shows a bubble at the top left; the app gets the macOS dialog. */
export function micPromptView(host = "browser") {
  if (host === "app") {
    return {
      title: "Allow microphone access",
      body: "macOS is asking whether Sotto can use the microphone. Click Allow so Sotto can hear you. Voice starts once the mic is on.",
      note: "Don't see it? It may be behind this panel, or check System Settings, then Privacy & Security, then Microphone.",
      arrow: false,
    };
  }
  return {
    title: "Allow microphone access",
    body: "Chrome is asking at the top left of this window: click Allow so Sotto can hear you. Voice starts once the mic is on.",
    note: "Don't see it? The prompt closes if you click elsewhere; you can ask again.",
    arrow: true,
  };
}

/**
 * What a screen reader hears when the card changes (AUDIT #11): the title and the
 * first sentence of the body. Errors, blocked mics and the daily cap are assertive.
 * @returns {{text:string, assertive:boolean}|null}
 */
export function cardAnnouncement(card) {
  if (!card?.title) return null;
  const first = String(card.body || "").match(/^.*?[.!?](?=\s|$)/)?.[0] || String(card.body || "");
  const text = first ? `${card.title}. ${first}`.replace(/\.\. /, ". ") : `${card.title}.`;
  const assertive = card.tone === "err" || card.kind === "cap" || String(card.kind || "").startsWith("mic-") || card.kind === "lost";
  return { text: text.replace(/…\./g, "…"), assertive };
}

/** The connect checklist under the dial. `stage` is the step in progress. */
export function connectSteps(stage) {
  const order = ["mic", "network", "session"];
  const labels = { mic: "Microphone on", network: "Reaching the voice service", session: "Starting the session" };
  const at = order.indexOf(stage);
  return order.map((key, i) => ({ key, label: labels[key], state: at < 0 ? "pending" : i < at ? "done" : i === at ? "active" : "pending" }));
}

/**
 * The Claude Code card: one of idle | working | approval | finished.
 * @param {{busy:boolean, kind?:string|null, text?:string, agent?:boolean, summary?:string|null, request?:{text:string,status:string}|null}} s
 */
export function claudeView(s) {
  const text = String(s?.text || "").trim();
  const request = s?.request?.text ? { text: truncate(s.request.text, 140), ...delegationLabel(s.request.status) } : null;
  const agents = Number(s?.agents) > 0 ? (Number(s.agents) === 1 ? "1 background agent working" : `${Number(s.agents)} background agents working`) : null;
  if (s?.kind === "permission" && s?.busy !== false) {
    return {
      kind: "approval",
      // A subagent's prompt (SPEC §6.10.4): the user may not know it runs.
      title: s?.agent ? "A background agent needs your approval" : "Claude needs your approval",
      command: text || null,
      note: "Waiting for your approval in the terminal",
      request,
      agents,
    };
  }
  if (s?.busy) {
    // Claude's own latest words, however old (SPEC-DEVIATIONS "Claude card, words
    // only"): a tool label ("Running a command", a Bash description) is never the
    // card's line. Before Claude has said anything this turn the line is "Thinking".
    const says = stripMarkdown(s.says || "");
    const step = says || "Thinking";
    const secondary = false;
    return { kind: "working", title: "Claude is working", step: truncate(step, 180), secondary, request, agents };
  }
  if (s?.summary) return { kind: "finished", title: "Claude finished", summary: String(s.summary), request, agents };
  return { kind: "idle", title: "Claude is idle", request, agents };
}

// ---- Claude's markdown, rendered safely (SPEC-DEVIATIONS "Claude card") -------------
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** HTML-escape every character that could open markup or leave an attribute. */
export function escapeHtml(t) {
  return String(t ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Inline markdown on ALREADY ESCAPED text: code, bold, italic, links (http/https only). */
function inlineMd(t) {
  const codes = [];
  // Inline code first; its content is kept verbatim (already escaped).
  t = t.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  // Links: [text](http…) → an anchor; any other scheme (javascript:, data:, file:) → the text.
  t = t.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, (_, label, url) =>
    /^https?:\/\/[^\s]+$/i.test(url) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>` : label);
  t = t.replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "<strong>$2</strong>");
  t = t.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1<em>$2</em>");
  t = t.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1<em>$2</em>");
  t = t.replace(/~~(?=\S)([^\n]*?\S)~~/g, "$1");
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

/**
 * Claude's markdown as a small, safe HTML subset: paragraphs, bold, italic,
 * inline code, http(s) links, bullet and numbered lists, headings as bold
 * paragraphs, and code blocks (`code: "block"`) or a "(code)" placeholder
 * (`code: "omit"`, for the short view). The input is HTML-escaped FIRST and
 * only whitelisted tags are added afterwards, so no markup in the text can
 * reach the DOM. No external library, no build step.
 */
export function renderMarkdown(md, { code = "omit" } = {}) {
  const lines = escapeHtml(String(md ?? "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "")).split("\n");
  const out = [];
  let para = [];
  let list = null; // {tag, items}
  const flushPara = () => { if (para.length) out.push(`<p>${inlineMd(para.join(" "))}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inlineMd(i)}</li>`).join("")}</${list.tag}>`); list = null; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flushPara(); flushList();
      const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      out.push(code === "block" ? `<pre><code>${body.join("\n")}</code></pre>` : `<p class="md-omitted">(code)</p>`);
      continue;
    }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const bullet = /^\s*[-*+•]\s+(.*)$/.exec(line);
    const num = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line);
    if (bullet || num) {
      flushPara();
      const tag = bullet ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((bullet || num)[1]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    flushList();
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { flushPara(); out.push(`<p><strong>${inlineMd(h[1])}</strong></p>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); continue; } // horizontal rule
    para.push(line.replace(/^\s*&gt;\s?/, "").trim());
  }
  flushPara(); flushList();
  return out.join("");
}

/** Markdown to plain one-line text (for short views): markers, code blocks and link targets dropped. */
export function stripMarkdown(md) {
  let t = String(md ?? "").replace(/\r\n?/g, "\n");
  t = t.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, " ");
  t = t.replace(/`([^`\n]+)`/g, "$1");
  t = t.replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, "$1");
  t = t.replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "$2");
  t = t.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1$2");
  t = t.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2");
  t = t.replace(/~~(?=\S)([^\n]*?\S)~~/g, "$1");
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/^\s*>\s?/gm, "").replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/gm, "");
  return t.replace(/\s+/g, " ").trim();
}

/**
 * The API key card (SPEC §4.3), or null. Shown while the daemon asks for key
 * setup (`status.key.setup`: first run without a key, or /talk key), after a
 * session create failed for want of a key, or when OpenAI rejected a key the
 * page can replace. `s.key` is PageStatus.key: {present, source, file, hint,
 * label, can_change, can_remove, keychain, setup}; it never holds the key.
 */
export function keyCardView(s) {
  const phase = s?.phase || "boot";
  if (phase === "live" || phase === "connecting" || phase === "boot" || phase === "replaced" || phase === "closed" || phase === "lost") return null;
  const st = s?.state || "off";
  const key = s?.key || null;
  const lastCode = s?.lastError?.code || null;
  const missing = s?.errorCode === "no_api_key" || (lastCode === "no_api_key" && st !== "off");
  const rejected = !!key?.can_change && (s?.errorCode === "openai_auth" || (lastCode === "openai_auth" && st !== "off"));
  if (!key?.setup && !missing && !rejected) return null;
  const where = key?.source === "dotenv" && key.file ? key.file : key?.label;
  if (key?.present && !key.can_change && !rejected && !missing) {
    return {
      title: "Your OpenAI API key is set outside Sotto",
      body: `The key in use (ending in ${key.hint || "????"}) comes from ${where}. Change it there, then run /talk on again.`,
      keyInput: false,
    };
  }
  if (key && key.keychain === false) {
    return {
      title: "Add your OpenAI API key to start",
      body: "Export OPENAI_API_KEY before starting Claude Code, or add it to the plugin's .env file, then run /talk on again.",
      keyInput: false,
    };
  }
  const intro = "Sotto talks through OpenAI's gpt-live-1 voice model, billed to your OpenAI account at about $0.05 a minute. Paste a key from platform.openai.com/api-keys.";
  const keep = "Sotto checks it with OpenAI, then keeps it in your macOS Keychain. It is never shown again.";
  if (rejected) {
    return {
      title: "OpenAI rejected your API key",
      body: `The key ending in ${key.hint || "????"} no longer works. Paste a new one. ${keep}`,
      keyInput: true,
    };
  }
  if (key?.present) {
    return {
      title: "Replace your OpenAI API key",
      body: `Sotto uses the key ending in ${key.hint || "????"}, from ${where}. Paste a new one to replace it. ${keep}`,
      keyInput: true,
    };
  }
  return { title: "Add your OpenAI API key to start", body: `${intro} ${keep}`, keyInput: true };
}

/**
 * The settings drawer's API key row: {text, help, change, remove, changeLabel}.
 * `key` is PageStatus.key (or null before the first status).
 */
export function keySettingsView(key) {
  if (!key) return { text: "Checking…", help: "", change: false, remove: false, changeLabel: "Change" };
  const where = key.source === "dotenv" && key.file ? key.file : key.label;
  if (!key.present) {
    return {
      text: "No key yet",
      help: key.keychain ? "Add one to start talking. It is checked with OpenAI and kept in your macOS Keychain." : "Export OPENAI_API_KEY before starting Claude Code, or add it to the plugin's .env file.",
      change: !!key.can_change, remove: false, changeLabel: "Add key",
    };
  }
  const help = key.source === "keychain" ? "Saved in your macOS Keychain."
    : key.can_change ? `From ${where}. A key saved here replaces it.`
    : `From ${where}. Change it there.`;
  return { text: `Key ending in ${key.hint || "????"}`, help, change: !!key.can_change, remove: !!key.can_remove, changeLabel: "Change" };
}

const STAGE_WORDS = {
  starting: ["Starting", "Looking for sotto…"],
  connecting: ["Connecting", "Connecting to the voice service…"],
  reconnecting: ["Reconnecting…", "Your mute setting is kept."],
  // Short, calm words in a fixed slot (SPEC-DEVIATIONS "status word"): the dial is
  // the real-time indicator, the word a slow summary behind createWordHold().
  listening: ["Listening", null],
  you: ["Hearing you", null],
  voice: ["Speaking", null],
  muted: ["Muted", "Sotto can't hear you. Still billing."],
  paused: ["Paused", null],
  sleeping: ["Sleeping", "Speak to wake it"],
  off: ["Voice is off", null],
  error: ["Stopped", null],
};

/** The hero word while Claude Code waits for an approval (AUDIT #5): the urgent fact wins. */
export const APPROVAL_WORD = "Approve in the terminal";

/**
 * Everything the window shows for one page snapshot. Replaces the old overlayModel().
 *
 * `sleep` is wake.js sleepView() output ({title, body, listening}) while the daemon
 * sleeps (§7.6); `host` is "app" inside the Sotto desktop app (§6.16), where
 * the microphone copy names macOS and Sotto instead of Chrome.
 *
 * @param {{
 *   phase:string, state:string, sseDown?:boolean, unauthorized?:boolean,
 *   muted?:boolean, floor?:"you"|"voice"|null, connectStage?:string|null,
 *   micPrompt?:boolean, micFailure?:string|null, errorText?:string|null, errorCode?:string|null,
 *   pausedReason?:string|null, idleMinutes?:number, idleSeconds?:number, capMinutes?:number, pendingResult?:string|null,
 *   lastError?:{code:string,message?:string}|null, attention?:boolean, connectReason?:string|null,
 *   sleep?:{title:string, body:string, listening:boolean}|null, host?:"browser"|"app",
 * }} s
 * @returns {{view:"live"|"card", dial:"full"|"small"|"hidden", floor:string, word:string, sub:string|null,
 *   wordTone:"attn"|null, dialHint:"prompt"|null,
 *   steps:Array|null, card:object|null, header:{key:string,label:string,detail:string|null}}}
 */
export function pageView(s) {
  const st = s?.state || "off";
  const phase = s?.phase || "boot";
  const host = s?.host === "app" ? "app" : "browser";
  const lastCode = s?.lastError?.code || null;
  const out = {
    view: "card", dial: "small", floor: "off", word: "", sub: null, wordTone: null, dialHint: null,
    steps: null, card: null, header: { key: "off", label: statusLabel(st), detail: null },
  };
  // Every state keeps the dial as its hero (a dormant one before a session); only a
  // window that is not ours at all drops it.
  const card = (c, floor, header, dial = "small") => {
    out.card = { pending: null, button: null, action: null, kbd: false, steps: null, arrow: false, keyInput: false, tone: "neutral", secondary: false, ...c };
    out.floor = floor;
    out.header = { detail: null, ...header };
    out.dial = dial;
    [out.word, out.sub] = STAGE_WORDS[floor] || ["", null];
    return out;
  };

  if (s?.unauthorized && phase !== "live" && phase !== "connecting") {
    return card({ kind: "unauthorized", title: "This window is not connected", body: "Open the voice window from Claude Code with /talk on." }, "off", { key: "off", label: "Not connected" }, "hidden");
  }
  if (phase === "replaced") {
    return card(
      { kind: "replaced", title: "Voice moved to another window", body: "Another sotto window took over. This one is inactive.", button: "Use this window", action: "reload" },
      "off",
      { key: "off", label: "Inactive" },
    );
  }
  if (phase === "boot") return card({ kind: "starting", title: "Starting sotto", body: "Looking for the voice daemon…" }, "starting", { key: "connecting", label: "Starting" });
  if (phase === "lost") {
    return card(
      { kind: "lost", title: "Lost contact with the sotto daemon", body: "The voice session was closed to stop billing. Waiting for the daemon to come back…", tone: "warn" },
      "off",
      { key: "error", label: "Disconnected" },
    );
  }
  if (phase === "closed") {
    return card({ kind: "closed", title: "Voice is off", body: "It's safe to close this window; start again from Claude Code with /talk on." }, "off", { key: "off", label: "Off" });
  }
  if (s?.micPrompt && phase === "connecting") {
    const v = micPromptView(host);
    card({ kind: "permission", title: v.title, body: v.body, note: v.note, arrow: v.arrow, tone: "attn" }, "off", { key: "attention", label: "Allow mic" });
    // A static amber tick at 10 o'clock points at Chrome's bubble (the app has no bubble).
    out.dialHint = v.arrow ? "prompt" : "attn";
    return out;
  }
  const kc = keyCardView(s);
  if (kc) return card({ kind: "apikey", tone: "attn", ...kc }, "off", { key: "attention", label: "Key needed" });
  if (phase === "error") {
    if (s?.micFailure) {
      const v = micFailureView(s.micFailure, host);
      return card(
        { kind: `mic-${s.micFailure}`, title: v.title, body: v.body, steps: v.steps, button: st === "off" ? null : v.button, action: "resume", kbd: st !== "off" && !!v.button, tone: "err", ...(v.link ? { link: v.link } : {}) },
        "error",
        { key: "error", label: v.header },
      );
    }
    return card(
      {
        kind: "error",
        title: "Voice could not start",
        body: s?.errorText || "Something went wrong.",
        button: st === "off" ? null : "Try again",
        action: "resume",
        kbd: st !== "off",
        tone: "err",
      },
      "error",
      { key: "error", label: "Error" },
    );
  }
  if (phase === "live" || phase === "connecting") {
    out.view = "live";
    out.dial = "full";
    const reconnecting = st === "reconnecting" || (phase === "connecting" && s?.connectReason === "reconnect");
    if (phase === "connecting") {
      out.floor = reconnecting ? "reconnecting" : "connecting";
      out.steps = reconnecting ? null : connectSteps(s?.connectStage || "mic");
      out.header = { key: "connecting", label: reconnecting ? "Reconnecting" : "Connecting", detail: null };
    } else if (s?.muted) {
      out.floor = "muted";
      out.header = { key: "muted", label: "Muted", detail: "Still billing" };
    } else {
      out.floor = s?.floor === "you" || s?.floor === "voice" ? s.floor : "listening";
      out.header = { key: "live", label: "Live", detail: null };
    }
    [out.word, out.sub] = STAGE_WORDS[out.floor];
    if (s?.attention) {
      out.header = { key: "attention", label: "Approval needed", detail: out.header.key === "muted" ? "Muted" : null };
      // The largest type names the most urgent fact; the floor moves to the small line.
      if (phase === "live") {
        out.sub = out.floor === "muted" ? "Muted · Sotto can't hear you" : out.word;
        out.word = APPROVAL_WORD;
        out.wordTone = "attn";
      }
    }
    return out;
  }
  if (s?.sseDown) {
    return card({ kind: "disconnected", title: "Disconnected", body: "Waiting for the sotto daemon…", tone: "warn" }, "off", { key: "error", label: "Disconnected" });
  }
  if (st === "off") return card({ kind: "off", title: "Voice is off", body: "Turn it on from Claude Code with /talk on." }, "off", { key: "off", label: "Off" });
  if (st === "closing") return card({ kind: "closing", title: "Closing…", body: "Finishing the voice session." }, "off", { key: "off", label: "Closing" });
  if (st === "sleeping") {
    // Local voice wake (§7.6): the copy comes from wake.js sleepView(), so feat/voice-wake owns it.
    const v = s?.sleep || { title: "Sleeping", body: "Voice wakes up when you speak. Nothing is sent or billed until then.", listening: false };
    return card(
      { kind: "sleeping", title: v.title, body: v.body, pending: s?.pendingResult || null, button: "Wake now", action: "resume", kbd: true, secondary: true, listening: !!v.listening },
      "sleeping",
      { key: "sleeping", label: statusLabel(st) },
    );
  }
  if (st === "paused") {
    const reason = s?.pausedReason || (lastCode === "daily_cap" ? "daily_cap" : null);
    const cap = reason === "daily_cap";
    let body = "Resume to keep talking with Claude Code.";
    if (cap) {
      const capMin = Number(s?.capMinutes);
      const used = capMin > 0 ? `You've used today's ${formatDuration(capMin * 60, { long: true })} of voice. ` : "";
      body = `${used}Set Daily limit to Unlimited in Settings (or run sotto cap off) to continue today.`;
    }
    else if (lastCode === "mic_denied" || lastCode === "mic_error") body = s?.lastError?.message || body;
    return card(
      {
        kind: cap ? "cap" : "paused",
        title: pausedMessage(reason, s?.idleMinutes, s?.idleSeconds),
        body: cap ? body : `${body} Nothing is billed while paused.`,
        pending: s?.pendingResult || null,
        button: cap ? null : "Resume",
        action: "resume",
        kbd: !cap,
        tone: cap ? "attn" : "neutral",
      },
      "paused",
      { key: cap ? "attention" : "paused", label: cap ? "Limit reached" : statusLabel(st) },
    );
  }
  // waiting_page / connecting / reconnecting / live on the daemon while this page
  // is idle: a connect command is on its way. Show the live layout, waiting.
  out.view = "live";
  out.dial = "full";
  out.floor = st === "reconnecting" ? "reconnecting" : "connecting";
  out.steps = st === "reconnecting" ? null : connectSteps(null);
  out.header = { key: "connecting", label: statusLabel(st), detail: null };
  [out.word, out.sub] = STAGE_WORDS[out.floor];
  if (st !== "reconnecting") out.sub = "Waiting for Claude Code…";
  return out;
}

/** Window title: the approval request escapes the window (AUDIT #5). */
export function windowTitle(view, attention) {
  if (attention) return "Approval needed · Sotto";
  if (view?.floor === "muted") return "Muted · Sotto";
  return "Sotto";
}

/** Claude's working time on the card: "42 sec", "3 min 12 sec", "1 hr 2 min". */
export function formatElapsed(ms) {
  const t = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (t < 60) return `${t} sec`;
  if (t < 3600) return `${Math.floor(t / 60)} min ${t % 60} sec`;
  return formatDuration(t);
}

// ---- The Filament + Orrery panel (design/concepts-v2/hybrid; SPEC-DEVIATIONS "hybrid panel") ----
// Pure rules shared with the native app's ViewText (docs/NATIVE.md §5.4, pinned by
// test/fixtures/native/viewtext.json), so the page and the app say the same words.

/** How long "Claude finished" stays the headline after a turn ends (hybrid §6). */
export const FINISHED_HEADLINE_MS = 30_000;
/** A new approval becomes the headline at totality, when the moon covers the peg (hybrid §4.1). */
export const ECLIPSE_TOTALITY_MS = 750;

// The daemon's plain-words tool lines (daemon/policy.js toolActivity) as one quiet
// verb. Never a tool line: "Running the tests" is "testing", a Bash description is "working".
const VERBS = [
  [/^Running the tests\b/i, "testing"],
  [/^Editing\b/i, "editing"],
  [/^(?:Looking through|Reading)\b/i, "reading"],
  [/^Searching\b/i, "searching"],
  [/^Building\b/i, "building"],
  [/^Installing\b/i, "installing"],
  [/^Checking the code\b/i, "checking"],
  [/^Committing\b/i, "committing"],
  [/^Pushing\b/i, "pushing"],
  [/^Fetching\b/i, "fetching"],
  [/^Validating\b/i, "validating"],
  [/^Updating\b/i, "updating"],
  [/^Downloading\b/i, "downloading"],
];

/** "Claude is <verb>": the verb for the current tool line, "working" when there is none. */
export function claudeVerb(tool) {
  const t = String(tool ?? "").trim();
  for (const [re, v] of VERBS) if (re.test(t)) return v;
  return "working";
}

/**
 * The headline (the floor word) in the live view (hybrid §6): the floor wins while
 * someone is talking; otherwise an approval; then Muted (it must never hide behind
 * Claude's news: the user would talk to a mic that is off); then Claude's news
 * ("Claude is testing", "Claude finished" for 30 s); else the word pageView chose.
 * A card view shows its short header label; connecting keeps pageView's word.
 *
 * @param {{view:string, floor:string, word:string, wordTone?:string|null}} v  lib.pageView() output
 * @param {{attention?:boolean, question?:boolean, busy?:boolean, tool?:string, finishedAt?:number|null, now?:number}} c
 * @returns {{word:string, tone:"attn"|"muted"|"you"|"err"|null, news:boolean}}
 */
export function headline(v, c = {}) {
  const floor = v?.floor;
  // A card view (paused, sleeping, an error, the key) names the state in one short
  // word; the card below it carries the sentence.
  if (v?.view !== "live") return { word: v?.header?.label || v?.word || "", tone: v?.card?.tone === "err" ? "err" : null, news: false };
  if (!["listening", "you", "voice", "muted"].includes(floor)) return { word: v.word || "", tone: v.wordTone || null, news: false };
  if (floor === "you") return { word: STAGE_WORDS.you[0], tone: "you", news: false };
  if (floor === "voice") return { word: STAGE_WORDS.voice[0], tone: null, news: false };
  if (c.attention) return { word: APPROVAL_WORD, tone: "attn", news: true };
  if (c.question && c.busy) return { word: "Answer in the terminal", tone: "attn", news: true };
  if (floor === "muted") return { word: STAGE_WORDS.muted[0], tone: "muted", news: false };
  if (c.busy) return { word: `Claude is ${claudeVerb(c.tool)}`, tone: null, news: true };
  const now = Number(c.now) || 0;
  if (c.finishedAt != null && now >= c.finishedAt && now - c.finishedAt < FINISHED_HEADLINE_MS) return { word: "Claude finished", tone: null, news: true };
  return { word: STAGE_WORDS.listening[0], tone: null, news: false };
}

/** The header's status word: pageView's, but an approval reads "Needs you" (hybrid §1). */
export function statusWord(v) {
  return v?.header?.key === "attention" && v?.view === "live" ? "Needs you" : v?.header?.label || "";
}

/**
 * The one line under the string (hybrid "caption"): a note when the state has one
 * (muted, reconnecting, waiting), else null and the latest caption shows there.
 */
export function captionNote(v) {
  if (v?.view !== "live") return null;
  if (v.floor === "muted") return "Sotto can't hear you. Still billing. Press M to listen.";
  if (v.floor === "connecting" || v.floor === "reconnecting") return v.sub || null;
  return null;
}

/**
 * Sleeping and paused are quiet states, not errors: like the app (PanelView CaptionLine),
 * the page keeps Claude's page, says the state on the caption line under the string, and
 * turns the footer's pause into play (Wake now / Resume). No card and no big pill. The
 * daily cap, errors, the mic prompt and the key keep their card.
 * @param {{card?:{kind:string}|null}} v  lib.pageView() output
 */
export function inlineCard(v) {
  const k = v?.card?.kind;
  return k === "sleeping" || k === "paused";
}

/** The caption line's words for an inline card: the app's CaptionLine.line, word for word. */
export function inlineNote(v) {
  const c = inlineCard(v) ? v.card : null;
  if (!c) return null;
  if (c.kind === "sleeping") return c.listening ? "Just start talking. Nothing is sent or billed until then." : c.body || null;
  return `${c.title}. Press Space to resume.`;
}

/**
 * The Claude row's head (hybrid §3 MoonGlyph): a moon phase instead of a state dot,
 * "Claude · Working" instead of a title. `m` is lib.claudeView() output.
 * @returns {{phase:"new"|"waxing"|"eclipse"|"full", label:string, detail:string|null, need:boolean}}
 */
export function claudeHead(m) {
  switch (m?.kind) {
    case "approval":
      return { phase: "eclipse", label: String(m.title || "").startsWith("A background agent") ? "A background agent is waiting for you" : "Claude is waiting for you", detail: null, need: true };
    case "working":
      return { phase: "waxing", label: "Claude", detail: "Working", need: false };
    case "finished":
      return { phase: "full", label: "Claude", detail: "Done", need: false };
    default:
      return { phase: "new", label: "Claude", detail: "Idle", need: false };
  }
}

// ---- Milestone stars (hybrid §6): each finished Claude step leaves a star on the string ----
export const STAR_GAP_MS = 20_000;
export const STAR_MAX = 12;
export const STAR_HALF_LIFE_MS = 20 * 60_000;
export const BEAD_TAU_MS = 60_000;

/** Where Claude's bead is on the string (0 = your peg, 1 = the bridge) after `elapsedMs` of work. */
export function beadPosition(elapsedMs) {
  const t = Math.max(0, Number(elapsedMs) || 0);
  return Math.round((0.05 + 0.85 * (1 - Math.exp(-t / BEAD_TAU_MS))) * 10_000) / 10_000;
}

/** A star's brightness: halves every 20 minutes, never below 0.3. */
export function starAlpha(ageMs) {
  const a = Math.max(0, Number(ageMs) || 0);
  return Math.round(Math.max(0.3, 0.92 * 2 ** (-a / STAR_HALF_LIFE_MS)) * 1000) / 1000;
}

/**
 * Fold one `activity` message into the stars (native: StateModel derives the same).
 * A star is born where the bead is when Claude reports a step in its own words
 * (kind "text" while busy), at most one per 20 s, at most 12 (oldest out first).
 * `state` = {stars:[{s, born}], lastAt}; returns a new state (or the same one).
 * @param {{kind:string, text?:string}} ev
 * @param {{busy:boolean, now:number, workSince:number|null}} ctx
 */
export function milestoneStars(state, ev, ctx) {
  const st = state && Array.isArray(state.stars) ? state : { stars: [], lastAt: null };
  if (ev?.kind !== "text" || !String(ev.text || "").trim() || !ctx?.busy) return st;
  const now = Number(ctx.now) || 0;
  if (st.lastAt != null && now - st.lastAt < STAR_GAP_MS) return st;
  const s = beadPosition(ctx.workSince == null ? 0 : now - ctx.workSince);
  const stars = [...st.stars, { s, born: now }].slice(-STAR_MAX);
  return { stars, lastAt: now };
}

// ---- Claude's page (SPEC-DEVIATIONS "scrolling page"): a fixed region that scrolls ----
// Native: StateModel.pushPage / ViewText.pageEntries / Follow (the same rules, pinned by
// test/fixtures/native/viewtext.json).

/** How many of Claude's messages the page keeps: this turn's and the recent ones before it. */
export const PAGE_MAX = 12;
/** The newest message at full ink, the rest of this turn at half, earlier turns quieter. */
export const PAGE_OPACITY = { latest: 1, turn: 0.5, past: 0.36 };
/** Within this many px of the latest text still counts as "at the latest" (follow on). */
export const FOLLOW_SLACK = 24;

/** A new turn: the messages so far become the earlier turns. `page` = {msgs:string[], turnStart:number}. */
export function pageTurn(page) {
  const msgs = Array.isArray(page?.msgs) ? page.msgs : [];
  return { msgs, turnStart: msgs.length };
}

/**
 * Add one of Claude's messages. A message that repeats or extends the last one of this
 * turn replaces it (the hook sends the growing text again); at most PAGE_MAX are kept,
 * the oldest out first.
 */
export function pushPage(page, text) {
  const msgs = Array.isArray(page?.msgs) ? page.msgs : [];
  let turnStart = Math.min(msgs.length, Math.max(0, Number(page?.turnStart) || 0));
  const t = String(text ?? "").trim();
  if (!t) return { msgs, turnStart };
  const last = msgs.length > turnStart ? msgs[msgs.length - 1] : null;
  if (last != null) {
    const a = stripMarkdown(last), b = stripMarkdown(t);
    if (a === b || b.startsWith(a)) return { msgs: [...msgs.slice(0, -1), t], turnStart };
  }
  let next = [...msgs, t];
  const drop = Math.max(0, next.length - PAGE_MAX);
  if (drop) { next = next.slice(drop); turnStart = Math.max(0, turnStart - drop); }
  return { msgs: next, turnStart };
}

/** The page's messages with their tone: "latest" (the newest of this turn), "turn" (earlier this turn), "past" (earlier turns). */
export function pageEntries(page) {
  const msgs = Array.isArray(page?.msgs) ? page.msgs : [];
  const start = Math.max(0, Number(page?.turnStart) || 0);
  return msgs.map((text, i) => ({ text, tone: i < start ? "past" : i === msgs.length - 1 ? "latest" : "turn" }));
}

/**
 * Where "the latest" is in the scrolling page: the end of the text, or, for a finished
 * reply taller than the page (`latestTop` given), the top of that reply, so it reads from
 * its first line like a chat.
 */
export function followTarget({ scrollHeight = 0, clientHeight = 0, latestTop = null } = {}) {
  const max = Math.max(0, scrollHeight - clientHeight);
  if (latestTop == null) return max;
  return Math.max(0, Math.min(max, latestTop));
}

/** Following: the reader is at (or past) the latest text. Scrolling up away from it stops following. */
export function isFollowing(scrollTop, target, slack = FOLLOW_SLACK) {
  return scrollTop >= target - slack;
}

/**
 * The auto-hiding scroller's thumb in the page's own box: inset `inset` px from the top
 * and bottom edges, at least `min` px tall. Null when nothing overflows.
 */
export function scrollThumb({ scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {}, { inset = 6, min = 24 } = {}) {
  const over = scrollHeight - clientHeight;
  if (over <= 1 || clientHeight <= 0) return null;
  const track = Math.max(0, clientHeight - 2 * inset);
  const height = Math.min(track, Math.max(min, (track * clientHeight) / scrollHeight));
  const f = Math.max(0, Math.min(1, scrollTop / over));
  return { top: Math.round((inset + (track - height) * f) * 10) / 10, height: Math.round(height * 10) / 10 };
}

// ---- Devices in the footer (SPEC-DEVIATIONS "Devices in the footer") ----
// Native: SottoUI DeviceMenu (the same order, check and fallback).

const HEADPHONES_RE = /airpods|headphone|headset|earbud|earphone|buds|beats/i;

/** True if an output label looks like headphones (the speaker button shows headphones). */
export function isHeadphonesLabel(label) {
  return HEADPHONES_RE.test(String(label || ""));
}

/**
 * The footer picker's rows: "System default (<name>)" first, then every real device of
 * `kind` ("audioinput" | "audiooutput"); the check on the saved choice when it is there,
 * else on System default. `id` "" = the system default.
 */
export function deviceMenu(devices, kind, savedId) {
  const list = (Array.isArray(devices) ? devices : []).filter((d) => d && d.kind === kind);
  const def = list.find((d) => d.deviceId === "default");
  const real = list.filter((d) => d.deviceId && !PSEUDO_IDS.has(d.deviceId));
  const saved = savedId && real.some((d) => d.deviceId === savedId) ? savedId : "";
  const defName = def ? stripDefaultPrefix(def.label) : "";
  return [
    { id: "", label: defName ? `System default (${defName})` : "System default", checked: !saved },
    ...real.map((d, i) => ({ id: d.deviceId, label: kind === "audioinput" ? inputOptionLabel(d, i) : deviceLabel(d, i), checked: d.deviceId === saved })),
  ];
}

/** The chosen device is gone: fall back to the system default (never another device). An empty list loses nothing. */
export function deviceLost(devices, kind, savedId) {
  const list = (Array.isArray(devices) ? devices : []).filter((d) => d && d.kind === kind);
  if (!savedId || !list.length) return false;
  return !list.some((d) => d.deviceId === savedId);
}

/** The footer button's words: "Microphone: MacBook Pro Microphone". */
export function deviceButtonLabel(kind, name) {
  const what = kind === "audioinput" ? "Microphone" : "Speaker";
  const n = stripDefaultPrefix(String(name || "")).trim();
  return n ? `${what}: ${n}` : `${what}: none`;
}
