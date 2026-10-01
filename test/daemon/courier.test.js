// The courier (SPEC §6.9.2): a real courier process speaking MCP on stdio,
// delivering for the daemon to a fake inbox; the daemon's courier-first send
// with its direct fallback; and the /talk on hold warning.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { courierPaths, courierAlive, viaCourier, readInboundSetting, inboundRisk } from "../../daemon/inbox.js";
import { startFakeInbox } from "../helpers/fake-inbox.js";
import { makeHarness, SESSION } from "../helpers/daemon-harness.js";
import { INBOUND_WARNING } from "../../daemon/voice.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rand = () => Math.random().toString(36).slice(2, 8);
const KEY = "daemon-key-" + rand();

/** Start a courier like Claude Code does (stdio pipes, plugin env); resolves once it listens. */
async function startCourier({ inbox, dataDir, token = "tok-courier" }) {
  const child = spawn(process.execPath, [path.join(ROOT, "daemon/courier.js")], {
    env: { PATH: process.env.PATH, HOME: os.homedir(), CLAUDE_CODE_MESSAGING_SOCKET: inbox, CLAUDE_CODE_MESSAGING_TOKEN: token, CLAUDE_PLUGIN_DATA: dataDir },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = [];
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  const rpc = async (msg, wantId = msg.id) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    if (wantId === undefined) return null;
    for (let t = 0; t < 200; t++) {
      const m = lines.find((l) => l.id === wantId);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("no MCP reply for " + msg.method);
  };
  const exited = new Promise((r) => child.once("exit", r));
  for (let t = 0; t < 300 && !courierAlive(dataDir, inbox); t++) await new Promise((r) => setTimeout(r, 10));
  return { child, rpc, exited, lines };
}

function tmpData() {
  const d = fs.mkdtempSync("/tmp/clv-cd-");
  fs.writeFileSync(path.join(d, "daemon.key"), KEY + "\n", { mode: 0o600 });
  return d;
}

test("courier: MCP handshake with no tools, delivers for the daemon with its own token, cleans up on stdin close", async () => {
  const dataDir = tmpData();
  const inbox = await startFakeInbox(`/tmp/clv-ci-${rand()}.sock`);
  const c = await startCourier({ inbox: inbox.path, dataDir });
  try {
    const init = await c.rpc({ id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.deepEqual(init.result.capabilities, {}); // no tools, prompts or resources
    assert.equal(init.result.instructions, undefined); // nothing enters the model's context
    await c.rpc({ method: "notifications/initialized" }, undefined);
    assert.deepEqual((await c.rpc({ id: 1, method: "tools/list" })).result, { tools: [] });
    assert.equal((await c.rpc({ id: 2, method: "resources/list" })).error.code, -32601);
    assert.deepEqual((await c.rpc({ id: 3, method: "ping" })).result, {});

    assert.ok(courierAlive(dataDir, inbox.path));
    const p = courierPaths(dataDir, inbox.path);
    assert.equal(fs.statSync(p.dir).mode & 0o777, 0o700);
    assert.equal((await viaCourier({ dataDir, inboxSocket: inbox.path, key: KEY, op: "ping" })).ok, true);

    const r = await viaCourier({ dataDir, inboxSocket: inbox.path, key: KEY, content: "[sotto voice] hi", msgId: "clv-x-1", priority: "later" });
    assert.deepEqual(r, { ok: true, via: "courier" });
    await inbox.waitFor(2);
    assert.deepEqual(inbox.frames[0], { type: "auth", token: "tok-courier" });
    assert.deepEqual(inbox.frames[1], { type: "user", message: { role: "user", content: "[sotto voice] hi" }, from_plugin: "sotto", msg_id: "clv-x-1", priority: "later" });

    // A wrong key never reaches the inbox, and the daemon may post directly.
    const bad = await viaCourier({ dataDir, inboxSocket: inbox.path, key: "nope", content: "x", msgId: "m" });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "bad_key");
    assert.equal(bad.fallback, true);
    assert.equal(inbox.frames.length, 2);

    c.child.stdin.end(); // Claude Code closing the session
    await c.exited;
    assert.equal(fs.existsSync(p.socket), false);
    assert.equal(fs.existsSync(p.pid), false);
    assert.equal(courierAlive(dataDir, inbox.path), false);
    const gone = await viaCourier({ dataDir, inboxSocket: inbox.path, key: KEY, content: "x", msgId: "m" });
    assert.equal(gone.code, "no_courier");
    assert.equal(gone.fallback, true);
  } finally {
    c.child.kill();
    await inbox.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("courier: an inbox error is final (no fallback, so no double send)", async () => {
  const dataDir = tmpData();
  const missing = `/tmp/clv-gone-${rand()}.sock`;
  const c = await startCourier({ inbox: missing, dataDir });
  try {
    const r = await viaCourier({ dataDir, inboxSocket: missing, key: KEY, content: "x", msgId: "m" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "no_socket");
    assert.equal(r.fallback, false);
  } finally {
    c.child.kill();
    await c.exited;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("courier: without an inbox socket it still answers MCP and listens nowhere", async () => {
  const child = spawn(process.execPath, [path.join(ROOT, "daemon/courier.js")], { env: { PATH: process.env.PATH, HOME: "/nonexistent" }, stdio: ["pipe", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} }) + "\n");
  for (let t = 0; t < 200 && !out.includes("\n"); t++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(JSON.parse(out.split("\n")[0]).result.serverInfo.name, "sotto-courier");
  child.stdin.end();
  assert.equal(await new Promise((r) => child.once("exit", r)), 0);
});

test("courierPaths: per inbox socket, and under /tmp when the data dir path is too long for a unix socket", () => {
  const a = courierPaths("/Users/u/.claude/plugins/data/sotto-skills-dir", "/tmp/cc-socks/1.sock", { uid: 501 });
  const b = courierPaths("/Users/u/.claude/plugins/data/sotto-skills-dir", "/tmp/cc-socks/2.sock", { uid: 501 });
  assert.equal(a.dir, "/Users/u/.claude/plugins/data/sotto-skills-dir/courier");
  assert.match(a.socket, /\/courier\/[0-9a-f]{16}\.sock$/);
  assert.notEqual(a.socket, b.socket);
  const long = courierPaths("/Users/" + "x".repeat(80) + "/.claude/plugins/data/sotto", "/tmp/cc-socks/1.sock", { uid: 501 });
  assert.equal(long.dir, "/tmp/sotto-courier-501");
  assert.ok(Buffer.byteLength(long.socket) <= 103);
});

test("inboundRisk and readInboundSetting", () => {
  assert.equal(inboundRisk({ permissionMode: "bypassPermissions", courier: false, inbound: null }), "bypass");
  assert.equal(inboundRisk({ permissionMode: "bypassPermissions", courier: true, inbound: null }), null);
  assert.equal(inboundRisk({ permissionMode: "bypassPermissions", courier: false, inbound: "accept" }), null);
  assert.equal(inboundRisk({ permissionMode: "default", courier: false, inbound: null }), null);
  assert.equal(inboundRisk({ permissionMode: "default", courier: true, inbound: "hold" }), "hold");
  assert.equal(inboundRisk({ permissionMode: "default", courier: true, inbound: "refuse" }), "refuse");
  const files = {
    "/Library/Application Support/ClaudeCode/managed-settings.json": null,
    "/h/.claude/settings.json": JSON.stringify({ crossSessionInbound: "accept" }),
    "/c/settings.json": JSON.stringify({ crossSessionInbound: "bogus" }),
  };
  const readFile = (f) => { if (files[f] == null) throw new Error("ENOENT"); return files[f]; };
  assert.equal(readInboundSetting({ env: {}, home: "/h", readFile, platform: "darwin" }), "accept");
  assert.equal(readInboundSetting({ env: { CLAUDE_CONFIG_DIR: "/c" }, home: "/h", readFile, platform: "darwin" }), null);
  files["/Library/Application Support/ClaudeCode/managed-settings.json"] = JSON.stringify({ crossSessionInbound: "hold" });
  assert.equal(readInboundSetting({ env: {}, home: "/h", readFile, platform: "darwin" }), "hold");
});

test("daemon: sends through the courier, falls back to direct only when the courier never took it", async () => {
  const h = await makeHarness();
  try {
    h.on();
    const calls = [];
    let reply = { ok: true, via: "courier" };
    h.voice.inbox.viaCourier = async (m) => { calls.push(m); return reply; };
    let r = await h.voice.inboxSend("[sotto voice] one", "clv-1-1");
    assert.equal(r.ok, true);
    assert.equal(h.inboxSends.length, 0);
    assert.equal(calls[0].inboxSocket, SESSION().socket);
    assert.equal(calls[0].dataDir, h.dataDir);
    assert.equal(typeof calls[0].key, "string");

    reply = { ok: false, code: "no_courier", fallback: true };
    r = await h.voice.inboxSend("[sotto voice] two", "clv-2-1");
    assert.equal(r.ok, true);
    assert.equal(h.inboxSends.length, 1);
    assert.equal(h.inboxSends[0].token, "inbox-token-a");

    reply = { ok: false, code: "timeout", fallback: false };
    r = await h.voice.inboxSend("[sotto voice] three", "clv-3-1");
    assert.equal(r.code, "timeout");
    assert.equal(h.inboxSends.length, 1); // never posted twice
    const logged = h.log.entries.filter((e) => e.ev === "inbox.send").map((e) => e.via);
    assert.deepEqual(logged, ["courier", "direct", "courier"]);
  } finally {
    await h.cleanup();
  }
});

test("/talk on warns up front when the session bypasses prompts and has no courier", async () => {
  const h = await makeHarness();
  try {
    let courier = false, inbound = null;
    Object.assign(h.voice.inbox, {
      courierAlive: () => courier,
      readInboundSetting: () => inbound,
      inboundRisk,
    });
    const bypass = SESSION(undefined, { permission_mode: "bypassPermissions" });
    let r = h.voice.control({ action: "on", session: bypass, config: {} });
    assert.ok(r.message.startsWith("sotto: voice ON (proj-a)"));
    assert.ok(r.message.endsWith(INBOUND_WARNING.bypass));
    assert.doesNotMatch(r.message, /["\\\n]/); // toggle.sh embeds it as is

    courier = true;
    r = h.voice.control({ action: "on", session: bypass, config: {} });
    assert.doesNotMatch(r.message, /Heads-up|Warning/);

    courier = false; inbound = "accept";
    assert.doesNotMatch(h.voice.control({ action: "on", session: bypass, config: {} }).message, /Heads-up/);
    inbound = "hold";
    assert.ok(h.voice.control({ action: "on", session: SESSION(), config: {} }).message.endsWith(INBOUND_WARNING.hold));
    inbound = null;
    assert.doesNotMatch(h.voice.control({ action: "on", session: SESSION(undefined, { permission_mode: "default" }), config: {} }).message, /Heads-up/);
    // Turning voice off says nothing about it.
    inbound = "refuse";
    assert.doesNotMatch(h.voice.control({ action: "toggle", session: SESSION(), config: {} }).message, /Warning/);
    const ev = h.log.entries.filter((e) => e.ev === "owner.inbound");
    assert.equal(ev[0].risk, "bypass");
    assert.equal(JSON.stringify(ev).includes("inbox-token-a"), false);
  } finally {
    await h.cleanup();
  }
});
