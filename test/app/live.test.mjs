// Desktop app against the REAL gpt-live-1 (opt-in):
//   SOTTO_APP_LIVE=1 npm run test:app          (two sessions, about 35 billed seconds)
//   SOTTO_APP_LIVE=1 SOTTO_APP_ECHO=1 ...      (+ the echo measurement, about 40 more; SOTTO_ECHO_GUARD=off|auto|on picks the page's echo guard)
// The daemon (in-process, temp data dir, spare port, fake inbox) opens the
// window through the real chooser (daemon/window.js, SOTTO_BROWSER=app),
// the app loads the page, WebKit's WebRTC connects to OpenAI, the session goes
// live, and voice off closes the panel and quits the app. Microphones:
//   1. WebKit's mock mic (the WebKit capture path, used on speakers);
//   2. the app's native mic (the headphones path) fed with the TTS fixture:
//      gpt-live-1 must transcribe the question;
//   3. (SOTTO_APP_ECHO=1) the native mic plus the model's own voice mixed back
//      in at -10 dB / 40 ms, i.e. speakers without echo cancellation: how much
//      of a long answer survives before the model hears itself.
import { test } from "node:test";
import assert from "node:assert/strict";
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE = process.env.SOTTO_APP_LIVE === "1";
// The daemon opens the app through LaunchServices (`open -a <bundle> sotto://…`),
// and the app is single-instance per bundle id: with the user's own Sotto
// running, the test's window would load in THEIR panel. Never run then.
const userAppRunning = () => process.platform === "darwin" &&
  (spawnSync("ps", ["-axo", "args="], { encoding: "utf8" }).stdout || "").split("\n")
    .some((l) => /Sotto\.app\/Contents\/MacOS\/Sotto/.test(l) && !l.includes(os.tmpdir()) && !l.startsWith("/private/var/folders/"));
const SKIP = !LIVE ? "set SOTTO_APP_LIVE=1 (real gpt-live-1 session)"
  : process.platform !== "darwin" ? "macOS only"
  : userAppRunning() ? "a Sotto app is running (quit it first: its panel would receive the test window)"
  : !resolveApiKey({ env: process.env, pluginRoot: ROOT, dataDir: os.tmpdir() }) ? "no OPENAI_API_KEY" : false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}
const ECHO = process.env.SOTTO_APP_ECHO === "1";
const ECHO_DB = process.env.SOTTO_APP_ECHO_DB || "-10";
const FIXTURE = path.join(ROOT, "test", "fixtures", "ask-files.wav");
const readJsonl = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };


/**
 * One live session through the app. `env` adds app test settings; `during(ctx)`
 * runs once the session is live. Returns what the caller asserts on.
 */
async function runLive(name, env, during) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sotto-app-live-")));
  const D = path.join(tmp, "data");
  const appLog = path.join(tmp, "app.jsonl");
  // Build (incrementally) straight into this data dir, as the daemon would.
  const b = spawnSync("/bin/bash", [path.join(ROOT, "scripts/build-app.sh"), "--out", appPaths(D, ROOT).dir, "--quiet"], { encoding: "utf8" });
  assert.equal(b.status, 0, b.stderr);
  const sock = `/tmp/clv-app-${process.pid}-${name}.sock`;
  const inbox = await startFakeInbox(sock);
  const port = await freePort();
  const d = createDaemon({
    dataDir: D, port, pluginRoot: ROOT,
    env: { ...process.env, SOTTO_BROWSER: "app", SOTTO_APP_TEST: "1", SOTTO_APP_DEBUG_LOG: appLog, SOTTO_NO_BROWSER: "", ...env },
  });
  await d.listen();
  const ctl = (body) => fetch(`http://127.0.0.1:${port}/control`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Sotto-Key": d.daemonKey }, body: JSON.stringify(body),
  }).then((r) => r.json());
  const hook = (event, body) => fetch(`http://127.0.0.1:${port}/hook/${event}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Sotto-Key": d.daemonKey, "X-Sotto-Socket": sock }, body: JSON.stringify(body),
  });
  const daemonLog = () => readJsonl(path.join(D, "logs", "daemon.log"));
  let appPid = null;
  const t0 = Date.now();
  const out = { name };
  try {
    const on = await ctl({ action: "on", session: { session_id: `app-${name}`, socket: sock, token: "t", cwd: ROOT, project_dir: ROOT }, config: { open_browser: true } });
    assert.equal(on.ok, true, on.message);
    const launch = await waitFor(() => readJsonl(appLog).find((e) => e.ev === "launch"), 20_000, "app launch");
    appPid = launch.pid;
    await waitFor(() => d.voice.state === "live", 45_000, "live session");
    out.liveMs = Date.now() - t0;
    assert.ok(readJsonl(appLog).some((e) => e.ev === "bridge" && e.kind === "live" && e.live === true), "session.started seen by the app");
    assert.ok(readJsonl(appLog).some((e) => e.ev === "bridge" && e.kind === "silenced" && e.ok === true), "test mode mutes the model's voice (never the speakers)");
    assert.match(fs.readFileSync(path.join(D, "logs", "daemon.log"), "utf8"), /"ev":"window.choose"[^\n]*"mode":"app"/);
    if (during) await during({ d, inbox, hook, daemonLog, appLog: () => readJsonl(appLog), out });
    const icons = readJsonl(appLog).filter((e) => e.ev === "icon").map((e) => e.state);
    assert.ok(icons.some((s) => ["listening", "assistantSpeaking", "userSpeaking", "working", "muted"].includes(s)), `icon states: ${icons}`);
    out.icons = [...new Set(icons)];
    const off = await ctl({ action: "off" });
    assert.equal(off.ok, true);
    await waitFor(() => !pidAlive(appPid), 15_000, "app quits after voice off");
    out.billed = d.voice.status().today?.seconds;
    out.appEvents = readJsonl(appLog);
    return out;
  } finally {
    if (appPid && pidAlive(appPid)) process.kill(appPid, "SIGTERM");
    await ctl({ action: "off" }).catch(() => {});
    await sleep(500);
    await d.close();
    await inbox.close?.();
    if (!process.env.SOTTO_E2E_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
    else console.log(`# kept ${tmp}`);
  }
}

test("app window goes live with gpt-live-1 and quits on voice off (WebKit mock mic)", { skip: SKIP, timeout: 150_000 }, async () => {
  const r = await runLive("webkit", {}, async ({ appLog }) => {
    assert.ok(appLog().some((e) => e.ev === "bridge" && e.kind === "mic" && e.ok === true && e.echoCancellation === true && e.source === "webkit"), "WebKit mic with echo cancellation");
    await sleep(2500);
  });
  console.log(`# webkit mic: live in ${(r.liveMs / 1000).toFixed(1)} s; icons: ${r.icons.join(",")}; billed ${r.billed} s`);
});

const transcript = (log, ev, from = 0) => log().filter((e) => e.ev === ev && Date.parse(e.ts) >= from).map((e) => e.delta || "").join("");

test("native mic: gpt-live-1 hears the app's own capture (fixture)", { skip: SKIP, timeout: 150_000 }, async () => {
  const r = await runLive("native", { SOTTO_APP_MIC: "native", SOTTO_APP_MIC_FIXTURE: FIXTURE, SOTTO_APP_MIC_FIXTURE_LEAD_MS: "1500" }, async ({ daemonLog, appLog, out }) => {
    assert.ok(appLog().some((e) => e.ev === "bridge" && e.kind === "mic" && e.ok === true && e.source === "native"), "native mic");
    assert.ok(!appLog().some((e) => e.ev === "media_permission"), "WebKit capture never opened");
    const heard = await waitFor(() => { const t = transcript(daemonLog, "session.input_transcript.delta"); return /files/i.test(t) ? t : null; }, 30_000, "input transcript");
    out.heard = heard.trim();
    await sleep(2500); // a stats report or two
  });
  const stats = r.appEvents.filter((e) => e.ev === "native_mic_stats" && e.transportMs != null);
  const p95 = Math.max(...stats.map((e) => e.transportP95Ms));
  const q = stats.filter((e) => e.queueMs != null).map((e) => e.queueMs);
  assert.ok(Math.max(...q.slice(1)) < 45, `worklet queue stays short: ${q.join("/")} ms`);
  const under = Math.max(0, ...stats.map((e) => e.underruns ?? 0));
  assert.ok(p95 < 60, `transport p95 ${p95} ms`);
  console.log(`# native mic: live in ${(r.liveMs / 1000).toFixed(1)} s; heard ${JSON.stringify(r.heard.slice(0, 80))}; transport mean ${stats.map((e) => e.transportMs).join("/")} ms, p95 max ${p95} ms; worklet queue ${q.join("/")} ms; underruns ${under}; billed ${r.billed} s`);
});

const LONG_ANSWER = "Here is the summary. The daemon folder holds the voice orchestrator, the delegation tracker, the speech policy and the transcript store. "
  + "The web folder holds the voice page, the dial and the pure view models. The scripts folder holds the hook forwarder, the toggle handler and the app build script. "
  + "The test folder holds unit tests for every module, the end to end smoke test and the fixtures, one of which is called banana split. That is everything.";

test("echo measurement: native mic without echo cancellation on simulated speakers", { skip: SKIP || (!ECHO && "set SOTTO_APP_ECHO=1"), timeout: 180_000 }, async () => {
  const r = await runLive("echo", { SOTTO_APP_MIC: "native", SOTTO_APP_MIC_FIXTURE: FIXTURE, SOTTO_APP_MIC_FIXTURE_LEAD_MS: "1500", SOTTO_APP_ECHO_SIM_DB: ECHO_DB }, async ({ d, inbox, hook, daemonLog, out }) => {
    await waitFor(() => inbox.frames.find((f) => f.type === "user"), 40_000, "delegation reaches the inbox");
    const u = inbox.frames.find((f) => f.type === "user");
    const content = typeof u.message?.content === "string" ? u.message.content : JSON.stringify(u.message?.content);
    await hook("UserPromptSubmit", { session_id: "app-echo", prompt_id: "echo-p1", hook_event_name: "UserPromptSubmit", prompt: content });
    await sleep(500);
    const tStop = Date.now();
    await hook("Stop", { session_id: "app-echo", prompt_id: "echo-p1", hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: LONG_ANSWER, background_tasks: [], session_crons: [] });
    // Let it speak (about 25 s for the full answer), then read what happened.
    await waitFor(() => /everything/i.test(transcript(daemonLog, "session.output_transcript.delta", tStop)) || Date.now() - tStop > 35_000, 40_000, "answer spoken or 35 s");
    await sleep(3000);
    out.spoken = transcript(daemonLog, "session.output_transcript.delta", tStop).trim();
    out.heardDuring = transcript(daemonLog, "session.input_transcript.delta", tStop).trim();
    out.delegations = d.voice.status().delegations?.length ?? null;
    // The page's echo measurement and guard (SPEC §7.7) run in WKWebView too.
    await sleep(1000);
    out.echo = daemonLog().filter((e) => /^echo\./.test(e.ev) || (e.ev === "page.log" && /echo:/.test(e.message || "")));
  });
  const words = (t) => t.split(/\s+/).filter(Boolean).length;
  const echoEv = r.appEvents.filter((e) => e.ev === "native_mic_stats" && e.echoSim === true).length;
  const echoDb = Math.max(...r.appEvents.filter((e) => e.ev === "native_mic_stats" && e.echoDb != null).map((e) => e.echoDb));
  // A measurement, reported either way; only the mechanics are asserted.
  assert.ok(echoEv > 0, "echo simulation attached");
  assert.ok(echoDb > -60, `the echo is really in the mic signal (peak ${echoDb} dBFS)`);
  console.log(`# echo sim ${ECHO_DB} dB/40 ms (echo peak ${echoDb} dBFS in the mic): spoke ${words(r.spoken)}/${words(LONG_ANSWER)} words of the answer; `
    + `own voice heard as user: ${JSON.stringify(r.heardDuring.slice(0, 160))}; delegations ${r.delegations}; billed ${r.billed} s`);
  console.log(`# spoken: ${JSON.stringify(r.spoken.slice(0, 400))}`);
  const leak = r.echo.filter((e) => e.ev === "echo.leak");
  const guard = r.echo.filter((e) => e.ev === "echo.guard");
  assert.ok(r.echo.some((e) => e.ev === "page.log" && /echo: measuring/.test(e.message)), "the page's echo worklet runs in the app");
  console.log(`# page echo (guard ${process.env.SOTTO_ECHO_GUARD || "auto"}): leak ${leak.map((e) => `${e.level} ${e.leak_db} dB corr ${e.corr}`).join(", ") || "none"}; guard ${guard.map((e) => `${e.engaged ? "on" : "off"} (${e.reason})`).join(", ") || "never"}`);
});
