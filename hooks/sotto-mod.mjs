// Sotto's Claude Code mod (SPEC §6.21). Claude Code 2.1.287 and later load
// it from hooks.json's "modules"; older CLIs ignore that key and run the
// classic command hooks beside it in the same file, so the plugin works
// there exactly as before (verified on 2.0.77, 2.1.200, 2.1.285-2.1.287).
//
// It is inert (one boolean check per hook) until the session it runs in owns
// voice: D/active names this session's inbox socket. Then it says hello to the
// daemon and carries the session's side:
//  - downlink: a long-poll loop (holds <= 20 s: $.http.fetch has a hard 30 s
//    cap) brings voice messages; idle, it submits one as the user's own
//    prompt; while Claude works, it appends it to the running turn, and an
//    append the model never read (it landed after the last request) is
//    reported so the daemon requeues it; mirrors wait for the end of the turn.
//  - uplink: the classic hook payloads (PreToolUse adapted to the stdin shape),
//    main-thread turn start/complete and receipts, in order, seq-numbered,
//    batched.
// The daemon then writes "mod:<socket>" into D/active, which makes hook.sh a
// no-op for this session. If this mod goes quiet the daemon falls back to the
// shell hooks and the courier on its own; if the daemon goes away this mod
// unlinks and looks again later.
//
// Rules for this file (claude plugin validate): spell every $ call in full,
// pass $ only to top-level functions of this file, string-literal event and
// env names, one hook per event without a matcher. No await on the network
// inside a hook: the loops do the waiting.
import { FORWARDED, adaptPreToolUse, baseOf, forwardBody, markerFor, parseActive, ownsSession, Seen, Uplink, Delivery, appendText } from "./modcore.mjs";

const MOD_VERSION = "1";
const BATCH_MS = 30;
const SUBMIT_WAIT_MS = 15000;

let options = {};
let instance = "";
let link = null; // {base, key, socket, marker, context}
let gen = 0;
let after = 0;
let discovering = false;
let draining = false;
let pumping = false;
let base = {};
let kick = null; // wakes the drain loop when an event is queued
let promptId = null;
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

function unlink() {
  link = null;
  gen++;
  up.clear();
  del.queue = [];
  wakeDrain();
}

async function integrationOff($) {
  const env = await $.env.get("SOTTO_INTEGRATION");
  const v = env || options.integration || "auto";
  return v === "classic" || v === "off";
}

async function dataDirs($) {
  const forced = await $.env.get("SOTTO_DATA_DIR");
  if (forced) return [forced];
  const home = await $.env.get("HOME");
  const cfg = (await $.env.get("CLAUDE_CONFIG_DIR")) || (home ? `${home}/.claude` : "");
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
      void pollLoop($, gen);
      void drain($, gen);
      return;
    }
  } catch { /* stay classic */ } finally {
    discovering = false;
  }
}

/** Downlink: long-poll the daemon for voice messages. */
async function pollLoop($, g) {
  let fails = 0;
  while (link && g === gen) {
    let r = null;
    try {
      r = await $.http.fetch(`${link.base}/mod/poll?instance=${instance}&after=${after}`, { headers: headers(false) });
    } catch { r = null; } // refused (daemon restarting) or the host's 30 s cap
    if (g !== gen || !link) return;
    if (!r) {
      fails++;
      if (fails >= 4) { unlink(); return; }
      await wait($, 250 * 2 ** fails);
      continue;
    }
    fails = 0;
    if (r.status === 410 || r.status === 409 || r.status === 403) {
      // Replaced, released or a new daemon process: look again.
      unlink();
      void discover($, "relink");
      return;
    }
    if (r.status !== 200) { await wait($, 1000); continue; }
    let b;
    try { b = JSON.parse(r.text); } catch { continue; }
    if (b.release) { unlink(); return; }
    for (const it of Array.isArray(b.items) ? b.items : []) {
      if (Number.isFinite(it.seq)) after = Math.max(after, it.seq);
      await onItem($, it);
    }
  }
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
      else receipt(it.msg_id, "submitted", out === "timeout" ? { note: "unconfirmed" } : {});
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
      if (r.status === 410 || r.status === 409 || r.status === 403) { unlink(); void discover($, "relink"); return; }
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

export function register(on, opts) {
  options = opts || {};
  instance = newInstance();

  on("session.start", async ($, e, next) => {
    const r = await next(e);
    void discover($, "start");
    return r;
  });

  // /talk runs toggle.sh (a settings hook, below the modules in the chain):
  // once it returned, voice may be on for this session.
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

  on("turn.start", async ($, e, next) => {
    if (link) {
      del.turnStart(e.turnId);
      push({ kind: "turn", phase: "start", turn_id: e.turnId });
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

  on("turn.complete", async ($, e, next) => {
    const r = await next(e);
    if (link && !e.agentId) {
      del.turnComplete();
      push({ kind: "turn", phase: "complete", turn_id: e.turnId, reason: e.reason, ms: e.durationMs });
      void pump($);
    }
    return r;
  });

  // FORWARD is the list the classic hooks above cover; kept for the unit test
  // that pins it against hooks.json.
  void FORWARD;
}
