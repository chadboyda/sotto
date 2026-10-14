// Asleep never means silent (SPEC §6.15): a notify wake says the update and
// sleeps again, the earcon before it, "what did I miss?", the away hold and
// watches. Fake clock, fake WebSocket, a fake native link (no sockets).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "../helpers/daemon-harness.js";
import { FRAME_BYTES } from "../../daemon/native-proto.js";
import { NOTIFY_LINGER_MS, MIN_AWAKE_MS } from "../../daemon/wake.js";
import { UpdateLog, isRecapRequest, recapCommentary, recapSeedLine, RECAP_MAX, RECAP_ANSWER_MS } from "../../daemon/recap.js";
import { Watches, watchKeywords, WATCH_TTL_MS } from "../../daemon/watch.js";
import { earconPcm, EARCON_PEAK } from "../../daemon/earcon.js";
import { classifyLine } from "../../daemon/mirror.js";
import { relay } from "../../daemon/phrasing.js";
import { route } from "../../daemon/policy.js";
import { watchBody, bandLines } from "../../hooks/modcore.mjs";
import { createFakeClock } from "../helpers/fake-clock.js";

const OWNER = "/tmp/clv-owner-a.sock";
const appends = (ws, kind) => ws.sent.filter((e) => e.type === `session.${kind}.append`);
const HEADPHONES = { name: "AirPods", bluetooth: true, headphones: true };
const SPEAKERS = { name: "MacBook Pro Speakers", bluetooth: false, headphones: false };

function fakeLink(id = 1) {
  return {
    id, clientInfo: { version: "0.6.6", test: true }, sent: [], audio: [], closed: null, bufferedAmount: 0,
    sendJson(o) { this.sent.push(o); return true; },
    sendAudio(pcm, { flags = 0 } = {}) { this.audio.push({ pcm: Buffer.from(pcm), flags }); return true; },
    close(code, reason) { this.closed = { code, reason }; },
    of(type) { return this.sent.filter((m) => m.type === type); },
  };
}

/** The native path: the app attached, a primary session live; sleep() and startPrimary() as the app would. */
async function native(t, config = {}) {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  h.ctl = h.d.nativeCtl;
  h.on(undefined, { idle_seconds: 20, ...config });
  const link = fakeLink();
  h.ctl.attach(link, link.clientInfo);
  h.ctl.afterWelcome(link);
  await h.clock.advance(0);
  h.link = link;
  h.startPrimary = async () => {
    const end = Date.now() + 10_000;
    await h.clock.advance(0);
    while (!(h.WS.last() && h.WS.last().readyState === 0) && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 5));
      await h.clock.advance(0);
    }
    const ws = h.WS.last();
    ws.open();
    ws.receive({ type: "session.started", session: { id: `live_${h.WS.instances.length}`, expires_at: Math.floor(h.clock.now() / 1000) + 7200 } });
    await h.clock.advance(0);
    return ws;
  };
  h.sleep = async (ws) => {
    const p = h.voice.goToSleep("idle");
    h.closeReply(ws);
    await p;
    assert.equal(h.voice.state, "sleeping");
  };
  h.output = (device) => h.ctl.onMessage(link, { type: "output", device });
  h.ws = await h.startPrimary();
  return h;
}

// ---- notify wake: wake, say it, sleep again -------------------------------------------
test("a notify wake nobody answers says the update and sleeps again, nothing left pending", async (t) => {
  const h = await native(t);
  await h.sleep(h.ws);
  h.voice.handleHook("Stop", { prompt_id: "p_cont", last_assistant_message: "The deploy finished. All 13 services are up." }, OWNER);
  await h.clock.advance(4000); // speech queue + batch window
  assert.equal(h.log.find("wake.request").length, 1);
  const ws = await h.startPrimary();
  await h.clock.advance(2000);
  assert.match(appends(ws, "commentary").at(-1).content, /Your result from the terminal: The deploy finished\./);
  ws.receive({ type: "session.output_transcript.delta", delta: " The deploy's done, all thirteen up.", start_ms: 1, end_ms: 2 });
  assert.deepEqual(h.voice.pendingResults, []);
  assert.equal(h.voice.pendingResult, null);
  await h.clock.advance(NOTIFY_LINGER_MS - 2000);
  assert.equal(ws.sentOfType("session.close").length, 0, "time to answer it");
  await h.clock.advance(MIN_AWAKE_MS);
  assert.equal(ws.sentOfType("session.close").length, 1, "said, then back to sleep (well before the 20 s idle)");
  assert.equal(h.log.find("idle.close").at(-1).detail, "notify_done");
  assert.equal(h.voice.status().wake.false_wakes, 0);
});

test("a second update within 30 s of a notify wake wakes again (the first wake's watch is gone)", async (t) => {
  const h = await native(t);
  await h.sleep(h.ws);
  h.voice.notifyUser("First.");
  let ws = await h.startPrimary();
  await h.clock.advance(3000);
  await h.sleep(ws);
  h.voice.notifyUser("Second.");
  await h.clock.advance(3000); // the speech queue's gap after "First."
  assert.equal(h.log.find("wake.request").length, 2, "not taken for 'already asked'");
  ws = await h.startPrimary();
  await h.clock.advance(3000);
  assert.equal(appends(ws, "commentary").at(-1).content, "Second.");
  await h.clock.advance(30_000);
  assert.equal(h.log.find("wake.request_timeout").length, 0);
});

// ---- earcon -----------------------------------------------------------------------------
test("earcon: a soft two-note chime, about a third of a second, well under the voice", () => {
  const pcm = earconPcm();
  const n = pcm.length / 2;
  assert.ok(n / 24000 > 0.25 && n / 24000 < 0.45, `${n / 24000} s`);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i * 2)));
  assert.ok(peak > 500 && peak <= EARCON_PEAK, `peak ${peak}`);
  assert.equal(pcm.readInt16LE(0), 0, "starts from silence (no click)");
});

test("earcon: the app plays it before an unprompted update, not before a voice wake; off in prefs turns it off", async (t) => {
  const h = await native(t);
  await h.sleep(h.ws);
  h.voice.notifyUser("Tests passed.");
  let ws = await h.startPrimary();
  assert.equal(h.log.find("earcon.play").length, 1);
  // Mixed into the session's own (here silent) speaker stream as it plays: no extra frames.
  const n0 = h.link.audio.length;
  h.ctl.onSessionAudio(h.voice.sideband, Buffer.alloc(24000)); // 0.5 s of model silence
  const frames = h.link.audio.slice(n0);
  assert.equal(frames.length, 25, "one speaker frame per 20 ms of model audio");
  const peakOf = (f) => { let p = 0; for (let i = 0; i < f.pcm.length; i += 2) p = Math.max(p, Math.abs(f.pcm.readInt16LE(i))); return p; };
  assert.ok(frames.slice(0, 15).some((f) => peakOf(f) > 500), "the chime is in the first frames");
  assert.equal(peakOf(frames.at(-1)), 0, "and over after a third of a second");
  await h.clock.advance(3000);
  assert.equal(appends(ws, "commentary").at(-1).content, "Tests passed.");
  await h.sleep(ws);
  // The user woke it by speaking: no chime.
  await h.voice.startNativeSession("wake");
  ws = await h.startPrimary();
  assert.equal(h.log.find("earcon.play").length, 1);
  await h.sleep(ws);
  // Turned off (/talk earcon off, sotto earcon off, the app's Settings).
  assert.equal(h.voice.control({ action: "earcon", on: false }).message.includes("earcon off"), true);
  assert.equal(h.voice.pageStatus().earcon, false);
  h.voice.notifyUser("Build failed.");
  await h.startPrimary();
  assert.equal(h.log.find("earcon.play").length, 1, "no chime when off");
});

test("earcon: the app's set_earcon command persists the setting", async (t) => {
  const h = await native(t);
  const r = await h.ctl.runCommand("set_earcon", { on: false });
  assert.equal(r.ok, true);
  assert.equal(r.data.on, false);
  assert.equal(h.voice.earconEnabled(), false);
  await h.ctl.runCommand("set_earcon", { on: true });
  assert.equal(h.voice.earconEnabled(), true);
});

// ---- away hold --------------------------------------------------------------------------
test("away: no output device → the update is held (no wake), offered as 'while you were away' when one returns", async (t) => {
  const h = await native(t);
  h.output(HEADPHONES);
  await h.sleep(h.ws);
  h.output(null);
  assert.equal(h.voice.outputAway(), true);
  h.voice.notifyUser("The deploy finished.");
  h.voice.notifyUser("The tests passed.");
  await h.clock.advance(5000);
  assert.equal(h.log.find("wake.request").length, 0, "nobody to hear it: no wake");
  assert.equal(h.log.find("away.hold").length, 2);
  assert.equal(h.voice.awayCount(), 2);
  assert.equal(h.voice.modUiState().away, 2);
  assert.match(bandLines(h.voice.modUiState(), 120)[1], /while you were away: 2 updates waiting/);
  h.output(HEADPHONES); // the headphones are back
  assert.equal(h.log.find("wake.request").length, 1);
  const ws = await h.startPrimary();
  await h.clock.advance(3000);
  const said = appends(ws, "commentary").map((e) => e.content);
  assert.equal(said.length, 1, "one update for everything held");
  assert.equal(said[0], relay("away", "The deploy finished. The tests passed."));
  assert.equal(h.voice.awayCount(), 0);
});

test("away: headphones removed while asleep (laptop speakers left) hold too; a voice wake says what waited", async (t) => {
  const h = await native(t);
  h.output(HEADPHONES);
  await h.sleep(h.ws);
  h.output(SPEAKERS);
  assert.equal(h.voice.outputAway(), true, "the headphones the user listened on were taken off");
  h.voice.notifyUser("The deploy finished.");
  await h.clock.advance(5000);
  assert.equal(h.log.find("wake.request").length, 0);
  // The user talks to it on the speakers: they are there.
  await h.voice.startNativeSession("wake");
  const ws = await h.startPrimary();
  await h.clock.advance(3000);
  assert.match(appends(ws, "commentary").at(-1).content, /^While the user was away[\s\S]*The deploy finished\./);
  assert.equal(h.voice.outputAway(), false);
});

test("away: speakers only from the start (no headphones ever) is not away; the page path never is", async (t) => {
  const h = await native(t);
  h.output(SPEAKERS);
  await h.sleep(h.ws);
  assert.equal(h.voice.outputAway(), false);
  h.voice.notifyUser("Done.");
  assert.equal(h.log.find("wake.request").length, 1);
});

// ---- on-a-call hold (opt-in) ------------------------------------------------------------
test("call hold: off by default, another app on the mic changes nothing", async (t) => {
  const h = await native(t);
  await h.sleep(h.ws);
  h.ctl.onMessage(h.link, { type: "mic_busy", busy: true, apps: ["us.zoom.xos"] });
  assert.equal(h.voice.onCall(), false);
  assert.equal(h.voice.pageStatus().call_hold, false);
  h.voice.notifyUser("The deploy finished.");
  assert.equal(h.log.find("wake.request").length, 1);
});

test("call hold on: updates wait while another app has the mic, then 'While you were on your call'", async (t) => {
  const h = await native(t);
  assert.match(h.voice.control({ action: "callhold", on: true }).message, /^sotto: call hold on/);
  assert.equal(h.voice.pageStatus().call_hold, true);
  await h.sleep(h.ws);
  h.ctl.onMessage(h.link, { type: "mic_busy", busy: true, apps: ["us.zoom.xos"] });
  assert.equal(h.voice.onCall(), true);
  assert.equal(h.voice.pageStatus().on_call, true);
  h.voice.notifyUser("The deploy finished.");
  h.voice.notifyUser("Tests passed.");
  await h.clock.advance(5000);
  assert.equal(h.log.find("wake.request").length, 0, "no wake during the call");
  assert.equal(h.log.find("call.hold").length, 2);
  assert.match(bandLines(h.voice.modUiState(), 120)[1], /on a call: 2 updates waiting, said when it ends/);
  h.ctl.onMessage(h.link, { type: "mic_busy", busy: false, apps: [] });
  assert.equal(h.log.find("wake.request").length, 1, "the call ended: say them");
  const ws = await h.startPrimary();
  await h.clock.advance(3000);
  assert.deepEqual(appends(ws, "commentary").map((e) => e.content), [relay("call", "The deploy finished. Tests passed.")]);
});

test("call hold: turning it off mid-call says what waited; the call's own speech never voice-wakes", async (t) => {
  const h = await native(t);
  h.voice.setCallHold(true);
  await h.sleep(h.ws);
  h.ctl.onMessage(h.link, { type: "mic_busy", busy: true, apps: ["com.apple.FaceTime"] });
  h.voice.notifyUser("Build failed.");
  assert.equal(h.log.find("wake.request").length, 0);
  // A loud wake trigger during the call does not open a session.
  h.ctl.wake = { vad: { samples: 48000 }, rec: { startCapture() {} }, near: 0, sensitivity: "medium" };
  h.ctl.onWakeTrigger({ onsetSample: 0, voicedMs: 600, snrDb: 30, db: -20, floorDb: -70 });
  assert.equal(h.log.find("wake.trigger").length, 0);
  h.voice.setCallHold(false);
  assert.equal(h.log.find("wake.request").length, 1);
});

// ---- what did I miss? -------------------------------------------------------------------
test("recap: requests are recognized, and are no mirror to Claude", () => {
  for (const s of ["What did I miss?", "so what did I miss", "Catch me up.", "Any updates?", "what's new", "What happened while I was away?", "give me a recap"]) {
    assert.ok(isRecapRequest(s), s);
    assert.equal(classifyLine(s), "recap", s);
  }
  for (const s of ["run the tests", "what did the deploy log say about the missing env var", "Hello?"]) assert.ok(!isRecapRequest(s), s);
});

test("recap: the log keeps the last 20 updates' words (no relay frame), with times", () => {
  const log = new UpdateLog();
  for (let i = 0; i < RECAP_MAX + 5; i++) log.add(relay("typed", `Update ${i}.`), 1000 * i, "typed_result");
  assert.equal(log.size, RECAP_MAX);
  assert.equal(log.recent(1)[0].text, `Update ${RECAP_MAX + 4}.`);
  assert.equal(log.recent()[0].text, "Update 5.");
  log.add(relay("typed", `Update ${RECAP_MAX + 4}.`), 99_000, "typed_result");
  assert.equal(log.size, RECAP_MAX, "the same update twice is one");
  assert.match(recapSeedLine(log.recent(2)), /^Updates already told to the user, oldest first[\s\S]*Update 23\.[\s\S]*Update 24\./);
  assert.match(recapCommentary(log.recent()), /^The user asked what they missed\.[\s\S]*Your result from the terminal: [\s\S]*Update 24\./);
  assert.match(recapCommentary([]), /Nothing new has come in/);
});

test("recap: spoken updates seed the next session; an unanswered 'what did I miss?' gets the recap", async (t) => {
  const h = await native(t);
  h.voice.handleHook("Stop", { prompt_id: "p_cont", last_assistant_message: "The deploy finished. All 13 services are up." }, OWNER);
  await h.clock.advance(3000);
  assert.equal(h.voice.updates.size, 1);
  await h.sleep(h.ws);
  await h.voice.startNativeSession("wake");
  const ws = await h.startPrimary();
  const seed = h.WS.last().sent.find((e) => e.type === "session.start")?.session.input[0].content[0].text || "";
  assert.match(seed, /Updates already told to the user[\s\S]*The deploy finished\./);
  // "What did I miss?" heard live, the voice says nothing and delegates nothing.
  ws.receive({ type: "session.input_transcript.delta", delta: " What did I miss?", start_ms: 1000, end_ms: 1600 });
  await h.clock.advance(8000 + RECAP_ANSWER_MS);
  const c = appends(ws, "commentary").at(-1);
  assert.ok(c, h.log.find("recap.asked").length ? "asked but not answered" : "never asked");
  assert.match(c.content, /^The user asked what they missed\.[\s\S]*The deploy finished\./);
  assert.equal(h.inboxSends.length, 0, "not sent to Claude");
});

test("recap: the voice answered it itself → no second recap", async (t) => {
  const h = await native(t);
  h.voice.notifyUser("Tests passed.");
  await h.clock.advance(3000);
  const n = appends(h.ws, "commentary").length;
  h.ws.receive({ type: "session.input_transcript.delta", delta: " Catch me up.", start_ms: 1000, end_ms: 1600 });
  await h.clock.advance(1600);
  h.ws.receive({ type: "session.output_transcript.delta", delta: " Just that the tests passed.", start_ms: 2000, end_ms: 2400 });
  await h.clock.advance(RECAP_ANSWER_MS + 1000);
  assert.equal(appends(h.ws, "commentary").length, n);
});

// ---- watches ----------------------------------------------------------------------------
test("watch: keywords from the description, or the ones Claude gave", () => {
  assert.deepEqual(watchKeywords("tell me when the deploy finishes"), ["deploy"]);
  assert.deepEqual(watchKeywords("the nightly build is done"), ["nightly", "build"]);
  assert.deepEqual(watchKeywords("the migration", ["migrations"]), ["migration"]);
});

test("watch: fires on a later result that names it and says it ended; never on the turn that set it; expires", async () => {
  const clock = createFakeClock();
  const w = new Watches({ clock });
  const a = w.add({ description: "the deploy finishes", duringTurn: true });
  assert.equal(w.match("I'll tell you when the deploy finishes."), null, "the turn that set it");
  w.turnEnded();
  assert.equal(w.match("The deploy is still rolling out: 10 of 13 services."), null, "named, not ended");
  assert.equal(w.match("Tests passed."), null, "ended, not named");
  assert.equal(w.match("The deploy finished: all 13 services are up."), a);
  assert.equal(w.add({ description: "The deploy finishes" }), a, "the same watch twice is one");
  await clock.advance(WATCH_TTL_MS + 1);
  assert.deepEqual(w.active(), []);
});

test("watch: a matching result is spoken under quiet, wakes a sleeping voice, and clears the watch", async (t) => {
  const h = await native(t, { speaking_policy: "quiet" });
  h.voice.handleHook("UserPromptSubmit", { prompt: "tell me when the deploy finishes", prompt_id: "p1" }, OWNER);
  const r = h.voice.control({ action: "watch", op: "add", description: "the deploy finishes", via: "cli" });
  assert.equal(r.ok, true);
  assert.match(r.message, /watching for "the deploy finishes" \(w1\)/);
  assert.match(h.voice.statusMessage(), /watching: "the deploy finishes"/);
  assert.deepEqual(h.voice.status().watches.map((w) => w.description), ["the deploy finishes"]);
  assert.equal(h.voice.modUiState().watching, 1);
  h.voice.handleHook("Stop", { prompt_id: "p1", last_assistant_message: "Okay, I'll tell you when the deploy finishes." }, OWNER);
  await h.clock.advance(3000);
  const n = appends(h.ws, "commentary").length;
  assert.equal(h.voice.watches.list.length, 1, "the turn that set it does not fire it");
  await h.sleep(h.ws);
  h.voice.handleHook("UserPromptSubmit", { prompt: "<task-notification>\n<task-id>t</task-id>\n<tool-use-id>toolu_D</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>", prompt_id: "p2" }, OWNER);
  h.voice.handleHook("Stop", { prompt_id: "p2", last_assistant_message: "The deploy finished: all 13 services are up." }, OWNER);
  await h.clock.advance(1000);
  assert.equal(h.log.find("watch.fire").length, 1);
  assert.equal(h.log.find("wake.request").length, 1, "a watch wakes at once, even under quiet");
  const ws = await h.startPrimary();
  await h.clock.advance(3000);
  assert.equal(appends(h.ws, "commentary").length, n);
  assert.match(appends(ws, "commentary").at(-1).content, /^The user asked to be told when this happens: "the deploy finishes"\. It just did\.[\s\S]*all 13 services are up/);
  assert.deepEqual(h.voice.watches.active(), []);
  assert.doesNotMatch(h.voice.statusMessage(), /watching/);
});

test("watch: Claude marks it done mid-turn → the turn's result is the one spoken update; done while idle speaks at once", async (t) => {
  const h = await native(t, { speaking_policy: "quiet" });
  h.voice.control({ action: "watch", op: "add", description: "the nightly build is done" });
  h.voice.handleHook("UserPromptSubmit", { prompt: "<task-notification>\n<task-id>t</task-id>\n<tool-use-id>toolu_N</tool-use-id>\n<status>completed</status>\n<summary>x</summary>\n</task-notification>", prompt_id: "p3" }, OWNER);
  h.voice.handleHook("PreToolUse", { prompt_id: "p3", tool_name: "mcp__sotto__watch", tool_use_id: "toolu_w", tool_input: { op: "done" } }, OWNER);
  assert.equal(h.voice.control({ action: "watch", op: "done", id: "w1", text: "The nightly build is green." }).ok, true);
  const n = appends(h.ws, "commentary").length;
  h.voice.handleHook("Stop", { prompt_id: "p3", last_assistant_message: "The nightly build passed, nothing failed." }, OWNER);
  await h.clock.advance(3000);
  const said = appends(h.ws, "commentary").slice(n).map((e) => e.content);
  assert.equal(said.length, 1);
  assert.match(said[0], /"the nightly build is done"\. It just did\.[\s\S]*The nightly build passed/);
  // Idle: spoken now, with Claude's sentence.
  h.voice.control({ action: "watch", op: "add", description: "the backup finishes" });
  h.voice.control({ action: "watch", op: "done", id: "the backup finishes", text: "The backup finished at 2 GB." });
  await h.clock.advance(3000);
  assert.match(appends(h.ws, "commentary").at(-1).content, /"the backup finishes"[\s\S]*The backup finished at 2 GB\./);
  assert.equal(h.voice.control({ action: "watch", op: "list" }).message, "sotto: no watches.");
});

test("watch: list and clear; off clears them; no voice → refused", async (t) => {
  const h = await native(t);
  h.voice.control({ action: "watch", description: "the deploy finishes" });
  h.voice.control({ action: "watch", description: "the tests pass" });
  assert.match(h.voice.control({ action: "watch" }).message, /w1 "the deploy finishes", w2 "the tests pass"/);
  assert.match(h.voice.control({ action: "watch", op: "clear", id: "w1" }).message, /cleared the watch for "the deploy finishes"/);
  h.voice.off("user");
  await h.clock.advance(20_000);
  assert.equal(h.voice.watches.list.length, 0);
  assert.equal(h.voice.control({ action: "watch", description: "x" }).ok, false);
});

test("watch: route under every policy; the mod's tool body", () => {
  for (const p of ["quiet", "milestones", "walkthrough"]) {
    const a = route("watch", p, { text: "Merged. CI is green.", watch: "the PR merges" });
    assert.equal(a[0].kind, "commentary", p);
  }
  assert.deepEqual(watchBody({ tool: "mcp__sotto__watch", description: "  the deploy\nfinishes ", keywords: ["deploy", 3] }, "/s.sock"),
    { action: "watch", op: "add", via: "cli", session: { socket: "/s.sock" }, description: "the deploy finishes", keywords: ["deploy"] });
  assert.deepEqual(watchBody({ tool: "mcp__sotto__watch", input: { op: "done", id: "w1", text: "Done." } }, "/s.sock"),
    { action: "watch", op: "done", via: "cli", session: { socket: "/s.sock" }, id: "w1", text: "Done." });
  assert.equal(watchBody({}, "/s").op, "list");
  assert.match(bandLines({ state: "sleeping", persona: "vela", voice: "willow", watching: 2 }, 120)[0], /watching 2/);
});
