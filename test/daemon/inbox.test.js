import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { send } from "../../daemon/inbox.js";
import { startFakeInbox } from "../helpers/fake-inbox.js";

const sockPath = () => `/tmp/clv-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`;

test("writes exactly two NDJSON lines: auth, then user", async () => {
  const inbox = await startFakeInbox(sockPath());
  try {
    const r = await send({ socket: inbox.path, token: "tok-123", content: '[sotto voice] what "branch"\nnext', msgId: "clv-item_1-1" });
    assert.deepEqual(r, { ok: true });
    await inbox.waitFor(2);
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(inbox.connections.length, 1);
    const c = inbox.connections[0];
    assert.equal(c.lines.length, 2);
    assert.ok(c.raw.endsWith("\n"));
    assert.deepEqual(JSON.parse(c.lines[0]), { type: "auth", token: "tok-123" });
    assert.deepEqual(JSON.parse(c.lines[1]), {
      type: "user", message: { role: "user", content: '[sotto voice] what "branch"\nnext' },
      from_plugin: "sotto", msg_id: "clv-item_1-1", priority: "next",
    });
  } finally {
    await inbox.close();
  }
});

test("no_socket for a missing path or a non-socket file", async () => {
  assert.equal((await send({ socket: "/tmp/clv-definitely-missing.sock", token: "t", content: "x", msgId: "m" })).code, "no_socket");
  const f = `/tmp/clv-file-${process.pid}.txt`;
  fs.writeFileSync(f, "x");
  try {
    assert.equal((await send({ socket: f, token: "t", content: "x", msgId: "m" })).code, "no_socket");
  } finally {
    fs.unlinkSync(f);
  }
});

test("refused when the socket file exists but nobody listens", async () => {
  const p = sockPath();
  // A child listens, then is SIGKILLed so the socket file is left behind.
  const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(p)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((res) => child.stdout.once("data", res));
  child.kill("SIGKILL");
  await new Promise((res) => child.once("exit", res));
  try {
    assert.ok(fs.existsSync(p));
    const r = await send({ socket: p, token: "t", content: "x", msgId: "m" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "refused");
  } finally {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
});

test("timeout when the peer never reads a large write", async () => {
  const inbox = await startFakeInbox(sockPath(), { paused: true });
  try {
    const r = await send({ socket: inbox.path, token: "t", content: "x".repeat(8 * 1024 * 1024), msgId: "m", timeoutMs: 300 });
    assert.equal(r.ok, false);
    assert.equal(r.code, "timeout");
  } finally {
    await inbox.close();
  }
});
