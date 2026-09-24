// First-run key setup through the daemon: /talk key, POST /api/key (check with
// OpenAI, save in the Keychain, connect), remove, and where the key must never
// appear (SPEC §4.3).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { makeHarness, SESSION } from "../helpers/daemon-harness.js";
import { createFakeKeychain } from "../helpers/fake-keychain.js";

const KEY = "sk-test-" + "Q1w2E3r4T5y6U7i8O9p0-_lmno";

function request(port, { method = "GET", path: p = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port, method, path: p,
      headers: { Host: `127.0.0.1:${port}`, ...(data !== undefined ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

/** OpenAI fake: GET /models answers `models` (status, ids); session creates succeed. */
function openai(h, { status = 200, ids = ["gpt-4o", "gpt-live-1"] } = {}) {
  h.modelCalls = [];
  h.setFetch(async (url, init) => {
    if (init.method === "GET") {
      h.modelCalls.push({ url, auth: init.headers.Authorization });
      return { status, text: async () => JSON.stringify(status === 200 ? { data: ids.map((id) => ({ id })) } : { error: { message: "Incorrect API key provided: sk-tes***lmno" } }) };
    }
    return { status: 201, text: async () => JSON.stringify({ session: { id: "live_k1" }, transport: { type: "webrtc", sdp: "v=0 answer" } }) };
  });
}

async function server(t, opts = {}) {
  const h = await makeHarness({ realClock: true, env: {}, ...opts });
  await h.d.listen();
  t.after(() => h.cleanup());
  h.key = { "X-Sotto-Key": h.d.daemonKey };
  h.page = { "X-Sotto-Page": h.d.pageToken };
  h.req = (o) => request(h.port, o);
  return h;
}

const noKeyAnywhere = (h, key = KEY) => {
  assert.ok(!JSON.stringify(h.log.entries).includes(key), "never logged");
  assert.ok(!JSON.stringify(h.sse).includes(key), "never sent to the page");
  assert.ok(!JSON.stringify(h.voice.status()).includes(key.slice(-4)), "status.json has the source only");
  for (const f of fs.readdirSync(h.dataDir, { recursive: true })) {
    const p = path.join(h.dataDir, f);
    if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p, "utf8").includes(key), `not in ${f}`);
  }
};

test("first run: /talk on without a key, the page saves one, voice connects", async (t) => {
  const h = await server(t);
  openai(h);
  const on = await h.req({ method: "POST", path: "/control?format=hook", body: { action: "on", session: SESSION(), config: { open_browser: true } }, headers: h.key });
  assert.match(on.json.stopReason, /no OpenAI API key yet\. Opening the voice window/);
  assert.equal(h.chrome.opened, 1);
  assert.equal(h.voice.state, "paused");
  const st = h.voice.pageStatus();
  assert.deepEqual([st.key.present, st.key.setup, st.key.can_change, st.last_error.code], [false, true, true, "no_api_key"]);

  const saved = await h.req({ method: "POST", path: "/api/key", body: { key: `  ${KEY}\n` }, headers: h.page });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual([saved.json.ok, saved.json.connecting, saved.json.message], [true, true, "Key saved. Connecting…"]);
  assert.deepEqual([saved.json.key.source, saved.json.key.hint, saved.json.key.can_remove], ["keychain", "lmno", true]);
  assert.ok(!saved.text.includes(KEY), "the key is never sent back");
  assert.deepEqual(h.modelCalls, [{ url: "https://api.openai.com/v1/models", auth: `Bearer ${KEY}` }]);
  assert.equal(h.keychain.key, KEY);
  assert.equal(h.voice.state, "waiting_page");
  assert.equal(h.voice.keySetup, false);
  assert.equal(h.voice.lastError, null);
  assert.ok(h.commands().includes("connect:key"));

  // The page's connect now works with the Keychain key.
  const sess = await h.req({ method: "POST", path: "/api/session", body: { sdp: "v=0 offer" }, headers: h.page });
  assert.equal(sess.status, 201);
  const health = await h.req({ path: "/healthz" });
  assert.equal(health.json.api_key, true);
  noKeyAnywhere(h);
});

test("POST /api/key: auth, format, OpenAI rejections, Keychain failures", async (t) => {
  const h = await server(t);
  openai(h, { status: 401 });
  assert.equal((await h.req({ method: "POST", path: "/api/key", body: { key: KEY } })).status, 403);
  const bad = await h.req({ method: "POST", path: "/api/key", body: { key: "hello" }, headers: h.page });
  assert.deepEqual([bad.status, bad.json.error.code], [400, "bad_key_format"]);
  assert.equal(h.modelCalls.length, 0, "no OpenAI call for a malformed key");
  const rejected = await h.req({ method: "POST", path: "/api/key", body: { key: KEY }, headers: h.page });
  assert.deepEqual([rejected.status, rejected.json.error.code], [400, "invalid_key"]);
  assert.ok(!rejected.text.includes("lmno"), "OpenAI's message (which echoes the key) is not passed through");
  openai(h, { ids: ["gpt-4o"] });
  const noModel = await h.req({ method: "POST", path: "/api/key", body: { key: KEY }, headers: h.page });
  assert.deepEqual([noModel.status, noModel.json.error.code], [400, "no_model_access"]);
  assert.match(noModel.json.error.message, /gpt-live-1/);
  h.setFetch(async () => { throw new TypeError("fetch failed"); });
  const net = await h.req({ method: "POST", path: "/api/key", body: { key: KEY }, headers: h.page });
  assert.deepEqual([net.status, net.json.error.code], [504, "network"]);
  assert.equal(h.keychain.sets, 0, "nothing stored until the key checks out");
  noKeyAnywhere(h);
});

test("POST /api/key: Keychain refuses or is missing", async (t) => {
  const h = await server(t, { keychain: createFakeKeychain({ failSet: true }) });
  openai(h);
  const r = await h.req({ method: "POST", path: "/api/key", body: { key: KEY }, headers: h.page });
  assert.deepEqual([r.status, r.json.error.code], [500, "keychain_error"]);
  const h2 = await server(t, { keychain: createFakeKeychain({ available: false }) });
  const r2 = await h2.req({ method: "POST", path: "/api/key", body: { key: KEY }, headers: h2.page });
  assert.deepEqual([r2.status, r2.json.error.code], [501, "keychain_unavailable"]);
});

test("GET /api/key and remove: only a Keychain key can be removed", async (t) => {
  const h = await server(t, { keychain: createFakeKeychain({ key: KEY }), userConfigKey: "sk-test-" + "u".repeat(20) + "uc12" });
  const info = await h.req({ path: "/api/key", headers: h.page });
  assert.deepEqual([info.json.source, info.json.hint, info.json.can_remove], ["keychain", "lmno", true]);
  assert.ok(!info.text.includes(KEY));
  assert.equal((await h.req({ path: "/api/key" })).status, 403);
  const rm = await h.req({ method: "POST", path: "/api/key/remove", body: {}, headers: h.page });
  assert.equal(rm.status, 200);
  assert.equal(rm.json.message, "Key removed from the Keychain. Now using the key from the plugin settings.");
  assert.deepEqual([rm.json.key.source, rm.json.key.hint], ["user_config", "uc12"]);
  assert.equal(h.keychain.key, null);
  const again = await h.req({ method: "POST", path: "/api/key/remove", body: {}, headers: h.page });
  assert.deepEqual([again.status, again.json.error.code], [409, "not_removable"]);
});

test("/talk key: where the key comes from; setup never reads the argument", async (t) => {
  const h = await makeHarness({ env: {} });
  t.after(() => h.cleanup());
  // No key: opens the window at the setup card, even with voice off.
  let r = h.voice.control({ action: "key" });
  assert.equal(r.message, "sotto: no OpenAI API key found. Opening the voice window so you can add it; it is saved in your macOS Keychain.");
  assert.equal(h.chrome.opened, 1);
  assert.equal(h.voice.pageStatus().key.setup, true);
  assert.equal(h.voice.state, "off");

  h.keychain.key = KEY;
  h.voice.keySetup = false;
  r = h.voice.control({ action: "key" });
  assert.equal(r.message, "sotto: using the OpenAI API key ending in lmno from the macOS Keychain. Change or remove it in the voice window settings.");
  assert.equal(h.chrome.opened, 1, "no window when a key exists");

  // /talk key <anything>: toggle.sh sends setup:true and never the text.
  r = h.voice.control({ action: "key", setup: true });
  assert.match(r.message, /^sotto: API keys are never read from \/talk arguments/);
  assert.match(r.message, /Opening the voice window/);
  assert.equal(h.chrome.opened, 2);
  assert.equal(h.voice.pageStatus().key.setup, true);
  assert.equal(h.voice.pageStatus().key.present, true, "the setup card offers to replace it");
  noKeyAnywhere(h);
});

test("/talk key with the key in the environment or .env: change it there", async (t) => {
  const h = await makeHarness({ env: { OPENAI_API_KEY: KEY } });
  t.after(() => h.cleanup());
  assert.equal(h.voice.control({ action: "key" }).message, "sotto: using the OpenAI API key ending in lmno from the OPENAI_API_KEY environment variable. Change it where OPENAI_API_KEY is exported.");
  const h2 = await makeHarness({ env: {} });
  t.after(() => h2.cleanup());
  fs.writeFileSync(path.join(h2.pluginRoot, ".env"), `OPENAI_API_KEY=${KEY}\n`);
  assert.equal(h2.voice.control({ action: "key" }).message, `sotto: using the OpenAI API key ending in lmno from ${path.join(h2.pluginRoot, ".env")}. Change it in that file.`);
  const s = h2.voice.control({ action: "key", setup: true }).message;
  assert.match(s, /The key in use comes from .*\.env; change it there\./);
  assert.equal(h2.chrome.opened, 0);
});

test("userConfig key is the last resort and never leaves memory", async (t) => {
  const uc = "sk-test-" + "C".repeat(24) + "ucfg";
  const h = await makeHarness({ env: {}, userConfigKey: uc });
  t.after(() => h.cleanup());
  assert.match(h.voice.control({ action: "key" }).message, /ending in ucfg from the plugin settings\. Change or remove it in the voice window settings\./);
  const r = h.on();
  assert.equal(r.message, "sotto: voice ON (proj-a). Opening the voice window.");
  const s = await h.voice.createSession({ sdp: "v=0" });
  assert.equal(s.status, 201);
  assert.equal(h.fetchCalls.at(-1).init.headers.Authorization, `Bearer ${uc}`);
  noKeyAnywhere(h, uc);
});

test("a key saved while voice is off asks for /talk on", async (t) => {
  const h = await makeHarness({ env: {} });
  t.after(() => h.cleanup());
  openai(h);
  h.voice.control({ action: "key" });
  const r = await h.voice.saveKey(KEY);
  assert.equal(r.status, 200);
  assert.equal(r.body.message, "Key saved. Run /talk on in Claude Code to start talking.");
  assert.equal(r.body.connecting, false);
  assert.equal(h.voice.keySetup, false);
  assert.ok(!h.commands().some((c) => c.startsWith("connect")));
});

test("OpenAI rejects the saved key: the page can replace it", async (t) => {
  const h = await makeHarness({ env: {}, keychain: createFakeKeychain({ key: KEY }) });
  t.after(() => h.cleanup());
  h.on();
  h.setFetch(async () => ({ status: 401, text: async () => "{}" }));
  const r = await h.voice.createSession({ sdp: "x" });
  assert.equal(r.body.error.code, "openai_auth");
  assert.equal(h.voice.state, "paused");
  const ps = h.voice.pageStatus();
  assert.deepEqual([ps.last_error.code, ps.key.can_change], ["openai_auth", true]);
  const next = "sk-test-" + "N".repeat(24) + "new1";
  openai(h);
  const saved = await h.voice.saveKey(next);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.connecting, true);
  assert.equal(h.voice.lastError, null);
  assert.equal(h.keychain.key, next);
});
