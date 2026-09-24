import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDotEnv, resolveApiKey, normalizeConfig, openaiBase, wssBase, DEFAULT_CONFIG } from "../../daemon/config.js";
import { dataPaths } from "../../daemon/paths.js";
import { writeActive, removeActive, readUsage, writeUsage, localDate, StatusFileWriter } from "../../daemon/statefiles.js";
import { createLogger } from "../../daemon/log.js";
import { createFakeClock } from "../helpers/fake-clock.js";

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "clv-cfg-")); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

test("parseDotEnv handles export, quotes and comments", () => {
  const env = parseDotEnv([
    "# comment", "", "export OPENAI_API_KEY='sk-single'", 'A="double # not comment"', "B=plain # trailing", "C = spaced ", "bad line",
  ].join("\n"));
  assert.deepEqual(env, { OPENAI_API_KEY: "sk-single", A: "double # not comment", B: "plain", C: "spaced" });
});

test("resolveApiKey order: env, plugin root, data dir, ~/.sotto", () => {
  const root = tmp(); const data = tmp(); const home = tmp();
  fs.mkdirSync(path.join(home, ".sotto"));
  fs.writeFileSync(path.join(home, ".sotto", ".env"), "OPENAI_API_KEY=home\n");
  assert.equal(resolveApiKey({ env: {}, pluginRoot: root, dataDir: data, home }), "home");
  fs.writeFileSync(path.join(data, ".env"), "OPENAI_API_KEY=data\n");
  assert.equal(resolveApiKey({ env: {}, pluginRoot: root, dataDir: data, home }), "data");
  fs.writeFileSync(path.join(root, ".env"), "export OPENAI_API_KEY=\"root\"\n");
  assert.equal(resolveApiKey({ env: {}, pluginRoot: root, dataDir: data, home }), "root");
  assert.equal(resolveApiKey({ env: { OPENAI_API_KEY: "real" }, pluginRoot: root, dataDir: data, home }), "real");
  assert.equal(resolveApiKey({ env: {}, pluginRoot: tmp(), dataDir: tmp(), home: tmp() }), null);
});

test("normalizeConfig validates and falls back", () => {
  assert.deepEqual(normalizeConfig({}), { ...DEFAULT_CONFIG });
  assert.equal(DEFAULT_CONFIG.idle_seconds, 60);
  assert.equal(DEFAULT_CONFIG.wake_sensitivity, "medium");
  assert.deepEqual(normalizeConfig({ voice: "cedar", idle_minutes: 0, speaking_policy: "quiet", daily_cap_minutes: 1440, wake_sensitivity: "off", window: "chrome", mirror: "decisions", open_browser: false }),
    { voice: "cedar", idle_minutes: 0, idle_seconds: 0, speaking_policy: "quiet", daily_cap_minutes: 1440, wake_sensitivity: "off", window: "chrome", mirror: "decisions", open_browser: false });
  assert.equal(DEFAULT_CONFIG.mirror, "all");
  assert.equal(normalizeConfig({ mirror: "everything" }).mirror, "all");
  assert.equal(normalizeConfig({ mirror: "off" }).mirror, "off");
  assert.deepEqual(normalizeConfig({ voice: "nope", idle_minutes: 500, idle_seconds: 9000, speaking_policy: "loud", daily_cap_minutes: -1, wake_sensitivity: "loud" }), { ...DEFAULT_CONFIG });
  assert.equal(normalizeConfig({ window: "none" }).window, "auto"); // "none" is env-only (tests, probes)
  assert.equal(normalizeConfig({}, { ...DEFAULT_CONFIG, window: "app" }).window, "app");
  assert.equal(normalizeConfig({ idle_minutes: "7" }).idle_minutes, 7);
});

test("idle_seconds wins over legacy idle_minutes; idle_minutes alone converts", () => {
  assert.equal(normalizeConfig({ idle_minutes: 5 }).idle_seconds, 300, "old toggle.sh / e2e bodies keep working");
  assert.equal(normalizeConfig({ idle_minutes: 2.5 }).idle_seconds, 150);
  assert.equal(normalizeConfig({ idle_seconds: 90, idle_minutes: 5 }).idle_seconds, 90);
  assert.equal(normalizeConfig({ idle_seconds: 90 }).idle_minutes, 1.5, "idle_minutes mirrors idle_seconds for display");
  assert.equal(normalizeConfig({ idle_seconds: "4" }).idle_seconds, 4);
  // A later /control without idle fields keeps the earlier value.
  assert.equal(normalizeConfig({}, normalizeConfig({ idle_seconds: 30 })).idle_seconds, 30);
  assert.equal(normalizeConfig({ wake_sensitivity: "high" }).wake_sensitivity, "high");
});

test("openai base override and wss conversion", () => {
  assert.equal(openaiBase({}), "https://api.openai.com/v1");
  assert.equal(openaiBase({ SOTTO_OPENAI_BASE: "http://127.0.0.1:9/v1/" }), "http://127.0.0.1:9/v1");
  assert.equal(wssBase("https://api.openai.com/v1"), "wss://api.openai.com/v1");
});

test("active file: one line, mode 0600, atomic, removable", () => {
  const p = dataPaths(tmp());
  writeActive(p, { socket: "/tmp/cc-socks/1.sock", port: 47821, key: "k".repeat(64) });
  assert.equal(fs.readFileSync(p.active, "utf8"), `/tmp/cc-socks/1.sock\t47821\t${"k".repeat(64)}\n`);
  assert.equal(fs.statSync(p.active).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(p.active + ".tmp"));
  assert.equal(removeActive(p), true);
  assert.ok(!fs.existsSync(p.active));
});

test("usage.json prunes entries older than 30 days", () => {
  const p = dataPaths(tmp());
  const now = new Date(2026, 8, 23, 12).getTime();
  const old = localDate(now - 40 * 86400_000);
  const recent = localDate(now - 3 * 86400_000);
  writeUsage(p, { days: { [old]: 5, [recent]: 7, [localDate(now)]: 1.5 } }, now);
  assert.deepEqual(readUsage(p).days, { [recent]: 7, [localDate(now)]: 1.5 });
  assert.equal(fs.statSync(p.usage).mode & 0o777, 0o600);
});

test("status file writer is throttled to once per second", async () => {
  const p = dataPaths(tmp());
  const clock = createFakeClock();
  let n = 0;
  const w = new StatusFileWriter({ paths: p, clock, get: () => ({ n: ++n }) });
  w.mark(); w.mark(); w.mark();
  await clock.advance(0);
  assert.equal(JSON.parse(fs.readFileSync(p.status, "utf8")).n, 1);
  w.mark();
  await clock.advance(500);
  assert.equal(JSON.parse(fs.readFileSync(p.status, "utf8")).n, 1);
  await clock.advance(600);
  assert.equal(JSON.parse(fs.readFileSync(p.status, "utf8")).n, 2);
});

test("logger writes JSONL, skips debug unless enabled, redacts secret-named fields, rotates", () => {
  const dir = tmp();
  const log = createLogger({ dir, maxBytes: 400 });
  log.info("start", { pid: 1, token: "secret-token" });
  log.debug("hidden", {});
  const lines = fs.readFileSync(path.join(dir, "daemon.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].ev, "start");
  assert.equal(lines[0].lvl, "info");
  assert.equal(lines[0].token, "[redacted]");
  assert.ok(!fs.readFileSync(path.join(dir, "daemon.log"), "utf8").includes("secret-token"));
  for (let i = 0; i < 20; i++) log.info("filler", { i, pad: "x".repeat(50) });
  assert.ok(fs.existsSync(path.join(dir, "daemon.log.1")));
  assert.ok(fs.statSync(path.join(dir, "daemon.log")).size <= 400);
});
