#!/usr/bin/env node
// End-to-end: a mic check is answered by the voice itself and never reaches
// Claude (SPEC §8.1, §6.18), against the REAL gpt-live-1.
//
// Seen live 2026-09-24: "Hello? Hello? ... it's like barely working" was
// handed to Claude and the voice said "I'll have Claude check again" instead
// of "Yes, I can hear you." This plays a mic check (macOS say, fake mic) into
// a live session and checks that the voice answers within a few seconds and
// that nothing reaches the fake inbox: not delegated, not mirrored.
//
// Needs: OPENAI_API_KEY (env or <repo>/.env), Google Chrome, ffmpeg, say.
// Cost: one Live session, about 30 billed seconds (~$0.03).
//
//   npm run e2e:miccheck
//   SOTTO_E2E_MICCHECK_PORT=47896   daemon port
//   SOTTO_E2E_KEEP=1                keep the temp dir (logs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startFakeInbox } from "../helpers/fake-inbox.js";
import { CHROME, spawnSilentChrome } from "../helpers/silent-chrome.js";
import { resolveApiKey } from "../../daemon/config.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PORT = Number(process.env.SOTTO_E2E_MICCHECK_PORT || 47896);
const BASE = `http://127.0.0.1:${PORT}`;
const UTTERANCE = "Hello? Hello? Can you hear me? Wow, it's like barely working.";
const SOCK = `/tmp/clv-e2e-mic-${process.pid}.sock`;
const INBOX_TOKEN = `e2e-mic-token-${process.pid}`;
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clv-e2e-mic-")));
const D = path.join(TMP, "data");
const LIVE_BUDGET_MS = 60_000;
const LEAD_MS = 8000; // greeting
const ANSWER_MS = 8000; // the voice must start answering within this long of the last word
const QUIET_MS = 12000; // and nothing may reach Claude for this long (the mirror waits 6 s)

const results = [];
const timings = {};
let inbox;
let chrome;
let liveId = null;
let billed = null;
let liveSince = 0;

const log = (...a) => console.log("[e2e-miccheck]", ...a);
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
async function until(fn, ms, every = 200) {
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
const status = async () => (await fetch(`${BASE}/status`, { headers: hdr() })).json();

function hookEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^CLAUDE_/.test(k) && k !== "SOTTO_MIRROR") env[k] = v;
  return Object.assign(env, {
    CLAUDE_PLUGIN_ROOT: REPO, CLAUDE_PLUGIN_DATA: D, CLAUDE_PLUGIN_OPTION_PORT: String(PORT),
    CLAUDE_PLUGIN_OPTION_DAILY_CAP_MINUTES: "10", CLAUDE_PLUGIN_OPTION_IDLE_SECONDS: "0",
    CLAUDE_CODE_MESSAGING_SOCKET: SOCK, CLAUDE_CODE_MESSAGING_TOKEN: INBOX_TOKEN, CLAUDE_PROJECT_DIR: REPO,
    SOTTO_NO_BROWSER: "1",
    SOTTO_UPDATE: "0", // an edit to this checkout mid-run must not restart the test daemon
    // Never read the user's real Keychain item (the key comes from .env or the env).
    SOTTO_KEYCHAIN_SERVICE: `sotto-e2e-mic-${process.pid}`,
  });
}
function toggle(arg) {
  const input = JSON.stringify({
    session_id: "e2e-mic", transcript_path: "", cwd: REPO, prompt_id: "p", permission_mode: "default",
    hook_event_name: "UserPromptExpansion", expansion_type: "slash_command", command_name: "sotto:talk",
    command_args: arg, command_source: "plugin", prompt: `/sotto:talk ${arg}`.trim(),
  });
  const r = spawnSync(path.join(REPO, "scripts", "toggle.sh"), [], { input, encoding: "utf8", env: hookEnv(), timeout: 15000 });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* checked by caller */ }
  return { status: r.status, out };
}
const hook = (event, body) => spawnSync(path.join(REPO, "scripts", "hook.sh"), [event], { input: JSON.stringify(body), encoding: "utf8", env: hookEnv() });
function daemonPid() { try { return Number(fs.readFileSync(path.join(D, "daemon.pid"), "utf8").trim()) || null; } catch { return null; } }
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function main() {
  const missing = [];
  if (!fs.existsSync(CHROME)) missing.push("Google Chrome");
  if (spawnSync("which", ["ffmpeg"]).status !== 0) missing.push("ffmpeg");
  if (spawnSync("which", ["say"]).status !== 0) missing.push("say");
  if (!resolveApiKey({ env: process.env, pluginRoot: REPO })) missing.push("OPENAI_API_KEY");
  if (missing.length) { log(`SKIP: missing ${missing.join(", ")}`); process.exitCode = 2; return; }

  // Mic: lead-in (the greeting), the mic check, then silence.
  const wav = path.join(TMP, "mic.wav");
  const mk = spawnSync("bash", [path.join(REPO, "test", "e2e", "make-audio.sh"), wav, UTTERANCE, String(LEAD_MS)], { encoding: "utf8" });
  if (!check("fake-mic wav", mk.status === 0 && fs.existsSync(wav), (mk.stderr || "").slice(0, 200))) return;

  inbox = await startFakeInbox(SOCK, {});
  const on = toggle("on");
  if (!check("toggle.sh on", on.status === 0 && /^sotto: voice ON \(/.test(on.out?.stopReason || ""), on.out?.stopReason)) return;
  KEY = fs.readFileSync(path.join(D, "daemon.key"), "utf8").trim();
  const PAGE_SECRET = fs.readFileSync(path.join(D, "page.secret"), "utf8").trim();

  chrome = spawnSilentChrome({ wav, extra: [`--user-data-dir=${path.join(TMP, "chrome-e2e")}`, `${BASE}/?autostart=1#k=${PAGE_SECRET}`] });

  const live = await until(async () => { const s = await status(); return s.state === "live" ? s : null; }, 25000);
  if (!check("state live", !!live)) return;
  liveSince = Date.now();
  liveId = live.live.session_id;

  const heard = await until(() => {
    const t = readLog().filter((e) => e.ev === "session.input_transcript.delta").map((e) => e.delta).join("");
    return /hear|working|hello/i.test(t) ? true : null;
  }, LEAD_MS + 20000);
  check("mic check transcribed", !!heard);
  // Wait for the end of the utterance (no input delta for 2.5 s), then the answer window.
  const lastWord = await until(() => {
    const ins = readLog().filter((e) => e.ev === "session.input_transcript.delta");
    const last = ins[ins.length - 1];
    return last && Date.now() - ts(last) > 2500 ? ts(last) : null;
  }, 20000);
  await until(() => Date.now() - (lastWord || Date.now()) > QUIET_MS, QUIET_MS + 1000, 250);

  const L = readLog();
  const heardText = L.filter((e) => e.ev === "session.input_transcript.delta").map((e) => e.delta).join("");
  log(`heard: ${JSON.stringify(heardText.trim().slice(0, 200))}`);
  const after = L.filter((e) => e.ev === "session.output_transcript.delta" && lastWord && ts(e) >= lastWord - 1500);
  const answer = after.map((e) => e.delta).join("");
  log(`voice said after the mic check: ${JSON.stringify(answer.trim().slice(0, 300))}`);
  const firstOut = after[0];
  check(`the voice answered within ${ANSWER_MS / 1000} s`, !!firstOut && ts(firstOut) - lastWord <= ANSWER_MS, firstOut ? secs(ts(firstOut) - lastWord) : "no answer");
  if (firstOut) timings.answer_ms = ts(firstOut) - lastWord;
  check("the answer says it can hear the user", /\b(hear|here|yes|loud and clear|working)\b/i.test(answer), JSON.stringify(answer.slice(0, 120)));
  check("the voice does not defer to Claude", !/\b(claude|check with|pass (that|it) (on|to))\b/i.test(answer), JSON.stringify(answer.slice(0, 120)));
  const delegations = L.filter((e) => e.ev === "session.delegation.created" && lastWord && ts(e) >= lastWord - 5000);
  check("not delegated", delegations.length === 0, `${delegations.length} delegation(s)`);
  const users = inbox.frames.filter((f) => f.type === "user");
  for (const u of users) log(`inbox ${u.priority}: ${JSON.stringify(u.message.content.slice(0, 160))}`);
  check("nothing reached Claude (neither delegated nor mirrored)", users.length === 0, `${users.length} frame(s)`);
  const s9 = await status();
  timings.mirror_sent = s9.counters.mirror_sent;
  timings.inbox_sent = s9.counters.inbox_sent;

  const off = toggle("off");
  check("toggle.sh off", off.status === 0 && /^sotto: voice OFF\./.test(off.out?.stopReason || ""), off.out?.stopReason);
  const closed = await until(() => readLog().find((e) => e.ev === "session.closed" && e.live_id === liveId), 20000);
  check("session.closed close_requested", closed?.reason === "close_requested", closed?.reason);
  billed = closed?.seconds ?? null;
  timings.live_wall_ms = Date.now() - liveSince;
  const raw = fs.readFileSync(path.join(D, "logs", "daemon.log"), "utf8");
  const apiKey = resolveApiKey({ env: process.env, pluginRoot: REPO });
  check("daemon log has no API key, inbox token or daemon key", !raw.includes(apiKey) && !raw.includes(INBOX_TOKEN) && !raw.includes(KEY));
}

async function cleanup() {
  try {
    const h = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(500) }).then((r) => r.json());
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
  log("---- timings and counts");
  for (const [k, v] of Object.entries(timings)) log(`${k.padEnd(28)} ${k.endsWith("_ms") ? secs(v) : v}`);
  for (const r of results.filter((x) => x.info)) log(`${r.name}: ${r.detail}`);
  log("----");
  log(`${failed.length ? "FAIL" : process.exitCode === 2 ? "SKIP" : "PASS"}: ${results.filter((r) => r.ok && !r.warn && !r.info).length} passed, ${failed.length} failed, ${results.filter((r) => r.warn).length} warnings`);
  log(`live session: ${liveId || "none"}  billed seconds: ${billed ?? "unknown"}`);
  if (failed.length) process.exitCode = 1;
}
