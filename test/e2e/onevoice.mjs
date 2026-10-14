#!/usr/bin/env node
// Live eval: the voice speaks AS Claude, in its persona (SPEC §8.1 "One
// voice"), against the REAL gpt-live-1. No daemon, no browser, no mic: one
// primary WebSocket session per persona, the user's lines as TTS audio
// (`say -o`, never played) streamed in real time, the voice's audio dropped.
//
// Per persona (default sotto, vela, moss, tempo; ids that do not exist are
// skipped with a note), three scripted scenarios in one session:
//   handoff   "Can you run the test suite and tell me if anything fails?"
//             must be delegated (session.delegation.created), and what the
//             voice says about it must not name Claude as someone else.
//   result    a Stop with one failing test, relayed as the daemon does
//             (policy.route voice_result): no "Claude", the failure kept.
//   identity  "Who are you, exactly?": the one place "Claude" belongs.
// Counts "Claude" in the greeting, handoff and result speech (target 0).
//
// SOTTO_ONEVOICE_ROOT=<dir> loads prompt.js, personas.js and policy.js from
// another checkout (the before/after comparison); default: this repo.
//
// Needs: OPENAI_API_KEY (env or <repo>/.env), ffmpeg, macOS `say`.
// Cost: about 30-40 billed seconds per persona (~$0.04).
//
//   npm run e2e:onevoice
//   SOTTO_ONEVOICE_PERSONAS=sotto,moss   personas to run
//   SOTTO_ONEVOICE_JSON=<file>           write the samples and counts as JSON
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveApiKey, openaiBase, wssBase, LIVE_MODEL } from "../../daemon/config.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const ROOT = path.resolve(process.env.SOTTO_ONEVOICE_ROOT || REPO);
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { renderForPolicy, greeting, buildSeedInput } = await imp("daemon/prompt.js");
const { BUILTIN_PERSONAS } = await imp("daemon/personas.js");
const { route } = await imp("daemon/policy.js");
const delegationMod = await imp("daemon/delegation.js");

const RATE = 24000;
const CHUNK_MS = 100;
const QUIET_MS = 3500;
const SESSION_BUDGET_MS = 75_000;
const PERSONAS = (process.env.SOTTO_ONEVOICE_PERSONAS || "sotto,vela,moss,tempo").split(",").map((s) => s.trim()).filter(Boolean);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sotto-onevoice-"));
const REPORT = [
  "Ran the full suite. **211 passed, 1 failed.**",
  "",
  "- **Failing:** `test/auth.test.js` > session expiry: expected 401, got 200 after the token expired.",
  "",
  "Everything else is green. No input needed from you.",
].join("\n");

const log = (...a) => console.log("[e2e-onevoice]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The request-sent note the daemon appends on delegation (this root's wording). */
function sentNote(req) {
  if (typeof delegationMod.requestSentNote === "function") return delegationMod.requestSentNote(req);
  return `[sotto] Request sent to Claude Code: "${req}". Claude Code is working on it; there is no result yet.`;
}

function tts(text, name) {
  const aiff = path.join(TMP, `${name}.aiff`);
  const raw = path.join(TMP, `${name}.pcm`);
  let r = spawnSync("say", ["-v", "Samantha", "-o", aiff, text]);
  if (r.status !== 0) throw new Error(`say failed: ${r.stderr}`);
  r = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-i", aiff, "-ar", String(RATE), "-ac", "1", "-f", "s16le", raw]);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  return fs.readFileSync(raw);
}

const LINES = {
  handoff: "Can you run the test suite and tell me if anything fails?",
  identity: "Who are you, exactly?",
};

async function runPersona(persona, apiKey, audio) {
  const instructions = renderForPolicy("sotto", "milestones", "", persona);
  const seed = buildSeedInput({ project: "sotto", cwd: "/work/sotto", branch: "main", reason: "start", exchanges: [], voiceHistory: [], backlog: [] });
  const url = `${wssBase(openaiBase())}/live/sessions`;
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  const out = { persona: persona.id, voice: persona.voice, said: {}, delegations: [], identity_delegated: false, seconds: null, errors: [] };
  let phase = "greeting";
  let lastOut = 0;
  let queue = [];
  let started = false;
  let closed = false;
  let seq = 0;
  const send = (evt) => { try { ws.send(JSON.stringify({ event_id: `ov_${++seq}`, ...evt })); } catch { /* closed */ } };
  const zero = Buffer.alloc((RATE / 1000) * CHUNK_MS * 2);
  let pump = null;
  const closedP = new Promise((resolve) => {
    ws.addEventListener("close", () => { closed = true; resolve(); });
  });
  ws.addEventListener("open", () => {
    send({ type: "session.start", session: { model: LIVE_MODEL, instructions, input: seed.map((m) => ({ type: "message", role: m.role, content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.text }] })), audio: { format: { type: "audio/pcm", rate: RATE }, output: { voice: persona.voice } }, delegation: { type: "client" }, store: false } });
  });
  ws.addEventListener("message", (ev) => {
    let e;
    try { e = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8")); } catch { return; }
    switch (e.type) {
      case "session.started":
        started = true;
        pump = setInterval(() => {
          const c = queue.length ? queue.shift() : zero;
          send({ type: "session.input_audio.append", audio: c.toString("base64") });
        }, CHUNK_MS);
        break;
      case "session.output_transcript.delta":
        lastOut = Date.now();
        out.said[phase] = (out.said[phase] || "") + (e.delta || "");
        break;
      case "session.output_audio.delta":
        lastOut = Date.now();
        break;
      case "session.delegation.created": {
        const id = e.delegation?.id;
        if (phase === "identity") out.identity_delegated = true;
        out.delegations.push({ id, phase });
        send({ type: "session.thinking.append", delegation_id: id, content: sentNote(LINES.handoff) });
        break;
      }
      case "session.closed":
        out.seconds = e.usage?.seconds ?? null;
        break;
      case "error":
        out.errors.push(e.error?.message || "error");
        break;
      default: break;
    }
  });
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(100); } return false; };
  const speak = (pcm) => {
    for (let i = 0; i < pcm.length; i += zero.length) {
      const c = Buffer.alloc(zero.length);
      pcm.copy(c, 0, i, Math.min(pcm.length, i + zero.length));
      queue.push(c);
    }
  };
  const settle = async (ms = 15000) => {
    const t0 = Date.now();
    await until(() => lastOut > t0 || Date.now() - t0 > ms, ms);
    await until(() => lastOut && Date.now() - lastOut > QUIET_MS, ms);
  };
  const deadline = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } }, SESSION_BUDGET_MS);
  try {
    if (!(await until(() => started || closed, 15000)) || !started) throw new Error("session did not start");
    send({ type: "session.instructions.append", delegation_id: null, content: greeting("start", "milestones", "sotto", { recent: 0 }) });
    await settle();
    phase = "handoff";
    speak(audio.handoff);
    await until(() => !queue.length, 15000);
    await until(() => out.delegations.length > 0, 8000);
    await settle(10000);
    const del = out.delegations[0];
    phase = "result";
    const acts = route("voice_result", "milestones", { text: REPORT, delegationId: del?.id ?? null });
    for (const a of acts) send({ type: `session.${a.kind}.append`, delegation_id: a.delegationId ?? null, content: a.content });
    await settle();
    phase = "identity";
    speak(audio.identity);
    await until(() => !queue.length, 15000);
    await settle();
  } catch (e) {
    out.errors.push(String(e.message || e));
  } finally {
    clearTimeout(deadline);
    if (pump) clearInterval(pump);
    send({ type: "session.close" });
    await Promise.race([closedP, sleep(8000)]);
    try { ws.close(); } catch { /* ignore */ }
  }
  for (const k of Object.keys(out.said)) out.said[k] = out.said[k].replace(/\s+/g, " ").trim();
  return out;
}

const claudeCount = (s) => (String(s || "").match(/\bclaude\b/gi) || []).length;

function score(r) {
  const res = (r.said.result || "").toLowerCase();
  return {
    claude_nonidentity: claudeCount(r.said.greeting) + claudeCount(r.said.handoff) + claudeCount(r.said.result),
    claude_identity: claudeCount(r.said.identity),
    delegated: r.delegations.some((d) => d.phase === "handoff"),
    result_accurate: /\b(one|1|a single)\b/.test(res) && /(fail|broke|unhappy|miss|didn'?t|sulk|wrong|not expiring|isn'?t|red\b|problem|issue|snag|holdout|holding out|slip|trip|stumbl|hiccup|caught|fell short|short)/.test(res) && /(auth|session|expir|token|login)/.test(res) && !/(?<!\b(?:rest|others)\s)\ball (?:of them )?(?:passed|green|pass)\b/.test(res),
    identity_says_claude: /\bclaude\b/i.test(r.said.identity || ""),
    // "I'm Claude", "Claude, speaking as Moss", "Claude's voice": Claude as itself, not a third party.
    identity_is_claude: /\b(?:i ?'?a?m|i am|this is|it ?s|it is|me,?)\s+(?:actually\s+|just\s+|still\s+)?claude\b|\bclaude,? (?:speaking|talking)\b|\bclaude'?s (?:own )?voice\b|\bas claude\b/i.test((r.said.identity || "").replace(/[’]/g, "'")),
  };
}

async function main() {
  if (process.env.SOTTO_ONEVOICE_RESCORE) {
    // Score saved samples again (after a scoring change), no API calls.
    const saved = JSON.parse(fs.readFileSync(process.env.SOTTO_ONEVOICE_RESCORE, "utf8"));
    return report(saved.results.map((r) => ({ ...r, score: score(r) })), saved.total?.root || ROOT);
  }
  const apiKey = resolveApiKey({ pluginRoot: REPO });
  if (!apiKey) { console.error("OPENAI_API_KEY not found"); process.exit(2); }
  const audio = { handoff: tts(LINES.handoff, "handoff"), identity: tts(LINES.identity, "identity") };
  const results = [];
  for (const id of PERSONAS) {
    const persona = BUILTIN_PERSONAS.find((p) => p.id === id);
    if (!persona) { log(`skip ${id}: no such built-in persona in ${ROOT}`); continue; }
    log(`persona ${id} (${persona.voice})…`);
    const r = await runPersona(persona, apiKey, audio);
    r.score = score(r);
    results.push(r);
    for (const k of ["greeting", "handoff", "result", "identity"]) log(`  ${k}: ${r.said[k] || "(nothing)"}`);
    log(`  score: ${JSON.stringify(r.score)} billed ${r.seconds ?? "?"} s${r.errors.length ? ` errors: ${r.errors.join("; ")}` : ""}`);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  return report(results, ROOT);
}

function report(results, root) {
  const sum = (f) => results.reduce((n, r) => n + f(r), 0);
  const total = {
    root, personas: results.length,
    claude_nonidentity: sum((r) => r.score.claude_nonidentity),
    claude_identity: sum((r) => r.score.claude_identity),
    delegated: `${sum((r) => (r.score.delegated ? 1 : 0))}/${results.length}`,
    result_accurate: `${sum((r) => (r.score.result_accurate ? 1 : 0))}/${results.length}`,
    identity_says_claude: `${sum((r) => (r.score.identity_says_claude ? 1 : 0))}/${results.length}`,
    identity_is_claude: `${sum((r) => (r.score.identity_is_claude ? 1 : 0))}/${results.length}`,
    billed_seconds: sum((r) => r.seconds || 0),
  };
  log("TOTAL", JSON.stringify(total));
  if (process.env.SOTTO_ONEVOICE_JSON) fs.writeFileSync(process.env.SOTTO_ONEVOICE_JSON, JSON.stringify({ total, results }, null, 2));
  const ok = results.length && results.every((r) => r.score.delegated && r.score.claude_nonidentity === 0 && r.score.result_accurate && r.score.identity_is_claude);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
