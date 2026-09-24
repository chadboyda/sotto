#!/usr/bin/env node
// End-to-end idle sleep + local voice wake against the REAL gpt-live-1 (SPEC §6.15, §7.6).
//
//   fake mic = [silence][TTS "Hey, can you ask Claude what files are in this project?"][silence]
//   /talk on (idle_seconds=3) → session 1 live → nobody talks → sleeps after the
//   prepaid 15 s → the page listens locally → the speech wakes session 2 → the
//   opening words (spoken before session 2 existed) are transcribed and handed
//   to the model → it delegates → the fake inbox gets the request.
//
// Measures wake latency (speech onset → session live → model speaking) from the
// page's `wake.timing` report and the daemon log. Cost: two short sessions,
// typically 30-40 billed seconds (~$0.03). Never prints the key or any token.
//
//   npm run e2e:wake
//   SOTTO_E2E_WAKE_PORT=47898   daemon port
//   SOTTO_E2E_WAKE_LEAD_MS=26000 silence before the speech in the fake mic
//   SOTTO_E2E_KEEP=1            keep the temp dir (logs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startFakeInbox } from "../helpers/fake-inbox.js";
import { CHROME, spawnSilentChrome } from "../helpers/silent-chrome.js";
import { resolveApiKey } from "../../daemon/config.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PORT = Number(process.env.SOTTO_E2E_WAKE_PORT || 47898);
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE = path.join(REPO, "test", "fixtures", "ask-files.wav");
const SOCK = `/tmp/clv-e2e-wake-${process.pid}.sock`;
const INBOX_TOKEN = `e2e-wake-token-${process.pid}`;
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clv-e2e-wake-")));
const D = path.join(TMP, "data");
const LIVE_BUDGET_MS = 90_000; // hard cap on wall time from the first live session
const LEAD_MS = Number(process.env.SOTTO_E2E_WAKE_LEAD_MS || 26000);

const results = [];
const timings = {};
let inbox;
let chrome;
let liveSince = 0;
const billed = {};

const log = (...a) => console.log("[e2e-wake]", ...a);
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
  for (const [k, v] of Object.entries(process.env)) if (!/^CLAUDE_/.test(k)) env[k] = v;
  return Object.assign(env, {
    CLAUDE_PLUGIN_ROOT: REPO,
    CLAUDE_PLUGIN_DATA: D,
    CLAUDE_PLUGIN_OPTION_PORT: String(PORT),
    CLAUDE_PLUGIN_OPTION_DAILY_CAP_MINUTES: "10",
    // Tiny idle timeout: the session sleeps as soon as the prepaid 15 s are used.
    CLAUDE_PLUGIN_OPTION_IDLE_SECONDS: "3",
    CLAUDE_PLUGIN_OPTION_WAKE_SENSITIVITY: "medium",
    CLAUDE_CODE_MESSAGING_SOCKET: SOCK,
    CLAUDE_CODE_MESSAGING_TOKEN: INBOX_TOKEN,
    CLAUDE_PROJECT_DIR: REPO,
    SOTTO_NO_BROWSER: "1",
    SOTTO_KEYCHAIN_SERVICE: `sotto-e2e-wake-${process.pid}`, // never the user's real Keychain item
    SOTTO_UPDATE: "0", // an edit to this checkout mid-run must not restart the test daemon
  });
}

function toggle(arg) {
  const input = JSON.stringify({
    session_id: "e2e-wake", transcript_path: "", cwd: REPO, prompt_id: "p", permission_mode: "default",
    hook_event_name: "UserPromptExpansion", expansion_type: "slash_command", command_name: "sotto:talk",
    command_args: arg, command_source: "plugin", prompt: `/sotto:talk ${arg}`.trim(),
  });
  const r = spawnSync(path.join(REPO, "scripts", "toggle.sh"), [], { input, encoding: "utf8", env: hookEnv(), timeout: 15000 });
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
  if (!resolveApiKey({ env: process.env, pluginRoot: REPO })) missing.push("OPENAI_API_KEY");
  if (missing.length) { log(`SKIP: missing ${missing.join(", ")}`); process.exitCode = 2; return; }
  if (!fs.existsSync(FIXTURE)) {
    const mk = spawnSync(process.execPath, [path.join(REPO, "test/e2e/make-fixture.mjs")], { stdio: "inherit" });
    if (!check("generate TTS fixture", mk.status === 0)) return;
  }

  // 1. Fake mic: long silence (session 1 sleeps in it), then the question.
  const wav = path.join(TMP, "mic.wav");
  const ff = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-i", FIXTURE, "-af", `adelay=${LEAD_MS}:all=1,apad=pad_dur=40`,
    "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
  if (!check("fake-mic wav (silence, then speech)", ff.status === 0 && fs.existsSync(wav), `speech at ${LEAD_MS / 1000} s`)) return;

  inbox = await startFakeInbox(SOCK, {});
  const on = toggle("on");
  check("toggle.sh on", on.status === 0 && /^sotto: voice ON \(/.test(on.out?.stopReason || ""), on.out?.stopReason);
  const pid = daemonPid();
  if (!check("daemon running", pid && alive(pid))) return;
  KEY = fs.readFileSync(path.join(D, "daemon.key"), "utf8").trim();
  const s0 = await status();
  check("config: idle_seconds 3, wake medium", s0.config.idle_seconds === 3 && s0.config.wake_sensitivity === "medium", JSON.stringify(s0.config));
  const PAGE_SECRET = fs.readFileSync(path.join(D, "page.secret"), "utf8").trim();

  chrome = spawnSilentChrome({ wav, extra: [
    `--user-data-dir=${path.join(TMP, "chrome-e2e")}`,
    `${BASE}/?autostart=1#k=${PAGE_SECRET}`,
  ] });
  const tMic = Date.now(); // ~ when the fake file starts playing (the page opens the mic at once)

  // 2. Session 1 goes live, then sleeps (nobody talks).
  const live1 = await until(async () => { const s = await status(); return s.state === "live" ? s : null; }, 25000);
  if (!check("session 1 live", !!live1)) return;
  liveSince = Date.now();
  const id1 = live1.live.session_id;
  const slept = await until(async () => { const s = await status(); return s.state === "sleeping" ? s : null; }, 30000);
  if (!check("session 1 went to sleep (state sleeping)", !!slept, slept ? "" : `state ${(await status()).state}`)) return;
  timings.live1_to_sleep_ms = Date.now() - liveSince;
  const closed1 = readLog().find((e) => e.ev === "session.closed" && e.live_id === id1);
  billed[id1] = closed1?.seconds ?? null;
  check("session 1 closed with close_requested", closed1?.reason === "close_requested", `${closed1?.seconds} s billed`);
  const idle = readLog().find((e) => e.ev === "idle.close");
  check("idle close chose sleep", idle?.sleep === true, JSON.stringify({ sleep: idle?.sleep, detail: idle?.detail }));
  const listening = await until(() => readLog().find((e) => e.ev === "page.log" && /wake: listening/.test(e.message || "")), 8000);
  check("page listens locally while sleeping", !!listening, listening?.message);
  if (Date.now() - tMic > LEAD_MS - 1500) warn("slept close to the speech", `${secs(Date.now() - tMic)} after the mic opened`);

  // 3. The speech wakes session 2.
  const wakeSession = await until(() => readLog().find((e) => e.ev === "wake.session"), LEAD_MS + 15000 - (Date.now() - tMic));
  if (!check("local VAD woke a session (reason wake)", !!wakeSession, wakeSession ? `snr ${wakeSession.snr_db} dB, voiced ${wakeSession.voiced_ms} ms` : "")) return;
  timings.mic_open_to_wake_post_ms = ts(wakeSession) - tMic;
  const created2 = await until(() => readLog().find((e) => e.ev === "session.create" && e.reason === "wake"), 10000);
  check("session 2 created (reason wake)", created2?.ok === true, `${created2?.ms} ms`);
  const live2 = await until(async () => { const s = await status(); return s.state === "live" && s.live?.session_id !== id1 ? s : null; }, 15000);
  if (!check("session 2 live", !!live2)) return;
  const id2 = live2.live.session_id;
  const started2 = readLog().find((e) => e.ev === "session.started" && e.live_id === id2);

  // 4. The opening words: transcribed from the page's clip and injected.
  const tr = await until(() => readLog().find((e) => e.ev === "wake.transcribe"), 15000);
  const clipText = (tr?.text || "").trim();
  check("wake clip transcribed", tr?.ok === true && clipText.length > 0, tr ? `${tr.model} ${tr.ms} ms, clip ${tr.clip_ms} ms: ${JSON.stringify(clipText)}` : "none");
  const inj = await until(() => readLog().find((e) => e.ev === "wake.inject"), 5000);
  check("opening words injected into session 2", inj?.via === "clip" && inj.chars > 0, JSON.stringify(inj && { via: inj.via, chars: inj.chars }));
  const sentIns = readLog().find((e) => e.ev === "client.send" && e.live_id === id2 && e.type === "session.instructions.append" && /What they said/.test(e.content || ""));
  check("instructions.append carries the words", !!sentIns);

  // 5. The model acts on them: delegation → inbox.
  const deleg = await until(() => readLog().find((e) => e.ev === "session.delegation.created" && e.live_id === id2), 25000);
  check("session 2 delegated to Claude", !!deleg);
  const frame = await until(() => inbox.frames.find((f) => f.type === "user"), 10000);
  const content = frame?.message?.content || "";
  const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  check("inbox got the request (\"files\")", /files/i.test(content), JSON.stringify(content.slice(0, 140)));
  check("the request starts with the words from the wake clip", clipText && norm(content).includes(norm(clipText)), JSON.stringify(clipText));
  const heardLive = readLog().filter((e) => e.ev === "session.input_transcript.delta" && e.live_id === id2).map((e) => e.delta).join("").trim();
  log(`session 2 heard live: ${JSON.stringify(heardLive.slice(0, 140))}`);
  const first = norm(clipText).split(" ")[0] || "";
  if (first && !norm(heardLive).split(" ").includes(first)) check("opening words reached the model only via the clip", true, `"${first}" was never heard live`);
  else warn("opening words", "the live audio also carried them (the wake was fast) or the model rephrased");
  check("the clip kept the first word (\"hey\")", /\bhey\b/i.test(clipText), JSON.stringify(clipText));

  // 6. Latency report from the page (first model output).
  const wt = await until(() => readLog().find((e) => e.ev === "wake.timing"), 22000);
  check("page reported wake timing", !!wt);
  if (wt) for (const [k, v] of Object.entries(wt)) if (k.endsWith("_ms")) timings[`wake_${k}`] = v;
  if (created2 && wakeSession) timings.wake_post_to_session_created_ms = ts(created2) - ts(wakeSession);
  if (started2 && created2) timings.session_created_to_started_ms = ts(started2) - ts(created2);
  if (inj && started2) timings.started_to_words_injected_ms = ts(inj) - ts(started2);
  const out2 = readLog().find((e) => e.ev === "session.output_transcript.delta" && e.live_id === id2);
  if (out2 && inj) timings.injected_to_first_output_ms = ts(out2) - ts(inj);

  // 7. Off.
  const off = toggle("off");
  check("toggle.sh off", off.status === 0 && /^sotto: voice OFF\./.test(off.out?.stopReason || ""), off.out?.stopReason);
  const closed2 = await until(() => readLog().find((e) => e.ev === "session.closed" && e.live_id === id2), 20000);
  billed[id2] = closed2?.seconds ?? null;
  check("session 2 closed", closed2?.reason === "close_requested", `${closed2?.seconds} s billed`);
  timings.live_wall_ms = Date.now() - liveSince;
  const st = readLog().filter((e) => e.ev === "session.create");
  check("exactly two sessions (no thrash)", st.length === 2, `${st.length} creates`);
  const raw = fs.readFileSync(path.join(D, "logs", "daemon.log"), "utf8");
  const apiKey = resolveApiKey({ env: process.env, pluginRoot: REPO });
  check("daemon log has no API key, inbox token or daemon key", !raw.includes(apiKey) && !raw.includes(INBOX_TOKEN) && !raw.includes(KEY));
  await until(() => !alive(pid), 8000);
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
  log("---- timings");
  for (const [k, v] of Object.entries(timings)) log(`${k.padEnd(40)} ${k.endsWith("_ms") ? secs(v) : v}`);
  log("----");
  log(`${failed.length ? "FAIL" : process.exitCode === 2 ? "SKIP" : "PASS"}: ${results.filter((r) => r.ok && !r.warn).length} passed, ${failed.length} failed, ${results.filter((r) => r.warn).length} warnings`);
  const total = Object.values(billed).reduce((s, v) => s + (Number(v) || 0), 0);
  log(`billed seconds: ${JSON.stringify(billed)} total ${total.toFixed(1)} s (~$${((total / 60) * 0.05).toFixed(3)})`);
  if (failed.length) process.exitCode = 1;
}
