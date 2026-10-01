// Cross-session inbox client (SPEC §6.9.1). Writes an auth line and one user
// message to the owner session's CLAUDE_CODE_MESSAGING_SOCKET.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * send({socket, token, content, msgId, priority}) → {ok:true} | {ok:false, code, message}
 * Codes: no_socket | refused | timeout | error.
 * A successful write is NOT a delivery receipt (the UserPromptSubmit hook is).
 */
export function send({ socket, token, content, msgId, priority = "next", timeoutMs = 2000, log } = {}) {
  return new Promise((resolve) => {
    try {
      const st = fs.lstatSync(socket);
      const uid = typeof process.getuid === "function" ? process.getuid() : st.uid;
      if (!st.isSocket() || st.uid !== uid) return resolve({ ok: false, code: "no_socket", message: "not a socket owned by this user" });
    } catch {
      return resolve({ ok: false, code: "no_socket", message: "socket not found" });
    }

    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const conn = net.createConnection({ path: socket });
    const timer = setTimeout(() => {
      conn.destroy();
      finish({ ok: false, code: "timeout", message: "inbox connect/write timed out" });
    }, timeoutMs);

    conn.on("error", (err) => {
      const code = err.code === "ENOENT" ? "no_socket" : err.code === "ECONNREFUSED" ? "refused" : "error";
      finish({ ok: false, code, message: err.code || err.message });
    });
    conn.on("data", (d) => log?.debug?.("inbox.reply", { bytes: d.length }));
    conn.on("connect", () => {
      const lines =
        JSON.stringify({ type: "auth", token }) + "\n" +
        JSON.stringify({ type: "user", message: { role: "user", content }, from_plugin: "sotto", msg_id: msgId, priority }) + "\n";
      conn.write(lines, (err) => {
        if (err) { conn.destroy(); finish({ ok: false, code: "error", message: err.code || err.message }); return; }
        conn.end();
        finish({ ok: true });
      });
    });
  });
}

// ---- Courier (SPEC §6.9.2) ----------------------------------------------------
// Claude Code 2.1.286 holds a message from a live process that is not one of
// the session's own children when the session bypasses permission prompts
// (peer_message_hold, cause no-mode-asserted), token or not: on macOS the
// token only counts once the poster has exited. The daemon is detached and
// long-lived, so it is held. The courier is a tiny stdio MCP server that the
// plugin declares (.mcp.json), so Claude Code spawns it as its own child in
// every session; the daemon hands it the message over a private unix socket
// and the courier writes the same two lines to its session's inbox.
// Verified 2026-10-01 (CLI 2.1.286, claude -p bypassPermissions): a direct
// post from a detached live process was held; the same post from the MCP
// child was delivered (origin selfSent, verifiedPeerPid = the courier).

const COURIER_SUN_PATH_MAX = 103; // macOS sockaddr_un.sun_path is 104 bytes incl. NUL

/**
 * Where the courier for an inbox socket listens: D/courier/<sha256(inbox)[:16]>.sock,
 * or /tmp/sotto-courier-<uid>/<same>.sock when that path is too long for a unix socket.
 * The daemon and the courier both compute it, so no registration is needed.
 */
export function courierPaths(dataDir, inboxSocket, { uid = typeof process.getuid === "function" ? process.getuid() : 0 } = {}) {
  const name = crypto.createHash("sha256").update(String(inboxSocket)).digest("hex").slice(0, 16);
  let dir = path.join(dataDir, "courier");
  if (Buffer.byteLength(path.join(dir, name + ".sock")) > COURIER_SUN_PATH_MAX) dir = `/tmp/sotto-courier-${uid}`;
  return { dir, socket: path.join(dir, name + ".sock"), pid: path.join(dir, name + ".pid") };
}

/** Is a courier running for this inbox socket? Sync: pid file, live pid, socket file. */
export function courierAlive(dataDir, inboxSocket, { kill = process.kill.bind(process) } = {}) {
  try {
    const p = courierPaths(dataDir, inboxSocket);
    const pid = Number(fs.readFileSync(p.pid, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    kill(pid, 0);
    return fs.lstatSync(p.socket).isSocket();
  } catch {
    return false;
  }
}

/**
 * Ask the session's courier to deliver one inbox message (op "send"), or
 * check it answers (op "ping").
 * → {ok:true, via:"courier"} | {ok:false, code, message, fallback}
 * `fallback: true` means the courier never took the message (none running,
 * a stale socket, a key it does not accept, no inbox in its env), so the
 * caller may post directly without a double send. Inbox errors the courier
 * reports (no_socket, refused, timeout) and a courier that went quiet after
 * taking the request are final.
 */
export function viaCourier({ dataDir, inboxSocket, key, content, msgId, priority = "next", timeoutMs = 2500, op = "send" } = {}) {
  return new Promise((resolve) => {
    let p;
    try { p = courierPaths(dataDir, inboxSocket); } catch (e) { return resolve({ ok: false, code: "no_courier", message: e.message, fallback: true }); }
    let done = false, written = false, buf = "";
    const conn = net.createConnection({ path: p.socket });
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); conn.destroy(); resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, code: written ? "timeout" : "no_courier", message: "courier timed out", fallback: !written }), timeoutMs);
    conn.on("error", (err) => finish({ ok: false, code: written ? "error" : "no_courier", message: err.code || err.message, fallback: !written }));
    conn.on("connect", () => {
      const req = op === "ping" ? { op: "ping", key } : { op: "send", key, content, msg_id: msgId, priority };
      conn.write(JSON.stringify(req) + "\n", () => { written = true; });
    });
    conn.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      let r = null;
      try { r = JSON.parse(buf.slice(0, i)); } catch { /* handled below */ }
      if (r && r.ok) return finish({ ok: true, via: "courier" });
      const code = (r && r.code) || "error";
      finish({ ok: false, code, message: (r && r.message) || code, fallback: code === "bad_key" || code === "no_inbox" });
    });
    conn.on("end", () => finish({ ok: false, code: "error", message: "courier closed without a reply", fallback: false }));
  });
}

// ---- Inbound hold risk (SPEC §6.9.2) --------------------------------------------

/**
 * crossSessionInbound from the settings this daemon can read: managed
 * settings win, then the user's settings ($CLAUDE_CONFIG_DIR or ~/.claude).
 * A --settings flag is invisible here. → "accept" | "hold" | "refuse" | null
 */
export function readInboundSetting({ env = process.env, home = os.homedir(), readFile = fs.readFileSync, platform = process.platform } = {}) {
  const pick = (f) => {
    try {
      const v = JSON.parse(readFile(f, "utf8"))?.crossSessionInbound;
      return v === "accept" || v === "hold" || v === "refuse" ? v : null;
    } catch { return null; }
  };
  const managed = platform === "darwin"
    ? "/Library/Application Support/ClaudeCode/managed-settings.json"
    : "/etc/claude-code/managed-settings.json";
  return pick(managed) || pick(path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "settings.json"));
}

/**
 * Will Claude Code hold or drop voice messages in this session?
 * → null (they are delivered) | "bypass" | "hold" | "refuse"
 * An explicit hold or refuse always applies. Otherwise only a session that
 * bypasses permission prompts holds a sender that is not its own child; the
 * courier is its own child, and an explicit accept delivers everything.
 */
export function inboundRisk({ permissionMode, courier, inbound }) {
  if (inbound === "refuse" || inbound === "hold") return inbound;
  if (inbound === "accept" || courier) return null;
  return permissionMode === "bypassPermissions" ? "bypass" : null;
}
