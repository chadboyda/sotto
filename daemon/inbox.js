// Cross-session inbox client (SPEC §6.9.1). Writes an auth line and one user
// message to the owner session's CLAUDE_CODE_MESSAGING_SOCKET.
import fs from "node:fs";
import net from "node:net";

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
