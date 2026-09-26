#!/usr/bin/env node
// Bluetooth headset mic through the native path, against the REAL gpt-live-1.
//
// A Node fake app (test/helpers/fake-native-app.js) streams speech fixtures
// as AirPods deliver them in call mode (test/helpers/bt-audio.js: 8 kHz band,
// gated -80 dBFS floor, speech at the measured -31 dBFS, or -50 for soft
// speech) and the test scores what gpt-live-1 transcribed (word recall of the
// user captions), per condition:
//   clean    the fixtures as recorded (TTS, about -18 dBFS)
//   headset  AirPods-like, conversational level (-31 dBFS)
//   soft     AirPods-like, soft speech (-50 dBFS)
//   typing   headset speech with keyboard typing before and between the
//            utterances, as a real capture showed (`sotto debug capture`,
//            2026-09-25): the typing must not be learned as speech (the
//            uplink gain stays small, no can't-hear notice) and the words
//            must still be transcribed
// Then (unless SOTTO_BT_WAKE=0) a voice wake on the headset signal: idle
// sleep, a wake phrase at the headset level, the clip must be transcribed and
// the woken session must stay awake while live speech follows.
// Silent: no speakers, no microphone, no browser, no window.
// Cost: about 20-25 billed seconds per condition, plus about 25 for the wake.
// Never prints the API key or any token.
//
//   node test/e2e/native-bt.mjs
//   SOTTO_BT_CONDITIONS=clean,headset,soft   which conditions to run
//   SOTTO_BT_WAKE=0                          skip the wake scenario
//   SOTTO_E2E_KEEP=1                         keep the temp dirs (daemon logs)
//   SOTTO_BT_REPLAY=<raw.wav>                also replay a `sotto debug capture` raw WAV
//     [SOTTO_BT_REPLAY_FROM=s SOTTO_BT_REPLAY_TO=s]  (a part of it, in seconds)
//     [SOTTO_BT_REPLAY_PROFILE_DB=-49.8]    (start from a learned device level)
//     and print what gpt-live-1 transcribed, the gain and any can't-hear notice
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { createDaemon } from "../../daemon/index.js";
import { resolveApiKey } from "../../daemon/config.js";
import { startFakeInbox } from "../helpers/fake-inbox.js";
import { FakeNativeApp, bootstrap, readWavPcm24k } from "../helpers/fake-native-app.js";
import { bluetoothMic, bluetoothSilence, wordRecall, keyboardTyping } from "../helpers/bt-audio.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const FIX = (n) => path.join(REPO, "test", "fixtures", n);
const UTTERANCES = [
  { file: "decide-name.wav", text: "Sotto is a clever name. I think we should go with that one." },
  { file: "ask-later.wav", text: "Oh, and let me know when the auto restart is ready." },
  { file: "ask-files.wav", text: "Hey, can you ask Claude what files are in this project?" },
];
const WAKE = { file: "ask-count.wav", text: "Please count slowly from one to thirty for me." };
const CONDITIONS = {
  clean: null,
  headset: { speechDb: -31 },
  soft: { speechDb: -50 },
  typing: { speechDb: -31, typing: true },
  // Measurement only (not in the default run): where gpt-live-1 stops hearing.
  db40: { speechDb: -40 },
  db45: { speechDb: -45 },
};
const WANT = (process.env.SOTTO_BT_CONDITIONS || "clean,headset,soft,typing").split(",").map((s) => s.trim()).filter((s) => s in CONDITIONS);
const GAP_MS = 3000;
const LEAD_MS = 3000;
const TAIL_MS = 6000;
const BILLED_MAX_S = 150;

const results = [];
const log = (...a) => console.log("[bt-e2e]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " - " + detail : ""}`);
  return !!ok;
}
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function signal(cond, pcm) { return cond ? bluetoothMic(pcm, cond) : pcm; }
function quiet(cond, ms) {
  if (cond?.typing) return Buffer.concat([keyboardTyping(ms - 600, { seed: Math.round(ms) }), bluetoothSilence(600, cond)]);
  return cond ? bluetoothSilence(ms, cond) : Buffer.alloc(Math.round(ms * 24) * 2);
}

async function withDaemon(label, fn, { config = {}, micLevels = null } = {}) {
  const key = resolveApiKey({ env: process.env, pluginRoot: REPO });
  const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `clv-bt-${label}-`)));
  const SOCK = `/tmp/clv-bt-${process.pid}-${label}.sock`;
  const inbox = await startFakeInbox(SOCK);
  const port = await freePort();
  const env = {
    HOME: process.env.HOME, PATH: process.env.PATH, OPENAI_API_KEY: key,
    SOTTO_KEYCHAIN_SERVICE: `sotto-e2e-bt-${process.pid}`,
    SOTTO_VOCAB: "0", SOTTO_UPDATE: "0",
  };
  const chrome = { opened: 0, open() { this.opened++; return { mode: "none" }; }, async kill() { return 0; }, notify() {}, appStatus: () => ({ state: "ready" }) };
  if (micLevels) {
    fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
    fs.writeFileSync(path.join(TMP, "data", "mic-levels.json"), JSON.stringify(micLevels));
  }
  const d = createDaemon({ dataDir: path.join(TMP, "data"), port, pluginRoot: REPO, env, chrome, onExit: () => {} });
  await d.listen();
  let app = null;
  let billed = 0;
  try {
    const on = d.voice.control({ action: "on", session: { session_id: `bt-${label}`, socket: SOCK, token: `tok-${process.pid}`, cwd: REPO, project_dir: REPO }, config: { open_browser: false, ...config } });
    if (!on.ok) throw new Error(`voice on: ${on.state}`);
    const boot = await bootstrap({ port, secret: d.pageSecret });
    app = new FakeNativeApp({ port, pageToken: boot.page_token });
    await app.connect();
    billed = await fn({ d, app, inbox, logFile: path.join(TMP, "data", "logs", "daemon.log") });
  } finally {
    try { app?.stopMic(); } catch { /* ignore */ }
    try { if (d.voice.state !== "off") d.voice.off("user"); } catch { /* ignore */ }
    await sleep(1500);
    try { app?.close(); } catch { /* ignore */ }
    try { await d.close(); } catch { /* ignore */ }
    try { inbox.server.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(SOCK); } catch { /* ignore */ }
    if (process.env.SOTTO_E2E_KEEP === "1") log(`kept ${TMP}`);
    else fs.rmSync(TMP, { recursive: true, force: true });
  }
  return billed;
}

function readLog(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

async function closeAndBill(app) {
  const end = await app.cmd("end", {}).catch(() => null);
  const closed = await app.waitType("live", 10_000, (m) => m.event.type === "session.closed").catch(() => null);
  return end && closed ? Number(closed.event?.usage?.seconds) || 0 : 0;
}

/** One condition: the utterances in a row, scored by word recall of the user captions. */
async function runCondition(name) {
  const cond = CONDITIONS[name];
  return withDaemon(name, async ({ d, app, logFile }) => {
    const parts = [quiet(cond, LEAD_MS)];
    for (const u of UTTERANCES) parts.push(signal(cond, readWavPcm24k(FIX(u.file))), quiet(cond, GAP_MS));
    parts.push(quiet(cond, TAIL_MS));
    const started = app.waitType("live", 15_000, (m) => m.event.type === "session.started");
    app.startMic({ pcm: Buffer.concat(parts) });
    await started;
    const ms = (Buffer.concat(parts).length / 2 / 24000) * 1000;
    await sleep(ms);
    const heard = app.ofType("caption").filter((c) => c.role === "user").map((c) => c.text).join("");
    const recall = wordRecall(UTTERANCES.map((u) => u.text).join(" "), heard);
    check(`${name}: user speech transcribed`, name === "clean" ? recall >= 0.7 : recall >= 0.6, `recall ${(recall * 100).toFixed(0)} %: ${JSON.stringify(heard.trim().slice(0, 140))}`);
    if (cond?.typing) {
      const agc = d.voice.status().native?.agc || {};
      check("typing: not learned as speech (uplink gain stays small)", Number(agc.gain_db) < 10, JSON.stringify(agc));
      const lines = readLog(logFile);
      check("typing: no can't-hear notice", !lines.some((e) => e.ev === "page.cant_hear"), "");
      check("typing: reported as not speech", lines.some((e) => e.ev === "mic.not_speech"), "");
    }
    const billed = await closeAndBill(app);
    log(`${name}: billed ${billed} s`);
    return billed;
  });
}

/** A captured raw WAV (diagnosis): what gpt-live-1 made of it. Informational, no pass bar. */
async function runReplay(file) {
  const all = readWavPcm24k(file);
  const from = Math.round(Number(process.env.SOTTO_BT_REPLAY_FROM || 0) * 24000) * 2;
  const to = process.env.SOTTO_BT_REPLAY_TO ? Math.round(Number(process.env.SOTTO_BT_REPLAY_TO) * 24000) * 2 : all.length;
  const pcm = Buffer.concat([all.subarray(from, to), Buffer.alloc(24000 * 2 * 4)]);
  const prof = Number(process.env.SOTTO_BT_REPLAY_PROFILE_DB);
  const INPUT = "Fake Mic";
  const micLevels = Number.isFinite(prof) ? { devices: { [INPUT]: { speech_db: prof, floor_db: -80, utterances: 50, updated: 1, method: "voiced" } } } : null;
  return withDaemon("replay", async ({ d, app, logFile }) => {
    const dev = { name: INPUT, bluetooth: true, headphones: false };
    app.sendJson({ type: "route", mode: "split", input: dev, output: { ...dev, headphones: true }, echo_cancellation: "automatic" });
    const started = app.waitType("live", 15_000, (m) => m.event.type === "session.started");
    app.startMic({ pcm });
    await started;
    await sleep((pcm.length / 2 / 24000) * 1000);
    const heard = app.ofType("caption").filter((c) => c.role === "user").map((c) => c.text).join("").trim();
    const lines = readLog(logFile);
    const gains = lines.filter((e) => e.ev === "native.audio").map((e) => e.gain_db);
    log(`replay: transcribed ${JSON.stringify(heard.slice(0, 400))}`);
    log(`replay: gain_db over time ${JSON.stringify(gains)}, final ${JSON.stringify(d.voice.status().native?.agc)}`);
    log(`replay: can't-hear ${lines.filter((e) => e.ev === "page.cant_hear").length}, utterances learned ${lines.filter((e) => e.ev === "mic.calibrate").length}, not speech ${lines.filter((e) => e.ev === "mic.not_speech").length}`);
    const billed = await closeAndBill(app);
    log(`replay: billed ${billed} s`);
    return billed;
  }, { micLevels });
}

/** Voice wake on the headset signal: the clip is transcribed and live speech keeps the session awake. */
async function runWake() {
  const cond = CONDITIONS.headset;
  return withDaemon("wake", async ({ d, app, logFile }) => {
    app.startMic({ pcm: quiet(cond, 60_000) });
    await app.waitType("live", 15_000, (m) => m.event.type === "session.started");
    const slept = await app.waitFor(() => d.voice.state === "sleeping", 40_000, "sleeping").catch(() => null);
    if (!check("wake: idle sleep", !!slept, d.voice.state)) return closeAndBill(app);
    await sleep(2000); // the detector's warm-up
    const wakePcm = signal(cond, readWavPcm24k(FIX(WAKE.file)));
    // The wake phrase, a short pause, then more speech (as a user who keeps talking).
    const follow = signal(cond, readWavPcm24k(FIX(UTTERANCES[2].file)));
    const t0 = Date.now();
    app.startMic({ pcm: Buffer.concat([wakePcm, quiet(cond, 2500), follow, quiet(cond, 30_000)]) });
    const trig = await app.waitFor(() => readLog(logFile).find((e) => e.ev === "wake.trigger"), 10_000, "trigger").catch(() => null);
    check("wake: triggered at the headset level", !!trig, trig ? `after ${Date.now() - t0} ms, level ${trig.level_db} dBFS` : "");
    const tr = await app.waitFor(() => readLog(logFile).find((e) => e.ev === "wake.transcribe"), 15_000, "transcribe").catch(() => null);
    check("wake: the clip is transcribed", tr && tr.chars > 0, tr ? JSON.stringify(tr.text) : "no wake.transcribe");
    await sleep(20_000);
    const closes = readLog(logFile).filter((e) => e.ev === "idle.close" && Date.parse(e.ts) >= t0);
    check("wake: the woken session stays awake while the user talks", !closes.length && d.voice.state === "live", closes.map((c) => c.detail).join(",") || d.voice.state);
    return closeAndBill(app);
  }, { config: { idle_seconds: 8, wake_sensitivity: "medium" } });
}

async function main() {
  const key = resolveApiKey({ env: process.env, pluginRoot: REPO });
  if (!key) { log("SKIP: no OPENAI_API_KEY (env or .env)"); process.exit(2); }
  const t0 = Date.now();
  let billed = 0;
  try {
    for (const c of WANT) billed += await runCondition(c);
    if (process.env.SOTTO_BT_REPLAY) billed += await runReplay(process.env.SOTTO_BT_REPLAY);
    if (process.env.SOTTO_BT_WAKE !== "0") billed += await runWake();
  } catch (e) {
    check("no exception", false, String(e && e.stack || e));
  }
  check(`billed <= ${BILLED_MAX_S} s`, billed <= BILLED_MAX_S, `${billed} s`);
  const failed = results.filter((r) => !r.ok);
  log(`${results.length - failed.length}/${results.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  process.exit(failed.length ? 1 : 0);
}

main();
