#!/usr/bin/env node
// End-to-end self-update against the REAL gpt-live-1 (SPEC §6.17).
//
//   temp copy of the plugin → toggle.sh on → headless Chrome (silent fake mic)
//   → session 1 live, greets → a quiet moment → a daemon file AND a web file
//   change in the temp copy → the daemon hands over to a new process on the
//   same port → the page reloads into the new page and reconnects → session 2
//   (seeded, reason "reconnect") says "I just updated myself" → hooks still
//   reach the new daemon with the old D/active → toggle.sh off.
//
// The quiet threshold and check interval are shortened with SOTTO_UPDATE_*
// (the defaults are 45 s and 30 s). Cost: two short sessions, typically
// 30-35 billed seconds (~$0.03). Never prints the key or any token.
//
//   npm run e2e:restart
//   SOTTO_E2E_RESTART_PORT=47893  daemon port
//   SOTTO_NODE=bun                run the daemon under Bun instead of Node
//   SOTTO_E2E_KEEP=1              keep the temp dir (logs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startFakeInbox } from "../helpers/fake-inbox.js";
import { CHROME, spawnSilentChrome } from "../helpers/silent-chrome.js";
import { resolveApiKey } from "../../daemon/config.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PORT = Number(process.env.SOTTO_E2E_RESTART_PORT || 47893);
const BASE = `http://127.0.0.1:${PORT}`;
const SOCK = `/tmp/clv-e2e-rs-${process.pid}.sock`;
const INBOX_TOKEN = `e2e-rs-token-${process.pid}`;
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clv-e2e-rs-")));
const ROOT = path.join(TMP, "plugin"); // the copy whose code changes
const D = path.join(TMP, "data");
const LIVE_BUDGET_MS = 90_000;
const QUIET_MS = 4000;

const results = [];
const timings = {};
const billed = {};
let inbox;
let chrome;
let liveSince = 0;
let apiKey = null;

const log = (...a) => console.log("[e2e-restart]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " - " + detail : ""}`);
  return !!ok;
}
function warn(name, detail) {
  results.push({ name, ok: true, warn: true, detail });
  log(`WARN ${name}${detail ? " - " + detail : ""}`);
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

let KEY = "";
const hdr = () => ({ "Content-Type": "application/json", "X-Sotto-Key": KEY });
const status = async () => (await fetch(`${BASE}/status`, { headers: hdr(), signal: AbortSignal.timeout(1000) })).json();
const healthz = async () => (await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(500) })).json();

function hookEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^CLAUDE_/.test(k)) env[k] = v;
  return Object.assign(env, {
    CLAUDE_PLUGIN_ROOT: ROOT,
    CLAUDE_PLUGIN_DATA: D,
    CLAUDE_PLUGIN_OPTION_PORT: String(PORT),
    CLAUDE_PLUGIN_OPTION_DAILY_CAP_MINUTES: "10",
    CLAUDE_CODE_MESSAGING_SOCKET: SOCK,
    CLAUDE_CODE_MESSAGING_TOKEN: INBOX_TOKEN,
    CLAUDE_PROJECT_DIR: ROOT,
    // The copy has no .env; the daemon inherits the key from its environment.
    OPENAI_API_KEY: apiKey,
    SOTTO_NO_BROWSER: "1",
    SOTTO_KEYCHAIN_SERVICE: `sotto-e2e-restart-${process.pid}`, // never the user's real Keychain item
    SOTTO_VOCAB: "0",
    SOTTO_UPDATE_CHECK_MS: "1000",
    SOTTO_UPDATE_SETTLE_MS: "500",
    SOTTO_UPDATE_QUIET_MS: String(QUIET_MS),
  });
}

function toggle(arg) {
  const input = JSON.stringify({
    session_id: "e2e-rs", transcript_path: "", cwd: ROOT, prompt_id: "p", permission_mode: "default",
    hook_event_name: "UserPromptExpansion", expansion_type: "slash_command", command_name: "sotto:talk",
    command_args: arg, command_source: "plugin", prompt: `/sotto:talk ${arg}`.trim(),
  });
  const r = spawnSync(path.join(ROOT, "scripts", "toggle.sh"), [], { input, encoding: "utf8", env: hookEnv(), timeout: 15000 });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* checked by caller */ }
  return { status: r.status, out };
}

function daemonPid() {
  try { return Number(fs.readFileSync(path.join(D, "daemon.pid"), "utf8").trim()) || null; } catch { return null; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function main() {
  const missing = [];
  if (!fs.existsSync(CHROME)) missing.push("Google Chrome");
  if (spawnSync("which", ["ffmpeg"]).status !== 0) missing.push("ffmpeg");
  apiKey = resolveApiKey({ env: process.env, pluginRoot: REPO });
  if (!apiKey) missing.push("OPENAI_API_KEY");
  if (missing.length) { log(`SKIP: missing ${missing.join(", ")}`); process.exitCode = 2; return; }

  // 1. The plugin copy (sources only) and a silent fake mic.
  for (const d of ["daemon", "web", "scripts", ".claude-plugin"]) fs.cpSync(path.join(REPO, d), path.join(ROOT, d), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(ROOT, "package.json"));
  const wav = path.join(TMP, "mic.wav");
  const ff = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "90", "-c:a", "pcm_s16le", wav]);
  if (!check("plugin copy + silent fake mic", ff.status === 0 && fs.existsSync(path.join(ROOT, "daemon", "index.js")))) return;

  inbox = await startFakeInbox(SOCK, {});
  const on = toggle("on");
  check("toggle.sh on", on.status === 0 && /^sotto: voice ON \(/.test(on.out?.stopReason || ""), on.out?.stopReason);
  const pid1 = daemonPid();
  if (!check("daemon 1 running", pid1 && alive(pid1), `pid ${pid1}`)) return;
  KEY = fs.readFileSync(path.join(D, "daemon.key"), "utf8").trim();
  const runtime = readLog().find((e) => e.ev === "start")?.runtime;
  log(`runtime: ${runtime}`);
  const PAGE_SECRET = fs.readFileSync(path.join(D, "page.secret"), "utf8").trim();
  const active1 = fs.readFileSync(path.join(D, "active"), "utf8");

  chrome = spawnSilentChrome({ wav, extra: [`--user-data-dir=${path.join(TMP, "chrome-e2e")}`, `${BASE}/?autostart=1#k=${PAGE_SECRET}`] });

  // 2. Session 1 live; it greets, then nobody speaks.
  const live1 = await until(async () => { const s = await status(); return s.state === "live" ? s : null; }, 25000);
  if (!check("session 1 live", !!live1)) return;
  liveSince = Date.now();
  const id1 = live1.live.session_id;
  const greeted = await until(() => readLog().find((e) => e.ev === "session.output_transcript.delta" && e.live_id === id1), 15000);
  check("session 1 greeted", !!greeted);

  // 3. New code lands in the copy: a daemon module and the page.
  const tEdit = Date.now();
  fs.appendFileSync(path.join(ROOT, "daemon", "format.js"), "\n// e2e: new daemon code\n");
  fs.appendFileSync(path.join(ROOT, "web", "app.js"), "\n// e2e: new page code\n");

  // 4. The daemon notices, waits for quiet, hands over.
  const detected = await until(() => readLog().find((e) => e.ev === "update.detected"), 5000);
  check("change detected", !!detected, detected ? `web_changed ${detected.web_changed}, ${detected.ms} ms` : "");
  const ho = await until(() => readLog().find((e) => e.ev === "update.handover"), 30000);
  if (!check("handed over to a new process", !!ho, ho ? `preflight ${ho.preflight_ms} ms, gap ${ho.gap_ms} ms, total ${ho.total_ms} ms, resumed from ${ho.resume}` : "")) return;
  timings.edit_to_handover_ms = ts(ho) - tEdit;
  timings.preflight_ms = ho.preflight_ms;
  timings.listen_gap_ms = ho.gap_ms;
  timings.handover_total_ms = ho.total_ms;
  const waited = readLog().filter((e) => e.ev === "update.waiting").map((e) => e.why);
  const lastOut = readLog().filter((e) => e.ev === "session.output_transcript.delta" && e.live_id === id1).at(-1);
  if (lastOut) timings.last_speech_to_handover_ms = ts(ho) - ts(lastOut);
  check("waited for a quiet moment", !lastOut || ts(ho) - ts(lastOut) >= QUIET_MS - 200, `waited for: ${[...new Set(waited)].join(", ") || "nothing"}`);
  const closed1 = readLog().find((e) => e.ev === "session.closed" && e.live_id === id1);
  billed[id1] = closed1?.seconds ?? null;
  // The page is told to disconnect first (it keeps its mic), so the server
  // often reports the WebRTC hang-up before our close; either way the usage is booked.
  check("session 1 closed and billed before the swap", ["close_requested", "remote_hangup"].includes(closed1?.reason) && ts(closed1) <= ts(ho) && closed1.seconds > 0, `${closed1?.reason}, ${closed1?.seconds} s billed`);

  const h2 = await until(async () => { const h = await healthz(); return h.pid !== pid1 ? h : null; }, 5000);
  check("new daemon on the same port", h2 && h2.port === PORT && h2.name === "sotto", h2 ? `pid ${pid1} → ${h2.pid}` : "");
  check("old daemon exited", !!(await until(() => !alive(pid1), 3000)));
  check("same daemon key and D/active (hooks keep working)", fs.readFileSync(path.join(D, "daemon.key"), "utf8").trim() === KEY && fs.readFileSync(path.join(D, "active"), "utf8") === active1);
  const restored = readLog().find((e) => e.ev === "update.restore");
  check("successor restored the conversation", restored?.resume === "live" && restored.history >= 1, `${restored?.history} lines`);

  // 5. The page reloads into the new page and reconnects; session 2 says so.
  const reload = await until(() => readLog().find((e) => e.ev === "page.log" && /new build after a daemon update/.test(e.message || "")), 10000);
  check("page reloaded into the new page", !!reload);
  const create2 = await until(() => readLog().find((e) => e.ev === "session.create" && e.reason === "reconnect" && ts(e) >= ts(ho)), 20000);
  check("session 2 created (reason reconnect)", create2?.ok === true, create2 ? `${create2.ms} ms` : "");
  const live2 = await until(async () => { const s = await status(); return s.state === "live" && s.live?.session_id !== id1 ? s : null; }, 20000);
  if (!check("session 2 live", !!live2)) return;
  const id2 = live2.live.session_id;
  timings.handover_to_live2_ms = Date.now() - ts(ho);
  const started2 = readLog().find((e) => e.ev === "session.started" && e.live_id === id2);
  if (started2) timings.handover_to_session2_started_ms = ts(started2) - ts(ho);
  const cue = readLog().find((e) => e.ev === "client.send" && e.live_id === id2 && e.type === "session.instructions.append" && /I just updated myself/.test(e.content || ""));
  check("session 2 was told to say it updated", !!cue);
  const acked = await until(() => readLog().find((e) => e.ev === "session.instructions.appended" && e.live_id === id2), 10000);
  check("the instruction was accepted (instructions.appended)", !!acked);
  const said = await until(() => {
    const t = readLog().filter((e) => e.ev === "session.output_transcript.delta" && e.live_id === id2).map((e) => e.delta).join("");
    return /updat/i.test(t) ? t : null;
  }, 20000);
  // Whether the model speaks an accepted instruction is its behaviour, not
  // ours: measured 4 of 5 runs within 3 s, the fifth said nothing at all.
  if (said) check("the voice says it updated itself", true, JSON.stringify(said.trim().slice(0, 100)));
  else warn("the voice says it updated itself", "the model stayed silent after accepting the instruction");
  const notice = readLog().filter((e) => e.ev === "page" && e.type === "hello" && ts(e) >= ts(ho));
  check("the new page said hello (toast delivered)", notice.length >= 1);

  // 6. The hooks reach the new daemon through the unchanged D/active.
  const before = readLog().filter((e) => e.ev === "hook").length;
  const hk = spawnSync(path.join(ROOT, "scripts", "hook.sh"), ["Notification"], {
    input: JSON.stringify({ session_id: "e2e-rs", hook_event_name: "Notification", notification_type: "idle_prompt", message: "waiting" }), encoding: "utf8", env: hookEnv(),
  });
  const hooked = await until(() => readLog().filter((e) => e.ev === "hook").length > before, 3000);
  check("hook.sh forwards to the new daemon", hk.status === 0 && !!hooked);

  // 7. Off.
  const off = toggle("off");
  check("toggle.sh off", off.status === 0 && /^sotto: voice OFF\./.test(off.out?.stopReason || ""), off.out?.stopReason);
  const closed2 = await until(() => readLog().find((e) => e.ev === "session.closed" && e.live_id === id2), 20000);
  billed[id2] = closed2?.seconds ?? null;
  check("session 2 closed", closed2?.reason === "close_requested", `${closed2?.seconds} s billed`);
  timings.live_wall_ms = Date.now() - liveSince;
  const raw = fs.readFileSync(path.join(D, "logs", "daemon.log"), "utf8");
  check("daemon log has no API key, inbox token or daemon key", !raw.includes(apiKey) && !raw.includes(INBOX_TOKEN) && !raw.includes(KEY));
  check("no handover file left on disk", !fs.readdirSync(D).some((f) => /handover/.test(f)));
  const h3 = h2 ? await until(() => !alive(h2.pid), 8000) : null;
  check("daemon 2 exited after off", !!h3);
}

async function cleanup() {
  try {
    const h = await healthz();
    if (h.name === "sotto" && h.state !== "off") {
      await fetch(`${BASE}/control`, { method: "POST", headers: hdr(), body: JSON.stringify({ action: "shutdown" }) }).catch(() => {});
      await sleep(3000);
    }
  } catch { /* daemon already gone */ }
  if (chrome) { try { chrome.kill("SIGTERM"); } catch { /* ignore */ } }
  const pid = daemonPid();
  if (pid && alive(pid)) { try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ } }
  await sleep(500);
  if (chrome) { try { chrome.kill("SIGKILL"); } catch { /* ignore */ } }
  if (pid && alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ } }
  if (inbox) await inbox.close().catch(() => {});
  try { fs.unlinkSync(SOCK); } catch { /* ignore */ }
  if (process.env.SOTTO_E2E_KEEP === "1") log(`kept ${TMP}`);
  else fs.rmSync(TMP, { recursive: true, force: true });
}

let budgetBlown = false;
const guard = setInterval(() => {
  if (!liveSince || budgetBlown || Date.now() - liveSince < LIVE_BUDGET_MS) return;
  budgetBlown = true;
  check("finished within the Live budget", false, `${LIVE_BUDGET_MS / 1000} s`);
  fetch(`${BASE}/control`, { method: "POST", headers: hdr(), body: JSON.stringify({ action: "shutdown" }) }).catch(() => {});
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
  for (const [k, v] of Object.entries(timings)) log(`${k.padEnd(40)} ${k.endsWith("_ms") ? secs(v) : v}`);
  log("----");
  log(`${failed.length ? "FAIL" : process.exitCode === 2 ? "SKIP" : "PASS"}: ${results.filter((r) => r.ok && !r.warn).length} passed, ${failed.length} failed, ${results.filter((r) => r.warn).length} warnings`);
  const total = Object.values(billed).reduce((s, v) => s + (Number(v) || 0), 0);
  log(`billed seconds: ${JSON.stringify(billed)} total ${total.toFixed(1)} s (~$${((total / 60) * 0.05).toFixed(3)})`);
  if (failed.length) process.exitCode = 1;
}
