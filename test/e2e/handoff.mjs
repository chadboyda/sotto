#!/usr/bin/env node
// Handoff guard end to end against the REAL gpt-live-1 (SPEC §6.20).
//
// The live log of 2026-09-28: a voice wake on a question ("How's it looking?")
// got a spoken "passing that to Claude" and no delegation, and the voice then
// slept before Claude's answer. Here, on the native path (the daemon owns the
// Live primary WebSocket, a Node fake app is the audio client, a fake inbox is
// Claude Code):
//   1. voice on, idle sleep;
//   2. a voice wake on "How's it looking?" (the whole question fits in the
//      wake clip, so the model only ever reads it): the words must reach the
//      fake inbox as a request (a delegation or the daemon's own fallback);
//   3. Claude picks it up (UserPromptSubmit) and works longer than the idle
//      window: the voice stays awake for the (shortened) wait bound, then sleeps;
//   4. Claude's Stop arrives while it sleeps: a notify wake, and the answer is
//      spoken (assistant captions and speaker frames).
// Silent: no speakers, no microphone, no browser, no window, no privacy prompt.
// Cost: three short Live sessions, about 50-70 billed seconds.
// Never prints the API key or any token.
//
//   node test/e2e/handoff.mjs
//   SOTTO_E2E_KEEP=1      keep the temp dir (daemon log) for inspection
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { createDaemon } from "../../daemon/index.js";
import { resolveApiKey } from "../../daemon/config.js";
import { startFakeInbox } from "../helpers/fake-inbox.js";
import { FakeNativeApp, bootstrap, readWavPcm24k, pcmPeak } from "../helpers/fake-native-app.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const QUESTION = path.join(REPO, "test", "fixtures", "ask-looking.wav"); // "How's it looking?"
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clv-handoff-e2e-")));
const D = path.join(TMP, "data");
const LOG = path.join(D, "logs", "daemon.log");
const SOCK = `/tmp/clv-ho-${process.pid}.sock`;
const IDLE_S = 8;
const WAIT_BOUND_MS = 12_000; // SOTTO_VOICE_WAIT_MS: the 10 min hold, shortened
const ANSWER = "The build is green and all 42 tests pass.";
const WALL_BUDGET_MS = 180_000;
const BILLED_MAX_S = 110;

const results = [];
const log = (...a) => console.log("[handoff-e2e]", ...a);
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
function readLog() {
  try {
    return fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
const silence = (ms) => Buffer.alloc(Math.round(ms * 24) * 2);
const userText = (f) => f?.message?.content;
/** Poll pred() every 200 ms (the log and the state change without a message to the app). */
async function poll(pred, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v = null;
    try { v = pred(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(200);
  }
}

async function main() {
  const key = resolveApiKey({ env: process.env, pluginRoot: REPO });
  if (!key) { log("SKIP: no OPENAI_API_KEY (env or .env)"); process.exit(2); }
  const inbox = await startFakeInbox(SOCK);
  const port = await freePort();
  const env = {
    HOME: process.env.HOME, PATH: process.env.PATH, OPENAI_API_KEY: key,
    SOTTO_KEYCHAIN_SERVICE: `sotto-e2e-handoff-${process.pid}`, // never the user's real Keychain item
    SOTTO_VOCAB: "0", SOTTO_UPDATE: "0", SOTTO_VOICE_WAIT_MS: String(WAIT_BOUND_MS),
  };
  const chrome = { opened: 0, open() { this.opened++; return { mode: "none" }; }, async kill() { return 0; }, notify() {}, appStatus: () => ({ state: "ready" }) };
  const d = createDaemon({ dataDir: D, port, pluginRoot: REPO, env, chrome, onExit: () => {} });
  await d.listen();
  log(`daemon on ${port}, data ${D}`);
  let app;
  const t0 = Date.now();
  const billed = new Map(); // live id → seconds
  const wall = setTimeout(() => { check("finished within the wall budget", false, `${WALL_BUDGET_MS / 1000} s`); finish(1); }, WALL_BUDGET_MS);
  let finished = false;
  async function finish(code) {
    if (finished) return;
    finished = true;
    clearTimeout(wall);
    try { app?.stopMic(); } catch { /* ignore */ }
    try { if (d.voice.state !== "off") d.voice.off("user"); } catch { /* ignore */ }
    await sleep(2000);
    for (const e of readLog()) if (e.ev === "session.closed" && Number.isFinite(Number(e.seconds))) billed.set(e.live_id, Number(e.seconds));
    const total = [...billed.values()].reduce((a, b) => a + b, 0);
    check(`billed <= ${BILLED_MAX_S} s`, total <= BILLED_MAX_S, `${total} s over ${billed.size} session(s)`);
    try { app?.close(); } catch { /* ignore */ }
    try { await d.close(); } catch { /* ignore */ }
    try { inbox.server.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(SOCK); } catch { /* ignore */ }
    const failed = results.filter((r) => !r.ok);
    log(`${results.length - failed.length}/${results.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (process.env.SOTTO_E2E_KEEP === "1") log(`kept ${TMP}`);
    else fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(code ?? (failed.length ? 1 : 0));
  }

  try {
    const on = d.voice.control({
      action: "on", session: { session_id: "e2e-handoff", socket: SOCK, token: `tok-${process.pid}`, cwd: REPO, project_dir: REPO },
      config: { open_browser: false, idle_seconds: IDLE_S, wake_sensitivity: "medium" },
    });
    check("voice on", on.ok, on.state);
    const boot = await bootstrap({ port, secret: d.pageSecret });
    app = new FakeNativeApp({ port, pageToken: boot.page_token });
    await app.connect();
    app.startMic({ pcm: silence(60_000) });
    const started = await app.waitType("live", 15_000, (m) => m.event.type === "session.started").catch(() => null);
    if (!check("first session live", !!started)) return finish(1);

    // 1. Idle sleep.
    const slept = await poll(() => d.voice.state === "sleeping", 40_000);
    if (!check("idle sleep", !!slept, d.voice.state)) return finish(1);
    await sleep(2000); // the wake detector's warm-up

    // 2. Voice wake on the question; nothing is said after it.
    const tWake = Date.now();
    const nCapWake = app.ofType("caption").length;
    app.startMic({ pcm: Buffer.concat([readWavPcm24k(QUESTION), silence(120_000)]) });
    const tr = await poll(() => readLog().find((e) => e.ev === "wake.transcribe" && Date.parse(e.ts) >= tWake), 20_000);
    check("the wake clip is transcribed", tr && /look/i.test(tr.text || ""), tr ? JSON.stringify(tr.text) : "none");
    const inj = readLog().find((e) => e.ev === "wake.inject" && Date.parse(e.ts) >= tWake);
    check("the clip is routed as a request", inj?.route === true, JSON.stringify(inj || null));
    const req = await poll(() => inbox.frames.find((f) => f.type === "user" && f.priority === "next" && /look/i.test(userText(f) || "")), 20_000);
    const tReq = Date.now();
    check("the question reaches the fake inbox as a request", !!req, req ? `${((tReq - tWake) / 1000).toFixed(1)} s after the wake, ${JSON.stringify(userText(req).slice(0, 80))}` : `frames: ${JSON.stringify(inbox.frames.map((f) => userText(f)).filter(Boolean))}`);
    if (!req) return finish(1);
    const lines = readLog().filter((e) => Date.parse(e.ts) >= tWake);
    const how = lines.find((e) => e.ev === "handoff.fallback") ? `fallback (${lines.find((e) => e.ev === "handoff.fallback").reason})` : lines.some((e) => e.ev === "delegation" && e.to === "collecting" && !e.synthetic) ? "delegation" : "?";
    log(`sent by: ${how}; the voice said: ${JSON.stringify(app.ofType("caption").slice(nCapWake).filter((c) => c.role === "assistant").map((c) => c.text).join("").trim().slice(0, 160))}`);
    const requests = inbox.frames.filter((f) => f.type === "user" && f.priority === "next");
    check("sent once", requests.length === 1, `${requests.length} request(s)`);

    // 3. Claude picks it up and works past the idle window: the voice stays awake.
    d.voice.handleHook("UserPromptSubmit", { prompt: userText(req), prompt_id: "e2e-p1", session_id: "e2e-handoff" }, SOCK);
    await sleep(IDLE_S * 1000 + 3000);
    check("awake while Claude works past the idle window", d.voice.state === "live", d.voice.state);
    const sleptAgain = await poll(() => d.voice.state === "sleeping", WAIT_BOUND_MS + 20_000);
    const tSlept = Date.now();
    check("sleeps once the wait bound has passed", !!sleptAgain, `${((tSlept - tReq) / 1000).toFixed(1)} s after the request (bound ${WAIT_BOUND_MS / 1000} s)`);
    if (!sleptAgain) return finish(1);
    await sleep(1500);

    // 4. The answer arrives while it sleeps: it wakes and says it.
    const nCaptions = app.ofType("caption").length;
    const nSpeaker = app.speaker.length;
    d.voice.handleHook("Stop", { last_assistant_message: ANSWER, prompt_id: "e2e-p1", session_id: "e2e-handoff" }, SOCK);
    const woke = await poll(() => readLog().some((e) => e.ev === "wake.request" && Date.parse(e.ts) >= tSlept), 10_000);
    check("the reply wakes the voice (notify)", !!woke);
    const spoken = await poll(() => /42|forty|green/i.test(app.ofType("caption").slice(nCaptions).filter((c) => c.role === "assistant").map((c) => c.text).join("")), 30_000);
    const said = app.ofType("caption").slice(nCaptions).filter((c) => c.role === "assistant").map((c) => c.text).join("").trim();
    check("the answer is spoken", !!spoken, JSON.stringify(said.slice(0, 160)));
    await sleep(2000);
    const peak = pcmPeak(Buffer.concat(app.speaker.slice(nSpeaker)));
    check("speaker frames hold speech", peak > 1200, `peak ${peak}`);
    const end = await app.cmd("end", {}).catch(() => null);
    await app.waitType("live", 10_000, (m) => m.event.type === "session.closed").catch(() => null);
    check("cmd end", !!end?.ok);
    return finish();
  } catch (e) {
    check("no exception", false, String(e && e.stack || e));
    return finish(1);
  }
}

main();
