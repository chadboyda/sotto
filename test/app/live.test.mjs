// Native desktop app against the REAL gpt-live-1 (opt-in, docs/NATIVE.md M2):
//   SOTTO_APP_LIVE=1 npm run test:app          (one session, 40 billed seconds or less)
// The daemon (in-process, temp data dir, spare port, fake inbox) opens the
// window through the real chooser (daemon/window.js, SOTTO_BROWSER=app). The
// app runs in test mode under the test bundle id: FakeAudioIO streams the TTS
// fixture as the mic and writes the model's voice to a WAV (never the
// speakers). The daemon owns the Live primary WebSocket: the question must
// reach Claude (the fake inbox), the output WAV must hold speech, and voice
// off must close and quit the app.
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
// Unique per run: LaunchServices hands `open -a <path> sotto://…` to an already
// running app with the same bundle id, so two concurrent test runs sharing one
// id steal each other's app (seen in integration). Never the user's own id.
const LS_ID = `com.chadboyda.sotto.apptest.${process.pid}`;
const SKIP = !LIVE ? "set SOTTO_APP_LIVE=1 (real gpt-live-1 session)"
  : process.platform !== "darwin" ? "macOS only"
  : !resolveApiKey({ env: process.env, pluginRoot: ROOT, dataDir: os.tmpdir() }) ? "no OPENAI_API_KEY" : false;
const MAX_BILLED_S = 40;
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
const FIXTURE = path.join(ROOT, "test", "fixtures", "ask-files.wav");
const readJsonl = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Peak |sample| of a PCM16 mono WAV (the data chunk found by name). */
function wavPeak(file) {
  const b = fs.readFileSync(file);
  let off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "data") {
      let peak = 0;
      for (let i = off + 8; i + 1 < Math.min(b.length, off + 8 + size); i += 2) peak = Math.max(peak, Math.abs(b.readInt16LE(i)));
      return { peak, seconds: size / 2 / 24000 };
    }
    off += 8 + size + (size & 1);
  }
  return { peak: 0, seconds: 0 };
}

test("native app: live session through the daemon, delegation, speech in the output WAV, quits on voice off", { skip: SKIP, timeout: 180_000 }, async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sotto-app-live-")));
  const D = path.join(tmp, "data");
  const appLog = path.join(tmp, "app.jsonl");
  const outWav = path.join(tmp, "out.wav");
  const p = appPaths(D, ROOT);
  // Build (incrementally) as the daemon would, then give the bundle the test
  // id: LaunchServices must never hand this URL to the user's own Sotto.
  const b = spawnSync("/bin/bash", [path.join(ROOT, "scripts/build-app.sh"), "--out", p.dir, "--quiet"], { encoding: "utf8" });
  assert.equal(b.status, 0, b.stderr);
  for (const [cmd, args] of [["plutil", ["-replace", "CFBundleIdentifier", "-string", LS_ID, path.join(p.bundle, "Contents/Info.plist")]],
    ["codesign", ["--force", "--sign", "-", "--identifier", LS_ID, p.bundle]]]) {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  const sock = `/tmp/clv-app-${process.pid}.sock`;
  const inbox = await startFakeInbox(sock);
  const port = await freePort();
  const d = createDaemon({
    dataDir: D, port, pluginRoot: ROOT,
    env: {
      ...process.env, SOTTO_BROWSER: "app", SOTTO_APP_TEST: "1", SOTTO_APP_DEBUG_LOG: appLog, SOTTO_NO_BROWSER: "", SOTTO_APP_DOWNLOAD: "0",
      SOTTO_APP_MIC_FIXTURE: FIXTURE, SOTTO_APP_MIC_FIXTURE_LEAD_MS: "1500", SOTTO_APP_OUT_WAV: outWav,
    },
  });
  await d.listen();
  const ctl = (body) => fetch(`http://127.0.0.1:${port}/control`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Sotto-Key": d.daemonKey }, body: JSON.stringify(body),
  }).then((r) => r.json());
  let appPid = null;
  const t0 = Date.now();
  try {
    const on = await ctl({ action: "on", session: { session_id: "app-live", socket: sock, token: "t", cwd: ROOT, project_dir: ROOT }, config: { open_browser: true } });
    assert.equal(on.ok, true, on.message);
    const launch = await waitFor(() => readJsonl(appLog).find((e) => e.ev === "launch"), 20_000, "app launch");
    appPid = launch.pid;
    assert.equal(launch.bundle, LS_ID);
    await waitFor(() => readJsonl(appLog).some((e) => e.ev === "welcome"), 20_000, "welcome");
    await waitFor(() => d.voice.state === "live", 45_000, "live session");
    const liveMs = Date.now() - t0;
    assert.match(fs.readFileSync(path.join(D, "logs", "daemon.log"), "utf8"), /"ev":"window.choose"[^\n]*"mode":"app"/);
    assert.ok(readJsonl(appLog).some((e) => e.ev === "capture" && e.to === "full"), "the app streams the fake mic");
    // The fixture asks about the files: it must reach Claude.
    await waitFor(() => inbox.frames.find((f) => f.type === "user"), 45_000, "delegation reaches the inbox");
    await waitFor(() => fs.existsSync(outWav) && wavPeak(outWav).peak > 1200, 30_000, "speech in the output WAV");
    const wav = wavPeak(outWav);
    const off = await ctl({ action: "off" });
    assert.equal(off.ok, true);
    await waitFor(() => !pidAlive(appPid), 15_000, "app quits after voice off");
    const billed = d.voice.status().today?.seconds ?? 0;
    const icons = [...new Set(readJsonl(appLog).filter((e) => e.ev === "icon").map((e) => e.state))];
    console.log(`# native live: live in ${(liveMs / 1000).toFixed(1)} s; output ${wav.seconds.toFixed(1)} s peak ${wav.peak}; icons ${icons.join(",")}; billed ${billed} s`);
    assert.ok(billed <= MAX_BILLED_S, `billed ${billed} s (budget ${MAX_BILLED_S})`);
  } finally {
    if (appPid && pidAlive(appPid)) process.kill(appPid, "SIGTERM");
    await ctl({ action: "off" }).catch(() => {});
    await sleep(500);
    await d.close();
    await inbox.close?.();
    spawnSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-u", p.bundle]);
    if (!process.env.SOTTO_E2E_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
    else console.log(`# kept ${tmp}`);
  }
});
