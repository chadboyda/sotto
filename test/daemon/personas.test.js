// Personas (SPEC §4.6): loading, validation and precedence; prompt assembly
// (the relay rules follow the persona block and win); the live switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  BUILTIN_PERSONAS, DEFAULT_PERSONA, MAX_PERSONA_CHARS, parsePersonaFile, loadPersonas, findPersona, resolvePersona,
  normalizePersonaId, personaListMessage, unknownPersonaMessage, personaSummary,
} from "../../daemon/personas.js";
import { render, renderForPolicy, personaBlock, personaSwitchGreeting, TEMPLATE, VOICE_HISTORY_END } from "../../daemon/prompt.js";
import { readPrefs, writePrefs, personaVoiceOn } from "../../daemon/prefs.js";
import { dataPaths } from "../../daemon/paths.js";
import { VOICES } from "../../daemon/config.js";
import { estTokens } from "../../daemon/speech.js";
import { makeHarness, SESSION } from "../helpers/daemon-harness.js";

const appends = (ws, kind) => ws.sent.filter((e) => e.type === `session.${kind}.append`);
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "clv-persona-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

// ---- built-ins -------------------------------------------------------------------------

test("built-ins: 8 distinct personas, valid ids and voices, bodies within ~250 tokens, default first", () => {
  assert.equal(BUILTIN_PERSONAS.length, 8);
  assert.equal(BUILTIN_PERSONAS[0].id, DEFAULT_PERSONA);
  const ids = BUILTIN_PERSONAS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(BUILTIN_PERSONAS.map((p) => p.voice)).size, ids.length, "each suggests its own voice");
  for (const p of BUILTIN_PERSONAS) {
    assert.equal(normalizePersonaId(p.id), p.id);
    assert.ok(VOICES.includes(p.voice), `${p.id} voice`);
    assert.ok(p.name && p.description && p.description.length <= 160, `${p.id} description`);
    assert.ok(estTokens(p.body) <= 300 && p.body.length <= 1200, `${p.id}: ${p.body.length} chars`);
    assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(p.body + p.description), "no emoji");
    assert.ok(!/\{\{|\}\}/.test(p.body));
  }
});

// ---- files -----------------------------------------------------------------------------

test("parsePersonaFile: frontmatter, defaults, bad voice, long body, empty, bad id", () => {
  let r = parsePersonaFile("---\nname: Captain Hook\ndescription: \"Arr, a pirate.\"\nvoice: Stone\n---\nYou talk like a pirate.\n", "captain");
  assert.deepEqual(r, { persona: { id: "captain", name: "Captain Hook", description: "Arr, a pirate.", voice: "stone", body: "You talk like a pirate.", source: "user" }, warnings: [] });
  r = parsePersonaFile("Just a body, no frontmatter.", "plain", "project");
  assert.deepEqual(r.persona, { id: "plain", name: "Plain", description: "", voice: null, body: "Just a body, no frontmatter.", source: "project" });
  r = parsePersonaFile("---\nvoice: robot\n---\nBody {{project}} text", "x");
  assert.equal(r.persona.voice, null);
  assert.deepEqual(r.warnings, ["bad_voice"]);
  assert.equal(r.persona.body, "Body project text", "placeholders are not left for the template");
  r = parsePersonaFile(`---\nname: Long\n---\n${"word ".repeat(1000)}`, "long");
  assert.ok(r.persona.body.length <= MAX_PERSONA_CHARS);
  assert.deepEqual(r.warnings, ["too_long"]);
  assert.deepEqual(parsePersonaFile("---\nname: Empty\n---\n  \n", "empty"), { error: "empty" });
  assert.deepEqual(parsePersonaFile("body", "Bad Name"), { error: "bad_id" });
  r = parsePersonaFile("---\r\nname: Win\r\n---\r\nCRLF body\r\n", "win");
  assert.equal(r.persona.name, "Win");
  assert.equal(r.persona.body, "CRLF body");
});

test("loadPersonas: project > user > built-in by id; custom ones follow the built-ins, sorted; invalid skipped", (t) => {
  const D = tmp(t);
  const proj = tmp(t);
  write(path.join(D, "personas", "zed.md"), "---\nname: User Zed\n---\nuser zed");
  write(path.join(D, "personas", "moss.md"), "---\nname: My Moss\nvoice: alloy\n---\nmy moss");
  write(path.join(D, "personas", "alpha.md"), "alpha body");
  write(path.join(D, "personas", "empty.md"), "---\nname: x\n---\n");
  write(path.join(D, "personas", "notes.txt"), "ignored");
  write(path.join(proj, ".claude", "sotto-personas", "zed.md"), "---\nname: Project Zed\n---\nproject zed");
  const warns = [];
  const list = loadPersonas({ dataDir: D, projectDir: proj, log: { warn: (ev, f) => warns.push([ev, f.code]) } });
  assert.deepEqual(list.map((p) => p.id), [...BUILTIN_PERSONAS.map((p) => p.id), "alpha", "zed"]);
  const moss = findPersona(list, "moss");
  assert.deepEqual([moss.name, moss.voice, moss.source], ["My Moss", "alloy", "user"], "a user file replaces a built-in in place");
  const zed = findPersona(list, "zed");
  assert.deepEqual([zed.name, zed.body, zed.source], ["Project Zed", "project zed", "project"]);
  assert.deepEqual(warns, [["persona.invalid", "empty"]]);
  // Missing dirs are fine.
  assert.equal(loadPersonas({ dataDir: path.join(D, "nope"), projectDir: null }).length, BUILTIN_PERSONAS.length);
});

test("findPersona / resolvePersona: by id or display name; unknown falls back to the default", () => {
  const list = BUILTIN_PERSONAS.map((p) => ({ ...p, source: "builtin" }));
  assert.equal(findPersona(list, " MOSS ").id, "moss");
  assert.equal(findPersona(list, "Koan").id, "koan");
  assert.equal(findPersona(list, "nobody"), null);
  assert.equal(findPersona(list, ""), null);
  assert.equal(resolvePersona(list, "gone").id, "sotto");
  assert.equal(resolvePersona(list, undefined).id, "sotto");
  assert.equal(resolvePersona(list, "pip").id, "pip");
  assert.deepEqual(Object.keys(personaSummary(list[1])), ["id", "name", "description", "voice", "source"], "the body never goes to the page");
});

test("list and unknown messages: one line, current marked", () => {
  const list = BUILTIN_PERSONAS.map((p) => ({ ...p, source: "builtin" }));
  const m = personaListMessage("moss", list);
  assert.match(m, /^sotto: persona is moss\. Personas: sotto \(Balanced and friendly, [^)]*\), june \(/);
  assert.ok(m.includes("moss (current) (Dry-witted senior engineer"));
  assert.ok(m.endsWith(". Change it with /talk persona <name>."));
  assert.ok(!m.includes("\n"));
  assert.equal(unknownPersonaMessage('ro"bot\n', list), `sotto: unknown persona "robot". Personas: ${list.map((p) => p.id).join(", ")}.`);
});

test("prefs: persona and persona_voice persist; invalid values dropped", (t) => {
  const p = dataPaths(tmp(t));
  writePrefs(p, { voice: "ash", persona: "moss" });
  writePrefs(p, { persona_voice: false });
  assert.equal(fs.readFileSync(p.prefs, "utf8"), '{"voice":"ash","persona":"moss","persona_voice":false}\n');
  assert.deepEqual(readPrefs(p), { voice: "ash", persona: "moss", persona_voice: false });
  fs.writeFileSync(p.prefs, '{"persona":"Bad Name","persona_voice":"yes"}');
  assert.deepEqual(readPrefs(p), {});
  assert.equal(personaVoiceOn({}), true);
  assert.equal(personaVoiceOn({ persona_voice: false }), false);
});

// ---- prompt ----------------------------------------------------------------------------

test("prompt: the persona block sits after the identity line and before every rule, which take precedence", () => {
  const moss = BUILTIN_PERSONAS.find((p) => p.id === "moss");
  const text = renderForPolicy("proj", "milestones", "", moss);
  const at = (s) => { const i = text.indexOf(s); assert.ok(i >= 0, s); return i; };
  const persona = at("Your persona is Moss. Personality:");
  assert.ok(at("You are Sotto, the voice of Claude Code") < persona);
  assert.ok(text.includes(moss.body));
  assert.ok(text.includes("Every rule below takes precedence over the persona."));
  // Every relay and safety rule follows the persona.
  for (const rule of [
    "Keep most replies to one to three short sentences.",
    "Never say passwords, API keys, tokens, or other secrets aloud",
    "Mic checks are yours to answer, right away",
    "Say that something is done, fixed, finished or ready only when a result from Claude Code for that request says so.",
    "Delegation policy:",
    "Delegate to the backend when:",
    "The user makes a decision, states a preference",
    "Do not guess the result while waiting.",
  ]) assert.ok(at(rule) > persona, rule);
  // Without a persona the template is unchanged apart from the placeholder.
  assert.equal(render({ project: "proj" }), render({ project: "proj", persona: null }));
  assert.ok(!render({ project: "proj" }).includes("{{persona}}"));
  assert.ok(!render({ project: "proj" }).includes("Personality:"));
  assert.match(TEMPLATE, /voice or persona/);
});

test("prompt: persona text is literal (no placeholder or $& expansion) and the name is sanitised", () => {
  const text = render({ project: "proj", vocabulary: "", persona: { name: "Zed\"\n{{x}}", body: "Say $& and {{project}} and $1." } });
  assert.ok(text.includes("Say $& and {{project}} and $1."), "persona body is inserted verbatim");
  assert.ok(text.includes("Your persona is Zedx."));
  assert.equal(personaBlock({ name: "x", body: "  " }), "");
  assert.equal(personaSwitchGreeting("Moss"), "In one short sentence, in your new personality, tell the user you're now Moss. Then stop and listen; the conversation continues from where it left off.");
});

test("prompt: every built-in, and a maximal custom one, keeps the instructions far below 16k tokens", () => {
  const vocab = `Names the user may say:\n${"- some-long-project-name (said as some long project name)\n".repeat(120)}`;
  for (const p of [...BUILTIN_PERSONAS, { name: "Max", body: "w".repeat(MAX_PERSONA_CHARS) }]) {
    const n = estTokens(renderForPolicy("proj", "walkthrough", vocab, p));
    assert.ok(n < 8000, `${p.name}: ~${Math.round(n)} tokens`);
  }
});

// ---- orchestrator ----------------------------------------------------------------------

test("session create: instructions carry the chosen persona; default without prefs", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  await h.goLive();
  let ins = h.fetchCalls[0].body.session.instructions;
  assert.ok(ins.includes("Your persona is Sotto."));
  assert.equal(h.voice.live.persona, "sotto");
  assert.equal(h.voice.pageStatus().persona, "sotto");
  assert.equal(h.voice.status().config.persona, "sotto");

  const h2 = await makeHarness();
  t.after(() => h2.cleanup());
  fs.writeFileSync(path.join(h2.dataDir, "prefs.json"), '{"persona":"vic"}');
  await h2.goLive();
  ins = h2.fetchCalls[0].body.session.instructions;
  assert.ok(ins.includes("Your persona is Vic."));
  assert.ok(ins.includes(BUILTIN_PERSONAS.find((p) => p.id === "vic").body));
  assert.deepEqual(h2.fetchCalls[0].body.session.audio, { output: { voice: "marin" } }, "prefs persona alone does not change the voice");
});

test("control persona: list, set with the persona's voice, already, unknown — without a Live session", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  let r = h.voice.control({ action: "persona" });
  assert.equal(r.message, personaListMessage("sotto", h.voice.personaList()));
  r = h.voice.control({ action: "persona", persona: "Moss" });
  assert.equal(r.message, "sotto: persona set to moss with the cedar voice. It applies to the next voice session.");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dataDir, "prefs.json"), "utf8")), { voice: "cedar", persona: "moss" });
  r = h.voice.control({ action: "persona", persona: "moss" });
  assert.equal(r.message, "sotto: persona is already moss.");
  r = h.voice.control({ action: "persona", persona: "robot" });
  assert.equal(r.ok, false);
  assert.match(r.message, /^sotto: unknown persona "robot"\. Personas: sotto, june, /);
  // "Use the persona's voice" off: the voice stays.
  h.voice.setPersonaVoice(false);
  r = h.voice.control({ action: "persona", persona: "tempo" });
  assert.equal(r.message, "sotto: persona set to tempo. It applies to the next voice session.");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dataDir, "prefs.json"), "utf8")), { voice: "cedar", persona: "tempo", persona_voice: false });
});

test("control persona: finds the unbound caller's project personas through its session", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const proj = tmp(t);
  write(path.join(proj, ".claude", "sotto-personas", "captain.md"), "---\nname: Captain\ndescription: A ship's captain.\nvoice: stone\n---\nYou are the captain.");
  const session = SESSION(undefined, { cwd: proj, project_dir: proj });
  assert.match(h.voice.control({ action: "persona", session }).message, /captain \(A ship's captain\)\. Change it/);
  const r = h.voice.control({ action: "persona", persona: "captain", session });
  assert.equal(r.message, "sotto: persona set to captain with the stone voice. It applies to the next voice session.");
  // Bound to that project: its session uses the project persona.
  await h.goLive({ session });
  assert.ok(h.fetchCalls.at(-1).body.session.instructions.includes("Your persona is Captain. Personality:\nYou are the captain."));
  assert.deepEqual(h.fetchCalls.at(-1).body.session.audio, { output: { voice: "stone" } });
});

test("live switch: closes the old session, reconnects, seeds context without repeating, greets in the new persona", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive({ config: { voice: "marin" } });
  ws.receive({ type: "session.input_transcript.delta", delta: " how's the parser", start_ms: 0, end_ms: 1 });
  ws.receive({ type: "session.output_transcript.delta", delta: " the parser tests pass", start_ms: 1, end_ms: 2 });

  const r = h.voice.control({ action: "persona", persona: "tempo" });
  assert.equal(r.message, "sotto: persona set to tempo with the tempo voice. Switching the live session now.");
  assert.equal(h.voice.state, "reconnecting");
  assert.equal(ws.sentOfType("session.close").length, 1, "old session closed");
  assert.ok(h.sse.some((m) => m.type === "notice" && m.code === "persona_change" && m.text === "Switching to Tempo."));
  assert.deepEqual(h.commands(), [], "no reconnect before the old session has closed");
  h.closeReply(ws, "close_requested", 7);
  await h.clock.advance(0);
  assert.deepEqual(h.commands(), ["reconnect:persona_change"]);
  assert.equal(h.voice.reconnects.length, 0, "not an unexpected loss");

  const c = await h.voice.createSession({ sdp: "v=0 offer 2", reason: "reconnect" });
  assert.equal(c.status, 201);
  const body = h.fetchCalls[1].body.session;
  assert.deepEqual(body.audio, { output: { voice: "tempo" } });
  assert.ok(body.instructions.includes("Your persona is Tempo."));
  assert.ok(!body.instructions.includes("Your persona is Sotto."));
  assert.deepEqual(body.input.slice(1).map((m) => [m.role, m.content[0].text]), [
    ["user", "how's the parser"], ["assistant", "the parser tests pass"], ["developer", VOICE_HISTORY_END],
  ]);
  const ws2 = h.WS.last();
  ws2.open();
  ws2.receive({ type: "session.started", session: {} });
  assert.equal(h.voice.state, "live");
  const ins = appends(ws2, "instructions");
  assert.equal(ins.length, 1);
  assert.equal(ins[0].content, personaSwitchGreeting("Tempo"));
  assert.equal(h.voice.live.persona, "tempo");
  assert.equal(h.voice.personaSwitch, null);
  assert.equal(h.voice.voiceSwitch, null);
});

test("live switch with use-voice off keeps the voice; the same persona does not re-create", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  writePrefs(dataPaths(h.dataDir), { persona_voice: false });
  const ws = await h.goLive({ config: { voice: "marin" } });
  let r = h.voice.control({ action: "persona", persona: "sotto" });
  assert.equal(r.message, "sotto: persona is already sotto.");
  assert.equal(ws.sentOfType("session.close").length, 0);
  r = h.voice.control({ action: "persona", persona: "koan" });
  assert.equal(r.message, "sotto: persona set to koan. Switching the live session now.");
  h.closeReply(ws, "close_requested", 3);
  await h.clock.advance(0);
  await h.voice.createSession({ sdp: "v=0 offer 2", reason: "reconnect" });
  assert.deepEqual(h.fetchCalls[1].body.session.audio, { output: { voice: "marin" } });
  const ws2 = h.WS.last();
  ws2.open();
  ws2.receive({ type: "session.started", session: {} });
  assert.equal(appends(ws2, "instructions")[0].content, personaSwitchGreeting("Koan"));
});

test("persona chosen while connecting: switches once ready, no greeting in the old persona", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  writePrefs(dataPaths(h.dataDir), { persona_voice: false });
  h.on(SESSION(), { voice: "marin" });
  await h.voice.createSession({ sdp: "v=0 offer", reason: "start" });
  assert.equal(h.voice.state, "connecting");
  const r = h.voice.control({ action: "persona", persona: "pip" });
  assert.equal(r.message, "sotto: persona set to pip. The session switches as soon as it is ready.");
  const ws = h.WS.last();
  ws.open();
  ws.receive({ type: "session.started", session: {} });
  assert.equal(h.voice.state, "reconnecting");
  assert.equal(appends(ws, "instructions").length, 0);
  h.closeReply(ws, "close_requested", 1);
  await h.clock.advance(0);
  assert.deepEqual(h.commands(), ["reconnect:persona_change"]);
  await h.voice.createSession({ sdp: "v=0 offer 2", reason: "reconnect" });
  const ws2 = h.WS.last();
  ws2.open();
  ws2.receive({ type: "session.started", session: {} });
  assert.equal(appends(ws2, "instructions")[0].content, personaSwitchGreeting("Pip"));
});

test("live switch: the last spoken update is not repeated by the new persona", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const ws = await h.goLive({ config: { voice: "marin" } });
  h.voice.deliver({ kind: "commentary", content: "Claude Code's answer: you're on the banana branch.", delegationId: null, source: "voice_result" });
  await h.clock.advance(500);
  ws.receive({ type: "session.output_transcript.delta", delta: " You're on the banana branch.", start_ms: 100, end_ms: 1500 });
  await h.clock.advance(3000);
  h.voice.control({ action: "persona", persona: "fern" });
  h.closeReply(ws, "close_requested", 5);
  await h.clock.advance(0);
  await h.voice.createSession({ sdp: "v=0 offer 2", reason: "reconnect" });
  const input = h.fetchCalls[1].body.session.input;
  assert.ok(!/Result that arrived while voice was paused/.test(input[0].content[0].text));
  const ws2 = h.WS.last();
  ws2.open();
  ws2.receive({ type: "session.started", session: {} });
  await h.clock.advance(30000);
  assert.equal(appends(ws2, "commentary").length, 0, "nothing re-spoken");
});

// ---- HTTP API ---------------------------------------------------------------------------

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
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not json */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

test("GET /api/personas and POST /api/persona: page auth, shapes, toggle, live switch", async (t) => {
  const h = await makeHarness({ realClock: true });
  await h.d.listen();
  t.after(() => h.cleanup());
  const page = { "X-Sotto-Page": h.d.pageToken };
  assert.equal((await request(h.port, { path: "/api/personas" })).status, 403);
  let r = await request(h.port, { path: "/api/personas", headers: page });
  assert.equal(r.status, 200);
  assert.equal(r.json.current, "sotto");
  assert.equal(r.json.use_voice, true);
  assert.equal(r.json.personas.length, BUILTIN_PERSONAS.length);
  assert.deepEqual(r.json.personas[2], { id: "moss", name: "Moss", description: BUILTIN_PERSONAS[2].description, voice: "cedar", source: "builtin" });
  assert.ok(!JSON.stringify(r.json).includes("Personality"), "no bodies");

  assert.equal((await request(h.port, { method: "POST", path: "/api/persona", body: { persona: "moss" } })).status, 403);
  r = await request(h.port, { method: "POST", path: "/api/persona", headers: page, body: { persona: "robot" } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, "bad_persona");
  r = await request(h.port, { method: "POST", path: "/api/persona", headers: page, body: {} });
  assert.equal(r.status, 400);
  r = await request(h.port, { method: "POST", path: "/api/persona", headers: page, body: { use_voice: false } });
  assert.deepEqual(r.json, { ok: true, use_voice: false });
  assert.equal((await request(h.port, { path: "/api/personas", headers: page })).json.use_voice, false);
  await request(h.port, { method: "POST", path: "/api/persona", headers: page, body: { use_voice: true } });

  const ws = await h.goLive({ config: { voice: "marin" } });
  r = await request(h.port, { method: "POST", path: "/api/persona", headers: page, body: { persona: "june" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, persona: "june", voice: "coral", switching: true, message: "sotto: persona set to june with the coral voice. Switching the live session now." });
  assert.equal(ws.sentOfType("session.close").length, 1);
  r = await request(h.port, { path: "/api/personas", headers: page });
  assert.deepEqual([r.json.current, r.json.live], ["june", false]);
});
