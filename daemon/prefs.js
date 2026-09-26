// User preferences that outlive the daemon (SPEC §3 `D/prefs.json`, §4.5).
// It holds the output voice, the voice window, the persona (SPEC §4.6) and
// whether choosing a persona also switches to its voice ("persona_voice",
// default true) and the daily voice limit ("daily_cap_minutes", 0 =
// unlimited; `sotto cap`, the window's Daily limit; beats userConfig). Precedence for voice and window:
//   D/prefs.json  >  userConfig (CLAUDE_PLUGIN_OPTION_* via /control)  >  default
// ("marin"; window "auto"). SOTTO_BROWSER still beats all of it for the window.
// toggle.sh reads and (when no daemon runs) writes the same file with bash
// regex, so it stays compact single-line JSON:
// {"voice":"cedar","window":"app","persona":"moss","persona_voice":false}.
import fs from "node:fs";
import { VOICES, DEFAULT_CONFIG, WINDOW_MODES } from "./config.js";
import { writeAtomic } from "./statefiles.js";
import { normalizePersonaId } from "./personas.js";

/** Lowercased, trimmed voice name if it is one of the 22 voices, else null. */
export function normalizeVoice(v) {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return VOICES.includes(s) ? s : null;
}

/** Lowercased, trimmed window mode if valid (auto, app, chrome, default), else null. */
export function normalizeWindow(v) {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return WINDOW_MODES.includes(s) ? s : null;
}

/** Read D/prefs.json. Missing, unreadable or malformed → {} (never throws). */
export function readPrefs(paths, readFile = fs.readFileSync) {
  try {
    const o = JSON.parse(readFile(paths.prefs, "utf8"));
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    const out = {};
    const v = normalizeVoice(o.voice);
    if (v) out.voice = v;
    const w = normalizeWindow(o.window);
    if (w) out.window = w;
    const p = normalizePersonaId(o.persona);
    if (p) out.persona = p;
    if (typeof o.persona_voice === "boolean") out.persona_voice = o.persona_voice;
    const cap = normalizeCap(o.daily_cap_minutes);
    if (cap !== null) out.daily_cap_minutes = cap;
    return out;
  } catch {
    return {};
  }
}

/**
 * A daily limit in minutes: 0 (unlimited) to 1440, or null when invalid.
 * Accepts numbers and the words "off", "unlimited", "none", "0", "2h", "90m".
 */
export function normalizeCap(v) {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 && v <= 1440 ? v : null;
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (["off", "unlimited", "none", "no", "never"].includes(s)) return 0;
  const m = /^(\d{1,4})\s*(h|hr|hrs|hour|hours|m|min|mins|minutes?)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] && m[2].startsWith("h") ? 60 : 1);
  return n <= 1440 ? n : null;
}

/** The daily limit in effect: prefs.json > userConfig > default (120). 0 = unlimited. */
export function resolveCap({ prefs = {}, configCap } = {}) {
  if (Number.isInteger(prefs.daily_cap_minutes)) return prefs.daily_cap_minutes;
  return Number.isFinite(configCap) ? configCap : DEFAULT_CONFIG.daily_cap_minutes;
}

/** "unlimited" or "2 h" / "90 min" for messages. */
export function capLabel(min) {
  if (!min) return "unlimited";
  return min % 60 === 0 ? `${min / 60} h` : `${min} min`;
}

/** Merge `patch` into D/prefs.json (atomic, 0600). Returns the new prefs. */
export function writePrefs(paths, patch) {
  const next = { ...readPrefs(paths), ...patch };
  writeAtomic(paths.prefs, `${JSON.stringify(next)}\n`);
  return next;
}

/** The effective voice: prefs file > userConfig > default. */
export function resolveVoice({ prefs = {}, configVoice } = {}) {
  return normalizeVoice(prefs.voice) || normalizeVoice(configVoice) || DEFAULT_CONFIG.voice;
}

/** Whether picking a persona also switches to its voice (default yes). */
export function personaVoiceOn(prefs = {}) {
  return prefs.persona_voice !== false;
}

/** The effective window preference: prefs file > userConfig > auto (env is applied by window.js). */
export function resolveWindowPref({ prefs = {}, configWindow } = {}) {
  return normalizeWindow(prefs.window) || normalizeWindow(configWindow) || "auto";
}

/** One-line list for /talk voice and the CLI; the current voice is marked. */
export function voiceListMessage(current) {
  const list = VOICES.map((v) => (v === current ? `${v} (current)` : v)).join(", ");
  return `sotto: voice is ${current}. Voices: ${list}. Change it with /talk voice <name>.`;
}

export function unknownVoiceMessage(name) {
  const shown = String(name ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  return `sotto: unknown voice "${shown}". Voices: ${VOICES.join(", ")}.`;
}
