// Self-update, voice side (SPEC §6.17): when it is quiet enough to restart,
// what the old daemon hands over, and how the successor resumes (fake clock,
// in-process daemons; the process swap itself is test/daemon/handover.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHarness, SESSION } from "../helpers/daemon-harness.js";
import { CHECK_MS, SETTLE_MS, QUIET_MS } from "../../daemon/update.js";
import { updateGreeting } from "../../daemon/prompt.js";

const appends = (ws, kind) => ws.sent.filter((e) => e.type === `session.${kind}.append`);
const say = (ws, role, text) => ws.receive({ type: `session.${role === "user" ? "input" : "output"}_transcript.delta`, delta: text, start_ms: 0, end_ms: 1 });

test("restartBlocker: live needs 45 s of silence both ways; delegation, busy Claude and queued speech block", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  assert.equal(h.voice.restartBlocker(QUIET_MS), "no_owner");
  h.on();
  assert.equal(h.voice.restartBlocker(QUIET_MS), "state_waiting_page");
  const ws = await h.goLive();
  assert.equal(h.voice.restartBlocker(QUIET_MS), "recent_speech", "just started");
  await h.clock.advance(QUIET_MS);
  // The greeting append counts as activity; nobody spoke since.
  assert.equal(h.voice.restartBlocker(QUIET_MS), null);
  say(ws, "user", " hello there");
  assert.equal(h.voice.restartBlocker(QUIET_MS), "recent_speech");
  await h.clock.advance(QUIET_MS - 1000);
  assert.equal(h.voice.restartBlocker(QUIET_MS), "recent_speech");
  await h.clock.advance(1000);
  assert.equal(h.voice.restartBlocker(QUIET_MS), null);
  say(ws, "assistant", " sure");
  assert.equal(h.voice.restartBlocker(QUIET_MS), "speaking");
  await h.clock.advance(QUIET_MS);
  h.voice.handlePage({ type: "activity" }); // the page hears the user locally
  assert.equal(h.voice.restartBlocker(QUIET_MS), "recent_speech");
  await h.clock.advance(QUIET_MS);
  assert.equal(h.voice.restartBlocker(QUIET_MS), null);
  // A voice request being collected, then with Claude.
  ws.receive({ type: "session.delegation.created", offset_ms: 0, delegation: { id: "item_1", type: "delegation", target: "client" } });
  assert.equal(h.voice.restartBlocker(0), "delegation");
  // Claude mid-turn from the terminal (no voice request).
  const h2 = await makeHarness();
  t.after(() => h2.cleanup());
  await h2.goLive();
  await h2.clock.advance(QUIET_MS);
  h2.voice.handleHook("UserPromptSubmit", { prompt: "typed", prompt_id: "p1" }, SESSION().socket);
  h2.voice.handleHook("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, prompt_id: "p1" }, SESSION().socket);
  assert.equal(h2.voice.restartBlocker(0), "claude_busy");
  h2.voice.handleHook("Stop", { prompt_id: "p1", last_assistant_message: "done" }, SESSION().socket);
  await h2.clock.advance(0);
  assert.notEqual(h2.voice.restartBlocker(0), "claude_busy");
});

test("restartBlocker: sleeping and paused are quiet at once", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  const p = h.voice.pause("pause");
  h.closeReply(ws);
  await p;
  assert.equal(h.voice.state, "paused");
  assert.equal(h.voice.restartBlocker(QUIET_MS), null);
  h.voice.setState("sleeping");
  assert.equal(h.voice.restartBlocker(QUIET_MS), null);
});

test("auto: a code change restarts only once the live conversation has been quiet for 45 s", async (t) => {
  const restarts = [];
  const h = await makeHarness({ onRestart: async (r) => { restarts.push({ ...r, state: h.voice.state, at: h.clock.now() }); return { ok: true }; } });
  t.after(() => h.cleanup());
  const ws = await h.goLive({ config: { idle_seconds: 0 } }); // no idle sleep: the live path is what is tested
  fs.appendFileSync(path.join(h.pluginRoot, "web", "app.js"), "// new\n");
  // Keep talking every 20 s: never quiet for 45 s.
  for (let i = 0; i < 6; i++) { await h.clock.advance(20_000); say(ws, i % 2 ? "assistant" : "user", ` line ${i}`); }
  assert.ok(h.log.find("update.detected").length === 1);
  assert.equal(restarts.length, 0, "never mid-conversation");
  const lastSpeech = h.clock.now();
  await h.clock.advance(QUIET_MS + 2000);
  assert.equal(restarts.length, 1);
  assert.equal(restarts[0].reason, "update");
  assert.equal(restarts[0].state, "live");
  assert.ok(restarts[0].at - lastSpeech >= QUIET_MS, `${restarts[0].at - lastSpeech} ms after the last speech`);
});

test("auto: a voice request with Claude holds the restart until it is answered and the talk goes quiet", async (t) => {
  const restarts = [];
  const h = await makeHarness({ onRestart: async (r) => { restarts.push(r); return { ok: true }; } });
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  ws.receive({ type: "session.delegation.created", offset_ms: 0, delegation: { id: "item_1", type: "delegation", target: "client" } });
  say(ws, "user", " can you list the files");
  await h.clock.advance(1000); // settles and goes to Claude
  assert.equal(h.inboxSends.length, 1);
  fs.appendFileSync(path.join(h.pluginRoot, "web", "app.js"), "// new\n");
  await h.clock.advance(CHECK_MS + SETTLE_MS + QUIET_MS * 2);
  assert.equal(restarts.length, 0, "a voice request is with Claude");
  assert.equal(h.log.find("update.waiting").at(-1).why, "delegation");
  // Claude answers; the answer is spoken; then quiet.
  h.voice.handleHook("UserPromptSubmit", { prompt: h.inboxSends[0].content, prompt_id: "p1" }, SESSION().socket);
  h.voice.handleHook("Stop", { prompt_id: "p1", last_assistant_message: "Three files." }, SESSION().socket);
  await h.clock.advance(0);
  say(ws, "assistant", " There are three files.");
  await h.clock.advance(QUIET_MS + 2000);
  assert.equal(restarts.length, 1);
});

test("/talk restart: messages for off, now and waiting", async (t) => {
  const restarts = [];
  const h = await makeHarness({ onRestart: async (r) => { restarts.push(r); return { ok: true }; } });
  t.after(() => h.cleanup());
  assert.equal(h.voice.control({ action: "restart" }).message, "sotto: voice is off. The next /talk on starts the latest code.");
  const ws = await h.goLive();
  say(ws, "user", " hi");
  assert.equal(h.voice.control({ action: "restart" }).message, "sotto: the voice daemon restarts at the next pause (waiting for the conversation).");
  await h.clock.advance(4000);
  assert.equal(restarts.length, 1);
  assert.equal(restarts[0].reason, "manual");

  const plain = await makeHarness(); // no process to swap to (tests, SOTTO_UPDATE=0 paths)
  t.after(() => plain.cleanup());
  plain.on();
  assert.match(plain.voice.control({ action: "restart" }).message, /^sotto: restart is turned off/);
});

test("prepareRestart closes the live session (page keeps its mic) and blocks new sessions", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  const p = h.voice.prepareRestart("update");
  assert.deepEqual(h.commands(), ["disconnect:update"]);
  assert.equal(ws.sentOfType("session.close").length, 1);
  h.closeReply(ws, "close_requested", 20);
  const prep = await p;
  assert.deepEqual(prep, { resume: "live", reason: "update" });
  const r = await h.voice.createSession({ sdp: "v=0", reason: "reconnect" });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, "restarting");
  assert.equal(h.voice.status().today.seconds, 20, "usage booked before the swap");
  // Failure: carry on, reconnect in this process.
  h.voice.abortRestart(prep);
  assert.equal(h.voice.state, "reconnecting");
  assert.ok(h.commands().includes("reconnect:update_failed"));
  assert.ok(h.sse.some((m) => m.type === "notice" && m.code === "update_failed"));
});

test("handover: the successor resumes the owner, marker, key and conversation, and says it updated", async (t) => {
  const a = await makeHarness();
  t.after(() => a.cleanup());
  const ws = await a.goLive();
  say(ws, "user", " what branch am I on");
  await a.clock.advance(2000);
  say(ws, "assistant", " You are on main.");
  await a.clock.advance(QUIET_MS);
  const activeBefore = fs.readFileSync(path.join(a.dataDir, "active"), "utf8");
  const p = a.voice.prepareRestart("update");
  a.closeReply(ws);
  const snap = a.voice.snapshot(await p);
  assert.equal(snap.resume, "live");
  assert.equal(snap.owner.token, "inbox-token-a", "the token travels in memory (stdin pipe), never to disk");
  assert.deepEqual(snap.history.map((l) => l.role), ["user", "assistant"]);

  // Successor: same data dir, same daemon key and page token (as main() passes them).
  const b = await makeHarness({ dataDir: a.dataDir, daemonKey: a.d.daemonKey, pageToken: a.d.pageToken, port: a.port });
  t.after(() => b.cleanup());
  assert.equal(b.voice.restore(JSON.parse(JSON.stringify(snap))), true);
  assert.equal(fs.readFileSync(path.join(a.dataDir, "active"), "utf8"), activeBefore, "hooks keep working: same socket, port, key, nonce");
  assert.equal(b.voice.state, "reconnecting");
  assert.equal(b.voice.owner.socket, SESSION().socket);
  assert.ok(b.commands().includes("reconnect:update"));
  // The page comes back: toast on hello, then it reconnects.
  b.voice.handlePage({ type: "hello" });
  assert.ok(b.sse.some((m) => m.type === "notice" && m.code === "updated" && m.text === "Sotto updated itself to the latest code."));
  const r = await b.voice.createSession({ sdp: "v=0 offer", reason: "reconnect" });
  assert.equal(r.status, 201);
  const seed = JSON.stringify(b.fetchCalls.at(-1).body);
  assert.match(seed, /what branch am I on/);
  assert.match(seed, /You are on main/);
  const ws2 = b.WS.last();
  ws2.open();
  ws2.receive({ type: "session.started", session: { id: r.body.session_id, expires_at: Math.floor(b.clock.now() / 1000) + 7200 } });
  const ins = appends(ws2, "instructions").map((e) => e.content);
  assert.deepEqual(ins, [updateGreeting()], "spoken once, because the user was awake");
  // A voice request in the new process reaches the same owner with the same marker.
  ws2.receive({ type: "session.delegation.created", offset_ms: 0, delegation: { id: "item_9", type: "delegation", target: "client" } });
  say(ws2, "user", " run the tests");
  await b.clock.advance(1000);
  assert.equal(b.inboxSends.length, 1);
  assert.equal(b.inboxSends[0].token, "inbox-token-a");
  assert.match(b.inboxSends[0].content, new RegExp(`^\\[sotto voice ${snap.nonce}\\]`));
});

test("handover from sleeping: stays asleep, toast only, no spoken cue on the next wake", async (t) => {
  const a = await makeHarness();
  t.after(() => a.cleanup());
  const ws = await a.goLive();
  const p = a.voice.pause("idle", { sleep: true });
  a.closeReply(ws);
  await p;
  assert.equal(a.voice.state, "sleeping");
  a.chrome.appLaunched = true; // the desktop app hosts the page
  const snap = a.voice.snapshot(await a.voice.prepareRestart("manual"));
  assert.equal(snap.window_app, true);
  const b = await makeHarness({ dataDir: a.dataDir, daemonKey: a.d.daemonKey, pageToken: a.d.pageToken });
  t.after(() => b.cleanup());
  let adopted = false;
  b.chrome.adoptApp = () => { adopted = true; };
  b.voice.restore(snap);
  assert.ok(adopted, "the successor can still close the app on /talk off");
  assert.equal(b.voice.state, "sleeping");
  assert.deepEqual(b.commands(), [], "nothing asks the page to connect");
  b.voice.handlePage({ type: "hello" });
  assert.ok(b.sse.some((m) => m.type === "notice" && m.code === "updated" && m.text === "Sotto restarted."));
  const r = await b.voice.createSession({ sdp: "v=0 offer", reason: "wake" });
  const ws2 = b.WS.last();
  ws2.open();
  ws2.receive({ type: "session.started", session: { id: r.body.session_id, expires_at: Math.floor(b.clock.now() / 1000) + 7200 } });
  assert.ok(!appends(ws2, "instructions").some((e) => e.content === updateGreeting()));
});

test("restore refuses a snapshot without an owner", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  assert.equal(h.voice.restore({ resume: "live", owner: null }), false);
  assert.equal(h.voice.restore(null), false);
  assert.equal(h.voice.state, "off");
});

test("auto: while sleeping, the restart happens as soon as the change has settled", async (t) => {
  const restarts = [];
  const h = await makeHarness({ onRestart: async (r) => { restarts.push({ ...r, state: h.voice.state }); return { ok: true }; } });
  t.after(() => h.cleanup());
  h.d.sse.clients.add({ write() {}, end() {} }); // a page listening for the wake
  const ws = await h.goLive();
  const p = h.voice.pause("idle", { sleep: true });
  h.closeReply(ws);
  await p;
  const t0 = h.clock.now();
  fs.appendFileSync(path.join(h.pluginRoot, "web", "app.js"), "// new\n");
  await h.clock.advance(CHECK_MS + SETTLE_MS);
  assert.equal(restarts.length, 1);
  assert.equal(restarts[0].state, "sleeping");
  assert.ok(h.clock.now() - t0 <= CHECK_MS + SETTLE_MS);
});
