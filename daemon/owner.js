// Owner binding (SPEC §6.5). The owner identity is the inbox socket path.
import fs from "node:fs";
import path from "node:path";

/** Build the owner record from a /control `session` object. */
export function makeOwner(session, nowMs) {
  const s = session || {};
  const project = path.basename(s.project_dir || s.cwd || "") || "this project";
  return {
    socket: String(s.socket),
    token: typeof s.token === "string" ? s.token : "", // memory only; never logged or exposed
    session_id: s.session_id || null,
    claude_pid: Number.isInteger(s.claude_pid) && s.claude_pid > 0 ? s.claude_pid : null,
    cwd: s.cwd || s.project_dir || null,
    project_dir: s.project_dir || null,
    project,
    transcript_path: s.transcript_path || null,
    since: nowMs,
  };
}

/** Public view for /status (no token). */
export function ownerStatus(owner) {
  if (!owner) return null;
  return {
    session_id: owner.session_id,
    socket: owner.socket,
    project: owner.project,
    cwd: owner.cwd,
    since: new Date(owner.since).toISOString(),
  };
}

/** Is the owner session alive? pid probe when known, else socket stat. */
export function isOwnerAlive(owner, { kill = process.kill.bind(process), statSync = fs.statSync } = {}) {
  if (!owner) return false;
  if (owner.claude_pid) {
    try { kill(owner.claude_pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; }
  }
  try { return statSync(owner.socket).isSocket(); } catch { return false; }
}
