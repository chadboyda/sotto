// Self-update (SPEC §6.17): notice new code on disk and restart the daemon at
// the next quiet moment, handing the running state to the new process.
//
// This module is the pure-ish half: the source fingerprint and the Updater,
// which decides WHEN to restart. Voice.restartBlocker() says whether now is
// quiet; daemon/handover.js does the process swap. All time goes through
// `clock`, so the timing rules are tested with the fake clock.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** The directories whose sources make up "the code" (the daemon, the page, the hooks, the native app). */
export const SOURCE_DIRS = ["daemon", "web", "scripts", "app-native"];
/** How often the sources are checked: a stat of every file, then a hash only if a stat changed. */
export const CHECK_MS = 30_000;
/** A change must hold still this long before it counts (an editor or `git checkout` mid-write). */
export const SETTLE_MS = 5_000;
/** Automatic restart: this long with no speech either side (a live session). */
export const QUIET_MS = 45_000;
/** `/talk restart`: the user asked, so a short pause in the conversation is enough. */
export const MANUAL_QUIET_MS = 3_000;
/** While a restart is due, quiet is re-checked this often (no file access). */
export const QUIET_POLL_MS = 2_000;

const SKIP = (name) => name.startsWith(".") || name === "node_modules" || name === "build";

/** Every source file under SOURCE_DIRS, relative to `root`, sorted. */
export function listSources(root, { fsImpl = fs, dirs = SOURCE_DIRS } = {}) {
  const out = [];
  const walk = (rel, depth) => {
    let entries;
    try { entries = fsImpl.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP(e.name)) continue;
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { if (depth < 6) walk(r, depth + 1); } else if (e.isFile()) out.push(r);
    }
  };
  for (const d of dirs) walk(d, 0);
  return out.sort();
}

/** Cheap change detector: path, size and mtime of every source file. */
export function sourceSignature(root, { fsImpl = fs, dirs } = {}) {
  const parts = [];
  for (const rel of listSources(root, { fsImpl, dirs })) {
    try {
      const st = fsImpl.statSync(path.join(root, rel));
      parts.push(`${rel}:${st.size}:${st.mtimeMs}`);
    } catch { parts.push(`${rel}:gone`); }
  }
  return parts.join("\n");
}

/**
 * Content hash of the sources: {all, web} (hex, 16 chars). `web` alone tells
 * the page whether it must reload itself after a restart (§7.2).
 */
export function hashSources(root, { fsImpl = fs, dirs } = {}) {
  const all = createHash("sha256");
  const web = createHash("sha256");
  let files = 0;
  for (const rel of listSources(root, { fsImpl, dirs })) {
    let data;
    try { data = fsImpl.readFileSync(path.join(root, rel)); } catch { continue; }
    files++;
    for (const h of rel.startsWith(`web${path.sep}`) ? [all, web] : [all]) {
      h.update(rel);
      h.update("\0");
      h.update(data);
      h.update("\0");
    }
  }
  return { all: all.digest("hex").slice(0, 16), web: web.digest("hex").slice(0, 16), files };
}

/** Timings from the environment (tests and debugging, SPEC §4.4); invalid → default. */
export function updateTimings(env = {}) {
  const num = (v, d, min) => {
    const n = Number(v);
    return v !== undefined && v !== "" && Number.isFinite(n) && n >= min ? n : d;
  };
  return {
    enabled: env.SOTTO_UPDATE !== "0",
    checkMs: num(env.SOTTO_UPDATE_CHECK_MS, CHECK_MS, 200),
    settleMs: num(env.SOTTO_UPDATE_SETTLE_MS, SETTLE_MS, 0),
    quietMs: num(env.SOTTO_UPDATE_QUIET_MS, QUIET_MS, 0),
  };
}

/**
 * Decides when to restart.
 *   baseline  the hash the running code was loaded with
 *   check()   every checkMs: stat all sources; hash only when a stat changed
 *   a new hash that holds still for settleMs is "due"
 *   due → every QUIET_POLL_MS ask isQuiet(quietMs); null means quiet → restart()
 * A restart that fails (the new code does not start) is not retried until the
 * sources change again. requestManual() restarts at the next short pause
 * (MANUAL_QUIET_MS), changed code or not.
 *
 * @param {object} o
 * @param {string} o.root
 * @param {object} o.clock
 * @param {object} o.log
 * @param {(quietMs:number, o:{manual:boolean}) => string|null} o.isQuiet   null = quiet now, else the reason not to
 * @param {(r:{reason:string, from:object, to:object}) => Promise<{ok:boolean, code?:string}>} o.restart
 */
export class Updater {
  constructor({ root, clock, log, isQuiet, restart, env = {}, fsImpl = fs, baseline }) {
    Object.assign(this, { root, clock, log, isQuiet, restart, fsImpl });
    const t = updateTimings(env);
    this.enabled = t.enabled;
    this.checkMs = t.checkMs;
    this.settleMs = t.settleMs;
    this.quietMs = t.quietMs;
    const t0 = Date.now();
    this.sig = sourceSignature(root, { fsImpl });
    this.baseline = baseline || hashSources(root, { fsImpl });
    this.log?.info("update.baseline", { hash: this.baseline.all, files: this.baseline.files, ms: Date.now() - t0 });
    this.pending = null; // {hash, since, due}
    this.failed = null; // hash that failed to start
    this.manual = false;
    this.restarting = false;
    this.timers = {};
    this.lastBlock = null;
  }

  start() {
    if (!this.enabled) return this;
    this.timers.check = this.clock.setInterval(() => this.check(), this.checkMs);
    return this;
  }

  stop() {
    if (this.timers.check) this.clock.clearInterval(this.timers.check);
    if (this.timers.settle) this.clock.clearTimeout(this.timers.settle);
    if (this.timers.quiet) this.clock.clearInterval(this.timers.quiet);
    this.timers = {};
  }

  /** One periodic check. Returns the measured cost in ms (for the log/tests). */
  check() {
    if (this.restarting) return 0;
    const t0 = Date.now();
    const sig = sourceSignature(this.root, { fsImpl: this.fsImpl });
    if (sig === this.sig) return Date.now() - t0;
    this.sig = sig;
    const h = hashSources(this.root, { fsImpl: this.fsImpl });
    const ms = Date.now() - t0;
    if (h.all === this.baseline.all) {
      // Edited and changed back (or touched): nothing new to run.
      if (this.pending) this.log?.info("update.cancelled", { hash: h.all });
      this.pending = null;
      this.stopQuietPoll();
      return ms;
    }
    if (this.failed && h.all === this.failed) return ms;
    this.pending = { hash: h, since: this.clock.now(), due: false };
    this.log?.info("update.detected", { from: this.baseline.all, to: h.all, web_changed: h.web !== this.baseline.web, ms });
    // Settle: the same sources a moment later, or wait for the next change.
    if (this.timers.settle) this.clock.clearTimeout(this.timers.settle);
    this.timers.settle = this.clock.setTimeout(() => {
      delete this.timers.settle;
      if (!this.pending || this.pending.hash !== h) return;
      if (sourceSignature(this.root, { fsImpl: this.fsImpl }) !== this.sig) { this.check(); return; }
      this.pending.due = true;
      this.log?.info("update.due", { to: h.all });
      this.startQuietPoll();
      this.tryRestart();
    }, this.settleMs);
    return ms;
  }

  /** `/talk restart`. Returns "now" when it is quiet right away, else the reason it waits. */
  requestManual() {
    this.manual = true;
    const why = this.isQuiet(MANUAL_QUIET_MS, { manual: true });
    this.startQuietPoll();
    if (!why) { this.clock.setTimeout(() => this.tryRestart(), 0); return "now"; }
    return why;
  }

  startQuietPoll() {
    if (this.timers.quiet) return;
    this.timers.quiet = this.clock.setInterval(() => this.tryRestart(), QUIET_POLL_MS);
  }

  stopQuietPoll() {
    if (this.timers.quiet) this.clock.clearInterval(this.timers.quiet);
    delete this.timers.quiet;
  }

  async tryRestart() {
    if (this.restarting) return false;
    const auto = !!this.pending?.due;
    if (!auto && !this.manual) { this.stopQuietPoll(); return false; }
    const quietMs = this.manual ? MANUAL_QUIET_MS : this.quietMs;
    const why = this.isQuiet(quietMs, { manual: this.manual });
    if (why) {
      if (why !== this.lastBlock) this.log?.info("update.waiting", { why, manual: this.manual });
      this.lastBlock = why;
      return false;
    }
    this.lastBlock = null;
    this.restarting = true;
    this.stopQuietPoll();
    const reason = this.manual ? "manual" : "update";
    const to = this.pending?.hash || hashSources(this.root, { fsImpl: this.fsImpl });
    let r;
    try {
      r = await this.restart({ reason, from: this.baseline, to, quietMs });
    } catch (e) {
      r = { ok: false, code: "exception", message: String(e && e.message) };
    }
    this.restarting = false;
    if (r && r.ok) return true; // this process is on its way out
    this.log?.warn("update.failed", { reason, to: to.all, code: r?.code || null });
    if (r?.code === "not_quiet") { this.startQuietPoll(); return false; } // got busy meanwhile: try again later
    this.manual = false;
    if (this.pending) { this.failed = this.pending.hash.all; this.pending = null; }
    return false;
  }
}
