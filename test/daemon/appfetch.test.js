// daemon/appfetch.js: release download of the desktop app (SPEC §6.16 "Release download").
// A local HTTP server plays GitHub; the signature check is injected except in
// the tests that run the real codesign against ad hoc bundles.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  installRelease, parseShaFile, pluginVersion, releaseUrls, shouldDownload, verifyApp, readDownloadStamp,
  zipEntries, zipEntryProblem, isMainModule, isLoopbackBase, failureMessage,
  RELEASE_BASE, RETRY_MS, REQUIREMENT, TEAM_ID,
} from "../../daemon/appfetch.js";
import { appBuildState, appSourceHash } from "../../daemon/window.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DARWIN = process.platform === "darwin";
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sotto-fetch-")));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const ok = async () => ({ ok: true });

/** A fake plugin root (app sources + version) and its sources hash. */
function fakePlugin(version = "9.8.7") {
  const root = tmp();
  fs.mkdirSync(path.join(root, "app-native/Sources/SottoApp"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(root, "app-native/Package.swift"), "// swift-tools-version:6.0\n");
  fs.writeFileSync(path.join(root, "app-native/Sources/SottoApp/main.swift"), "print(1)\n");
  fs.writeFileSync(path.join(root, "scripts/build-app.sh"), "#!/bin/bash\nexit 0\n");
  fs.writeFileSync(path.join(root, ".claude-plugin/plugin.json"), JSON.stringify({ name: "sotto", version }));
  return { root, hash: appSourceHash(root), version };
}

/** A zipped Sotto.app carrying `hash` in sotto-source.json; optionally ad hoc signed. */
function makeZip(hash, { sign = false, extra = null } = {}) {
  const dir = tmp();
  const c = path.join(dir, "Sotto.app", "Contents");
  fs.mkdirSync(path.join(c, "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(c, "Resources"), { recursive: true });
  fs.writeFileSync(path.join(c, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.chadboyda.sotto</string><key>CFBundleExecutable</key><string>Sotto</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>
`);
  fs.writeFileSync(path.join(c, "MacOS", "Sotto"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(c, "Resources", "sotto-source.json"), JSON.stringify({ hash, version: "9.8.7" }));
  if (sign) {
    const r = spawnSync("codesign", ["--force", "--sign", "-", "--identifier", "com.chadboyda.sotto", path.join(dir, "Sotto.app")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  if (extra) fs.writeFileSync(path.join(dir, extra), "x");
  const zip = path.join(tmp(), "Sotto.zip");
  const args = extra ? ["-c", "-k", dir, zip] : ["-c", "-k", "--keepParent", path.join(dir, "Sotto.app"), zip];
  const z = spawnSync("ditto", args, { encoding: "utf8" });
  assert.equal(z.status, 0, z.stderr);
  return { bytes: fs.readFileSync(zip), bundleDir: dir };
}

/** GitHub stand-in: /v<version>/Sotto.zip and .sha256 from `assets` (mutable); counts requests. */
function startServer() {
  const s = { assets: {}, hits: [], redirect: false };
  s.server = http.createServer((req, res) => {
    s.hits.push(req.url);
    if (s.redirect && !req.url.startsWith("/cdn/")) {
      res.writeHead(302, { Location: `/cdn${req.url}` });
      return res.end();
    }
    const key = req.url.replace(/^\/cdn/, "");
    const body = s.assets[key];
    if (body === undefined) { res.writeHead(404); return res.end("Not Found"); }
    res.writeHead(200, { "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  });
  return new Promise((resolve) => s.server.listen(0, "127.0.0.1", () => {
    s.base = `http://127.0.0.1:${s.server.address().port}`;
    s.publish = (version, zip, shaText = `${sha(zip)}  Sotto.zip\n`) => {
      s.assets[`/v${version}/Sotto.zip`] = zip;
      s.assets[`/v${version}/Sotto.zip.sha256`] = shaText;
    };
    resolve(s);
  }));
}

describe("pure helpers", () => {
  test("release URLs follow GitHub's download layout", () => {
    assert.deepEqual(releaseUrls("0.2.0"), {
      zip: "https://github.com/chadboyda/sotto/releases/download/v0.2.0/Sotto.zip",
      sha: "https://github.com/chadboyda/sotto/releases/download/v0.2.0/Sotto.zip.sha256",
    });
    assert.equal(releaseUrls("1.0.0", "http://x/y/").zip, "http://x/y/v1.0.0/Sotto.zip");
    assert.equal(RELEASE_BASE, "https://github.com/chadboyda/sotto/releases/download");
  });

  test("sha256 file: shasum output or a bare digest; other file names rejected", () => {
    const h = "a".repeat(64);
    assert.equal(parseShaFile(`${h}  Sotto.zip\n`), h);
    assert.equal(parseShaFile(`${h.toUpperCase()}\n`), h);
    assert.equal(parseShaFile(`${h} *dist/Sotto.zip`), h);
    assert.equal(parseShaFile(`${h}  Other.zip`), null);
    assert.equal(parseShaFile("nope"), null);
    assert.equal(parseShaFile(""), null);
  });

  test("plugin version comes from plugin.json and matches package.json", () => {
    const v = pluginVersion(ROOT);
    assert.match(v, /^\d+\.\d+\.\d+$/);
    assert.equal(v, JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version);
    assert.equal(pluginVersion(tmp()), null);
  });

  test("shouldDownload: once per version + sources; mismatch final; failures retried after a day", () => {
    const base = { version: "1.0.0", hash: "h", now: Date.parse("2026-09-24T12:00:00Z") };
    assert.equal(shouldDownload({ ...base, stamp: null }), true);
    assert.equal(shouldDownload({ ...base, version: null, stamp: null }), false);
    const failed = { version: "1.0.0", hash: "h", ok: false, permanent: false, at: "2026-09-24T11:00:00Z" };
    assert.equal(shouldDownload({ ...base, stamp: failed }), false);
    assert.equal(shouldDownload({ ...base, now: base.now + RETRY_MS, stamp: failed }), true);
    assert.equal(shouldDownload({ ...base, stamp: { ...failed, version: "0.9.0" } }), true, "a new version tries again");
    assert.equal(shouldDownload({ ...base, stamp: { ...failed, hash: "other" } }), true, "new sources try again");
    assert.equal(shouldDownload({ ...base, now: base.now + 10 * RETRY_MS, stamp: { ...failed, permanent: true } }), false);
    assert.equal(shouldDownload({ ...base, stamp: { ...failed, ok: true } }), true, "bundle vanished since: fetch again");
  });

  test("the signature requirement pins Developer ID, the team and the bundle id", () => {
    assert.match(REQUIREMENT, /anchor apple generic/);
    assert.match(REQUIREMENT, /identifier "com\.chadboyda\.sotto"/);
    assert.match(REQUIREMENT, new RegExp(`leaf\\[subject\\.OU\\] = "${TEAM_ID}"`));
    assert.match(REQUIREMENT, /1\.2\.840\.113635\.100\.6\.1\.13/); // Developer ID Application leaf
  });
});

describe("installRelease", { skip: DARWIN ? false : "needs ditto (macOS)" }, () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(() => srv.server.close());

  test("downloads, verifies, installs; the chooser then sees a ready app", async () => {
    const pl = fakePlugin("1.2.3");
    const data = tmp();
    const out = path.join(data, "app");
    const { bytes } = makeZip(pl.hash);
    srv.publish("1.2.3", bytes);
    srv.redirect = true; // GitHub answers with a redirect to its CDN
    const events = [];
    let verified = null;
    const r = await installRelease({
      outDir: out, version: "1.2.3", hash: pl.hash, base: srv.base,
      verify: async (b) => { verified = b; return { ok: true }; }, log: (ev) => events.push(ev),
    });
    srv.redirect = false;
    assert.deepEqual(r, { ok: true });
    assert.ok(verified.endsWith("Sotto.app"), "the unpacked bundle is verified before it is moved in");
    assert.ok(fs.existsSync(path.join(out, "Sotto.app/Contents/MacOS/Sotto")));
    const stamp = JSON.parse(fs.readFileSync(path.join(out, "build.json"), "utf8"));
    assert.equal(stamp.source, "release");
    assert.equal(stamp.sha256, sha(bytes));
    assert.equal(appBuildState({ pluginRoot: pl.root, dataDir: data }).state, "ready");
    assert.deepEqual(events, ["download_start", "sha256_ok", "verify_ok", "download_ok"]);
    assert.deepEqual(fs.readdirSync(out).filter((n) => n.startsWith(".dl.")), [], "stage cleaned up");
    assert.equal(readDownloadStamp(out).ok, true);
  });

  test("tampered zip (sha256 mismatch) is rejected and never installed", async () => {
    const pl = fakePlugin("2.0.0");
    const out = path.join(tmp(), "app");
    const good = makeZip(pl.hash).bytes;
    const tampered = Buffer.from(good);
    tampered[tampered.length - 10] ^= 0xff;
    srv.publish("2.0.0", tampered, `${sha(good)}  Sotto.zip\n`);
    let verifyCalls = 0;
    const r = await installRelease({ outDir: out, version: "2.0.0", hash: pl.hash, base: srv.base, verify: async () => { verifyCalls++; return { ok: true }; } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "sha256_mismatch");
    assert.equal(r.permanent, false);
    assert.equal(verifyCalls, 0);
    assert.ok(!fs.existsSync(path.join(out, "Sotto.app")));
    assert.ok(!fs.existsSync(path.join(out, "build.json")));
    assert.equal(readDownloadStamp(out).reason, "sha256_mismatch");
  });

  test("a failed signature check leaves the existing bundle alone", async () => {
    const pl = fakePlugin("2.1.0");
    const out = path.join(tmp(), "app");
    fs.mkdirSync(path.join(out, "Sotto.app"), { recursive: true });
    fs.writeFileSync(path.join(out, "Sotto.app", "marker"), "old");
    srv.publish("2.1.0", makeZip(pl.hash).bytes);
    const r = await installRelease({ outDir: out, version: "2.1.0", hash: pl.hash, base: srv.base, verify: async () => ({ ok: false, reason: "codesign" }) });
    assert.equal(r.reason, "codesign");
    assert.equal(fs.readFileSync(path.join(out, "Sotto.app", "marker"), "utf8"), "old");
  });

  test("a release built from other app sources is refused for good (local build instead)", async () => {
    const pl = fakePlugin("3.0.0");
    const out = path.join(tmp(), "app");
    srv.publish("3.0.0", makeZip("f".repeat(64)).bytes);
    const r = await installRelease({ outDir: out, version: "3.0.0", hash: pl.hash, base: srv.base, verify: ok });
    assert.equal(r.reason, "sources_mismatch");
    assert.equal(r.permanent, true);
    assert.equal(shouldDownload({ stamp: readDownloadStamp(out), version: "3.0.0", hash: pl.hash, now: Date.now() + 30 * RETRY_MS }), false);
  });

  test("no release for this version (404), a zip with extra entries, a bad sha file", async () => {
    const pl = fakePlugin("4.0.0");
    const out = path.join(tmp(), "app");
    assert.equal((await installRelease({ outDir: out, version: "4.0.0", hash: pl.hash, base: srv.base, verify: ok })).reason, "not_found");
    const extra = makeZip(pl.hash, { extra: "evil.txt" }).bytes;
    srv.publish("4.0.1", extra);
    assert.equal((await installRelease({ outDir: out, version: "4.0.1", hash: pl.hash, base: srv.base, verify: ok })).reason, "bad_zip");
    srv.publish("4.0.2", makeZip(pl.hash).bytes, "not a digest\n");
    assert.equal((await installRelease({ outDir: out, version: "4.0.2", hash: pl.hash, base: srv.base, verify: ok })).reason, "bad_sha_file");
    const refused = await installRelease({ outDir: out, version: "4.0.0", hash: pl.hash, base: "http://127.0.0.1:1", verify: ok });
    assert.equal(refused.reason, "network");
  });

  test("a zip with a path escaping the staging dir or a symlink is refused before or right after unpacking", async () => {
    const pl = fakePlugin("4.1.0");
    const data = tmp();
    const out = path.join(data, "app");
    // Crafted archive: a valid Sotto.app plus an entry that climbs out of the staging dir.
    const craft = path.join(tmp(), "evil.zip");
    const py = spawnSync("python3", ["-c", `import sys, zipfile
z = zipfile.ZipFile(sys.argv[1], "w")
z.writestr("Sotto.app/Contents/Resources/sotto-source.json", '{"hash":"' + sys.argv[2] + '"}')
z.writestr("Sotto.app/../../../escaped.txt", "x")
z.close()`, craft, pl.hash], { encoding: "utf8" });
    assert.equal(py.status, 0, py.stderr);
    srv.publish("4.1.0", fs.readFileSync(craft));
    let verifyCalls = 0;
    const r = await installRelease({ outDir: out, version: "4.1.0", hash: pl.hash, base: srv.base, verify: async () => { verifyCalls++; return { ok: true }; } });
    assert.equal(r.reason, "bad_zip");
    assert.match(r.message, /bad path/);
    assert.equal(verifyCalls, 0);
    assert.ok(!fs.existsSync(path.join(data, "escaped.txt")) && !fs.existsSync(path.join(out, "escaped.txt")));
    // A symlink inside the bundle (ditto keeps symlinks).
    const { bundleDir } = makeZip(pl.hash);
    fs.symlinkSync("/etc", path.join(bundleDir, "Sotto.app", "Contents", "Resources", "etc"));
    const zipPath = path.join(tmp(), "Sotto.zip");
    assert.equal(spawnSync("ditto", ["-c", "-k", "--keepParent", path.join(bundleDir, "Sotto.app"), zipPath]).status, 0);
    srv.publish("4.1.1", fs.readFileSync(zipPath));
    const r2 = await installRelease({ outDir: out, version: "4.1.1", hash: pl.hash, base: srv.base, verify: ok });
    assert.equal(r2.reason, "bad_zip");
    assert.match(r2.message, /not a plain file/);
    assert.ok(!fs.existsSync(path.join(out, "Sotto.app")));
  });

  test("an oversized download is cut off", async () => {
    const pl = fakePlugin("5.0.0");
    const out = path.join(tmp(), "app");
    const huge = { ok: true, status: 200, headers: new Map([["content-length", String(1e9)]]), body: [] };
    const fetchImpl = async (url) => (url.endsWith(".sha256") ? new Response(`${"a".repeat(64)}  Sotto.zip\n`) : huge);
    const r = await installRelease({ outDir: out, version: "5.0.0", hash: pl.hash, base: "http://unused", fetchImpl, verify: ok });
    assert.equal(r.reason, "too_large");
  });

  test("real codesign: an ad hoc signed bundle fails the Developer ID requirement", async () => {
    const { bundleDir } = makeZip("a".repeat(64), { sign: true });
    const v = await verifyApp(path.join(bundleDir, "Sotto.app"));
    assert.equal(v.ok, false);
    assert.equal(v.reason, "codesign");
    // And end to end: the default verifier rejects the download.
    const pl = fakePlugin("6.0.0");
    const out = path.join(tmp(), "app");
    srv.publish("6.0.0", makeZip(pl.hash, { sign: true }).bytes);
    const r = await installRelease({ outDir: out, version: "6.0.0", hash: pl.hash, base: srv.base });
    assert.equal(r.reason, "codesign");
    assert.ok(!fs.existsSync(path.join(out, "Sotto.app")));
  });

  test("the CLI falls back to the local build when the download fails, and releases the lock", async () => {
    const pl = fakePlugin("7.0.0");
    const out = path.join(tmp(), "app");
    const marker = path.join(out, "built-by-script");
    fs.writeFileSync(path.join(pl.root, "scripts/build-app.sh"), `#!/bin/bash\n[[ -f "$2/build.lock" ]] && exit 9\ntouch "$2/built-by-script"\n`);
    const child = spawn(process.execPath, [path.join(ROOT, "daemon/appfetch.js"), "--out", out, "--plugin-root", pl.root, "--hash", pl.hash, "--base", srv.base], { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (d) => { log += d; });
    child.stderr.on("data", (d) => { log += d; });
    const code = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(code, 0, log);
    assert.ok(fs.existsSync(marker), `build-app.sh ran without the lock held\n${log}`);
    assert.match(log, /download_failed.*not_found/);
    assert.match(log, /local_build/);
    assert.ok(!fs.existsSync(path.join(out, "build.lock")));
    assert.equal(readDownloadStamp(out).reason, "not_found");
  });

  test("the CLI logs every step with a timestamp and records the outcome in install.json", async () => {
    const pl = fakePlugin("7.2.0");
    const out = path.join(tmp(), "app");
    fs.writeFileSync(path.join(pl.root, "scripts/build-app.sh"), `#!/bin/bash\nprintf '{"hash":"x","ok":false,"error":"swiftc not found"}\\n' > "$2/build.json"\nexit 1\n`);
    const child = spawn(process.execPath, [path.join(ROOT, "daemon/appfetch.js"), "--out", out, "--plugin-root", pl.root, "--hash", pl.hash, "--base", srv.base], { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (d) => { log += d; });
    child.stderr.on("data", (d) => { log += d; });
    assert.equal(await new Promise((resolve) => child.on("exit", resolve)), 1, log);
    for (const ev of ["start", "download_start", "download_failed", "local_build", "local_build_done", "failed"]) {
      assert.match(log, new RegExp(`^\\d{4}-\\d\\d-\\d\\dT[^ ]+Z appfetch: ${ev} `, "m"), `${ev} in\n${log}`);
    }
    const rec = JSON.parse(fs.readFileSync(path.join(out, "install.json"), "utf8"));
    assert.equal(rec.ok, false);
    assert.equal(rec.reason, "build_failed");
    assert.equal(rec.message, "no signed release for this version; the local build failed: swiftc not found");
  });

  test("a release from other sources is still installed when the local build cannot run", async () => {
    const pl = fakePlugin("7.3.0");
    const out = path.join(tmp(), "app");
    fs.writeFileSync(path.join(pl.root, "scripts/build-app.sh"), "#!/bin/bash\nexit 1\n");
    srv.publish("7.3.0", makeZip("f".repeat(64)).bytes);
    const child = spawn(process.execPath, [path.join(ROOT, "daemon/appfetch.js"), "--out", out, "--plugin-root", pl.root, "--hash", pl.hash, "--base", srv.base], {
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SOTTO_APP_VERIFY: "insecure-test" },
    });
    let log = "";
    child.stdout.on("data", (d) => { log += d; });
    child.stderr.on("data", (d) => { log += d; });
    assert.equal(await new Promise((resolve) => child.on("exit", resolve)), 0, log);
    assert.match(log, /download_failed.*sources_mismatch/);
    assert.match(log, /release_despite_sources/);
    const stampJ = JSON.parse(fs.readFileSync(path.join(out, "build.json"), "utf8"));
    assert.equal(stampJ.hash, pl.hash, "stamped for these sources so the chooser sees ready");
    assert.equal(stampJ.release_hash, "f".repeat(64));
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, "install.json"), "utf8")).sources_mismatch, true);
  });

  test("SOTTO_APP_VERIFY=insecure-test is ignored for a non-loopback base", () => {
    assert.equal(isLoopbackBase("http://127.0.0.1:9/r"), true);
    assert.equal(isLoopbackBase("http://localhost/r"), true);
    assert.equal(isLoopbackBase(RELEASE_BASE), false);
    assert.equal(isLoopbackBase("http://127.0.0.1.evil.example/"), false);
    assert.equal(isLoopbackBase("file:///tmp"), false);
  });

  test("the CLI with --no-build only downloads", async () => {
    const pl = fakePlugin("7.1.0");
    const out = path.join(tmp(), "app");
    fs.writeFileSync(path.join(pl.root, "scripts/build-app.sh"), `#!/bin/bash\ntouch "$2/built-by-script"\n`);
    // Async: the server runs in this process.
    const child = spawn(process.execPath, [path.join(ROOT, "daemon/appfetch.js"), "--out", out, "--plugin-root", pl.root, "--hash", pl.hash, "--base", srv.base, "--no-build"], { stdio: "ignore" });
    assert.equal(await new Promise((resolve) => child.on("exit", resolve)), 1);
    assert.ok(!fs.existsSync(path.join(out, "built-by-script")));
  });
});

describe("CLI entry", () => {
  test("isMainModule compares real paths, so a symlinked plugin root runs the installer", () => {
    const dir = tmp();
    const link = path.join(dir, "plugin");
    fs.symlinkSync(ROOT, link);
    const me = new URL(`file://${path.join(ROOT, "daemon/appfetch.js")}`).href;
    assert.equal(isMainModule(path.join(link, "daemon/appfetch.js"), me), true);
    assert.equal(isMainModule(path.join(ROOT, "daemon/appfetch.js"), me), true);
    assert.equal(isMainModule(path.join(ROOT, "daemon/window.js"), me), false);
    assert.equal(isMainModule(undefined, me), false);
  });

  test("run through a symlink, the CLI does its work (it used to exit 0 silently)", () => {
    const dir = tmp();
    const link = path.join(dir, "plugin");
    fs.symlinkSync(ROOT, link);
    const r = spawnSync(process.execPath, [path.join(link, "daemon/appfetch.js"), "--bogus"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown argument --bogus/);
  });

  test("failureMessage words the release and build outcomes", () => {
    assert.equal(failureMessage({ release: { ok: false, reason: "not_found" }, buildRan: false }), "no signed release for this version");
    assert.equal(failureMessage({ release: { ok: false, reason: "codesign" }, build: { ok: false, error: "swiftc not found" }, buildRan: true }), "the release was refused (codesign); the local build failed: swiftc not found");
    assert.equal(failureMessage({ release: { ok: false, reason: "network" }, build: null, buildRan: true, buildCode: 3 }), "the release download failed (network); the local build failed: exit 3");
  });
});

describe("zip entry checks", () => {
  test("only plain files and directories under Sotto.app/ pass", () => {
    const f = (name, mode = 0o100644) => ({ name, mode });
    assert.equal(zipEntryProblem([f("Sotto.app/", 0o40755), f("Sotto.app/Contents/Info.plist"), f("__MACOSX/Sotto.app/._x"), f("Sotto.app/x", 0)]), null);
    for (const bad of ["../x", "/etc/passwd", "Sotto.app/../../x", "Sotto.app/./x", "Sotto.app//x", "Other.app/x", "Sotto.app\\..\\x", "Sotto.app/a\nb"]) {
      assert.ok(zipEntryProblem([f(bad)]), bad);
    }
    assert.match(zipEntryProblem([f("Sotto.app/link", 0o120777)]), /not a plain file/);
    assert.match(zipEntryProblem([f("Sotto.app/dev", 0o020644)]), /not a plain file/);
  });

  test("zipEntries reads a ditto archive and refuses garbage", { skip: DARWIN ? false : "needs ditto (macOS)" }, () => {
    const { bytes } = makeZip("b".repeat(64));
    const names = zipEntries(bytes).map((e) => e.name);
    assert.ok(names.includes("Sotto.app/Contents/Resources/sotto-source.json"), names.join(", "));
    assert.throws(() => zipEntries(Buffer.from("not a zip at all, just some bytes")));
    assert.throws(() => zipEntries(bytes.subarray(0, bytes.length - 30)));
  });
});
