// Sotto's Claude Code mod (SPEC §6.21). Claude Code 2.1.287 and later load
// it from hooks.json's "modules"; older CLIs ignore that key and run the
// classic command hooks beside it in the same file, so the plugin works
// there exactly as before (verified on 2.0.77, 2.1.200, 2.1.285-2.1.287).
//
// It is inert (one boolean check per hook) until the session it runs in owns
// voice: D/active names this session's inbox socket. Then it says hello to the
// daemon and carries the session's side:
//  - downlink: a long-poll loop (holds <= 20 s: $.http.fetch has a hard 30 s
//    cap) brings voice messages and the voice's state; idle, a message is
//    submitted as the user's own prompt; while Claude works, it is appended to
//    the running turn, and an append the model never read (it landed after the
//    last request) is reported so the daemon requeues it; mirrors wait for the
//    end of the turn.
//  - uplink: the classic hook payloads (PreToolUse adapted to the stdin shape),
//    main-thread turn start/complete, receipts, the conversation for the seed,
//    subagent spawns (who launched them) and tool approvals, in order,
//    seq-numbered, batched.
//  - /talk: run here (toggle.sh under $.process.run, the daemon cold-started
//    from the mod) once the data dir is known; the classic expansion otherwise.
//  - model tools mcp__sotto__voice / persona / status while linked.
//  - terminal UI: a status line and a band above the prompt.
// The daemon then writes "mod:<socket>" into D/active, which makes hook.sh a
// no-op for this session. If this mod goes quiet the daemon falls back to the
// shell hooks and the courier on its own; if the daemon goes away this mod
// unlinks and looks again later.
//
// Rules for this file (claude plugin validate): spell every $ call in full,
// pass $ only to top-level functions of this file, string-literal event and
// env names, one hook per event without a matcher. No await on the network
// inside a hook except a tool or command it answers itself: the loops wait.
import {
  FORWARDED, adaptPreToolUse, baseOf, forwardBody, markerFor, parseActive, ownsSession, Seen, Uplink, Delivery, appendText,
  optionEnv, isTalkCommand, transcriptPathFor, expansionInput, toggleText, contextOf, statusLine, bandLines,
} from "./modcore.mjs";

const MOD_VERSION = "2";
const BATCH_MS = 30;
const SUBMIT_WAIT_MS = 15000;
const TOOL_PREFIX = "mcp__sotto__";
const STORE_DIR = "dataDir"; // $.store key prefix: the daemon data dir of a plugin root

let options = {};
let instance = "";
let link = null; // {base, key, socket, marker, context}
let gen = 0;
let after = 0;
let sv = 0; // the UI state version this mod has
let ui = null; // the voice's state, for the status line and the band
let discovering = false;
let draining = false;
let pumping = false;
let toolsUp = false;
let base = {};
let kick = null; // wakes the drain loop when an event is queued
let promptId = null;
const asks = new Set(); // tool_use_ids tool.check put to the user
const seen = new Seen();
const up = new Uplink();
const del = new Delivery();
const FORWARD = new Set(FORWARDED);

function newInstance() {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function wait($, ms) {
  return new Promise((resolve) => { $.clock.after(ms, resolve); });
}

function headers(json) {
  const h = { "X-Sotto-Key": link ? link.key : "" };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

function wakeDrain() {
  const k = kick;
  kick = null;
  if (k) k();
}

function unlink($) {
  link = null;
  gen++;
  up.clear();
  del.queue = [];
  asks.clear();
  wakeDrain();
  if (ui) {
    ui = null;
    $.ui.status(undefined);
    $.ui.invalidate("ui.render");
  }
}

async function integrationOff($) {
  const env = await $.env.get("SOTTO_INTEGRATION");
  const v = env || options.integration || "auto";
  return v === "classic" || v === "off";
}

async function configDir($) {
  const home = await $.env.get("HOME");
  return (await $.env.get("CLAUDE_CONFIG_DIR")) || (home ? `${home}/.claude` : "");
}

async function dataDirs($) {
  const forced = await $.env.get("SOTTO_DATA_DIR");
  if (forced) return [forced];
  const home = await $.env.get("HOME");
  const cfg = await configDir($);
  const out = [];
  if (cfg) {
    try {
      for (const ent of await $.fs.list(`${cfg}/plugins/data`)) {
        if (ent.name.startsWith("sotto")) out.push(`${cfg}/plugins/data/${ent.name}`);
      }
    } catch { /* no plugin data yet */ }
  }
  if (home) out.push(`${home}/.sotto`);
  return out;
}

/** Find the daemon whose D/active names this session; say hello; start the loops. */
async function discover($, why) {
  if (link || discovering) return;
  discovering = true;
  try {
    if (await integrationOff($)) return;
    const socket = await $.env.get("CLAUDE_CODE_MESSAGING_SOCKET");
    if (!socket) return;
    for (const dir of await dataDirs($)) {
      let a = null;
      try { a = parseActive(await $.fs.read(`${dir}/active`)); } catch { continue; }
      if (!a || !ownsSession(a.owner, socket)) continue;
      const url = `http://127.0.0.1:${a.port}`;
      let sessionId = null, cli = null;
      try { sessionId = await $.session.id(); } catch { /* none */ }
      try { cli = (await $.session.version()).version; } catch { /* none */ }
      let r;
      try {
        r = await $.http.fetch(`${url}/mod/hello`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Sotto-Key": a.key },
          body: JSON.stringify({ instance, socket, session_id: sessionId, cli, mod: MOD_VERSION, why }),
        });
      } catch { continue; }
      if (r.status !== 200) continue;
      let b = {};
      try { b = JSON.parse(r.text); } catch { continue; }
      const marker = markerFor(b.nonce || a.nonce);
      let context = "";
      try { context = String(await $.fs.read(`${$.plugin.root}/scripts/voice-context.txt`)).trim().split("@MARKER@").join(marker); } catch { /* framing is optional */ }
      link = { base: url, key: a.key, socket, marker, context };
      gen++;
      after = Number.isFinite(b.after) ? b.after : 0;
      sv = 0;
      // Where this plugin's daemon keeps its data, for /talk from the mod later.
      if (typeof b.data_dir === "string" && b.data_dir) {
        try { await $.store.set(`${STORE_DIR}:${$.plugin.root}`, b.data_dir); } catch { /* the classic /talk still works */ }
      }
      void pollLoop($, gen);
      void drain($, gen);
      void pushContext($);
      void registerTools($);
      return;
    }
  } catch { /* stay classic */ } finally {
    discovering = false;
  }
}

/** Downlink: long-poll the daemon for voice messages and UI state. */
async function pollLoop($, g) {
  let fails = 0;
  while (link && g === gen) {
    let r = null;
    try {
      r = await $.http.fetch(`${link.base}/mod/poll?instance=${instance}&after=${after}&sv=${sv}`, { headers: headers(false) });
    } catch { r = null; } // refused (daemon restarting) or the host's 30 s cap
    if (g !== gen || !link) return;
    if (!r) {
      fails++;
      if (fails >= 4) { unlink($); return; }
      await wait($, 250 * 2 ** fails);
      continue;
    }
    fails = 0;
    if (r.status === 410 || r.status === 409 || r.status === 403) {
      // Replaced, released or a new daemon process: look again.
      unlink($);
      void discover($, "relink");
      return;
    }
    if (r.status !== 200) { await wait($, 1000); continue; }
    let b;
    try { b = JSON.parse(r.text); } catch { continue; }
    if (b.release) { unlink($); return; }
    if (Number.isFinite(b.sv)) sv = b.sv;
    if (b.state) applyState($, b.state);
    for (const it of Array.isArray(b.items) ? b.items : []) {
      if (Number.isFinite(it.seq)) after = Math.max(after, it.seq);
      await onItem($, it);
    }
  }
}

/** The voice's state: the pinned status line, and a redraw of the band. */
function applyState($, state) {
  ui = state;
  $.ui.status(statusLine(state));
  $.ui.invalidate("ui.render");
}

function receipt(msgId, how, extra = {}) {
  push({ kind: "receipt", msg_id: msgId, how, ...extra });
}

/** One voice message from the daemon. */
async function onItem($, it) {
  if (!it || it.kind !== "inject" || typeof it.text !== "string" || typeof it.msg_id !== "string") return;
  if (seen.has(it.msg_id)) { receipt(it.msg_id, "duplicate"); return; }
  seen.add(it.msg_id);
  const where = del.route(it);
  if (where === "append") {
    let r = null;
    try {
      r = await $.session.append({ message: { type: "user", content: [{ type: "text", text: appendText(it.text, link ? link.context : "") }] } });
    } catch (err) { r = { deny: String(err) }; }
    if (r && r.deny) {
      // Refused (a guard above): it waits for the end of the turn instead.
      del.enqueue(it);
      receipt(it.msg_id, "queued", { note: "append_refused", error: String(r.deny).slice(0, 200) });
      return;
    }
    del.noteAppend(it.msg_id);
    receipt(it.msg_id, "appended", { prompt_id: promptId });
    $.ui.log("sotto: a voice message was added to Claude's running turn");
    return;
  }
  del.enqueue(it);
  if (where === "queue") receipt(it.msg_id, "queued");
  void pump($);
}

/** Submit queued messages one at a time, only while the session is idle. */
async function pump($) {
  if (pumping) return;
  pumping = true;
  try {
    let it;
    while (link && (it = del.nextQueued())) {
      // It resolves once its turn started; never wait on it unbounded (a
      // submit merged into another's turn never resolves).
      const out = await Promise.race([
        $.prompt.submit({ text: it.text, asUser: true }).then(() => "ok", (err) => `error ${err}`),
        wait($, SUBMIT_WAIT_MS).then(() => "timeout"),
      ]);
      if (out.startsWith("error")) receipt(it.msg_id, "failed", { error: out.slice(6), text: it.text, priority: it.priority });
      else {
        receipt(it.msg_id, "submitted", out === "timeout" ? { note: "unconfirmed" } : {});
        $.ui.log("sotto: a voice message was sent as your prompt");
      }
      // Its turn.start set busy; the rest waits for turn.complete.
    }
  } finally {
    pumping = false;
  }
}

function push(ev) {
  if (!link) return;
  up.push(ev);
  wakeDrain();
}

/** Uplink: POST the queued events in order, in batches. */
async function drain($, g) {
  if (draining) return;
  draining = true;
  try {
    let fails = 0;
    while (link && g === gen) {
      if (!up.size) { await new Promise((resolve) => { kick = resolve; }); continue; }
      await wait($, BATCH_MS); // let a burst (MessageDisplay deltas) collect
      if (!link || g !== gen) return;
      const events = up.batch(50);
      let r = null;
      try {
        r = await $.http.fetch(`${link.base}/mod/events`, { method: "POST", headers: headers(true), body: JSON.stringify({ instance, events }) });
      } catch { r = null; }
      if (g !== gen || !link) return;
      if (!r) { fails++; await wait($, Math.min(5000, 200 * 2 ** fails)); continue; }
      fails = 0;
      if (r.status === 410 || r.status === 409 || r.status === 403) { unlink($); void discover($, "relink"); return; }
      if (r.status !== 200) { await wait($, 1000); continue; }
      try { up.ack(JSON.parse(r.text).acked); } catch { /* resent next round; the daemon skips seen seqs */ }
    }
  } finally {
    draining = false;
  }
}

function forward(name, e) {
  if (!link) return;
  base = baseOf(e, base);
  push({ kind: "classic", event: name, body: forwardBody(name, e) });
}

/** The conversation as the session holds it, for the next Live session's seed. */
async function pushContext($) {
  if (!link) return;
  try { push({ kind: "context", messages: contextOf(await $.session.messages()) }); } catch { /* the transcript file is the fallback */ }
}

/** The model's voice controls, from the first link on (the same as `sotto voice|persona|status`). */
async function registerTools($) {
  if (toolsUp) return;
  toolsUp = true;
  const name = { type: "object", properties: { name: { type: "string", description: "The name to switch to; leave it out to list the choices." } } };
  try {
    await $.tool.register({ name: "voice", description: "Sotto (the user's spoken voice assistant): switch the voice it speaks with, or list the voices. Use it only when the user's own words clearly ask for a different voice; a yes to a voice the voice assistant offered counts.", inputSchema: name });
    await $.tool.register({ name: "persona", description: "Sotto (the user's spoken voice assistant): switch its persona (its personality), or list the personas with a line each. Use it only when the user clearly asks for a different persona or personality.", inputSchema: name });
    await $.tool.register({ name: "status", description: "Sotto (the user's spoken voice assistant): its state, voice, persona and today's usage, in one line.", inputSchema: { type: "object", properties: {} } });
  } catch { toolsUp = false; }
}

/** A voice tool call: the daemon's /control, as bin/sotto sends it. */
async function answerTool($, e) {
  const action = String(e.tool).slice(TOOL_PREFIX.length);
  if (!link) return { result: "sotto: voice is off in this session. The user turns it on with /talk." };
  const arg = typeof e.name === "string" ? e.name.trim().toLowerCase() : "";
  if (arg && !/^[a-z0-9_-]{1,40}$/.test(arg)) return { result: `sotto: unknown ${action}.` };
  const body = { action, via: "cli", session: { socket: link.socket } };
  if (action === "voice") { body.voice = arg; body.confirm = !!arg; }
  if (action === "persona") { body.persona = arg; body.confirm = !!arg; }
  try {
    const r = await $.http.fetch(`${link.base}/control`, { method: "POST", headers: headers(true), body: JSON.stringify(body) });
    const j = JSON.parse(r.text);
    return { result: typeof j.message === "string" ? j.message : "sotto: no answer from the voice daemon." };
  } catch (err) {
    return { result: `sotto: ERROR the voice daemon did not answer (${String(err).slice(0, 120)}).` };
  }
}

/**
 * /talk from the mod (phase 4): toggle.sh itself, run with the environment
 * Claude Code gives the classic hook (the data dir remembered from the
 * daemon's hello), so the messages, the daemon cold start and every argument
 * are the same. null: not possible here, the classic expansion runs it.
 */
async function talk($, e) {
  if (await integrationOff($)) return null;
  let dir = null;
  try { dir = await $.store.get(`${STORE_DIR}:${$.plugin.root}`); } catch { dir = null; }
  if (typeof dir !== "string" || !dir) return null;
  try { if (!(await $.fs.exists(`${dir}/logs`))) return null; } catch { return null; }
  let sessionId = "", cwd = "";
  try { sessionId = await $.session.id(); } catch { /* none */ }
  try { cwd = base.cwd || (await $.session.cwd()); } catch { /* none */ }
  const transcriptPath = base.transcript_path || transcriptPathFor(await configDir($), cwd, sessionId);
  const stdin = expansionInput({ sessionId, transcriptPath, cwd, permissionMode: base.permission_mode, args: e.args });
  let r;
  try {
    r = await $.process.run(["/bin/bash", `${$.plugin.root}/scripts/toggle.sh`], {
      stdin, timeoutMs: 30000,
      env: { ...optionEnv(options), CLAUDE_PLUGIN_ROOT: $.plugin.root, CLAUDE_PLUGIN_DATA: dir },
    });
  } catch {
    return null; // could not start: nothing ran, the classic hook may
  }
  const text = toggleText(r.stdout);
  if (link) void pushContext($);
  else void discover($, "talk");
  return { text: text || "voice could not be changed; see logs/toggle.log in the plugin data dir." };
}

export function register(on, opts) {
  options = opts || {};
  instance = newInstance();

  on("session.start", async ($, e, next) => {
    const r = await next(e);
    void discover($, "start");
    return r;
  });

  on("command.run", async ($, e, next) => {
    if (!isTalkCommand(e.command)) return next(e);
    const r = await talk($, e);
    return r || next(e);
  });

  // /talk ran toggle.sh in the classic expansion (a settings hook, below the
  // modules in the chain): once it returned, voice may be on for this session.
  on("classic.UserPromptExpansion", async ($, e, next) => {
    const r = await next(e);
    if (!link) void discover($, "talk");
    return r;
  });

  on("classic.UserPromptSubmit", async ($, e, next) => {
    if (!link) {
      void discover($, "prompt");
      return next(e);
    }
    if (!e.agent_id && typeof e.prompt_id === "string") promptId = e.prompt_id;
    forward("UserPromptSubmit", e);
    const r = await next(e);
    // hook.sh's framing, for a voice message submitted as a prompt: the same
    // marker rule, the same text (scripts/voice-context.txt).
    if (link && link.context && typeof e.prompt === "string" && e.prompt.startsWith(link.marker)) {
      return { ...(r || {}), additionalContext: [...((r && r.additionalContext) || []), link.context] };
    }
    return r;
  });

  on("classic.PreToolUse", async ($, e, next) => {
    if (link) push({ kind: "classic", event: "PreToolUse", body: forwardBody("PreToolUse", adaptPreToolUse(e, base, promptId)) });
    return next(e);
  });

  on("classic.PermissionRequest", async ($, e, next) => { forward("PermissionRequest", e); return next(e); });
  on("classic.MessageDisplay", async ($, e, next) => { forward("MessageDisplay", e); return next(e); });
  on("classic.Notification", async ($, e, next) => { forward("Notification", e); return next(e); });
  on("classic.Elicitation", async ($, e, next) => { forward("Elicitation", e); return next(e); });
  on("classic.SubagentStop", async ($, e, next) => { forward("SubagentStop", e); return next(e); });
  on("classic.TaskCompleted", async ($, e, next) => { forward("TaskCompleted", e); return next(e); });
  on("classic.TeammateIdle", async ($, e, next) => { forward("TeammateIdle", e); return next(e); });
  on("classic.PostToolUseFailure", async ($, e, next) => { forward("PostToolUseFailure", e); return next(e); });
  on("classic.PostToolUse", async ($, e, next) => { forward("PostToolUse", e); return next(e); });
  on("classic.PermissionDenied", async ($, e, next) => { forward("PermissionDenied", e); return next(e); });
  on("classic.StopFailure", async ($, e, next) => { forward("StopFailure", e); return next(e); });

  on("classic.Stop", async ($, e, next) => {
    if (link && !e.agent_id) {
      // Appends the model never read, reported before the Stop that would
      // otherwise count them as answered.
      for (const id of del.missedAtStop()) receipt(id, "requeued");
    }
    forward("Stop", e);
    return next(e);
  });

  on("classic.SessionEnd", async ($, e, next) => {
    forward("SessionEnd", e);
    if (link && up.size) {
      // Session hooks get 1.5 s in all: one direct POST, no batching wait.
      try { await $.http.fetch(`${link.base}/mod/events`, { method: "POST", headers: headers(true), body: JSON.stringify({ instance, events: up.batch(200) }) }); } catch { /* the daemon's liveness check covers it */ }
    }
    return next(e);
  });

  // A model request follows each batch of tool results: an append that
  // resolved before this point is in the next request. (Not turn.step: a
  // generator hook would take every streamed chunk of every session through
  // the mods worker, voice on or off.)
  on("classic.PostToolBatch", async ($, e, next) => {
    if (link && !e.agent_id) del.stepStart();
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    if (link) {
      del.turnStart(e.turnId);
      push({ kind: "turn", phase: "start", turn_id: e.turnId });
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const r = await next(e);
    if (link && !e.agentId) {
      del.turnComplete();
      push({ kind: "turn", phase: "complete", turn_id: e.turnId, reason: e.reason, ms: e.durationMs });
      void pump($);
      void pushContext($);
    }
    return r;
  });

  // Who started each subagent (phase 5): only the main thread's own Agent
  // calls are the user's; the daemon ignores the helpers.
  on("agent.spawn", async ($, e, next) => {
    const r = await next(e);
    if (link && r && typeof r.agentId === "string") {
      push({ kind: "agent", agent_id: r.agentId, parent_agent_id: e.parentAgentId || null, origin: next.origin && next.origin.plugin ? next.origin.plugin : null, background: !!e.background, tool_use_id: e.tool_use_id, description: String(e.description || "").slice(0, 120) });
    }
    return r;
  });

  // Approvals (phase 5): the engine's verdict by tool_use_id. Sotto's own tools
  // only change its voice settings: allowed without a prompt.
  on("tool.check", async ($, e, next) => {
    if (typeof e.tool === "string" && e.tool.startsWith(TOOL_PREFIX)) return { decision: "allow", reason: "Sotto's own voice settings" };
    const r = await next(e);
    if (link && r && r.decision === "ask" && typeof e.tool_use_id === "string") {
      const id = e.tool_use_id;
      asks.add(id);
      push({ kind: "approval", phase: "ask", tool_use_id: id, tool: e.tool });
      // A line under the dialog once it is open. Voice answers stay off.
      $.clock.after(300, () => {
        if (!asks.has(id)) return;
        try { $.ui.notice(id, "sotto: the voice is telling you about this; answer it here"); } catch { /* the dialog closed */ }
      });
    }
    return r;
  });

  on("tool.call", async ($, e, next) => {
    if (typeof e.tool === "string" && e.tool.startsWith(TOOL_PREFIX)) return await answerTool($, e);
    if (!link) return next(e);
    let r;
    try {
      r = await next(e);
    } catch (err) {
      if (asks.delete(e.tool_use_id)) push({ kind: "approval", phase: "resolved", tool_use_id: e.tool_use_id, outcome: "error", ...(e.agentId ? { agent_id: e.agentId } : {}) });
      throw err;
    }
    if (asks.delete(e.tool_use_id)) push({ kind: "approval", phase: "resolved", tool_use_id: e.tool_use_id, outcome: r && r.deny ? "denied" : "done", ...(e.agentId ? { agent_id: e.agentId } : {}) });
    return r;
  });

  // The band above the prompt (phase 6): what the voice is doing and its last
  // words, fitted to the band's width; a survey keeps the band.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (!link || !ui || (e.props && e.props.hasSurvey)) return next(e);
    const lines = bandLines(ui, e.props && e.props.bodyColumns);
    if (!lines.length) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    return Box({ flexDirection: "column", children: lines.map((t, i) => Text({ key: `l${i}`, dimColor: i > 0, bold: i === 0, wrap: "truncate-end", children: t })) });
  });

  void FORWARD;
}
