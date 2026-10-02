// The e2e isolation helper (test/helpers/isolated-claude.js): test sessions
// never reach the session running the tests (live incident 2026-10-02).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isolatedClaudeEnv, peerToolCalls, NO_PEER_TOOLS_ARGS } from "../helpers/isolated-claude.js";

const HELPER = fileURLToPath(new URL("../helpers/isolated-claude.js", import.meta.url));

test("isolatedClaudeEnv drops every CLAUDE* variable of the parent session but CLAUDE_CONFIG_DIR", () => {
  process.env.CLAUDE_CODE_MESSAGING_SOCKET_TEST_PROBE = "x";
  try {
    const env = isolatedClaudeEnv({ TERM: "xterm" });
    assert.ok(!Object.keys(env).some((k) => /^CLAUDE/.test(k) && k !== "CLAUDE_CONFIG_DIR"));
    assert.equal(env.TERM, "xterm");
    assert.equal(env.DISABLE_AUTOUPDATER, "1");
  } finally { delete process.env.CLAUDE_CODE_MESSAGING_SOCKET_TEST_PROBE; }
});

test("the cross-session tools are denied on the command line", () => {
  assert.deepEqual(NO_PEER_TOOLS_ARGS, ["--disallowed-tools", "SendMessage,ListAgents"]);
});

test("assertNotInherited refuses the inherited inbox; scrubInheritedMessaging removes it from the process", () => {
  const script = `
    const m = await import(${JSON.stringify(HELPER)});
    let refused = false;
    try { m.assertNotInherited("/tmp/cc-socks/parent.sock"); } catch { refused = true; }
    m.assertNotInherited("/tmp/cc-socks/child.sock");
    m.scrubInheritedMessaging();
    console.log(JSON.stringify({ refused, left: Object.keys(process.env).filter((k) => k.startsWith("CLAUDE_CODE_MESSAGING_")) }));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH, CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/parent.sock", CLAUDE_CODE_MESSAGING_TOKEN: "t" },
  }).toString();
  assert.deepEqual(JSON.parse(out), { refused: true, left: [] });
});

test("peerToolCalls finds SendMessage/ListAgents tool calls in a stream-json transcript", () => {
  const ev = (name) => ({ type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name, input: {} }] } });
  assert.deepEqual(peerToolCalls([ev("Bash"), ev("ListAgents"), { type: "result" }, ev("SendMessage")]), ["ListAgents", "SendMessage"]);
  assert.deepEqual(peerToolCalls([ev("Bash"), {}, null]), []);
});
