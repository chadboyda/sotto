#!/usr/bin/env node
// The mod's terminal UI in a REAL interactive Claude Code terminal (SPEC
// §6.21 "Terminal UI"): the band above the prompt, Sotto's one surface.
//
// Claude Code runs in a pseudo-terminal (Python's pty; nothing is drawn on
// your screen), in this repo's directory (a trusted workspace is needed:
// set SOTTO_E2E_UI_CWD to another trusted one), with --plugin-dir <repo>, a
// scratch port and an in-process daemon on the --plugin-dir data dir. It
// types `/sotto:talk status` (no model turn): the mod runs it, links up, gets
// the voice's state and draws. The captured screen bytes, ANSI stripped, must
// show the band "sotto · <phase> · <persona> · <voice>" and no separate
// status line ("sotto: voice ... | persona ...", drawn once beside the band).
// No model call, no OpenAI, no microphone, no window. Run after
// `npm run e2e:mod` (it needs the data dir the mod remembers from a hello).
//
//   node test/e2e/mod-ui.mjs        (npm run e2e:mod-ui)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDaemon } from "../../daemon/index.js";
import { createMemoryLogger } from "../../daemon/log.js";
import { createFakeKeychain } from "../helpers/fake-keychain.js";
import { freePort, makePluginRoot } from "../helpers/daemon-harness.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const CWD = process.env.SOTTO_E2E_UI_CWD || REPO;
const D = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "plugins", "data", "sotto-inline");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[(\d*)C/g, (_, n) => " ".repeat(Number(n) || 1)).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "").replace(/\x1b[()][A-Z0-9]/g, "");

for (const f of ["daemon.pid", "active"]) {
  if (fs.existsSync(path.join(D, f))) { console.error(`FAIL ${path.join(D, f)} exists: another daemon uses the --plugin-dir data dir`); process.exit(1); }
}
fs.mkdirSync(D, { recursive: true, mode: 0o700 });
const keyFile = path.join(D, "daemon.key");
const wroteKey = !fs.existsSync(keyFile);
if (wroteKey) fs.writeFileSync(keyFile, `e2e-ui-${process.pid}\n`, { mode: 0o600 });
const KEY = fs.readFileSync(keyFile, "utf8").trim();
const port = await freePort();
const root = makePluginRoot();
const log = createMemoryLogger({ debug: false });
const d = createDaemon({
  dataDir: D, port, pluginRoot: root, env: { SOTTO_KEYCHAIN_SERVICE: `sotto-e2e-ui-${process.pid}` }, keychain: createFakeKeychain(), daemonKey: KEY, log,
  chrome: { open() { return { mode: "chrome" }; }, async kill() { return 0; }, notify() {} },
});
await d.listen();
const voice = d.voice;

const env = { ...process.env, DISABLE_AUTOUPDATER: "1", TERM: "xterm-256color", COLUMNS: "100", LINES: "30" };
for (const k of Object.keys(env)) if (/^CLAUDE/.test(k) && k !== "CLAUDE_CONFIG_DIR") delete env[k];
delete env.SOTTO_INTEGRATION;
const args = ["claude", "--plugin-dir", REPO, "--setting-sources", "project,local",
  "--settings", JSON.stringify({ pluginConfigs: { "sotto@inline": { options: { port } } } }), "--permission-mode", "bypassPermissions", "--model", "haiku"];
// A 100x30 pseudo-terminal from the Python standard library (pty), relaying
// its bytes to our pipes: Node has no pty of its own and `script` needs a tty.
const DRIVER = `
import os, pty, sys, select, struct, fcntl, termios, json
argv = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
print(pid, file=sys.stderr, flush=True)
while True:
    r, _, _ = select.select([fd, 0], [], [], 0.5)
    if fd in r:
        try: b = os.read(fd, 65536)
        except OSError: break
        if not b: break
        os.write(1, b)
    if 0 in r:
        b = os.read(0, 4096)
        if not b: break
        os.write(fd, b)
`;
const term = spawn("python3", ["-c", DRIVER, JSON.stringify(args)], { cwd: CWD, env, stdio: ["pipe", "pipe", "pipe"] });
let claudePid = 0;
term.stderr.on("data", (b) => { const n = parseInt(String(b), 10); if (n > 0 && !claudePid) claudePid = n; });
let screen = "";
term.stdout.on("data", (b) => { screen += b.toString("utf8"); });
let code = 1;
const fail = (m) => { console.error(`FAIL ${m}`); console.error(strip(screen).slice(-1500)); };
const type = async (text) => { for (const ch of text) { term.stdin.write(ch); await sleep(15); } };
try {
  // The session's inbox socket names it.
  let sock = null;
  for (let i = 0; i < 300 && !sock; i++) {
    await sleep(100);
    if (claudePid) sock = [`/tmp/cc-socks/${claudePid}.sock`, `/tmp/cc-socks-${process.getuid()}/${claudePid}.sock`].find((s) => fs.existsSync(s)) || null;
  }
  if (!sock) throw new Error("no inbox socket for the terminal session");
  const r = voice.control({ action: "on", session: { socket: sock, cwd: CWD, project_dir: CWD, permission_mode: "bypassPermissions" }, config: {} });
  if (!voice.owner) throw new Error(`owner not bound: ${r.message}`);
  await sleep(4000); // the TUI settles
  if (/trust\s*this\s*folder/i.test(strip(screen))) throw new Error(`${CWD} is not a trusted workspace; set SOTTO_E2E_UI_CWD`);
  await type("/sotto:talk status");
  await sleep(300);
  term.stdin.write("\r");
  for (let i = 0; i < 200 && !voice.modActive(); i++) await sleep(100);
  if (!voice.modActive()) throw new Error("the mod did not link after /talk status");
  await sleep(3000); // the next poll brings the state; the band redraws
  // The TUI moves the cursor instead of printing spaces, so match without whitespace.
  const text = strip(screen).replace(/\s+/g, "");
  const status = /sotto:voice[A-Za-z_]+\|persona[a-z0-9_-]+\|voice[a-z]+/.exec(text);
  const band = /sotto·(listening|paused|asleep|Claudeis|approval|waiting_page|connecting|reconnecting|closing|held|can'thear|error)[A-Za-z,_':]*(·[a-z0-9_-]+){0,2}/.exec(text);
  const talk = /voice[a-z_]+\([^)]*\)\|[^❯]*?linkmod/.exec(text);
  console.log(`status line: ${status ? status[0] : "(none)"}`);
  console.log(`band: ${band ? band[0] : "(none)"}`);
  console.log(`/talk status answer: ${talk ? talk[0].slice(0, 120) : "(none)"}`);
  if (status) fail("a separate status line is on screen beside the band");
  else if (!band) fail("no band above the prompt");
  else if (!talk) fail("no /talk status answer from the mod");
  else { console.log("PASS terminal UI drawn"); code = 0; }
} catch (e) {
  fail(String(e && e.message || e));
} finally {
  try { term.stdin.write("\x03"); await sleep(300); term.stdin.write("\x03"); } catch { /* gone */ }
  await sleep(1500);
  try { term.kill("SIGTERM"); } catch { /* gone */ }
  await d.close();
  for (const f of ["active", "status.json", "daemon.port", "approval-pending", "pending-context"]) fs.rmSync(path.join(D, f), { force: true });
  fs.rmSync(root, { recursive: true, force: true });
  if (wroteKey) fs.rmSync(keyFile, { force: true });
  process.exit(code);
}
