import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSessionBody, createLiveSession, Sideband } from "../../daemon/live.js";
import { createMemoryLogger } from "../../daemon/log.js";
import { newCounters } from "../../daemon/voice.js";
import { createFakeClock } from "../helpers/fake-clock.js";
import { createFakeWSClass } from "../helpers/fake-ws.js";

test("create body matches SPEC §6.6 exactly", () => {
  const body = buildSessionBody({ instructions: "INSTR", seed: "SEED", voice: "cedar", sdp: "v=0 offer" });
  const expected = {
    session: {
      model: "gpt-live-1",
      instructions: "INSTR",
      input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "SEED" }] }],
      audio: { output: { voice: "cedar" } },
      delegation: { type: "client" },
      store: false,
      client: {
        data_channel: {
          allowed_client_events: ["session.input_audio.mute", "session.input_audio.unmute", "session.close"],
          allowed_server_events: [
            { type: "session.started" }, { type: "session.closed" },
            { type: "session.input_transcript.delta" }, { type: "session.output_transcript.delta" },
            { type: "session.input_audio.muted" }, { type: "session.input_audio.unmuted" },
            { type: "session.usage.updated" }, { type: "error" }, { type: "info" },
          ],
        },
      },
    },
    transport: { type: "webrtc", sdp: "v=0 offer" },
  };
  assert.deepEqual(body, expected);
  assert.equal(JSON.stringify(body).includes("format"), false);
});

function fakeFetch(status, json, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return { status, text: async () => JSON.stringify(json) };
  };
}

test("createLiveSession: success, auth, rate limit, other errors", async () => {
  const clock = createFakeClock();
  const calls = [];
  const ok = await createLiveSession({ base: "https://x/v1", apiKey: "sk-test", body: { a: 1 }, clock,
    fetchImpl: fakeFetch(201, { session: { id: "live_1" }, transport: { type: "webrtc", sdp: "v=0 answer" } }, calls) });
  assert.deepEqual({ ok: ok.ok, id: ok.id, sdp: ok.sdp }, { ok: true, id: "live_1", sdp: "v=0 answer" });
  assert.equal(calls[0].url, "https://x/v1/live/sessions");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");

  const auth = await createLiveSession({ base: "b", apiKey: "sk-secret", body: {}, clock, fetchImpl: fakeFetch(401, { error: { message: "bad key" } }) });
  assert.deepEqual([auth.httpStatus, auth.code], [502, "openai_auth"]);
  assert.ok(!auth.message.includes("sk-secret"));
  const rl = await createLiveSession({ base: "b", apiKey: "k", body: {}, clock, fetchImpl: fakeFetch(429, {}) });
  assert.deepEqual([rl.httpStatus, rl.code], [502, "openai_rate_limit"]);
  const e5 = await createLiveSession({ base: "b", apiKey: "k", body: {}, clock, fetchImpl: fakeFetch(503, {}) });
  assert.deepEqual([e5.httpStatus, e5.code], [502, "openai_error"]);
  assert.match(e5.message, /503/);
  const net = await createLiveSession({ base: "b", apiKey: "k", body: {}, clock, fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  assert.equal(net.code, "openai_error");
});

test("createLiveSession: 15 s timeout → openai_timeout (504)", async () => {
  const clock = createFakeClock();
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
  const p = createLiveSession({ base: "b", apiKey: "k", body: {}, clock, fetchImpl: hang });
  await clock.advance(15000);
  const r = await p;
  assert.deepEqual([r.httpStatus, r.code], [504, "openai_timeout"]);
});

function sideband(opts = {}) {
  const clock = createFakeClock();
  const WS = createFakeWSClass();
  const log = createMemoryLogger();
  const counters = newCounters();
  const sb = new Sideband({ id: "live_1", url: "wss://x/v1/live/sessions/live_1/attach", apiKey: "sk-test", WebSocketImpl: WS, clock, log, counters, ...opts });
  const events = [];
  for (const e of ["open", "ready", "ack", "append_failed", "session_closed", "lost", "socket_closed"]) sb.on(e, (x) => events.push([e, x]));
  const seen = [];
  sb.on("event", (e) => seen.push(e.type));
  return { clock, WS, log, counters, sb, events, seen };
}

test("sideband connects with the bearer header and becomes ready on session.started", async () => {
  const { WS, sb, events } = sideband();
  sb.connect();
  const ws = WS.last();
  assert.equal(ws.url, "wss://x/v1/live/sessions/live_1/attach");
  assert.deepEqual(ws.opts, { headers: { Authorization: "Bearer sk-test" } });
  ws.open();
  ws.receive({ type: "session.started", session: { id: "live_1", expires_at: 1790000000 } });
  assert.deepEqual(events.find((e) => e[0] === "ready"), ["ready", { started: true, expires_at: 1790000000 }]);
});

test("sideband becomes ready 1.5 s after open without session.started", async () => {
  const { WS, sb, clock, events } = sideband();
  sb.connect();
  WS.last().open();
  await clock.advance(1499);
  assert.ok(!events.some((e) => e[0] === "ready"));
  await clock.advance(1);
  assert.deepEqual(events.find((e) => e[0] === "ready"), ["ready", { started: false, expires_at: null }]);
});

test("appends: delegation_id always present, queued before ready, acks and errors matched", async () => {
  const { WS, sb, counters, events } = sideband();
  sb.connect();
  const ws = WS.last();
  sb.append("thinking", "early note", null);
  ws.open();
  assert.equal(ws.sent.length, 0, "queued until ready");
  ws.receive({ type: "session.started", session: {} });
  assert.deepEqual(ws.sent[0], { type: "session.thinking.append", event_id: "clv_1", delegation_id: null, content: "early note" });
  const id2 = sb.append("commentary", "Result.", "item_9");
  const id3 = sb.append("instructions", "Greet.");
  assert.deepEqual(ws.sent[1], { type: "session.commentary.append", event_id: id2, delegation_id: "item_9", content: "Result." });
  assert.equal(ws.sent[2].delegation_id, null);
  for (const e of ws.sent) assert.ok("delegation_id" in e);
  assert.deepEqual([counters.thinking_sent, counters.commentary_sent, counters.instructions_sent], [1, 1, 1]);

  ws.receive({ type: "session.thinking.appended", client_event_id: "clv_1", start_ms: 1, end_ms: 1 });
  ws.receive({ type: "session.commentary.appended", client_event_id: id2, start_ms: 2, end_ms: 2 });
  ws.receive({ type: "session.commentary.appended", client_event_id: "unknown" });
  ws.receive({ type: "error", error: { code: "bad", message: "nope", client_event_id: id3 } });
  assert.equal(counters.appends_acked, 2);
  assert.equal(counters.appends_failed, 1);
  assert.deepEqual(events.filter((e) => e[0] === "ack").map((e) => e[1].event_id), ["clv_1", id2]);
  assert.equal(events.find((e) => e[0] === "append_failed")[1].event_id, id3);
  assert.throws(() => sb.append("thinking", "x".repeat(1401)));
  assert.throws(() => sb.append("bogus", "x"));
});

test("thinking queue keeps the last 50 while not ready", () => {
  const { WS, sb } = sideband();
  sb.connect();
  for (let i = 0; i < 60; i++) sb.append("thinking", `n${i}`, null);
  sb.append("commentary", "keep me", null);
  const ws = WS.last();
  ws.open();
  ws.receive({ type: "session.started", session: {} });
  const thinking = ws.sentOfType("session.thinking.append");
  assert.equal(thinking.length, 50);
  assert.equal(thinking[0].content, "n10");
  assert.equal(ws.sentOfType("session.commentary.append").length, 1);
});

test("audio events are dropped: never emitted, logged or stored", () => {
  const { WS, sb, seen, log } = sideband();
  sb.connect();
  const ws = WS.last();
  ws.open();
  const big = "A".repeat(6400);
  ws.receive({ type: "session.output_audio.delta", delta: big });
  ws.receive(JSON.stringify({ audio: big, type: "session.input_audio.append" })); // type after payload
  ws.receive({ type: "session.output_audio.delta", delta: "AA" }); // small
  ws.receive({ type: "session.input_transcript.delta", delta: " hi", start_ms: 0, end_ms: 200 });
  assert.deepEqual(seen, ["session.input_transcript.delta"]);
  assert.ok(sb.audioBytes > 12800);
  assert.ok(!JSON.stringify(log.entries).includes("AAAAAAAA"));
});

test("unexpected close triggers exactly one re-attach, then lost", async () => {
  const { WS, sb, clock, events } = sideband();
  sb.connect();
  WS.last().open();
  WS.last().receive({ type: "session.started", session: {} });
  WS.last().serverClose(1006);
  assert.equal(WS.instances.length, 1);
  await clock.advance(1000);
  assert.equal(WS.instances.length, 2, "re-attached after 1 s");
  WS.last().serverClose(1006); // re-attach fails
  await clock.advance(5000);
  assert.equal(WS.instances.length, 2);
  assert.ok(events.some((e) => e[0] === "lost"));
});

test("re-attached socket flushes queued appends", async () => {
  const { WS, sb, clock } = sideband();
  sb.connect();
  WS.last().open();
  WS.last().receive({ type: "session.started", session: {} });
  WS.last().serverClose(1006);
  sb.append("thinking", "while away", null);
  await clock.advance(1000);
  WS.last().open();
  assert.equal(WS.last().sentOfType("session.thinking.append")[0].content, "while away");
});

test("close(): sends session.close, resolves on session.closed, no re-attach", async () => {
  const { WS, sb, clock, events } = sideband();
  sb.connect();
  const ws = WS.last();
  ws.open();
  ws.receive({ type: "session.started", session: {} });
  const p = sb.close(15000);
  assert.equal(ws.sentOfType("session.close").length, 1);
  ws.receive({ type: "error", error: { code: "context_injection_incomplete", client_event_id: "clv_x" } });
  ws.receive({ type: "session.closed", reason: "close_requested", usage: { seconds: 12.5 } });
  const r = await p;
  assert.equal(r.confirmed, true);
  assert.deepEqual(events.find((e) => e[0] === "session_closed")[1], { reason: "close_requested", seconds: 12.5 });
  await clock.advance(5000);
  assert.equal(WS.instances.length, 1);
});

test("close(): times out after 15 s as unconfirmed", async () => {
  const { WS, sb, clock, log } = sideband();
  sb.connect();
  WS.last().open();
  const p = sb.close(15000);
  await clock.advance(15000);
  assert.equal((await p).confirmed, false);
  assert.ok(log.find("sideband.close_timeout").length === 1);
});
