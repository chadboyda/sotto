// Atomic state-file writes (SPEC §3). Every file is mode 0600.
import fs from "node:fs";

export function writeAtomic(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function removeQuiet(file) {
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

export function writePid(paths, pid = process.pid) {
  writeAtomic(paths.pid, `${pid}\n`);
}

export function writeKey(paths, key) {
  writeAtomic(paths.key, `${key}\n`);
}

/**
 * `active` holds exactly one line: <owner_socket>\t<port>\t<key>[\t<nonce>]\n
 * The optional nonce is the per-bind voice-marker nonce hook.sh matches on.
 */
export function writeActive(paths, { socket, port, key, nonce }) {
  writeAtomic(paths.active, `${socket}\t${port}\t${key}${nonce ? `\t${nonce}` : ""}\n`);
}

/** `daemon.port` records the port this data dir's daemon listens on (toggle.sh finds it after a port change). */
export function writePort(paths, port) {
  writeAtomic(paths.port, `${port}\n`);
}

export function removeActive(paths) {
  return removeQuiet(paths.active);
}

/** Empty flag file consumed by hook.sh on the next PreToolUse (SPEC §0.2 #7). */
export function createPendingContext(paths) {
  try { fs.writeFileSync(paths.pendingContext, "", { mode: 0o600 }); return true; } catch { return false; }
}

export function removePendingContext(paths) {
  return removeQuiet(paths.pendingContext);
}

/** Local calendar date YYYY-MM-DD for a wall-clock ms value. */
export function localDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function readUsage(paths) {
  try {
    const u = JSON.parse(fs.readFileSync(paths.usage, "utf8"));
    if (u && typeof u.days === "object" && u.days) return { days: { ...u.days } };
  } catch { /* missing or corrupt: start fresh */ }
  return { days: {} };
}

/** Write usage.json, pruning entries older than 30 days relative to `nowMs`. */
export function writeUsage(paths, usage, nowMs) {
  const cutoff = localDate(nowMs - 30 * 86400_000);
  const days = {};
  for (const [k, v] of Object.entries(usage.days || {})) if (k >= cutoff) days[k] = v;
  usage.days = days;
  writeAtomic(paths.usage, JSON.stringify({ days }) + "\n");
}

/**
 * Throttled status.json writer: at most once per second, only on change.
 * `get()` returns the status object; `mark()` flags a change.
 */
export class StatusFileWriter {
  constructor({ paths, clock, get, intervalMs = 1000 }) {
    Object.assign(this, { paths, clock, get, intervalMs });
    this.dirty = false;
    this.timer = null;
    this.lastWrite = 0;
    this.last = "";
  }
  mark() {
    this.dirty = true;
    if (this.timer) return;
    const wait = Math.max(0, this.lastWrite + this.intervalMs - this.clock.now());
    this.timer = this.clock.setTimeout(() => { this.timer = null; this.flush(); }, wait);
  }
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.lastWrite = this.clock.now();
    try {
      const s = JSON.stringify(this.get(), null, 2) + "\n";
      if (s !== this.last) { writeAtomic(this.paths.status, s); this.last = s; }
    } catch { /* data dir removed: ignore */ }
  }
  stop() {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}
