#!/usr/bin/env node
// The courier end to end against a REAL Claude Code session (SPEC §6.9.2).
//
// Claude Code (2.1.286) holds a message posted to a bypassPermissions
// session's inbox by a live process that is not the session's own child: the
// detached sotto daemon's case. The courier, the plugin's stdio MCP server,
// is the session's own child and is delivered. This runs a headless
//   claude -p --permission-mode bypassPermissions --plugin-dir <repo>
// that waits in Bash for about 90 s, and meanwhile:
//   1. posts a message straight to its inbox from this (unrelated, live)
//      process: it must be HELD (a peer_message_hold event, never seen by Claude);
//   2. hands a message to the session's courier exactly as the daemon does
//      (viaCourier with D/daemon.key): it must be DELIVERED (Claude quotes it).
// No OpenAI calls, no daemon, no window. Costs one short haiku turn.
// Never prints a key or token.
//
//   node test/e2e/courier.mjs          (npm run e2e:courier)
//   SOTTO_E2E_KEEP=1                    keep the stream log for inspection
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { courierPaths, viaCourier, send } from "../../daemon/inbox.js";
import { scrubInheritedMessaging, isolatedClaudeEnv, assertNotInherited, NO_PEER_TOOLS_ARGS } from "../helpers/isolated-claude.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const D = path.join(os.homedir(), ".claude", "plugins", "data", "sotto-inline"); // --plugin-dir's data dir
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "clv-courier-e2e-"));
const STREAM = path.join(TMP, "stream.jsonl");
const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
const HELD_WORD = `HELD${tag}`, COURIER_WORD = `COURIER${tag}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error(`FAIL ${m}`); cleanup(); process.exit(1); };
const events = () => fs.readFileSync(STREAM, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });

let wroteKey = false, claude = null;
function cleanup() {
  try { claude?.kill("SIGTERM"); } catch { /* gone */ }
  if (wroteKey) try { fs.unlinkSync(path.join(D, "daemon.key")); } catch { /* ignore */ }
  if (!process.env.SOTTO_E2E_KEEP) fs.rmSync(TMP, { recursive: true, force: true });
  else console.log(`kept ${TMP}`);
}

// The courier checks the daemon's key. Use the existing one, or a throwaway
// one when this data dir has none (removed at the end).
fs.mkdirSync(D, { recursive: true, mode: 0o700 });
const keyFile = path.join(D, "daemon.key");
if (!fs.existsSync(keyFile)) { fs.writeFileSync(keyFile, `e2e-${tag}-${process.pid}\n`, { mode: 0o600 }); wroteKey = true; }
const KEY = fs.readFileSync(keyFile, "utf8").trim();

// Never post into the session running this test (test/helpers/isolated-claude.js).
scrubInheritedMessaging();
const env = isolatedClaudeEnv();
const prompt = "Run this Bash command three times, one after another, each with a 60000 ms timeout: python3 -c 'import time; time.sleep(30)'. "
  + "Then reply with every message you received from other sessions during this conversation, quoted verbatim, or NONE.";
const t0 = Date.now();
claude = spawn("claude", ["-p", "--permission-mode", "bypassPermissions", "--model", "haiku", "--plugin-dir", REPO, ...NO_PEER_TOOLS_ARGS,
  "--output-format", "stream-json", "--verbose", prompt], { cwd: TMP, env, stdio: ["ignore", fs.openSync(STREAM, "w"), "ignore"] });
const exited = new Promise((r) => claude.once("exit", r));

// Find this session's courier: the pid file whose process is claude's child.
let courier = null;
for (let i = 0; i < 300 && !courier; i++) {
  await sleep(100);
  for (const dir of [path.join(D, "courier"), `/tmp/sotto-courier-${process.getuid()}`]) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".pid")); } catch { continue; }
    for (const n of names) {
      const pid = Number(fs.readFileSync(path.join(dir, n), "utf8").trim());
      let ppid = 0;
      try { ppid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)]).toString().trim()); } catch { continue; }
      if (ppid === claude.pid) courier = { pid, name: n.replace(/\.pid$/, "") };
    }
  }
}
if (!courier) fail("no courier started as the session's child (is the plugin's .mcp.json loaded?)");
const inboxSocket = [`/tmp/cc-socks/${claude.pid}.sock`, `/tmp/cc-socks-${process.getuid()}/${claude.pid}.sock`]
  .find((s) => path.basename(courierPaths(D, s).socket, ".sock") === courier.name);
if (!inboxSocket) fail("could not match the courier to the session's inbox socket");
assertNotInherited(inboxSocket);
console.log(`courier pid ${courier.pid} (child of claude ${claude.pid}), started ${Date.now() - t0} ms after launch`);

// Wait until Claude is inside its first Bash call, so both messages land mid-turn.
for (let i = 0; i < 600 && !events().some((e) => e.subtype === "task_started"); i++) await sleep(100);

// 1. Direct from a live unrelated process: held.
const d = await send({ socket: inboxSocket, token: "", content: `[probe] direct post, codeword ${HELD_WORD}`, msgId: `e2e-held-${tag}` });
if (!d.ok) fail(`direct write failed: ${d.code}`);
for (let i = 0; i < 50 && !events().some((e) => e.subtype === "peer_message_hold"); i++) await sleep(100);
const holds = events().filter((e) => e.subtype === "peer_message_hold" && e.state === "held");
if (holds.length !== 1) fail(`expected the direct post to be held, saw ${holds.length} hold events`);
console.log(`direct post: HELD (cause ${holds[0].cause})`);

// 2. Through the courier, as the daemon sends: delivered.
const sentAt = Date.now();
const c = await viaCourier({ dataDir: D, inboxSocket, key: KEY, content: `[probe] courier post, codeword ${COURIER_WORD}`, msgId: `e2e-courier-${tag}` });
if (!c.ok) fail(`courier send failed: ${c.code} ${c.message || ""}`);
console.log(`courier send: ok in ${Date.now() - sentAt} ms`);
await sleep(3000);
if (events().filter((e) => e.subtype === "peer_message_hold" && e.state === "held").length !== 1) fail("the courier's message was held too");

const code = await Promise.race([exited, sleep(240_000).then(() => "timeout")]);
if (code === "timeout") fail("claude -p did not finish in 4 min");
const result = events().find((e) => e.type === "result");
const text = String(result?.result || "");
if (!text.includes(COURIER_WORD)) fail(`Claude never saw the courier's message. Reply: ${text.slice(0, 300)}`);
if (text.includes(HELD_WORD)) fail("the held message reached Claude");
console.log(`PASS delivered via courier, held direct (session ${Math.round((Date.now() - t0) / 1000)} s, $${(result.total_cost_usd || 0).toFixed(3)})`);
cleanup();
