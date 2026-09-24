// Layout stability of the live view (SPEC-DEVIATIONS "status word"): the word
// under the dial changes with the floor ("Listening", "Hearing you",
// "Speaking", "Muted", an approval), but the Claude card and the captions
// below it must never move. Measured in real headless Chrome on the real
// index.html + styles.css, with the stage filled from lib.pageView() the way
// app.js renderStage() fills it. app.js itself is replaced by an empty module
// (no daemon, no microphone, no audio). Skipped where Chrome is not installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHROME, spawnSilentChrome } from "../helpers/silent-chrome.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WEB = path.join(ROOT, "web");
const WAV = path.join(ROOT, "test", "fixtures", "ask-files.wav");
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms) {
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

async function connect(userDir, base) {
  const devPort = await until(() => fs.readFileSync(path.join(userDir, "DevToolsActivePort"), "utf8").split("\n")[0].trim(), 10000);
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json())
    .find((t) => t.type === "page" && t.url.startsWith(base)), 10000);
  if (!target) throw new Error("no page target");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
  return {
    send,
    async eval(expression) {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
      return r.result?.result?.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

// Fill the stage the way app.js renderStage() does, then measure.
const MEASURE = `(async () => {
  const lib = await import("/lib.js");
  const $ = (id) => document.getElementById(id);
  const b = document.body.dataset;
  // A working Claude card and two caption lines, as in a real session.
  b.claude = "working";
  $("claude-title").textContent = "Claude is working";
  $("claude-step").hidden = false;
  $("claude-step").textContent = "I found the bug in voice.js. Fixing it now.";
  for (const [id, who, text] of [["cap-prev", "You", "Can you check the tests"], ["cap-latest", "Sotto", "Sure, asking Claude now."]]) {
    const li = $(id); li.hidden = false; li.firstElementChild.textContent = who; li.lastElementChild.textContent = text;
  }
  $("captions-empty").hidden = true;
  const out = {};
  const states = { listening: {}, you: { floor: "you" }, voice: { floor: "voice" }, muted: { muted: true }, approval: { attention: true }, approvalMuted: { attention: true, muted: true } };
  for (const [name, s] of Object.entries(states)) {
    const v = lib.pageView({ phase: "live", state: "live", ...s });
    b.view = v.view; b.dial = v.dial; b.floor = v.floor; b.card = "";
    $("stage-word").textContent = v.word;
    $("stage-word").dataset.tone = v.wordTone || "";
    $("stage-sub").hidden = v.view === "live" ? false : !v.sub;
    $("stage-sub").textContent = v.sub || "";
    $("key-hint").hidden = false;
    $("connect-steps").hidden = true;
    $("overlay").hidden = true;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    out[name] = {
      word: v.word,
      captions: Math.round($("captions-panel").getBoundingClientRect().top * 10) / 10,
      claude: Math.round($("claude").getBoundingClientRect().top * 10) / 10,
      hint: Math.round($("key-hint").getBoundingClientRect().top * 10) / 10,
    };
  }
  return out;
})()`;

test("live view: the Claude card and the captions never move when the status word changes", { skip: fs.existsSync(CHROME) ? false : "Chrome not installed", timeout: 60000 }, async (t) => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "sotto-layout-"));
  const chrome = spawnSilentChrome({ wav: WAV, extra: ["--remote-debugging-port=0", `--user-data-dir=${userDir}`, "--window-size=420,760", base] });
  let page;
  t.after(() => {
    page?.close();
    try { chrome.kill("SIGTERM"); } catch { /* gone */ }
    server.close();
    setTimeout(() => fs.rmSync(userDir, { recursive: true, force: true }), 500).unref();
  });
  page = await connect(userDir, base);
  await until(() => page.eval(`document.readyState === "complete"`), 10000);
  for (const [w, h] of [[420, 760], [360, 640], [560, 900]]) {
    await page.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    const m = await page.eval(MEASURE);
    const rows = Object.values(m);
    assert.equal(rows.length, 6);
    for (const key of ["captions", "claude", "hint"]) {
      const tops = new Set(rows.map((r) => r[key]));
      assert.equal(tops.size, 1, `${w}x${h}: ${key} top moved across states: ${JSON.stringify(m)}`);
    }
  }
});
