// In-process fake daemon HTTP server that records every request.
// Used by the hook.sh tests (forwarding) and toggle.sh tests (foreign port).
import { createServer } from "node:http";

/**
 * @param {object} [opts]
 * @param {number} [opts.delayMs=0]   delay before answering /hook/* requests
 * @param {(req, body) => {status?:number, body?:string}} [opts.handler] custom reply
 * @returns {Promise<{port:number, requests:Array, close:() => Promise<void>, waitForRequests:(n:number, ms?:number)=>Promise<Array>}>}
 */
export async function startFakeDaemon({ delayMs = 0, handler } = {}) {
  const requests = [];
  const waiters = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method, url: req.url, headers: req.headers, body, at: Date.now() });
      for (const w of waiters.splice(0)) w();
      const reply = () => {
        const r = handler ? handler(req, body) : { status: 204, body: "" };
        res.writeHead(r.status ?? 200, { "Content-Type": "application/json" });
        res.end(r.body ?? "");
      };
      if (delayMs) setTimeout(reply, delayMs); else reply();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    port,
    requests,
    async waitForRequests(n, ms = 8000) {
      const end = Date.now() + ms;
      while (requests.length < n && Date.now() < end) {
        await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
      }
      return requests;
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(() => r()));
    },
  };
}
