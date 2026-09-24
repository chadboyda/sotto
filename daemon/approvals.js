// Pending tool approvals (SPEC §6.10.4). Pure: time comes from the injected clock.
//
// Claude Code has no "approval answered" hook, so an approval is pending from
// its PermissionRequest until the first evidence that the prompt is gone:
//  - PostToolUse / PostToolUseFailure / PermissionDenied for its tool_use_id;
//  - a later PreToolUse from the same thread (main session or one subagent):
//    a thread's next tool call means the prompt was answered;
//  - the thread ending: Stop (main thread) or that agent's SubagentStop;
//  - a UserPromptSubmit: the user typed into the terminal, where the dialog
//    had the focus;
//  - a Bash command that is visibly running (see findRunning): approval
//    starts it, and a long command's PostToolUse comes only when it exits.
//    Observed live (2026-09-24): a subagent's render script, approved after
//    1.5 min, ran another 3 min; the card said "Claude needs your approval"
//    the whole time.
//
// PermissionRequest carries no tool_use_id (hooks reference). Claude Code
// runs PreToolUse first for the same call, so the request is keyed by the
// tool_use_id of the thread's latest PreToolUse when tool name and input
// match; otherwise by a synthetic id.

/** Reminders while an approval stays pending: Claude Code never times a
 *  permission prompt out ("permission prompts ... never auto-resolve on idle",
 *  tools reference), so these are fixed offsets, at most two. */
export const REMIND_AT_MS = Object.freeze([2 * 60_000, 5 * 60_000]);
/** A PreToolUse this soon after the request may be a sibling in the same
 *  parallel batch, not the thread moving on. */
export const SIBLING_GRACE_MS = 1500;
/** Pending approvals kept at most (oldest dropped). */
export const MAX_PENDING = 20;

const MAIN = "main";
const threadOf = (b) => (typeof b?.agent_id === "string" && b.agent_id ? b.agent_id : MAIN);

/** Stable comparison key for a tool input (key order kept as sent). */
function inputKey(input) {
  try { return JSON.stringify(input ?? null); } catch { return ""; }
}

export class Approvals {
  constructor({ clock }) {
    this.clock = clock;
    this.pending = new Map(); // id → {id, thread, agent, tool, input, command, label, at, reminders}
    this.lastPre = new Map(); // thread → {id, tool, input, at}
    this.seq = 0;
  }

  get size() { return this.pending.size; }
  list() { return [...this.pending.values()]; }
  /** The approval the card shows: the newest. */
  current() { let last = null; for (const p of this.pending.values()) last = p; return last; }

  /**
   * PreToolUse. Remembers the call (a PermissionRequest may follow) and
   * resolves this thread's older approvals. Returns the resolved ones.
   */
  onPreToolUse(b = {}) {
    const now = this.clock.now();
    const thread = threadOf(b);
    const id = typeof b.tool_use_id === "string" ? b.tool_use_id : null;
    this.lastPre.set(thread, { id, tool: b.tool_name, input: inputKey(b.tool_input), at: now });
    if (this.lastPre.size > 200) this.lastPre.delete(this.lastPre.keys().next().value);
    return this.resolveWhere((p) => p.thread === thread && p.id !== id && now - p.at >= SIBLING_GRACE_MS, "next_tool");
  }

  /**
   * PermissionRequest. Returns {approval, fresh}: fresh is false when the
   * same call is already pending (a repeated hook), which is not announced again.
   */
  onRequest(b = {}, label = "") {
    const now = this.clock.now();
    const thread = threadOf(b);
    const input = inputKey(b.tool_input);
    for (const p of this.pending.values()) {
      if (p.thread === thread && p.tool === b.tool_name && p.input === input) return { approval: p, fresh: false };
    }
    const pre = this.lastPre.get(thread);
    const matched = pre && pre.id && pre.tool === b.tool_name && pre.input === input;
    const id = matched ? pre.id : `perm-${++this.seq}`;
    const command = b.tool_name === "Bash" && typeof b.tool_input?.command === "string" ? b.tool_input.command : null;
    const p = { id, thread, agent: thread !== MAIN, tool: b.tool_name || "", input, command, label, at: now, reminders: 0 };
    this.pending.set(id, p);
    while (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value);
    return { approval: p, fresh: true };
  }

  /** PostToolUse / PostToolUseFailure / PermissionDenied for one call. */
  onToolDone(b = {}) {
    const id = typeof b.tool_use_id === "string" ? b.tool_use_id : null;
    if (id && this.pending.has(id)) return this.resolveWhere((p) => p.id === id, "tool_done");
    // An approval we could not key (no matching PreToolUse): the thread's
    // next finished tool means the prompt is gone.
    const thread = threadOf(b);
    const now = this.clock.now();
    return this.resolveWhere((p) => p.thread === thread && p.id.startsWith("perm-") && now - p.at >= SIBLING_GRACE_MS, "tool_done");
  }

  /** Stop (main thread) or SubagentStop (that agent). */
  onThreadEnd(b = {}) {
    const thread = threadOf(b);
    this.lastPre.delete(thread);
    return this.resolveWhere((p) => p.thread === thread, "stop");
  }

  /** UserPromptSubmit: the user typed in the terminal. */
  onUserPrompt() { return this.resolveWhere(() => true, "prompt"); }

  /** A running approved command (process probe). */
  resolve(id, reason) { return this.resolveWhere((p) => p.id === id, reason); }

  clear() { const n = this.pending.size; this.pending.clear(); this.lastPre.clear(); return n; }

  resolveWhere(pred, reason) {
    const out = [];
    for (const p of [...this.pending.values()]) {
      if (pred(p)) { this.pending.delete(p.id); out.push({ ...p, reason }); }
    }
    return out;
  }

  /** Approvals whose next reminder is due now (bumps their count). */
  takeDue(now = this.clock.now()) {
    const due = [];
    for (const p of this.pending.values()) {
      const at = REMIND_AT_MS[p.reminders];
      if (at !== undefined && now - p.at >= at) due.push(p);
    }
    return due;
  }

  /** Wall time of the next reminder, or null. */
  nextDueAt() {
    let next = null;
    for (const p of this.pending.values()) {
      const at = REMIND_AT_MS[p.reminders];
      if (at !== undefined && (next === null || p.at + at < next)) next = p.at + at;
    }
    return next;
  }

  /** Pending Bash approvals the process probe can look for. */
  probeable() { return this.list().filter((p) => p.command && commandFingerprint(p.command)); }
}

// ---- process probe ---------------------------------------------------------------------
// Claude Code runs an approved Bash command as `/bin/zsh -c ... eval '<command>' ...`
// (measured, CLI 2.1.28x): the command text is on the shell's argv, with each
// `'` rewritten as `'"'"'`. The longest quote-free line of the command is
// therefore a literal substring of that process's command line.

/** The literal piece of `command` to look for in `ps` output, or null if too short to be distinctive. */
export function commandFingerprint(command) {
  let best = "";
  for (const piece of String(command || "").split(/['\\\n\r\t]/)) {
    const t = piece.trim();
    if (t.length > best.length) best = t;
  }
  if (best.length < 16) return null;
  return best.slice(0, 120);
}

/**
 * Is a process running that carries this fingerprint? `ps` is the output of
 * `ps -axo pid=,command=`; `selfPids` are ours (the probe itself).
 */
export function findRunning(ps, fingerprint, selfPids = []) {
  if (!fingerprint) return false;
  for (const line of String(ps || "").split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || selfPids.includes(Number(m[1]))) continue;
    if (m[2].includes(fingerprint)) return true;
  }
  return false;
}
