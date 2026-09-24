import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { makeHarness, SESSION } from "../helpers/daemon-harness.js";

/** Raw HTTP request with full header control (fetch would set Host/Origin itself). */
function request(port, { method = "GET", path: p = "/", headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port, method, path: p,
      headers: { Host: host ?? `127.0.0.1:${port}`, ...(data !== undefined ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

async function server(t, opts = {}) {
  const h = await makeHarness({ realClock: true, ...opts });
  await h.d.listen();
  t.after(() => h.cleanup());
  h.key = { "X-Sotto-Key": h.d.daemonKey };
  h.page = { "X-Sotto-Page": h.d.pageToken };
  h.req = (o) => request(h.port, o);
  return h;
}

test("healthz shape and no-store", async (t) => {
  const h = await server(t);
  const r = await h.req({ path: "/healthz" });
  assert.equal(r.status, 200);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.headers["access-control-allow-origin"], undefined);
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.deepEqual(r.json, { ok: true, name: "sotto", version: "0.3.0", pid: process.pid, port: h.port, data_dir: h.dataDir, plugin_root: h.pluginRoot, state: "off", api_key: true });
});

test("421 on a bad Host header", async (t) => {
  const h = await server(t);
  for (const host of ["evil.com", `evil.com:${h.port}`, "127.0.0.1:1", `localhost:${h.port}x`]) {
    const r = await h.req({ path: "/healthz", host });
    assert.equal(r.status, 421, host);
    assert.deepEqual(r.json, { error: { code: "bad_host" } });
  }
  assert.equal((await h.req({ path: "/healthz", host: `localhost:${h.port}` })).status, 200);
});

test("403 on missing or wrong key, and on a foreign Origin", async (t) => {
  const h = await server(t);
  assert.deepEqual((await h.req({ method: "POST", path: "/control", body: { action: "status" } })).json, { error: { code: "bad_key" } });
  assert.equal((await h.req({ method: "POST", path: "/control", body: { action: "status" }, headers: { "X-Sotto-Key": "0".repeat(64) } })).status, 403);
  assert.equal((await h.req({ path: "/status" })).status, 403);
  assert.equal((await h.req({ method: "POST", path: "/hook/Stop", body: {} })).status, 403);
  const o = await h.req({ method: "POST", path: "/control", body: { action: "status" }, headers: { ...h.key, Origin: "https://evil.com" } });
  assert.equal(o.status, 403);
  const same = await h.req({ method: "POST", path: "/control", body: { action: "status" }, headers: { ...h.key, Origin: `http://127.0.0.1:${h.port}` } });
  assert.equal(same.status, 200);
});

test("400 on malformed JSON, 413 on huge bodies", async (t) => {
  const h = await server(t);
  assert.deepEqual((await h.req({ method: "POST", path: "/control", body: "{nope", headers: h.key })).json, { error: { code: "bad_json" } });
  const big = JSON.stringify({ x: "y".repeat(16 * 1024 * 1024 + 10) });
  const r = await h.req({ method: "POST", path: "/control", body: big, headers: h.key });
  assert.equal(r.status, 413);
});

test("/control: every action, both response formats, §9.2 messages", async (t) => {
  const h = await server(t);
  const ctl = (body, fmt = "") => h.req({ method: "POST", path: "/control" + fmt, body, headers: h.key });
  assert.deepEqual((await ctl({ action: "status" }, "?format=hook")).json, { continue: false, stopReason: "sotto: voice is off. 0 min today ($0.00)." });
  assert.deepEqual((await ctl({ action: "off" })).json, { ok: true, state: "off", message: "sotto: voice is already off." });
  const on = await ctl({ action: "toggle", session: SESSION(), config: { open_browser: true } }, "?format=hook");
  assert.deepEqual(on.json, { continue: false, stopReason: "sotto: voice ON (proj-a). Opening the voice window." });
  assert.equal(Object.keys(on.json).length, 2);
  const active = path.join(h.dataDir, "active");
  assert.equal(fs.statSync(active).mode & 0o777, 0o600);
  const st = await ctl({ action: "status" });
  assert.equal(st.json.message, "sotto: voice waiting_page (proj-a) | 0 min today ($0.00) | voice marin | persona sotto | milestones");
  assert.equal((await ctl({ action: "policy", policy: "quiet" })).json.message, "sotto: speaking policy is now quiet.");
  const t0 = Date.now();
  const off = await ctl({ action: "off" }, "?format=hook");
  // Proves off does not wait for the (up to 15 s) session close; 2 s leaves room for load.
  assert.ok(Date.now() - t0 < 2000, "/control answers fast");
  assert.deepEqual(off.json, { continue: false, stopReason: "sotto: voice OFF. 0 min today ($0.00)." });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!fs.existsSync(active), "active removed on off");
  assert.equal((await ctl({ action: "bogus" })).json.ok, false);
  const sd = await ctl({ action: "shutdown" }, "?format=hook");
  assert.deepEqual(sd.json, { continue: false, stopReason: "sotto: daemon stopped." });
});

test("/status is the full Status object", async (t) => {
  const h = await server(t);
  await h.req({ method: "POST", path: "/control", body: { action: "on", session: SESSION(), config: {} }, headers: h.key });
  const s = (await h.req({ path: "/status", headers: h.key })).json;
  assert.deepEqual(Object.keys(s), ["state", "owner", "live", "today", "config", "claude", "page", "delegations", "counters", "last_error", "wake", "api_key", "echo", "audio_client", "native"]);
  assert.equal(s.audio_client, null);
  assert.equal(s.native.connected, false, "the native app link (docs/NATIVE.md)");
  assert.deepEqual(Object.keys(s.counters), ["delegations", "inbox_sent", "inbox_failed", "thinking_sent", "commentary_sent", "instructions_sent", "appends_acked", "appends_failed", "hooks", "sessions_created", "mirror_sent", "mirror_failed", "echo_guard_on", "echo_heard"]);
  assert.equal(s.live, null);
  assert.equal(s.owner.project, "proj-a");
  assert.ok(!JSON.stringify(s).includes("inbox-token-a"));
});

test("/hook/*: 204 immediately; non-owners are counted and ignored", async (t) => {
  const h = await server(t);
  await h.req({ method: "POST", path: "/control", body: { action: "on", session: SESSION(), config: {} }, headers: h.key });
  let called = 0;
  const orig = h.voice.handleHook.bind(h.voice);
  h.voice.handleHook = (...a) => { called++; return orig(...a); };
  const r = await h.req({ method: "POST", path: "/hook/UserPromptSubmit", body: { prompt: "typed thing" }, headers: { ...h.key, "X-Sotto-Socket": "/tmp/someone-else.sock" } });
  assert.equal(r.status, 204);
  assert.equal(r.text, "");
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(called, 1);
  assert.equal(h.voice.counters.hooks, 1);
  assert.equal(h.voice.delegation.claudeBusy, false, "non-owner hook ignored");
  await h.req({ method: "POST", path: "/hook/UserPromptSubmit", body: { prompt: "typed thing" }, headers: { ...h.key, "X-Sotto-Socket": "/tmp/clv-owner-a.sock" } });
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(h.voice.delegation.claudeBusy, true);
  const unk = await h.req({ method: "POST", path: "/hook/SomethingNew", body: {}, headers: { ...h.key, "X-Sotto-Socket": "/tmp/clv-owner-a.sock" } });
  assert.equal(unk.status, 204);
});

test("static files: whitelist and traversal rejection", async (t) => {
  const h = await server(t);
  const root = await h.req({ path: "/" });
  assert.equal(root.status, 200);
  assert.match(root.headers["content-type"], /^text\/html/);
  assert.equal((await h.req({ path: "/app.js" })).headers["content-type"], "text/javascript; charset=utf-8");
  for (const p of ["/package.json", "/../package.json", "/%2e%2e/package.json", "/..%2fpackage.json", "/web/app.js", "/x.txt", "/.env", "/missing.js"]) {
    assert.equal((await h.req({ path: p })).status, 404, p);
  }
});

test("bootstrap needs the page secret or a one-time launch code", async (t) => {
  const h = await server(t);
  const denied = await h.req({ path: "/api/bootstrap" });
  assert.equal(denied.status, 403, "Host alone is not enough: any local process can forge it");
  assert.ok(!denied.text.includes(h.d.pageToken));
  assert.equal((await h.req({ path: "/api/bootstrap", headers: { "X-Sotto-Boot": "wrong" } })).status, 403);
  // A launch code (window URL fragment) works once and yields the persistent secret.
  const code = h.d.issueLaunchCode();
  const ok = await h.req({ path: "/api/bootstrap", headers: { "X-Sotto-Launch": code } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.page_token, h.d.pageToken);
  assert.equal(ok.json.page_secret, h.d.pageSecret);
  assert.equal((await h.req({ path: "/api/bootstrap", headers: { "X-Sotto-Launch": code } })).status, 403, "single use");
  // The persistent secret keeps working (re-bootstrap after a daemon restart).
  assert.equal((await h.req({ path: "/api/bootstrap", headers: { "X-Sotto-Boot": ok.json.page_secret } })).status, 200);
  assert.match(fs.readFileSync(path.join(h.dataDir, "page.secret"), "utf8"), /^[0-9a-f]{48}\n$/);
  assert.equal(fs.statSync(path.join(h.dataDir, "page.secret")).mode & 0o777, 0o600);
});

test("bootstrap returns the page token; SSE requires it and sends status first", async (t) => {
  const h = await server(t);
  const b = (await h.req({ path: "/api/bootstrap", headers: { "X-Sotto-Boot": h.d.pageSecret } })).json;
  assert.equal(b.page_token, h.d.pageToken);
  assert.equal(b.version, "0.3.0");
  assert.match(b.build, /^[0-9a-f]{16}$/, "web/ build hash (the page reloads when it changes, §6.17)");
  assert.equal(b.port, h.port);
  assert.equal(b.status.state, "off");
  assert.ok(!("socket" in (b.status.owner || {})));
  assert.equal((await h.req({ path: "/api/events" })).status, 403);
  assert.equal((await h.req({ path: "/api/events?token=wrong" })).status, 403);
  const first = await new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: h.port, path: `/api/events?token=${b.page_token}`, headers: { Host: `127.0.0.1:${h.port}` } }, (res) => {
      assert.equal(res.headers["content-type"], "text/event-stream");
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", (d) => {
        buf += d;
        const i = buf.indexOf("\n\n");
        if (i >= 0) { req.destroy(); resolve(buf.slice(0, i)); }
      });
    });
    req.on("error", (e) => { if (e.code !== "ECONNRESET") reject(e); });
  });
  assert.ok(first.startsWith("data: "));
  const msg = JSON.parse(first.slice(6));
  assert.equal(msg.type, "status");
  assert.equal(msg.status.state, "off");
});

test("/api/session: success and error codes", async (t) => {
  const h = await server(t);
  const sess = (body, headers = h.page) => h.req({ method: "POST", path: "/api/session", body, headers });
  assert.equal((await sess({ sdp: "v=0" }, {})).status, 403);
  assert.deepEqual((await sess({ sdp: "" })).json.error.code, "bad_sdp");
  assert.deepEqual([(await sess({ sdp: "v=0" })).status], [409]);
  await h.req({ method: "POST", path: "/control", body: { action: "on", session: SESSION(), config: { daily_cap_minutes: 10 } }, headers: h.key });
  const ok = await h.req({ method: "POST", path: `/api/session?token=${h.d.pageToken}`, body: { sdp: "v=0 offer", reason: "start" } });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.json, { session_id: "live_test_1", sdp: "v=0 answer" });
  assert.equal(h.fetchCalls[0].init.headers.Authorization, "Bearer sk-test-key");

  for (const [status, code] of [[401, "openai_auth"], [429, "openai_rate_limit"], [500, "openai_error"]]) {
    h.setFetch(async () => ({ status, text: async () => "{}" }));
    const r = await sess({ sdp: "v=0" });
    assert.deepEqual([r.status, r.json.error.code], [502, code]);
    assert.ok(!r.text.includes("sk-test-key"));
  }
  h.voice.usage.days[h.voice.status().today.date] = 600;
  const cap = await sess({ sdp: "v=0" });
  assert.deepEqual([cap.status, cap.json.error.code], [429, "daily_cap"]);
});

test("/api/session: 503 without an API key", async (t) => {
  const h = await server(t, { env: {} });
  await h.req({ method: "POST", path: "/control", body: { action: "on", session: SESSION(), config: {} }, headers: h.key });
  const r = await h.req({ method: "POST", path: "/api/session", body: { sdp: "v=0" }, headers: h.page });
  assert.deepEqual([r.status, r.json.error.code], [503, "no_api_key"]);
});

test("/api/page: token via header or query (sendBeacon), 204", async (t) => {
  const h = await server(t);
  const seen = [];
  h.voice.handlePage = (m) => seen.push(m.type);
  assert.equal((await h.req({ method: "POST", path: "/api/page", body: { type: "hello" }, headers: h.page })).status, 204);
  assert.equal((await h.req({ method: "POST", path: `/api/page?token=${h.d.pageToken}`, body: JSON.stringify({ type: "unload" }), headers: { "Content-Type": "text/plain" } })).status, 204);
  assert.equal((await h.req({ method: "POST", path: "/api/page", body: { type: "hello" } })).status, 403);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, ["hello", "unload"]);
});

test("launch codes expire after 2 minutes", async (t) => {
  const h = await server(t, { realClock: false });
  const code = h.d.issueLaunchCode();
  await h.clock.advance(121_000);
  assert.equal((await h.req({ path: "/api/bootstrap", headers: { "X-Sotto-Launch": code } })).status, 403);
});

test("shutdown: the daemon stops listening right after answering", async (t) => {
  const h = await server(t);
  const r = await h.req({ method: "POST", path: "/control", headers: h.key, body: { action: "shutdown" } });
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 50));
  await assert.rejects(h.req({ path: "/healthz" }), /ECONNREFUSED/, "port is free for the next daemon");
});
