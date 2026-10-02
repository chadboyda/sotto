#!/usr/bin/env node
// The Claude Code mod link end to end (SPEC §6.21), against a REAL headless
// Claude Code session (haiku, no OpenAI, no window):
//
//   claude -p --input-format stream-json --permission-mode bypassPermissions
//          --plugin-dir <repo> --setting-sources project,local
//
// and an in-process daemon bound to that session, on a scratch port, with the
// --plugin-dir data dir (~/.claude/plugins/data/sotto-inline) so the session's
// hooks, courier and mod all find it. Two runs:
//   mod      the mod links up by itself (hello), a voice message sent while
//            Claude is idle is submitted by the mod (receipt "submitted",
//            Claude answers it), one sent while Claude works in Bash is
//            appended to the running turn (receipt "appended" or "requeued"
//            then answered), and the daemon gets the session's events through
//            the ordered uplink (UserPromptSubmit, PreToolUse with tool_name
//            Bash from the adapter, Stop, turn start/complete). Both runs: a
//            typed turn holds a sleeping-capable voice awake and its reply
//            queues a notify wake (§6.20 F).
//   classic  SOTTO_INTEGRATION=classic keeps the mod inert: no hello, the same
//            message goes through the courier and the shell hooks, as in v0.4.9.
// Needs the CLI >= 2.1.287 on PATH and a signed-in Claude Code. Costs a few
// short haiku turns. Never prints a key or token.
//
//   node test/e2e/mod.mjs            (npm run e2e:mod)
//   SOTTO_E2E_ONLY=mod|classic       one run
//   SOTTO_E2E_KEEP=1                 keep the stream logs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDaemon } from "../../daemon/index.js";
import { createMemoryLogger } from "../../daemon/log.js";
import { voiceMarker } from "../../daemon/config.js";
import { createFakeKeychain } from "../helpers/fake-keychain.js";
import { freePort, makePluginRoot } from "../helpers/daemon-harness.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const D = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "plugins", "data", "sotto-inline");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = () => Math.random().toString(36).slice(2, 7).toUpperCase();
const ONLY = process.env.SOTTO_E2E_ONLY || "";

fs.mkdirSync(D, { recursive: true, mode: 0o700 });
const keyFile = path.join(D, "daemon.key");
let wroteKey = false;
if (!fs.existsSync(keyFile)) { fs.writeFileSync(keyFile, `e2e-${tag()}-${process.pid}\n`, { mode: 0o600 }); wroteKey = true; }
const KEY = fs.readFileSync(keyFile, "utf8").trim();
for (const f of ["daemon.pid", "active"]) {
  if (fs.existsSync(path.join(D, f))) { console.error(`FAIL ${path.join(D, f)} exists: another daemon uses the --plugin-dir data dir; stop it first`); process.exit(1); }
}

async function run(mode) {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `clv-mod-e2e-${mode}-`));
  const STREAM = path.join(TMP, "stream.jsonl");
  const log = createMemoryLogger({ debug: false });
  const port = await freePort();
  const root = makePluginRoot();
  const d = createDaemon({
    dataDir: D, port, pluginRoot: root, env: { SOTTO_KEYCHAIN_SERVICE: `sotto-e2e-mod-${process.pid}` }, keychain: createFakeKeychain(), daemonKey: KEY, log,
    chrome: { open() { return { mode: "chrome" }; }, async kill() { return 0; }, notify() {} },
  });
  await d.listen();
  const voice = d.voice;
  let claude = null;
  const t0 = Date.now();
  const cleanup = async () => {
    try { claude?.stdin.end(); } catch { /* gone */ }
    await sleep(500);
    try { claude?.kill("SIGTERM"); } catch { /* gone */ }
    await d.close();
    for (const f of ["active", "status.json", "daemon.port", "approval-pending", "pending-context"]) fs.rmSync(path.join(D, f), { force: true });
    fs.rmSync(root, { recursive: true, force: true });
    if (!process.env.SOTTO_E2E_KEEP) fs.rmSync(TMP, { recursive: true, force: true }); else console.log(`kept ${TMP}`);
  };
  const fail = async (m) => { console.error(`FAIL [${mode}] ${m}`); console.error(log.entries.filter((e) => /^(modlink|inbox|hook|claude|delegation|wake|speech|result|state|page)/.test(e.ev)).slice(-40).map((e) => JSON.stringify(e)).join("\n")); await cleanup(); finish(1); };
  try {
    const env = { ...process.env, DISABLE_AUTOUPDATER: "1" };
    for (const k of Object.keys(env)) if (/^CLAUDE/.test(k) && k !== "CLAUDE_CONFIG_DIR") delete env[k];
    if (mode === "classic") env.SOTTO_INTEGRATION = "classic"; else delete env.SOTTO_INTEGRATION;
    claude = spawn("claude", ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "haiku",
      "--permission-mode", "bypassPermissions", "--plugin-dir", REPO, "--setting-sources", "project,local",
      // The scratch port for toggle.sh too (never the live daemon on 47821).
      "--settings", JSON.stringify({ pluginConfigs: { "sotto@inline": { options: { port } } } }), ...(process.env.SOTTO_E2E_DEBUG ? ["--debug-file", path.join(TMP, "debug.log")] : [])],
    { cwd: TMP, env, stdio: ["pipe", fs.openSync(STREAM, "w"), "ignore"] });
    const events = () => fs.readFileSync(STREAM, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    const results = () => events().filter((e) => e.type === "result").map((e) => String(e.result || ""));
    const say = (text) => claude.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
    const waitFor = async (pred, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(100); } await fail(`timed out waiting for ${what}`); return false; };

    // The session's inbox socket names it, as hook.sh and the courier know it.
    let socket = null;
    await waitFor(() => (socket = [`/tmp/cc-socks/${claude.pid}.sock`, `/tmp/cc-socks-${process.getuid()}/${claude.pid}.sock`].find((s) => fs.existsSync(s))), 30000, "the session's inbox socket");
    const r = voice.control({ action: "on", session: { socket, session_id: null, cwd: TMP, project_dir: TMP, permission_mode: "bypassPermissions" }, config: {} });
    if (!voice.owner) return fail(`could not bind the owner: ${r.message}`);
    const marker = voiceMarker(voice.nonce);

    // A typed first prompt: its UserPromptSubmit is where an unlinked mod looks for voice.
    say("Reply with just the word READY.");
    if (!await waitFor(() => results().length >= 1, 90000, "the first reply")) return;
    if (mode === "mod") {
      if (!await waitFor(() => voice.modActive(), 15000, "the mod's hello")) return;
      const up = log.find("modlink.up")[0];
      console.log(`[mod] linked in ${Date.now() - t0} ms (cli ${up?.cli}); active file owner: ${fs.readFileSync(path.join(D, "active"), "utf8").split("\t")[0].slice(0, 4)}…`);
    } else {
      await sleep(3000);
      if (voice.modActive() || log.find("modlink.up").length) return fail("the mod linked with SOTTO_INTEGRATION=classic");
    }

    // 1. Idle: a voice message becomes a prompt of its own.
    const W1 = `ALPHA${tag()}`;
    const s1 = Date.now();
    const sent1 = await voice.inboxSend(`${marker} Hey, can you say ${W1} back to me so I know you can hear me?`, `e2e-idle-${W1}`);
    if (!sent1.ok) return fail(`idle send failed: ${JSON.stringify(sent1)}`);
    if (mode === "mod" && sent1.via !== "mod") return fail(`idle send went ${sent1.via || "classic"}, not through the mod`);
    if (mode === "classic" && sent1.via === "mod") return fail("idle send went through the mod");
    if (!await waitFor(() => results().some((t) => t.includes(W1)), 90000, `Claude to answer the idle voice message (${W1})`)) return;
    console.log(`[${mode}] idle message answered in ${Date.now() - s1} ms via ${sent1.via || "direct"}`);

    // 2. Busy: Claude is in a Bash call when the message arrives.
    const W2 = `BRAVO${tag()}`;
    const before = results().length;
    say("Run this Bash command with a 60000 ms timeout: sleep 12. Then reply with just the word DONE plus any extra word a voice message asked you to include.");
    if (!await waitFor(() => events().some((e) => e.type === "assistant" && JSON.stringify(e.message?.content || "").includes("\"Bash\"")), 60000, "the Bash call")) return;
    await sleep(1500);
    const sent2 = await voice.inboxSend(`${marker} Oh, and when you're done, say ${W2} too.`, `e2e-busy-${W2}`);
    if (!sent2.ok) return fail(`busy send failed: ${JSON.stringify(sent2)}`);
    if (!await waitFor(() => results().slice(before).some((t) => t.includes(W2)), 150000, `Claude to answer the mid-turn voice message (${W2})`)) return;
    console.log(`[${mode}] mid-turn message answered via ${sent2.via || "direct"}${mode === "mod" ? `, receipts: ${log.find("modlink.receipt").map((x) => x.how).join(",")}` : ""}`);

    // 3. Late (mod only): appended while Claude writes its final, text-only
    // reply, the model never reads it. The mod reports it "requeued" before
    // the Stop, the daemon's nudge starts a turn, and that turn answers it.
    // A delegation record stands for the voice request, as the Live model's
    // delegation would make it.
    if (mode === "mod") {
      const W3 = `DELTA${tag()}`;
      const before3 = results().length;
      const hooksBefore = log.find("hook").length;
      say("Write a plain story of about 250 words about a lighthouse keeper. No tools.");
      // The mod's turn start makes Claude busy at once; the turn is one text-only request.
      if (!await waitFor(() => log.find("hook").slice(hooksBefore).some((x) => x.event === "UserPromptSubmit") && voice.delegation.claudeBusy, 60000, "the story turn to start")) return;
      await sleep(400);
      const content = `${marker} Also tell me the word ${W3}.`;
      const rec = { id: 901, rev: 901, status: "collecting", text: `Also tell me the word ${W3}.`, content, msg_id: `clv-901-901`, sent_at: 0, prompt_id: null, live_id: null, frags: [] };
      voice.delegation.records.push(rec);
      const sent3 = await voice.inboxSend(content, rec.msg_id);
      Object.assign(rec, { status: "sent", sent_at: Date.now(), sent_while_busy: true });
      if (!sent3.ok || sent3.via !== "mod") return fail(`late send: ${JSON.stringify(sent3)}`);
      if (!await waitFor(() => results().slice(before3).some((t) => t.includes(W3)), 150000, `Claude to answer the late voice message (${W3})`)) return;
      const hows = log.find("modlink.receipt").filter((x) => x.msg_id === rec.msg_id || x.msg_id === `${rec.msg_id}-n`).map((x) => `${x.msg_id === rec.msg_id ? "msg" : "nudge"}:${x.how}`);
      console.log(`[mod] late message answered; receipts ${hows.join(",")}; record ${rec.status}`);
      if (hows.includes("msg:requeued") && !hows.includes("nudge:submitted")) return fail("requeued but the nudge was never submitted");
      if (rec.status !== "answered") return fail(`the late voice request ended ${rec.status}, not answered`);

      // 4. Phase 4: the voice tools, answered by the mod through /control.
      const before4 = results().length;
      say("Call the mcp__sotto__status tool (load it with ToolSearch if needed) and reply with exactly the line it returned.");
      if (!await waitFor(() => results().length > before4, 120000, "the status tool turn")) return;
      if (!log.find("control").some((c) => c.action === "status" && c.via === "cli")) return fail(`the model's status tool never reached /control: ${results().at(-1)}`);
      console.log(`[mod] voice tool answered: ${results().at(-1).slice(0, 100)}`);

      // 6. Phase 6: the mod got the voice's state for its status line and band.
      if (!(voice.modlink.stateVer > 0) || !voice.modlink.uiState?.persona) return fail("no UI state pushed to the mod");
      if (!log.find("hook").some((x) => x.event === "UserPromptSubmit" && x.via === "mod")) return fail("no prompts through the mod");
    }

    // 7. A typed turn holds the voice awake, and its reply wakes a sleeping
    // voice (SPEC §6.20 F; live log 2026-10-02). There is no Live session here:
    // a stand-in page listens and the voice is put to sleep, as idle would.
    const W7 = `ECHO${tag()}`;
    const page = { write() {}, end() {} };
    const stateBefore = voice.state;
    voice.sse.clients.add(page);
    voice.setState("sleeping");
    const before7 = results().length;
    const wakesBefore = log.find("wake.queue").length;
    say(`Run this Bash command: sleep 5. Then reply with just the word ${W7}.`);
    if (!await waitFor(() => events().some((e) => e.type === "assistant" && JSON.stringify(e.message?.content || "").includes("sleep 5")), 60000, "the typed turn's Bash call")) return;
    await sleep(1000);
    if (!voice.delegation.claudeBusy || !voice.voiceIsWaiting()) return fail(`a typed turn does not hold the voice (busy ${voice.delegation.claudeBusy})`);
    if (!await waitFor(() => results().slice(before7).some((t) => t.includes(W7)), 90000, `the typed reply (${W7})`)) return;
    if (!await waitFor(() => log.find("wake.queue").slice(wakesBefore).some((w) => w.source === "typed_result") && voice.wakeQueue.some((q) => q.source === "typed_result" && q.content.includes(W7)), 15000, "the typed reply to wake the voice")) return;
    if (!log.find("wake.request").length) return fail("no wake request for the typed reply");
    console.log(`[${mode}] typed turn held the voice; its reply (${W7}) queued a notify wake, connect:notify sent`);
    voice.sse.clients.delete(page);
    voice.clear("notifyWatch");
    voice.wakeQueue = [];
    voice.setState(stateBefore);

    // /talk status: from the mod (no hook stop) when linked, from toggle.sh otherwise.
    const before5 = results().length;
    say("/sotto:talk status");
    if (!await waitFor(() => results().length > before5, 60000, "/talk status")) return;
    const talk = results().at(-1);
    const fromHook = talk.startsWith("Operation stopped by hook");
    if (mode === "mod" && (fromHook || !talk.includes("link mod"))) return fail(`/talk status in mod mode: ${talk}`);
    if (mode === "classic" && (!fromHook || !talk.includes("link classic"))) return fail(`/talk status in classic mode: ${talk}`);
    console.log(`[${mode}] /talk status: ${talk.slice(0, 160)}`);

    if (mode === "mod") {
      const hooks = log.find("hook").filter((h) => h.via === "mod");
      const names = new Set(hooks.map((h) => h.event));
      for (const ev of ["UserPromptSubmit", "Stop", "PreToolUse"]) if (!names.has(ev)) return fail(`no ${ev} through the uplink (saw ${[...names].join(",")})`);
      if (!hooks.some((h) => h.event === "PreToolUse" && h.tool_name === "Bash")) return fail("PreToolUse reached the daemon without tool_name (adapter)");
      if (!log.find("claude.turn").some((t) => t.phase === "complete")) return fail("no turn.complete through the uplink");
      const st = voice.status().integration;
      if (st.mode !== "mod" || !(st.counters.receipts >= 2)) return fail(`integration status ${JSON.stringify(st)}`);
      if (!voice.statusMessage().includes("link mod")) return fail(`/talk status does not say link mod: ${voice.statusMessage()}`);
      console.log(`[mod] uplink: ${hooks.length} hook events (${[...names].join(", ")}), ${st.counters.events} events, ${st.counters.receipts} receipts, dup ${st.counters.dup_events}`);
    } else {
      const sends = log.find("inbox.send");
      if (!sends.length || sends.some((s) => s.via === "mod")) return fail(`classic sends: ${JSON.stringify(sends)}`);
      if (!log.find("hook").some((h) => h.event === "Stop" && !h.via)) return fail("no Stop through the shell hooks");
      if (!voice.statusMessage().includes("link classic")) return fail(`/talk status does not say link classic: ${voice.statusMessage()}`);
      console.log(`[classic] sends via ${[...new Set(sends.map((s) => s.via))].join(",")}, shell hooks: ${log.find("hook").length}`);
    }
    const cost = events().filter((e) => e.type === "result").reduce((a, e) => a + (e.total_cost_usd || 0), 0);
    console.log(`PASS [${mode}] in ${Math.round((Date.now() - t0) / 1000)} s, $${cost.toFixed(3)}`);
    await cleanup();
  } catch (e) {
    await fail(String(e && e.stack || e));
  }
}

let exitCode = 0;
function finish(code) { exitCode = code; if (wroteKey) fs.rmSync(keyFile, { force: true }); process.exit(code); }
if (ONLY !== "classic") await run("mod");
if (ONLY !== "mod") await run("classic");
finish(exitCode);
