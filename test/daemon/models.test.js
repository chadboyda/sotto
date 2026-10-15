// Live model selection (SPEC §4.7) and reported voices (§4.5 "New voices"):
// version parsing, the choice, the fallbacks, no switch mid-session and the
// once-per-change announcement (fake clock, in-process daemon).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHarness, tmpDir } from "../helpers/daemon-harness.js";
import { createFakeClock } from "../helpers/fake-clock.js";
import { createMemoryLogger } from "../../daemon/log.js";
import { parseLiveModel, isLiveConversationModel, pickLiveModel, modelLabel, normalizeModelPref, parseVoiceError, ModelSelector, DEFAULT_LIVE_MODEL, MODEL_REFRESH_MS } from "../../daemon/models.js";
import { modelChangeGreeting } from "../../daemon/prompt.js";
import { validateKey } from "../../daemon/apikey.js";
import { setExtraVoices } from "../../daemon/config.js";

const appends = (ws, kind) => ws.sent.filter((e) => e.type === `session.${kind}.append`);
const list = (...ids) => ({ status: 200, text: async () => JSON.stringify({ data: ids.map((id) => ({ id })) }) });

test("parseLiveModel: versions, snapshot dates and variants", () => {
  assert.deepEqual(parseLiveModel("gpt-live-1"), { id: "gpt-live-1", major: 1, minor: 0, date: null, variant: null });
  assert.deepEqual(parseLiveModel("gpt-live-1.1"), { id: "gpt-live-1.1", major: 1, minor: 1, date: null, variant: null });
  assert.deepEqual(parseLiveModel("gpt-live-1.1-2026-10-15"), { id: "gpt-live-1.1-2026-10-15", major: 1, minor: 1, date: "2026-10-15", variant: null });
  assert.deepEqual(parseLiveModel("gpt-live-2"), { id: "gpt-live-2", major: 2, minor: 0, date: null, variant: null });
  assert.deepEqual(parseLiveModel("gpt-live-1.1-mini-2026-11-01"), { id: "gpt-live-1.1-mini-2026-11-01", major: 1, minor: 1, date: "2026-11-01", variant: "mini" });
  assert.equal(parseLiveModel("gpt-live-transcribe"), null, "no version");
  assert.equal(parseLiveModel("gpt-live-2026-10-15"), null, "a bare date is not version 2026");
  assert.equal(parseLiveModel("gpt-realtime-2"), null);
  assert.equal(parseLiveModel(null), null);
  assert.equal(isLiveConversationModel("gpt-live-1-transcribe"), false);
  assert.equal(isLiveConversationModel("gpt-live-1.1-mini"), true);
});

test("pickLiveModel: the highest version; transcribe excluded; mini only when alone; alias over snapshot", () => {
  assert.equal(pickLiveModel(["gpt-live-1"]), "gpt-live-1");
  assert.equal(pickLiveModel(["gpt-live-1", "gpt-live-1.1"]), "gpt-live-1.1");
  assert.equal(pickLiveModel(["gpt-live-1", "gpt-live-1.1-2026-10-15"]), "gpt-live-1.1-2026-10-15");
  assert.equal(pickLiveModel(["gpt-live-1.1-2026-10-15", "gpt-live-1.1", "gpt-live-1"]), "gpt-live-1.1", "the alias tracks the newest snapshot");
  assert.equal(pickLiveModel(["gpt-live-1.1-2026-10-15", "gpt-live-1.1-2026-12-01"]), "gpt-live-1.1-2026-12-01");
  assert.equal(pickLiveModel(["gpt-live-1.1", "gpt-live-2", "gpt-live-1.10"]), "gpt-live-2");
  assert.equal(pickLiveModel(["gpt-live-1.9", "gpt-live-1.10"]), "gpt-live-1.10", "numeric, not string, order");
  assert.equal(pickLiveModel(["gpt-live-1", "gpt-live-transcribe", "gpt-live-2-transcribe"]), "gpt-live-1", "transcribe is never chosen");
  assert.equal(pickLiveModel(["gpt-live-1", "gpt-live-2-mini"]), "gpt-live-1", "a full model beats a newer mini");
  assert.equal(pickLiveModel(["gpt-live-2-mini", "gpt-live-transcribe"]), "gpt-live-2-mini", "mini when it is the only option");
  // GPT-Live 1.1 ships with a smaller "Quip" sibling in ChatGPT (2026-10-15): a variant.
  assert.equal(pickLiveModel(["gpt-live-1", "gpt-live-1.1-quip", "gpt-live-1.1"]), "gpt-live-1.1");
  assert.equal(pickLiveModel(["gpt-live-1", "gpt-live-1.1-quip"]), "gpt-live-1", "the full model beats a newer quip");
  assert.equal(pickLiveModel(["gpt-live-transcribe", "gpt-4o"]), DEFAULT_LIVE_MODEL);
  assert.equal(pickLiveModel([]), DEFAULT_LIVE_MODEL);
  assert.equal(pickLiveModel(["gpt-live-1", "gpt-live-1.1"], { exclude: ["gpt-live-1.1"] }), "gpt-live-1");
});

test("modelLabel and normalizeModelPref", () => {
  assert.equal(modelLabel("gpt-live-1"), "GPT-Live 1");
  assert.equal(modelLabel("gpt-live-1.1"), "GPT-Live 1.1");
  assert.equal(modelLabel("gpt-live-1.1-2026-10-15"), "GPT-Live 1.1");
  assert.equal(modelLabel("gpt-live-2-mini"), "GPT-Live 2 mini");
  assert.equal(normalizeModelPref("auto"), "auto");
  assert.equal(normalizeModelPref(" GPT-Live-1.1 "), "gpt-live-1.1");
  assert.equal(normalizeModelPref("gpt-live-transcribe"), null);
  assert.equal(normalizeModelPref("gpt-4o"), null);
  assert.equal(normalizeModelPref(""), null);
  assert.equal(modelChangeGreeting("GPT-Live 1.1"), `In one short sentence, fully in character and in the first person, tell the user you've moved to GPT-Live 1.1, for example "I've moved to GPT-Live 1.1." Then stop and listen.`);
});

test("parseVoiceError: an invalid-voice error and the voices it lists", () => {
  const m = "Invalid value: 'zephyr'. Supported values are: 'alloy', 'ash', 'marin', 'soleil', and 'hana'.";
  assert.deepEqual(parseVoiceError(`audio.output.voice: ${m}`, { tried: "zephyr" }), { invalid: true, voices: ["alloy", "ash", "marin", "soleil", "hana"] });
  assert.deepEqual(parseVoiceError("Voice 'zephyr' is not supported for this model."), { invalid: true, voices: ["zephyr"] });
  assert.deepEqual(parseVoiceError("The model 'gpt-live-9' does not exist"), { invalid: false, voices: [] });
  assert.deepEqual(parseVoiceError(""), { invalid: false, voices: [] });
});

function selector({ fetchImpl, key = "sk-test", file, pref = "auto" } = {}) {
  const clock = createFakeClock();
  const log = createMemoryLogger();
  const dir = tmpDir("clv-models-");
  const s = new ModelSelector({ file: file || path.join(dir, "live-model.json"), voicesFile: path.join(dir, "voices-extra"), base: () => "https://api.test/v1", getApiKey: () => key, getPref: () => pref, fetchImpl, clock, log });
  return { s, clock, log, dir };
}

test("ModelSelector: refresh chooses, caches in D, and logs live.model {chosen, available, previous}", async () => {
  let ids = ["gpt-live-1", "gpt-live-transcribe", "gpt-4o"];
  const calls = [];
  const { s, log, dir } = selector({ fetchImpl: async (url, init) => { calls.push({ url, auth: init.headers.Authorization }); return list(...ids); } });
  assert.equal(s.forSession(), "gpt-live-1", "nothing checked yet");
  assert.equal(await s.refresh("start"), "gpt-live-1");
  assert.deepEqual(calls, [{ url: "https://api.test/v1/models", auth: "Bearer sk-test" }]);
  ids = ["gpt-live-1", "gpt-live-1.1", "gpt-live-transcribe"];
  assert.equal(await s.refresh("interval"), "gpt-live-1.1");
  const ev = log.find("live.model");
  assert.deepEqual(ev.map((e) => [e.chosen, e.previous]), [["gpt-live-1", null], ["gpt-live-1.1", "gpt-live-1"]]);
  assert.deepEqual(ev[1].available, ["gpt-live-1", "gpt-live-1.1", "gpt-live-transcribe"]);
  assert.equal(s.forSession(), "gpt-live-1.1");
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "live-model.json"), "utf8"));
  assert.equal(saved.chosen, "gpt-live-1.1");
  // A new daemon reads the cache before its own check.
  const again = selector({ fetchImpl: async () => { throw new Error("offline"); }, file: path.join(dir, "live-model.json") });
  assert.equal(again.s.forSession(), "gpt-live-1.1");
});

test("ModelSelector: any error keeps the cached choice, else gpt-live-1; no key, no request", async () => {
  let fail = null;
  const { s, log } = selector({ fetchImpl: async () => { if (fail) return fail(); return list("gpt-live-1", "gpt-live-2"); } });
  fail = async () => { throw new Error("ECONNREFUSED"); };
  assert.equal(await s.refresh(), DEFAULT_LIVE_MODEL, "no cache: gpt-live-1");
  fail = null;
  assert.equal(await s.refresh(), "gpt-live-2");
  for (const f of [async () => { throw new Error("ECONNRESET"); }, async () => ({ status: 500, text: async () => "{}" }), async () => ({ status: 200, text: async () => "not json" })]) {
    fail = f;
    assert.equal(await s.refresh(), "gpt-live-2", "the cached choice stays");
  }
  assert.equal(log.find("live.model_error").length, 4);
  const nokey = selector({ key: null, fetchImpl: async () => { throw new Error("must not be called"); } });
  assert.equal(await nokey.s.refresh(), DEFAULT_LIVE_MODEL);
  assert.equal(nokey.log.find("live.model_error").length, 0);
});

test("ModelSelector: a pinned id wins; a demoted model falls back to gpt-live-1 and is retried after a day", async () => {
  const { s, clock } = selector({ fetchImpl: async () => list("gpt-live-1", "gpt-live-1.1") });
  await s.refresh();
  assert.equal(s.forSession(), "gpt-live-1.1");
  assert.equal(s.demote("gpt-live-1.1", "model not available"), true);
  assert.equal(s.forSession(), DEFAULT_LIVE_MODEL);
  assert.equal(await s.refresh(), DEFAULT_LIVE_MODEL, "a check skips it too");
  assert.equal(s.demote(DEFAULT_LIVE_MODEL), false, "nothing below gpt-live-1");
  await clock.advance(24 * 60 * 60 * 1000);
  assert.equal(s.forSession(), DEFAULT_LIVE_MODEL, "cached choice is still gpt-live-1 until the next check");
  assert.equal(await s.refresh(), "gpt-live-1.1");
  const pinned = selector({ pref: "gpt-live-1", fetchImpl: async () => list("gpt-live-1", "gpt-live-2") });
  await pinned.s.refresh();
  assert.equal(pinned.s.forSession(), "gpt-live-1");
  assert.equal(pinned.s.info().chosen, "gpt-live-2", "auto's choice is still recorded");
});

test("ModelSelector: the announcement is due once per change; the first model is recorded silently", () => {
  const { s } = selector({ fetchImpl: async () => list() });
  assert.equal(s.announcement("gpt-live-1"), null);
  assert.equal(s.announcement("gpt-live-1"), null);
  assert.equal(s.announcement("gpt-live-1.1"), "GPT-Live 1.1");
  s.markAnnounced("gpt-live-1.1");
  assert.equal(s.announcement("gpt-live-1.1"), null);
});

test("validateKey: a project with only gpt-live-1.1 passes; transcribe alone does not", async () => {
  const f = (...ids) => async () => list(...ids);
  assert.deepEqual(await validateKey({ base: "https://api.test/v1", key: "sk-x", fetchImpl: f("gpt-live-1.1", "gpt-live-transcribe") }), { ok: true });
  assert.deepEqual(await validateKey({ base: "https://api.test/v1", key: "sk-x", fetchImpl: f("gpt-live-2-2027-01-01") }), { ok: true });
  const r = await validateKey({ base: "https://api.test/v1", key: "sk-x", fetchImpl: f("gpt-live-transcribe", "gpt-4o") });
  assert.equal(r.code, "no_model_access");
  assert.match(r.message, /gpt-live-1/);
  assert.equal((await validateKey({ base: "https://api.test/v1", key: "sk-x", fetchImpl: f("gpt-live-1"), model: "gpt-live-1.1" })).code, "no_model_access", "a pinned model must be listed");
});

const session = (h, i = -1) => h.fetchCalls.filter((c) => /\/live\/sessions$/.test(c.url)).at(i)?.body.session;

test("daemon: start checks /models and the session uses the newest; never switches mid-session; the next session announces once", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  await h.voice.models.refreshing;
  assert.equal(h.log.find("live.model")[0].chosen, "gpt-live-1");
  const ws1 = await h.goLive();
  assert.equal(session(h).model, "gpt-live-1");
  assert.ok(!appends(ws1, "instructions").some((e) => /moved to/.test(e.content)), "the first model is not announced");
  // GPT-Live 1.1 appears in the API while the session runs.
  h.models = ["gpt-live-1", "gpt-live-1.1", "gpt-live-transcribe"];
  await h.voice.models.refresh("interval");
  assert.equal(h.log.find("live.model").at(-1).chosen, "gpt-live-1.1");
  assert.equal(h.voice.live.model, "gpt-live-1", "the running session keeps its model");
  assert.match(h.voice.control({ action: "status" }).message, /\| model gpt-live-1 \|/);
  assert.match(h.voice.control({ action: "model" }).message, /^sotto: model auto \(.*\); the next session uses gpt-live-1\.1; this session runs on gpt-live-1\./);
  assert.equal(appends(ws1, "instructions").filter((e) => /moved to/.test(e.content)).length, 0);
  // The next session runs on 1.1 and says so once, in persona.
  const n = h.fetchCalls.length;
  const r = await h.voice.createSession({ sdp: "v=0 offer", reason: "start" });
  assert.equal(r.status, 201);
  assert.equal(h.fetchCalls.length, n + 1);
  assert.equal(session(h).model, "gpt-live-1.1");
  const ws2 = h.WS.last();
  ws2.open();
  ws2.receive({ type: "session.started", session: { id: r.body.session_id, expires_at: Math.floor(h.clock.now() / 1000) + 7200 } });
  const said = appends(ws2, "instructions").filter((e) => /moved to GPT-Live 1\.1/.test(e.content));
  assert.equal(said.length, 1);
  assert.equal(said[0].content, modelChangeGreeting("GPT-Live 1.1", "proj-a"));
  assert.equal(h.log.find("live.model_announced")[0].model, "gpt-live-1.1");
  // Another session on the same model: no announcement.
  const r3 = await h.voice.createSession({ sdp: "v=0 offer", reason: "start" });
  const ws3 = h.WS.last();
  ws3.open();
  ws3.receive({ type: "session.started", session: { id: r3.body.session_id, expires_at: Math.floor(h.clock.now() / 1000) + 7200 } });
  assert.equal(appends(ws3, "instructions").filter((e) => /moved to/.test(e.content)).length, 0);
});

test("daemon: a start refused for its model is retried on gpt-live-1 at once", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  h.models = ["gpt-live-1", "gpt-live-1.1"];
  await h.voice.models.refreshing;
  await h.voice.models.refresh("test");
  const ok = h.fetchImpl;
  h.setFetch(async (url, init) => {
    if (init?.method !== "GET" && JSON.parse(init.body).session.model === "gpt-live-1.1") {
      h.fetchCalls.push({ url, init, body: JSON.parse(init.body) });
      return { status: 400, text: async () => JSON.stringify({ error: { message: "The model `gpt-live-1.1` does not exist or you do not have access to it." } }) };
    }
    return ok(url, init);
  });
  h.on();
  const r = await h.voice.createSession({ sdp: "v=0 offer", reason: "start" });
  assert.equal(r.status, 201);
  assert.deepEqual(h.fetchCalls.filter((c) => /live\/sessions$/.test(c.url)).map((c) => c.body.session.model), ["gpt-live-1.1", "gpt-live-1"]);
  assert.equal(h.voice.live.model, "gpt-live-1");
  assert.equal(h.log.find("live.model_demoted")[0].model, "gpt-live-1.1");
});

test("daemon: an invalid voice falls back to the persona's voice, then marin; the voices it lists show as new", async (t) => {
  const h = await makeHarness();
  t.after(() => { setExtraVoices([]); return h.cleanup(); });
  await h.voice.models.refreshing;
  h.voice.control({ action: "voice", voice: "cedar" });
  const ok = h.fetchImpl;
  h.setFetch(async (url, init) => {
    if (init?.method !== "GET" && JSON.parse(init.body).session.audio.output.voice === "cedar") {
      h.fetchCalls.push({ url, init, body: JSON.parse(init.body) });
      return { status: 400, text: async () => JSON.stringify({ error: { message: "Invalid value for 'audio.output.voice': 'cedar'. Supported values are: 'alloy', 'marin', 'soleil', 'hana'." } }) };
    }
    return ok(url, init);
  });
  h.on();
  const r = await h.voice.createSession({ sdp: "v=0 offer", reason: "start" });
  assert.equal(r.status, 201);
  assert.deepEqual(h.fetchCalls.filter((c) => /live\/sessions$/.test(c.url)).map((c) => c.body.session.audio.output.voice), ["cedar", "marin"], "persona sotto's own voice is marin");
  assert.deepEqual(h.log.find("voice.fallback").map((e) => [e.voice, e.to, e.model]), [["cedar", "marin", "gpt-live-1"]]);
  const v = h.voice.voices();
  assert.deepEqual([...v.new].sort(), ["hana", "soleil"], "alloy and marin are already known");
  assert.ok(v.voices.includes("soleil") && v.voices.includes("hana"));
  assert.equal(v.info.soleil.presentation, "new");
  assert.equal(v.info.soleil.description, "");
  assert.equal(fs.readFileSync(path.join(h.dataDir, "voices-extra"), "utf8").trim().split(" ").sort().join(" "), "hana soleil");
  // A reported voice is a valid choice.
  assert.equal(h.voice.control({ action: "voice", voice: "soleil" }).ok, true);
});

test("daemon: /talk model sets auto or a pinned id in prefs.json; a running session keeps its model", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  await h.voice.models.refreshing;
  // Checked again every 6 h.
  const checks = h.log.find("live.model").length;
  await h.clock.advance(MODEL_REFRESH_MS);
  await h.voice.models.refreshing;
  assert.equal(h.log.find("live.model").length, checks + 1);
  assert.equal(h.log.find("live.model").at(-1).reason, "interval");
  await h.goLive();
  const r = h.voice.control({ action: "model", model: "gpt-live-1.1" });
  assert.equal(r.ok, true);
  assert.match(r.message, /^sotto: model set to gpt-live-1\.1\. The current session keeps its model; the next one uses gpt-live-1\.1\. gpt-live-1\.1 is not listed for this key/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dataDir, "prefs.json"), "utf8")).model, "gpt-live-1.1");
  assert.equal(h.voice.live.model, "gpt-live-1");
  assert.equal(h.voice.control({ action: "model", model: "gpt-4o" }).ok, false);
  assert.match(h.voice.control({ action: "model", model: "auto" }).message, /^sotto: model set to auto\./);
});
