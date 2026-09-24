// Fake Claude Code inbox socket (NDJSON over a unix socket). Records every
// frame and never replies. Shared by daemon tests and the e2e smoke test.
//
// In-process:  const inbox = await startFakeInbox("/tmp/clv-x.sock"); … inbox.frames
// CLI:         node test/helpers/fake-inbox.js <socket> [frames.jsonl]
//              (appends each frame as one JSON line to frames.jsonl)
import net from "node:net";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * @param {string} socketPath  keep it short (/tmp/clv-<rand>.sock): macOS limit is 104 bytes
 * @param {{paused?: boolean, onFrame?: (frame, conn) => void}} [opts]
 *   paused: never read from connections (used to force write timeouts)
 */
export function startFakeInbox(socketPath, { paused = false, onFrame } = {}) {
  try { fs.unlinkSync(socketPath); } catch { /* not there */ }
  const frames = [];
  const connections = [];
  const waiters = [];
  const check = () => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (frames.length >= waiters[i].n) { waiters[i].resolve(frames); waiters.splice(i, 1); }
    }
  };
  const sockets = new Set();
  const server = net.createServer((conn) => {
    sockets.add(conn);
    conn.on("close", () => sockets.delete(conn));
    const c = { raw: "", lines: [] };
    connections.push(c);
    if (paused) { conn.pause(); return; }
    let buf = "";
    conn.setEncoding("utf8");
    conn.on("data", (d) => {
      c.raw += d;
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        c.lines.push(line);
        let frame;
        try { frame = JSON.parse(line); } catch { frame = { _raw: line }; }
        frames.push(frame);
        onFrame?.(frame, conn);
        check();
      }
    });
    conn.on("error", () => {});
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      resolve({
        path: socketPath,
        frames,
        connections,
        server,
        /** Resolve once at least n frames have arrived (or reject after ms). */
        waitFor(n, ms = 5000) {
          if (frames.length >= n) return Promise.resolve(frames);
          return new Promise((res, rej) => {
            const w = { n, resolve: res };
            waiters.push(w);
            setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej(new Error(`timeout waiting for ${n} frames (got ${frames.length})`)); } }, ms).unref?.();
          });
        },
        close() {
          return new Promise((res) => {
            server.close(() => { try { fs.unlinkSync(socketPath); } catch { /* ignore */ } res(); });
            for (const s of sockets) s.destroy();
          });
        },
      });
    });
  });
}

// CLI mode for the e2e smoke test.
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const [sock, out] = process.argv.slice(2);
  if (!sock) { process.stderr.write("usage: fake-inbox.js <socket> [frames.jsonl]\n"); process.exit(2); }
  startFakeInbox(sock, { onFrame: (f) => { if (out) fs.appendFileSync(out, JSON.stringify(f) + "\n"); } }).then(() => {
    process.stdout.write(`fake-inbox listening on ${sock}\n`);
  });
  const bye = () => { try { fs.unlinkSync(sock); } catch { /* ignore */ } process.exit(0); };
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
}
