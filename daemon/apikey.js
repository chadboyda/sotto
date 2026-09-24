// OpenAI API key: where it comes from, the macOS Keychain store, and the
// check that runs before a key typed into the voice page is saved (SPEC §4.3).
//
// Resolution order (first hit wins):
//   1. OPENAI_API_KEY in the daemon's environment (inherited from Claude Code);
//   2. a .env file: <plugin root>/.env, then D/.env, then ~/.sotto/.env;
//   3. the macOS Keychain: generic password, service "sotto",
//      account "openai-api-key" (what the voice page saves);
//   4. the plugin's sensitive userConfig `openai_api_key` (Claude Code keeps it
//      in its own secure storage and exports it to hooks as
//      CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY; toggle.sh hands it to the daemon
//      through the environment at spawn, never argv).
//
// The key itself is never logged, never sent to the page, never written to a
// file by sotto, and never put on a command line: the Keychain write feeds
// `security -i` its command on stdin, because `security add-generic-password
// -w <key>` would show the key to every local user in `ps`.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { resolveApiKeyInfo } from "./config.js";

export const KEYCHAIN_SERVICE = "sotto";
export const KEYCHAIN_ACCOUNT = "openai-api-key";
export const KEYCHAIN_LABEL = "Sotto OpenAI API key";
export const SECURITY_BIN = "/usr/bin/security";
export const REQUIRED_MODEL = "gpt-live-1";

/** OpenAI secret keys: sk-, sk-proj-, sk-svcacct-, sk-admin- … then key characters. */
export const KEY_RE = /^sk-[A-Za-z0-9_-]{16,400}$/;

/**
 * Tidy a key pasted into the page: trims whitespace, a surrounding pair of
 * quotes, and a leading `OPENAI_API_KEY=` / `export OPENAI_API_KEY=` (people
 * paste their .env line). Returns the key if it looks like one, else null.
 */
export function normalizeKeyInput(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim().replace(/^(?:export\s+)?OPENAI_API_KEY\s*=\s*/, "").trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) s = s.slice(1, -1).trim();
  return KEY_RE.test(s) ? s : null;
}

/** The last four characters, for "key ending in abcd". Never more. */
export function keyHint(key) {
  return typeof key === "string" && key.length >= 12 ? key.slice(-4) : null;
}

const SOURCE_LABELS = {
  env: "the OPENAI_API_KEY environment variable",
  dotenv: "a .env file",
  keychain: "the macOS Keychain",
  user_config: "the plugin settings",
};

/**
 * The macOS Keychain through /usr/bin/security. `available` is false off
 * macOS (and when disabled with SOTTO_KEYCHAIN=0); then get() returns null
 * and set() fails with keychain_unavailable.
 * Tests pass SOTTO_SECURITY_BIN (a fake) and/or SOTTO_KEYCHAIN_SERVICE.
 */
export function createKeychain({
  env = process.env, platform = process.platform, bin, service, account = KEYCHAIN_ACCOUNT, exec = execFileSync, timeoutMs = 3000,
} = {}) {
  const securityBin = bin || env.SOTTO_SECURITY_BIN || SECURITY_BIN;
  const svc = service || env.SOTTO_KEYCHAIN_SERVICE || KEYCHAIN_SERVICE;
  const available = env.SOTTO_KEYCHAIN !== "0" && (platform === "darwin" || !!env.SOTTO_SECURITY_BIN);
  const run = (args, input) => exec(securityBin, args, {
    encoding: "utf8", timeout: timeoutMs, input, stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    available,
    service: svc,
    account,
    /** The stored key, or null (none, locked, denied, timed out). */
    get() {
      if (!available) return null;
      try {
        const v = String(run(["find-generic-password", "-s", svc, "-a", account, "-w"], "")).trim();
        return v || null;
      } catch {
        return null; // exit 44 = not found; anything else is treated the same
      }
    },
    /** Store (or replace) the key. Returns {ok} or {ok:false, message} (message never has the key). */
    set(key) {
      if (!available) return { ok: false, message: "The macOS Keychain is not available here." };
      if (!KEY_RE.test(key)) return { ok: false, message: "Not an API key." };
      // KEY_RE allows only [A-Za-z0-9_-], so the quoted value needs no escaping
      // inside the `security -i` command line. -U updates an existing item.
      const cmd = `add-generic-password -U -s "${svc}" -a "${account}" -l "${KEYCHAIN_LABEL}" -w "${key}"\n`;
      try {
        run(["-i"], cmd);
      } catch (e) {
        return { ok: false, message: e.code === "ETIMEDOUT" ? "The Keychain did not answer (is it locked?)." : "The Keychain refused the key." };
      }
      // `security -i` exits 0 even when a command inside fails: read it back.
      if (this.get() !== key) return { ok: false, message: "The Keychain did not keep the key (is it locked?)." };
      return { ok: true };
    },
    /** Delete the item. Returns {ok, removed}. */
    remove() {
      if (!available) return { ok: false, removed: false };
      try {
        run(["delete-generic-password", "-s", svc, "-a", account], "");
        return { ok: true, removed: true };
      } catch {
        return { ok: this.get() === null, removed: false };
      }
    },
  };
}

/**
 * The daemon's view of the key. Environment and .env files are read on every
 * call (cheap, and an edit takes effect at once); the Keychain is read at the
 * first call and again on refresh() (each read spawns `security`, ~25 ms).
 */
export class KeyStore {
  constructor({ env = process.env, pluginRoot, dataDir, home, keychain, userConfigKey, readFile = fs.readFileSync } = {}) {
    this.env = env;
    this.pluginRoot = pluginRoot;
    this.dataDir = dataDir;
    this.home = home ?? env.HOME;
    this.readFile = readFile;
    this.keychain = keychain || createKeychain({ env });
    const uc = typeof userConfigKey === "string" ? userConfigKey.trim() : "";
    this.userConfigKey = uc || null; // memory only
    this.keychainKey = undefined; // undefined = not read yet
  }

  refresh() {
    this.keychainKey = this.keychain.get();
    return this;
  }

  /** {key, source, file} with source env | dotenv | keychain | user_config | null. */
  current() {
    const d = resolveApiKeyInfo({ env: this.env, pluginRoot: this.pluginRoot, dataDir: this.dataDir, home: this.home, readFile: this.readFile });
    if (d) return d;
    if (this.keychainKey === undefined) this.refresh();
    if (this.keychainKey) return { key: this.keychainKey, source: "keychain", file: null };
    if (this.userConfigKey) return { key: this.userConfigKey, source: "user_config", file: null };
    return { key: null, source: null, file: null };
  }

  key() { return this.current().key; }

  /**
   * What the page and /talk key may know: never the key, only its last four
   * characters and where it comes from.
   */
  info() {
    const c = this.current();
    const canStore = this.keychain.available;
    return {
      present: !!c.key,
      source: c.source,
      file: c.file || null,
      hint: keyHint(c.key),
      label: c.source ? SOURCE_LABELS[c.source] : null,
      // The page can store a key only in the Keychain, which is outranked by
      // the environment and .env files: changing one of those is up to the user.
      can_change: canStore && (c.source === null || c.source === "keychain" || c.source === "user_config"),
      can_remove: canStore && c.source === "keychain",
      keychain: canStore,
    };
  }

  /** Store a validated key in the Keychain and re-read it. */
  save(key) {
    const r = this.keychain.set(key);
    this.refresh();
    return r;
  }

  remove() {
    const r = this.keychain.remove();
    this.refresh();
    return r;
  }
}

/** Where the key in use comes from, for messages: the .env path, or the source label. */
export function keyWhere(info) {
  if (!info?.source) return "nowhere";
  return info.source === "dotenv" && info.file ? info.file : info.label;
}

/**
 * Check a key with GET /v1/models before saving it: the key must be accepted
 * and its project must list gpt-live-1. A 403 on the list (a restricted key
 * without the Models read permission) falls back to GET /v1/models/gpt-live-1.
 * Returns {ok:true} or {ok:false, code, message}; messages are ours, never
 * OpenAI's (their 401 text echoes part of the key).
 */
export async function validateKey({ base, key, fetchImpl = globalThis.fetch, clock, timeoutMs = 10_000, model = REQUIRED_MODEL }) {
  const get = async (path) => {
    const ac = new AbortController();
    const t = (clock?.setTimeout || setTimeout)(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}${path}`, { method: "GET", headers: { Authorization: `Bearer ${key}` }, signal: ac.signal });
      let body = null;
      try { body = JSON.parse(await res.text()); } catch { /* not JSON */ }
      return { status: res.status, body };
    } finally {
      (clock?.clearTimeout || clearTimeout)(t);
    }
  };
  let r;
  try {
    r = await get("/models");
    if (r.status === 403) {
      const one = await get(`/models/${encodeURIComponent(model)}`);
      if (one.status >= 200 && one.status < 300) return { ok: true };
      if (one.status === 404) r = { status: 200, body: { data: [] } };
    }
  } catch (e) {
    const timeout = e?.name === "AbortError";
    return {
      ok: false, code: "network",
      message: timeout ? "OpenAI did not answer in time while checking the key. Try again." : "Could not reach OpenAI to check the key. Check your internet connection and try again.",
    };
  }
  if (r.status === 401) return { ok: false, code: "invalid_key", message: "OpenAI rejected this key. Check that you copied all of it, or create a new one." };
  if (r.status === 403) return { ok: false, code: "key_forbidden", message: "OpenAI refused this key (it may be restricted). Use a key whose project can use gpt-live-1." };
  if (r.status === 429) return { ok: false, code: "rate_limited", message: "OpenAI is rate limiting this key right now. Wait a minute and try again." };
  if (r.status < 200 || r.status >= 300) return { ok: false, code: "openai_error", message: `OpenAI returned an error (HTTP ${r.status}) while checking the key. Try again.` };
  const ids = Array.isArray(r.body?.data) ? r.body.data.map((m) => m?.id) : [];
  if (!ids.includes(model)) {
    return { ok: false, code: "no_model_access", message: `This key works, but its project cannot use ${model}. Enable ${model} for the project in the OpenAI dashboard, or use another key.` };
  }
  return { ok: true };
}
