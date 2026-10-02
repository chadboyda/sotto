// Keep e2e Claude Code sessions away from the session running the test.
//
// The e2e scripts run inside a developer's own Claude Code session, which
// exports CLAUDE_CODE_MESSAGING_SOCKET/TOKEN (its cross-session inbox). Live
// incident 2026-10-02: an e2e:mod classic run delivered its voice message to
// the test session correctly, but haiku answered it with SendMessage to a
// session it found by name with ListAgents: the developer's live session.
// So every spawned test session gets a scrubbed environment and no
// cross-session tools, the test process drops the inherited inbox too, and a
// target socket equal to the inherited one is refused.

/** The developer session's inbox, captured before scrubInheritedMessaging(). */
export const INHERITED_SOCKET = process.env.CLAUDE_CODE_MESSAGING_SOCKET || "";

/** Tools that reach other sessions: denied to every e2e session. */
export const PEER_TOOLS = ["SendMessage", "ListAgents"];
export const NO_PEER_TOOLS_ARGS = ["--disallowed-tools", PEER_TOOLS.join(",")];

/** Drop the inherited inbox from this process, so nothing in it (daemon included) can post there. */
export function scrubInheritedMessaging() {
  for (const k of Object.keys(process.env)) if (/^CLAUDE_CODE_MESSAGING_/.test(k)) delete process.env[k];
}

/** The environment for a spawned `claude`: no CLAUDE* variables of the parent session (CLAUDE_CONFIG_DIR kept). */
export function isolatedClaudeEnv(extra = {}) {
  const env = { ...process.env, DISABLE_AUTOUPDATER: "1", ...extra };
  for (const k of Object.keys(env)) if (/^CLAUDE/.test(k) && k !== "CLAUDE_CONFIG_DIR") delete env[k];
  return env;
}

/** Throws when `socket` is the inbox of the session running the test. */
export function assertNotInherited(socket) {
  if (INHERITED_SOCKET && socket === INHERITED_SOCKET) throw new Error(`target socket ${socket} is the inbox of the session running this test`);
}

/** Cross-session tool calls in a stream-json transcript (should be none). */
export function peerToolCalls(events) {
  const out = [];
  for (const e of events) {
    if (e?.type !== "assistant" || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) if (b?.type === "tool_use" && PEER_TOOLS.includes(b.name)) out.push(b.name);
  }
  return out;
}
