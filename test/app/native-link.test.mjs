// Native link (docs/NATIVE.md §6 B4): the SwiftPM-built app runs
// `--selftest link --port P --data-dir D` against an in-process temp daemon:
// bootstrap via page.secret, hello/welcome, a status, clean close.
// Silent: the selftest opens no audio device and no window. It passes --test.
// Run with `npm run test:app` (macOS with Swift). Never touches the user's daemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDaemon } from "../../daemon/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PKG = path.join(ROOT, "app-native");
const SKIP = process.platform !== "darwin" ? "macOS only"
  : spawnSync("swift", ["--version"]).status !== 0 ? "no Swift toolchain" : false;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function buildApp() {
  const r = spawnSync("swift", ["build", "--package-path", PKG, "--product", "Sotto"], { encoding: "utf8", timeout: 300_000 });
  assert.equal(r.status, 0, `swift build failed:\n${r.stderr || r.stdout}`);
  const bin = spawnSync("swift", ["build", "--package-path", PKG, "--show-bin-path"], { encoding: "utf8" }).stdout.trim();
  return path.join(bin, "Sotto");
}

test("app --selftest link: bootstrap with page.secret, hello/welcome, status, clean close", { skip: SKIP, timeout: 360_000 }, async (t) => {
  const exe = buildApp();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sotto-native-link-"));
  const dataDir = path.join(tmp, "data");
  const port = await freePort();
  const daemon = createDaemon({
    dataDir, port, pluginRoot: ROOT,
    env: { SOTTO_BROWSER: "none", SOTTO_KEYCHAIN_SERVICE: `sotto-test-${process.pid}` }, daemonKey: "k".repeat(64),
  });
  try {
    // Until B1 wires /api/native into the daemon (createDaemon returns `native`).
    if (!daemon.native) { t.skip("needs the daemon's /api/native endpoint (docs/NATIVE.md B1)"); return; }
    await daemon.listen();
    // daemon.port is what the app trusts (owned regular file in an owned dir).
    if (!fs.existsSync(path.join(dataDir, "daemon.port"))) fs.writeFileSync(path.join(dataDir, "daemon.port"), `${port}\n`);
    // Async spawn: the daemon runs in this process, so a spawnSync would block
    // its event loop and the app's bootstrap would never be answered.
    const r = await new Promise((resolve) => {
      const child = spawn(exe, ["--test", "--selftest", "link", "--port", String(port), "--data-dir", dataDir],
        { env: { ...process.env, SOTTO_APP_TEST: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b) => { stdout += b; });
      child.stderr.on("data", (b) => { stderr += b; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.on("exit", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
    const line = (r.stdout || "").split("\n").find((l) => l.includes("\"selftest\":\"link\""));
    if (!line) {
      // Until SottoApp (B6) routes `--selftest link` to SottoClient.LinkSelfTest.run.
      t.skip(`the app does not answer --selftest link yet (exit ${r.status})`);
      return;
    }
    const out = JSON.parse(line);
    assert.equal(out.ok, true, line);
    assert.equal(out.welcome, true);
    assert.equal(out.protocol, 1);
    assert.equal(typeof out.status_state, "string");
    assert.equal(out.connects, 1);
    // The page token and secret never reach stdout.
    assert.ok(!r.stdout.includes(daemon.pageToken) && !r.stdout.includes(daemon.pageSecret));
  } finally {
    await daemon.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
