// Pure logic of Sotto's Claude Code mod (SPEC §6.21): no `$`, no I/O, so it is
// unit-tested with node:test (test/hooks/modcore.test.js) and imported by
// hooks/sotto-mod.mjs, the hooks module the CLI loads.

/** The classic hook events the mod forwards: hooks.json's list for hook.sh. */
export const FORWARDED = [
  "UserPromptSubmit", "PreToolUse", "PermissionRequest", "MessageDisplay", "Notification", "Elicitation",
  "SubagentStop", "TaskCompleted", "TeammateIdle", "PostToolUseFailure", "PostToolUse", "PermissionDenied",
  "Stop", "StopFailure", "SessionEnd",
];

const MAX_STRING = 16 * 1024;

/** A copy of a hook body with long strings cut (a Write's content, a tool's output). */
export function trimBody(v, depth = 0) {
  if (typeof v === "string") return v.length > MAX_STRING ? v.slice(0, MAX_STRING) : v;
  if (!v || typeof v !== "object" || depth > 3) return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => trimBody(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = trimBody(x, depth + 1);
  return out;
}

/**
 * classic.PreToolUse hands a mod a ToolCallEnvelope ({tool, tool_use_id,
 * ...arguments, agentId?}), not the hook's stdin (the CLI 2.1.287 types say so
 * and a probe saw it). The daemon reads the stdin shape, so rebuild it: the
 * base fields come from the latest other classic event of the session.
 */
export function adaptPreToolUse(e, base = {}, promptId = null) {
  const { tool, tool_use_id, agentId, ...args } = e || {};
  const body = {
    session_id: base.session_id, transcript_path: base.transcript_path, cwd: base.cwd, permission_mode: base.permission_mode,
    hook_event_name: "PreToolUse", tool_name: tool, tool_input: args, tool_use_id,
  };
  if (typeof agentId === "string" && agentId) body.agent_id = agentId;
  else if (promptId) body.prompt_id = promptId;
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

/** The base fields a classic event carries (all but PreToolUse). */
export function baseOf(e, prev = {}) {
  if (!e || typeof e !== "object") return prev;
  const pick = (k) => (typeof e[k] === "string" && e[k] ? e[k] : prev[k]);
  return { session_id: pick("session_id"), transcript_path: pick("transcript_path"), cwd: pick("cwd"), permission_mode: pick("permission_mode") };
}

/** The body forwarded for a classic event: PostToolUse without its (unused, maybe huge) tool_response. */
export function forwardBody(name, e) {
  if (name === "PostToolUse" && e && typeof e === "object") {
    const { tool_response, ...rest } = e;
    return trimBody(rest);
  }
  return trimBody(e);
}

/** "[sotto voice <nonce>]", the marker hook.sh and the daemon use (config.js voiceMarker). */
export function markerFor(nonce) {
  return typeof nonce === "string" && /^[0-9a-f]+$/.test(nonce) ? `[sotto voice ${nonce}]` : "[sotto voice]";
}

/** D/active: "<owner>\t<port>\t<key>[\t<nonce>]". → {owner, port, key, nonce} | null */
export function parseActive(text) {
  if (typeof text !== "string") return null;
  const [owner = "", port = "", key = "", nonce = ""] = text.split("\n")[0].split("\t");
  if (!owner || !/^\d+$/.test(port) || !key) return null;
  return { owner, port: Number(port), key, nonce };
}

/** Does an active file's owner name this session (classic, or already linked to its mod)? */
export function ownsSession(owner, socket) {
  return !!socket && (owner === socket || owner === `mod:${socket}`);
}

/** Bounded set of handled msg_ids: at-least-once downlink, at-most-once delivery. */
export class Seen {
  constructor(cap = 256) { this.cap = cap; this.set = new Set(); }
  has(id) { return this.set.has(id); }
  add(id) {
    this.set.add(id);
    while (this.set.size > this.cap) this.set.delete(this.set.values().next().value);
  }
}

/** The ordered uplink: seq-numbered events, kept until the daemon acks them. */
export class Uplink {
  constructor(max = 2000) { this.max = max; this.seq = 0; this.queue = []; this.dropped = 0; }
  push(ev) {
    const e = { ...ev, seq: ++this.seq };
    this.queue.push(e);
    while (this.queue.length > this.max) { this.queue.shift(); this.dropped++; }
    return e.seq;
  }
  batch(n = 50) { return this.queue.slice(0, n); }
  ack(seq) { if (Number.isFinite(seq)) this.queue = this.queue.filter((e) => e.seq > seq); }
  get size() { return this.queue.length; }
  clear() { this.queue = []; }
}

/**
 * Where a voice message goes (SPEC §6.21): an idle session gets it as a
 * prompt of its own ($.prompt.submit), a working one now ($.session.append,
 * read at the model's next request), or at the end of the turn ("later",
 * a mirror; "submit_only", a requeue nudge). One submit at a time: two
 * submitted while a turn runs are merged and one's promise never resolves
 * (probed on CLI 2.1.287).
 */
export class Delivery {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.busy = false;
    this.turnId = null;
    this.promptId = null;
    this.stepAt = 0; // when the main thread's latest model request started
    this.appended = []; // {msg_id, at} appended during this turn
    this.queue = []; // items waiting for an idle session, in order
  }

  /** → "submit" | "append" | "queue" */
  route(item) {
    if (!this.busy) return "submit";
    if (item.priority === "later" || item.submit_only) return "queue";
    return "append";
  }

  turnStart(turnId) { this.busy = true; this.turnId = turnId || null; this.stepAt = this.now(); this.appended = []; }
  stepStart() { this.stepAt = this.now(); }
  noteAppend(msgId) { this.appended.push({ msg_id: msgId, at: this.now() }); }

  /**
   * At the main thread's Stop: appends that resolved after the turn's last
   * model request started were never read by the model (probed: it does not
   * run another step for them). Their msg_ids, for a "requeued" receipt each.
   */
  missedAtStop() {
    const missed = this.appended.filter((a) => a.at >= this.stepAt).map((a) => a.msg_id);
    this.appended = [];
    return missed;
  }

  turnComplete() { this.busy = false; this.turnId = null; this.appended = []; }

  enqueue(item) { this.queue.push(item); }
  nextQueued() { return this.busy ? null : this.queue.shift() || null; }
}

/** The text appended mid-turn: the message, then the voice framing hook.sh adds as context to a prompt. */
export function appendText(content, context) {
  return context ? `${content}\n\n(${context})` : content;
}

// ---- phase 4: /talk from the mod, the conversation for the seed -----------------

/**
 * CLAUDE_PLUGIN_OPTION_* for toggle.sh run by the mod: the userConfig values
 * register() got (defaults filled in). idle_seconds' default is left out when
 * the legacy idle_minutes was set, as an unset option would be (SPEC §4.2).
 */
export function optionEnv(options = {}) {
  const env = {};
  for (const [k, v] of Object.entries(options || {})) {
    if (!/^[a-z_]+$/.test(k) || v === undefined || v === null || typeof v === "object") continue;
    env[`CLAUDE_PLUGIN_OPTION_${k.toUpperCase()}`] = String(v);
  }
  if (Number(options?.idle_seconds) === 60 && options?.idle_minutes !== undefined && Number(options.idle_minutes) !== 5) delete env.CLAUDE_PLUGIN_OPTION_IDLE_SECONDS;
  return env;
}

/** Is this command.run the plugin's /talk? */
export function isTalkCommand(name) {
  return name === "sotto:talk" || name === "talk";
}

/** The transcript file Claude Code keeps for a session: <config>/projects/<cwd, non-alphanumerics as "-">/<id>.jsonl. */
export function transcriptPathFor(configDir, cwd, sessionId) {
  if (!configDir || !cwd || !sessionId) return "";
  return `${configDir}/projects/${String(cwd).replace(/[^A-Za-z0-9]/g, "-")}/${sessionId}.jsonl`;
}

/** UserPromptExpansion stdin for toggle.sh, as Claude Code would hand it. */
export function expansionInput({ sessionId, transcriptPath, cwd, permissionMode, args }) {
  const a = typeof args === "string" ? args : "";
  return JSON.stringify({
    session_id: sessionId || "", transcript_path: transcriptPath || "", cwd: cwd || "", permission_mode: permissionMode || "default",
    hook_event_name: "UserPromptExpansion", expansion_type: "slash_command", command_name: "sotto:talk", command_args: a,
    prompt: `/sotto:talk${a ? ` ${a}` : ""}`,
  });
}

/** toggle.sh's one line ({"continue":false,"stopReason":…}) as command text, without the "sotto: " Claude Code adds itself. */
export function toggleText(stdout) {
  const line = String(stdout || "").trim().split("\n").pop() || "";
  let j = null;
  try { j = JSON.parse(line); } catch { return null; }
  if (!j || typeof j.stopReason !== "string") return null;
  return j.stopReason.replace(/^sotto:\s*/, "");
}

/** $.session.messages() rows → [{role, text}] for the daemon's seed (newest last). */
export function contextOf(rows, max = 40) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows.slice(-max * 2) : []) {
    if (!r || (r.role !== "user" && r.role !== "assistant") || typeof r.text !== "string" || !r.text.trim()) continue;
    out.push({ role: r.role, text: r.text.length > 4000 ? r.text.slice(0, 4000) : r.text });
  }
  return out.slice(-max);
}

// ---- phase 6: what the mod draws -------------------------------------------------

/** The voice state word as /talk status says it. */
function stateWord(s) { return s.state === "live" ? "ON" : s.state || "off"; }

/** The pinned status line under the prompt. */
export function statusLine(s) {
  if (!s) return undefined;
  // Claude Code puts the plugin's name in front of the line ("sotto: ").
  const parts = [`voice ${stateWord(s)}`];
  if (s.persona) parts.push(`persona ${s.persona}`);
  if (s.voice) parts.push(`voice ${s.voice}`);
  return parts.join(" | ");
}

/** The phase words of the band. */
export function phaseOf(s) {
  if (!s) return "";
  if (s.approval) return "approval needed";
  if (s.state === "live") return s.busy ? "Claude is working" : "listening";
  if (s.state === "sleeping") return s.busy ? "Claude is working, voice asleep" : "asleep, talk to wake it";
  return s.state || "";
}

/** Text on one line, cut to `cols` cells (a code point per cell is close enough here). */
export function fit(text, cols) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!(cols > 0)) return "";
  const chars = [...t];
  return chars.length <= cols ? t : chars.slice(0, Math.max(0, cols - 1)).join("") + "…";
}

/**
 * The band above the prompt: one or two lines fitted to the band's width:
 * "sotto | <phase>" and the voice's last words (else the latest activity).
 */
export function bandLines(s, cols) {
  if (!s) return [];
  const w = Math.max(10, Number(cols) || 80);
  const head = fit(`sotto | ${phaseOf(s)}${s.approval ? `: ${s.approval}` : ""}`, w);
  const body = s.said ? `"${s.said}"` : s.activity || "";
  return body ? [head, fit(body, w)] : [head];
}
