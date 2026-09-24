#!/usr/bin/env node
// End-to-end: switching the persona mid-session (SPEC §4.6), against the
// REAL gpt-live-1. Silent: headless Chrome with --mute-audio and a fake mic.
//
// The fake mic asks the same question twice (a reaction to good news plus a
// request for Claude): once in the default persona, then, after
// `/talk persona tempo` switched the live session, once more. It checks that
// the switch re-created the session with the new persona and its voice, that
// the old session closed cleanly, that the new persona greeted, that its reply
// differs from the default persona's (loosely: not the same words), and that
// both requests still reached Claude (the relay rules survive the persona).
//
// Needs: OPENAI_API_KEY (env or <repo>/.env), Google Chrome, ffmpeg, say.
// Cost: two short Live sessions, about 50 billed seconds (~$0.05).
//
//   npm run e2e:persona
//   SOTTO_E2E_PERSONA_PORT=47897   daemon port
//   SOTTO_E2E_KEEP=1               keep the temp dir (logs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startFakeInbox } from "../helpers/fake-inbox.js";
import { CHROME, spawnSilentChrome } from "../helpers/silent-chrome.js";
import { resolveApiKey } from "../../daemon/config.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PORT = Number(process.env.SOTTO_E2E_PERSONA_PORT || 47897);
const BASE = `http://127.0.0.1:${PORT}`;
const SOCK = `/tmp/clv-e2e-persona-${process.pid}.sock`;
const INBOX_TOKEN = `e2e-persona-token-${process.pid}`;
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clv-e2e-persona-")));
const D = path.join(TMP, "data");
const LIVE_BUDGET_MS = 80_000;
// The same question twice: once in the default persona, once after the switch.
// It is small talk (a reaction) plus a request, so the reply shows personality
// and the request must still be delegated.
const QUESTION = "Great news, all the tests just passed! How do you feel about that? And please ask Claude what the current git branch is.";
const Q1_AT_MS = 8000; // after the greeting
const Q2_AT_MS = 38000; // after the switch and the new persona's hello
const PERSONA = "tempo";

const results = [];
const timings = {};
let inbox;
let chrome;
let liveId = null;
let billed = null;
let liveSince = 0;

const log = (...a) => console.log("[e2e-persona]", ...a);
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
    SOTTO_KEYCHAIN_SERVICE: `sotto-e2e-persona-${process.pid}`,
  });
}
function toggle(arg) {
  const input = JSON.stringify({
    session_id: "e2e-persona", transcript_path: "", cwd: REPO, prompt_id: "p", permission_mode: "default",
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

  // Mic: silence, the question at Q1_AT_MS, silence, the same question at Q2_AT_MS.
  const q = path.join(TMP, "q.aiff");
  const wav = path.join(TMP, "mic.wav");
  const say = spawnSync("say", ["-v", "Samantha", "-o", q, QUESTION], { encoding: "utf8" });
  const ff = say.status === 0 && spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-i", q, "-i", q, "-filter_complex",
    `[0]adelay=${Q1_AT_MS}:all=1[a];[1]adelay=${Q2_AT_MS}:all=1[b];[a][b]amix=inputs=2:duration=longest:normalize=0,apad=pad_dur=30`,
    "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", wav], { encoding: "utf8" });
  if (!check("fake-mic wav", ff && ff.status === 0 && fs.existsSync(wav), ((ff && ff.stderr) || say.stderr || "").slice(0, 200))) return;

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
  const created1 = readLog().find((e) => e.ev === "session.create" && e.ok);
  check("first session in the default persona", created1?.persona === "sotto", created1?.persona);

  // Wait for Q1 to be heard and answered (no output for 2.5 s after some output that follows it).
  const q1End = await until(() => {
    const ins = readLog().filter((e) => e.ev === "session.input_transcript.delta");
    const last = ins[ins.length - 1];
    return last && /branch|passed|feel/i.test(ins.map((e) => e.delta).join("")) && Date.now() - ts(last) > 2500 ? ts(last) : null;
  }, 30000);
  if (!check("question 1 heard", !!q1End)) return;
  await until(() => {
    const outs = readLog().filter((e) => e.ev === "session.output_transcript.delta" && e.live_id === liveId && ts(e) >= q1End - 1500);
    const last = outs[outs.length - 1];
    return last && Date.now() - ts(last) > 2500 ? true : null;
  }, 15000);
  const reply1 = readLog().filter((e) => e.ev === "session.output_transcript.delta" && e.live_id === liveId && ts(e) >= q1End - 1500).map((e) => e.delta).join("").trim();
  log(`default persona said: ${JSON.stringify(reply1.slice(0, 300))}`);
  check("default persona answered", reply1.length > 0);

  // Q1's request reaches Claude (delegated, or mirrored within ~6 s).
  const userFrames = () => inbox.frames.filter((f) => f.type === "user");
  await until(() => userFrames().length >= 1 || null, 10000);
  const before = userFrames().length;
  check("question 1 reached Claude (default persona)", before >= 1, `${before} frame(s)`);

  // Switch, as Claude would by voice (sotto persona tempo runs the same handler).
  const tSwitch = Date.now();
  const sw = toggle(`persona ${PERSONA}`);
  check("toggle.sh persona switches the live session", sw.status === 0 && sw.out?.stopReason === `sotto: persona set to ${PERSONA} with the tempo voice. The live session now runs as ${PERSONA}.`, sw.out?.stopReason);
  const created2 = await until(() => readLog().find((e) => e.ev === "session.create" && e.ok && ts(e) >= tSwitch - 50), 20000);
  check("a new session in the new persona and voice", created2?.persona === PERSONA && created2?.voice === "tempo" && created2?.reason === "reconnect", JSON.stringify(created2 && { persona: created2.persona, voice: created2.voice, reason: created2.reason }));
  const live2 = await until(async () => { const s = await status(); return s.state === "live" && s.live?.session_id !== liveId ? s : null; }, 20000);
  check("live again", !!live2);
  if (live2) timings.switch_ms = Date.now() - tSwitch;
  const oldClosed = await until(() => readLog().find((e) => e.ev === "session.closed" && e.live_id === liveId), 10000);
  check("old session closed cleanly", oldClosed?.reason === "close_requested", oldClosed?.reason);
  billed = oldClosed?.seconds ?? null;
  const live2Id = live2?.live?.session_id || created2?.live_id;
  const hello = await until(() => readLog().filter((e) => e.ev === "session.output_transcript.delta" && e.live_id === live2Id).map((e) => e.delta).join("").trim() || null, 12000);
  log(`${PERSONA} greeted: ${JSON.stringify((hello || "").slice(0, 200))}`);
  check("the new persona greeted", !!hello);
  const helloSent = readLog().find((e) => e.ev === "client.send" && e.type === "session.instructions.append" && ts(e) >= tSwitch && /tell the user you're now Tempo/.test(e.content || ""));
  check("persona switch greeting sent", !!helloSent);

  // Q2: the same question to the new persona.
  const q2End = await until(() => {
    const ins = readLog().filter((e) => e.ev === "session.input_transcript.delta" && e.live_id === live2Id);
    const last = ins[ins.length - 1];
    return last && /branch|passed|feel/i.test(ins.map((e) => e.delta).join("")) && Date.now() - ts(last) > 2500 ? ts(last) : null;
  }, 40000);
  if (!check("question 2 heard by the new session", !!q2End)) return;
  await until(() => {
    const outs = readLog().filter((e) => e.ev === "session.output_transcript.delta" && e.live_id === live2Id && ts(e) >= q2End - 1500);
    const last = outs[outs.length - 1];
    return last && Date.now() - ts(last) > 2500 ? true : null;
  }, 15000);
  const reply2 = readLog().filter((e) => e.ev === "session.output_transcript.delta" && e.live_id === live2Id && ts(e) >= q2End - 1500).map((e) => e.delta).join("").trim();
  log(`${PERSONA} said: ${JSON.stringify(reply2.slice(0, 300))}`);
  const norm = (t) => t.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
  check("the new persona answered, in different words", reply2.length > 0 && norm(reply2) !== norm(reply1));
  results.push({ name: "replies", ok: true, info: true, detail: `sotto: ${JSON.stringify(reply1.slice(0, 160))} | ${PERSONA}: ${JSON.stringify(reply2.slice(0, 160))}` });
  check("no false done claim about the branch", !/\b(you'?re on|the branch is|current branch is)\b/i.test(reply2), JSON.stringify(reply2.slice(0, 120)));

  // The relay rules survive the persona: Q2's request reached Claude too
  // (delegated, or mirrored; the transcript of the request varies, so no word match).
  await until(() => userFrames().length > before || null, 10000);
  for (const u of userFrames()) log(`inbox ${u.priority}: ${JSON.stringify(u.message.content.slice(0, 160))}`);
  const after = userFrames().slice(before);
  check("question 2 reached Claude (new persona)", after.length >= 1 && after.every((f) => /^\[sotto voice [0-9a-f]+\]/.test(f.message?.content || "")), `${after.length} frame(s)`);
  const dels = readLog().filter((e) => e.ev === "session.delegation.created" && e.live_id === live2Id);
  timings.delegations_after_switch = dels.length;

  const off = toggle("off");
  check("toggle.sh off", off.status === 0 && /^sotto: voice OFF\./.test(off.out?.stopReason || ""), off.out?.stopReason);
  const closed = await until(() => readLog().find((e) => e.ev === "session.closed" && e.live_id === live2Id), 20000);
  check("second session closed close_requested", closed?.reason === "close_requested", closed?.reason);
  if (closed?.seconds != null) billed = (billed || 0) + closed.seconds;
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
