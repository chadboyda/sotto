#!/usr/bin/env node
// End-to-end first-run API key setup against the REAL OpenAI API (SPEC §4.3).
//
//   a plugin root with no .env, an empty HOME and a TEMPORARY Keychain service
//   → /talk on (real toggle.sh) binds but has no key → the real page, in
//   headless Chrome driven over CDP, shows the key card → a wrong key is
//   rejected by OpenAI → the real key is checked (GET /v1/models lists
//   gpt-live-1), saved in the Keychain → the page connects a gpt-live-1
//   session by itself → /talk key reports the Keychain → the settings drawer
//   shows "Key ending in …" and removes it → /talk off.
//
// Cost: one short Live session, typically under 10 billed seconds.
// The Keychain item lives under "sotto-e2e-<pid>" and is deleted at the end;
// the user's real "sotto" item is never touched. Never prints the key.
//
//   npm run e2e:key
//   SOTTO_E2E_KEY_PORT=47897   daemon port
//   SOTTO_E2E_KEEP=1           keep the temp dir (logs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startFakeInbox } from "../helpers/fake-inbox.js";
import { CHROME, spawnSilentChrome } from "../helpers/silent-chrome.js";
import { resolveApiKey } from "../../daemon/config.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PORT = Number(process.env.SOTTO_E2E_KEY_PORT || 47897);
const SECURITY = "/usr/bin/security";
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE = path.join(REPO, "test", "fixtures", "ask-files.wav");
const SOCK = `/tmp/clv-e2e-key-${process.pid}.sock`;
const INBOX_TOKEN = `e2e-key-token-${process.pid}`;
const SERVICE = `sotto-e2e-${process.pid}`;
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clv-e2e-key-")));
const D = path.join(TMP, "data");
const ROOT = path.join(TMP, "plugin"); // the repo without its .env
const LIVE_BUDGET_MS = 60_000;

const results = [];
const timings = {};
let inbox;
let chrome;
let page;
let liveSince = 0;
let liveId = null;
let billed = null;
let DKEY = "";

const log = (...a) => console.log("[e2e-key]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " - " + detail : ""}`);
  return !!ok;
}
async function until(fn, ms, every = 150) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() > end) return null;
    await sleep(every);
  }
}
const readLog = () => {
  try {
    return fs.readFileSync(path.join(D, "logs", "daemon.log"), "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};
const ts = (e) => Date.parse(e.ts);
const secs = (ms) => (ms / 1000).toFixed(2) + " s";
const status = async () => (await fetch(`${BASE}/status`, { headers: { "X-Sotto-Key": DKEY } })).json();
const keychainGet = () => {
  const r = spawnSync(SECURITY, ["find-generic-password", "-s", SERVICE, "-a", "openai-api-key", "-w"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};

/** What Claude Code gives the /talk hook, with no key anywhere but what the page saves. */
function hookEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^CLAUDE_|^OPENAI_API_KEY$/.test(k)) env[k] = v;
  // HOME stays real: `security` finds the login Keychain through it (a fake
  // HOME makes every Keychain write fail with "authorization was canceled").
  return Object.assign(env, {
    CLAUDE_PLUGIN_ROOT: ROOT,
    CLAUDE_PLUGIN_DATA: D,
    CLAUDE_PLUGIN_OPTION_PORT: String(PORT),
    CLAUDE_PLUGIN_OPTION_DAILY_CAP_MINUTES: "5",
    CLAUDE_CODE_MESSAGING_SOCKET: SOCK,
    CLAUDE_CODE_MESSAGING_TOKEN: INBOX_TOKEN,
    CLAUDE_PROJECT_DIR: REPO,
    SOTTO_NO_BROWSER: "1", // the test drives its own headless Chrome
    SOTTO_UPDATE: "0", // an edit to this checkout mid-run must not restart the test daemon
    SOTTO_KEYCHAIN_SERVICE: SERVICE,
  });
}

function toggle(arg) {
  const input = JSON.stringify({
    session_id: "e2e-key", transcript_path: "", cwd: REPO, prompt_id: "p", permission_mode: "default",
    hook_event_name: "UserPromptExpansion", expansion_type: "slash_command", command_name: "sotto:talk",
    command_args: arg, command_source: "plugin", prompt: `/sotto:talk ${arg}`.trim(),
  });
  const t0 = Date.now();
  const r = spawnSync(path.join(ROOT, "scripts", "toggle.sh"), [], { input, encoding: "utf8", env: hookEnv(), timeout: 15000 });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* checked by caller */ }
  return { status: r.status, stdout: r.stdout, out, ms: Date.now() - t0 };
}

/** Minimal Chrome DevTools Protocol client: evaluate JS in the voice page. */
async function connectPage(userDir) {
  const portFile = path.join(userDir, "DevToolsActivePort");
  const devPort = await until(() => fs.readFileSync(portFile, "utf8").split("\n")[0].trim(), 10000);
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json())
    .find((t) => t.type === "page" && t.url.startsWith(BASE)), 10000);
  if (!target) throw new Error("no voice page target");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
  return {
    async eval(expression) {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
      return r.result?.result?.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

function preflight() {
  const missing = [];
  if (process.platform !== "darwin" || !fs.existsSync(SECURITY)) missing.push("macOS Keychain");
  if (!fs.existsSync(CHROME)) missing.push("Google Chrome");
  if (spawnSync("which", ["ffmpeg"]).status !== 0) missing.push("ffmpeg");
  if (!resolveApiKey({ env: process.env, pluginRoot: REPO })) missing.push("OPENAI_API_KEY");
  // A key in ~/.sotto/.env would outrank the Keychain: this test needs none there.
  if (resolveApiKey({ env: {}, home: os.homedir() })) missing.push("an empty ~/.sotto/.env (it holds a key)");
  return missing;
}
const daemonPid = () => { try { return Number(fs.readFileSync(path.join(D, "daemon.pid"), "utf8").trim()) || null; } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function main() {
  const missing = preflight();
  if (missing.length) { log(`SKIP: missing ${missing.join(", ")}`); process.exitCode = 2; return; }
  const REAL_KEY = resolveApiKey({ env: process.env, pluginRoot: REPO });

  // A plugin root without .env: symlinks to the real code.
  fs.mkdirSync(ROOT);
  for (const f of ["daemon", "web", "scripts", "bin", "package.json", ".claude-plugin"]) fs.symlinkSync(path.join(REPO, f), path.join(ROOT, f));
  check("no key anywhere to start with", !resolveApiKey({ env: {}, pluginRoot: ROOT, dataDir: D, home: os.homedir() }) && keychainGet() === null);

  inbox = await startFakeInbox(SOCK, {});

  // 1. /talk on without a key: bound, paused, pointed at the key setup.
  const on = toggle("on");
  check("toggle.sh on without a key: one JSON line", on.status === 0 && on.out?.continue === false && on.stdout.trim().split("\n").length === 1);
  check("on message says there is no key yet", /^sotto: voice ON \(.*\), but there is no OpenAI API key yet\./.test(on.out?.stopReason || ""), on.out?.stopReason);
  timings.toggle_on_cold_ms = on.ms;
  DKEY = fs.readFileSync(path.join(D, "daemon.key"), "utf8").trim();
  const s0 = await status();
  check("state paused, last_error no_api_key", s0.state === "paused" && s0.last_error?.code === "no_api_key", `${s0.state} ${s0.last_error?.code}`);
  const h0 = await (await fetch(`${BASE}/healthz`)).json();
  check("healthz api_key:false", h0.api_key === false);

  // 2. The real page in headless Chrome (fake mic), driven over CDP.
  const PAGE_SECRET = fs.readFileSync(path.join(D, "page.secret"), "utf8").trim();
  const userDir = path.join(TMP, "chrome-key");
  const wav = path.join(TMP, "mic.wav");
  const ff = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-i", FIXTURE, "-af", "adelay=30000:all=1,apad=pad_dur=30", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
  // Tests never use the real mic: no fake-mic file, no Chrome.
  if (!check("fake-mic wav", ff.status === 0 && fs.existsSync(wav))) return;
  chrome = spawnSilentChrome({ wav, extra: [
    "--remote-debugging-port=0", `--user-data-dir=${userDir}`, `${BASE}/#k=${PAGE_SECRET}`,
  ] });
  page = await connectPage(userDir);
  const card = await until(() => page.eval(`(() => { const f = document.getElementById("key-field"); return f && !f.hidden && !document.getElementById("overlay").hidden ? document.getElementById("overlay-title").textContent : null; })()`), 10000);
  check("page shows the key card", card === "Add your OpenAI API key to start", card);
  const drawer0 = await page.eval(`document.getElementById("key-summary").textContent`);
  check("settings drawer: No key yet", drawer0 === "No key yet", drawer0);

  // 3. A wrong key: rejected by OpenAI, nothing stored.
  const submit = (k) => page.eval(`(() => { const i = document.getElementById("api-key-input"); i.value = ${JSON.stringify(k)}; document.getElementById("key-field").requestSubmit(); return true; })()`);
  const tBad = Date.now();
  await submit("sk-test-" + "0".repeat(32) + "nope");
  const badErr = await until(() => page.eval(`(() => { const e = document.getElementById("api-key-error"); return !e.hidden && e.textContent ? e.textContent : null; })()`), 15000);
  check("wrong key: OpenAI rejects it, the page says so", /OpenAI rejected this key/.test(badErr || ""), `${badErr} (${Date.now() - tBad} ms)`);
  check("wrong key: nothing in the Keychain", keychainGet() === null);
  const badCheck = readLog().find((e) => e.ev === "key.check" && e.ok === false);
  if (badCheck) timings.wrong_key_check_ms = badCheck.ms;

  // 4. The real key: checked, saved in the Keychain, voice connects by itself.
  const tSave = Date.now();
  await submit(REAL_KEY);
  const saved = await until(() => readLog().find((e) => e.ev === "key.saved"), 20000);
  check("real key checked with OpenAI and saved", saved?.source === "keychain");
  const good = readLog().find((e) => e.ev === "key.check" && e.ok === true);
  if (good) timings.key_check_ms = good.ms;
  if (saved) timings.submit_to_saved_ms = ts(saved) - tSave;
  check("Keychain holds exactly that key (temp service)", keychainGet() === REAL_KEY);
  check("the input is emptied after saving", (await page.eval(`document.getElementById("api-key-input").value`)) === "");
  const live = await until(async () => { const s = await status(); return s.state === "live" ? s : null; }, 25000);
  if (!check("the page connected a live session on its own", !!live, live ? "" : (await status()).state)) return;
  liveSince = Date.now();
  liveId = live.live.session_id;
  timings.submit_to_live_ms = liveSince - tSave;
  const created = readLog().find((e) => e.ev === "session.create" && e.ok);
  check("session created with gpt-live-1", created?.model === "gpt-live-1", created?.model);
  check("status: key source keychain", live.api_key?.source === "keychain");
  const h1 = await (await fetch(`${BASE}/healthz`)).json();
  check("healthz api_key:true", h1.api_key === true);

  // 5. /talk key says where the key comes from (last four only).
  const k = toggle("key");
  const hint = REAL_KEY.slice(-4);
  check("/talk key: from the macOS Keychain", k.out?.stopReason === `sotto: using the OpenAI API key ending in ${hint} from the macOS Keychain. Change or remove it in the voice window settings.`, (k.out?.stopReason || "").replace(hint, "****"));
  const typed = toggle("key sk-test-typedintotheprompt0000000");
  check("/talk key <text>: not read, setup opens", /^sotto: API keys are never read from \/talk arguments/.test(typed.out?.stopReason || "") && !readLog().some((e) => JSON.stringify(e).includes("typedintotheprompt")));

  // 6. Drawer: "Key ending in …", then Remove (two clicks).
  const drawer1 = await until(() => page.eval(`(() => { const t = document.getElementById("key-summary").textContent; return t.startsWith("Key ending in") ? t : null; })()`), 5000);
  check("settings drawer: Key ending in (last four)", drawer1 === `Key ending in ${hint}`, drawer1 ? "Key ending in ****" : "");
  await page.eval(`(() => { document.getElementById("settings-btn").click(); const b = document.getElementById("key-remove-btn"); b.click(); b.click(); return true; })()`);
  const removed = await until(() => keychainGet() === null, 5000);
  check("drawer Remove deletes the Keychain item", !!removed);
  const drawer2 = await until(() => page.eval(`(() => { const t = document.getElementById("key-summary").textContent; return t === "No key yet" ? t : null; })()`), 5000);
  check("drawer shows No key yet; the live session keeps running", drawer2 === "No key yet" && (await status()).state === "live");

  // 7. Off.
  const off = toggle("off");
  check("toggle.sh off", /^sotto: voice OFF\./.test(off.out?.stopReason || ""));
  const closed = await until(() => readLog().find((e) => e.ev === "session.closed" && e.live_id === liveId), 15000);
  check("session.closed close_requested", closed?.reason === "close_requested", closed?.reason);
  billed = closed?.seconds ?? null;
  timings.live_wall_ms = Date.now() - liveSince;

  // 8. Hygiene: the key is nowhere on disk or in the log.
  let leak = false;
  for (const f of fs.readdirSync(D, { recursive: true })) {
    const p = path.join(D, f);
    try { if (fs.statSync(p).isFile() && fs.readFileSync(p).includes(REAL_KEY)) leak = true; } catch { /* gone */ }
  }
  check("the key is in no file of the data dir (logs, status.json)", !leak);
}

async function cleanup() {
  page?.close();
  try {
    const h = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(500) }).then((r) => r.json());
    if (h.name === "sotto" && h.state !== "off") {
      await fetch(`${BASE}/control`, { method: "POST", headers: { "Content-Type": "application/json", "X-Sotto-Key": DKEY }, body: JSON.stringify({ action: "shutdown" }) }).catch(() => {});
      await sleep(2500);
    }
  } catch { /* already gone */ }
  if (chrome) { try { chrome.kill("SIGTERM"); } catch { /* ignore */ } }
  const pid = daemonPid();
  if (pid && alive(pid)) { try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ } }
  await sleep(500);
  if (chrome) { try { chrome.kill("SIGKILL"); } catch { /* ignore */ } }
  if (pid && alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ } }
  if (inbox) await inbox.close().catch(() => {});
  try { fs.unlinkSync(SOCK); } catch { /* ignore */ }
  spawnSync(SECURITY, ["delete-generic-password", "-s", SERVICE, "-a", "openai-api-key"], { stdio: "ignore" });
  check("temporary Keychain item cleaned up", keychainGet() === null);
  if (process.env.SOTTO_E2E_KEEP === "1") log(`kept ${TMP}`);
  else fs.rmSync(TMP, { recursive: true, force: true });
}

let budgetBlown = false;
const guard = setInterval(() => {
  if (!liveSince || budgetBlown || Date.now() - liveSince < LIVE_BUDGET_MS) return;
  budgetBlown = true;
  check("finished within the Live budget", false, `${LIVE_BUDGET_MS / 1000} s`);
  fetch(`${BASE}/control`, { method: "POST", headers: { "Content-Type": "application/json", "X-Sotto-Key": DKEY }, body: JSON.stringify({ action: "shutdown" }) }).catch(() => {});
}, 1000);
guard.unref();

try {
  await main();
} catch (e) {
  check("no exceptions", false, String(e && e.stack || e));
} finally {
  await cleanup();
  clearInterval(guard);
  const failed = results.filter((r) => !r.ok);
  log("---- timings");
  for (const [k, v] of Object.entries(timings)) log(`${k.padEnd(28)} ${k.endsWith("_ms") ? secs(v) : v}`);
  log("----");
  log(`${failed.length ? "FAIL" : process.exitCode === 2 ? "SKIP" : "PASS"}: ${results.filter((r) => r.ok).length} passed, ${failed.length} failed`);
  log(`live session: ${liveId || "none"}  billed seconds: ${billed ?? "unknown"}`);
  if (failed.length) process.exitCode = 1;
}
