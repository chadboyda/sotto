#!/usr/bin/env node
// End-to-end: decisions and casual requests reach Claude (SPEC §6.17, §8.1),
// against the REAL gpt-live-1.
//
// In a real session gpt-live-1 answered "Sotto is a clever name" and "let me
// know when you auto restart" itself and never told Claude. This plays both
// (TTS, fake mic) into a live session and checks that each reaches the fake
// inbox within 12 s of the user's last word, either delegated by the model
// ("next") or by the daemon's transcript mirror ("later"), exactly once. It
// also runs a mirror turn through the real hook.sh (voice context) and a
// "Noted." Stop (silent), and reports how the model handled each utterance.
//
// Needs: OPENAI_API_KEY (env or <repo>/.env), Google Chrome, ffmpeg.
// Cost: one Live session, about 45 billed seconds (~$0.04).
//
//   npm run e2e:decisions
//   SOTTO_E2E_DECISIONS_PORT=47895   daemon port
//   SOTTO_E2E_KEEP=1                 keep the temp dir (logs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startFakeInbox } from "../helpers/fake-inbox.js";
import { CHROME, spawnSilentChrome } from "../helpers/silent-chrome.js";
import { resolveApiKey } from "../../daemon/config.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PORT = Number(process.env.SOTTO_E2E_DECISIONS_PORT || 47895);
const BASE = `http://127.0.0.1:${PORT}`;
const U1 = path.join(REPO, "test", "fixtures", "decide-name.wav"); // "Sotto is a clever name. I think we should go with that one."
const U2 = path.join(REPO, "test", "fixtures", "ask-later.wav"); // "Oh, and let me know when the auto restart is ready."
const SOCK = `/tmp/clv-e2e-dec-${process.pid}.sock`;
const INBOX_TOKEN = `e2e-dec-token-${process.pid}`;
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clv-e2e-dec-")));
const D = path.join(TMP, "data");
const LIVE_BUDGET_MS = 80_000;
const LEAD_MS = 8000; // greeting
const GAP_MS = 13000; // between the two utterances: longer than the 6 s mirror delay
const REACH_MS = 12000; // each utterance must reach Claude within this long of its last word

const results = [];
const timings = {};
let inbox;
let chrome;
let liveId = null;
let billed = null;
let liveSince = 0;

const log = (...a) => console.log("[e2e-decisions]", ...a);
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
    // Never read the user's real Keychain item (the key comes from .env or the env).
    SOTTO_KEYCHAIN_SERVICE: `sotto-e2e-dec-${process.pid}`,
  });
}
function toggle(arg) {
  const input = JSON.stringify({
    session_id: "e2e-dec", transcript_path: "", cwd: REPO, prompt_id: "p", permission_mode: "default",
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
  if (!resolveApiKey({ env: process.env, pluginRoot: REPO })) missing.push("OPENAI_API_KEY");
  if (!fs.existsSync(U1) || !fs.existsSync(U2)) missing.push("fixtures (npm run e2e:fixture)");
  if (missing.length) { log(`SKIP: missing ${missing.join(", ")}`); process.exitCode = 2; return; }

  // Mic: lead-in, utterance 1, gap, utterance 2, tail.
  const wav = path.join(TMP, "mic.wav");
  const ff = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-i", U1, "-i", U2, "-filter_complex",
    `[0]aresample=48000,aformat=channel_layouts=mono,adelay=${LEAD_MS}:all=1,apad=pad_dur=${GAP_MS / 1000}[a];` +
    "[1]aresample=48000,aformat=channel_layouts=mono,apad=pad_dur=40[b];[a][b]concat=n=2:v=0:a=1",
    "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
  if (!check("fake-mic wav", ff.status === 0 && fs.existsSync(wav), ff.stderr?.toString().slice(0, 200))) return;

  const frameAt = [];
  // Play Claude: each delivered message fires UserPromptSubmit (delivery) and,
  // a moment later, Stop with a short reply, through the real hook.sh.
  let turn = 0;
  let chain = Promise.resolve();
  const claudeTurn = (frame) => {
    const pid = `e2e-t${++turn}`;
    const content = frame.message.content;
    const mirror = content.includes("(said to the voice assistant, not delegated)");
    chain = chain.then(async () => {
      hook("UserPromptSubmit", { session_id: "e2e-dec", prompt_id: pid, hook_event_name: "UserPromptSubmit", prompt: content });
      await sleep(800);
      hook("Stop", { session_id: "e2e-dec", prompt_id: pid, hook_event_name: "Stop", stop_hook_active: false,
        last_assistant_message: mirror ? "Noted." : "Got it.", background_tasks: [], session_crons: [] });
    });
  };
  inbox = await startFakeInbox(SOCK, { onFrame: (f) => { frameAt.push(Date.now()); if (f.type === "user") claudeTurn(f); } });
  const on = toggle("on");
  if (!check("toggle.sh on", on.status === 0 && /^sotto: voice ON \(/.test(on.out?.stopReason || ""), on.out?.stopReason)) return;
  KEY = fs.readFileSync(path.join(D, "daemon.key"), "utf8").trim();
  const PAGE_SECRET = fs.readFileSync(path.join(D, "page.secret"), "utf8").trim();
  const NONCE = fs.readFileSync(path.join(D, "active"), "utf8").trim().split("\t")[3] || "";
  const MARK = `[sotto voice ${NONCE}]`;
  const s0 = await status();
  check("mirror mode defaults to all", s0.config?.mirror === "all", s0.config?.mirror);

  chrome = spawnSilentChrome({ wav, extra: [`--user-data-dir=${path.join(TMP, "chrome-e2e")}`, `${BASE}/?autostart=1#k=${PAGE_SECRET}`] });

  const live = await until(async () => { const s = await status(); return s.state === "live" ? s : null; }, 25000);
  if (!check("state live", !!live)) return;
  liveSince = Date.now();
  liveId = live.live.session_id;

  // Wait for both utterances to be heard and for the reach window after the second.
  const heard2 = await until(() => {
    const t = readLog().filter((e) => e.ev === "session.input_transcript.delta").map((e) => e.delta).join("");
    return /restart/i.test(t) ? true : null;
  }, LEAD_MS + GAP_MS + 25000);
  check("both utterances transcribed", !!heard2);
  await sleep(REACH_MS + 1000);

  const L = readLog();
  const inputs = L.filter((e) => e.ev === "session.input_transcript.delta");
  const heardText = inputs.map((e) => e.delta).join("");
  log(`heard: ${JSON.stringify(heardText.trim().slice(0, 200))}`);
  const users = inbox.frames.map((f, i) => ({ f, at: frameAt[i] })).filter((x) => x.f.type === "user");
  for (const u of users) log(`inbox ${u.f.priority}: ${JSON.stringify(u.f.message.content.slice(0, 160))}`);
  const lastInputBefore = (re) => {
    // The last input delta of the utterance: the latest delta up to the first one after a >3 s gap past a match.
    const i = inputs.findIndex((e) => re.test(e.delta));
    if (i < 0) return null;
    let j = i;
    while (j + 1 < inputs.length && ts(inputs[j + 1]) - ts(inputs[j]) < 3000) j++;
    return inputs[j];
  };
  const utterances = [
    { name: "decision (project name)", re: /clever|s[oa]t+o\b|sato|soto/i, first: /clever|name/i },
    { name: "casual request (tell me when)", re: /restart/i, first: /restart/i },
  ];
  for (const u of utterances) {
    const end = lastInputBefore(u.first);
    const words = (x) => x.f.message.content.replace(MARK, "").replace("(said to the voice assistant, not delegated)", "").split("\n")[0];
    const hits = users.filter((x) => u.re.test(words(x)) && !/^\s*Please act on and answer/.test(words(x)));
    const first = hits[0];
    const reached = first && end && first.at - ts(end) <= REACH_MS;
    const via = first ? (first.f.priority === "later" ? "mirror" : "delegated by the model") : "none";
    check(`${u.name} reached Claude within ${REACH_MS / 1000} s`, reached, first && end ? `${via}, ${secs(first.at - ts(end))} after the last word` : `via ${via}`);
    if (first && end) timings[`${u.name.split(" ")[0]}_reach_ms`] = first.at - ts(end);
    check(`${u.name} sent once`, hits.length === 1, `${hits.length} frames`);
    if (first) {
      const ok = first.f.priority === "later"
        ? first.f.message.content.startsWith(`${MARK} (said to the voice assistant, not delegated) `) && /^clv-mirror-/.test(first.f.msg_id)
        : first.f.message.content.startsWith(`${MARK} `) && first.f.priority === "next";
      check(`${u.name}: marker, tag and priority`, ok, `${first.f.priority} ${first.f.msg_id}`);
    }
    results.push({ name: `model delegated: ${u.name}`, ok: true, info: true, detail: via });
  }
  // False promises: the model saying it recorded or will report something itself.
  const outText = L.filter((e) => e.ev === "session.output_transcript.delta").map((e) => e.delta).join("");
  log(`voice said: ${JSON.stringify(outText.trim().slice(0, 400))}`);
  const promise = /\bI(?:'|’)?(?:ll| will| have|'ve|’ve) (?:mark|note|noted|record|recorded|remember|save|saved|schedule|let you know when|tell you when)\b/i.exec(outText);
  if (promise) warn("no self-made promises in the voice's replies", JSON.stringify(promise[0]));
  else check("no self-made promises in the voice's replies", true);

  // A mirror turn through the real hook.sh: voice framing for the tag; "Noted." is silent.
  const mirrorPrompt = `${MARK} (said to the voice assistant, not delegated) I like the blue one`;
  await chain;
  const ups = hook("UserPromptSubmit", { session_id: "e2e-dec", prompt_id: "e2e-mirror", hook_event_name: "UserPromptSubmit", prompt: mirrorPrompt });
  let upsOut = null;
  try { upsOut = JSON.parse(ups.stdout); } catch { /* checked */ }
  const ctx = upsOut?.hookSpecificOutput?.additionalContext || "";
  check("hook.sh: a mirror gets the voice context that explains the tag", ctx.includes(MARK) && ctx.includes("(said to the voice assistant, not delegated)") && ctx.includes("reply with only the word Noted"));
  const tStop = Date.now();
  hook("Stop", { session_id: "e2e-dec", prompt_id: "e2e-mirror", hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Noted.", background_tasks: [], session_crons: [] });
  // (An identical note from a mirror turn in the last 30 s is deduplicated, so any one counts.)
  const silent = await until(() => readLog().find((e) => e.ev === "client.send" && e.type === "session.thinking.append" && ts(e) >= tStop - 30000 && /had nothing to add/.test(e.content || "")), 6000);
  check("mirror turn 'Noted.' → silent note, nothing spoken", !!silent && !readLog().some((e) => e.ev === "client.send" && e.type === "session.commentary.append" && ts(e) >= tStop - 50 && /Noted/.test(e.content || "")));
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
