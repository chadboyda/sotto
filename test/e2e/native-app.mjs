#!/usr/bin/env node
// Native desktop app, end to end against the REAL gpt-live-1 (docs/NATIVE.md §6).
//
// The real app (built from app-native/, test bundle id, test mode) is opened
// by the real chooser (daemon/window.js, SOTTO_BROWSER=app). Its FakeAudioIO
// is the microphone and the speaker: the test drops WAV clips into a queue
// directory at the moments it chooses (SOTTO_APP_MIC_QUEUE_DIR) and the model's
// voice is rendered through the real jitter buffer into a WAV file. Nothing
// reaches the speakers, nothing opens the microphone.
//
//   session A: greeting audio reaches the app -> the fixture question is
//              transcribed -> delegation reaches the fake inbox -> a Stop hook
//              answer is spoken -> a barge-in clip stops the voice
//   voice switch to cedar: session B, in the new voice
//   persona picker: the app's Settings model turns "Switch to the persona's own
//              voice" off and picks June (SOTTO_APP_TEST_ACTION_DIR -> cmd
//              set_persona): session B', June's personality, still cedar
//   session B: nobody talks -> no "can't hear you" (the user was heard on this
//              mic in session A; a voice switch keeps that) -> idle sleep
//   sleeping:  the app listens; a spoken clip wakes session C (voice wake)
//   voice off: the app quits
//
// Measures latency: mic clip -> input transcript, model audio at the daemon ->
// app receive -> first rendered sample, barge-in -> silence, switch and wake.
// Cost: three short sessions, about 60-90 billed seconds (hard cap asserted).
// Never prints the API key or any token.
//
//   npm run e2e:app
//   SOTTO_E2E_KEEP=1   keep the temp dir (daemon log, app log, output WAV)
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDaemon } from "../../daemon/index.js";
import { appPaths } from "../../daemon/window.js";
import { resolveApiKey } from "../../daemon/config.js";
import { startFakeInbox } from "../helpers/fake-inbox.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
// Unique per run: LaunchServices hands `open -a <path> sotto://…` to an already
// running app with the same bundle id, so two concurrent test runs sharing one
// id steal each other's app (seen in integration). Never the user's own id.
const LS_ID = `com.chadboyda.sotto.apptest.${process.pid}`;
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const FIX = (n) => path.join(REPO, "test", "fixtures", n);
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clv-app-e2e-")));
const D = path.join(TMP, "data");
const QDIR = path.join(TMP, "micq");
const ADIR = path.join(TMP, "actions");
const APP_LOG = path.join(TMP, "app.jsonl");
const OUT_WAV = path.join(TMP, "out.wav");
const SOCK = `/tmp/clv-app-e2e-${process.pid}.sock`;
const INBOX_TOKEN = `e2e-app-${process.pid}`;
const WALL_BUDGET_MS = 240_000;
const BILLED_MAX_S = 130;
const IDLE_SECONDS = 10;
const SILENT_MS = 11_000; // can't-hear "silent" window (the page's is 20 s; shortened to save billing)

const results = [];
const timings = {};
const log = (...a) => console.log("[app-e2e]", ...a);
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
async function until(fn, ms, every = 100) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() > end) return null;
    await sleep(every);
  }
}
const jsonl = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
/** Daemon log, each line with `at` (epoch ms). */
const dlog = () => jsonl(path.join(D, "logs", "daemon.log")).map((e) => ({ ...e, at: Date.parse(e.ts) }));
/** App debug log, each line with `at` (epoch ms). */
const alog = () => jsonl(APP_LOG).map((e) => ({ ...e, at: Math.round(e.t * 1000) }));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const ms = (v) => (v == null || !Number.isFinite(v) ? "n/a" : `${Math.round(v)} ms`);

/** Speak a clip into the app's fake mic now; resolves with the app's clip start/end times. */
let clipN = 0;
async function speak(file, what) {
  const name = `${String(++clipN).padStart(2, "0")}-${what}.wav`;
  const tmp = path.join(QDIR, `.${name}`);
  fs.copyFileSync(file, tmp);
  fs.renameSync(tmp, path.join(QDIR, name)); // atomic: the app never reads half a file
  const start = await until(() => alog().find((e) => e.ev === "mic_clip" && e.name === name && e.phase === "start"), 5000);
  return { name, start: start?.at ?? null, end: () => alog().find((e) => e.ev === "mic_clip" && e.name === name && e.phase === "end")?.at ?? null };
}

/** Synthesize a short clip with macOS `say` (written to a file, never played). */
function say(text, out) {
  const aiff = out.replace(/\.wav$/, ".aiff");
  const r = spawnSync("say", ["-o", aiff, text]);
  if (r.status !== 0) return false;
  const f = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-i", aiff, "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", out]);
  return f.status === 0 && fs.existsSync(out);
}

function wavStats(file) {
  try {
    const b = fs.readFileSync(file);
    let off = 12;
    while (off + 8 <= b.length) {
      const id = b.toString("ascii", off, off + 4);
      const size = b.readUInt32LE(off + 4);
      if (id === "data") {
        let peak = 0, voiced = 0;
        const end = Math.min(b.length, off + 8 + size);
        for (let i = off + 8; i + 959 < end; i += 960) {
          let p = 0;
          for (let j = i; j < i + 960; j += 2) p = Math.max(p, Math.abs(b.readInt16LE(j)));
          if (p > 800) voiced++;
          peak = Math.max(peak, p);
        }
        return { peak, seconds: size / 48000, voicedSeconds: voiced * 0.02 };
      }
      off += 8 + size + (size & 1);
    }
  } catch { /* not written yet */ }
  return { peak: 0, seconds: 0, voicedSeconds: 0 };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

async function main() {
  const key = resolveApiKey({ env: process.env, pluginRoot: REPO });
  const missing = [];
  if (process.platform !== "darwin") missing.push("macOS");
  if (!key) missing.push("OPENAI_API_KEY");
  if (spawnSync("which", ["ffmpeg"]).status !== 0) missing.push("ffmpeg");
  if (missing.length) { log(`SKIP: missing ${missing.join(", ")}`); process.exitCode = 2; return; }

  fs.mkdirSync(QDIR, { recursive: true });
  fs.mkdirSync(ADIR, { recursive: true });
  // A Settings action for the app (test mode only), written whole then renamed so the app never reads half a file.
  const act = (name, obj) => { const f = path.join(ADIR, `${name}.json`); fs.writeFileSync(`${f}.tmp`, JSON.stringify(obj)); fs.renameSync(`${f}.tmp`, f); };
  const barge = path.join(TMP, "barge.wav");
  if (!check("barge-in clip (say)", say("Hold on. Stop there for a second.", barge))) return;

  // Build as the daemon would, then the test bundle id: LaunchServices must
  // never hand this URL to the user's own Sotto.
  const p = appPaths(D, REPO);
  const tb = Date.now();
  const b = spawnSync("/bin/bash", [path.join(REPO, "scripts/build-app.sh"), "--out", p.dir, "--quiet"], { encoding: "utf8" });
  if (!check("build Sotto.app", b.status === 0, b.status === 0 ? `${((Date.now() - tb) / 1000).toFixed(1)} s` : b.stderr.slice(-400))) return;
  for (const [cmd, args] of [["plutil", ["-replace", "CFBundleIdentifier", "-string", LS_ID, path.join(p.bundle, "Contents/Info.plist")]],
    ["codesign", ["--force", "--sign", "-", "--identifier", LS_ID, p.bundle]]]) {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    if (!check(`${cmd} test bundle id`, r.status === 0, r.stderr)) return;
  }

  const inboxAt = [];
  const inbox = await startFakeInbox(SOCK, { onFrame: () => inboxAt.push(Date.now()) });
  const port = await freePort();
  const env = {
    HOME: process.env.HOME, PATH: process.env.PATH, OPENAI_API_KEY: key,
    SOTTO_KEYCHAIN_SERVICE: `sotto-e2e-app-${process.pid}`, // never the user's real Keychain item
    SOTTO_VOCAB: "0", SOTTO_UPDATE: "0", SOTTO_APP_DOWNLOAD: "0",
    SOTTO_BROWSER: "app", SOTTO_APP_TEST: "1", SOTTO_APP_DEBUG_LOG: APP_LOG,
    SOTTO_APP_MIC_QUEUE_DIR: QDIR, SOTTO_APP_OUT_WAV: OUT_WAV, SOTTO_APP_TEST_ACTION_DIR: ADIR,
  };
  const d = createDaemon({ dataDir: D, port, pluginRoot: REPO, env, onExit: () => {}, nativeOptions: { hearing: { silentMs: SILENT_MS } } });
  await d.listen();
  log(`daemon on ${port}, data ${D}`);
  const hdr = { "Content-Type": "application/json", "X-Sotto-Key": d.daemonKey };
  const ctl = (body) => fetch(`http://127.0.0.1:${port}/control`, { method: "POST", headers: hdr, body: JSON.stringify(body) }).then((r) => r.json());
  const hook = (event, body) => fetch(`http://127.0.0.1:${port}/hook/${event}`, { method: "POST", headers: { ...hdr, "X-Sotto-Socket": SOCK }, body: JSON.stringify(body) });
  const state = () => d.voice.state;
  let appPid = null;
  const wall = setTimeout(() => { check("finished within the wall budget", false, `${WALL_BUDGET_MS / 1000} s`); d.voice.off("user"); }, WALL_BUDGET_MS);
  wall.unref();

  try {
    // ---- on: the chooser opens the app, the app attaches, session A goes live.
    const t0 = Date.now();
    const on = await ctl({ action: "on", session: { session_id: "app-e2e", socket: SOCK, token: INBOX_TOKEN, cwd: REPO, project_dir: REPO }, config: { open_browser: true, idle_seconds: IDLE_SECONDS } });
    check("voice on", on.ok, on.message);
    const launch = await until(() => alog().find((e) => e.ev === "launch"), 20_000);
    if (!check("app launched under the test bundle id", launch?.bundle === LS_ID && launch.test === true, launch ? `pid ${launch.pid}` : "no launch line")) return;
    appPid = launch.pid;
    timings.on_to_app_launch_ms = launch.at - t0;
    const welcome = await until(() => alog().find((e) => e.ev === "welcome"), 20_000);
    check("app link: welcome", !!welcome);
    if (welcome) timings.on_to_welcome_ms = welcome.at - t0;
    const live = await until(() => state() === "live", 30_000);
    if (!check("session A live (daemon owns the primary WebSocket)", live, state())) return;
    timings.on_to_live_ms = Date.now() - t0;
    const L0 = dlog();
    check("window.choose picked the app", L0.some((e) => e.ev === "window.choose" && e.mode === "app"));
    const startedA = L0.find((e) => e.ev === "session.started");
    const liveA = d.voice.status().live?.session_id;
    check("capture full in the app", alog().some((e) => e.ev === "capture" && e.to === "full"));

    // ---- greeting audio reaches the app and plays.
    const greetOut = await until(() => alog().find((e) => e.ev === "out_speech" && e.phase === "start"), 15_000);
    check("greeting audio rendered by the app", !!greetOut);
    const greetSpk = dlog().find((e) => e.ev === "native.speech_onset");
    if (startedA && greetSpk) timings.session_started_to_first_model_audio_ms = greetSpk.at - startedA.at;
    const greetEnd = await until(() => alog().find((e) => e.ev === "out_speech" && e.phase === "end" && e.at > (greetOut?.at ?? 0)), 15_000);
    await sleep(600);

    // ---- the user's question: transcribed, delegated, reaches the inbox.
    const q = await speak(FIX("ask-files.wav"), "ask-files");
    check("question clip streaming from the app mic", !!q.start);
    const deleg = await until(() => (inbox.frames.some((f) => f.type === "user") ? inbox.frames.find((f) => f.type === "user") : null), 30_000);
    const qEnd = q.end();
    const heardQ = dlog().filter((e) => e.ev === "session.input_transcript.delta" && e.at >= (q.start ?? 0));
    const heardText = heardQ.map((e) => e.delta).join("");
    check("user WAV transcribed", /file/i.test(heardText), JSON.stringify(heardText.trim().slice(0, 100)));
    if (!check("delegation reaches the fake inbox", !!deleg, deleg ? JSON.stringify(String(deleg.message?.content || "").slice(0, 100)) : "")) return;
    if (heardQ.length && q.start) {
      timings.mic_clip_start_to_first_transcript_ms = heardQ[0].at - q.start;
      const lastQ = heardQ.filter((e) => /\S/.test(e.delta || "") && (!qEnd || e.at <= qEnd + 4000)).pop();
      if (lastQ && qEnd) timings.mic_speech_end_to_last_transcript_ms = lastQ.at - qEnd;
      // Session-clock lag: arrival vs the delta's own end_ms on the audio timeline.
      const t0Audio = startedA ? startedA.at : null;
      const lags = heardQ.filter((e) => Number.isFinite(e.end_ms) && t0Audio).map((e) => e.at - (t0Audio + e.end_ms));
      if (lags.length) timings.transcript_lag_session_clock_median_ms = median(lags);
    }
    const dc = dlog().find((e) => e.ev === "session.delegation.created");
    if (qEnd) {
      if (dc) timings.mic_speech_end_to_delegation_created_ms = dc.at - qEnd;
      timings.mic_speech_end_to_inbox_ms = inboxAt[inboxAt.length - 1] - qEnd;
    }
    const content = String(deleg.message?.content || "");

    // ---- Claude answers (UserPromptSubmit + Stop through the daemon's hook route).
    await hook("UserPromptSubmit", { session_id: "app-e2e", prompt_id: "p1", hook_event_name: "UserPromptSubmit", prompt: content });
    await sleep(300);
    const answer = "This project has a daemon folder with the voice orchestrator, a web folder with the voice page, "
      + "a scripts folder with the hooks, an app-native folder with the Swift desktop app, and a test folder with unit tests, "
      + "end to end tests and audio fixtures. The readme explains how to install it, and the docs folder holds the spec, "
      + "the architecture notes and the list of deviations from the spec.";
    const tStop = Date.now();
    await hook("Stop", { session_id: "app-e2e", prompt_id: "p1", hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: answer, background_tasks: [], session_crons: [] });
    const appended = await until(() => dlog().find((e) => e.ev === "session.commentary.appended" && e.at >= tStop - 50), 15_000);
    check("Stop answer appended (commentary acked)", !!appended);
    const spoken = await until(() => {
      const from = appended ? appended.at : tStop;
      const ds = dlog().filter((e) => e.ev === "session.output_transcript.delta" && e.at >= from);
      return ds.map((e) => e.delta).join("").trim().split(/\s+/).length >= 4 ? ds : null;
    }, 20_000);
    check("simulated Stop is spoken", !!spoken, spoken ? JSON.stringify(spoken.map((e) => e.delta).join("").trim().slice(0, 100)) : "");
    const answerOut = await until(() => alog().find((e) => e.ev === "out_speech" && e.phase === "start" && e.at >= (appended?.at ?? tStop)), 10_000);
    check("answer audio rendered by the app", !!answerOut);
    if (appended && answerOut) timings.stop_to_answer_playback_ms = answerOut.at - tStop;

    // ---- barge-in: the user talks over the answer; the voice stops.
    await sleep(2500);
    const speakingBefore = alog().filter((e) => e.ev === "out_speech").pop();
    const bargeWhileSpeaking = speakingBefore?.phase === "start";
    const bg = await speak(barge, "barge");
    const bargeStop = await until(() => alog().find((e) => e.ev === "out_speech" && e.phase === "end" && e.at >= (bg.start ?? Date.now())), 12_000);
    if (!bargeWhileSpeaking) warn("barge-in over speech", "the voice had already finished the answer");
    const stopMs = bargeStop && bg.start ? bargeStop.at - bg.start : null;
    check("barge-in stops playback", bargeWhileSpeaking ? (stopMs != null && stopMs < 4000) : true, `clip start -> app output silent ${ms(stopMs)}; max buffer ${bargeStop?.max_buffer_ms ?? "n/a"} ms`);
    timings.barge_in_to_playback_silent_ms = stopMs;
    const bargeHeard = await until(() => dlog().find((e) => e.ev === "session.input_transcript.delta" && e.at >= (bg.start ?? 0) && /\w/.test(e.delta || "")), 8000);
    if (bargeHeard && bg.start) timings.barge_in_clip_start_to_first_transcript_ms = bargeHeard.at - bg.start;
    const flushes = alog().filter((e) => e.ev === "playout_flush" || e.ev === "audio_flush");
    log(`flushes so far: ${JSON.stringify(flushes.map((f) => [f.ev, f.reason ?? null, f.buffer_ms ?? null]))}`);
    await sleep(2500);
    const answerSaid = dlog().filter((e) => e.ev === "session.output_transcript.delta" && e.at >= (appended?.at ?? tStop)).map((e) => e.delta).join("");
    check("the answer was cut short by the barge-in", bargeWhileSpeaking ? !/readme|deviations/i.test(answerSaid) : true, JSON.stringify(answerSaid.trim().slice(-80)));

    // ---- voice switch: session B in cedar; the app keeps playing.
    const tSw = Date.now();
    const sw = await ctl({ action: "voice", voice: "cedar" });
    check("voice switch accepted", sw.ok, sw.message);
    const created2 = await until(() => dlog().find((e) => e.ev === "session.create" && e.at >= tSw && e.ok), 20_000);
    check("session B created in cedar", created2?.voice === "cedar", `${created2?.voice} ${created2?.reason}`);
    let liveB = await until(() => (state() === "live" && d.voice.status().live?.session_id !== liveA ? d.voice.status().live.session_id : null), 20_000);
    check("live again after the switch", !!liveB);
    let tLiveB = Date.now();
    timings.voice_switch_to_live_ms = tLiveB - tSw;
    const swFlush = alog().find((e) => e.ev === "audio_flush" && e.at >= tSw);
    check("app flushed session A's audio on the switch", !!swFlush, swFlush?.reason ?? "");
    const swOut = await until(() => alog().find((e) => e.ev === "out_speech" && e.phase === "start" && e.at >= tSw), 15_000);
    check("session B audio rendered by the app", !!swOut);
    if (swOut) timings.voice_switch_to_new_voice_playback_ms = swOut.at - tSw;

    // ---- persona picker in the app's Settings: toggle the persona's voice off, pick June.
    // Same SettingsModel calls as the window (cmd set_persona); the session is re-created in
    // June's personality and keeps cedar (June's own voice would be coral).
    await sleep(1500);
    act("1-persona-voice", { action: "persona_voice", on: false });
    const tog = await until(() => alog().find((e) => e.ev === "cmd_result" && e.name === "set_persona"), 10_000);
    check("persona voice toggle off (cmd set_persona from the app)", tog?.ok === true && d.voice.personas().use_voice === false);
    const tPs = Date.now();
    act("2-persona", { action: "persona", persona: "june" });
    const psRes = await until(() => alog().find((e) => e.ev === "cmd_result" && e.name === "set_persona" && e.at >= tPs), 10_000);
    check("persona pick answered", psRes?.ok === true);
    const createdP = await until(() => dlog().find((e) => e.ev === "session.create" && e.at >= tPs && e.ok), 20_000);
    check("session B' created in June, voice kept", createdP?.persona === "june" && createdP?.voice === "cedar", `${createdP?.persona} ${createdP?.voice} ${createdP?.reason}`);
    const liveP = await until(() => (state() === "live" && d.voice.status().live?.session_id !== liveB ? d.voice.status().live.session_id : null), 20_000);
    check("live again in the new persona", !!liveP && d.voice.live?.persona === "june");
    timings.persona_pick_to_live_ms = Date.now() - tPs;
    const psOut = await until(() => alog().find((e) => e.ev === "out_speech" && e.phase === "start" && e.at >= tPs), 15_000);
    check("persona greeting rendered by the app", !!psOut);
    if (psOut) timings.persona_pick_to_new_persona_playback_ms = psOut.at - tPs;
    const psSaid = (await until(() => {
      const t = dlog().filter((e) => e.ev === "session.output_transcript.delta" && e.at >= tPs).map((e) => e.delta).join("");
      return t.trim().split(/\s+/).length >= 4 ? t : null;
    }, 10_000)) || "";
    if (!/june/i.test(psSaid)) warn("persona greeting names June", JSON.stringify(psSaid.trim().slice(0, 100)));
    else log(`persona greeting: ${JSON.stringify(psSaid.trim().slice(0, 100))}`);
    if (liveP) { liveB = liveP; tLiveB = Date.now(); }

    // ---- can't hear only before the first words (SPEC-DEVIATIONS, header pills 3): the
    // user was heard on this mic in session A and the voice switch is a reconnect, so
    // session B's silence raises no warning (the unit tests cover the firing side).
    const silentUntil = Date.now() + SILENT_MS + 3000;
    const slept = await until(() => state() === "sleeping", 45_000, 250);
    if (Date.now() < silentUntil && state() !== "sleeping") await sleep(silentUntil - Date.now());
    const cant = dlog().find((e) => e.ev === "page.cant_hear" && e.at >= tLiveB);
    check("no can't-hear after a voice switch on a mic that already heard the user", !cant, cant ? `${cant.kind} after ${cant.since_ms} ms` : "");
    check("app shows no can't-hear notice", !alog().find((e) => e.ev === "notice" && e.code === "cant_hear"));

    // ---- idle sleep: the app switches to listen-only capture.
    if (!check("session B sleeps when idle", slept, state())) return;
    const listen = await until(() => alog().find((e) => e.ev === "capture" && e.to === "listen" && e.at >= tLiveB), 5000);
    check("app listens locally while sleeping", !!listen);
    await sleep(1500);

    // ---- voice wake: speech into the app's mic wakes session C.
    const wk = await speak(FIX("ask-count.wav"), "wake");
    const trig = await until(() => dlog().find((e) => e.ev === "wake.trigger" && e.src === "app" && e.at >= (wk.start ?? 0)), 10_000);
    check("voice wake triggered from the app's mic", !!trig, trig ? `voiced ${trig.voiced_ms} ms, snr ${trig.snr_db} dB` : "");
    const liveC = await until(() => (state() === "live" && d.voice.status().live?.session_id !== liveB ? d.voice.status().live.session_id : null), 20_000);
    check("session C live after the wake", !!liveC);
    if (wk.start) {
      if (trig) timings.wake_speech_start_to_trigger_ms = trig.at - wk.start;
      if (liveC) timings.wake_speech_start_to_live_ms = Date.now() - wk.start;
    }
    const wakeOut = await until(() => alog().find((e) => e.ev === "out_speech" && e.phase === "start" && e.at >= (wk.start ?? 0)), 15_000);
    check("session C answers (audio rendered)", !!wakeOut);
    if (wakeOut && wk.start) timings.wake_speech_start_to_voice_ms = wakeOut.at - wk.start;
    const wakeWords = await until(() => {
      const t = dlog().filter((e) => (e.ev === "wake.transcribe" || e.ev === "session.input_transcript.delta") && e.at >= (wk.start ?? 0)).map((e) => e.text || e.delta || "").join(" ");
      return /\w{3,}/.test(t) ? t : null;
    }, 10_000);
    check("the wake words reach session C", !!wakeWords, JSON.stringify((wakeWords || "").trim().slice(0, 100)));
    await sleep(2000);

    // ---- latency of every speech onset: daemon receive -> app receive -> first rendered loud sample.
    const A = alog();
    const pairs = [];
    for (const s of dlog().filter((e) => e.ev === "native.speech_onset")) {
      const out = A.find((e) => e.ev === "out_speech" && e.phase === "start" && e.at >= s.at && e.at <= s.at + 1000);
      if (out) pairs.push(out.at - s.at);
    }
    if (pairs.length) {
      timings.model_audio_to_playback_median_ms = median(pairs);
      timings.model_audio_to_playback_max_ms = Math.max(...pairs);
      timings.model_audio_to_playback_n = pairs.length;
    }
    const rx = A.filter((e) => e.ev === "spk_rx");
    const onsets = dlog().filter((e) => e.ev === "native.speech_onset");
    check("model audio -> playback measured", pairs.length >= 3, `${pairs.length} of ${onsets.length} onsets paired; ${rx.length} link bursts`);
    const ends = A.filter((e) => e.ev === "out_speech" && e.phase === "end");
    const maxBuf = Math.max(0, ...ends.map((e) => e.max_buffer_ms || 0));
    const lastEnd = ends[ends.length - 1];
    check("jitter buffer stayed shallow (no overrun drops)", maxBuf <= 320 && (lastEnd?.overruns ?? 0) === 0, `max ${maxBuf} ms, overruns ${lastEnd?.overruns ?? "n/a"}, underruns ${lastEnd?.underruns ?? "n/a"}`);
    const st = d.voice.status();
    log(`native: ${JSON.stringify({ pacer: st.native?.pacer, counters: st.native?.counters })}`);

    // ---- voice off: the app quits.
    const off = await ctl({ action: "off" });
    check("voice off", off.ok);
    const quit = await until(() => !pidAlive(appPid), 15_000);
    check("app quits after voice off", !!quit);
    const wav = wavStats(OUT_WAV);
    check("output WAV holds the model's speech", wav.peak > 1200 && wav.voicedSeconds > 3, `${wav.seconds.toFixed(1)} s, ${wav.voicedSeconds.toFixed(1)} s voiced, peak ${wav.peak}`);
    await sleep(1000);
    const closed = dlog().filter((e) => e.ev === "session.closed");
    const billed = closed.reduce((s, e) => s + (Number(e.seconds) || 0), 0);
    timings.billed_seconds = billed;
    check(`billed <= ${BILLED_MAX_S} s`, billed > 0 && billed <= BILLED_MAX_S, `${billed} s over ${closed.length} sessions`);
    const raw = fs.readFileSync(path.join(D, "logs", "daemon.log"), "utf8") + fs.readFileSync(APP_LOG, "utf8");
    check("logs hold no API key, inbox token or daemon key", !raw.includes(key) && !raw.includes(INBOX_TOKEN) && !raw.includes(d.daemonKey));
  } finally {
    if (appPid && pidAlive(appPid)) { try { process.kill(appPid, "SIGTERM"); } catch { /* ignore */ } }
    try { if (d.voice.state !== "off") d.voice.off("user"); } catch { /* ignore */ }
    await sleep(1500);
    if (appPid && pidAlive(appPid)) { try { process.kill(appPid, "SIGKILL"); } catch { /* ignore */ } }
    try { await d.close(); } catch { /* ignore */ }
    try { await inbox.close(); } catch { /* ignore */ }
    spawnSync(LSREGISTER, ["-u", appPaths(D, REPO).bundle]);
  }
}

try {
  await main();
} catch (e) {
  check("no exceptions", false, String(e && e.stack || e));
} finally {
  const failed = results.filter((r) => !r.ok);
  log("---- timings");
  for (const [k, v] of Object.entries(timings)) log(`${k.padEnd(48)} ${k.endsWith("_ms") ? ms(v) : v}`);
  log("----");
  log(`${failed.length ? "FAIL" : process.exitCode === 2 ? "SKIP" : "PASS"}: ${results.filter((r) => r.ok && !r.warn).length} passed, ${failed.length} failed, ${results.filter((r) => r.warn).length} warnings`);
  if (process.env.SOTTO_E2E_KEEP === "1") log(`kept ${TMP}`);
  else fs.rmSync(TMP, { recursive: true, force: true });
  if (failed.length) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}
