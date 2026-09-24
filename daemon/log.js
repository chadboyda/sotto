// JSONL logger with size rotation (SPEC §10).
// Never pass secrets in fields; as a last line of defense, fields whose names
// look like secrets are redacted.
import fs from "node:fs";
import path from "node:path";

const SECRET_KEYS = /^(token|key|api_key|apikey|authorization|page_token|daemon_key|secret)$/i;

function redact(fields) {
  if (!fields || typeof fields !== "object") return fields;
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = SECRET_KEYS.test(k) ? "[redacted]" : v;
  return out;
}

export function truncate(s, n = 500) {
  if (typeof s !== "string") return s;
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/**
 * createLogger({dir, debug, maxBytes}) → {debug, info, warn, error, crash, isDebug}
 * Writes D/logs/daemon.log; rotates to daemon.log.1 once past maxBytes.
 */
export function createLogger({ dir, debug = false, maxBytes = 5 * 1024 * 1024, now = () => Date.now() } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "daemon.log");
  const crashFile = path.join(dir, "crash.log");
  let size = 0;
  try { size = fs.statSync(file).size; } catch { size = 0; }

  function write(lvl, ev, fields) {
    if (lvl === "debug" && !debug) return;
    const line = JSON.stringify({ ts: new Date(now()).toISOString(), lvl, ev, ...redact(fields) }) + "\n";
    try {
      if (size + line.length > maxBytes) {
        try { fs.renameSync(file, file + ".1"); } catch { /* ignore */ }
        size = 0;
      }
      fs.appendFileSync(file, line, { mode: 0o600 });
      size += Buffer.byteLength(line);
    } catch { /* logging must never throw */ }
  }

  return {
    isDebug: debug,
    debug: (ev, f) => write("debug", ev, f),
    info: (ev, f) => write("info", ev, f),
    warn: (ev, f) => write("warn", ev, f),
    error: (ev, f) => write("error", ev, f),
    crash(kind, err) {
      const text = `${new Date(now()).toISOString()} ${kind}: ${err && err.stack ? err.stack : String(err)}\n`;
      try { fs.appendFileSync(crashFile, text, { mode: 0o600 }); } catch { /* ignore */ }
      write("error", kind, { message: truncate(String(err && err.message ? err.message : err), 500) });
    },
  };
}

/** In-memory logger for tests: entries are kept in `.entries`. */
export function createMemoryLogger({ debug = true } = {}) {
  const entries = [];
  const mk = (lvl) => (ev, f) => { if (lvl !== "debug" || debug) entries.push({ lvl, ev, ...redact(f) }); };
  return {
    entries,
    isDebug: debug,
    debug: mk("debug"), info: mk("info"), warn: mk("warn"), error: mk("error"),
    crash: (kind, err) => entries.push({ lvl: "error", ev: kind, message: String(err) }),
    find: (ev) => entries.filter((e) => e.ev === ev),
  };
}
