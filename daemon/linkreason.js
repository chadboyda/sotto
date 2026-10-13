// Why a session stays on the classic link (SPEC §6.21 "Link reason"): the
// mod loads only on Claude Code 2.1.287+, and an older CLI ignores the
// `modules` key without a word, so /talk explains the fallback once. Pure,
// apart from the bounded transcript tail read.
import fs from "node:fs";

export const MOD_MIN_CLI = "2.1.287";
// How long a new-enough CLI's mod gets to say hello before "try /reload-plugins".
export const LINK_WAIT_MS = 5000;
const TAIL_BYTES = 64 * 1024;

/** "2.1.285", "2.1.285 (Claude Code)" → [2, 1, 285]; else null. */
export function parseVersion(s) {
  const m = /^\s*v?(\d{1,4})\.(\d{1,4})\.(\d{1,6})(?![\d.])/.exec(String(s ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Compare two version strings: -1, 0, 1; null when either does not parse. */
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * The CLI version that last wrote this transcript: its last `"version"` field.
 * A long-lived session's transcript keeps the version it was started with,
 * which is what the user's report came down to (2.1.285 in a background
 * session). Reads at most the last 64 KB. → "x.y.z" or null.
 */
export function transcriptVersion(file, fsImpl = fs) {
  if (typeof file !== "string" || !file) return null;
  let fd;
  try {
    fd = fsImpl.openSync(file, "r");
    const size = fsImpl.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fsImpl.readSync(fd, buf, 0, len, size - len);
    let last = null;
    for (const m of buf.toString("utf8").matchAll(/"version"\s*:\s*"(\d{1,4}\.\d{1,4}\.\d{1,6})"/g)) last = m[1];
    return last;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fsImpl.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Why the link is classic, known before any mod could say hello, else null.
 * `integration` is SOTTO_INTEGRATION or the userConfig option; `cli` the
 * session's Claude Code version.
 */
export function staticLinkReason({ integration = null, cli = null } = {}) {
  if (integration === "classic" || integration === "off") return { code: "integration_classic", integration, cli };
  if (cli && compareVersions(cli, MOD_MIN_CLI) === -1) return { code: "cli_too_old", cli };
  return null;
}

/** The reason when a new-enough (or unknown) CLI's mod did not link in LINK_WAIT_MS. */
export function notLinkedReason({ cli = null } = {}) {
  return { code: "not_linked", cli };
}

/** The short status suffix: `link classic (…)`. */
export function linkSuffix(reason) {
  if (!reason) return "link classic";
  if (reason.code === "cli_too_old") return `link classic (Claude Code ${reason.cli})`;
  if (reason.code === "integration_classic") return `link classic (integration=${reason.integration})`;
  return "link classic (mod not linked)";
}

/** The full sentence, said once per session. */
export function linkSentence(reason) {
  if (!reason) return "";
  if (reason.code === "cli_too_old") {
    return `sotto: this session runs Claude Code ${reason.cli}; mods need ${MOD_MIN_CLI}+, so voice uses the classic link. Restart it (claude respawn <id> for background sessions, or claude --resume) to get the mod.`;
  }
  if (reason.code === "integration_classic") {
    return `sotto: the classic link is set (integration=${reason.integration}), so the mod stays off in this session.`;
  }
  return `sotto: the Claude Code mod has not linked in this session, so voice uses the classic link; try /reload-plugins.`;
}
