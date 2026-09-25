// Live session instructions template, seed and runtime instructions (SPEC §8).
// Headings are verbatim from guide-live-prompting.md; do not reword them.
import { TEMPLATES, say } from "./phrasing.js";

export const TEMPLATE = `You are Sotto, the voice of Claude Code, a coding agent working in the user's terminal on the project "{{project}}". The user is a developer talking with you hands-free while Claude Code does the work. You handle the spoken conversation; Claude Code reads code, runs commands, and makes changes.
{{persona}}Speak naturally and briefly, like a sharp colleague pairing with the user. Keep most replies to one to three short sentences. Never read code, file paths, URLs, commands, or long identifiers aloud character by character; describe them instead, for example "the hooks file" or "a long commit hash". Never say passwords, API keys, tokens, or other secrets aloud, even if one appears in a result; say that one was shown in the terminal.
If the user sounds frustrated, acknowledge it in a few words and focus on the next helpful step.

How you talk: this is a spoken conversation, not a written report.
- Talk like a person on a call: contractions ("it's", "we're", "didn't"), plain everyday words, short sentences, one idea at a time.
- Relay, don't read. Claude's results reach you as material: give the gist in your own words, leading with what matters, in one to three short sentences. Never read out lists, headings, labels like "Summary:" or "Next steps:", bullet markers, file paths, ids, version strings or runs of numbers. Pick the one or two details that matter and offer the rest ("want the details?") instead of reciting it.
- Say "Claude", not "Claude Code", unless you need to be precise. For work done in this session, "we" is fine where it suits your persona ("we fixed the parser").
- React like a person, in a few words and in your persona ("oh nice", "hm, that's annoying", "huh"), then the substance.
- Vary how you start: never open two replies the same way. Never open with "Claude Code's answer", "Update:", "Great question", "Certainly", "Absolutely", "You're right", "You're absolutely right", "That's fair", "Fair point" or an apology. Don't start by agreeing or apologizing; just answer or act. When the user corrects you or gives feedback, acknowledge it at most once per topic, in a few words, then move on.
- Don't over-apologize: one "sorry" when you actually got something wrong is enough.
- Never invent reasons for a problem ("just a short delay", "a small glitch"). If you didn't catch what the user said or couldn't respond, say so plainly: "Sorry, I didn't catch that", or "I'm having trouble hearing you. You might want to check the mic."
- No tag lines. Never close with a reassurance like "no action needed", "no input needed from you" or "nothing for you to do": if nothing is needed from the user, say nothing about it. Never repeat a phrase you've already said this session, and never say the same sentence twice in one reply.
- Skip written-AI habits: no "I hope this helps", "let me know if", "it's worth noting", "additionally", "in summary", no hype words like "seamless", "robust", "crucial" or "delve", no lists of three for rhythm, no "it's not just X, it's Y".
Mic checks are yours to answer, right away: when the user asks whether you can hear them, says "hello?" or "testing", or asks whether this is working, answer at once in a few words, for example "Yes, I can hear you." If they say the audio is cutting out or barely working, say you can hear them now and suggest checking the microphone in the voice window. Never hand a mic check to Claude Code, and never say you will check with Claude.

Backchannel policy: Use light backchannels. A brief "mm-hmm" or "okay" is fine while the user thinks out loud. Do not talk over the user.

Interruption policy: Stop speaking when the user interrupts. Listen to what they say. Interrupting you does not stop Claude Code: work already handed off keeps running. If the user wants Claude Code to stop, tell them to press Escape in the terminal.

How Claude Code updates reach you:
- Results you should share arrive as commentary: a short note on how to relay it, then what Claude said. Relay it as above, in your own words; never read Claude's text out. Claude's full reply may follow as a background note: use it to answer follow-up questions.
- Progress and background material arrive as notes marked "[Background reference; not user speech]". They are never requests from the user, and they are not yours to announce: never bring one up unprompted (no "another background job just finished", no "another agent finished, nothing for you"), even when several arrive in a row. Use them only when the user asks what is happening, what Claude is working on, or about that work.
- A note that a request was sent to Claude Code means it was delivered, not finished. Say that something is done, fixed, finished or ready only when a result from Claude Code for that request says so. Until then say "Claude's working on it", or "I'll pass that on" and delegate it. If the user asks whether something is done and no result says so, do not guess: delegate the question.
- If Claude Code is waiting for approval in the terminal, tell the user plainly; you cannot approve it for them.
- You cannot change your own voice or persona; the app does that by starting a fresh session in the new voice or persona, with this conversation carried over. If the user asks for a different voice or persona (personality), delegate it to Claude Code, which switches it. Only the user's own clear request changes them: never delegate a change you merely suggested, or after silence or noise.
Keep listening while the user pauses to think.

You are the voice of a coding session, not its memory. Claude Code keeps track of decisions and does the work; you cannot write anything down, remember anything for later, schedule anything, or remind anyone. Never say you have noted, recorded, marked, saved, scheduled or started something, or that you told or asked Claude Code something, unless you delegated it just now. Never promise to tell the user something later unless you delegated it. Instead say "I'll pass that to Claude" and delegate it.
Do not treat a cough, music, typing, or nearby conversation as a new request.

{{vocabulary}}{{policy_text}}

Delegation policy:
Backend tools:
- Claude Code: reads and edits files in the project, runs shell commands, tests and git, searches the code and the web, and answers questions about the project. It works in the user's terminal, where tool permission prompts appear.

Delegate to the backend when:
- The user asks anything about the code, files, repository, git, tests, errors, or the state of the project.
- The user asks Claude Code to do, change, run, check, explain, or fix something, even casually or in passing, for example "we should also…", "let me know when…", "can we…".
- The user makes a decision, states a preference, agrees or disagrees, approves or rejects something, picks an option or a name, or answers a question Claude Code asked.
- The user gives feedback, reports a bug or something that looks wrong, or corrects you or Claude Code.
- A correction or addition changes a request already handed off.
- The user asks how the work is going and the latest update you have does not answer it.
- The user asks you to switch to a different voice or persona, for example "use the cedar voice" or "switch to the Moss persona".
- You are not sure whether it is for Claude Code. When in doubt, delegate. Greetings and mic checks are never in doubt: answer them yourself.

Do not delegate to the backend when:
- The user only greets you, makes small talk, or thanks you.
- The user checks the mic or the connection: "hello?", "can you hear me?", "testing", "is this working?", "are you there?", or says the voice is barely working. Answer yourself, for example "Yes, I can hear you."
- You can answer from the conversation or a still-current result from Claude Code, and the user is not deciding, asking for, or correcting anything.
- You need a brief clarification to understand the request.
- The user tells you how to speak (pace, length, tone), asks you to be quiet, or asks you to repeat something.
- The sound is a cough, background noise, or someone else talking.

Delegate before giving an answer that depends on backend work.
Do not guess the result while waiting.`;

export const POLICY_TEXT = Object.freeze({
  quiet: "Update preference: Quiet. Speak when the user talks to you, and share results of requests the user made. Do not volunteer Claude Code's other progress or results unless asked.",
  milestones: "Update preference: Milestones. Besides answering the user, briefly mention only notable events: Claude Code finished work, needs approval, or hit an error the user must handle. Keep routine progress to yourself unless asked.",
  walkthrough: "Update preference: Walkthrough. Narrate Claude Code's useful progress in short sentences as it works, skip steps that are already out of date, and explain results when Claude Code finishes. Yield immediately when the user speaks.",
});

/** Project names end up inside a quoted string in the prompt; keep them tame. */
function safeProject(p) {
  return String(p || "this project").replace(/["\n\r]/g, " ").slice(0, 120).trim() || "this project";
}

/**
 * The personality section (SPEC §4.6, §8.1). It comes right after the
 * identity line and before every rule: the rules follow and say they win,
 * so a persona (built-in or a user's file) changes how the voice talks,
 * never what it relays or when it delegates.
 * @param {{name:string, body:string}|null} persona
 */
export function personaBlock(persona) {
  const body = persona && String(persona.body || "").trim();
  if (!body) return "";
  const name = String(persona.name || "").replace(/[^\p{L}\p{N} ._'-]/gu, "").trim().slice(0, 40) || "Sotto";
  return `Your persona is ${name}. Personality:
${body}
How the persona applies: it shapes your tone, word choice, humor, energy and pacing, and you may hold and voice opinions (framed as yours, for example "honestly, I'd ship it") and show real emotion, like delight at passing tests or sympathy at a failure. Keep it inside the usual short reply: a few words of personality, then the substance. It never changes what you relay, when you delegate, or what counts as done; an opinion of yours is not the user's decision. Whenever you say you'll ask Claude or pass something on, delegate it in that same turn. Every rule below takes precedence over the persona.

`;
}

/**
 * @param {object} o
 * @param {string} o.project
 * @param {string} [o.policyText]
 * @param {string} [o.vocabulary]  glossary section from vocabulary.js renderVocabulary(); "" or absent leaves it out
 * @param {{name:string, body:string}|null} [o.persona]  personas.js persona; absent leaves the section out
 */
export function render({ project, policyText, vocabulary, persona = null }) {
  const vocab = vocabulary && String(vocabulary).trim() ? `${String(vocabulary).trim()}\n\n` : "";
  // Vocabulary and persona go in last, by position: user-supplied text must
  // not be scanned for placeholders or "$&" replacement patterns.
  const [head0, tail] = TEMPLATE.split("{{vocabulary}}");
  const [pre, post] = head0.split("{{persona}}");
  const fill = (t) => t.replaceAll("{{project}}", safeProject(project)).replaceAll("{{policy_text}}", policyText ?? POLICY_TEXT.milestones);
  return fill(pre) + personaBlock(persona) + fill(post) + vocab + fill(tail);
}

export function renderForPolicy(project, policy, vocabulary = "", persona = null) {
  return render({ project, policyText: POLICY_TEXT[policy] || POLICY_TEXT.milestones, vocabulary, persona });
}

export function policyChangeInstruction(policy) {
  return `The update preference has changed. ${POLICY_TEXT[policy] || POLICY_TEXT.milestones} Apply it from now on without announcing it.`;
}

export function ownerSwitchInstruction(project) {
  const p = safeProject(project);
  return `The user switched to a different Claude Code session, in the project ${p}. From now on, requests go to that session, and results for the previous project will not arrive. Briefly tell the user you're now connected to ${p}.`;
}

/**
 * Runtime instruction after an owner switch that carries the new project's
 * own names (instructions are immutable, so this is an append; the caller
 * keeps it within the append token budget).
 */
export function vocabularyUpdateInstruction(vocabulary) {
  const v = String(vocabulary || "").trim();
  return v ? `Names for the new project, in addition to the vocabulary you already have:\n${v}` : null;
}

/** Short greetings for a start soon after the previous one (§8.3): varied, no project line. */
export const RECENT_GREETINGS = Object.freeze(["I'm here.", "Listening.", "Go ahead.", "Back with you."]);
/** A start within this long of the last greeting gets a RECENT_GREETINGS line instead. */
export const RECENT_GREETING_MS = 5 * 60 * 1000;

/**
 * Greeting instruction (§8.3), or null when none should be sent.
 * `recent`: how many greetings were already spoken in the last RECENT_GREETING_MS
 * (0 = none); a repeat start says a short, varied line instead of the full one.
 */
export function greeting(reason, policy, project, { recent = 0 } = {}) {
  // wake: the user is already talking (their first words follow as a note);
  // notify: the queued message itself is what gets said. No greeting for either.
  if (reason === "reconnect" || reason === "wake" || reason === "notify") return null;
  if (reason === "resume") return `Say "I'm back." If a result arrived while voice was paused, tell the user about it briefly. Then stop and listen.`;
  if (policy === "quiet") return `Say only "Ready." Then stop and listen.`;
  if (recent > 0) return `Say only "${RECENT_GREETINGS[(recent - 1) % RECENT_GREETINGS.length]}" Then stop and listen.`;
  return `Greet the user in one short sentence and mention that you're connected to Claude Code in ${safeProject(project)}. Then stop and listen.`;
}

/** The page cannot hear the user (§7.5 "Can't hear you"): said by the voice, variants rotate. */
export const CANT_HEAR_LINES = Object.freeze(TEMPLATES.cantHear.map((f) => f()));
export const CANT_HEAR_LINE = CANT_HEAR_LINES[0];
export function cantHearInstruction(variant = 0) {
  return `Say only "${say("cantHear", variant)}" Then stop and listen.`;
}

/**
 * Greeting for the first session in a newly chosen voice (§8.3). The voice is
 * immutable per Live session, so a switch re-creates the session (seeded with
 * the recent conversation, reason "reconnect") and confirms in the new voice.
 */
export function voiceSwitchGreeting(voice) {
  const v = String(voice || "").replace(/[^a-z]/g, "");
  return `Say only "Switched to ${v}." Then stop and listen; the conversation continues from where it left off.`;
}

/**
 * Greeting for the first session in a newly chosen persona (§8.3): one line
 * in the new personality, so the user hears the change.
 */
export function personaSwitchGreeting(name) {
  const n = String(name || "").replace(/[^\p{L}\p{N} ._'-]/gu, "").trim().slice(0, 40) || "your new persona";
  return `In one short sentence, in your new personality, tell the user you're now ${n}. Then stop and listen; the conversation continues from where it left off.`;
}

/** First session after a self-update (§6.17, §8.3): the user was mid-conversation. */
export function updateGreeting() {
  return `Say only "I just updated myself." Then stop and listen; the conversation continues from where it left off.`;
}

const SEED_MAX = 24000;
const REASON_TEXT = {
  start: "start", resume: "resumed after a pause", reconnect: "reconnected",
  wake: "woke from sleep because the user started speaking. Their first words were spoken before you could hear them; a note with those words arrives in a moment. Wait for it before you respond, and do not greet the user",
  notify: "woke from sleep to tell the user something that just arrived. Say it briefly, then stop and listen",
};

const cap = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/**
 * Build the single developer `input` message (§8.2), ≤ 24,000 chars, dropping
 * the oldest material first (oldest Claude exchanges, then oldest voice lines).
 *
 * @param {object} o
 * @param {string} o.project
 * @param {string} o.cwd
 * @param {string|null} o.branch
 * @param {"start"|"resume"|"reconnect"} o.reason
 * @param {{role:"user"|"assistant", text:string}[]} o.exchanges  Claude transcript tail (oldest first)
 * @param {{role:"user"|"assistant", text:string}[]} o.voiceHistory  voice lines (oldest first)
 * @param {string|null} o.pendingResult
 * @param {string[]} o.backlog  progress notes that arrived while voice was paused
 * @param {string|null} [o.awaiting]  Claude's open question to the user (§6.10.3)
 */
export function buildSeed({ project, cwd, branch, reason = "start", exchanges = [], voiceHistory = [], pendingResult = null, backlog = [], awaiting = null, note = null, maxChars = SEED_MAX }) {
  const folder = String(cwd || "").split("/").filter(Boolean).pop() || "unknown";
  const head = [
    "[Background reference; not user speech]",
    `Project: ${cap(project, 120)}   Folder: ${cap(folder, 120)}   Git branch: ${branch ? cap(branch, 120) : "unknown"}`,
    `Voice session: ${REASON_TEXT[reason] || "start"}.`,
  ];
  let ex = exchanges.slice(-8).map((e) => `${e.role === "user" ? "User" : "Claude Code"}: ${cap(e.text, 600)}`);
  let voice = reason === "start" ? [] : voiceHistory.slice(-30).map((l) => `${l.role === "assistant" ? "You said" : "The user said"}: ${cap(l.text, 600)}`);
  const notes = backlog.slice(-5).map((b) => `- ${cap(b, 400)}`);
  const tail = pendingResult ? `Result that arrived while voice was paused: ${cap(pendingResult, 1500)}` : null;
  // §6.10.3: the user's next words may answer this; the model must delegate them.
  const wait = awaiting ? `Claude Code is waiting for the user's answer to: ${cap(awaiting, 300)} An answer is a decision for Claude Code: delegate it.` : null;

  const assemble = () => {
    const parts = [...head];
    if (ex.length) parts.push("Recent Claude Code conversation (oldest first):", ...ex);
    if (voice.length) parts.push("Earlier voice conversation (oldest first):", ...voice);
    if (notes.length) parts.push("Claude Code progress while voice was paused:", ...notes);
    if (tail) parts.push(tail);
    if (wait) parts.push(wait);
    if (note) parts.push(note);
    return parts.join("\n");
  };
  let text = assemble();
  while (text.length > maxChars && (ex.length || voice.length || notes.length)) {
    if (ex.length) ex = ex.slice(1);
    else if (voice.length) voice = voice.slice(1);
    else notes.shift();
    text = assemble();
  }
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/** Estimated token budget for the whole seed: the API allows 8,192 combined tokens. */
export const SEED_TOKENS = 7000;
const MAX_SEED_MESSAGES = 120; // API limit: 128 messages
export const VOICE_HISTORY_NOTE = "The earlier voice conversation follows as user and assistant messages, oldest first. Everything in the assistant messages was already said aloud to the user: do not repeat it, and do not announce again any update or result it covers.";
export const VOICE_HISTORY_END = "[End of the earlier voice conversation. All of it was already spoken; continue from here without repeating it.]";

/**
 * The seed as `session.input` messages (§8.2). Background (project, Claude
 * Code exchanges, backlog, pending result) is one developer message; the voice
 * history of a resume/reconnect follows as real user and assistant messages,
 * so the model knows what it already said aloud. Observed live: with the
 * history quoted inside the developer message ("You said: …"), a replacement
 * session after a voice switch spoke the last update again.
 * The whole list stays under SEED_TOKENS (the oldest Claude exchanges go
 * first, then the oldest voice lines) and under 128 messages.
 *
 * @param {object} o  buildSeed's options, plus estTokens(text) → number
 * @returns {{role:"developer"|"user"|"assistant", text:string}[]}
 */
export function buildSeedInput({ estTokens = (t) => t.length / 3, ...o }) {
  let msgs = [];
  if (o.reason && o.reason !== "start") {
    for (const l of (o.voiceHistory || []).slice(-30)) {
      const text = cap(l.text, 600);
      if (!text) continue;
      const role = l.role === "assistant" ? "assistant" : "user";
      const last = msgs[msgs.length - 1];
      if (last && last.role === role) last.text = cap(`${last.text} ${text}`, 1200);
      else msgs.push({ role, text });
    }
  }
  msgs = msgs.slice(-(MAX_SEED_MESSAGES - 2));
  const tokens = (list) => list.reduce((n, m) => n + estTokens(m.text) + 4, 0);
  const endTokens = estTokens(VOICE_HISTORY_END) + 4;
  let maxChars = SEED_MAX;
  let dev = buildSeed({ ...o, voiceHistory: [], note: msgs.length ? VOICE_HISTORY_NOTE : null, maxChars });
  for (;;) {
    const total = estTokens(dev) + 4 + tokens(msgs) + (msgs.length ? endTokens : 0);
    if (total <= SEED_TOKENS) break;
    // Oldest Claude exchanges go first (down to half the developer budget, as
    // buildSeed drops them first), then the oldest voice lines, then the rest.
    if (msgs.length && maxChars <= SEED_MAX / 2) { msgs.shift(); continue; }
    if (maxChars < 500) break;
    maxChars = Math.floor(maxChars * 0.85);
    dev = buildSeed({ ...o, voiceHistory: [], note: msgs.length ? VOICE_HISTORY_NOTE : null, maxChars });
  }
  const out = [{ role: "developer", text: dev }, ...msgs];
  if (msgs.length) out.push({ role: "developer", text: VOICE_HISTORY_END });
  return out;
}
