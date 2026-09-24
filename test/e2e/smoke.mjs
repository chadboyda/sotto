#!/usr/bin/env node
// End-to-end smoke test against the REAL gpt-live-1 (SPEC §11.4, extended).
//
// Drives the whole product the way Claude Code would, minus Claude itself:
//   scripts/toggle.sh on  (real UserPromptExpansion handler; spawns the daemon detached)
//   headless Chrome at the real page, fake mic = OpenAI-TTS speech fixture
//   gpt-live-1 hears the request and delegates → daemon writes to a FAKE inbox socket
//   scripts/hook.sh Stop  (real forwarder) carries Claude's "answer" back
//   the model speaks it (commentary.append acked, output transcript arrives)
//   scripts/toggle.sh voice cedar → the session is re-created in the new voice
//   scripts/toggle.sh off → session.closed(close_requested), daemon exits
//
// Needs: OPENAI_API_KEY (env or <repo>/.env), Google Chrome, ffmpeg.
// Cost: one Live session, typically 25-45 billed seconds (~$0.02-0.04).
// Never prints the API key or any token.
//
//   npm run e2e                   (alias: npm run test:e2e)
//   SOTTO_E2E_PORT=47899    daemon port
//   SOTTO_E2E_LEAD_MS=8000  silence before the question in the fake mic
//   SOTTO_E2E_KEEP=1        keep the temp dir (logs) for inspection
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startFakeInbox } from "../helpers/fake-inbox.js";
import { CHROME, spawnSilentChrome } from "../helpers/silent-chrome.js";
import { resolveApiKey } from "../../daemon/config.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PORT = Number(process.env.SOTTO_E2E_PORT || 47899);
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE = path.join(REPO, "test", "fixtures", "ask-files.wav");
const SOCK = `/tmp/clv-e2e-${process.pid}.sock`;
const INBOX_TOKEN = `e2e-token-${process.pid}`;
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clv-e2e-")));
const D = path.join(TMP, "data");
const LIVE_BUDGET_MS = 90_000; // hard cap on Live-session wall time

const results = [];
const timings = {};
let inbox;
let chrome;
let liveId = null;
let billed = null;
let firstBilled = null; // the session replaced by the voice switch
let liveSince = 0;

const log = (...a) => console.log("[e2e]", ...a);
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

/** Hermetic env for the plugin scripts: what Claude Code would give a hook. */
function hookEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^CLAUDE_/.test(k)) env[k] = v;
  return Object.assign(env, {
    CLAUDE_PLUGIN_ROOT: REPO,
    CLAUDE_PLUGIN_DATA: D,
    CLAUDE_PLUGIN_OPTION_PORT: String(PORT),
    CLAUDE_PLUGIN_OPTION_DAILY_CAP_MINUTES: "10",
    CLAUDE_CODE_MESSAGING_SOCKET: SOCK,
    CLAUDE_CODE_MESSAGING_TOKEN: INBOX_TOKEN,
    CLAUDE_PROJECT_DIR: REPO,
    SOTTO_NO_BROWSER: "1", // the test drives its own headless Chrome
  });
}

/** Run scripts/toggle.sh like the UserPromptExpansion hook does. */
function toggle(arg) {
  const input = JSON.stringify({
    session_id: "e2e", transcript_path: "", cwd: REPO, prompt_id: "p", permission_mode: "default",
    hook_event_name: "UserPromptExpansion", expansion_type: "slash_command", command_name: "sotto:talk",
    command_args: arg, command_source: "plugin", prompt: `/sotto:talk ${arg}`.trim(),
  });
  const t0 = Date.now();
  const r = spawnSync(path.join(REPO, "scripts", "toggle.sh"), [], { input, encoding: "utf8", env: hookEnv(), timeout: 15000 });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* checked by caller */ }
  return { status: r.status, stdout: r.stdout, out, ms: Date.now() - t0 };
}

function preflight() {
  const missing = [];
  if (!fs.existsSync(CHROME)) missing.push("Google Chrome");
  if (spawnSync("which", ["ffmpeg"]).status !== 0) missing.push("ffmpeg");
  if (!resolveApiKey({ env: process.env, pluginRoot: REPO })) missing.push("OPENAI_API_KEY");
  return missing;
}

function daemonPid() {
  try { return Number(fs.readFileSync(path.join(D, "daemon.pid"), "utf8").trim()) || null; } catch { return null; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function main() {
  const missing = preflight();
  if (missing.length) { log(`SKIP: missing ${missing.join(", ")}`); process.exitCode = 2; return; }

  // 1. Fake-mic audio: TTS fixture (regenerated if absent) + lead-in + tail pad.
  if (!fs.existsSync(FIXTURE)) {
    const mk = spawnSync(process.execPath, [path.join(REPO, "test/e2e/make-fixture.mjs")], { stdio: "inherit" });
    if (!check("generate TTS fixture", mk.status === 0)) return;
  }
  const lead = Number(process.env.SOTTO_E2E_LEAD_MS || 8000);
  const wav = path.join(TMP, "mic.wav");
  // The file starts playing when the page opens the mic, ~1 s before the session
  // is live, and the model greets for ~3 s; the lead-in keeps the question clear of it.
  const ff = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-i", FIXTURE, "-af", `adelay=${lead}:all=1,apad=pad_dur=45`,
    "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
  if (!check("fake-mic wav", ff.status === 0 && fs.existsSync(wav))) return;

  // 2. Fake inbox (records frames + arrival time, never replies).
  const frameAt = [];
  inbox = await startFakeInbox(SOCK, { onFrame: () => frameAt.push(Date.now()) });

  // 3. /talk on through the real toggle.sh (cold start: spawns the daemon detached).
  const on = toggle("on");
  check("toggle.sh on: one JSON line, continue:false", on.status === 0 && on.out?.continue === false && on.stdout.trim().split("\n").length === 1, on.out?.stopReason);
  check("toggle.sh on: voice ON message", /^sotto: voice ON \(/.test(on.out?.stopReason || ""), `${on.ms} ms`);
  timings.toggle_on_cold_ms = on.ms;
  const pid = daemonPid();
  if (!check("daemon running (pid file)", pid && alive(pid), `pid ${pid}`)) return;
  const ppid = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  check("daemon detached from toggle.sh", ppid !== String(process.pid), `ppid ${ppid}`);
  KEY = fs.readFileSync(path.join(D, "daemon.key"), "utf8").trim();
  const s0 = await status();
  check("state waiting_page after on", s0.state === "waiting_page", s0.state);
  // Page credentials: bootstrap refuses a client that was not given the secret.
  const anon = await fetch(`${BASE}/api/bootstrap`);
  check("bootstrap without the page secret is refused (403)", anon.status === 403, String(anon.status));
  const PAGE_SECRET = fs.readFileSync(path.join(D, "page.secret"), "utf8").trim();
  const activeFields = fs.readFileSync(path.join(D, "active"), "utf8").trim().split("\t");
  const NONCE = activeFields[3] || "";
  check("active file carries the per-bind marker nonce", /^[0-9a-f]{12}$/.test(NONCE));

  // 4. Headless Chrome with the fake mic, muted output, dedicated throwaway profile.
  chrome = spawnSilentChrome({ wav, extra: [
    `--user-data-dir=${path.join(TMP, "chrome-e2e")}`,
    // The daemon's own windows carry a one-time launch code; the persistent
    // page secret is accepted in the same place.
    `${BASE}/?autostart=1#k=${PAGE_SECRET}`,
  ] });
  const tChrome = Date.now();

  // 5. WebRTC session created with gpt-live-1, sideband attached, live.
  const live = await until(async () => { const s = await status(); return s.state === "live" ? s : null; }, 25000);
  if (!check("state live", !!live, live ? "" : `state ${(await status().catch(() => ({}))).state}`)) return;
  liveSince = Date.now();
  liveId = live.live.session_id;
  timings.chrome_to_live_ms = liveSince - tChrome;
  const L = readLog();
  const created = L.find((e) => e.ev === "session.create");
  check("session created with gpt-live-1", created?.ok === true && created.model === "gpt-live-1" && created.status === 201, `${created?.status} ${created?.model} in ${created?.ms} ms`);
  check("sideband attached", L.some((e) => e.ev === "sideband.open" && e.live_id === liveId));
  const started = L.find((e) => e.ev === "session.started");
  check("session.started (model gpt-live-1)", started?.model === "gpt-live-1", started?.model);

  // 6. Input transcript, delegation, exactly one inbox write.
  const heard = await until(() => {
    const t = readLog().filter((e) => e.ev === "session.input_transcript.delta").map((e) => e.delta).join("");
    return /files/i.test(t) ? t : null;
  }, 30000);
  check("input transcript received", !!heard, JSON.stringify((heard || "").trim().slice(0, 120)));
  const deleg = await until(() => readLog().find((e) => e.ev === "session.delegation.created" && e.target === "client"), 20000);
  if (!check("session.delegation.created (client)", !!deleg)) return;
  const got = await until(() => (inbox.frames.some((f) => f.type === "user") ? true : null), 10000);
  if (!check("inbox received a user frame", !!got)) return;
  await sleep(1500); // anything extra would show up now
  const frames = inbox.frames.slice();
  check("exactly one inbox write (auth + user)", inbox.connections.length === 1 && frames.length === 2, `${inbox.connections.length} conn, ${frames.length} frames`);
  check("auth frame first, with the session token", frames[0]?.type === "auth" && frames[0]?.token === INBOX_TOKEN);
  const u = frames[1] || {};
  const content = u.message?.content || "";
  check("user frame carries the utterance", u.type === "user" && u.message?.role === "user" && content.startsWith(`[sotto voice ${NONCE}] `) && /files/i.test(content) && /project/i.test(content), JSON.stringify(content.slice(0, 120)));
  check("user frame fields", u.from_plugin === "sotto" && /^clv-/.test(u.msg_id || "") && u.priority === "next", u.msg_id);
  const s6 = await status();
  const d0 = s6.delegations[0];
  check("delegation sent, counters", d0?.status === "sent" && s6.counters.inbox_sent === 1 && s6.counters.delegations >= 1, `${d0?.status} inbox_sent=${s6.counters.inbox_sent}`);

  // Timings: end of the user's speech → inbox frame.
  const L6 = readLog();
  const tInbox = frameAt[1];
  const userDeltas = L6.filter((e) => e.ev === "session.input_transcript.delta" && ts(e) <= tInbox);
  const lastDelta = userDeltas[userDeltas.length - 1];
  if (lastDelta) timings.last_input_transcript_to_inbox_ms = tInbox - ts(lastDelta);
  timings.delegation_created_to_inbox_ms = tInbox - ts(deleg);
  // Audio-clock estimate: session.started wall time + transcript end_ms of the utterance.
  if (lastDelta?.end_ms != null && started) timings.speech_end_audio_clock_to_inbox_ms = tInbox - (ts(started) + Number(lastDelta.end_ms));

  // 7a. Delivery: the UserPromptSubmit hook for that message (real hook.sh)
  //     prints the voice framing and marks the delegation delivered.
  const upsBody = JSON.stringify({ session_id: "e2e", prompt_id: "e2e-p1", hook_event_name: "UserPromptSubmit", prompt: content });
  const ups = spawnSync(path.join(REPO, "scripts", "hook.sh"), ["UserPromptSubmit"], { input: upsBody, encoding: "utf8", env: hookEnv() });
  let upsOut = null;
  try { upsOut = JSON.parse(ups.stdout); } catch { /* checked below */ }
  check("hook.sh UserPromptSubmit: voice framing with this bind's marker", ups.status === 0 && (upsOut?.hookSpecificOutput?.additionalContext || "").includes(`[sotto voice ${NONCE}]`));
  const delivered = await until(async () => ((await status()).delegations.find((x) => x.id === d0?.id)?.status === "delivered" ? true : null), 3000);
  check("delegation delivered (UserPromptSubmit)", !!delivered);

  // 7b. Claude's reply through the real forwarder (what the Stop hook does).
  const answer = "This project has a daemon folder, a web folder, a scripts folder and a test folder, plus a readme. The test fixture is called banana split.";
  const stopBody = JSON.stringify({ session_id: "e2e", prompt_id: "e2e-p1", hook_event_name: "Stop", stop_hook_active: false,
    last_assistant_message: answer, background_tasks: [], session_crons: [] });
  const tStop = Date.now();
  const r = spawnSync(path.join(REPO, "scripts", "hook.sh"), ["Stop"], { input: stopBody, encoding: "utf8", env: hookEnv() });
  timings.hook_sh_stop_ms = Date.now() - tStop;
  check("hook.sh Stop: exit 0, silent", r.status === 0 && r.stdout === "" && r.stderr === "", `${timings.hook_sh_stop_ms} ms`);

  // 8. commentary.append accepted and spoken.
  const appended = await until(() => readLog().find((e) => e.ev === "session.commentary.appended" && ts(e) >= tStop - 50), 15000);
  check("session.commentary.appended", !!appended);
  const sent = readLog().find((e) => e.ev === "client.send" && e.type === "session.commentary.append" && e.delegation_id === d0?.id);
  check("commentary.append carries the delegation id", !!sent);
  const spoken = await until(() => {
    // Speech about the result starts after the ack; earlier deltas are the tail of
    // the model's "I'll check with Claude" filler.
    const from = appended ? ts(appended) : tStop;
    const ds = readLog().filter((e) => e.ev === "session.output_transcript.delta" && ts(e) >= from);
    return ds.length && ds.map((e) => e.delta).join("").trim().split(/\s+/).length >= 4 ? ds : null;
  }, 20000);
  check("output transcript after the result", !!spoken, spoken ? JSON.stringify(spoken.map((e) => e.delta).join("").trim().slice(0, 140)) : "");
  if (appended) timings.stop_to_commentary_ack_ms = ts(appended) - tStop;
  if (sent) timings.stop_to_commentary_send_ms = ts(sent) - tStop;
  if (spoken) timings.stop_to_speech_start_ms = ts(spoken[0]) - tStop;
  const s8 = await status();
  check("delegation answered", s8.delegations.find((x) => x.id === d0?.id)?.status === "answered", s8.delegations[0]?.status);
  const banana = await until(() => readLog().some((e) => e.ev === "session.output_transcript.delta" && ts(e) >= tStop && /banana/i.test(e.delta || "")) || null, 8000);
  if (banana) check("spoken result mentions the answer (banana)", true);
  else warn("spoken result mentions the answer (banana)", "model-dependent paraphrase");
  if (inbox.frames.length !== 2) warn("extra inbox writes after the result", `${inbox.frames.length} frames total`);

  // 8b. Live voice switch (SPEC §6.14): /talk voice cedar re-creates the session
  //     in the new voice, seeded with the conversation, and confirms by voice.
  const firstLiveId = liveId;
  const tSwitch = Date.now();
  const sw = toggle("voice cedar");
  check("toggle.sh voice cedar: switching message", sw.status === 0 && sw.out?.stopReason === "sotto: voice set to cedar. Switching the live session now.", `${sw.out?.stopReason} (${sw.ms} ms)`);
  const created2 = await until(() => readLog().find((e) => e.ev === "session.create" && ts(e) >= tSwitch && e.ok), 20000);
  check("replacement session created in cedar (reason reconnect)", created2?.voice === "cedar" && created2?.reason === "reconnect" && created2.live_id !== firstLiveId, `${created2?.voice} ${created2?.reason}`);
  const live2 = await until(async () => { const s = await status(); return s.state === "live" && s.live?.session_id === created2?.live_id ? s : null; }, 20000);
  if (check("live again after the switch", !!live2, live2 ? "" : (await status()).state)) {
    liveId = live2.live.session_id;
    timings.voice_switch_to_live_ms = Date.now() - tSwitch;
  }
  const oldClosed = await until(() => readLog().find((e) => e.ev === "session.closed" && e.live_id === firstLiveId), 10000);
  check("old session closed (close_requested)", oldClosed?.reason === "close_requested", oldClosed?.reason);
  firstBilled = oldClosed?.seconds ?? null;
  // The dial's outer ring meters an unplayed clone of the remote track (web/app.js,
  // meter.attachVoice). The page logs the peak level per session when the voice
  // meter detaches (here: the voice switch). A silent clone would leave the ring
  // dead in production while every other check passes.
  const peakLine = await until(() => readLog().find((e) => e.ev === "page.log" && /^voice meter: peak /.test(e.message || "") && ts(e) >= tSwitch - 50), 8000);
  const peak = peakLine ? Number(/peak ([\d.]+)/.exec(peakLine.message)?.[1]) : NaN;
  check("voice meter heard the model through the unplayed clone (peak above the 0.08 gate)", peak > 0.08, peakLine ? peakLine.message : "no voice meter line in the daemon log");
  const confirmed = await until(() => {
    const t = readLog().filter((e) => e.ev === "session.output_transcript.delta" && ts(e) >= tSwitch).map((e) => e.delta).join("");
    return /switch|cedar/i.test(t) ? t : null;
  }, 12000);
  if (confirmed) {
    check("spoken confirmation in the new voice", true, JSON.stringify(confirmed.trim().slice(0, 80)));
    timings.voice_switch_to_confirmation_ms = Date.now() - tSwitch;
  } else warn("spoken confirmation in the new voice", "no 'switched'/'cedar' in the output transcript");
  // Regression (round 2): the replacement session used to speak the last update
  // (the files answer) again. Its seed now carries the voice history as
  // assistant messages, already spoken. Listen to the new session for a moment.
  if (created2?.live_id) {
    await sleep(4000);
    const said2 = readLog().filter((e) => e.ev === "session.output_transcript.delta" && e.live_id === created2.live_id).map((e) => e.delta).join("");
    check("new voice does not re-speak the last update", !/banana|daemon folder|web folder|scripts folder/i.test(said2), JSON.stringify(said2.trim().slice(0, 120)));
    const closeFirst = readLog().find((e) => e.ev === "voice.switch_closed");
    if (closeFirst) timings.voice_switch_close_wait_ms = closeFirst.ms;
  }
  check("prefs.json persisted the voice", JSON.parse(fs.readFileSync(path.join(D, "prefs.json"), "utf8")).voice === "cedar");

  // 8c. Claude asks the user a question (AskUserQuestion PreToolUse through the
  // real forwarder): spoken as an acked commentary (SPEC §6.10.1), once the
  // voice has finished speaking the result (§6.10.2).
  const askBody = JSON.stringify({ session_id: "e2e", prompt_id: "e2e-p2", hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_e2e_ask",
    tool_input: { questions: [{ question: "Which color should the button be?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false }] } });
  const tAsk = Date.now();
  const ask = spawnSync(path.join(REPO, "scripts", "hook.sh"), ["PreToolUse"], { input: askBody, encoding: "utf8", env: hookEnv() });
  check("hook.sh PreToolUse (AskUserQuestion): exit 0, silent", ask.status === 0 && ask.stdout === "" && ask.stderr === "");
  const askSent = await until(() => readLog().find((e) => e.ev === "client.send" && e.type === "session.commentary.append" && ts(e) >= tAsk - 50 && /^Claude's asking: Which color should the button be\? Options: Red or Blue\./.test(e.content || "")), 20000);
  check("AskUserQuestion → commentary.append with the question and options", !!askSent, askSent ? `${ts(askSent) - tAsk} ms after the hook` : "");
  const askAck = askSent && await until(() => readLog().find((e) => e.ev === "append.ack" && e.event_id === askSent.event_id), 10000);
  check("question commentary acked", !!askAck);
  if (askSent) timings.ask_hook_to_commentary_send_ms = ts(askSent) - tAsk;

  // 8d. Voice sample for the picker (GET /api/voice-preview): a separate tiny
  //     primary-WebSocket session in another voice, cached as a WAV. The live
  //     session must not notice.
  const secret = fs.readFileSync(path.join(D, "page.secret"), "utf8").trim();
  const boot = await (await fetch(`${BASE}/api/bootstrap`, { headers: { "X-Sotto-Boot": secret } })).json();
  const tPrev = Date.now();
  const prev = await fetch(`${BASE}/api/voice-preview?voice=sage`, { headers: { "X-Sotto-Page": boot.page_token } });
  const prevMs = Date.now() - tPrev;
  const prevWav = Buffer.from(await prev.arrayBuffer());
  const prevAudioMs = prevWav.length > 44 ? Math.round(((prevWav.length - 44) / 48000) * 1000) : 0;
  check("voice preview: first request records a WAV", prev.status === 200 && prev.headers.get("content-type") === "audio/wav" && prevWav.toString("ascii", 0, 4) === "RIFF" && prevAudioMs > 800 && prevAudioMs < 6000, `${prev.status}, ${prevAudioMs} ms of audio in ${prevMs} ms`);
  timings.voice_preview_first_ms = prevMs;
  const tPrev2 = Date.now();
  const prev2 = await fetch(`${BASE}/api/voice-preview?voice=sage`, { headers: { "X-Sotto-Page": boot.page_token } });
  await prev2.arrayBuffer();
  timings.voice_preview_cached_ms = Date.now() - tPrev2;
  check("voice preview: second request is served from the cache", prev2.status === 200 && timings.voice_preview_cached_ms < 500, `${timings.voice_preview_cached_ms} ms`);
  const prevRec = readLog().find((e) => e.ev === "preview.recorded" && e.voice === "sage");
  if (prevRec) check("voice preview transcript", /sage/i.test(prevRec.transcript || ""), JSON.stringify(prevRec.transcript));
  const prevClosed = await until(() => readLog().find((e) => e.ev === "preview.closed" && e.voice === "sage"), 5000);
  if (prevClosed) timings.voice_preview_billed_s = prevClosed.seconds;
  const sPrev = await status();
  check("voice preview left the live session alone", sPrev.state === "live" && sPrev.live?.session_id === liveId, `${sPrev.state} ${sPrev.live?.session_id === liveId ? "same session" : "session changed"}`);

  // 9. /talk off through the real toggle.sh.
  const off = toggle("off");
  check("toggle.sh off: voice OFF message", off.status === 0 && /^sotto: voice OFF\./.test(off.out?.stopReason || ""), `${off.out?.stopReason} (${off.ms} ms)`);
  const closed = await until(() => readLog().find((e) => e.ev === "session.closed" && e.live_id === liveId), 20000);
  check("session.closed close_requested", closed?.reason === "close_requested", closed?.reason);
  billed = closed?.seconds != null ? closed.seconds + (firstBilled || 0) + (timings.voice_preview_billed_s || 0) : null;
  timings.live_wall_ms = Date.now() - liveSince;
  check("active file removed", !fs.existsSync(path.join(D, "active")));
  const gone = await until(() => !alive(pid), 8000);
  check("daemon exited after off", !!gone);

  // 10. Hygiene: no secrets in the log.
  const raw = fs.readFileSync(path.join(D, "logs", "daemon.log"), "utf8");
  const apiKey = resolveApiKey({ env: process.env, pluginRoot: REPO });
  check("daemon log has no API key, inbox token or daemon key", !raw.includes(apiKey) && !raw.includes(INBOX_TOKEN) && !raw.includes(KEY));
}

async function cleanup() {
  // Billing safety: if a session may still be open, turn voice off first.
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

// Hard cap on paid Live time: once the session has been live for 90 s, stop
// the daemon (graceful close) no matter which step we are waiting in.
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
  for (const [k, v] of Object.entries(timings)) log(`${k.padEnd(38)} ${k.endsWith("_ms") ? secs(v) : v}`);
  log("----");
  log(`${failed.length ? "FAIL" : process.exitCode === 2 ? "SKIP" : "PASS"}: ${results.filter((r) => r.ok && !r.warn).length} passed, ${failed.length} failed, ${results.filter((r) => r.warn).length} warnings`);
  log(`live session: ${liveId || "none"}  billed seconds: ${billed ?? "unknown"}`);
  if (failed.length) process.exitCode = 1;
}
