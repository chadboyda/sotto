// Configuration: defaults, validation of /control config, .env loading and
// OpenAI endpoint resolution (SPEC §4).
import fs from "node:fs";
import path from "node:path";

export const VERSION = "0.2.0";
export const NAME = "sotto";
export const LIVE_MODEL = "gpt-live-1";
export const DEFAULT_PORT = 47821;
export const MAX_APPEND_CHARS = 1400;
// The Live API limits every instructions/thinking/commentary append to 500
// tokens. We have no tokenizer, so appends are budgeted with a conservative
// estimate (speech.js estTokens) against this lower ceiling.
export const MAX_APPEND_TOKENS = 450;
// Base marker; on the wire it carries a per-bind nonce: "[sotto voice <nonce>]".
export const VOICE_MARKER = "[sotto voice]";
export const voiceMarker = (nonce) => (nonce ? `[sotto voice ${nonce}]` : VOICE_MARKER);
export const BG = "[Background reference; not user speech] ";

export const VOICES = Object.freeze([
  "alloy", "ash", "ballad", "beacon", "bossa", "cedar", "cinder", "coral", "delta", "echo", "gleam",
  "marin", "meridian", "quartz", "ripple", "sage", "shimmer", "stone", "tempo", "verse", "vesper", "willow",
]);
export const POLICIES = Object.freeze(["quiet", "milestones", "walkthrough"]);

export const WAKE_SENSITIVITIES = Object.freeze(["off", "low", "medium", "high"]);

/** Transcript mirror (userConfig `mirror`, SPEC §6.18): which undelegated speech reaches Claude. */
export const MIRROR_MODES = Object.freeze(["all", "decisions", "off"]);

/** Voice-window choices (userConfig `window`, env SOTTO_BROWSER adds "none"); SPEC §6.16. */
export const WINDOW_MODES = Object.freeze(["auto", "app", "chrome", "default"]);

export const DEFAULT_CONFIG = Object.freeze({
  voice: "marin",
  // idle_minutes is the legacy setting, kept for back-compat and display; the
  // daemon sleeps after idle_seconds (SPEC §4.1, §6.15). It is derived from
  // idle_seconds unless a caller sets only idle_minutes.
  idle_minutes: 1,
  idle_seconds: 60,
  speaking_policy: "milestones",
  daily_cap_minutes: 120,
  wake_sensitivity: "medium",
  window: "auto",
  mirror: "all",
  open_browser: true,
});

function num(v, min, max) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

/**
 * Merge a (possibly partial or invalid) config object from /control onto a base.
 * Invalid fields fall back to the base value, then to the default.
 */
export function normalizeConfig(input, base = DEFAULT_CONFIG) {
  const c = input && typeof input === "object" ? input : {};
  const b = { ...DEFAULT_CONFIG, ...(base || {}) };
  // idle_seconds wins; an explicit legacy idle_minutes (without idle_seconds) converts.
  const secs = num(c.idle_seconds, 0, 7200);
  const mins = num(c.idle_minutes, 0, 120);
  const idleSeconds = secs ?? (mins !== undefined ? mins * 60 : b.idle_seconds);
  return {
    voice: VOICES.includes(c.voice) ? c.voice : b.voice,
    idle_minutes: Math.round((idleSeconds / 60) * 100) / 100,
    idle_seconds: idleSeconds,
    speaking_policy: POLICIES.includes(c.speaking_policy) ? c.speaking_policy : b.speaking_policy,
    daily_cap_minutes: num(c.daily_cap_minutes, 0, 1440) ?? b.daily_cap_minutes,
    wake_sensitivity: WAKE_SENSITIVITIES.includes(c.wake_sensitivity) ? c.wake_sensitivity : b.wake_sensitivity,
    window: WINDOW_MODES.includes(c.window) ? c.window : b.window,
    mirror: MIRROR_MODES.includes(c.mirror) ? c.mirror : b.mirror,
    open_browser: typeof c.open_browser === "boolean" ? c.open_browser : true,
  };
}

/**
 * Parse a .env file: KEY=VALUE lines, optional `export ` prefix, optional
 * single/double quotes, `#` comments (full-line, or after an unquoted value).
 */
export function parseDotEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    const q = v[0];
    if ((q === '"' || q === "'") && v.lastIndexOf(q) > 0) {
      v = v.slice(1, v.lastIndexOf(q));
      if (q === '"') v = v.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      v = v.replace(/\s+#.*$/, "").trim();
    }
    out[m[1]] = v;
  }
  return out;
}

/**
 * The environment and .env tiers of the key resolution (SPEC §4.3; the
 * Keychain and userConfig tiers are in apikey.js KeyStore). Returns
 * {key, source: "env"|"dotenv", file} or null.
 * The key is never logged; callers must keep it in memory only.
 */
export function resolveApiKeyInfo({ env = process.env, pluginRoot, dataDir, home = env.HOME, readFile = fs.readFileSync } = {}) {
  if (env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim()) return { key: env.OPENAI_API_KEY.trim(), source: "env", file: null };
  const candidates = [];
  if (pluginRoot) candidates.push(path.join(pluginRoot, ".env"));
  if (dataDir) candidates.push(path.join(dataDir, ".env"));
  if (home) candidates.push(path.join(home, ".sotto", ".env"));
  for (const file of candidates) {
    try {
      const v = parseDotEnv(readFile(file, "utf8")).OPENAI_API_KEY;
      if (v && v.trim()) return { key: v.trim(), source: "dotenv", file };
    } catch { /* missing or unreadable: try the next one */ }
  }
  return null;
}

/** The key from the environment or a .env file, or null (tests and e2e use this). */
export function resolveApiKey(opts = {}) {
  return resolveApiKeyInfo(opts)?.key ?? null;
}

export function openaiBase(env = process.env) {
  return (env.SOTTO_OPENAI_BASE || "https://api.openai.com/v1").replace(/\/+$/, "");
}

/** Sideband base: the same URL with https: → wss: (http: → ws: for local fakes). */
export function wssBase(base) {
  return base.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}
