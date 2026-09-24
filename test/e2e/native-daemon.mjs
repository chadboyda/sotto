#!/usr/bin/env node
// Native-path smoke test against the REAL gpt-live-1 (docs/NATIVE.md §6, B2 (e)).
//
// The daemon owns the Live primary WebSocket; a Node fake native app
// (test/helpers/fake-native-app.js) is the audio client over /api/native:
//   daemon (in-process, temp data dir, fake inbox socket as the owner)
//   fake app: bootstrap with page.secret, hello/welcome, mic = ask-files.wav
//   gpt-live-1 hears the request and delegates -> the fake inbox gets it
//   the model's voice arrives as speaker frames (captured, never played)
//   cmd end -> session.closed (close_requested)
// Silent: no speakers, no microphone, no browser, no window.
// Cost: one short Live session, about 12-20 billed seconds (hard cap 25 s of
// billing is asserted; wall time capped at 60 s).
// Never prints the API key or any token.
//
//   node test/e2e/native-daemon.mjs
//   SOTTO_E2E_KEEP=1      keep the temp dir (daemon log) for inspection
//   SOTTO_E2E_LEAD_MS     silence before the question (default 3500)
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
const FIXTURE = path.join(REPO, "test", "fixtures", "ask-files.wav");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clv-native-e2e-")));
const D = path.join(TMP, "data");
const SOCK = `/tmp/clv-ne2e-${process.pid}.sock`;
const LEAD_MS = Number(process.env.SOTTO_E2E_LEAD_MS || 3500);
const WALL_BUDGET_MS = 60_000;
const BILLED_MAX_S = 25;

const results = [];
const log = (...a) => console.log("[native-e2e]", ...a);
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

async function main() {
  const key = resolveApiKey({ env: process.env, pluginRoot: REPO });
  if (!key) { log("SKIP: no OPENAI_API_KEY (env or .env)"); process.exit(2); }
  const inbox = await startFakeInbox(SOCK);
  const port = await freePort();
  const env = {
    HOME: process.env.HOME, PATH: process.env.PATH, OPENAI_API_KEY: key,
    SOTTO_KEYCHAIN_SERVICE: `sotto-e2e-native-${process.pid}`, // never the user's real Keychain item
    SOTTO_VOCAB: "0", SOTTO_UPDATE: "0",
  };
  // No window at all: the fake app is the client.
  const chrome = { opened: 0, open() { this.opened++; return { mode: "none" }; }, async kill() { return 0; }, notify() {}, appStatus: () => ({ state: "ready" }) };
  const d = createDaemon({ dataDir: D, port, pluginRoot: REPO, env, chrome, onExit: () => {} });
  await d.listen();
  log(`daemon on ${port}, data ${D}`);
  let app;
  const t0 = Date.now();
  const wall = setTimeout(() => { check("finished within the wall budget", false, `${WALL_BUDGET_MS / 1000} s`); finish(1); }, WALL_BUDGET_MS);
  let finished = false;
  async function finish(code) {
    if (finished) return;
    finished = true;
    clearTimeout(wall);
    try { app?.close(); } catch { /* ignore */ }
    try { if (d.voice.state !== "off") d.voice.off("user"); } catch { /* ignore */ }
    await sleep(1500);
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
    const on = d.voice.control({ action: "on", session: { session_id: "e2e", socket: SOCK, token: `tok-${process.pid}`, cwd: REPO, project_dir: REPO }, config: { open_browser: false } });
    check("voice on", on.ok, on.state);
    const boot = await bootstrap({ port, secret: d.pageSecret });
    app = new FakeNativeApp({ port, pageToken: boot.page_token });
    const welcome = await app.connect();
    check("welcome", welcome.protocol === 1 && welcome.status.audio_client === "app");
    app.startMic({ pcm: readWavPcm24k(FIXTURE), leadMs: LEAD_MS });
    const started = await app.waitType("live", 15_000, (m) => m.event.type === "session.started").catch(() => null);
    const tStart = Date.now();
    check("session.started on the primary socket", !!started, started ? `${((tStart - t0) / 1000).toFixed(1)} s after on` : "");
    if (!started) return finish(1);
    // The greeting, then the question: a delegation must reach the inbox.
    const delegated = await app.waitFor(() => inbox.frames.length > 0, 25_000, "delegation").catch(() => null);
    check("delegation reaches the fake inbox", !!delegated, delegated ? `${((Date.now() - tStart) / 1000).toFixed(1)} s after start, ${inbox.frames.length} frame(s)` : "");
    const peak = pcmPeak(app.speakerPcm());
    check("speaker frames hold speech", peak > 1200, `peak ${peak}, ${app.speaker.length} frames`);
    const said = app.ofType("caption").filter((c) => c.role === "assistant").map((c) => c.text).join("");
    check("assistant captions", said.trim().length > 0, JSON.stringify(said.slice(0, 80)));
    const heard = app.ofType("caption").filter((c) => c.role === "user").map((c) => c.text).join("");
    check("user captions", /file/i.test(heard), JSON.stringify(heard.slice(0, 80)));
    // Clean close.
    const end = await app.cmd("end", {});
    check("cmd end", end.ok);
    const closed = await app.waitType("live", 10_000, (m) => m.event.type === "session.closed").catch(() => null);
    const billed = Number(closed?.event?.usage?.seconds);
    check("session.closed close_requested", closed?.event?.reason === "close_requested", closed ? `reason ${closed.event.reason}` : "none");
    check(`billed <= ${BILLED_MAX_S} s`, Number.isFinite(billed) && billed <= BILLED_MAX_S, `${billed} s`);
    check("audio_flush off, then close_window", app.ofType("audio_flush").some((m) => m.reason === "off") && app.ofType("command").some((c) => c.command === "close_window"));
    const st = d.voice.status();
    log(`pacer: ${JSON.stringify(st.native.pacer)}; speaker frames ${st.native.counters.speaker_frames}, dropped ${st.native.counters.speaker_dropped}`);
    return finish();
  } catch (e) {
    check("no exception", false, String(e && e.message));
    return finish(1);
  }
}

main();
