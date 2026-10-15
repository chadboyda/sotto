// Live model selection (SPEC §4.7): `model` "auto" (the default) follows the
// newest GPT-Live the key's project lists, so a new release (GPT-Live 1.1 was
// announced 2026-10-15, "coming soon to the API") is used the moment the API
// has it, with no plugin update. An explicit id pins one.
//
// The choice is made at daemon start and every MODEL_REFRESH_MS from
// GET /v1/models, cached in D/live-model.json, and read once per session
// start: a session never changes model, the next one does. Any error keeps
// the cached choice (or gpt-live-1 with none); a model a session start
// refused is skipped (demoted) and the next session uses gpt-live-1.
//
// The same file holds what the API told us about voices (SPEC §4.5 "New
// voices"): ids an "invalid voice" error listed that the static list lacks
// (shown as new in the pickers), and voices a model refused.
import fs from "node:fs";
import { writeAtomic } from "./statefiles.js";
import { truncate } from "./log.js";

export const DEFAULT_LIVE_MODEL = "gpt-live-1";
export const MODEL_REFRESH_MS = 6 * 60 * 60 * 1000;
/** A demoted model is skipped this long, then tried again (a refused start costs one failed session). */
export const DEMOTE_MS = 24 * 60 * 60 * 1000;

// gpt-live-<major>[.<minor>][-<word>...][-YYYY-MM-DD]. Two-digit majors at
// most, so a bare date ("gpt-live-2026-10-15") is not read as version 2026.
const ID_RE = /^gpt-live-(\d{1,2})(?:\.(\d{1,3}))?((?:-[a-z0-9]+)*)$/;
// Not conversation models: never chosen for a voice session.
const NOT_CONVERSATION = new Set(["transcribe", "translate", "translation", "tts", "speech", "diarize"]);

/**
 * Parse a Live model id: {id, major, minor, date, variant} or null when it is
 * not gpt-live-<n>... (gpt-live-transcribe has no version and is null).
 */
export function parseLiveModel(id) {
  const m = typeof id === "string" ? ID_RE.exec(id.trim()) : null;
  if (!m) return null;
  const words = m[3].split("-").filter(Boolean);
  let date = null;
  const n = words.length;
  if (n >= 3 && /^\d{4}$/.test(words[n - 3]) && /^\d{2}$/.test(words[n - 2]) && /^\d{2}$/.test(words[n - 1])) {
    date = words.splice(n - 3, 3).join("-");
  }
  return { id: m[0], major: Number(m[1]), minor: m[2] === undefined ? 0 : Number(m[2]), date, variant: words.length ? words.join("-") : null };
}

/** A model a voice session can run on: gpt-live-<n>..., not a transcribe/translate variant. */
export function isLiveConversationModel(id) {
  const p = parseLiveModel(id);
  return !!p && !(p.variant && p.variant.split("-").some((w) => NOT_CONVERSATION.has(w)));
}

/**
 * Order two parsed ids, best first: higher version; then the full model over a
 * variant (mini); then the alias over a dated snapshot (the alias tracks the
 * newest snapshot); then the newer date.
 */
function better(a, b) {
  if (a.major !== b.major) return b.major - a.major;
  if (a.minor !== b.minor) return b.minor - a.minor;
  if (!!a.variant !== !!b.variant) return a.variant ? 1 : -1;
  if (!!a.date !== !!b.date) return a.date ? 1 : -1;
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The newest conversation model among `ids` (minus `exclude`), or
 * DEFAULT_LIVE_MODEL when there is none. Mini and other variants count only
 * when no full model is listed.
 */
export function pickLiveModel(ids, { exclude = [] } = {}) {
  const skip = new Set(exclude);
  const cands = (Array.isArray(ids) ? ids : []).filter((id) => !skip.has(id) && isLiveConversationModel(id)).map(parseLiveModel);
  if (!cands.length) return DEFAULT_LIVE_MODEL;
  const full = cands.filter((p) => !p.variant);
  return (full.length ? full : cands).sort(better)[0].id;
}

/** "GPT-Live 1.1" for gpt-live-1.1 and gpt-live-1.1-2026-10-15; "GPT-Live 2 mini". */
export function modelLabel(id) {
  const p = parseLiveModel(id);
  if (!p) return String(id || DEFAULT_LIVE_MODEL);
  const v = /^gpt-live-\d+\.\d+/.test(p.id) ? `${p.major}.${p.minor}` : `${p.major}`;
  return `GPT-Live ${v}${p.variant ? ` ${p.variant.replace(/-/g, " ")}` : ""}`;
}

/** A `model` setting: "auto", a Live model id, or null when invalid. */
export function normalizeModelPref(v) {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "auto" || s === "") return s === "auto" ? "auto" : null;
  return isLiveConversationModel(s) ? s : null;
}

const VOICE_ID_RE = /^[a-z]{2,20}$/;

/**
 * Read an OpenAI error about the voice: {invalid, voices}. `invalid` when the
 * message says the voice is not valid/supported; `voices` the quoted ids it
 * lists (an "Invalid value: 'x'. Supported values are: 'alloy', ..." shape).
 * Field names (audio.output.voice) and the model id are not voices.
 */
export function parseVoiceError(message, { tried = null } = {}) {
  const s = String(message || "");
  const invalid = /voice/i.test(s) && /(invalid|unsupported|not (supported|available|valid|allowed)|unknown|does not exist)/i.test(s);
  const voices = [];
  if (invalid) {
    const re = /['"`‘“]([a-z]{2,20})['"`’”]/g;
    let m;
    while ((m = re.exec(s))) {
      const v = m[1];
      if (v !== tried && v !== "voice" && !voices.includes(v)) voices.push(v);
    }
  }
  return { invalid, voices };
}

export class ModelSelector {
  /**
   * @param {object} o
   * @param {string} o.file          D/live-model.json
   * @param {string} [o.voicesFile]  D/voices-extra (one line, for toggle.sh)
   * @param {() => string} o.base    OpenAI base URL
   * @param {() => string|null} o.getApiKey
   * @param {() => string} o.getPref "auto" or an explicit id (prefs.json)
   */
  constructor({ file, voicesFile = null, base, getApiKey, getPref = () => "auto", fetchImpl = globalThis.fetch, clock, log, timeoutMs = 10_000 }) {
    Object.assign(this, { file, voicesFile, base, getApiKey, getPref, fetchImpl, clock, log, timeoutMs });
    this.state = this.load();
    this.demoted = new Map(); // id -> until (ms)
    this.refreshing = null;
    this.lastOk = false;
  }

  load() {
    try {
      const o = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!o || typeof o !== "object" || Array.isArray(o)) return {};
      const out = {};
      if (isLiveConversationModel(o.chosen)) out.chosen = o.chosen;
      if (isLiveConversationModel(o.announced)) out.announced = o.announced;
      if (Array.isArray(o.available)) out.available = o.available.filter((x) => typeof x === "string").slice(0, 40);
      if (Number.isFinite(o.checked_at)) out.checked_at = o.checked_at;
      if (o.new_voices && typeof o.new_voices === "object") {
        out.new_voices = {};
        for (const [v, at] of Object.entries(o.new_voices)) if (VOICE_ID_RE.test(v)) out.new_voices[v] = at;
      }
      if (o.bad_voices && typeof o.bad_voices === "object") {
        out.bad_voices = {};
        for (const [m, list] of Object.entries(o.bad_voices)) if (Array.isArray(list)) out.bad_voices[m] = list.filter((v) => VOICE_ID_RE.test(v));
      }
      return out;
    } catch {
      return {};
    }
  }

  save() {
    try { writeAtomic(this.file, `${JSON.stringify(this.state)}\n`); } catch (e) { this.log?.warn("live.model_save_error", { message: truncate(String(e && e.message), 200) }); }
    if (this.voicesFile) {
      try { writeAtomic(this.voicesFile, `${this.newVoices().join(" ")}\n`); } catch { /* data dir unwritable */ }
    }
  }

  /** "auto" or the pinned id. */
  mode() {
    return normalizeModelPref(this.getPref?.()) || "auto";
  }

  isDemoted(id) {
    const until = this.demoted.get(id);
    if (until === undefined) return false;
    if (this.clock.now() >= until) { this.demoted.delete(id); return false; }
    return true;
  }

  /** The model the next session uses. Read once per session start; a running session keeps its own. */
  forSession() {
    const mode = this.mode();
    const want = mode === "auto" ? this.state.chosen || DEFAULT_LIVE_MODEL : mode;
    return this.isDemoted(want) ? DEFAULT_LIVE_MODEL : want;
  }

  /**
   * GET /v1/models and choose. Never throws; resolves to the choice. Without
   * a key nothing is asked. Logs live.model {chosen, available, previous}.
   */
  refresh(reason = "interval") {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh(reason).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async doRefresh(reason) {
    const key = this.getApiKey?.();
    if (!key) return this.forSession();
    const previous = this.state.chosen || null;
    let ids;
    const ac = new AbortController();
    const t = this.clock.setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base()}/models`, { method: "GET", headers: { Authorization: `Bearer ${key}` }, signal: ac.signal });
      let body = null;
      try { body = JSON.parse(await res.text()); } catch { /* not JSON */ }
      if (res.status < 200 || res.status >= 300 || !Array.isArray(body?.data)) throw new Error(`HTTP ${res.status}`);
      ids = body.data.map((m) => m?.id).filter((x) => typeof x === "string");
    } catch (e) {
      this.lastOk = false;
      const chosen = this.forSession();
      this.log?.warn("live.model_error", { reason, message: truncate(String(e?.name === "AbortError" ? "timeout" : e && e.message), 200), using: chosen });
      return chosen;
    } finally {
      this.clock.clearTimeout(t);
    }
    this.lastOk = true;
    const available = ids.filter((id) => id.startsWith("gpt-live")).sort();
    const exclude = [...this.demoted.keys()].filter((id) => this.isDemoted(id));
    const chosen = pickLiveModel(available, { exclude });
    this.state = { ...this.state, chosen, available, checked_at: this.clock.now() };
    this.save();
    this.log?.info("live.model", { chosen, available, previous, mode: this.mode(), reason, ...(exclude.length ? { demoted: exclude } : {}) });
    return chosen;
  }

  /**
   * A session start on `model` was refused: skip it for DEMOTE_MS. Returns
   * true when the next session will use another model.
   */
  demote(model, why) {
    if (!model || model === DEFAULT_LIVE_MODEL) return false;
    this.demoted.set(model, this.clock.now() + DEMOTE_MS);
    this.log?.warn("live.model_demoted", { model, to: DEFAULT_LIVE_MODEL, why: truncate(String(why || ""), 200) });
    return true;
  }

  /**
   * The line to say once when the session's model is not the one the user
   * last heard about: the label ("GPT-Live 1.1"), or null. The first model
   * ever used is recorded silently.
   */
  announcement(model) {
    if (!this.state.announced) {
      this.state.announced = model;
      this.save();
      return null;
    }
    return this.state.announced === model ? null : modelLabel(model);
  }

  markAnnounced(model) {
    if (this.state.announced === model) return;
    this.log?.info("live.model_announced", { model, previous: this.state.announced || null });
    this.state.announced = model;
    this.save();
  }

  // ---- voices -------------------------------------------------------------------------
  /** Voice ids the API reported that the static list lacks (oldest first). */
  newVoices() {
    const o = this.state.new_voices || {};
    return Object.keys(o).sort((a, b) => (o[a] - o[b]) || (a < b ? -1 : 1));
  }

  /** Merge ids the API reported; `known` is the static list. Returns the ids that were new. */
  mergeVoices(ids, known, source) {
    const add = (Array.isArray(ids) ? ids : []).filter((v) => VOICE_ID_RE.test(v) && !known.includes(v) && !(this.state.new_voices || {})[v]);
    if (!add.length) return [];
    this.state.new_voices = { ...(this.state.new_voices || {}) };
    for (const v of add) this.state.new_voices[v] = this.clock.now();
    this.save();
    this.log?.info("voice.new", { voices: add, source });
    return add;
  }

  /** `voice` was refused by `model`. */
  markBadVoice(model, voice) {
    if (!VOICE_ID_RE.test(voice || "")) return;
    const bad = { ...(this.state.bad_voices || {}) };
    const list = bad[model] || [];
    if (list.includes(voice)) return;
    bad[model] = [...list, voice];
    this.state.bad_voices = bad;
    this.save();
  }

  voiceOk(model, voice) {
    return !(this.state.bad_voices?.[model] || []).includes(voice);
  }

  /** {mode, model (next session), chosen, available, checked_at} for status. */
  info() {
    return { mode: this.mode(), model: this.forSession(), chosen: this.state.chosen || null, available: this.state.available || [], checked_at: this.state.checked_at || null };
  }
}
