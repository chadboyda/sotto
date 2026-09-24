#!/usr/bin/env node
// End-to-end: the voice must not hear itself, and full duplex must survive
// (SPEC §6.8.1, §7.7), against the REAL gpt-live-1.
//
// The page simulates speakers with no working echo canceller
// (?echo_sim_db=<gain>: the model's own voice is mixed back into the mic
// 40 ms later), so gpt-live-1 hears its greeting and its answers. The fake mic
// (TTS) asks it to count slowly to thirty (long, steady speech), then talks
// over the count ("Hey, can you ask Claude what files are in this project?"). Checks:
//   - no echo reaches Claude (no inbox message carries the assistant's words),
//   - the barge-in reaches Claude and the input transcript has its words,
//   - the page measured the echo, and the guard engaged (auto/on) or not (off),
// and reports: leak, double-talk transcript accuracy, how fast the assistant
// yielded to the barge-in, and its backchannels while the user talked.
//
// Tests are silent: Chrome runs through test/helpers/silent-chrome.js
// (--mute-audio, fake mic); the "echo" is mixed inside the page, never played.
//
//   npm run e2e:echo                           one session: echo -10 dB, guard auto (~35 billed s)
//   SOTTO_E2E_ECHO_MATRIX=1 npm run e2e:echo   no echo, then echo with guard off / auto / on (~4 sessions)
//   SOTTO_E2E_ECHO_SIM_DB=-10  SOTTO_E2E_ECHO_GUARD=auto  SOTTO_E2E_ECHO_REPEAT=2  SOTTO_E2E_KEEP=1
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startFakeInbox } from "../helpers/fake-inbox.js";
import { CHROME, spawnSilentChrome } from "../helpers/silent-chrome.js";
import { resolveApiKey } from "../../daemon/config.js";
import { normalizeWords } from "../../daemon/transcript.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const STORY = path.join(REPO, "test", "fixtures", "ask-count.wav"); // "Please count slowly from one to thirty for me."
const BARGE = path.join(REPO, "test", "fixtures", "ask-files.wav"); // "Hey, can you ask Claude what files are in this project?"
const STORY_TEXT = "Please count slowly from one to thirty for me.";
const BARGE_TEXT = "Hey, can you ask Claude what files are in this project?";
const LEAD_MS = 7000; // greeting (and its echo)
const BARGE_AFTER_MS = 5600; // from the start of the counting request (4.2 s long): about two numbers into the count
const LIVE_BUDGET_MS = 70_000;
const BASE_PORT = Number(process.env.SOTTO_E2E_ECHO_PORT || 47880);

const SIM = process.env.SOTTO_E2E_ECHO_SIM_DB === undefined ? -10 : Number(process.env.SOTTO_E2E_ECHO_SIM_DB);
const BASE_SCENARIOS = process.env.SOTTO_E2E_ECHO_MATRIX === "1"
  ? [{ name: "no echo, guard off", sim: null, guard: "off" }, { name: `echo ${SIM} dB, guard off`, sim: SIM, guard: "off" },
     { name: `echo ${SIM} dB, guard auto`, sim: SIM, guard: "auto" }, { name: `echo ${SIM} dB, guard on`, sim: SIM, guard: "on" }]
  : [{ name: `echo ${SIM} dB, guard ${process.env.SOTTO_E2E_ECHO_GUARD || "auto"}`, sim: SIM, guard: process.env.SOTTO_E2E_ECHO_GUARD || "auto" }];
// SOTTO_E2E_ECHO_REPEAT=n runs every scenario n times (the model varies run to run).
const REPEAT = Math.max(1, Math.min(5, Number(process.env.SOTTO_E2E_ECHO_REPEAT) || 1));
const SCENARIOS = Array.from({ length: REPEAT }, (_, r) => BASE_SCENARIOS.map((s) => (REPEAT > 1 ? { ...s, name: `${s.name} #${r + 1}` } : s))).flat();

const results = [];
const report = [];
const log = (...a) => console.log("[e2e-echo]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " - " + detail : ""}`);
  return !!ok;
}
function warn(name, detail) {
  results.push({ name, ok: true, warn: true, detail });
  log(`WARN ${name}${detail ? " - " + detail : ""}`);
}
async function until(fn, ms, every = 200) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

/** Fraction of `want`'s words found in order in `got` (a simple transcript accuracy). */
const NUM = { one: "1", two: "2", three: "3", four: "4", five: "5", ten: "10", twenty: "20", thirty: "30" };
const norm = (t) => normalizeWords(t).map((x) => NUM[x] || x);
function inOrderRecall(want, got) {
  const w = norm(want);
  const g = norm(got);
  let j = 0;
  let hit = 0;
  for (const x of w) {
    let k = j;
    while (k < g.length && g[k] !== x) k++;
    if (k < g.length) { hit++; j = k + 1; }
  }
  return w.length ? hit / w.length : 0;
}
/** Speech onsets (ms) in a mono PCM16 WAV: the first loud 10 ms block at or after each `fromMs`. */
function onsetsMs(file, fromList, dbfs = -40) {
  const b = fs.readFileSync(file);
  let off = 12;
  let rate = 48000;
  let data = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const len = b.readUInt32LE(off + 4);
    if (id === "fmt ") rate = b.readUInt32LE(off + 12);
    if (id === "data") { data = b.subarray(off + 8, Math.min(b.length, off + 8 + len)); break; }
    off += 8 + len + (len & 1);
  }
  const n = Math.floor((data?.length || 0) / 2);
  const thr = 32768 * Math.pow(10, dbfs / 20);
  const blk = Math.round(rate / 100);
  return fromList.map((fromMs) => {
    for (let i = Math.round((fromMs / 1000) * rate); i + blk <= n; i += blk) {
      let s = 0;
      for (let k = 0; k < blk; k++) { const v = data.readInt16LE(2 * (i + k)); s += v * v; }
      if (Math.sqrt(s / blk) > thr) return (i / rate) * 1000;
    }
    return null;
  });
}
const ngrams = (words, n) => { const s = new Set(); for (let i = 0; i + n <= words.length; i++) s.add(words.slice(i, i + n).join(" ")); return s; };

async function runScenario(sc, idx) {
  const PORT = BASE_PORT + idx;
  const BASE = `http://127.0.0.1:${PORT}`;
  const SOCK = `/tmp/clv-e2e-echo-${process.pid}-${idx}.sock`;
  const INBOX_TOKEN = `e2e-echo-token-${process.pid}-${idx}`;
  const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clv-e2e-echo-")));
  const D = path.join(TMP, "data");
  let KEY = "";
  let chrome = null;
  let inbox = null;
  let liveSince = 0;
  let liveId = null;
  const row = { scenario: sc.name };
  const hdr = () => ({ "Content-Type": "application/json", "X-Sotto-Key": KEY });
  const status = async () => (await fetch(`${BASE}/status`, { headers: hdr() })).json();
  const readLog = () => {
    try {
      return fs.readFileSync(path.join(D, "logs", "daemon.log"), "utf8").split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  };
  const hookEnv = () => {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^CLAUDE_/.test(k) && !/^SOTTO_(MIRROR|ECHO_GUARD)$/.test(k)) env[k] = v;
    return Object.assign(env, {
      CLAUDE_PLUGIN_ROOT: REPO, CLAUDE_PLUGIN_DATA: D, CLAUDE_PLUGIN_OPTION_PORT: String(PORT),
      CLAUDE_PLUGIN_OPTION_DAILY_CAP_MINUTES: "10", CLAUDE_PLUGIN_OPTION_IDLE_SECONDS: "0", CLAUDE_PLUGIN_OPTION_ECHO_GUARD: sc.guard,
      CLAUDE_CODE_MESSAGING_SOCKET: SOCK, CLAUDE_CODE_MESSAGING_TOKEN: INBOX_TOKEN, CLAUDE_PROJECT_DIR: REPO,
      SOTTO_NO_BROWSER: "1", SOTTO_KEYCHAIN_SERVICE: `sotto-e2e-echo-${process.pid}`,
    });
  };
  const toggle = (arg) => {
    const input = JSON.stringify({
      session_id: "e2e-echo", transcript_path: "", cwd: REPO, prompt_id: "p", permission_mode: "default",
      hook_event_name: "UserPromptExpansion", expansion_type: "slash_command", command_name: "sotto:talk",
      command_args: arg, command_source: "plugin", prompt: `/sotto:talk ${arg}`.trim(),
    });
    const r = spawnSync(path.join(REPO, "scripts", "toggle.sh"), [], { input, encoding: "utf8", env: hookEnv(), timeout: 15000 });
    let out = null;
    try { out = JSON.parse(r.stdout); } catch { /* checked by caller */ }
    return { status: r.status, out };
  };
  const hook = (event, body) => spawnSync(path.join(REPO, "scripts", "hook.sh"), [event], { input: JSON.stringify(body), encoding: "utf8", env: hookEnv() });
  const tag = (n) => `[${sc.name}] ${n}`;

  const guard = setInterval(() => {
    if (!liveSince || Date.now() - liveSince < LIVE_BUDGET_MS) return;
    liveSince = 0;
    check(tag("finished within the Live budget"), false, `${LIVE_BUDGET_MS / 1000} s`);
    fetch(`${BASE}/control`, { method: "POST", headers: hdr(), body: JSON.stringify({ action: "shutdown" }) }).catch(() => {});
  }, 1000);
  guard.unref();

  try {
    // Mic: lead-in, the story request, then the barge-in over the story, tail.
    const wav = path.join(TMP, "mic.wav");
    const ff = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-i", STORY, "-i", BARGE, "-filter_complex",
      `[0]aresample=48000,aformat=channel_layouts=mono,adelay=${LEAD_MS}:all=1,apad=whole_dur=${(LEAD_MS + BARGE_AFTER_MS) / 1000}[a];` +
      "[1]aresample=48000,aformat=channel_layouts=mono,apad=pad_dur=30[b];[a][b]concat=n=2:v=0:a=1",
      "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
    if (!check(tag("fake-mic wav"), ff.status === 0 && fs.existsSync(wav), ff.stderr?.toString().slice(0, 200))) return row;

    let turn = 0;
    let chain = Promise.resolve();
    inbox = await startFakeInbox(SOCK, {
      onFrame: (f) => {
        if (f.type !== "user") return;
        const pid = `e2e-t${++turn}`;
        const content = f.message.content;
        const mirror = content.includes("(said to the voice assistant, not delegated)");
        chain = chain.then(async () => {
          hook("UserPromptSubmit", { session_id: "e2e-echo", prompt_id: pid, hook_event_name: "UserPromptSubmit", prompt: content });
          await sleep(800);
          hook("Stop", { session_id: "e2e-echo", prompt_id: pid, hook_event_name: "Stop", stop_hook_active: false,
            last_assistant_message: mirror ? "Noted." : "The project has a daemon folder, a web folder and the tests.", background_tasks: [], session_crons: [] });
        });
      },
    });
    const on = toggle("on");
    if (!check(tag("toggle.sh on"), on.status === 0 && /^sotto: voice ON \(/.test(on.out?.stopReason || ""), on.out?.stopReason)) return row;
    KEY = fs.readFileSync(path.join(D, "daemon.key"), "utf8").trim();
    const PAGE_SECRET = fs.readFileSync(path.join(D, "page.secret"), "utf8").trim();
    const NONCE = fs.readFileSync(path.join(D, "active"), "utf8").trim().split("\t")[3] || "";
    const s0 = await status();
    check(tag("echo_guard reaches the daemon"), s0.config?.echo_guard === sc.guard, s0.config?.echo_guard);

    const q = sc.sim === null ? "autostart=1" : `autostart=1&echo_sim_db=${sc.sim}`;
    chrome = spawnSilentChrome({ wav, extra: [`--user-data-dir=${path.join(TMP, "chrome")}`, `${BASE}/?${q}#k=${PAGE_SECRET}`] });
    const live = await until(async () => { const s = await status(); return s.state === "live" ? s : null; }, 25000);
    if (!check(tag("state live"), !!live)) return row;
    liveSince = Date.now();
    liveId = live.live.session_id;

    // Wait for the barge-in to be heard, then for its request to reach Claude.
    const heard = await until(() => /files|project/i.test(readLog().filter((e) => e.ev === "session.input_transcript.delta").map((e) => e.delta).join("")), LEAD_MS + BARGE_AFTER_MS + 20000);
    check(tag("barge-in heard"), !!heard);
    // The whole barge-in, not a fragment of it (a first guard cut "…iles are in this project").
    const reached = await until(() => inbox.frames.find((f) => f.type === "user" && inOrderRecall(BARGE_TEXT, f.message.content) >= 0.8), 16000);
    await sleep(7000); // the mirror (6 s) and any late delegation

    const L = readLog();
    const ins = L.filter((e) => e.ev === "session.input_transcript.delta");
    const outs = L.filter((e) => e.ev === "session.output_transcript.delta");
    const inText = ins.map((e) => e.delta).join("");
    const outText = outs.map((e) => e.delta).join("");
    log(`heard (input transcript): ${JSON.stringify(inText.trim().slice(0, 500))}`);
    log(`said (output transcript): ${JSON.stringify(outText.trim().slice(0, 500))}`);
    const users = inbox.frames.filter((f) => f.type === "user");
    for (const u of users) log(`inbox ${u.priority}: ${JSON.stringify(u.message.content.slice(0, 200))}`);

    // 1. No echo reached Claude: no 4-word run of the assistant's speech that the user did not also say.
    const userGrams = new Set([...ngrams(normalizeWords(STORY_TEXT), 4), ...ngrams(normalizeWords(BARGE_TEXT), 4)]);
    const outGrams = ngrams(normalizeWords(outText), 4);
    const leaks = [];
    for (const u of users) {
      const words = normalizeWords(u.message.content.split("\n")[0].replace(`[sotto voice ${NONCE}]`, "").replace("(said to the voice assistant, not delegated)", ""));
      for (const g of ngrams(words, 4)) if (outGrams.has(g) && !userGrams.has(g)) leaks.push(g);
    }
    check(tag("no echo of the assistant reached Claude"), leaks.length === 0, leaks.slice(0, 4).join(" | "));
    const echoDrops = L.filter((e) => (e.ev === "delegation.request" && (e.echo_lines || e.echo_words)) || (e.ev === "delegation" && e.to === "dropped_echo"));
    row.echo_filtered = echoDrops.length + L.filter((e) => e.ev === "mirror.skip" && e.dropped?.echo).length + L.filter((e) => (e.ev === "mirror.send" || e.ev === "mirror.skip") && e.dropped?.echo_words).length;

    // 2. The barge-in reached Claude and its words are in the transcript.
    check(tag("the barge-in over the assistant reached Claude"), !!reached, reached ? `${reached.priority} ${JSON.stringify(reached.message.content.slice(0, 120))}` : "no inbox message about the files");
    const bargeStart = ins.findIndex((e, i) => /\bhey\b|\bclaude\b|\bfiles?\b/i.test(e.delta) && ins.slice(i, i + 12).map((x) => x.delta).join("").match(/files|project/i));
    const onset = bargeStart >= 0 ? ins[bargeStart].start_ms : null;
    const window = bargeStart >= 0 ? ins.filter((e) => e.start_ms >= onset - 1000 && e.start_ms <= onset + 6000).map((e) => e.delta).join("") : "";
    row.barge_recall = inOrderRecall(BARGE_TEXT, window);
    check(tag("double talk: the barge-in's words are in the input transcript (≥ 80 %)"), row.barge_recall >= 0.8, `${(100 * row.barge_recall).toFixed(0)}%`);
    check(tag("the counting request is in the input transcript (≥ 80 %)"), inOrderRecall(STORY_TEXT, inText) >= 0.8);
    row.story_recall = inOrderRecall(STORY_TEXT, inText);

    // 3. How the assistant yielded. The barge-in's real onset on the session
    // timeline: the fixture's own timing, anchored at the story request's first
    // word as transcribed (ASR places a word's start at 200 ms steps).
    const [storyOn, bargeOn] = onsetsMs(wav, [LEAD_MS - 200, LEAD_MS + BARGE_AFTER_MS - 200]);
    const tell = ins.find((e) => /\b(?:please|count)\b/i.test(e.delta));
    const userOn = tell && storyOn !== null && bargeOn !== null ? tell.start_ms + (bargeOn - storyOn) : onset;
    const userEnd = bargeStart >= 0 ? Math.max(...ins.slice(bargeStart).filter((e) => e.start_ms < (userOn ?? 0) + 6000).map((e) => e.end_ms)) : null;
    row.barge_onset_ms = userOn;
    if (userOn !== null) {
      const talking = outs.filter((e) => e.start_ms <= userOn && e.end_ms >= userOn - 400);
      if (talking.length) {
        // The assistant's speech runs on while deltas keep coming < 600 ms apart.
        let stop = Math.max(...talking.map((e) => e.end_ms));
        for (const e of outs) if (e.start_ms > userOn && e.start_ms <= stop + 600 && e.start_ms < (userEnd ?? userOn)) stop = Math.max(stop, e.end_ms);
        row.yield_ms = stop - userOn;
      } else row.yield_ms = null; // not talking at the onset
      // Self-interruption: the assistant's speech before the barge-in stopped
      // mid-sentence (no final punctuation) and stayed quiet ≥ 1 s before it.
      const before = outs.filter((e) => e.start_ms < userOn - 1000 && e.start_ms > (tell?.start_ms ?? 0));
      const lastBefore = before[before.length - 1];
      row.self_interrupted = !!lastBefore && !talking.length && !/[.!?…]["'”’]?\s*$/.test(lastBefore.delta) && userOn - lastBefore.end_ms >= 1000;
      const during = outs.filter((e) => e.start_ms > userOn && e.start_ms < (userEnd ?? userOn + 3000)).map((e) => e.delta).join("");
      row.backchannels = (during.match(/\b(mm+-?hm+|uh-huh|mhm|yeah|okay|right)\b/gi) || []).length;
      row.assistant_during_barge = during.trim().slice(0, 120);
    }

    // 4. The page measured the echo; the guard followed its mode.
    const leakEv = L.filter((e) => e.ev === "echo.leak");
    const guardEv = L.filter((e) => e.ev === "echo.guard");
    const measuring = L.some((e) => e.ev === "page.log" && /echo: measuring/.test(e.message || ""));
    check(tag("page measures echo (worklet running)"), measuring && (sc.sim === null || leakEv.length > 0), `${leakEv.length} leak reports`);
    const rank = { high: 3, some: 2, low: 1, unknown: 0 };
    const worst = leakEv.reduce((m, e) => (e.leak_db != null && (m === null || rank[e.level] > rank[m.level] || (rank[e.level] === rank[m.level] && e.leak_db > m.leak_db)) ? e : m), null);
    row.leak = worst ? `${worst.level} ${worst.leak_db} dB corr ${worst.corr}` : "none";
    const engaged = guardEv.find((e) => e.engaged === true);
    const liveAt = Date.parse(L.find((e) => e.ev === "state" && e.to === "live")?.ts || "") || liveSince;
    row.guard = engaged ? `on (${engaged.reason}) ${((Date.parse(engaged.ts) - liveAt) / 1000).toFixed(1)} s after live` : "off";

    const heardSelf = L.filter((e) => e.ev === "echo.heard");
    row.heard_self = heardSelf.length;
    if (sc.guard === "off") check(tag("guard off never engages"), !engaged);
    else if (sc.guard === "on") check(tag("guard on engages"), !!engaged);
    // auto: only with the model demonstrably hearing itself (§7.7), never on a leak alone.
    else check(tag("guard auto engages only when the model heard itself"), !engaged || heardSelf.some((e) => Date.parse(e.ts) <= Date.parse(engaged.ts)), `${row.guard}; model heard itself ${heardSelf.length}x`);
    if (sc.sim !== null) check(tag("measured leak is high"), leakEv.some((e) => e.level === "high"), row.leak);

    const off = toggle("off");
    check(tag("toggle.sh off"), off.status === 0 && /^sotto: voice OFF\./.test(off.out?.stopReason || ""), off.out?.stopReason);
    const closed = await until(() => readLog().find((e) => e.ev === "session.closed" && e.live_id === liveId), 20000);
    row.billed_s = closed?.seconds ?? null;
    const summary = await until(() => readLog().filter((e) => e.ev === "echo.leak" && e.mode === "summary").pop(), 3000);
    row.attenuated_pct = summary?.attenuated_pct ?? null;
    const raw = fs.readFileSync(path.join(D, "logs", "daemon.log"), "utf8");
    const apiKey = resolveApiKey({ env: process.env, pluginRoot: REPO });
    check(tag("daemon log has no API key, inbox token or daemon key"), !raw.includes(apiKey) && !raw.includes(INBOX_TOKEN) && !raw.includes(KEY));
    return row;
  } finally {
    clearInterval(guard);
    try {
      const h = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(500) }).then((r) => r.json());
      if (h.name === "sotto" && h.state !== "off") {
        await fetch(`${BASE}/control`, { method: "POST", headers: hdr(), body: JSON.stringify({ action: "shutdown" }) }).catch(() => {});
        await sleep(3000);
      }
    } catch { /* gone */ }
    if (chrome) { try { chrome.kill("SIGTERM"); } catch { /* ignore */ } }
    let pid = null;
    try { pid = Number(fs.readFileSync(path.join(D, "daemon.pid"), "utf8").trim()) || null; } catch { /* none */ }
    if (pid) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
    await sleep(500);
    if (chrome) { try { chrome.kill("SIGKILL"); } catch { /* ignore */ } }
    if (inbox) await inbox.close().catch(() => {});
    try { fs.unlinkSync(SOCK); } catch { /* ignore */ }
    if (process.env.SOTTO_E2E_KEEP === "1") log(`kept ${TMP}`);
    else fs.rmSync(TMP, { recursive: true, force: true });
  }
}

const missing = [];
if (!fs.existsSync(CHROME)) missing.push("Google Chrome");
if (spawnSync("which", ["ffmpeg"]).status !== 0) missing.push("ffmpeg");
if (!resolveApiKey({ env: process.env, pluginRoot: REPO })) missing.push("OPENAI_API_KEY");
if (!fs.existsSync(STORY) || !fs.existsSync(BARGE)) missing.push("fixtures");
if (missing.length) {
  log(`SKIP: missing ${missing.join(", ")}`);
  process.exitCode = 2;
} else {
  for (const [i, sc] of SCENARIOS.entries()) {
    try {
      report.push(await runScenario(sc, i));
    } catch (e) {
      check(`[${sc.name}] no exceptions`, false, String(e && e.stack || e));
    }
  }
  log("---- report");
  for (const r of report) {
    log(`${r.scenario}: leak ${r.leak}; guard ${r.guard}; attenuated ${r.attenuated_pct == null ? "-" : r.attenuated_pct.toFixed(0) + "%"} of the assistant's speech; ` +
      `model transcribed its own voice ${r.heard_self ?? 0}x (echo filter), echo lines/words filtered ${r.echo_filtered ?? 0}x; ` +
      `double-talk accuracy (barge-in words heard) ${(100 * (r.barge_recall || 0)).toFixed(0)}%, counting request ${(100 * (r.story_recall || 0)).toFixed(0)}%; ` +
      `assistant stopped ${r.yield_ms == null ? "n/a (not talking at the onset)" : r.yield_ms + " ms"} after the barge-in onset, backchannels while the user talked ${r.backchannels ?? "-"} ` +
      `(${JSON.stringify(r.assistant_during_barge || "")}); cut itself off before the barge-in: ${r.self_interrupted ? "yes" : "no"}; billed ${r.billed_s ?? "?"} s`);
  }
  const failed = results.filter((r) => !r.ok);
  log(`${failed.length ? "FAIL" : "PASS"}: ${results.filter((r) => r.ok && !r.warn).length} passed, ${failed.length} failed, ${results.filter((r) => r.warn).length} warnings`);
  if (failed.length) process.exitCode = 1;
}
