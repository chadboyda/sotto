// Opt-in debug capture of the native uplink (daemon/debugcapture.js, SPEC §6.19).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDebugCapture, FLAG_FILE, MAX_MS, KEEP_MS, STALE_MS } from "../../daemon/debugcapture.js";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clv-dbg-"));
  let t = 1_790_000_000_000;
  const clock = { now: () => t };
  const lines = [];
  const log = { info: (ev, o) => lines.push({ ev, ...o }), warn: (ev, o) => lines.push({ ev, ...o }) };
  return { dir, clock, lines, log, advance: (ms) => { t += ms; }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const frame = (v) => { const b = Buffer.alloc(960); for (let i = 0; i < 480; i++) b.writeInt16LE(v, i * 2); return b; };
const wavs = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith(".wav")).sort();

test("off by default: no flag, no files", (t) => {
  const s = setup(); t.after(s.cleanup);
  const c = createDebugCapture({ dir: s.dir, clock: s.clock, log: s.log });
  for (let i = 0; i < 100; i++) { c.frame(frame(5), frame(9)); s.advance(20); }
  assert.equal(c.active, false);
  assert.deepEqual(wavs(s.dir), []);
});

test("the flag records aligned raw and uplink WAVs; nothing pushed is silence", (t) => {
  const s = setup(); t.after(s.cleanup);
  fs.writeFileSync(path.join(s.dir, FLAG_FILE), "");
  fs.utimesSync(path.join(s.dir, FLAG_FILE), s.clock.now() / 1000, s.clock.now() / 1000);
  const c = createDebugCapture({ dir: s.dir, clock: s.clock, log: s.log });
  c.frame(frame(5), frame(9)); s.advance(20);
  c.frame(frame(6), null); s.advance(20);
  c.close();
  const [raw, up] = [wavs(s.dir).find((n) => n.endsWith("-raw.wav")), wavs(s.dir).find((n) => n.endsWith("-up.wav"))];
  const r = fs.readFileSync(path.join(s.dir, raw));
  const u = fs.readFileSync(path.join(s.dir, up));
  assert.equal(r.toString("ascii", 0, 4), "RIFF");
  assert.equal(r.readUInt32LE(24), 24000);
  assert.equal(r.readUInt32LE(40), 1920);
  assert.equal(u.readUInt32LE(40), 1920);
  assert.equal(r.readInt16LE(44), 5);
  assert.equal(r.readInt16LE(44 + 960), 6);
  assert.equal(u.readInt16LE(44), 9);
  assert.equal(u.readInt16LE(44 + 960), 0);
  assert.ok(s.lines.some((l) => l.ev === "debug.capture_saved"));
});

test("switches itself off after MAX_MS and deletes the flag; old captures are pruned", (t) => {
  const s = setup(); t.after(s.cleanup);
  const flag = path.join(s.dir, FLAG_FILE);
  fs.writeFileSync(flag, "");
  const at = s.clock.now() / 1000;
  fs.utimesSync(flag, at, at);
  const c = createDebugCapture({ dir: s.dir, clock: s.clock, log: s.log });
  c.frame(frame(1), null);
  assert.equal(c.active, true);
  s.advance(MAX_MS + 2000);
  c.frame(frame(1), null);
  assert.equal(c.active, false);
  assert.equal(fs.existsSync(flag), false);
  assert.equal(wavs(s.dir).length, 2);
  for (const n of wavs(s.dir)) fs.utimesSync(path.join(s.dir, n), at, at);
  s.advance(KEEP_MS);
  c.frame(frame(1), null);
  assert.deepEqual(wavs(s.dir), []);
});

test("the 10 minutes count from when the daemon first saw the flag; a stale flag starts nothing", (t) => {
  const s = setup(); t.after(s.cleanup);
  const flag = path.join(s.dir, FLAG_FILE);
  fs.writeFileSync(flag, "");
  const made = (s.clock.now() - MAX_MS + 60_000) / 1000; // made 9 minutes before the daemon looks
  fs.utimesSync(flag, made, made);
  const c = createDebugCapture({ dir: s.dir, clock: s.clock, log: s.log });
  c.frame(frame(1), null);
  assert.equal(c.active, true);
  s.advance(5 * 60_000);
  c.frame(frame(1), null);
  assert.equal(c.active, true, "still on 14 minutes after the flag was made");
  c.close();
  const s2 = setup(); t.after(s2.cleanup);
  const flag2 = path.join(s2.dir, FLAG_FILE);
  fs.writeFileSync(flag2, "");
  const old = (s2.clock.now() - STALE_MS - 1000) / 1000;
  fs.utimesSync(flag2, old, old);
  const c2 = createDebugCapture({ dir: s2.dir, clock: s2.clock, log: s2.log });
  c2.frame(frame(1), null);
  assert.equal(c2.active, false);
  assert.equal(fs.existsSync(flag2), false);
});
