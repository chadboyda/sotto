import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHarness, SESSION } from "../helpers/daemon-harness.js";
import { createFakeKeychain } from "../helpers/fake-keychain.js";

const appends = (ws, kind) => ws.sent.filter((e) => e.type === `session.${kind}.append`);

test("on: binds owner, writes active (0600), opens the window, waits for the page", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const r = h.on();
  assert.deepEqual(r, { ok: true, state: "waiting_page", message: "sotto: voice ON (proj-a). Opening the voice window." });
  assert.equal(h.chrome.opened, 1);
  const active = path.join(h.dataDir, "active");
  assert.equal(fs.readFileSync(active, "utf8"), `/tmp/clv-owner-a.sock\t${h.port}\t${h.d.daemonKey}\t${h.voice.nonce}\n`);
  assert.match(h.voice.nonce, /^[0-9a-f]{12}$/, "per-bind marker nonce for hook.sh");
  assert.equal(fs.statSync(active).mode & 0o777, 0o600);
  const st = h.voice.status();
  assert.equal(st.owner.project, "proj-a");
  assert.ok(!JSON.stringify(st).includes("inbox-token-a"), "token never in status");
  assert.ok(!JSON.stringify(h.voice.pageStatus()).includes("clv-owner-a.sock"), "socket never in page status");
});

test("on with a connected page sends SSE connect instead of opening a window", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  h.d.sse.clients.add({ write() {}, end() {} }); // pretend a page is connected
  const r = h.on();
  assert.equal(r.message, "sotto: voice ON (proj-a).");
  assert.equal(h.chrome.opened, 0);
  assert.deepEqual(h.commands(), ["connect:on"]);
});

test("page timeout after 30 s in waiting_page", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  h.on();
  await h.clock.advance(30000);
  assert.equal(h.voice.status().last_error.code, "page_timeout");
  assert.deepEqual(h.chrome.notified, ["Voice window did not connect"]);
});

test("createSession → connecting → live; greeting sent once", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  h.on();
  const r = await h.voice.createSession({ sdp: "v=0 offer", reason: "start" });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { session_id: "live_test_1", sdp: "v=0 answer" });
  assert.equal(h.voice.state, "connecting");
  const body = h.fetchCalls[0].body;
  assert.equal(body.session.audio.output.voice, "marin");
  assert.match(body.session.input[0].content[0].text, /Project: proj-a {3}Folder: proj-a {3}Git branch: main/);
  assert.match(body.session.instructions, /Update preference: Milestones/);
  assert.equal(h.voice.counters.sessions_created, 1);
  const ws = h.WS.last();
  assert.equal(ws.url, "wss://api.openai.com/v1/live/sessions/live_test_1/attach");
  ws.open();
  ws.receive({ type: "session.started", session: {} });
  assert.equal(h.voice.live.expires_at, Math.floor(h.voice.live.started_at / 1000) + 7200);
  assert.equal(h.voice.state, "live");
  const g = appends(ws, "instructions");
  assert.equal(g.length, 1);
  assert.match(g[0].content, /Greet the user in one short sentence.*proj-a/);
  // A re-attach (new ready) does not greet again.
  ws.serverClose(1006);
  await h.clock.advance(1000);
  h.WS.last().open();
  await h.clock.advance(2000);
  assert.equal(appends(h.WS.last(), "instructions").length, 0);
});

test("createSession error codes", async (t) => {
  const h = await makeHarness({ env: {} });
  t.after(() => h.cleanup());
  assert.equal((await h.voice.createSession({ sdp: "" })).body.error.code, "bad_sdp");
  assert.equal((await h.voice.createSession({ sdp: "x" })).status, 409);
  h.on();
  const nk = await h.voice.createSession({ sdp: "x" });
  assert.deepEqual([nk.status, nk.body.error.code], [503, "no_api_key"]);
});

test("createSession maps OpenAI failures and pauses", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  h.on();
  for (const [status, code] of [[401, "openai_auth"], [429, "openai_rate_limit"], [500, "openai_error"]]) {
    h.setFetch(async () => ({ status, text: async () => "{}" }));
    const r = await h.voice.createSession({ sdp: "x" });
    assert.deepEqual([r.status, r.body.error.code], [502, code]);
    assert.equal(h.voice.state, "paused");
    assert.equal(h.voice.status().last_error.code, code);
  }
  assert.ok(h.sse.some((m) => m.type === "notice" && m.code === "openai_auth"));
});

test("idle close after idle_minutes of silence", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive({ config: { idle_minutes: 1 } });
  await h.clock.advance(45000);
  assert.equal(ws.sentOfType("session.close").length, 0);
  await h.clock.advance(15000); // tick at 60 s
  assert.equal(ws.sentOfType("session.close").length, 1);
  h.closeReply(ws, "close_requested", 60);
  await h.clock.advance(0);
  assert.equal(h.voice.state, "paused");
  assert.deepEqual(h.commands(), ["disconnect:idle"]);
  assert.equal(h.voice.status().today.seconds, 60);
  assert.ok(h.log.find("idle.close").length === 1);
});

test("no idle close while a delegation is collecting", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive({ config: { idle_minutes: 1 } });
  await h.clock.advance(59000);
  ws.receive({ type: "session.delegation.created", offset_ms: 100, delegation: { id: "item_1", type: "delegation", target: "client" } });
  h.clock.set(h.clock.now() + 120000); // jump without firing timers
  h.voice.idleTick();
  assert.equal(ws.sentOfType("session.close").length, 0);
  assert.equal(h.voice.state, "live");
});

test("user speech and page activity keep the session alive", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive({ config: { idle_minutes: 1 } });
  await h.clock.advance(40000);
  ws.receive({ type: "session.input_transcript.delta", delta: " hmm", start_ms: 1, end_ms: 2 });
  await h.clock.advance(40000);
  h.voice.handlePage({ type: "activity" });
  await h.clock.advance(40000);
  assert.equal(ws.sentOfType("session.close").length, 0);
});

test("expiry: reconnect in a silent moment inside the last 5 minutes", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive({ expiresIn: 400, config: { idle_seconds: 0 } }); // no idle sleep in this test
  ws.receive({ type: "session.output_transcript.delta", delta: " talking", start_ms: 0, end_ms: 1 });
  await h.clock.advance(99000);
  assert.equal(h.voice.state, "live");
  // Keep talking through the window start; no reconnect while speech continues.
  for (let i = 0; i < 6; i++) { await h.clock.advance(500); ws.receive({ type: "session.input_transcript.delta", delta: " x", start_ms: 0, end_ms: 1 }); }
  assert.equal(h.voice.state, "live");
  await h.clock.advance(2500);
  assert.equal(h.voice.state, "reconnecting");
  assert.equal(ws.sentOfType("session.close").length, 1);
  h.closeReply(ws);
  await h.clock.advance(0);
  assert.deepEqual(h.commands(), ["reconnect:expiry"]);
  // The page re-offers with reason reconnect: no greeting.
  const r = await h.voice.createSession({ sdp: "x", reason: "reconnect" });
  assert.equal(r.status, 201);
  const ws2 = h.WS.last();
  ws2.open();
  ws2.receive({ type: "session.started", session: {} });
  assert.equal(h.voice.state, "live");
  assert.equal(appends(ws2, "instructions").length, 0);
  const input = h.fetchCalls[1].body.session.input;
  assert.match(input[0].content[0].text, /Voice session: reconnected\./);
  assert.ok(input.some((m) => m.role === "assistant" && m.content[0].type === "output_text" && m.content[0].text === "talking"), "voice history as assistant messages");
});

test("expiry hard deadline at expires_at - 60 s even while talking", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive({ expiresIn: 400 });
  for (let i = 0; i < 700; i++) { await h.clock.advance(500); if (h.voice.state !== "live") break; ws.receive({ type: "session.input_transcript.delta", delta: " x", start_ms: 0, end_ms: 1 }); }
  assert.equal(h.voice.state, "reconnecting");
  const elapsed = (h.clock.now() - h.voice.liveStartedAt) / 1000;
  assert.ok(elapsed >= 339 && elapsed <= 341, `reconnected at ${elapsed}s`);
});

test("daily cap: warning at 80 %, close at 100 %, then 429 and the cap message", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive({ config: { daily_cap_minutes: 10 } });
  ws.receive({ type: "session.usage.updated", usage: { seconds: 470 } });
  assert.equal(appends(ws, "commentary").length, 0);
  ws.receive({ type: "session.usage.updated", usage: { seconds: 480 } });
  ws.receive({ type: "session.usage.updated", usage: { seconds: 490 } });
  const warn = appends(ws, "commentary");
  assert.equal(warn.length, 1);
  assert.equal(warn[0].content, "Heads up: you've used 80 percent of today's voice time.");
  ws.receive({ type: "session.usage.updated", usage: { seconds: 600 } });
  assert.equal(ws.sentOfType("session.close").length, 1);
  h.closeReply(ws, "close_requested", 601);
  await h.clock.advance(0);
  assert.equal(h.voice.state, "paused");
  assert.equal(h.voice.status().last_error.code, "daily_cap");
  assert.equal(h.voice.status().today.seconds, 601);
  const r = await h.voice.createSession({ sdp: "x" });
  assert.deepEqual([r.status, r.body.error.code], [429, "daily_cap"]);
  assert.equal(h.on().message, "sotto: daily voice cap reached (10 min). Raise daily_cap_minutes in /config to continue.");
  const usage = JSON.parse(fs.readFileSync(path.join(h.dataDir, "usage.json"), "utf8"));
  assert.equal(Object.values(usage.days)[0], 601);
});

test("usage is never summed across usage.updated events", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  for (const s of [10, 20, 20, 35]) ws.receive({ type: "session.usage.updated", usage: { seconds: s } });
  assert.equal(h.voice.status().today.seconds, 35);
  assert.equal(h.voice.status().live.usage_seconds, 35);
});

test("paused: results wait in pendingResult and seed the resumed session", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  const p = h.voice.pause("pause");
  h.closeReply(ws);
  await p;
  assert.equal(h.voice.state, "paused");
  h.voice.handleHook("Stop", { last_assistant_message: "All tests pass. Nothing else changed." }, "/tmp/clv-owner-a.sock");
  await h.clock.advance(0);
  const pending = h.sse.find((m) => m.type === "result_pending");
  assert.equal(pending.text, "Claude Code finished: All tests pass.");
  const r = await h.voice.createSession({ sdp: "x", reason: "resume" });
  assert.equal(r.status, 201);
  assert.match(h.fetchCalls[1].body.session.input[0].content[0].text, /Result that arrived while voice was paused: Claude Code finished: All tests pass/);
  assert.equal(h.voice.pendingResult, null);
  const ws2 = h.WS.last();
  ws2.open();
  ws2.receive({ type: "session.started", session: {} });
  assert.match(appends(ws2, "instructions")[0].content, /^Say "I'm back\."/);
});

test("SessionEnd: clear/resume ignored; exit of a dead owner turns voice off", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  h.voice.handleHook("SessionEnd", { reason: "clear" }, "/tmp/clv-owner-a.sock");
  await h.clock.advance(10000);
  assert.equal(h.voice.state, "live");
  h.ownerAlive = false;
  h.voice.handleHook("SessionEnd", { reason: "prompt_input_exit" }, "/tmp/clv-owner-a.sock");
  await h.clock.advance(3000);
  assert.equal(appends(ws, "commentary").at(-1).content, "The Claude Code session for proj-a ended, so voice is turning off.");
  await h.clock.advance(4000);
  assert.equal(h.voice.state, "closing");
  h.closeReply(ws);
  await h.clock.advance(2000);
  assert.equal(h.voice.state, "off");
  assert.equal(h.voice.owner, null);
  assert.ok(!fs.existsSync(path.join(h.dataDir, "active")));
  assert.equal(h.chrome.killed, 1);
  await h.clock.advance(3000);
  assert.deepEqual(h.exits, ["off"]);
});

test("liveness check every 30 s releases a dead owner", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  h.on();
  h.ownerAlive = false;
  await h.clock.advance(30000);
  await h.clock.advance(2000);
  assert.equal(h.voice.state, "off");
});

test("owner switch while live: orphan, rewrite active, instructions, keep the session", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  ws.receive({ type: "session.delegation.created", offset_ms: 0, delegation: { id: "item_1", target: "client" } });
  const r = h.on(SESSION("/tmp/clv-owner-b.sock", { cwd: "/work/proj-b", project_dir: "/work/proj-b" }));
  assert.equal(r.message, "sotto: voice ON (proj-b), moved from proj-a.");
  assert.equal(h.voice.delegation.get("item_1").status, "orphaned");
  assert.match(fs.readFileSync(path.join(h.dataDir, "active"), "utf8"), /^\/tmp\/clv-owner-b\.sock\t/);
  assert.match(appends(ws, "instructions").at(-1).content, /switched to a different Claude Code session, in the project proj-b/);
  assert.equal(h.voice.state, "live");
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.on(SESSION("/tmp/clv-owner-b.sock", { project_dir: "/work/proj-b" })).message, "sotto: voice is already ON here (proj-b).");
});

test("control: off, already off, status, toggle, policy, shutdown", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  assert.equal(h.voice.control({ action: "status" }).message, "sotto: voice is off. 0 min today ($0.00).");
  assert.equal(h.voice.control({ action: "off" }).message, "sotto: voice is already off.");
  const ws = await h.goLive();
  ws.receive({ type: "session.usage.updated", usage: { seconds: 90 } });
  assert.equal(h.voice.control({ action: "status" }).message, "sotto: voice ON (proj-a) | 1 min today ($0.08) | voice marin | persona sotto | milestones");
  const p = h.voice.control({ action: "policy", policy: "walkthrough" });
  assert.equal(p.message, "sotto: speaking policy is now walkthrough.");
  assert.match(appends(ws, "instructions").at(-1).content, /^The update preference has changed\. Update preference: Walkthrough/);
  assert.equal(h.voice.control({ action: "policy", policy: "loud" }).ok, false);
  // toggle from the owner → off
  const off = h.voice.control({ action: "toggle", session: SESSION() });
  assert.equal(off.message, "sotto: voice OFF. 1 min today ($0.08).");
  h.closeReply(ws);
  await h.clock.advance(2000);
  assert.equal(h.voice.state, "off");
  assert.ok(h.commands().includes("close_window:user"));
  // toggle again → on (re-bound within the 3 s grace, no exit)
  assert.equal(h.voice.control({ action: "toggle", session: SESSION() }).state, "waiting_page");
  await h.clock.advance(5000);
  assert.deepEqual(h.exits, []);
  assert.equal(h.voice.control({ action: "shutdown" }).message, "sotto: daemon stopped.");
  await h.clock.advance(2000);
  assert.deepEqual(h.exits, ["shutdown"]);
});

test("on without a key: bound, paused, and the window opens at key setup", async (t) => {
  const h = await makeHarness({ env: {} });
  t.after(() => h.cleanup());
  const r = h.on();
  assert.equal(r.message, "sotto: voice ON (proj-a), but there is no OpenAI API key yet. Opening the voice window so you can add it; it is saved in your macOS Keychain.");
  assert.equal(h.voice.state, "paused");
  assert.ok(h.voice.owner);
  assert.equal(h.chrome.opened, 1);
  assert.equal(h.voice.pageStatus().key.setup, true);
  assert.equal(h.voice.pageStatus().last_error.code, "no_api_key");
  assert.equal(h.voice.control({ action: "off" }).message.startsWith("sotto: voice OFF."), true);
  assert.equal(h.voice.keySetup, false);
});

test("on without a key and without a Keychain: the terminal says how to add one", async (t) => {
  const h = await makeHarness({ env: {}, keychain: createFakeKeychain({ available: false }) });
  t.after(() => h.cleanup());
  const r = h.on();
  assert.equal(r.message, "sotto: ERROR OPENAI_API_KEY was not found. Run /talk key to add it, or export it before starting Claude Code.");
  assert.equal(h.voice.state, "paused");
  assert.equal(h.chrome.opened, 0);
});

test("on without a socket is an error", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  assert.match(h.voice.control({ action: "on", session: { socket: "" } }).message, /no inbox socket/);
});

test("end to end in-process: speech → inbox → Stop → spoken result with the delegation id", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  for (const [i, w] of ["Hey,", "what", "branch", "am", "I", "on?"].entries()) {
    ws.receive({ type: "session.input_transcript.delta", delta: " " + w, start_ms: 1000 + i * 200, end_ms: 1200 + i * 200 });
  }
  ws.receive({ type: "session.delegation.created", offset_ms: 2000, delegation: { id: "item_abc", type: "delegation", target: "client" } });
  await h.clock.advance(700);
  assert.equal(h.inboxSends.length, 1);
  assert.equal(h.inboxSends[0].content, `[sotto voice ${h.voice.nonce}] Hey, what branch am I on?`);
  assert.equal(h.inboxSends[0].token, "inbox-token-a");
  assert.equal(h.inboxSends[0].socket, "/tmp/clv-owner-a.sock");
  assert.equal(h.voice.status().delegations[0].status, "sent");
  // Hooks from another session are counted but ignored.
  h.voice.handleHook("Stop", { last_assistant_message: "Other" }, "/tmp/other.sock");
  assert.equal(h.voice.counters.hooks, 1);
  h.voice.handleHook("UserPromptSubmit", { prompt: h.inboxSends[0].content, session_id: "sess-new" }, "/tmp/clv-owner-a.sock");
  assert.equal(h.voice.status().delegations[0].status, "delivered");
  assert.equal(h.voice.owner.session_id, "sess-new");
  h.voice.handleHook("PreToolUse", { tool_name: "Bash", tool_input: { command: "git branch", description: "Show the branch" } }, "/tmp/clv-owner-a.sock");
  h.voice.handleHook("Stop", { last_assistant_message: "You are on **main**." }, "/tmp/clv-owner-a.sock");
  await h.clock.advance(0);
  const c = appends(ws, "commentary");
  assert.deepEqual(c.at(-1), { type: "session.commentary.append", event_id: c.at(-1).event_id, delegation_id: "item_abc", content: "Claude Code's answer: You are on main." });
  assert.equal(h.voice.status().delegations[0].status, "answered");
  assert.equal(h.voice.status().claude.busy, false);
  assert.ok(appends(ws, "thinking").some((e) => e.delegation_id === "item_abc" && /Request sent to Claude Code/.test(e.content)));
});

test("permission prompts are spoken once", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  for (let i = 0; i < 2; i++) h.voice.handleHook("PermissionRequest", { tool_name: "Edit", tool_input: { file_path: "/a/hooks.json" } }, "/tmp/clv-owner-a.sock");
  const c = appends(ws, "commentary");
  assert.equal(c.length, 1);
  assert.equal(c[0].content, "Claude Code is waiting for your approval in the terminal to edit hooks.json.");
  assert.ok(h.sse.some((m) => m.type === "activity" && m.kind === "permission"));
});

test("unexpected close reasons: reconnect up to 3 times per 10 min, content pauses", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  let ws = await h.goLive();
  for (let i = 0; i < 3; i++) {
    ws.receive({ type: "session.closed", reason: "connection_lost", usage: { seconds: 5 } });
    assert.equal(h.voice.state, "reconnecting");
    ws = await h.goLive({ reason: "reconnect" });
  }
  ws.receive({ type: "session.closed", reason: "connection_lost", usage: { seconds: 5 } });
  assert.equal(h.voice.state, "paused");
  assert.equal(h.voice.status().last_error.code, "connection_lost");
  ws = await h.goLive({ reason: "resume" });
  ws.receive({ type: "session.closed", reason: "content", usage: { seconds: 1 } });
  assert.equal(h.voice.state, "paused");
  assert.equal(h.voice.status().last_error.code, "content");
  assert.ok(h.commands().includes("disconnect:content"));
});

test("page events: mic_error pauses, muted mirrors, rtc failed reconnects, stop turns off", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  h.on();
  h.voice.handlePage({ type: "mic_error", name: "NotAllowedError", message: "Permission denied" });
  assert.equal(h.voice.state, "paused");
  assert.equal(h.voice.status().last_error.code, "mic_denied");
  const ws = await h.goLive({ reason: "resume" });
  h.voice.handlePage({ type: "muted", muted: true });
  assert.equal(h.voice.status().live.muted, true);
  h.voice.handlePage({ type: "rtc_state", state: "disconnected" });
  await h.clock.advance(7000);
  h.voice.handlePage({ type: "rtc_state", state: "connected" });
  await h.clock.advance(5000);
  assert.equal(h.voice.state, "live");
  h.voice.handlePage({ type: "rtc_state", state: "failed" });
  assert.equal(h.voice.state, "reconnecting");
  assert.equal(ws.sentOfType("session.close").length, 1);
  h.voice.handlePage({ type: "log", level: "error", message: "boom" });
  assert.equal(h.log.find("page.log")[0].src, "page");
  h.voice.handlePage({ type: "stop" });
  await h.clock.advance(20000);
  assert.equal(h.voice.state, "off");
});

// ---- voice window: /talk window, /talk app, app install notes (SPEC §6.16) ----
function fakeApp(h, status = { state: "ready" }) {
  const calls = [];
  h.chrome.appStatus = () => status;
  h.chrome.ensureInstalled = (o) => { calls.push(o || {}); return status; };
  return { calls, set: (s) => { status = s; } };
}

test("/talk window: shows, validates and persists the window in prefs.json", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  fakeApp(h, { state: "installing" });
  assert.equal(h.voice.control({ action: "window" }).message, "sotto: window is auto (desktop app: installing). Change it with /talk window <auto|app|chrome>.");
  assert.equal(h.voice.control({ action: "window", window: "Chrome" }).message, "sotto: window set to chrome. It applies the next time the voice window opens.");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dataDir, "prefs.json"), "utf8")), { window: "chrome" });
  assert.equal(h.voice.windowPref(), "chrome");
  assert.equal(h.voice.windowPref({ window: "app" }), "chrome", "prefs beat userConfig");
  const bad = h.voice.control({ action: "window", window: "lynx" });
  assert.equal(bad.ok, false);
  assert.equal(bad.message, 'sotto: unknown window "lynx". Choose auto, app or chrome.');
  assert.match(h.voice.control({ action: "window", window: "app" }).message, /window set to app\. .* The desktop app is installing\.$/);
});

test("/talk app: persists window=app, forces the install, turns voice on", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const app = fakeApp(h);
  const r = h.voice.control({ action: "app", session: SESSION(), config: { open_browser: true } });
  assert.equal(r.message, "sotto: voice ON (proj-a). Opening the voice window.");
  assert.equal(h.chrome.opened, 1);
  assert.deepEqual(app.calls.at(-1), { force: true });
  assert.equal(h.voice.windowPref(), "app");
});

test("/talk app while a Chrome page hosts the voice: switches at the next /talk", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  fakeApp(h);
  h.on();
  h.d.sse.clients.add({ write() {}, end() {} });
  const r = h.voice.control({ action: "app", session: SESSION(), config: { open_browser: true } });
  assert.match(r.message, /^sotto: window set to app\. The voice moves to the desktop app at the next \/talk/);
  assert.equal(h.chrome.opened, 1, "no second window");
});

test("/talk app on Linux: a clear message", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  fakeApp(h, { state: "unsupported" });
  const r = h.voice.control({ action: "app", session: SESSION(), config: { open_browser: true } });
  assert.equal(r.ok, false);
  assert.match(r.message, /needs macOS/);
});

test("on: the window waits for an app install, or says why the app is missing", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  fakeApp(h, { state: "installing" });
  h.chrome.open = () => ({ mode: "app", pending: true });
  assert.equal(h.on().message, "sotto: voice ON (proj-a). Installing the desktop app (signed release, about 350 KB); the window opens when it is ready.");
  h.voice.control({ action: "off" });
  h.chrome.open = () => ({ mode: "chrome", installError: { reason: "build_failed", message: "no signed release for this version" } });
  assert.equal(h.on().message, "sotto: voice ON (proj-a). Desktop app couldn't be installed (no signed release for this version); using Chrome.");
  assert.equal(h.voice.helloNotice.code, "app_install_failed");
});

test("status names a missing, installing or failed desktop app; every /talk ensures the install", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const app = fakeApp(h, { state: "failed", reason: "build_failed", message: "the local build failed: swiftc not found" });
  assert.equal(h.voice.control({ action: "status" }).message, "sotto: voice is off. 0 min today ($0.00). desktop app couldn't be installed (the local build failed: swiftc not found); using Chrome. Retry with /talk app.");
  assert.ok(app.calls.length >= 1);
  app.set({ state: "ready" });
  assert.equal(h.voice.control({ action: "status" }).message, "sotto: voice is off. 0 min today ($0.00).");
  h.voice.control({ action: "window", window: "chrome" });
  app.set({ state: "failed", message: "x" });
  assert.equal(h.voice.control({ action: "status" }).message, "sotto: voice is off. 0 min today ($0.00).", "not when Chrome is chosen");
});

test("install results reach the page: failure as a toast (now or at hello), success as a hint", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  fakeApp(h);
  h.voice.appInstallResult({ ok: false, reason: "build_failed", message: "swiftc not found" });
  assert.deepEqual(h.voice.helloNotice, { level: "warn", code: "app_install_failed", text: "Desktop app couldn't be installed: swiftc not found. Using Chrome." });
  const sent = [];
  h.d.sse.clients.add({ write(d) { sent.push(String(d)); }, end() {} });
  h.voice.appInstallResult({ ok: true });
  assert.ok(sent.some((d) => d.includes("app_ready")));
});
