// Handoff guard (SPEC §6.20). Pure text rules, no I/O.
//
// Why (live log 2026-09-28, 0.4.7): after a voice wake the model said "Mm,
// yeah. Passing that to Claude now." and, the next time, "I'm asking Claude
// about the verdict now. I'll be right here with you.", but created no
// delegation either time. The first request never reached Claude; the second
// reached it only through the transcript mirror 19 s later, and the voice then
// fell asleep while Claude was still answering. The model had read the wake
// clip's words in an instructions append, not heard them, and does not
// delegate text it only read. These rules let the daemon notice a spoken
// handoff that was not made (and wake-clip words that are a request) and send
// the words itself.
import { normalizeWords } from "./transcript.js";
import { classifyLine } from "./mirror.js";

// A first-person, present or future handoff: the old Claude-named lines
// ("passing that to Claude", "let me check with Claude", "Claude's on it") and,
// since the voice speaks as Claude (0.6.8), first-person ones ("On it.", "Let
// me check.", "I'll look into that.", "Give me a sec, I'm digging in."). Past tense ("I asked Claude", "I've sent
// it") is left out on purpose: it is what the model says about a delegation
// it already made, and "Claude said / found / finished" or "I found" is a result.
const VERB = "(?:pass|hand|send|ask|check|forward|relay|flag|get|put|loop|run|kick|bring|tell|let|give|take|throw|shoot|ping|toss|bounce|punt)";
// Interjections a handoff line may start with: "Okay, on it.", "Sure, checking now."
const LEAD = "and|so|okay|ok|sure|yeah|yes|yep|right|mm|alright|ooh|oh";
// Doing the work yourself, said as you start it: "check", "look into", "dig in".
const DO = "(?:look(?=\\s*(?:[.?!,]|$))|check|have a look|take a look|look (?:into|at|it up)|dig (?:in|into)|find out|figure (?:it|that|this) out|pull (?:it|that|this|up)|run (?:it|that|this|the|those|them)|kick (?:it|that|this) off|investigate|get on (?:it|that|this)|get (?:started|that started)|sort (?:it|that|this) out|fix (?:it|that|this)|handle (?:it|that|this)|see what)\\b";
const DOING = "(?:checking|digging in|digging into|looking into|looking at (?:it|that|this|the)|taking a look|having a look|pulling (?:it|that|this) up|running (?:it|that|this|the|those|them)|kicking (?:it|that|this) off|investigating|on the (?:case|trail))\\b";
const HANDOFF = new RegExp([
  // "I'll pass that to Claude", "I'm going to ask Claude", "let me check with Claude"
  `\\b(?:i ?ll|i will|i ?m|i am|let me|lemme|going to|gonna|i can)\\s+(?:just\\s+|now\\s+|quickly\\s+|go\\s+(?:and\\s+)?|also\\s+)?(?:be\\s+)?${VERB}(?:ing)?\\b[^.?!]{0,60}?\\bclaude\\b`,
  // "Passing that to Claude now.", "Asking Claude about the verdict."
  `(?:^|[.?!,]\\s*|\\b(?:and|so|okay|ok|sure|yeah|yes|right|mm|alright)\\s+)(?:passing|handing|sending|forwarding|relaying|asking|checking with|looping in|flagging|pinging|kicking|tossing|throwing|shooting|bouncing|punting|running)\\b[^.?!]{0,50}?\\bclaude\\b`,
  // "Claude's on it", "Claude has it", "it's with Claude", "over to Claude"
  "\\bclaude(?: ?s| is| has)\\s+(?:on it|got it|getting it|looking|checking|taking a look)\\b",
  "\\b(?:it ?s|that ?s)\\s+with claude\\b",
  "\\bover to claude\\b",
  // Persona handoff lines that do not name Claude: "Handed off.", "Sending it over."
  "\\bhanded (?:it )?(?:off|over)\\b",
  "\\b(?:sending|passing|handing) (?:it|that|this) (?:over|along|on)\\b",
  "\\boff (?:it goes|i go)\\b",
  "\\bball ?s in my court\\b",
  "\\bheading (?:out|off) (?:into|to)\\b",
  // First person (0.6.8, SPEC §8.1 "One voice"): the voice IS Claude, so a
  // handoff no longer names Claude. "On it.", "I'm on it" ("still on it",
  // "working on it" are status, not a new handoff).
  `(?:^|[.?!,]\\s*|\\b(?:${LEAD}|i ?m|i am|boom|got it)\\s+)on it\\b`,
  // "Let me check", "I'll look into that", "let me dig in", "I'm going to run it"
  `\\b(?:let me|lemme|i ?ll|i will|i ?m going to|i am going to|i ?m gonna|gonna)\\s+(?:just\\s+|quickly\\s+|now\\s+|go\\s+(?:and\\s+)?)?${DO}`,
  // "I'm digging in", "I'm checking now", "I'm looking into it" (not "I'm looking forward")
  `\\bi ?m\\s+(?:just\\s+|now\\s+)?${DOING}`,
  // "Checking now.", "Digging in.", "Running it."
  `(?:^|[.?!,]\\s*|\\b(?:${LEAD})\\s+)${DOING}`,
  // "Give me a sec", "one moment", "just a sec"
  "\\b(?:give me|gimme|one|just a|back in a) (?:sec|second|moment|minute|tick)\\b",
].join("|"), "i");

// The voice says it is waiting for a reply from Claude with the user.
const WAITING = /\b(?:i ?ll be (?:right )?here|i ?ll stay (?:right )?here|i ?m (?:right )?here with you|stay with me|now we wait|we ?ll (?:know|see|hear) soon|i ?ll let you know (?:when|as soon as)|as soon as (?:it|claude) (?:gets back|answers|replies|is done|finishes)|as soon as i (?:know|have it|hear|m done|finish)|when claude (?:gets back|answers|replies|is done|finishes)|wait(?:ing)? for (?:claude|the answer|a reply|the result))\b/i;

const norm = (text) => String(text || "").toLowerCase().replace(/[’']/g, " ").replace(/\s+/g, " ").trim();

/** Does this assistant speech claim to hand something to Claude now? */
export function isHandoffClaim(text) {
  const t = norm(text);
  return !!t && HANDOFF.test(t);
}

/** Does this assistant speech say it is waiting (with the user) for Claude's reply? */
export function isWaitingClaim(text) {
  return WAITING.test(norm(text));
}

/**
 * Should the words that woke the voice (the wake clip) go to Claude as a
 * request? Questions and requests do; fillers, mic checks, requests about the
 * voice itself ("slow down") and noise do not.
 */
export function clipWantsDelegation(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const cls = classifyLine(t);
  if (cls === "decision" || cls === "other") return true;
  // Short ones too: "How's it looking?", "run the tests". A clip is only the
  // start of the turn; whatever the user adds is sent with it once they pause.
  return cls === "fragment" && normalizeWords(t).length >= 2;
}
