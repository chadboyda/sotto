// Builds a fully injected daemon (fake clock, fetch, WebSocket, inbox, chrome)
// for voice-lifecycle and HTTP tests. Nothing here touches the network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createDaemon } from "../../daemon/index.js";
import { createMemoryLogger } from "../../daemon/log.js";
import { createFakeClock } from "./fake-clock.js";
import { createFakeWSClass } from "./fake-ws.js";
import { createFakeKeychain } from "./fake-keychain.js";

export function tmpDir(prefix = "clv-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A free loopback port (the Host check needs the real port up front). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

export function makePluginRoot() {
  const root = tmpDir("clv-root-");
  fs.mkdirSync(path.join(root, "web"));
  fs.writeFileSync(path.join(root, "web", "index.html"), "<!doctype html><title>sotto</title>");
  fs.writeFileSync(path.join(root, "web", "app.js"), "export {};\n");
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  return root;
}

export const SESSION = (socket = "/tmp/clv-owner-a.sock", extra = {}) => ({
  session_id: "sess-a", socket, token: "inbox-token-a", cwd: "/work/proj-a", project_dir: "/work/proj-a",
  transcript_path: "/nonexistent/t.jsonl", ...extra,
});

/**
 * makeHarness({env, clock, port, config}) → h with:
 *   d (createDaemon result), voice, clock, WS, fetchCalls, inboxSends, chrome,
 *   sse (captured broadcasts), exits, log, setFetch(fn), ownerAlive flag.
 */
export async function makeHarness({ env = { OPENAI_API_KEY: "sk-test-key" }, clock, port, realClock = false, onRestart, dataDir, pageToken, daemonKey, keychain = createFakeKeychain(), userConfigKey } = {}) {
  const h = {
    clock: realClock ? undefined : clock || createFakeClock(),
    WS: createFakeWSClass(),
    fetchCalls: [],
    inboxSends: [],
    inboxResult: { ok: true },
    sse: [],
    exits: [],
    ownerAlive: true,
    log: createMemoryLogger(),
    dataDir: dataDir || tmpDir("clv-data-"),
    pluginRoot: makePluginRoot(),
    port: port || (await freePort()),
    liveCounter: 0,
    keychain,
  };
  h.fetchImpl = async (url, init) => {
    h.fetchCalls.push({ url, init, body: JSON.parse(init.body) });
    const id = `live_test_${++h.liveCounter}`;
    return { status: 201, text: async () => JSON.stringify({ session: { id }, transport: { type: "webrtc", sdp: "v=0 answer" } }) };
  };
  h.setFetch = (fn) => { h.fetchImpl = fn; };
  h.chrome = {
    opened: 0, killed: 0, notified: [],
    open() { this.opened++; return { mode: "chrome" }; },
    async kill() { this.killed++; return 0; },
    notify(t) { this.notified.push(t); },
  };
  const probe = {
    kill: () => { if (!h.ownerAlive) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); },
    statSync: () => ({ isSocket: () => h.ownerAlive }),
  };
  const opts = {
    dataDir: h.dataDir, port: h.port, pluginRoot: h.pluginRoot, env, keychain, userConfigKey,
    fetchImpl: (...a) => h.fetchImpl(...a), WebSocketImpl: h.WS,
    inbox: { send: async (m) => { h.inboxSends.push(m); return h.inboxResult; } },
    chrome: h.chrome, log: h.log, onExit: (r) => h.exits.push(r), owner: probe,
    execFile: (cmd, args, o, cb) => cb(null, "main\n"),
  };
  if (onRestart) opts.onRestart = onRestart;
  if (pageToken) opts.pageToken = pageToken;
  if (daemonKey) opts.daemonKey = daemonKey;
  if (h.clock) opts.clock = h.clock;
  h.d = createDaemon(opts);
  h.voice = h.d.voice;
  const orig = h.d.sse.broadcast.bind(h.d.sse);
  h.d.sse.broadcast = (m) => { h.sse.push(m); orig(m); };
  h.commands = () => h.sse.filter((m) => m.type === "command").map((m) => m.command + ":" + m.reason);

  h.on = (session = SESSION(), config = {}) => h.voice.control({ action: "on", session, config: { open_browser: true, ...config } });

  /** Turn on, create a Live session and make its sideband ready. Returns the fake socket. */
  h.goLive = async ({ session = SESSION(), config = {}, reason = "start", expiresIn = 7200 } = {}) => {
    if (!h.voice.owner) h.on(session, config);
    const r = await h.voice.createSession({ sdp: "v=0 offer", reason });
    if (r.status !== 201) throw new Error(`createSession ${r.status} ${JSON.stringify(r.body)}`);
    const ws = h.WS.last();
    ws.open();
    const now = h.clock ? h.clock.now() : Date.now();
    ws.receive({ type: "session.started", session: { id: r.body.session_id, expires_at: Math.floor(now / 1000) + expiresIn } });
    return ws;
  };

  /** Reply to a pending session.close with session.closed. */
  h.closeReply = (ws, reason = "close_requested", seconds = 1) => ws.receive({ type: "session.closed", reason, usage: { seconds } });

  h.cleanup = async () => {
    await h.d.close();
    fs.rmSync(h.dataDir, { recursive: true, force: true });
    fs.rmSync(h.pluginRoot, { recursive: true, force: true });
  };
  return h;
}
