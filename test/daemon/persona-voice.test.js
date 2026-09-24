// The persona's voice has one source of truth (SPEC §4.5, §4.6): prefs.json's
// persona plus persona_voice, resolved again for every session the daemon
// creates (daemon/voice.js effectiveVoice). And `sotto persona <x>` reports a
// switch only once the daemon confirms a session runs in it (controlConfirmed).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHarness } from "../helpers/daemon-harness.js";
import { QUIET_MS } from "../../daemon/update.js";

const prefsOf = (h) => JSON.parse(fs.readFileSync(path.join(h.dataDir, "prefs.json"), "utf8"));
const voiceOf = (h, i) => h.fetchCalls[i].body.session.audio.output.voice;

test("the persona's voice survives reconnect, voice wake and a self-update restart", async (t) => {
  const a = await makeHarness();
  t.after(() => a.cleanup());
  a.d.sse.clients.add({ write() {}, end() {} }); // a page is listening, so idle close sleeps (wake on)
  fs.writeFileSync(path.join(a.dataDir, "prefs.json"), '{"voice":"marin","persona":"june"}\n');
  // userConfig names another voice: prefs and the persona still win.
  const ws = await a.goLive({ config: { voice: "sage" } });
  assert.equal(voiceOf(a, 0), "coral", "start");
  assert.equal(a.voice.live.persona, "june");

  // An unexpected loss: the page reconnects.
  a.voice.reconnect("rtc_failed");
  let r = await a.voice.createSession({ sdp: "v=0 offer", reason: "reconnect" });
  assert.equal(r.status, 201);
  assert.equal(voiceOf(a, 1), "coral", "reconnect");
  let live = a.WS.last();
  live.open();
  live.receive({ type: "session.started", session: {} });

  // Idle sleep, then a voice wake.
  const pp = a.voice.goToSleep("idle");
  a.closeReply(live);
  await pp;
  assert.equal(a.voice.state, "sleeping");
  r = await a.voice.createSession({ sdp: "v=0 offer", reason: "wake", wake: { snr_db: 12, level_db: -40, voiced_ms: 400 } });
  assert.equal(r.status, 201);
  assert.equal(voiceOf(a, 2), "coral", "wake");
  live = a.WS.last();
  live.open();
  live.receive({ type: "session.started", session: {} });

  // Self-update: snapshot, successor restores and reconnects.
  await a.clock.advance(QUIET_MS);
  const p = a.voice.prepareRestart("update");
  a.closeReply(live);
  const snap = a.voice.snapshot(await p);
  const b = await makeHarness({ dataDir: a.dataDir, daemonKey: a.d.daemonKey, pageToken: a.d.pageToken, port: a.port });
  t.after(() => b.cleanup());
  assert.equal(b.voice.restore(JSON.parse(JSON.stringify(snap))), true);
  r = await b.voice.createSession({ sdp: "v=0 offer", reason: "reconnect" });
  assert.equal(r.status, 201);
  assert.equal(voiceOf(b, 0), "coral", "restart");
  assert.equal(b.voice.live.persona, "june");
  assert.ok(ws);
});

test("a persona chosen elsewhere (the CLI with no daemon, another window) applies at the next session with its voice", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  assert.equal(voiceOf(h, 0), "marin");
  // prefs.json changed behind the daemon's back (toggle.sh persona_local, a second install).
  fs.writeFileSync(path.join(h.dataDir, "prefs.json"), '{"persona":"june"}\n');
  h.voice.reconnect("rtc_failed");
  const r = await h.voice.createSession({ sdp: "v=0 offer", reason: "reconnect" });
  assert.equal(r.status, 201);
  assert.equal(voiceOf(h, 1), "coral");
  assert.equal(h.voice.live.persona, "june");
  assert.ok(ws);
});

test("an explicit voice after a persona turns the persona's voice off, and that also survives a reconnect", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  h.voice.setPersona("pip", "app");
  assert.equal(h.voice.currentVoice(), "echo");
  h.voice.setVoice("marin", "app");
  assert.deepEqual(prefsOf(h), { persona: "pip", voice: "marin", persona_voice: false });
  const set = h.log.entries.filter((e) => e.ev === "voice.set").at(-1);
  assert.equal(set.persona_voice, false, "logged");
  // Turning the toggle back on brings the persona's voice back.
  h.voice.setPersonaVoice(true);
  assert.equal(h.voice.currentVoice(), "echo");
  assert.ok(ws);
});

test("sotto persona (confirm): success only after a session runs in the persona and its voice; logged via cli", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive();
  const p = h.voice.controlConfirmed({ action: "persona", persona: "june", confirm: true, via: "cli" });
  let settled = null;
  p.then((r) => { settled = r; });
  await h.clock.advance(0);
  assert.equal(settled, null, "not answered while switching");
  h.closeReply(ws);
  await h.clock.advance(0);
  const c = await h.voice.createSession({ sdp: "v=0 offer", reason: "reconnect" });
  assert.equal(c.status, 201);
  await h.clock.advance(200);
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.message, "sotto: persona set to june with the coral voice. The live session now runs as june.");
  const set = h.log.entries.find((e) => e.ev === "persona.set");
  assert.equal(set.via, "cli");
  assert.equal(set.persona, "june");
  assert.equal(set.voice, "coral");
  assert.ok(h.log.entries.some((e) => e.ev === "control.confirm" && e.ok === true));
  assert.equal(voiceOf(h, 1), "coral");
});

test("sotto persona (confirm): no session in the persona within 5 s is an ERROR, not a success", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  await h.goLive();
  const p = h.voice.controlConfirmed({ action: "persona", persona: "moss", confirm: true, via: "cli" });
  await h.clock.advance(5200); // the old session never closes, nothing reconnects
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.message, /^sotto: ERROR persona moss is saved, but the live session did not switch to it within 5 s/);
  assert.equal(prefsOf(h).persona, "moss", "the choice is kept for the next session");
});

test("sotto persona (confirm): rejected, or nothing to switch, answers at once", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  let r = await h.voice.controlConfirmed({ action: "persona", persona: "robot", confirm: true, via: "cli" });
  assert.equal(r.ok, false);
  assert.match(r.message, /^sotto: unknown persona "robot"/);
  // Voice on but no session (paused/sleeping or off): saved, next session.
  r = await h.voice.controlConfirmed({ action: "persona", persona: "june", confirm: true, via: "cli" });
  assert.equal(r.ok, true);
  assert.equal(r.message, "sotto: persona set to june with the coral voice. It applies to the next voice session.");
  assert.equal(prefsOf(h).persona, "june");
});
