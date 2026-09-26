// Opt-in uplink audio capture for diagnosing "the voice does not hear me"
// (SPEC §6.19 "Debug capture"). Off by default. `sotto debug capture on`
// creates `D/debug/capture.on`; while that file exists (for at most MAX_MS
// from when the daemon first saw it, then the daemon deletes it; a flag
// older than STALE_MS never starts a capture), the native session
// writes two aligned 24 kHz mono PCM16 WAVs per session into `D/debug/`:
//   <stamp>-raw.wav  the app's mic frames exactly as they arrived
//   <stamp>-up.wav   what was pushed to gpt-live-1 (after level control;
//                    silence while no session was live)
// Nothing is recorded from any other source, nothing leaves the machine, and
// captures older than KEEP_MS are deleted at the next check. `sotto debug
// capture off` stops and deletes everything.
import fs from "node:fs";
import path from "node:path";

export const FLAG_FILE = "capture.on";
/** A capture switches itself off this long after it was turned on. */
export const MAX_MS = 10 * 60_000;
/** A flag file older than this when first seen is stale (made while no daemon ran): deleted, no capture. */
export const STALE_MS = 60 * 60_000;
/** Finished captures are deleted after this long. */
export const KEEP_MS = 24 * 3600_000;
/** How often the flag file is looked at (one stat). */
export const CHECK_MS = 1000;
const RATE = 24000;

function wavHeader(dataBytes) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii"); h.writeUInt32LE(36 + dataBytes, 4); h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii"); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii"); h.writeUInt32LE(dataBytes, 40);
  return h;
}

/**
 * @param {object} o
 * @param {string|null} o.dir   D/debug (null: disabled)
 * @param {{now:()=>number}} o.clock
 * @param {object} [o.log]
 */
export function createDebugCapture({ dir, clock, log = null, fsImpl = fs }) {
  let checkedAt = -Infinity;
  let on = false;
  let onSince = 0;
  let files = null; // {raw:{fd,bytes,path}, up:{...}}
  const flag = dir ? path.join(dir, FLAG_FILE) : null;

  function open(stamp, kind) {
    const p = path.join(dir, `${stamp}-${kind}.wav`);
    const fd = fsImpl.openSync(p, "w", 0o600);
    fsImpl.writeSync(fd, wavHeader(0));
    return { fd, bytes: 0, path: p };
  }
  function close() {
    if (!files) return;
    for (const f of [files.raw, files.up]) {
      try { fsImpl.writeSync(f.fd, wavHeader(f.bytes), 0, 44, 0); fsImpl.closeSync(f.fd); } catch { /* ignore */ }
    }
    log?.info("debug.capture_saved", { raw: files.raw.path, up: files.up.path, seconds: Math.round(files.raw.bytes / 2 / RATE) });
    files = null;
  }
  function prune(now) {
    let names = [];
    try { names = fsImpl.readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (!n.endsWith(".wav")) continue;
      const p = path.join(dir, n);
      if (files && (p === files.raw.path || p === files.up.path)) continue;
      try { if (now - fsImpl.statSync(p).mtimeMs > KEEP_MS) fsImpl.unlinkSync(p); } catch { /* ignore */ }
    }
  }
  function check(now) {
    checkedAt = now;
    let st = null;
    try { st = fsImpl.statSync(flag); } catch { st = null; }
    if (st && ((on && now - onSince > MAX_MS) || (!on && now - st.mtimeMs > STALE_MS))) {
      try { fsImpl.unlinkSync(flag); } catch { /* ignore */ }
      log?.info("debug.capture", { on: false, reason: "timeout" });
      st = null;
    }
    const want = !!st;
    if (want !== on) {
      on = want;
      if (!on) close();
      else { onSince = now; log?.info("debug.capture", { on: true, dir }); }
    }
    if (!on) prune(now);
  }

  return {
    get active() { return on; },
    /**
     * One mic frame. `up` is the frame pushed to the Live session, or null
     * when nothing was pushed (written as silence, so both files stay aligned).
     */
    frame(raw, up) {
      if (!dir) return;
      const now = clock.now();
      if (now - checkedAt >= CHECK_MS) check(now);
      if (!on) return;
      try {
        if (!files) {
          const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
          files = { raw: open(stamp, "raw"), up: open(stamp, "up") };
        }
        fsImpl.writeSync(files.raw.fd, raw); files.raw.bytes += raw.length;
        const u = up || Buffer.alloc(raw.length);
        fsImpl.writeSync(files.up.fd, u); files.up.bytes += u.length;
      } catch (e) {
        log?.warn("debug.capture_error", { message: String(e && e.message).slice(0, 200) });
        close();
        on = false;
        try { fsImpl.unlinkSync(flag); } catch { /* ignore */ }
      }
    },
    /** A new session or route: start new files (the next frame opens them). */
    split() { close(); },
    close,
  };
}
