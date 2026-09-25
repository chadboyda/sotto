// Voice choice: prefs precedence (SPEC §4.5), live switch (§6.14), page API (§6.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { readPrefs, writePrefs, resolveVoice, normalizeVoice, voiceListMessage, unknownVoiceMessage } from "../../daemon/prefs.js";
import { dataPaths } from "../../daemon/paths.js";
import { VOICES, VOICE_INFO } from "../../daemon/config.js";
import { voiceSwitchGreeting, TEMPLATE, VOICE_HISTORY_END } from "../../daemon/prompt.js";
import { makeHarness, SESSION } from "../helpers/daemon-harness.js";

const appends = (ws, kind) => ws.sent.filter((e) => e.type === `session.${kind}.append`);
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "clv-prefs-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

// ---- prefs.js -------------------------------------------------------------------------

test("resolveVoice: prefs file > userConfig > default; invalid values skipped", () => {
  assert.equal(resolveVoice({ prefs: { voice: "cedar" }, configVoice: "sage" }), "cedar");
  assert.equal(resolveVoice({ prefs: {}, configVoice: "sage" }), "sage");
  assert.equal(resolveVoice({ prefs: {}, configVoice: undefined }), "marin");
  assert.equal(resolveVoice({ prefs: { voice: "robot" }, configVoice: "robot" }), "marin");
  assert.equal(resolveVoice({ prefs: { voice: "robot" }, configVoice: "echo" }), "echo");
  assert.equal(resolveVoice(), "marin");
});

test("normalizeVoice lowercases and trims; rejects unknown names", () => {
  assert.equal(normalizeVoice("  Cedar "), "cedar");
  assert.equal(normalizeVoice("robot"), null);
  assert.equal(normalizeVoice(null), null);
  assert.equal(normalizeVoice({}), null);
});

test("readPrefs/writePrefs: missing or malformed → {}, atomic 0600, compact one line", (t) => {
  const p = dataPaths(tmp(t));
  assert.deepEqual(readPrefs(p), {});
  fs.writeFileSync(p.prefs, "not json");
  assert.deepEqual(readPrefs(p), {});
  fs.writeFileSync(p.prefs, '["cedar"]');
  assert.deepEqual(readPrefs(p), {});
  fs.writeFileSync(p.prefs, '{"voice":"robot"}');
  assert.deepEqual(readPrefs(p), {});
  writePrefs(p, { voice: "ash" });
  assert.equal(fs.readFileSync(p.prefs, "utf8"), '{"voice":"ash"}\n', "toggle.sh parses this with a bash regex");
  assert.equal(fs.statSync(p.prefs).mode & 0o777, 0o600);
  assert.deepEqual(readPrefs(p), { voice: "ash" });
});

test("list and unknown-voice messages", () => {
  const m = voiceListMessage("cedar");
  assert.match(m, /^sotto: voice is cedar\. Voices: alloy, /);
  assert.ok(m.includes("cedar (current)"));
  assert.equal(m.match(/\(current\)/g).length, 1);
  for (const v of VOICES) assert.ok(m.includes(v));
  assert.equal(unknownVoiceMessage('ro"bot\n'), `sotto: unknown voice "robot". Voices: ${VOICES.join(", ")}.`);
});

test("prompt: the voice model is told it cannot change its voice and to delegate it", () => {
  assert.match(TEMPLATE, /You cannot change your own voice/);
  assert.match(TEMPLATE, /Delegate to the backend when:[\s\S]*switch to a different voice[\s\S]*Do not delegate to the backend when:/);
  assert.equal(voiceSwitchGreeting("cedar"), 'Say only "Switched to cedar." Then stop and listen; the conversation continues from where it left off.');
});

// ---- Voice orchestrator -------------------------------------------------------------------

test("on: prefs.json beats the userConfig voice from /control", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  fs.writeFileSync(path.join(h.dataDir, "prefs.json"), '{"voice":"cedar"}');
  h.on(SESSION(), { voice: "sage" });
  assert.equal(h.voice.config.voice, "cedar");
  const r = await h.voice.createSession({ sdp: "v=0 offer", reason: "start" });
  assert.equal(r.status, 201);
  assert.deepEqual(h.fetchCalls[0].body.session.audio, { output: { voice: "cedar" } });
});

test("on: without prefs the userConfig voice is used", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  h.on(SESSION(), { voice: "sage" });
  assert.equal(h.voice.config.voice, "sage");
});

test("control voice: list, set (persisted), already, unknown — without a Live session", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  // Not bound: current = prefs > the caller's userConfig.
  let r = h.voice.control({ action: "voice", config: { voice: "sage" } });
  assert.equal(r.ok, true);
  assert.match(r.message, /^sotto: voice is sage\./);
  r = h.voice.control({ action: "voice", voice: "Echo", config: { voice: "sage" } });
  assert.equal(r.message, "sotto: voice set to echo. It applies to the next voice session.");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dataDir, "prefs.json"), "utf8")), { voice: "echo" });
  r = h.voice.control({ action: "voice", config: { voice: "sage" } });
  assert.match(r.message, /^sotto: voice is echo\./);
  r = h.voice.control({ action: "voice", voice: "echo" });
  assert.equal(r.message, "sotto: voice is already echo.");
  r = h.voice.control({ action: "voice", voice: "robot" });
  assert.equal(r.ok, false);
  assert.match(r.message, /^sotto: unknown voice "robot"/);
  // A later /talk on keeps the chosen voice over userConfig.
  h.on(SESSION(), { voice: "sage" });
  assert.equal(h.voice.pageStatus().voice, "echo");
  assert.equal(h.voice.status().config.voice, "echo");
});

test("live switch: closes the old session, asks the page to reconnect, seeds context, confirms in the new voice", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive({ config: { voice: "marin" } });
  ws.receive({ type: "session.input_transcript.delta", delta: " we were talking about the parser", start_ms: 0, end_ms: 1 });
  ws.receive({ type: "session.output_transcript.delta", delta: " right, the parser", start_ms: 1, end_ms: 2 });
  assert.equal(h.voice.state, "live");

  const r = h.voice.control({ action: "voice", voice: "cedar" });
  assert.equal(r.ok, true);
  assert.equal(r.message, "sotto: voice set to cedar. Switching the live session now.");
  assert.equal(h.voice.state, "reconnecting");
  assert.equal(ws.sentOfType("session.close").length, 1, "old session closed");
  // The page is asked to reconnect only after session.closed: tearing down the
  // peer at the same moment made the server end the session as connection_lost.
  assert.deepEqual(h.commands(), [], "no reconnect before the old session has closed");
  assert.ok(h.sse.some((m) => m.type === "notice" && m.code === "voice_change"));
  // The old session's session.closed books usage but does not trigger the loss path.
  h.closeReply(ws, "close_requested", 7);
  await h.clock.advance(0);
  assert.equal(h.voice.state, "reconnecting");
  assert.deepEqual(h.commands(), ["reconnect:voice_change"]);
  assert.equal(h.voice.reconnects.length, 0, "a voice switch is not an unexpected loss");

  // The page re-offers with reason reconnect.
  const c = await h.voice.createSession({ sdp: "v=0 offer 2", reason: "reconnect" });
  assert.equal(c.status, 201);
  const body = h.fetchCalls[1].body.session;
  assert.deepEqual(body.audio, { output: { voice: "cedar" } });
  // Background first; the voice history follows as real user/assistant messages
  // (already spoken), then an end marker.
  assert.match(body.input[0].content[0].text, /Voice session: reconnected\./);
  assert.deepEqual(body.input.slice(1).map((m) => [m.role, m.content[0].type, m.content[0].text]), [
    ["user", "input_text", "we were talking about the parser"],
    ["assistant", "output_text", "right, the parser"],
    ["developer", "input_text", VOICE_HISTORY_END],
  ]);
  const ws2 = h.WS.last();
  ws2.open();
  ws2.receive({ type: "session.started", session: {} });
  assert.equal(h.voice.state, "live");
  const ins = appends(ws2, "instructions");
  assert.equal(ins.length, 1);
  assert.equal(ins[0].content, voiceSwitchGreeting("cedar"));
  assert.equal(ins[0].delegation_id, null);
  assert.equal(h.voice.live.voice, "cedar");

  // A later plain reconnect (e.g. expiry) greets nothing again.
  assert.equal(h.voice.voiceSwitch, null);
});

test("setting the same voice while live does not re-create the session", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive({ config: { voice: "marin" } });
  const r = h.voice.control({ action: "voice", voice: "marin" });
  assert.equal(r.message, "sotto: voice is already marin.");
  assert.equal(h.voice.state, "live");
  assert.equal(ws.sentOfType("session.close").length, 0);
  assert.deepEqual(h.commands(), []);
});

test("voice chosen while the session is still connecting: switches once it is ready, no greeting in the old voice", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  h.on(SESSION(), { voice: "marin" });
  const c = await h.voice.createSession({ sdp: "v=0 offer", reason: "start" });
  assert.equal(c.status, 201);
  assert.equal(h.voice.state, "connecting");
  const r = h.voice.control({ action: "voice", voice: "sage" });
  assert.equal(r.message, "sotto: voice set to sage. The session switches as soon as it is ready.");
  const ws = h.WS.last();
  ws.open();
  ws.receive({ type: "session.started", session: {} });
  assert.equal(h.voice.state, "reconnecting");
  assert.equal(appends(ws, "instructions").length, 0, "no start greeting in marin");
  assert.equal(ws.sentOfType("session.close").length, 1);
  assert.deepEqual(h.commands(), [], "waits for session.closed");
  h.closeReply(ws, "close_requested", 1);
  await h.clock.advance(0);
  assert.deepEqual(h.commands(), ["reconnect:voice_change"]);
});

test("live switch: no session.closed within 2 s still reconnects", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive({ config: { voice: "marin" } });
  h.voice.control({ action: "voice", voice: "cedar" });
  assert.equal(ws.sentOfType("session.close").length, 1);
  await h.clock.advance(1900);
  assert.deepEqual(h.commands(), []);
  await h.clock.advance(200);
  assert.deepEqual(h.commands(), ["reconnect:voice_change"]);
  assert.equal(h.voice.state, "reconnecting");
});

test("paused: a voice change just applies to the next session", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive({ config: { voice: "marin" } });
  const p = h.voice.pause("pause");
  h.closeReply(ws);
  await p;
  assert.equal(h.voice.state, "paused");
  const r = h.voice.control({ action: "voice", voice: "ballad" });
  assert.equal(r.message, "sotto: voice set to ballad. It applies to the next voice session.");
  assert.deepEqual(h.commands(), ["disconnect:pause"]);
  await h.voice.createSession({ sdp: "x", reason: "resume" });
  assert.deepEqual(h.fetchCalls.at(-1).body.session.audio, { output: { voice: "ballad" } });
  const ws2 = h.WS.last();
  ws2.open();
  ws2.receive({ type: "session.started", session: {} });
  assert.match(appends(ws2, "instructions")[0].content, /I'm back/, "resume keeps its own greeting");
});

// ---- HTTP API ------------------------------------------------------------------------------

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
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

test("GET /api/voices and POST /api/voice: page-token auth, validation, live switch", async (t) => {
  const h = await makeHarness({ realClock: true });
  await h.d.listen();
  t.after(() => h.cleanup());
  const page = { "X-Sotto-Page": h.d.pageToken };

  assert.equal((await request(h.port, { path: "/api/voices" })).status, 403);
  assert.equal((await request(h.port, { path: "/api/voices", headers: { "X-Sotto-Key": h.d.daemonKey } })).status, 403, "the daemon key is not a page token");
  let r = await request(h.port, { path: "/api/voices", headers: page });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { voices: [...VOICES], current: "marin", live: false, live_voice: null, info: JSON.parse(JSON.stringify(VOICE_INFO)) });
  r = await request(h.port, { path: `/api/voices?token=${h.d.pageToken}` });
  assert.equal(r.status, 200);

  assert.equal((await request(h.port, { method: "POST", path: "/api/voice", body: { voice: "cedar" } })).status, 403);
  r = await request(h.port, { method: "POST", path: "/api/voice", headers: page, body: { voice: "robot" } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, "bad_voice");
  r = await request(h.port, { method: "POST", path: "/api/voice", headers: { ...page, Origin: "http://evil.example" }, body: { voice: "cedar" } });
  assert.equal(r.status, 403);

  const ws = await h.goLive({ config: { voice: "marin" } });
  r = await request(h.port, { path: "/api/voices", headers: page });
  assert.deepEqual([r.json.current, r.json.live, r.json.live_voice], ["marin", true, "marin"]);
  r = await request(h.port, { method: "POST", path: "/api/voice", headers: page, body: { voice: "cedar" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, voice: "cedar", switching: true, message: "sotto: voice set to cedar. Switching the live session now." });
  assert.equal(ws.sentOfType("session.close").length, 1);
  assert.equal(h.voice.state, "reconnecting");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dataDir, "prefs.json"), "utf8")), { voice: "cedar" });
  r = await request(h.port, { path: "/api/voices", headers: page });
  assert.deepEqual([r.json.current, r.json.live], ["cedar", false]);
});

test("POST /control action voice answers in hook format as one line", async (t) => {
  const h = await makeHarness({ realClock: true });
  await h.d.listen();
  t.after(() => h.cleanup());
  const r = await request(h.port, { method: "POST", path: "/control?format=hook", headers: { "X-Sotto-Key": h.d.daemonKey }, body: { action: "voice", voice: "coral" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { continue: false, stopReason: "sotto: voice set to coral. It applies to the next voice session." });
});

test("live switch: the new session does not re-speak the last update; an unheard one is carried once", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive({ config: { voice: "marin" } });
  // An update the old session spoke.
  h.voice.deliver({ kind: "commentary", content: "Claude Code's answer: you're on the banana branch.", delegationId: null, source: "voice_result" });
  assert.equal(appends(ws, "commentary").length, 1);
  await h.clock.advance(500);
  ws.receive({ type: "session.output_transcript.delta", delta: " You're on the banana branch.", start_ms: 100, end_ms: 1500 });
  await h.clock.advance(3000);
  // A second update sent just before the switch, never spoken.
  h.voice.deliver({ kind: "commentary", content: "Claude finished: the tests pass.", delegationId: null, source: "typed_result" });
  assert.equal(appends(ws, "commentary").length, 2);
  h.voice.control({ action: "voice", voice: "cedar" });
  // While switching, the same spoken update is routed again: dropped.
  h.voice.deliver({ kind: "commentary", content: "Claude Code's answer: you're on the banana branch.", delegationId: null, source: "voice_result" });
  h.closeReply(ws, "close_requested", 5);
  await h.clock.advance(0);
  assert.equal(h.voice.pendingResult, null, "nothing fell into pendingResult during the swap");
  await h.voice.createSession({ sdp: "v=0 offer 2", reason: "reconnect" });
  const input = h.fetchCalls[1].body.session.input;
  assert.ok(!/Result that arrived while voice was paused/.test(input[0].content[0].text));
  assert.ok(input.some((m) => m.role === "assistant" && /banana branch/.test(m.content[0].text)), "the spoken update is assistant history");
  const ws2 = h.WS.last();
  ws2.open();
  ws2.receive({ type: "session.started", session: {} });
  assert.equal(appends(ws2, "instructions")[0].content, voiceSwitchGreeting("cedar"));
  assert.equal(appends(ws2, "commentary").length, 0, "carried update waits for the greeting");
  await h.clock.advance(3000);
  assert.deepEqual(appends(ws2, "commentary").map((a) => a.content), ["Claude finished: the tests pass."]);
  await h.clock.advance(30000);
  assert.equal(appends(ws2, "commentary").length, 1, "each update once");
});
