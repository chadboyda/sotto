// Echo handling in the voice orchestrator (SPEC §6.8.1, §7.7): the wake clip
// against what was played aloud, page echo reports, the guard mode in the
// page status, and the echo filter on the mirror path end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "../helpers/daemon-harness.js";
import { MIRROR_QUIET_MS } from "../../daemon/mirror.js";

function wavB64(ms = 500) {
  const n = Math.round((16000 * ms) / 1000);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  return b.toString("base64");
}

async function harness(t, { transcript = "hi i'm cedar this is how i sound" } = {}) {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  h.d.sse.clients.add({ write() {}, end() {} });
  let live = 0;
  h.setFetch(async (url, init) => {
    if (String(url).endsWith("/audio/transcriptions")) return { status: 200, text: async () => JSON.stringify({ text: transcript }) };
    h.fetchCalls.push({ url, init, body: JSON.parse(init.body) });
    return { status: 201, text: async () => JSON.stringify({ session: { id: `live_e_${++live}` }, transport: { type: "webrtc", sdp: "v=0 answer" } }) };
  });
  return h;
}

test("wake clip that is a voice sample the page just played is not the user", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive({ reason: "wake" });
  h.voice.handlePage({ type: "played", what: "sample", voice: "cedar" });
  h.voice.handlePage({ type: "wake_audio", session_id: h.voice.live.id, audio: wavB64(1200), clip_ms: 1200 });
  await h.clock.advance(0);
  const ins = ws.sent.filter((e) => e.type === "session.instructions.append");
  assert.match(ins[ins.length - 1].content, /Nothing intelligible was captured/);
  assert.equal(h.sse.filter((m) => m.type === "wake_heard").length, 0);
  assert.equal(h.log.find("wake.echo")[0].verdict, "echo");
  assert.equal(h.log.find("page.played")[0].voice, "cedar");
});

test("page echo reports are logged, kept for /status, and the guard mode reaches the page", async (t) => {
  const h = await harness(t);
  await h.goLive({ config: { echo_guard: "on" } });
  assert.equal(h.voice.pageStatus().echo_guard, "on");
  assert.equal(h.voice.status().config.echo_guard, "on");
  h.voice.handlePage({ type: "echo", kind: "leak", level: "high", leak_db: -12.345, corr: 0.9567, lag_ms: 46.7, output: "MacBook Pro Speakers", junk: "x".repeat(5000) });
  h.voice.handlePage({ type: "echo", kind: "guard", engaged: true, reason: "leak_high", mode: "auto" });
  const leak = h.log.find("echo.leak")[0];
  assert.deepEqual([leak.level, leak.leak_db, leak.corr, leak.lag_ms, leak.junk], ["high", -12.3, 0.96, 47, undefined]);
  assert.equal(h.log.find("echo.guard")[0].engaged, true);
  const st = h.voice.status();
  assert.equal(st.echo.leak.level, "high");
  assert.equal(st.echo.guard.reason, "leak_high");
  assert.equal(st.counters.echo_guard_on, 1);
});

test("SOTTO_ECHO_GUARD overrides the config (tests)", async (t) => {
  const h = await harness(t);
  h.voice.env = { ...h.voice.env, SOTTO_ECHO_GUARD: "off" };
  await h.goLive({ config: { echo_guard: "on" } });
  assert.equal(h.voice.pageStatus().echo_guard, "off");
});

test("mirror: the assistant's words heard back during double talk are cut, the user's reach Claude", async (t) => {
  const h = await harness(t);
  const ws = await h.goLive();
  let at = 1000;
  for (const w of "I'll run the whole test suite and then open the pull request".split(" ")) {
    ws.receive({ type: "session.output_transcript.delta", delta: " " + w, start_ms: at, end_ms: at + 200 });
    at += 200;
  }
  // The mic hears the assistant 300 ms late, and the user talks over it.
  const heard = [["I'll run the whole", 1300], ["actually wait", 2100], ["test suite and then", 2500], ["let's skip the lint step", 3300]];
  for (const [text, s] of heard) {
    let t0 = s;
    for (const w of text.split(" ")) { ws.receive({ type: "session.input_transcript.delta", delta: " " + w, start_ms: t0, end_ms: t0 + 200 }); t0 += 200; }
  }
  await h.clock.advance(MIRROR_QUIET_MS + 1500);
  const mirror = h.inboxSends.find((m) => /not delegated/.test(m.content));
  assert.ok(mirror, "mirrored");
  assert.match(mirror.content, /\(said to the voice assistant, not delegated\) actually wait let's skip the lint step/);
  assert.doesNotMatch(mirror.content.split("\n")[0], /test suite/);
  // The model heard itself: logged once, and the page learns it (its auto guard needs this evidence).
  assert.equal(h.log.find("echo.heard").length, 1);
  assert.equal(h.voice.status().counters.echo_heard, 1);
  assert.equal(typeof h.voice.pageStatus().echo_heard_ms_ago, "number");
});
