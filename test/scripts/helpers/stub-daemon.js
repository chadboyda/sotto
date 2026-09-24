#!/usr/bin/env node
// Stub daemon for toggle.sh tests (set as SOTTO_DAEMON_ENTRY).
// Mimics the real daemon's CLI, state files and the two routes toggle.sh uses:
//   node stub-daemon.js --port <n> --data-dir <D> --plugin-root <ROOT>
// - writes D/daemon.pid and D/daemon.key before listen()
// - GET  /healthz            -> SPEC §6.4 identity JSON
// - POST /control?format=hook -> {"continue":false,"stopReason":"stub: <action>"}
//   (requires X-Sotto-Key); each body is appended to D/stub-control.jsonl
// - {"action":"shutdown"} replies, then exits (after CLV_STUB_SHUTDOWN_MS)
// - writes D/daemon.port like the real daemon
// It exits by itself after 60 s so a failed test never leaks it.
import { createServer } from "node:http";
import { writeFileSync, appendFileSync, rmSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const port = Number(opt("--port"));
const dataDir = opt("--data-dir");
const pluginRoot = opt("--plugin-root");
if (!port || !dataDir || !pluginRoot) process.exit(2);

const key = randomBytes(32).toString("hex");
writeFileSync(join(dataDir, "daemon.pid"), `${process.pid}\n`, { mode: 0o600 });
writeFileSync(join(dataDir, "daemon.key"), `${key}\n`, { mode: 0o600 });
// Record how we were launched so tests can check argv and the parent pid.
// userConfigKey: the sensitive userConfig key toggle.sh hands over in the env.
const userConfigKey = process.env.CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY || "";
writeFileSync(join(dataDir, "stub-argv.json"), JSON.stringify({ argv: args, ppid: process.ppid, cwd: process.cwd(), userConfigKey }));
writeFileSync(join(dataDir, "daemon.port"), `${port}\n`, { mode: 0o600 });

const bye = () => {
  try { rmSync(join(dataDir, "daemon.pid")); } catch {}
  try { rmSync(join(dataDir, "daemon.port")); } catch {}
  process.exit(0);
};
setTimeout(bye, Number(process.env.CLV_STUB_LIFETIME_MS || 60000)).unref();
process.on("SIGTERM", bye);

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: "sotto", version: "0.2.1", pid: process.pid, port, data_dir: dataDir, plugin_root: pluginRoot, state: "off", api_key: !!userConfigKey || existsSync(join(dataDir, "stub-has-key")) }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/control") {
      // D/stub-die-next: drop this request unanswered and exit, like a daemon
      // whose exit-after-off timer fires while a /control is in flight.
      if (existsSync(join(dataDir, "stub-die-next"))) {
        rmSync(join(dataDir, "stub-die-next"));
        req.socket.destroy();
        bye();
        return;
      }
      if (req.headers["x-sotto-key"] !== key) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":{"code":"bad_key"}}');
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      appendFileSync(join(dataDir, "stub-control.jsonl"), raw + "\n");
      let action = "?";
      try { action = JSON.parse(raw).action; } catch { action = "bad_json"; }
      res.writeHead(200, { "Content-Type": "application/json" });
      const msg = `stub: ${action}`;
      res.end(url.searchParams.get("format") === "hook"
        ? JSON.stringify({ continue: false, stopReason: msg })
        : JSON.stringify({ ok: true, state: "off", message: msg }));
      // CLV_STUB_SHUTDOWN_MS: keep answering /healthz this long after a shutdown,
      // like an older daemon that closes its Live session before exiting.
      if (action === "shutdown") setTimeout(bye, Number(process.env.CLV_STUB_SHUTDOWN_MS || 20));
      return;
    }
    res.writeHead(404); res.end();
  });
});
server.listen(port, "127.0.0.1");
