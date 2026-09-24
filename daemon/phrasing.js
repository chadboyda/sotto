// How the daemon's words reach the voice (SPEC §6.10, §8.1). Pure.
//
// Claude's replies are written reports: bold labels, bullet lists, paths,
// parentheticals, and a stock closing line ("No input needed from you.").
// Handed to gpt-live-1 as a quote ("Claude Code's answer: …"), the model read
// them nearly verbatim, and it sounded like a robot reading a memo. Results
// now go out as material to relay: a short frame that tells the voice to give
// the gist in its own words, then Claude's text with the markdown, labels,
// stock tag lines and repeated sentences taken out. The full reply still goes
// along as silent context, so the voice can answer "what else?".
//
// Fixed notices (approvals, questions, idle, can't hear) are short spoken
// lines with a few rotating variants each, so back-to-back ones don't sound
// canned. Every variant keeps its meaning: an approval always says approval
// and terminal, a question always says where to answer.
import { speakable, sentences, clip } from "./speech.js";

// ---- results: material to relay ---------------------------------------------------

/** Separates a relay frame from Claude's own words (speaker.js strips up to it). */
export const RELAY_MARK = "Claude said: ";

/** The relay rule every spoken result carries. */
export const RELAY_RULES = "Tell the user the gist in your own words, speaking to them as \"you\", conversationally, in one to three short sentences, in your persona. " +
  "Lead with the actual answer or outcome (the name, number or result itself), not just that Claude found or did something. " +
  "Don't read lists, labels, file paths or formatting aloud; mention details only if they matter or the user asks. " +
  "Stop when the news ends: no closing line about the user not needing to do anything.";
const ONE_LINE = "Mention it in one short sentence, in your own words, in your persona; skip paths, ids and formatting, and add no closing line about the user not needing to do anything.";

const quoteReq = (t, max) => clip(String(t || ""), max).replace(/"/g, "'");

/**
 * The commentary for a result: a frame plus the material.
 *   answer      the reply to what the user asked by voice
 *   earlier     the reply to a request from a previous Live session ({requestText})
 *   mirror      Claude's response to what the user just told the voice
 *   background  follow-up for an earlier voice request ({requestText})
 *   typed       a turn the user started by typing
 *   bgwork      background work started in a typed turn
 *   other       a turn nobody asked for out loud
 *   progress    Claude's own words mid-turn
 */
export function relay(kind, material, { requestText = "" } = {}) {
  const m = String(material || "").trim();
  switch (kind) {
    case "earlier":
      return `This answers the user's earlier request "${quoteReq(requestText, 160)}". ${RELAY_RULES}\n${RELAY_MARK}${m}`;
    case "mirror":
      return `Claude's response to what the user just said to you. ${RELAY_RULES}\n${RELAY_MARK}${m}`;
    case "background":
      return `Background work for the user's earlier request${requestText ? ` "${quoteReq(requestText, 120)}"` : ""} finished. ${RELAY_RULES}\n${RELAY_MARK}${m}`;
    case "typed":
      return `Claude finished something the user typed in the terminal. ${ONE_LINE}\n${RELAY_MARK}${m}`;
    case "bgwork":
      return `Background work the user started finished. ${ONE_LINE}\n${RELAY_MARK}${m}`;
    case "other":
      return `Claude finished some work. ${ONE_LINE}\n${RELAY_MARK}${m}`;
    case "progress":
      return `Claude's still working. If you mention it, one short sentence in your own words, no paths or formatting.\n${RELAY_MARK}${m}`;
    case "answer":
    default:
      return `Claude's reply to what the user asked. ${RELAY_RULES}\n${RELAY_MARK}${m}`;
  }
}

/** Claude's words inside a relay commentary (the whole text when it has no frame). */
export function materialOf(content) {
  const s = String(content ?? "");
  const i = s.indexOf(RELAY_MARK);
  return i >= 0 ? s.slice(i + RELAY_MARK.length) : s;
}

// Stock reassurances written reports end with. Said aloud after every update
// they are the canned tag line users notice first ("No input needed from you."
// three times in a row). A whole sentence of this shape is dropped; if nothing
// is needed from the user, nothing is said about it.
const TAGLINE_RE = new RegExp("^(?:(?:and|so|still|again|also|but)[, ]+)*(?:" + [
  "no (?:action|input|decision|approval)s?(?: is| are)?(?: (?:needed|required|necessary))?(?: (?:from|for|on) (?:you|your (?:end|side|part)))?(?: (?:here|now|right now|yet|on (?:this|that|those|these)))?",
  "nothing (?:is )?(?:needed |required )?(?:(?:for|from) you)(?: to do)?(?: (?:here|now|right now|yet|on (?:this|that|those|these)))?",
  "nothing (?:else )?(?:for you to do|you need to do|needed from you)(?: (?:here|now|right now|yet))?",
  "you don'?t (?:need|have) to do anything(?: (?:here|else|now|right now))?",
  "no need (?:for you )?to do anything(?: (?:here|else|now))?",
  "(?:there'?s )?nothing to (?:do|approve) on your (?:end|side|part)",
].join("|") + ")[.!]?$", "i");

/** Is this sentence a stock "nothing needed from you" tag line? */
export function isTagline(sentence) {
  const s = String(sentence || "").trim().replace(/^[—–-]\s*/, "").replace(/[.!…]+$/, "").trim();
  return !!s && TAGLINE_RE.test(s);
}

// "Label: text" at a sentence start (bold labels and bullet headers after
// speakable()): "What changes: It tells you…" → "It tells you…". Short labels
// only (at most five words) followed by a capitalized sentence, so a real
// sentence with a colon ("Found it: the window started late.") survives.
const LABEL_RE = /(^|[.!?…]\s+)([A-Z][\w'’-]*(?:[ \t]+[\w'’-]+){0,4}):[ \t]+(?=[A-Z0-9"“])/g;
export function stripLabels(text) {
  return String(text || "").replace(LABEL_RE, "$1");
}

/**
 * Markdown-level labels, before speakable() flattens them: a line that is only
 * a label ("**What changed:**", "### Next steps:") goes, and a bold label at
 * the start of a bullet or paragraph ("- **Threshold:** lowered…") is cut.
 */
export function stripMarkdownLabels(md) {
  return String(md ?? "").split(/\r?\n/)
    .filter((l) => !/^\s*(?:#{1,6}\s*)?(?:\*\*|__)?[^*_\n]{1,40}:(?:\*\*|__)?\s*$/.test(l) || /^\s*(?:[-*+•]|\d{1,3}[.)])\s/.test(l))
    .map((l) => l.replace(/^(\s*(?:(?:[-*+•]|\d{1,3}[.)])\s+)?)(?:\*\*|__)[^*_:\n]{1,40}(?::(?:\*\*|__)|(?:\*\*|__):)\s+(?=\S)/, "$1"))
    .join("\n");
}

const norm = (s) => String(s || "").toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Claude's markdown as material to relay: speakable (no code, tables, paths,
 * urls, secrets, markdown), without short labels, "(code omitted)" markers,
 * stock tag lines or a sentence said twice, at most `max` characters cut at a
 * sentence end.
 */
export function relayMaterial(md, max = 900) {
  const t = stripLabels(speakable(stripMarkdownLabels(md)).replace(/\s*\((?:code|table) omitted\)\.?/g, "")).replace(/\s+/g, " ").trim();
  const seen = new Set();
  const out = [];
  let len = 0;
  for (const s of sentences(t)) {
    const k = norm(s);
    if (!k || isTagline(s) || seen.has(k)) continue;
    seen.add(k);
    const add = (out.length ? 1 : 0) + s.length;
    if (len + add > max) {
      if (!out.length) out.push(clip(s, max));
      break;
    }
    out.push(s);
    len += add;
  }
  return out.join(" ");
}

// ---- fixed notices, with rotating variants ---------------------------------------------

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const stop = (t) => String(t || "").replace(/[.!?…]*$/, ".");

/**
 * Spoken templates. Each variant is a function of its slots. Variant 0 is the
 * plainest. The fixed part of every variant stays under TEMPLATE_MAX_CHARS
 * (test/daemon/phrasing.test.js); slots are clipped by the callers.
 */
export const TEMPLATES = Object.freeze({
  // Claude is blocked on a tool approval: always "approval" and "terminal".
  permission: [
    ({ label }) => `Claude needs your approval in the terminal to ${label}.`,
    ({ label }) => `Heads up, Claude's waiting for your approval in the terminal to ${label}.`,
    ({ label }) => `Claude wants to ${label}. It needs your approval in the terminal.`,
  ],
  // The same, from a subagent: the user may not know it runs.
  permissionAgent: [
    ({ label }) => `A background agent is waiting for your approval in the terminal to ${label}.`,
    ({ label }) => `Heads up, a background agent needs your approval in the terminal to ${label}.`,
    ({ label }) => `One of the background agents wants to ${label}. It needs your approval in the terminal.`,
  ],
  // Approvals still pending after a while (SPEC §6.10.4).
  reminder: [
    ({ label }) => `By the way, Claude's still waiting on your approval to ${label}.`,
    ({ label }) => `Just a reminder, Claude still needs your approval in the terminal to ${label}.`,
  ],
  reminderAgent: [
    ({ label }) => `By the way, a background agent is still waiting on your approval to ${label}.`,
    ({ label }) => `Just a reminder, a background agent still needs your approval in the terminal to ${label}.`,
  ],
  reminderMany: [
    ({ n }) => `By the way, ${n} approvals are still waiting for you in the terminal.`,
    ({ n }) => `Just a reminder, ${n} approvals are still waiting in the terminal.`,
  ],
  // A permission Notification: Claude Code's own message, or none.
  permissionNote: [
    ({ msg }) => (msg ? `Claude needs you in the terminal: ${stop(msg)}` : "Claude's waiting for your approval in the terminal."),
    ({ msg }) => (msg ? `Claude's waiting on you in the terminal: ${stop(msg)}` : "There's an approval waiting for you in the terminal."),
    ({ msg }) => (msg ? `Something needs you in the terminal: ${stop(msg)}` : "Claude needs your approval in the terminal."),
  ],
  // Claude went idle waiting for the user.
  idle: [
    () => "Claude's waiting for you in the terminal.",
    () => "Over to you, Claude's waiting in the terminal.",
    () => "Claude's stopped and is waiting on you in the terminal.",
  ],
  // AskUserQuestion with one question (q already ends in "?" and carries its options).
  questionOne: [
    ({ q }) => `Claude's asking: ${q} Answer in the terminal.`,
    ({ q }) => `Claude has a question: ${q} You can answer in the terminal.`,
    ({ q }) => `Quick question from Claude: ${q} Answer it in the terminal.`,
  ],
  questionMany: [
    ({ n, list }) => `Claude has ${n} questions for you in the terminal. ${list}`,
    ({ n, list }) => `Claude's got ${n} questions for you, answer them in the terminal. ${list}`,
  ],
  questionNone: [
    () => "Claude has a question for you in the terminal.",
    () => "Claude's asking you something in the terminal.",
  ],
  // ExitPlanMode.
  plan: [
    ({ title }) => `Claude's plan is ready for your approval in the terminal${title ? `: ${title}` : ""}.`,
    ({ title }) => `Claude has a plan ready${title ? `: ${title}` : ""}. It needs your approval in the terminal.`,
    ({ title }) => `The plan's ready for your approval in the terminal${title ? `: ${title}` : ""}.`,
  ],
  // An MCP server asks the user for input.
  elicitation: [
    ({ who, msg }) => `${who} is asking for your input in the terminal${msg ? `: ${msg}` : "."}`,
    ({ who, msg }) => `${who} needs something from you in the terminal${msg ? `: ${msg}` : "."}`,
  ],
  // A background Claude session needs the user.
  sessionInput: [
    ({ msg }) => `A background Claude session needs your input${msg ? `: ${stop(msg)}` : "."}`,
    ({ msg }) => `One of the background Claude sessions needs you${msg ? `: ${stop(msg)}` : "."}`,
  ],
  usageReset: [
    () => "Your usage limit has reset. Press Enter in the terminal to continue.",
    () => "The usage limit's reset. Press Enter in the terminal to keep going.",
  ],
  usageGaveUp: [
    () => "Claude stopped waiting for the usage limit, so the task didn't continue.",
    () => "Claude gave up waiting on the usage limit, so that task didn't pick back up.",
  ],
  // A main-thread step failed (walkthrough only). No exit codes aloud.
  toolFailure: [
    ({ label }) => `${cap(label)} failed.`,
    ({ label }) => `Hm, ${label} failed.`,
    ({ label }) => `Looks like ${label} failed.`,
  ],
  // The page cannot hear the user (§7.5). Said by the voice as given.
  cantHear: [
    () => "I can't hear you well. Check the mic in the voice window.",
    () => "I'm not picking you up. Can you check the mic in the voice window?",
    () => "Your audio isn't coming through. Try the mic in the voice window.",
  ],
});

/** Longest fixed text (slots empty) any variant may have. */
export const TEMPLATE_MAX_CHARS = 110;

/** Variant `variant` (rotating) of template `key` with `slots`. */
export function say(key, variant = 0, slots = {}) {
  const list = TEMPLATES[key];
  if (!list) throw new Error(`unknown template ${key}`);
  const n = Number.isInteger(variant) && variant >= 0 ? variant : 0;
  return list[n % list.length](slots);
}

/** Per-key rotation counter (one per Narrator / voice). */
export class Rotation {
  constructor() { this.n = new Map(); }
  /** The next variant for `key`: 0, 1, 2, … */
  next(key) {
    const v = this.n.get(key) || 0;
    this.n.set(key, v + 1);
    return v;
  }
}
