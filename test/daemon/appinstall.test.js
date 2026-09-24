// End to end (no network): the daemon's window chooser spawns the real
// installer (daemon/appfetch.js, detached, as the daemon does) from a plugin
// root reached through a symlink, like the ~/.claude/skills/sotto install,
// against a local stand-in for the GitHub release (SOTTO_RELEASE_BASE).
// Regression for the installer that exited 0 without doing anything because
// its main-module check compared a symlinked argv[1] with the real path.
// Nothing here launches the app: only the install is exercised.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appBuildState, appPaths, appSourceHash, chooseWindow, createWindow } from "../../daemon/window.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DARWIN = process.platform === "darwin";
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sotto-inst-")));
const VERSION = "4.5.6";

/** A plugin copy (app sources, installer, a stub build script) behind a symlink. */
function pluginViaSymlink(buildScript) {
  const real = tmp();
  // The app sources, without SwiftPM build products (appSourceHash skips them anyway).
  fs.cpSync(path.join(ROOT, "app-native"), path.join(real, "app-native"), {
    recursive: true, filter: (src) => !/\/\.(build|swiftpm)(\/|$)/.test(src),
  });
  fs.mkdirSync(path.join(real, "daemon"));
  fs.copyFileSync(path.join(ROOT, "daemon/appfetch.js"), path.join(real, "daemon/appfetch.js"));
  fs.mkdirSync(path.join(real, "scripts"));
  fs.writeFileSync(path.join(real, "scripts/build-app.sh"), buildScript, { mode: 0o755 });
  fs.mkdirSync(path.join(real, ".claude-plugin"));
  fs.writeFileSync(path.join(real, ".claude-plugin/plugin.json"), JSON.stringify({ name: "sotto", version: VERSION }));
  const link = path.join(tmp(), "sotto");
  fs.symlinkSync(real, link);
  return link;
}

/** An unsigned Sotto.app zip whose sotto-source.json carries `hash`. */
function fixtureZip(hash) {
  const dir = tmp();
  const c = path.join(dir, "Sotto.app", "Contents");
  fs.mkdirSync(path.join(c, "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(c, "Resources"), { recursive: true });
  fs.writeFileSync(path.join(c, "Info.plist"), "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>com.chadboyda.sotto</string></dict></plist>\n");
  fs.writeFileSync(path.join(c, "MacOS", "Sotto"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(c, "Resources", "sotto-source.json"), JSON.stringify({ hash, version: VERSION }));
  const zip = path.join(tmp(), "Sotto.zip");
  const z = spawnSync("ditto", ["-c", "-k", "--keepParent", path.join(dir, "Sotto.app"), zip], { encoding: "utf8" });
  assert.equal(z.status, 0, z.stderr);
  return fs.readFileSync(zip);
}

function startServer() {
  const s = { assets: {} };
  s.server = http.createServer((req, res) => {
    const body = s.assets[req.url];
    if (body === undefined) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  });
  return new Promise((resolve) => s.server.listen(0, "127.0.0.1", () => {
    s.base = `http://127.0.0.1:${s.server.address().port}`;
    s.publish = (zip) => {
      s.assets[`/v${VERSION}/Sotto.zip`] = zip;
      s.assets[`/v${VERSION}/Sotto.zip.sha256`] = `${createHash("sha256").update(zip).digest("hex")}  Sotto.zip\n`;
    };
    resolve(s);
  }));
}

/** createWindow with the real spawn; resolves with the first install result. */
function installWith({ pluginRoot, env }) {
  const dataDir = tmp();
  const logs = [];
  let resolveResult;
  const result = new Promise((r) => { resolveResult = r; });
  const w = createWindow({
    dataDir, port: 47998, pluginRoot, env,
    chrome: { url: "", launched: false, open: () => ({ mode: "chrome" }), kill: async () => 0, notify() {} },
    exists: (f) => fs.existsSync(f),
    log: { info: (ev, o) => logs.push([ev, o]), warn: (ev, o) => logs.push([ev, o]), error: (ev, o) => logs.push([ev, o]) },
    onInstallResult: (r) => resolveResult(r),
  });
  return { w, dataDir, logs, result };
}

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: no result in ${ms} ms`)), ms).unref())]);

describe("daemon-spawned app install", { skip: DARWIN ? false : "needs ditto (macOS)" }, () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(() => srv.server.close());

  test("installs the release into the data dir; the next window is the app", async () => {
    const pluginRoot = pluginViaSymlink("#!/bin/bash\necho 'build-app.sh must not run' >&2\nexit 1\n");
    srv.publish(fixtureZip(appSourceHash(pluginRoot)));
    const h = installWith({ pluginRoot, env: { SOTTO_RELEASE_BASE: srv.base, SOTTO_APP_VERIFY: "insecure-test" } });
    assert.equal(h.w.ensureInstalled().state, "installing");
    const r = await withTimeout(h.result, 20_000, "install");
    const p = appPaths(h.dataDir, pluginRoot);
    const log = fs.readFileSync(p.buildLog, "utf8");
    assert.deepEqual(r, { ok: true }, log);
    assert.ok(fs.existsSync(p.exe), "Sotto.app is in D/app");
    assert.equal(JSON.parse(fs.readFileSync(p.stamp, "utf8")).source, "release");
    assert.equal(JSON.parse(fs.readFileSync(p.installStamp, "utf8")).ok, true);
    assert.match(log, /appfetch: start /);
    assert.match(log, /appfetch: download_ok /);
    assert.match(log, /appfetch: done \{"ok":true,"source":"release"\}/);
    assert.doesNotMatch(log, /must not run/);
    assert.equal(h.w.appStatus().state, "ready");
    const app = appBuildState({ pluginRoot, dataDir: h.dataDir });
    assert.equal(chooseWindow({ want: "auto", platform: "darwin", app, chromeExists: true }).mode, "app");
    assert.ok(h.logs.some(([ev]) => ev === "app.install_ready"));
  });

  test("an unsigned release fails the real signature check; the failed build's reason reaches the caller", async () => {
    const pluginRoot = pluginViaSymlink(`#!/bin/bash\nmkdir -p "$2"\nprintf '{"hash":"%s","ok":false,"error":"swiftc not found"}\\n' "x" > "$2/build.json"\nexit 1\n`);
    srv.publish(fixtureZip(appSourceHash(pluginRoot)));
    const h = installWith({ pluginRoot, env: { SOTTO_RELEASE_BASE: srv.base } });
    h.w.ensureInstalled();
    const r = await withTimeout(h.result, 30_000, "install");
    const p = appPaths(h.dataDir, pluginRoot);
    const log = fs.readFileSync(p.buildLog, "utf8");
    assert.equal(r.ok, false, log);
    assert.match(r.message, /the release was refused \(codesign\); the local build failed: swiftc not found/);
    assert.ok(!fs.existsSync(p.exe), "nothing unsigned is installed");
    assert.equal(h.w.appStatus().state, "failed");
    assert.match(log, /appfetch: download_failed .*codesign/);
    assert.match(log, /daemon: install failed: /);
  });
});
