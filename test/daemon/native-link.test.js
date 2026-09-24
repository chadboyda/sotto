// The native app link (docs/NATIVE.md §1-§3): RFC 6455 framing
// (daemon/wsserver.js), the /api/native endpoint's checks and handshake
// (daemon/native.js), and the whole chain over real loopback sockets:
// FakeNativeApp -> daemon -> fake Live primary server. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { randomBytes } from "node:crypto";
import {
  acceptKey, encodeServerFrame, createFrameParser, acceptUpgrade, OP,
} from "../../daemon/wsserver.js";
import { createNativeEndpoint } from "../../daemon/native.js";
import { NATIVE_PATH, SUBPROTOCOL, CLOSE, FRAME_BYTES, KIND, FLAG, encodeFrame } from "../../daemon/native-proto.js";
import { createMemoryLogger } from "../../daemon/log.js";
import { realClock } from "../../daemon/index.js";
import { makeHarness, SESSION } from "../helpers/daemon-harness.js";
import { FakeNativeApp, bootstrap, pcmPeak } from "../helpers/fake-native-app.js";
import { startFakeLiveServer } from "../helpers/fake-live-server.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A client frame (masked, as RFC 6455 requires of clients). */
function clientFrame(opcode, payload, { fin = true, mask = true } = {}) {
  const body = Buffer.from(payload);
  const n = body.length;
  const head = n < 126 ? Buffer.from([0, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (n >= 126 && n < 65536) { head[1] = 126; head.writeUInt16BE(n, 2); }
  else if (n >= 65536) { head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  head[0] = (fin ? 0x80 : 0) | opcode;
  if (!mask) return Buffer.concat([head, body]);
  head[1] |= 0x80;
  const m = randomBytes(4);
  const out = Buffer.from(body);
  for (let i = 0; i < out.length; i++) out[i] ^= m[i & 3];
  return Buffer.concat([head, m, out]);
}

// ---- wsserver.js --------------------------------------------------------------------------

test("acceptKey: the RFC 6455 example", () => {
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("encodeServerFrame: 7/16/64-bit lengths, never masked", () => {
  for (const n of [0, 125, 126, 65535, 65536, 70000]) {
    const f = encodeServerFrame(OP.BINARY, Buffer.alloc(n, 7));
    assert.equal(f[0], 0x82);
    assert.equal(f[1] & 0x80, 0);
    const len = f[1] & 0x7f;
    if (n < 126) assert.equal(len, n);
    else if (n < 65536) { assert.equal(len, 126); assert.equal(f.readUInt16BE(2), n); }
    else { assert.equal(len, 127); assert.equal(Number(f.readBigUInt64BE(2)), n); }
  }
  assert.equal(encodeServerFrame(OP.TEXT, "x", false)[0], 0x01, "FIN clear");
});

test("createFrameParser: masking, fragmentation, control frames, split chunks, limits", () => {
  const msgs = [];
  const ctl = [];
  const errs = [];
  const p = createFrameParser({ maxBytes: 1000, onMessage: (op, d) => msgs.push([op, d.toString()]), onControl: (op, d) => ctl.push([op, d.toString()]), onError: (c, r) => errs.push([c, r]) });
  const all = Buffer.concat([
    clientFrame(OP.TEXT, "hel", { fin: false }),
    clientFrame(OP.PING, "p"),
    clientFrame(OP.CONT, "lo", { fin: true }),
    clientFrame(OP.BINARY, Buffer.alloc(300, 65)),
  ]);
  for (let i = 0; i < all.length; i += 7) p.push(all.subarray(i, i + 7)); // byte dribble
  assert.deepEqual(msgs[0], [OP.TEXT, "hello"]);
  assert.equal(msgs[1][1].length, 300);
  assert.deepEqual(ctl, [[OP.PING, "p"]]);
  assert.deepEqual(errs, []);
  const e1 = []; createFrameParser({ onError: (c) => e1.push(c) }).push(clientFrame(OP.TEXT, "x", { mask: false }));
  assert.deepEqual(e1, [1002], "unmasked client frame");
  const e2 = []; createFrameParser({ maxBytes: 10, onError: (c) => e2.push(c) }).push(clientFrame(OP.BINARY, Buffer.alloc(11)));
  assert.deepEqual(e2, [1009]);
  const e3 = []; const p3 = createFrameParser({ maxBytes: 10, onError: (c) => e3.push(c) });
  p3.push(clientFrame(OP.TEXT, "123456", { fin: false })); p3.push(clientFrame(OP.CONT, "7890ab"));
  assert.deepEqual(e3, [1009], "fragments add up");
  const e4 = []; createFrameParser({ onError: (c) => e4.push(c) }).push(clientFrame(OP.CONT, "x"));
  assert.deepEqual(e4, [1002], "continuation without a start");
});

test("acceptUpgrade against Node's WebSocket client: text, binary, ping, close, oversize -> 1009", async (t) => {
  const server = http.createServer();
  let conn;
  server.on("upgrade", (req, socket, head) => {
    conn = acceptUpgrade(req, socket, head, { protocol: "p1", maxBytes: 2048 });
    conn.on("text", (s) => conn.sendText(`echo:${s}`));
    conn.on("binary", (b) => conn.sendBinary(Buffer.concat([b, b])));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, ["p1"]);
  ws.binaryType = "arraybuffer";
  const got = [];
  ws.onmessage = (e) => got.push(e.data);
  await new Promise((r) => { ws.onopen = r; });
  assert.equal(ws.protocol, "p1");
  ws.send("hi");
  ws.send(new Uint8Array([1, 2, 3]));
  ws.send("x".repeat(20000)); // fragmented or not, it is one message
  const closed = new Promise((r) => { ws.onclose = (e) => r(e.code); });
  await sleep(100);
  assert.equal(got[0], "echo:hi");
  assert.deepEqual([...new Uint8Array(got[1])], [1, 2, 3, 1, 2, 3]);
  assert.equal(await closed, 1009);
});

// ---- native.js: upgrade checks and handshake ---------------------------------------------------

function stubController() {
  const c = {
    attached: [], detached: [], messages: [], frames: [],
    attach(link, hello) { c.attached.push({ link, hello }); c.link = link; return { protocol: 1, version: "test", build: null, status: { state: "off" }, settings: {} }; },
    afterWelcome() {},
    detach(link, info) { c.detached.push({ link, info }); },
    onMessage(link, msg) { c.messages.push(msg); },
    onMicFrame(link, f) { c.frames.push(f); },
  };
  return c;
}

async function endpointServer(t, opts = {}) {
  const log = createMemoryLogger();
  const ctl = stubController();
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const ep = createNativeEndpoint({ port, pageToken: "tok123", controller: ctl, log, clock: realClock, ...opts });
  server.on("upgrade", (req, socket, head) => { if (!ep.handleUpgrade(req, socket, head)) socket.destroy(); });
  t.after(() => { ep.close(); server.close(); server.closeAllConnections?.(); });
  return { port, ep, ctl, log };
}

/** Raw upgrade request; resolves {status, headers, socket}. */
function rawUpgrade(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: NATIVE_PATH, headers: {
      Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      "Sec-WebSocket-Protocol": SUBPROTOCOL, ...headers,
    } });
    req.on("upgrade", (res, socket) => { resolve({ status: 101, headers: res.headers, socket }); });
    req.on("response", (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
    req.on("error", reject);
    req.end();
  });
}

test("upgrade auth matrix: Host 421, any Origin 403, missing/wrong token 403, right token 101 + subprotocol", async (t) => {
  const { port } = await endpointServer(t);
  const host = `127.0.0.1:${port}`;
  assert.equal((await rawUpgrade(port, { Host: "evil.com", "X-Sotto-Page": "tok123" })).status, 421);
  assert.equal((await rawUpgrade(port, { Host: `evil.com:${port}`, "X-Sotto-Page": "tok123" })).status, 421);
  const o = await rawUpgrade(port, { Host: host, Origin: `http://127.0.0.1:${port}`, "X-Sotto-Page": "tok123" });
  assert.equal(o.status, 403);
  assert.match(o.body, /bad_origin/);
  assert.equal((await rawUpgrade(port, { Host: host, Origin: "null", "X-Sotto-Page": "tok123" })).status, 403);
  assert.equal((await rawUpgrade(port, { Host: host })).status, 403);
  const w = await rawUpgrade(port, { Host: host, "X-Sotto-Page": "tok124" });
  assert.equal(w.status, 403);
  assert.match(w.body, /bad_token/);
  const ok = await rawUpgrade(port, { Host: `localhost:${port}`, "X-Sotto-Page": "tok123" });
  assert.equal(ok.status, 101);
  assert.equal(ok.headers["sec-websocket-protocol"], SUBPROTOCOL);
  ok.socket.destroy();
});

test("handshake: hello timeout 4003, protocol mismatch 4001, bad JSON 4004, replace 4002", async (t) => {
  const { port, ctl, log } = await endpointServer(t, { helloTimeoutMs: 150 });
  // No hello.
  const silent = new FakeNativeApp({ port, pageToken: "tok123" });
  const ws = new WebSocket(`ws://127.0.0.1:${port}${NATIVE_PATH}`, { protocols: [SUBPROTOCOL], headers: { "X-Sotto-Page": "tok123" } });
  const code = await new Promise((r) => { ws.onclose = (e) => r(e.code); });
  assert.equal(code, CLOSE.HELLO_TIMEOUT);
  // Protocol 2.
  const p2 = new FakeNativeApp({ port, pageToken: "tok123", protocol: 2 });
  await assert.rejects(p2.connect(), (e) => e.code === CLOSE.PROTOCOL_MISMATCH);
  assert.equal(ctl.attached.length, 0, "no welcome, no attach");
  // Bad JSON after hello.
  const a = new FakeNativeApp({ port, pageToken: "tok123" });
  await a.connect();
  a.ws.send("{nope");
  assert.equal((await a.waitClosed()).code, CLOSE.BAD_MESSAGE);
  // Replace: a second client takes over; the first gets 4002.
  const b = new FakeNativeApp({ port, pageToken: "tok123" });
  const c = new FakeNativeApp({ port, pageToken: "tok123" });
  await b.connect();
  await c.connect();
  assert.equal((await b.waitClosed()).code, CLOSE.REPLACED);
  assert.equal(log.find("native.replaced").length, 1);
  assert.equal(ctl.detached.at(-1).info.code, CLOSE.REPLACED);
  c.close();
  void silent;
});

test("frames: a wrong mic frame size closes 4004; unknown JSON types are ignored; cmd args never logged", async (t) => {
  const { port, ctl, log } = await endpointServer(t);
  const a = new FakeNativeApp({ port, pageToken: "tok123" });
  await a.connect();
  a.sendJson({ type: "bogus", x: 1 });
  a.sendJson({ type: "cmd", id: "k1", name: "key_save", args: { key: "sk-proj-SECRETSECRET" } });
  await sleep(50);
  assert.deepEqual(ctl.messages.map((m) => m.type), ["cmd"], "bogus ignored");
  const text = JSON.stringify(log.entries);
  assert.ok(!text.includes("SECRETSECRET"));
  a.ws.send(encodeFrame({ kind: KIND.MIC, seq: 0, pcm: Buffer.alloc(100) }));
  assert.equal((await a.waitClosed()).code, CLOSE.BAD_MESSAGE);
  const b = new FakeNativeApp({ port, pageToken: "tok123" });
  await b.connect();
  b.ws.send(encodeFrame({ kind: KIND.SPEAKER, seq: 0, pcm: Buffer.alloc(FRAME_BYTES) }));
  assert.equal((await b.waitClosed()).code, CLOSE.BAD_MESSAGE, "the app never sends speaker frames");
});

test("round trip: hello/welcome, 50 mic frames and 50 speaker frames in seq order; ping/pong; 4005 on close", async (t) => {
  const { port, ep, ctl } = await endpointServer(t, { pingMs: 50 });
  const a = new FakeNativeApp({ port, pageToken: "tok123" });
  const w = await a.connect();
  assert.equal(w.type, "welcome");
  assert.equal(a.messages[0].type, "welcome");
  assert.equal(ep.connected, true);
  for (let i = 0; i < 50; i++) { const f = Buffer.alloc(FRAME_BYTES); f.writeInt16LE(i, 0); a.sendMicFrame(f); }
  await a.waitFor(() => ctl.frames.length === 50, 2000, "mic frames");
  assert.deepEqual(ctl.frames.map((f) => f.seq), [...Array(50).keys()]);
  assert.deepEqual(ctl.frames.map((f) => f.pcm.readInt16LE(0)), [...Array(50).keys()]);
  assert.ok(ctl.frames.every((f) => f.flags & FLAG.FAKE));
  for (let i = 0; i < 50; i++) { const f = Buffer.alloc(FRAME_BYTES); f.writeInt16LE(i, 0); ctl.link.sendAudio(f); }
  await a.waitFor(() => a.speaker.length === 50, 2000, "speaker frames");
  assert.deepEqual(a.speakerMeta.map((m) => m.seq), [...Array(50).keys()]);
  assert.deepEqual(a.speaker.map((b) => b.readInt16LE(0)), [...Array(50).keys()]);
  await a.waitType("ping", 1000);
  await a.waitFor(() => ctl.messages.some((m) => m.type === "pong"), 1000, "pong");
  ep.close();
  assert.equal((await a.waitClosed()).code, CLOSE.DAEMON_EXIT);
});

test("keepalive: no pong within the timeout closes 1001 and detaches", async (t) => {
  const { port, ctl } = await endpointServer(t, { pingMs: 30, pongTimeoutMs: 120 });
  const a = new FakeNativeApp({ port, pageToken: "tok123" });
  a.autoPong = false;
  await a.connect();
  assert.equal((await a.waitClosed(2000)).code, CLOSE.GOING_AWAY);
  assert.equal(ctl.detached.length, 1);
});

// ---- the daemon over real sockets ---------------------------------------------------------------

test("daemon: /api/native on the daemon port; the page SSE paths are unchanged; non-native upgrades get 404", async (t) => {
  const h = await makeHarness({ realClock: true });
  await h.d.listen();
  t.after(() => h.cleanup());
  const boot = await bootstrap({ port: h.port, secret: h.d.pageSecret });
  assert.equal(boot.page_token, h.d.pageToken);
  const a = new FakeNativeApp({ port: h.port, pageToken: boot.page_token });
  const w = await a.connect();
  assert.equal(w.status.state, "off");
  assert.equal(w.status.audio_client, "app");
  assert.ok(w.settings.data_dir);
  const other = await new Promise((resolve) => {
    const s = net.connect(h.port, "127.0.0.1", () => s.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`));
    let b = ""; s.on("data", (c) => (b += c)); s.on("close", () => resolve(b)); s.on("error", () => resolve(b));
  });
  assert.match(other, /^HTTP\/1.1 404/);
  a.close();
});

test("daemon + fake Live server: app mic -> primary session -> delegation to the inbox; model audio -> speaker frames; voice switch; off", async (t) => {
  // 1 s of a loud tone as the model's greeting.
  const greet = Buffer.alloc(24000 * 2);
  for (let i = 0; i < 24000; i++) greet.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 220 * i) / 24000)), i * 2);
  const live = await startFakeLiveServer({ key: "sk-test-key", outputPcm: greet });
  t.after(() => live.close());
  const h = await makeHarness({ realClock: true, env: { OPENAI_API_KEY: "sk-test-key", SOTTO_OPENAI_BASE: live.base, SOTTO_VOCAB: "0" }, WebSocketImpl: globalThis.WebSocket });
  await h.d.listen();
  t.after(() => h.cleanup());
  h.on(SESSION(), { open_browser: false });
  assert.equal(h.voice.state, "waiting_page");
  const boot = await bootstrap({ port: h.port, secret: h.d.pageSecret });
  const app = new FakeNativeApp({ port: h.port, pageToken: boot.page_token });
  t.after(() => app.close());
  await app.connect();
  // Speech: 1.2 s of tone after 0.6 s, then silence.
  const speech = Buffer.alloc(Math.round(1.2 * 24000) * 2);
  for (let i = 0; i < speech.length / 2; i++) speech.writeInt16LE(Math.round(7000 * Math.sin((2 * Math.PI * 180 * i) / 24000)), i * 2);
  app.startMic({ pcm: speech, leadMs: 600 });
  await app.waitFor(() => app.ofType("live").some((m) => m.event.type === "session.started"), 5000, "session.started");
  assert.equal(h.voice.state, "live");
  const s1 = live.last();
  assert.equal(s1.start.audio.format.rate, 24000);
  assert.equal(s1.start.client, undefined);
  await app.waitFor(() => h.inboxSends.length >= 1, 8000, "delegation reaches the inbox");
  assert.match(h.inboxSends[0].content, /List the files in the daemon folder/);
  await app.waitFor(() => pcmPeak(app.speakerPcm()) > 1200, 5000, "speaker frames hold the greeting");
  assert.ok(app.speaker.every((b) => b.length === FRAME_BYTES));
  assert.ok(s1.inputFrames >= 50, `continuous input: ${s1.inputFrames}`);
  assert.ok(app.ofType("caption").some((c) => c.role === "user"));
  // Voice switch over the command channel.
  const r = await app.cmd("set_voice", { voice: "cedar" });
  assert.equal(r.ok, true);
  await app.waitFor(() => live.sessions.length === 2 && live.last().started, 5000, "second session");
  assert.equal(live.last().start.audio.output.voice, "cedar");
  assert.equal(s1.events.at(-1).type, "session.close");
  assert.ok(app.ofType("audio_flush").some((m) => m.reason === "voice_change"));
  await app.waitFor(() => h.voice.state === "live", 5000, "live again");
  // Mute round trip.
  const m = await app.cmd("mute", { on: true });
  assert.deepEqual(m.data, { muted: true });
  await app.waitFor(() => app.ofType("live").some((x) => x.event.type === "session.input_audio.muted"), 3000, "muted event");
  // Off: flush, close_window, the link stays open.
  const off = await app.cmd("end", {});
  assert.equal(off.ok, true);
  await app.waitFor(() => app.ofType("command").some((c) => c.command === "close_window"), 5000, "close_window");
  assert.equal(live.last().events.at(-1).type, "session.close");
  assert.equal(app.closeInfo, null, "link stays up");
  app.stopMic();
});
