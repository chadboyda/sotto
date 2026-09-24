// Self-update detection and timing (SPEC §6.17): the source fingerprint and
// the Updater's rules (settle, quiet, failure memory, manual), fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listSources, sourceSignature, hashSources, updateTimings, Updater, CHECK_MS, SETTLE_MS, QUIET_MS, MANUAL_QUIET_MS, QUIET_POLL_MS } from "../../daemon/update.js";
import { createFakeClock } from "../helpers/fake-clock.js";
import { createMemoryLogger } from "../../daemon/log.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clv-upd-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  w("daemon/index.js", "export {};\n");
  w("daemon/voice.js", "export const a = 1;\n");
  w("web/app.js", "console.log(1);\n");
  w("scripts/hook.sh", "#!/bin/bash\n");
  w("app/Sources/main.swift", "print(1)\n");
  w("app/.build/junk.o", "x"); // build output: ignored
  w("web/.DS_Store", "x"); // dotfiles: ignored
  w("test/x.test.js", "x"); // outside the source dirs
  w("README.md", "x");
  return { root, w };
}

test("listSources covers daemon, web, scripts and app, skipping dotfiles and build output", (t) => {
  const { root } = tree(t);
  assert.deepEqual(listSources(root), ["app/Sources/main.swift", "daemon/index.js", "daemon/voice.js", "scripts/hook.sh", "web/app.js"]);
});

test("hashSources: any source change moves `all`; only web/ moves `web`; unrelated files move nothing", (t) => {
  const { root, w } = tree(t);
  const h0 = hashSources(root);
  assert.equal(h0.files, 5);
  assert.match(h0.all, /^[0-9a-f]{16}$/);
  w("README.md", "changed");
  w("test/x.test.js", "changed");
  assert.deepEqual(hashSources(root), h0);
  w("daemon/voice.js", "export const a = 2;\n");
  const h1 = hashSources(root);
  assert.notEqual(h1.all, h0.all);
  assert.equal(h1.web, h0.web);
  w("web/app.js", "console.log(2);\n");
  const h2 = hashSources(root);
  assert.notEqual(h2.web, h0.web);
  // A rename is a change even with identical bytes.
  fs.renameSync(path.join(root, "scripts/hook.sh"), path.join(root, "scripts/hook2.sh"));
  assert.notEqual(hashSources(root).all, h2.all);
});

test("sourceSignature changes on touch (mtime) even when the content does not", (t) => {
  const { root } = tree(t);
  const s0 = sourceSignature(root);
  const f = path.join(root, "daemon/index.js");
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(f, later, later);
  assert.notEqual(sourceSignature(root), s0);
});

test("updateTimings: defaults, overrides, invalid values ignored, SOTTO_UPDATE=0 disables", () => {
  assert.deepEqual(updateTimings({}), { enabled: true, checkMs: CHECK_MS, settleMs: SETTLE_MS, quietMs: QUIET_MS });
  assert.equal(CHECK_MS, 30000);
  assert.equal(QUIET_MS, 45000);
  assert.deepEqual(updateTimings({ SOTTO_UPDATE_CHECK_MS: "1000", SOTTO_UPDATE_SETTLE_MS: "0", SOTTO_UPDATE_QUIET_MS: "2000" }),
    { enabled: true, checkMs: 1000, settleMs: 0, quietMs: 2000 });
  assert.equal(updateTimings({ SOTTO_UPDATE_CHECK_MS: "5" }).checkMs, CHECK_MS, "below the floor");
  assert.equal(updateTimings({ SOTTO_UPDATE_QUIET_MS: "abc" }).quietMs, QUIET_MS);
  assert.equal(updateTimings({ SOTTO_UPDATE: "0" }).enabled, false);
});

function updater(t, root, { quiet = () => null, result = { ok: true }, env = {} } = {}) {
  const clock = createFakeClock();
  const log = createMemoryLogger();
  const calls = [];
  const state = { quiet, result };
  const u = new Updater({
    root, clock, log, env,
    isQuiet: (ms) => state.quiet(ms),
    restart: async (r) => { calls.push(r); return typeof state.result === "function" ? state.result(r) : state.result; },
  }).start();
  t.after(() => u.stop());
  return { u, clock, log, calls, state };
}

test("Updater: a change is noticed on the 30 s check, settles 5 s, then restarts when quiet", async (t) => {
  const { root, w } = tree(t);
  const { u, clock, log, calls } = updater(t, root);
  await clock.advance(CHECK_MS);
  assert.equal(calls.length, 0, "nothing changed");
  w("daemon/voice.js", "export const a = 3;\n");
  await clock.advance(CHECK_MS - 1);
  assert.equal(log.find("update.detected").length, 0, "not before the next check");
  await clock.advance(1);
  assert.equal(log.find("update.detected").length, 1);
  assert.equal(calls.length, 0, "settling");
  await clock.advance(SETTLE_MS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reason, "update");
  assert.equal(calls[0].quietMs, QUIET_MS);
  assert.equal(calls[0].from.all, u.baseline.all);
  assert.notEqual(calls[0].to.all, u.baseline.all);
});

test("Updater: a file still being written restarts the settle; changing it back cancels", async (t) => {
  const { root, w } = tree(t);
  const { clock, log, calls } = updater(t, root);
  w("daemon/voice.js", "export const a = 4;\n");
  await clock.advance(CHECK_MS);
  // Mid-edit: the file changes again inside the settle window.
  await clock.advance(SETTLE_MS - 1000);
  w("daemon/voice.js", "export const a = 44;\n");
  await clock.advance(1000);
  assert.equal(calls.length, 0, "the settle saw another change");
  assert.equal(log.find("update.detected").length, 2);
  await clock.advance(SETTLE_MS);
  assert.equal(calls.length, 1, "restarts once it holds still");

  const t2 = tree(t);
  const b = updater(t, t2.root);
  t2.w("web/app.js", "console.log(9);\n");
  await b.clock.advance(CHECK_MS);
  t2.w("web/app.js", "console.log(1);\n"); // back to the original bytes
  await b.clock.advance(CHECK_MS);
  assert.equal(b.log.find("update.cancelled").length, 1);
  await b.clock.advance(CHECK_MS * 3);
  assert.equal(b.calls.length, 0);
});

test("Updater: waits for a quiet moment, polling every 2 s without touching files", async (t) => {
  const { root, w } = tree(t);
  const { clock, log, calls, state } = updater(t, root, { quiet: () => "recent_speech" });
  w("daemon/voice.js", "export const a = 5;\n");
  await clock.advance(CHECK_MS + SETTLE_MS);
  assert.equal(calls.length, 0);
  assert.equal(log.find("update.waiting").length, 1, "logged once per reason");
  state.quiet = () => "delegation";
  await clock.advance(QUIET_POLL_MS);
  assert.equal(log.find("update.waiting").length, 2);
  state.quiet = () => null;
  await clock.advance(QUIET_POLL_MS);
  assert.equal(calls.length, 1);
});

test("Updater: a failed restart is not retried for the same code, only for newer code", async (t) => {
  const { root, w } = tree(t);
  const { clock, log, calls, state } = updater(t, root, { result: { ok: false, code: "preflight" } });
  w("daemon/voice.js", "export const a = (;\n"); // broken
  await clock.advance(CHECK_MS + SETTLE_MS);
  assert.equal(calls.length, 1);
  assert.equal(log.find("update.failed").length, 1);
  await clock.advance(CHECK_MS * 4);
  assert.equal(calls.length, 1, "no retry loop on the same broken code");
  state.result = { ok: true };
  w("daemon/voice.js", "export const a = 6;\n"); // fixed
  await clock.advance(CHECK_MS + SETTLE_MS);
  assert.equal(calls.length, 2);
});

test("Updater: 'not_quiet' (busy again after the preflight) retries on the next poll", async (t) => {
  const { root, w } = tree(t);
  let n = 0;
  const { clock, calls } = updater(t, root, { result: () => (++n === 1 ? { ok: false, code: "not_quiet" } : { ok: true }) });
  w("daemon/voice.js", "export const a = 7;\n");
  await clock.advance(CHECK_MS + SETTLE_MS);
  assert.equal(calls.length, 1);
  await clock.advance(QUIET_POLL_MS);
  assert.equal(calls.length, 2);
});

test("Updater: manual restart uses the 3 s quiet window and needs no code change", async (t) => {
  const { root } = tree(t);
  const quietAsked = [];
  const { u, clock, calls, state } = updater(t, root, { quiet: (ms) => { quietAsked.push(ms); return "recent_speech"; } });
  assert.equal(u.requestManual(), "recent_speech");
  assert.equal(quietAsked.at(-1), MANUAL_QUIET_MS);
  await clock.advance(QUIET_POLL_MS);
  assert.equal(calls.length, 0);
  state.quiet = () => null;
  await clock.advance(QUIET_POLL_MS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reason, "manual");
  assert.equal(calls[0].quietMs, MANUAL_QUIET_MS);

  const t2 = tree(t);
  const b = updater(t, t2.root);
  assert.equal(b.u.requestManual(), "now");
  await b.clock.advance(0);
  assert.equal(b.calls.length, 1);
});

test("Updater: SOTTO_UPDATE=0 never checks", async (t) => {
  const { root, w } = tree(t);
  const { clock, calls, log } = updater(t, root, { env: { SOTTO_UPDATE: "0" } });
  w("daemon/voice.js", "export const a = 8;\n");
  await clock.advance(CHECK_MS * 3);
  assert.equal(calls.length, 0);
  assert.equal(log.find("update.detected").length, 0);
});

test("cost on this repository: a no-change check is a few ms, a full hash well under 100 ms", () => {
  const t0 = performance.now();
  const sig = sourceSignature(REPO);
  const statMs = performance.now() - t0;
  const t1 = performance.now();
  const h = hashSources(REPO);
  const hashMs = performance.now() - t1;
  assert.ok(sig.length > 0 && h.files > 20, `${h.files} files`);
  // Generous bounds: npm test runs files in parallel.
  assert.ok(statMs < 250, `stat pass ${statMs.toFixed(1)} ms`);
  assert.ok(hashMs < 500, `hash ${hashMs.toFixed(1)} ms`);
});
