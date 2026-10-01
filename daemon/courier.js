// The courier (SPEC §6.9.2): a stdio MCP server with no tools that the plugin
// declares in .mcp.json, so Claude Code starts one in every session as its
// own child process and keeps it running. It listens on a private unix socket
// (daemon/inbox.js courierPaths) and, for the daemon (authenticated with
// D/daemon.key), writes voice messages to its own session's inbox socket.
// Claude Code verifies a live child as the session's own and delivers its
// messages even when the session bypasses permission prompts, where a post
// from the detached daemon is held (verified with CLI 2.1.286).
//
// Cost when voice is off: one idle process per session, no tools, no
// instructions (nothing enters the model's context), no network.
// Runs on any Node >= 18 or Bun; zero dependencies.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { courierPaths, send as inboxSend } from "./inbox.js";

const MAX_REQUEST = 4 * 1024 * 1024; // a voice message is a few KB; refuse anything absurd
const VERSION = "1";

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/**
 * Start the courier's listener. Returns {paths, close()} or null when the
 * session has no inbox socket (nothing to deliver to; the MCP side still runs).
 * @param {object} o
 * @param {object} o.env        CLAUDE_CODE_MESSAGING_SOCKET/TOKEN, CLAUDE_PLUGIN_DATA
 * @param {Function} [o.send]   inbox client (tests)
 */
export async function startCourier({ env = process.env, send = inboxSend, log = () => {} } = {}) {
  const inbox = env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (!inbox) { log("no_inbox"); return null; }
  const dataDir = env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".sotto");
  const p = courierPaths(dataDir, inbox);
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(p.dir, 0o700); } catch { /* not ours to fix */ }
  // A courier for the same inbox socket (an /mcp reconnect) replaces the old one.
  try { fs.unlinkSync(p.socket); } catch { /* none */ }
  const keyFile = path.join(dataDir, "daemon.key");

  const handle = async (line) => {
    let req;
    try { req = JSON.parse(line); } catch { return { ok: false, code: "bad_request" }; }
    let key = "";
    try { key = fs.readFileSync(keyFile, "utf8").trim(); } catch { /* no daemon yet */ }
    if (!req || !safeEqual(req.key, key)) return { ok: false, code: "bad_key" };
    if (req.op === "ping") return { ok: true, pid: process.pid, version: VERSION };
    if (req.op !== "send" || typeof req.content !== "string") return { ok: false, code: "bad_request" };
    const r = await send({
      socket: inbox, token: env.CLAUDE_CODE_MESSAGING_TOKEN || "", content: req.content,
      msgId: typeof req.msg_id === "string" ? req.msg_id : undefined,
      priority: req.priority === "later" ? "later" : "next",
    });
    return r.ok ? { ok: true } : { ok: false, code: r.code, message: r.message };
  };

  const server = net.createServer((conn) => {
    let buf = "", busy = false;
    conn.setTimeout(10000, () => conn.destroy());
    conn.on("error", () => {});
    conn.on("data", async (d) => {
      if (busy) return;
      buf += d;
      if (buf.length > MAX_REQUEST) { busy = true; conn.end(JSON.stringify({ ok: false, code: "too_large" }) + "\n"); return; }
      const i = buf.indexOf("\n");
      if (i < 0) return;
      busy = true;
      let out;
      try { out = await handle(buf.slice(0, i)); } catch (e) { out = { ok: false, code: "error", message: e.message }; }
      log(out.ok ? "sent" : out.code);
      conn.end(JSON.stringify(out) + "\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(p.socket, () => { server.off("error", reject); resolve(); });
  });
  try { fs.chmodSync(p.socket, 0o600); } catch { /* the dir is 0700 anyway */ }
  fs.writeFileSync(p.pid, String(process.pid) + "\n", { mode: 0o600 });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { server.close(); } catch { /* ignore */ }
    // Remove only our own files: a newer courier may have replaced them.
    try { if (fs.readFileSync(p.pid, "utf8").trim() === String(process.pid)) { fs.unlinkSync(p.pid); fs.unlinkSync(p.socket); } } catch { /* gone */ }
  };
  return { paths: p, close };
}

/**
 * Minimal MCP stdio server: newline-delimited JSON-RPC. Advertises no
 * capabilities beyond the handshake, so it adds no tools, prompts or
 * instructions to the session. Unknown requests get "method not found".
 */
export function serveMcp({ input = process.stdin, output = process.stdout, onEnd = () => {} } = {}) {
  let buf = "";
  const reply = (msg) => { try { output.write(JSON.stringify(msg) + "\n"); } catch { /* client gone */ } };
  input.setEncoding?.("utf8");
  input.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (!m || m.id === undefined || m.id === null || typeof m.method !== "string") continue; // notifications, responses
      if (m.method === "initialize") {
        reply({ jsonrpc: "2.0", id: m.id, result: {
          protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "2025-06-18",
          capabilities: {},
          serverInfo: { name: "sotto-courier", version: VERSION },
        } });
      } else if (m.method === "ping") reply({ jsonrpc: "2.0", id: m.id, result: {} });
      else if (m.method === "tools/list") reply({ jsonrpc: "2.0", id: m.id, result: { tools: [] } });
      else reply({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
    }
  });
  input.on("end", onEnd);
  input.on("close", onEnd);
}

// Entry: `node daemon/courier.js` (scripts/courier.sh, from .mcp.json).
// realpath: the symlink install runs it through ~/.claude/skills/sotto, and
// Node resolves the main module's URL to the real path.
const isMain = () => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
};
if (isMain()) {
  const debug = process.env.SOTTO_COURIER_LOG; // a file path; tests and debugging only
  const log = (ev) => { if (debug) try { fs.appendFileSync(debug, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ev }) + "\n"); } catch { /* ignore */ } };
  let courier = null;
  const quit = () => { courier?.close(); process.exit(0); };
  // The MCP handshake must never wait on the listener, and a listener failure
  // must not fail the MCP server (that shows as a failed server in /mcp).
  serveMcp({ onEnd: quit });
  process.on("SIGTERM", quit);
  process.on("SIGINT", quit);
  process.on("SIGHUP", quit);
  process.on("uncaughtException", (e) => log("error:" + e.message));
  startCourier({ log }).then((c) => { courier = c; log(c ? "listening" : "idle"); }, (e) => log("listen_error:" + e.message));
}
