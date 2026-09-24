// The real web/index.html + styles.css in silent headless Chrome, for layout tests.
// app.js is replaced by an empty module (no daemon, no microphone, no audio), so a
// test fills the DOM itself the way app.js would. Chrome goes through
// spawnSilentChrome (muted, fake mic): tests never touch the real mic or speakers.
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHROME, spawnSilentChrome } from "./silent-chrome.js";

export { CHROME };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WEB = path.join(ROOT, "web");
const WAV = path.join(ROOT, "test", "fixtures", "ask-files.wav");
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() > end) return null;
    await sleep(100);
  }
}

function serve() {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/app.js") { res.writeHead(200, { "Content-Type": "text/javascript" }); return res.end("export {};"); }
    const file = path.join(WEB, p === "/" ? "index.html" : p);
    if (!file.startsWith(WEB) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/**
 * Open the page; returns { send, eval, setSize, base }. Cleanup is registered on `t`.
 */
export async function openPage(t, { width = 420, height = 760 } = {}) {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "sotto-webpage-"));
  const chrome = spawnSilentChrome({ wav: WAV, extra: ["--remote-debugging-port=0", `--user-data-dir=${userDir}`, `--window-size=${width},${height}`, base] });
  let ws;
  t.after(() => {
    try { ws?.close(); } catch { /* ignore */ }
    try { chrome.kill("SIGTERM"); } catch { /* gone */ }
    server.close();
    setTimeout(() => fs.rmSync(userDir, { recursive: true, force: true }), 500).unref();
  });
  const devPort = await until(() => fs.readFileSync(path.join(userDir, "DevToolsActivePort"), "utf8").split("\n")[0].trim(), 10000);
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json())
    .find((x) => x.type === "page" && x.url.startsWith(base)), 10000);
  if (!target) throw new Error("no page target");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
  const page = {
    base,
    send,
    async eval(expression) {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
      return r.result?.result?.value;
    },
    frames() {
      return page.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
    },
    async setSize(w, h) {
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      // The override lands asynchronously; wait for the new viewport and a layout.
      await until(() => page.eval(`window.innerWidth === ${w} && window.innerHeight === ${h}`), 10000);
      await page.frames();
    },
  };
  await until(() => page.eval(`document.readyState === "complete"`), 10000);
  return page;
}
