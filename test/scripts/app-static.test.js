// Native desktop app sources checked without building (fast; runs in npm test).
// The build, the app's self-tests and the launch checks are in test/app
// (npm run test:app); the Swift unit tests are `npm run test:native`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("build-app.sh parses under /bin/bash and is executable", () => {
  const f = path.join(ROOT, "scripts/build-app.sh");
  assert.equal(spawnSync("/bin/bash", ["-n", f]).status, 0);
  assert.ok(fs.statSync(f).mode & 0o111);
});

test("release-app.sh parses, is executable, and only uploads behind --upload", () => {
  const f = path.join(ROOT, "scripts/release-app.sh");
  assert.equal(spawnSync("/bin/bash", ["-n", f]).status, 0);
  assert.ok(fs.statSync(f).mode & 0o111);
  const src = fs.readFileSync(f, "utf8");
  const create = src.lastIndexOf("gh release create");
  assert.ok(create > 0 && src.lastIndexOf("if [[ $UPLOAD -eq 1 ]]", create) > 0, "gh release create sits behind --upload");
  assert.match(src, /notarytool submit .*--wait/);
  assert.match(src, /stapler staple/);
  // Refuses a version that does not match the manifests, before building anything.
  const r = spawnSync("/bin/bash", [f, "99.99.99"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /version/);
});

test("entitlements: the microphone and nothing else", { skip: process.platform !== "darwin" }, () => {
  const r = spawnSync("plutil", ["-convert", "json", "-o", "-", path.join(ROOT, "app-native/Bundle/Sotto.entitlements")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { "com.apple.security.device.audio-input": true });
});

test("one version everywhere: package.json, plugin.json, Info.plist, daemon VERSION", { skip: process.platform !== "darwin" }, async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin/plugin.json"), "utf8")).version, pkg);
  const plist = spawnSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path.join(ROOT, "app-native/Bundle/Info.plist")], { encoding: "utf8" }).stdout.trim();
  assert.equal(plist, pkg);
  const { VERSION } = await import("../../daemon/config.js");
  assert.equal(VERSION, pkg);
});

test("Info.plist has the keys the app relies on", { skip: process.platform !== "darwin" }, () => {
  const r = spawnSync("plutil", ["-convert", "json", "-o", "-", path.join(ROOT, "app-native/Bundle/Info.plist")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(r.stdout);
  assert.equal(p.CFBundleIdentifier, "com.chadboyda.sotto", "the native app replaces the WKWebView app under the same id");
  assert.equal(p.CFBundleExecutable, "Sotto");
  assert.equal(p.LSUIElement, true);
  assert.equal(p.LSMultipleInstancesProhibited, true);
  assert.equal(p.LSMinimumSystemVersion, "14.0");
  assert.match(p.NSMicrophoneUsageDescription, /microphone/i);
  assert.deepEqual(p.CFBundleURLTypes[0].CFBundleURLSchemes, ["sotto"]);
  assert.equal(p.NSAppTransportSecurity.NSAllowsLocalNetworking, true);
});

test("the WKWebView app is gone; the native package has no dependencies", () => {
  assert.ok(!fs.existsSync(path.join(ROOT, "app")), "app/ was replaced by app-native/ (docs/NATIVE.md §5.5)");
  const pkg = fs.readFileSync(path.join(ROOT, "app-native/Package.swift"), "utf8");
  assert.doesNotMatch(pkg, /\.package\(/, "no third-party packages");
  assert.match(pkg, /\.macOS\(\.v14\)/);
  assert.match(fs.readFileSync(path.join(ROOT, "app-native/.gitignore"), "utf8"), /^\.build\/$/m);
});

test("SottoApp: audio only through SottoAudio, test mode always gets the fake engine", () => {
  const dir = path.join(ROOT, "app-native/Sources/SottoApp");
  const src = fs.readdirSync(dir).filter((f) => f.endsWith(".swift")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  // Opening AVAudioEngine.inputNode flips AirPods to the headset profile
  // (docs/NATIVE.md §5.3): the app target never touches CoreAudio itself.
  assert.doesNotMatch(src, /AVAudioEngine|inputNode|AudioUnit|import AVFoundation|import CoreAudio/);
  assert.match(src, /makeAudioIO\(test: options\.testMode\)/);
  // Test mode: hidden, no global hotkeys, own defaults suite.
  assert.match(src, /if o\.testMode \{[^}]*o\.hidden = !o\.show[^}]*o\.hotkeys = false/);
  assert.match(src, /"com\.chadboyda\.sotto\.test"/);
  // Test runs never forward a request to another running Sotto.
  assert.match(src, /if !options\.testMode, let id = Bundle\.main\.bundleIdentifier/);
});
