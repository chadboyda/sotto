// PrimarySession (daemon/live-ws.js) and the input pacer (daemon/pacer.js),
// docs/NATIVE.md §2.3 and §4.1. Fake clock and fake WebSocket; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrimarySession, buildPrimaryStart } from "../../daemon/live-ws.js";
import { createPacer } from "../../daemon/pacer.js";
import { createMemoryLogger } from "../../daemon/log.js";
import { newCounters } from "../../daemon/voice.js";
import { createFakeClock } from "../helpers/fake-clock.js";
import { createFakeWSClass } from "../helpers/fake-ws.js";

function session() {
  const clock = createFakeClock();
  const WS = createFakeWSClass();
  const log = createMemoryLogger();
  const counters = newCounters();
  const start = buildPrimaryStart({ instructions: "be brief", seed: "seed", voice: "marin" });
  const sb = new PrimarySession({ url: "wss://example.test/v1/live/sessions", apiKey: "sk-test-secret", start, WebSocketImpl: WS, clock, log, counters });
  return { clock, WS, log, counters, sb };
}

// ---- PrimarySession ----------------------------------------------------------------------------

test("connect: bearer header, session.start first, ready (and the id) only on session.started", async () => {
  const { WS, sb, clock } = session();
  const events = [];
  sb.on("ready", (r) => events.push(["ready", r]));
  sb.connect();
  const ws = WS.last();
  assert.equal(ws.url, "wss://example.test/v1/live/sessions");
  assert.deepEqual(ws.opts.headers, { Authorization: "Bearer sk-test-secret" });
  ws.open();
  assert.equal(ws.sent.length, 1);
  assert.equal(ws.sent[0].type, "session.start");
  assert.equal(ws.sent[0].session.audio.format.type, "audio/pcm");
  await clock.advance(5000);
  assert.equal(events.length, 0, "no 1.5 s fallback on the primary socket");
  assert.equal(sb.id, null);
  // Appends and audio wait for session.started.
  sb.append("instructions", "hello", null);
  assert.equal(sb.pushAudio(Buffer.alloc(960)), false);
  assert.equal(ws.sent.length, 1);
  ws.receive({ type: "session.started", session: { id: "live_1", expires_at: 123 } });
  assert.equal(sb.id, "live_1");
  assert.equal(events[0][1].expires_at, 123);
  assert.equal(ws.sent[1].type, "session.instructions.append", "queued append flushed");
  assert.equal(sb.pushAudio(Buffer.alloc(960, 1)), true);
  assert.equal(ws.sent[2].type, "session.input_audio.append");
  assert.equal(Buffer.from(ws.sent[2].audio, "base64").length, 960);
});

test("acks and append failures behave like the sideband", () => {
  const { WS, sb, counters } = session();
  const acks = [];
  const fails = [];
  sb.on("ack", (a) => acks.push(a));
  sb.on("append_failed", (f) => fails.push(f));
  sb.connect();
  const ws = WS.last();
  ws.open();
  ws.receive({ type: "session.started", session: { id: "live_1" } });
  const id1 = sb.append("commentary", "Done.", "item_1");
  const id2 = sb.append("thinking", "context", null);
  ws.receive({ type: "session.commentary.appended", client_event_id: id1 });
  ws.receive({ type: "error", error: { code: "invalid_value", message: "bad", client_event_id: id2 } });
  assert.deepEqual(acks, [{ kind: "commentary", event_id: id1 }]);
  assert.equal(fails[0].kind, "thinking");
  assert.equal(fails[0].content, "context");
  assert.equal(counters.appends_acked, 1);
  assert.equal(counters.appends_failed, 1);
});

test("output audio: decoded and emitted as PCM, never logged or parsed into events", () => {
  const { WS, sb, log } = session();
  const pcm = [];
  const evts = [];
  sb.on("audio", (b) => pcm.push(b));
  sb.on("event", (e) => evts.push(e.type));
  sb.connect();
  const ws = WS.last();
  ws.open();
  ws.receive({ type: "session.started", session: { id: "live_1" } });
  const big = Buffer.alloc(4800, 3);
  ws.receive({ type: "session.output_audio.delta", delta: big.toString("base64") });
  ws.receive({ type: "session.output_audio.delta", delta: Buffer.from([1, 2]).toString("base64") }); // short: parsed path
  assert.equal(pcm.length, 2);
  assert.deepEqual(pcm[0], big);
  assert.deepEqual([...pcm[1]], [1, 2]);
  assert.deepEqual(evts, ["session.started"]);
  assert.ok(!JSON.stringify(log.entries).includes(big.toString("base64").slice(0, 40)));
  assert.ok(sb.lastOutputAudioAt > 0);
});

test("no re-attach: an unexpected close is `lost`; before open it is a start failure (neverOpened)", async () => {
  const { WS, sb, clock } = session();
  const lost = [];
  sb.on("lost", (l) => lost.push(l));
  sb.connect();
  const ws = WS.last();
  ws.open();
  ws.receive({ type: "session.started", session: { id: "live_1" } });
  ws.serverClose(1006);
  await clock.advance(5000);
  assert.equal(WS.instances.length, 1, "never re-attaches");
  assert.deepEqual(lost, [{ code: 1006, neverOpened: false, started: true, error: null }]);
  assert.equal(sb.state, "closed");

  const s2 = session();
  const lost2 = [];
  s2.sb.on("lost", (l) => lost2.push(l));
  s2.sb.connect();
  s2.WS.last().serverClose(1006);
  assert.equal(lost2[0].neverOpened, true);
  assert.equal(lost2[0].started, false);

  const s3 = session();
  const lost3 = [];
  s3.sb.on("lost", (l) => lost3.push(l));
  s3.sb.connect();
  const w3 = s3.WS.last();
  w3.open();
  w3.receive({ type: "error", error: { code: "invalid_request_error", message: "voice is invalid" } });
  w3.serverClose(1008);
  assert.deepEqual(lost3[0].error, { code: "invalid_request_error", message: "voice is invalid" });
});

test("close: session.close, resolves on session.closed; no `lost` for an expected close", async () => {
  const { WS, sb } = session();
  const lost = [];
  sb.on("lost", (l) => lost.push(l));
  sb.connect();
  const ws = WS.last();
  ws.open();
  ws.receive({ type: "session.started", session: { id: "live_1" } });
  const p = sb.close(3000);
  assert.equal(ws.sent.at(-1).type, "session.close");
  assert.equal(sb.pushAudio(Buffer.alloc(960)), false, "no audio after close");
  ws.receive({ type: "session.closed", reason: "close_requested", usage: { seconds: 4 } });
  assert.deepEqual(await p, { confirmed: true });
  assert.equal(lost.length, 0);
});

// ---- pacer ---------------------------------------------------------------------------------------

function pacer(opts = {}) {
  const clock = createFakeClock();
  const sent = [];
  let expired = 0;
  const p = createPacer({ clock, send: (b) => sent.push(b), onGraceExpired: () => { expired++; }, ...opts });
  return { clock, sent, p, expired: () => expired };
}
const frame = (v) => Buffer.alloc(960, v);

test("pacer: one frame per 20 ms from the app, in order; nothing before start", async () => {
  const { clock, sent, p } = pacer();
  p.push(frame(9));
  p.start();
  assert.equal(sent.length, 0, "a frame from before start is never sent");
  for (let i = 1; i <= 50; i++) { p.push(frame(i)); await clock.advance(20); }
  assert.equal(sent.length, 50);
  assert.deepEqual(sent.map((b) => b[0]), [...Array(50).keys()].map((i) => i + 1));
  assert.equal(p.stats().fill_frames, 0);
  assert.equal(p.stats().input_ms, 1000);
});

test("pacer: fills silence once the app is more than 60 ms behind; a late burst is trimmed back to target", async () => {
  const { clock, sent, p } = pacer();
  p.start();
  await clock.advance(200);
  const filled = p.stats().fill_frames;
  assert.ok(filled >= 7 && filled <= 8, `filled ${filled}`);
  assert.ok(sent.every((b) => b.every((x) => x === 0)));
  // The late frames arrive in a burst: queued, the excess over 3 frames trimmed within ~0.5 s.
  for (let i = 0; i < filled; i++) p.push(frame(5));
  p.push(frame(7));
  await clock.advance(600);
  assert.ok(p.stats().queued <= 3, `queued ${p.stats().queued}`);
  assert.ok(p.stats().dropped_late <= filled, "never drops more than the burst's excess");
  // Timeline stays at wall time (800 / 20 frames), at most fillAfterMs (3 frames) behind.
  assert.ok(p.stats().sent_frames >= 38 && p.stats().sent_frames <= 41, `sent ${p.stats().sent_frames}`);
});

/** Feed the pacer an app stream at `fps` for `ms`; returns how many real frames went out. */
async function stream(clock, p, sent, { ms, fps = 50, value = 1 }) {
  const before = sent.length;
  // One step per app frame (fractional ms kept exact), so a minute of audio stays cheap.
  let t = 0;
  for (let k = 0; ; k++) {
    const at = Math.round((k * 1000) / fps);
    if (at >= ms) break;
    if (at > t) { await clock.advance(at - t); t = at; }
    p.push(frame(value));
  }
  if (ms > t) await clock.advance(ms - t);
  return sent.slice(before).filter((b) => b[0] === value).length;
}

test("pacer: after a capture stall (rebuild, route change, sleep/wake) real frames flow again, nothing is dropped", async () => {
  const { clock, sent, p } = pacer();
  p.start();
  await stream(clock, p, sent, { ms: 2000 });
  await clock.advance(300); // the app rebuilt its capture: 300 ms with no frames, none arrive later
  const s0 = p.stats();
  const real = await stream(clock, p, sent, { ms: 30_000 });
  const s = p.stats();
  const fills = s.fill_frames - s0.fill_frames;
  assert.equal(s.dropped_late - s0.dropped_late, 0, "no frame dropped as late");
  assert.equal(fills, 0, "no silence substituted while the app streams");
  assert.ok(real >= 1495, `real frames sent ${real} of 1500`);
});

test("pacer: stalls with the timestamp jumping back or ahead (seq restart) never lock into silence", async () => {
  const { clock, sent, p } = pacer();
  p.start();
  for (const gap of [150, 700, 60, 2500]) {
    await stream(clock, p, sent, { ms: 1000 });
    await clock.advance(gap);
    p.resync(); // the app's route message after a rebuild
  }
  const s0 = p.stats();
  const real = await stream(clock, p, sent, { ms: 10_000 });
  assert.equal(p.stats().fill_frames - s0.fill_frames, 0);
  assert.equal(p.stats().dropped_late - s0.dropped_late, 0);
  assert.ok(real >= 498, `real ${real}`);
});

test("pacer: app clock drift of +/-0.5 % keeps drops and silence under 1 %", async () => {
  for (const fps of [50 * 1.005, 50 * 0.995]) {
    const { clock, sent, p } = pacer();
    p.start();
    const real = await stream(clock, p, sent, { ms: 60_000, fps });
    const s = p.stats();
    const pushed = Math.floor(60_000 * fps / 1000);
    assert.ok((s.dropped_late + s.dropped) / pushed < 0.01, `fps ${fps}: dropped ${s.dropped_late + s.dropped}`);
    assert.ok(s.fill_frames / s.sent_frames < 0.01, `fps ${fps}: fills ${s.fill_frames}`);
    assert.ok(real / s.sent_frames > 0.99, `fps ${fps}: real ${real} of ${s.sent_frames}`);
    assert.ok(s.queued <= 4, `latency bounded (queued ${s.queued})`);
  }
});

test("pacer: onDropRate fires when over 5 % of frames are dropped or replaced by silence in 5 s", async () => {
  const warns = [];
  const { clock, sent, p } = pacer({ onDropRate: (w) => warns.push(w) });
  p.start();
  await stream(clock, p, sent, { ms: 10_000 });
  assert.equal(warns.length, 0, "a healthy stream never warns");
  // App at half rate: silence fills half the slots.
  await stream(clock, p, sent, { ms: 6000, fps: 25 });
  assert.ok(warns.length >= 1, "warned");
  assert.ok(warns.at(-1).fill_ratio > 0.05);
  assert.equal(p.stats().drop_warnings, warns.length);
});

test("pacer: queue capped at 10 frames (oldest dropped); muted sends zeros", async () => {
  let muted = false;
  const { clock, sent, p } = pacer({ isMuted: () => muted });
  p.start();
  for (let i = 0; i < 15; i++) p.push(frame(i + 1));
  assert.equal(p.stats().dropped, 5);
  assert.equal(p.stats().queued, 10);
  await clock.advance(20);
  assert.equal(sent[0][0], 6, "oldest dropped");
  muted = true;
  await clock.advance(20);
  assert.ok(sent.at(-1).every((x) => x === 0));
});

test("pacer: app gone -> silence continues; grace (10 s) expiry calls back once; appBack cancels", async () => {
  const { clock, sent, p, expired } = pacer();
  p.start();
  p.appGone();
  await clock.advance(5000);
  assert.ok(sent.length >= 245, "timeline kept alive");
  p.appBack();
  await clock.advance(6000);
  assert.equal(expired(), 0);
  p.appGone();
  await clock.advance(10_000);
  assert.equal(expired(), 1);
  p.stop();
  const n = sent.length;
  await clock.advance(1000);
  assert.equal(sent.length, n, "stopped");
});

// ---- NativeController: speech onsets in the speaker stream (log only; app e2e latency) ------------

test("native: one speech_onset line per loud frame after 300 ms of quiet frames", async () => {
  const { NativeController } = await import("../../daemon/native-session.js");
  const clock = createFakeClock();
  const log = createMemoryLogger();
  const ctl = new NativeController({ voice: { state: "live" }, log, clock, hearing: { silentMs: 5000 } });
  const sb = { id: "sess_1" };
  ctl.session = sb;
  ctl.link = { sendAudio: () => true };
  const frame = (v) => { const b = Buffer.alloc(960); for (let i = 0; i < 480; i++) b.writeInt16LE(v, i * 2); return b; };
  const feed = (v, n) => { for (let i = 0; i < n; i++) ctl.onSessionAudio(sb, frame(v)); };
  feed(0, 20); feed(4000, 10); // silence then speech: onset
  feed(100, 10); feed(4000, 5); // a 200 ms pause inside speech: no onset
  feed(0, 15); feed(4000, 1); // 300 ms of quiet: onset
  const onsets = log.entries.filter((e) => e.ev === "native.speech_onset");
  assert.equal(onsets.length, 2);
  assert.equal(onsets[0].live_id, "sess_1");
  assert.equal(onsets[0].peak, 4000);
});
