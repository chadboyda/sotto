// Speaking-policy routing (SPEC §6.10).
//
// `route()` is pure: (source, policy, payload, ctx) → list of appends.
// `Narrator` holds the small amount of timing state the table needs
// (milestone batching, walkthrough throttle, dedupe, progress_text hold) and
// is driven by an injected clock, so it stays deterministic in tests.
import { BG } from "./config.js";
import { speakable, summary, tokenChunks, fitTokens, firstSentences, clip, sentences } from "./speech.js";
import { policyChangeInstruction } from "./prompt.js";

const ANSWER = "Claude Code's answer: ";
/** Very short spoken summaries (milestones, turns the user did not ask for by voice). */
export const SHORT_SUMMARY_CHARS = 160;
const RANK = { quiet: 0, milestones: 1, walkthrough: 2 };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "a", "a or b", "a, b, or c" */
export function oxford(xs, conj = "or") {
  const a = xs.filter(Boolean);
  if (a.length <= 1) return a.join("");
  if (a.length === 2) return `${a[0]} ${conj} ${a[1]}`;
  return `${a.slice(0, -1).join(", ")}, ${conj} ${a[a.length - 1]}`;
}

/** One sentence for a batch of completions (with a detail only for a single one). */
function completionSentence(items, p) {
  if (items.length === 1) {
    const it = items[0];
    const detail = it.detail ? (p === "walkthrough" ? firstSentences(it.detail, 2) : clip(firstSentences(it.detail, 1), SHORT_SUMMARY_CHARS)) : "";
    return `${cap(it.what)} finished${detail ? `: ${detail}` : "."}`;
  }
  return `Finished: ${oxford(items.map((it) => it.what), "and")}.`;
}
const FULL = "Claude Code's full reply (abridged): ";

// Every append is clipped to the (estimated) token budget, not a char count.
const act = (kind, delegationId, content) => ({ kind, delegationId: delegationId ?? null, content: fitTokens(content) });

/** S and R for a final assistant message (§6.10). */
export function resultParts(text) {
  const sum = summary(text, 900);
  const full = speakable(text);
  const S = sum ? ANSWER + sum : "Claude Code finished, with nothing to report.";
  const R = full.length > sum.length ? tokenChunks(BG + FULL + full).slice(0, 2) : [];
  // The part of the reply after the summary, for walkthrough narration.
  const rest = full.length > sum.length && full.startsWith(sum) ? full.slice(sum.length).trim() : (full.length > sum.length ? sentences(full).slice(sentences(sum).length).join(" ") : "");
  return { sum, S, R, rest };
}

/**
 * route(source, policy, payload, ctx) → [{kind, delegationId, content}]
 *   payload: {text, delegationId, requestText, labels, label, policy}
 *   ctx:     {canSpeakProgress}  (walkthrough progress_text throttle)
 */
export function route(source, policy, payload = {}, ctx = {}) {
  const p = ["quiet", "milestones", "walkthrough"].includes(policy) ? policy : "milestones";
  switch (source) {
    case "voice_result": {
      const { S, R, rest } = resultParts(payload.text);
      // `earlier`: the request was made in a previous Live session, whose
      // delegation id the current session does not know. Speak it with a null
      // id and say which request it answers.
      const lead = payload.earlier ? `Result for your earlier request "${clip(payload.requestText || "", 160).replace(/"/g, "'")}": ` : "";
      const id = payload.earlier ? null : payload.delegationId;
      const out = [act("commentary", id, lead + S)];
      if (p === "walkthrough" && rest) for (const c of tokenChunks(rest).slice(0, 2)) out.push(act("commentary", id, c));
      for (const r of R) out.push(act("thinking", null, r));
      return out;
    }
    case "stale_result": {
      const { S } = resultParts(payload.text);
      return [act("thinking", null, `${BG}Result for the earlier request "${clip(payload.requestText || "", 200).replace(/"/g, "'")}": ${S}`)];
    }
    case "typed_result": {
      // A turn the user started by typing. Under milestones the summary is one
      // short sentence: it must not crowd out the voice conversation (§6.10.2).
      const { sum, S, R } = resultParts(payload.text);
      if (p === "quiet") return [act("thinking", null, BG + S)];
      const said = p === "milestones" ? clip(firstSentences(sum, 1), SHORT_SUMMARY_CHARS) : sum;
      return [act("commentary", null, said ? `Claude Code finished: ${said}` : "Claude Code finished."), ...R.map((r) => act("thinking", null, r))];
    }
    case "other_result": {
      // A turn nobody asked for as far as we know (no UserPromptSubmit seen, or
      // a system-originated prompt): context only, except in walkthrough.
      const { sum, S, R } = resultParts(payload.text);
      if (p !== "walkthrough" || !sum) return [act("thinking", null, BG + S)];
      return [act("commentary", null, `Claude Code finished: ${clip(firstSentences(sum, 1), SHORT_SUMMARY_CHARS)}`), ...R.map((r) => act("thinking", null, r))];
    }
    case "background_voice": {
      // A background task launched while answering a voice request finished:
      // the follow-up answer to that request. Spoken under every policy.
      const { sum, S, R } = resultParts(payload.text);
      const lead = payload.requestText ? `Update on your earlier request "${clip(payload.requestText, 120).replace(/"/g, "'")}": ` : "Update on your earlier request: ";
      const said = p === "walkthrough" ? sum : firstSentences(sum, 2);
      return [act("commentary", null, lead + (said || "the background work finished.")), ...R.map((r) => act("thinking", null, r))];
    }
    case "background_result": {
      // Background work launched in a typed turn (the user kicked it off).
      const { sum, S, R } = resultParts(payload.text);
      if (p === "quiet" || !sum) return [act("thinking", null, BG + "Background work finished. " + S)];
      const said = p === "milestones" ? clip(firstSentences(sum, 1), SHORT_SUMMARY_CHARS) : firstSentences(sum, 2);
      return [act("commentary", null, `Background work finished: ${said}`), ...R.map((r) => act("thinking", null, r))];
    }
    case "progress_text": {
      const t = speakable(payload.text);
      if (!t) return [];
      if (p === "walkthrough" && ctx.canSpeakProgress) return [act("commentary", null, clip(t, 400))];
      // Milestones: a long-running turn gets a spoken progress note at most every 30 s.
      if (p === "milestones" && ctx.canSpeakLongProgress) return [act("commentary", null, `Still working: ${clip(firstSentences(t, 1), SHORT_SUMMARY_CHARS)}`)];
      return [act("thinking", null, BG + clip(t, 600))];
    }
    case "question": {
      // Claude is blocked on the user (AskUserQuestion, plan approval): spoken
      // under every policy; `reference` (e.g. the plan) goes along silently.
      const out = [act("commentary", payload.delegationId, payload.text)];
      if (payload.reference) for (const c of tokenChunks(BG + payload.reference).slice(0, 2)) out.push(act("thinking", null, c));
      return out;
    }
    case "attention":
      // Something else waits on the user (MCP input, sign-in, a stale usage-limit resume).
      return [act("commentary", payload.delegationId, payload.text)];
    case "notice":
      return [act("commentary", null, payload.text)];
    case "context":
      return payload.text ? [act("thinking", null, BG + payload.text)] : [];
    case "completion": {
      const items = (payload.items || []).filter((it) => it && it.what);
      if (!items.length) return [];
      const spoken = items.filter((it) => RANK[p] >= RANK[it.level || "milestones"]);
      const out = [];
      if (spoken.length) out.push(act("commentary", null, completionSentence(spoken, p)));
      const notes = items.map((it) => `${cap(it.what)} finished${it.detail ? `: ${it.detail}` : "."}`).join(" ");
      out.push(act("thinking", null, BG + notes));
      return out;
    }
    case "idle":
      if (p === "quiet" || !payload.speak) return [act("thinking", null, BG + "Claude Code is idle, waiting for the user in the terminal.")];
      return [act("commentary", null, "Claude Code is waiting for you in the terminal.")];
    case "tool_failure": {
      const said = `${cap(payload.label || "a step")} failed${payload.exit ? ` with exit code ${payload.exit}` : ""}.`;
      const note = BG + `Claude Code tool failure: ${said}${payload.detail ? ` ${payload.detail}` : ""}`;
      if (p === "walkthrough" && ctx.canSpeakFailure) return [act("commentary", null, said), act("thinking", null, note)];
      return [act("thinking", null, note)];
    }
    case "tool_milestone": {
      const labels = (payload.labels || []).filter(Boolean);
      return labels.length ? [act("thinking", null, `${BG}Claude progress: ${labels.join("; ")}`)] : [];
    }
    case "permission":
      return [act("commentary", null, `Claude Code is waiting for your approval in the terminal to ${payload.label || "use a tool"}.`)];
    case "policy_change":
      return [act("instructions", null, policyChangeInstruction(payload.policy || p))];
    default:
      return [];
  }
}

// ---- milestone labels --------------------------------------------------------
const base = (p) => String(p || "").replace(/\/+$/, "").split("/").pop() || "a file";

/** Progress label (gerund) for a PreToolUse event. Never includes raw arguments. */
export function milestoneLabel(toolName, input = {}) {
  const i = input && typeof input === "object" ? input : {};
  switch (toolName) {
    case "Bash": {
      if (typeof i.description === "string" && i.description.trim()) return clip(i.description.trim(), 80);
      const first = String(i.command || "").trim().split(/\s+/)[0] || "a command";
      return `running ${base(first)}`;
    }
    case "Edit": case "Write": case "MultiEdit": case "NotebookEdit":
      return `editing ${base(i.file_path || i.notebook_path)}`;
    case "Read": return `reading ${base(i.file_path)}`;
    case "Grep": case "Glob": return "searching the code";
    case "WebFetch": case "WebSearch": return "searching the web";
    case "Agent": case "Task":
      return "starting a helper agent" + (typeof i.description === "string" && i.description.trim() ? `: ${clip(i.description.trim(), 60)}` : "");
    default: {
      const m = /^mcp__(.+?)__/.exec(toolName || "");
      if (m) return `using ${m[1].replace(/^plugin_/, "").replace(/_/g, " ")}`;
      return `using ${toolName || "a tool"}`;
    }
  }
}

/** Permission label (infinitive) for "…waiting for your approval … to <label>". */
export function permissionLabel(toolName, input = {}) {
  const i = input && typeof input === "object" ? input : {};
  switch (toolName) {
    case "Bash": return "run a shell command";
    case "Edit": case "Write": case "MultiEdit": case "NotebookEdit":
      return `edit ${base(i.file_path || i.notebook_path)}`;
    case "Read": return `read ${base(i.file_path)}`;
    case "Grep": case "Glob": return "search the code";
    case "WebFetch": case "WebSearch": return "search the web";
    case "Agent": case "Task": return "start a helper agent";
    default: {
      const m = /^mcp__(.+?)__/.exec(toolName || "");
      if (m) return `use ${m[1].replace(/^plugin_/, "").replace(/_/g, " ")}`;
      return `use ${toolName || "a tool"}`;
    }
  }
}

// ---- things Claude asks the user (§6.10.1) ----------------------------------------
const ORDINAL = ["First", "Second", "Third", "Fourth", "Fifth"];
const endPunct = (t) => (/[.!?…]$/.test(t) ? t : `${t}?`);
/** speakable() without the sentence punctuation it adds to every paragraph. */
const phrase = (t, max) => clip(speakable(t).replace(/[.;:,]+$/, ""), max);

/**
 * Spoken form of an AskUserQuestion input: every question with its option
 * labels, sanitized by speakable() (no code, paths, URLs or secrets).
 * "Claude's asking: Which layout? Options: A, B, or C. Answer in the terminal."
 */
export function questionSpeech(input = {}) {
  const qs = Array.isArray(input && input.questions) ? input.questions.filter((q) => q && typeof q === "object") : [];
  const parts = [];
  for (const q of qs.slice(0, 4)) {
    const raw = typeof q.question === "string" ? q.question : q.header || "";
    // Keep the question's own "?": speakable() would end it with a period.
    const text = /\?\s*$/.test(raw) ? `${phrase(raw.replace(/\?\s*$/, ""), 200)}?` : phrase(raw, 200);
    if (!text) continue;
    const labels = (Array.isArray(q.options) ? q.options : [])
      .map((o) => phrase(typeof o === "string" ? o : o && o.label, 60).replace(/[.!?…]+$/, ""))
      .filter(Boolean).slice(0, 6);
    let t = endPunct(text);
    if (labels.length) t += ` ${q.multiSelect ? "Pick any of" : "Options"}: ${oxford(labels, q.multiSelect ? "and" : "or")}.`;
    parts.push(t);
  }
  if (!parts.length) return "Claude Code has a question for you in the terminal.";
  if (parts.length === 1) return fitTokens(`Claude's asking: ${parts[0]} Answer in the terminal.`);
  return fitTokens(`Claude has ${parts.length} questions for you in the terminal. ${parts.map((t, i) => `${ORDINAL[i]}: ${t}`).join(" ")}`);
}

/** Spoken form of an ExitPlanMode input: "Claude's plan is ready for your approval…: <title>." */
export function planSpeech(input = {}, policy = "milestones") {
  const plan = typeof input?.plan === "string" ? input.plan : "";
  const h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(plan);
  const title = phrase(h ? h[1] : firstSentences(summary(plan, 200), 1), 100).replace(/[.!?…]+$/, "");
  let t = `Claude's plan is ready for your approval in the terminal${title ? `: ${title}` : ""}.`;
  if (policy === "walkthrough") {
    const body = summary(h ? plan.replace(h[0], "") : plan, 300);
    if (body) t += ` In short: ${body}`;
  }
  return { text: t, reference: plan ? `Claude's proposed plan (awaiting the user's approval in the terminal): ${speakable(plan)}` : "" };
}

/** A speakable MCP server name ("claude_ai_Slack" → "Slack"). */
export function serverName(name) {
  const n = String(name || "").replace(/^plugin_[^_]+_/, "").replace(/^claude_ai_/, "").replace(/[_-]+/g, " ").trim();
  return phrase(n, 40).replace(/[.!?…]+$/, "") || "an MCP server";
}

/** Spoken form of an Elicitation hook (an MCP server asking the user for input). */
export function elicitationSpeech(b = {}) {
  const who = serverName(b.mcp_server_name);
  if (b.mode === "url") return `${who} needs you to finish a step in your browser. Check the terminal.`;
  const msg = clip(speakable(b.message || ""), 160);
  return `${who} is asking for your input in the terminal${msg ? `: ${endPunct(msg).replace(/\?$/, ".")}` : "."}`;
}

// Notification types (hooks.md "Notification"): what each one means for the voice.
//   attention  → spoken under every policy (the user must act)
//   completion → batched completion (milestones+)
//   notice     → spoken under every policy (something went wrong)
//   resumed    → spoken milestones+
//   ignore     → nothing (covered elsewhere, or not about the user)
export const NOTIFICATION_KIND = Object.freeze({
  permission_prompt: "permission", // deduped against PermissionRequest
  idle_prompt: "idle",
  elicitation_dialog: "elicitation", // deduped against the Elicitation hook
  elicitation_url_dialog: "elicitation",
  agent_needs_input: "attention",
  agent_completed: "completion",
  quota_auto_resume_stale: "attention",
  quota_auto_resume_disabled: "notice",
  quota_auto_resume_fired: "resumed",
  auth_success: "ignore",
  elicitation_complete: "ignore",
  elicitation_response: "ignore",
});

/** Background launch? (Agent/Task/Workflow run in the background by default since CLI 2.1.198.) */
export function isBackgroundLaunch(toolName, input = {}) {
  const i = input && typeof input === "object" ? input : {};
  if (i.run_in_background === true) return true;
  if (toolName === "Agent" || toolName === "Task") return i.run_in_background !== false;
  return toolName === "Workflow";
}

// ---- stateful narrator ----------------------------------------------------------
export const MILESTONE_BATCH_MS = 3000;
export const WALKTHROUGH_THROTTLE_MS = 15000;
export const THINKING_DEDUPE_MS = 30000;
export const PERMISSION_DEDUPE_MS = 10000;
/** Subagent/task completions within this window are spoken as one sentence. */
export const COMPLETION_BATCH_MS = 3000;
/** Milestones: spoken progress only in a turn running this long, at most this often. */
export const LONG_PROGRESS_MS = 30000;
/** Walkthrough: at most one spoken tool failure per this long. */
export const FAILURE_THROTTLE_MS = 15000;
/** A Notification that repeats an announcement made this recently is not spoken again. */
export const ATTENTION_DEDUPE_MS = 120000;
/** The same question (tool_use_id or text) is announced once in this window. */
export const QUESTION_DEDUPE_MS = 10 * 60_000;
const ASKS = new Set(["AskUserQuestion", "ExitPlanMode"]);
const RESULT_SOURCES = new Set(["voice_result", "typed_result", "other_result", "background_result", "background_voice"]);

export class Narrator {
  /**
   * @param {object} o
   * @param {object} o.clock
   * @param {() => string} o.policy   current policy getter
   * @param {(action) => void} o.emit  send one {kind, delegationId, content}
   */
  constructor({ clock, policy, emit }) {
    this.clock = clock;
    this.policy = policy;
    this.emitRaw = emit;
    this.batch = [];
    this.batchTimer = null;
    this.lastLabel = null;
    this.lastProgressSpokenAt = -Infinity;
    this.recentThinking = new Map(); // content → sent at
    this.recentPermission = new Map(); // label → at
    // MessageDisplay batches are POSTed by independent background curls, so
    // they can arrive out of order (and after the turn's Stop). Batches are
    // buffered per message and assembled by `index` once the final one and
    // every lower index are in.
    this.msgs = new Map(); // message_id → {parts: Map(index → delta), finalIndex}
    this.doneMsgs = new BoundedSet(200); // message ids already assembled or closed by Stop
    this.stoppedPrompts = new BoundedSet(50); // prompt_ids whose Stop has been seen
    this.held = null; // final intermediate message waiting to see if a Stop follows
    this.completions = []; // pending completion items {what, detail, level}
    this.completionTimer = null;
    this.turnStartedAt = null; // main-thread turn start (UserPromptSubmit), for long-running progress
    this.lastLongProgressAt = -Infinity;
    this.lastFailureSpokenAt = -Infinity;
    this.recentQuestions = new Map(); // key → at
    this.lastAttention = new Map(); // "permission" | "question" | "elicitation" → at
    this.idleSaid = false; // spoken "waiting for you" this idle period
    this.resultSpoken = false; // this idle period began with a spoken result
  }

  /** Emit actions, dropping thinking appends identical to one sent in the last 30 s. */
  emit(actions) {
    const now = this.clock.now();
    for (const [k, t] of this.recentThinking) if (now - t > THINKING_DEDUPE_MS) this.recentThinking.delete(k);
    for (const a of actions) {
      if (a.kind === "thinking") {
        if (this.recentThinking.has(a.content)) continue;
        this.recentThinking.set(a.content, now);
      }
      this.emitRaw(a);
    }
  }

  route(source, payload) {
    const policy = this.policy();
    const ctx = {};
    const now = this.clock.now();
    if (source === "progress_text") {
      ctx.canSpeakProgress = now - this.lastProgressSpokenAt >= WALKTHROUGH_THROTTLE_MS;
      ctx.canSpeakLongProgress = this.turnStartedAt !== null && now - this.turnStartedAt >= LONG_PROGRESS_MS && now - this.lastLongProgressAt >= LONG_PROGRESS_MS;
    }
    if (source === "tool_failure") ctx.canSpeakFailure = now - this.lastFailureSpokenAt >= FAILURE_THROTTLE_MS;
    const actions = route(source, policy, payload, ctx).map((a) => ({ ...a, source }));
    const spoke = actions.some((a) => a.kind === "commentary");
    if (source === "progress_text" && spoke) { this.lastProgressSpokenAt = now; if (policy === "milestones") this.lastLongProgressAt = now; }
    if (source === "tool_failure" && spoke) this.lastFailureSpokenAt = now;
    if (RESULT_SOURCES.has(source)) { this.turnStartedAt = null; this.resultSpoken = spoke; this.idleSaid = false; }
    this.emit(actions);
    return actions;
  }

  /** PreToolUse: release a held intermediate message, then batch a milestone. */
  onToolUse(toolName, toolInput) {
    this.releaseHeld();
    if (ASKS.has(toolName)) return null; // spoken by onQuestion, not a milestone
    const label = milestoneLabel(toolName, toolInput);
    if (label === this.lastLabel || this.batch.includes(label)) return label;
    this.batch.push(label);
    if (!this.batchTimer) this.batchTimer = this.clock.setTimeout(() => this.flushMilestones(), MILESTONE_BATCH_MS);
    return label;
  }

  flushMilestones() {
    this.batchTimer = null;
    if (!this.batch.length) return;
    const labels = this.batch;
    this.batch = [];
    this.lastLabel = labels[labels.length - 1];
    this.route("tool_milestone", { labels });
  }

  /** PermissionRequest: speak once per label per 10 s. Questions are spoken by onQuestion. */
  onPermission(toolName, toolInput) {
    if (ASKS.has(toolName)) return null;
    const label = permissionLabel(toolName, toolInput);
    const now = this.clock.now();
    this.lastAttention.set("permission", now);
    const last = this.recentPermission.get(label);
    if (last !== undefined && now - last < PERMISSION_DEDUPE_MS) return null;
    this.recentPermission.set(label, now);
    this.route("permission", { label });
    return label;
  }

  /**
   * AskUserQuestion / ExitPlanMode (from PreToolUse, or PermissionRequest,
   * whichever comes first): speak the question once. Returns the spoken text,
   * or null for a duplicate.
   */
  onQuestion(toolName, toolInput, { toolUseId, delegationId = null } = {}) {
    const now = this.clock.now();
    for (const [k, t] of this.recentQuestions) if (now - t > QUESTION_DEDUPE_MS) this.recentQuestions.delete(k);
    const spoken = toolName === "ExitPlanMode" ? planSpeech(toolInput, this.policy()) : { text: questionSpeech(toolInput), reference: "" };
    // The same call may reach us from PreToolUse (with tool_use_id) and
    // PermissionRequest (without): dedupe on the spoken text too.
    const keys = [toolUseId && `id:${toolUseId}`, `text:${spoken.text}`].filter(Boolean);
    if (keys.some((k) => this.recentQuestions.has(k))) return null;
    for (const k of keys) this.recentQuestions.set(k, now);
    this.lastAttention.set("question", now);
    this.releaseHeld();
    this.route("question", { text: spoken.text, reference: spoken.reference, delegationId });
    return spoken.text;
  }

  /** Something other than a tool approval waits on the user (MCP elicitation, …). */
  onAttention(key, text, delegationId = null) {
    const now = this.clock.now();
    const last = this.lastAttention.get(key);
    if (last !== undefined && now - last < PERMISSION_DEDUPE_MS) return null;
    this.lastAttention.set(key, now);
    this.route("attention", { text, delegationId });
    return text;
  }

  recentlyAnnounced(keys, withinMs = ATTENTION_DEDUPE_MS) {
    const now = this.clock.now();
    return keys.some((k) => { const t = this.lastAttention.get(k); return t !== undefined && now - t < withinMs; });
  }

  /**
   * Notification hook. permission_prompt / elicitation dialogs repeat what
   * PermissionRequest / Elicitation already announced, so they are spoken only
   * if nothing was announced in the last 2 minutes. Returns what happened.
   */
  onNotification(b = {}) {
    const type = typeof b.notification_type === "string" ? b.notification_type : "";
    const kind = NOTIFICATION_KIND[type] || "other";
    const msg = clip(speakable(b.message || ""), 160);
    switch (kind) {
      case "permission":
        if (this.recentlyAnnounced(["permission", "question"])) return "deduped";
        this.lastAttention.set("permission", this.clock.now());
        this.route("attention", { text: msg ? `Claude Code needs you in the terminal: ${msg.replace(/[.!?…]*$/, ".")}` : "Claude Code is waiting for your approval in the terminal." });
        return "spoken";
      case "elicitation":
        if (this.recentlyAnnounced(["elicitation"])) return "deduped";
        this.onAttention("elicitation", msg ? `An MCP server needs your input in the terminal: ${msg.replace(/[.!?…]*$/, ".")}` : "An MCP server needs your input in the terminal.");
        return "spoken";
      case "idle": return this.onIdle();
      case "attention":
        if (type === "quota_auto_resume_stale") this.route("attention", { text: "Your usage limit has reset. Press Enter in the terminal to continue." });
        else this.route("attention", { text: `A background Claude session needs your input${msg ? `: ${msg.replace(/[.!?…]*$/, ".")}` : "."}` });
        return "spoken";
      case "notice":
        this.route("notice", { text: "Claude Code stopped waiting for the usage limit, so the task did not continue." });
        return "spoken";
      case "resumed":
        if (this.policy() === "quiet") this.route("context", { text: "Claude Code resumed the task after the usage limit reset." });
        else this.route("completion", { items: [{ what: "the usage-limit wait", detail: "Claude Code picked the task back up.", level: "milestones" }] });
        return "spoken";
      case "completion":
        this.onCompletion({ what: "a background Claude session", detail: msg, level: "milestones" });
        return "batched";
      case "ignore": return "ignored";
      default:
        if (msg) this.route("context", { text: `Claude Code notification: ${msg}` });
        return "context";
    }
  }

  /** idle_prompt: "waiting for you", once per idle period, unless its result was just spoken. */
  onIdle() {
    if (this.idleSaid) return "deduped";
    this.idleSaid = true;
    const speak = !this.resultSpoken && !this.recentlyAnnounced(["permission", "question", "elicitation"]);
    this.route("idle", { speak });
    return speak && this.policy() !== "quiet" ? "spoken" : "context";
  }

  /** A subagent / task / background session finished: batch for COMPLETION_BATCH_MS. */
  onCompletion(item) {
    if (!item || !item.what) return;
    if (this.completions.some((c) => c.what === item.what && c.detail === item.detail)) return;
    this.completions.push(item);
    if (!this.completionTimer) this.completionTimer = this.clock.setTimeout(() => this.flushCompletions(), COMPLETION_BATCH_MS);
  }

  flushCompletions() {
    if (this.completionTimer) this.clock.clearTimeout(this.completionTimer);
    this.completionTimer = null;
    if (!this.completions.length) return;
    const items = this.completions;
    this.completions = [];
    this.route("completion", { items });
  }

  /** PostToolUseFailure (main thread): context always, spoken only in walkthrough. */
  onToolFailure(toolName, toolInput, error) {
    const label = milestoneLabel(toolName, toolInput);
    const first = String(error || "").split("\n")[0];
    const m = /^Exit code (\d+)/.exec(first);
    const detail = m ? "" : clip(speakable(first), 160);
    this.route("tool_failure", { label, exit: m ? m[1] : null, detail });
    return label;
  }

  /** A main-thread turn started (UserPromptSubmit with a new prompt). */
  onTurnStart() {
    if (this.turnStartedAt === null) this.turnStartedAt = this.clock.now();
    this.idleSaid = false;
    this.resultSpoken = false;
  }

  /** Is this MessageDisplay stale (its message or its turn already ended)? */
  isLateMessage({ message_id, prompt_id } = {}) {
    if (message_id && this.doneMsgs.has(message_id)) return true;
    return typeof prompt_id === "string" && this.stoppedPrompts.has(prompt_id);
  }

  /**
   * MessageDisplay: buffer batches per message by index; once complete, a
   * message is held until we know it isn't the turn's last. Returns false for
   * a batch that arrived after its message or turn was already closed.
   */
  onMessageDisplay(b = {}) {
    if (this.isLateMessage(b)) return false;
    const id = b.message_id || "_";
    // A batch for a different message means a held one was intermediate.
    if (this.held && this.held.id !== id) this.releaseHeld();
    let m = this.msgs.get(id);
    if (!m) { m = { parts: new Map(), finalIndex: null }; this.msgs.set(id, m); }
    const idx = Number.isInteger(b.index) && b.index >= 0 ? b.index : m.parts.size;
    m.parts.set(idx, typeof b.delta === "string" ? b.delta : "");
    if (b.final) m.finalIndex = idx;
    if (m.finalIndex === null) return true;
    for (let i = 0; i <= m.finalIndex; i++) if (!m.parts.has(i)) return true; // wait for the gap
    let text = "";
    for (let i = 0; i <= m.finalIndex; i++) text += m.parts.get(i);
    this.msgs.delete(id);
    this.doneMsgs.add(id);
    if (text.trim()) this.held = { id, text };
    return true;
  }

  releaseHeld() {
    if (!this.held) return;
    const { text } = this.held;
    this.held = null;
    this.route("progress_text", { text });
  }

  /** Stop: the held message is the final answer; the Stop path covers it. */
  onStop(body = {}) {
    this.held = null;
    this.turnStartedAt = null;
    for (const id of this.msgs.keys()) this.doneMsgs.add(id);
    this.msgs.clear();
    if (typeof body.prompt_id === "string") this.stoppedPrompts.add(body.prompt_id);
  }

  /** Forget per-turn state (owner switch / off). */
  resetTurn() {
    this.held = null;
    this.msgs.clear();
  }

  dispose() {
    if (this.batchTimer) this.clock.clearTimeout(this.batchTimer);
    this.batchTimer = null;
    this.batch = [];
    if (this.completionTimer) this.clock.clearTimeout(this.completionTimer);
    this.completionTimer = null;
    this.completions = [];
  }
}

/** Insertion-ordered Set that forgets its oldest entries past `max`. */
class BoundedSet extends Set {
  constructor(max) { super(); this.max = max; }
  add(v) {
    super.delete(v);
    super.add(v);
    while (this.size > this.max) super.delete(this.values().next().value);
    return this;
  }
}
