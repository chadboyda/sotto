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

// A first-person, present or future handoff to Claude: "passing that to
// Claude", "I'm asking Claude about it", "let me check with Claude", "I'll let
// Claude know", "Claude's on it". Past tense ("I asked Claude", "I've sent
// it") is left out on purpose: it is what the model says about a delegation
// it already made, and "Claude said / found / finished" is a result.
const VERB = "(?:pass|hand|send|ask|check|forward|relay|flag|get|put|loop|run|kick|bring|tell|let|give|take|throw|shoot|ping|toss|bounce|punt)";
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
  "\\boff it goes\\b",
].join("|"), "i");

// The voice says it is waiting for a reply from Claude with the user.
const WAITING = /\b(?:i ?ll be (?:right )?here|i ?ll stay (?:right )?here|i ?m (?:right )?here with you|stay with me|now we wait|we ?ll (?:know|see|hear) soon|i ?ll let you know (?:when|as soon as)|as soon as (?:it|claude) (?:gets back|answers|replies|is done|finishes)|when claude (?:gets back|answers|replies|is done|finishes)|wait(?:ing)? for (?:claude|the answer|a reply|the result))\b/i;

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
