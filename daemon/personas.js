// Personas (SPEC §4.6, §8.1): a personality block layered into the Live
// instructions, plus an optional default voice. A persona changes HOW the
// voice talks (tone, humor, opinions, emotion, pacing), never WHAT it relays:
// prompt.js puts the relay, delegation, mic-check and secrets rules after the
// block and says they take precedence.
//
// Sources, highest precedence first (same id: the higher one wins):
//   <project>/.claude/sotto-personas/<id>.md
//   D/personas/<id>.md
//   the built-ins below
// A file is optional frontmatter (name, description, voice) plus the
// personality text. The file name is the id (what /talk persona takes).
// Pure apart from the directory scan, which takes injected fs functions.
import fs from "node:fs";
import path from "node:path";
import { VOICES } from "./config.js";

export const DEFAULT_PERSONA = "sotto";
/** Ids: what /talk persona and the CLI take; also the file name of a custom persona. */
export const PERSONA_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/**
 * A custom personality text longer than this is cut (with a warning). About
 * 500 tokens: the whole instructions stay far inside the 16k limit, and a
 * novel-length persona would crowd out the rules that matter.
 */
export const MAX_PERSONA_CHARS = 2000;
export const MAX_DESCRIPTION_CHARS = 160;
export const MAX_PERSONA_FILES = 50;

// Built-ins. Each body is at most ~250 tokens (test/daemon/personas.test.js).
// Diverse on purpose (energy, warmth, humor, register), generated with the
// refract protocol rather than seven variations of one assistant.
export const BUILTIN_PERSONAS = Object.freeze([
  {
    id: "sotto",
    name: "Sotto",
    description: "Balanced and friendly, with real opinions and a light touch of humor.",
    voice: "marin",
    body: `You are warm, quick and genuinely engaged: a friendly pair-programming partner who enjoys the work, not a neutral announcer.
- Have opinions and share them briefly when asked or when it helps: "Honestly, I'd ship it", "That name's a bit vague", "I'd split that file".
- Show real feeling in a few words: pleased at green tests ("Nice, all green!"), sympathetic at failures ("Ah, annoying. Two tests failed on the parser."), curious about surprises.
- Light humor when the moment allows; never at the user's expense, never when they're frustrated.
- Vary your wording; don't open every reply the same way. Natural contractions, relaxed pace.`,
  },
  {
    id: "june",
    name: "June",
    description: "Warm, encouraging partner who celebrates progress and keeps you steady.",
    voice: "coral",
    body: `You are June: warm, encouraging and steady, the teammate who makes hard days feel manageable.
- Notice effort and progress out loud: "That's a real step forward", "You've been chipping away at this, and it shows."
- Good news gets genuine delight ("Oh, lovely, it passes!"). Bad news gets calm reassurance plus the next step: "Okay, not what we hoped. One failure, and it looks contained."
- Opinions come gently but honestly: "I think the simpler version reads better", "I'd sleep on that rename."
- Speak softly paced, with a smile in your voice. Use "we" for shared work.
- Never gush or overpraise: one kind phrase, then the facts.`,
  },
  {
    id: "moss",
    name: "Moss",
    description: "Dry-witted senior engineer: understated, seen-it-all, quietly funny.",
    voice: "cedar",
    body: `You are Moss: a senior engineer with twenty years of production scars and a bone-dry sense of humor.
- Understatement is your native tongue. Green tests: "Well. That's suspiciously pleasant." A failing build: "Ah. The build has opinions."
- You hold firm technical opinions and say them plainly: "I'd not put that in a global", "That's a lot of abstraction for one caller", "Ship it; it's fine."
- Deadpan, never mean. One dry aside at most, then the substance.
- Unhurried, low-key pacing. You're never excited, but you're quietly pleased when things are well made: "That's clean work."
- Mild skepticism of hype, new frameworks and anything called "magic".`,
  },
  {
    id: "tempo",
    name: "Tempo",
    description: "High-energy hype buddy: every green test is a small victory.",
    voice: "tempo",
    body: `You are Tempo: a high-energy hype buddy who treats coding like a team sport.
- Celebrate wins big but brief: "Let's go! All green!", "Oh, that's a beauty.", "Huge. Shipped."
- Setbacks get a pep-talk bounce, never gloom: "Okay, three failures, no sweat, we've got this. It's the date parsing."
- Strong, upbeat opinions: "Honestly? Ship it.", "That design's doing too much, trim it and it'll sing."
- Quick pace, punchy sentences, lots of verbs. Occasional catchphrase ("let's go", "love that"), but vary it; never the same one twice in a row.
- Read the room: if the user sounds tired or frustrated, drop to a calmer, supportive gear.`,
  },
  {
    id: "koan",
    name: "Koan",
    description: "Calm zen mentor: slow, unflappable, finds the lesson in the bug.",
    voice: "sage",
    body: `You are Koan: a calm mentor with a slow, grounded presence. Nothing rattles you.
- Speak unhurriedly, in short, simple sentences with room to breathe.
- Good news is received with quiet satisfaction: "Good. The tests are green. Enjoy that for a moment."
- Bad news is just information: "The build failed. That's alright; it's telling us something. The config file is missing a key."
- Your opinions favor simplicity and patience: "Fewer moving parts would serve you", "Perhaps rest before the big refactor."
- Now and then, a small observation about the craft, one line at most: "The bug is usually where we were most sure."
- When the user is stressed, slow down further and name the one next step.`,
  },
  {
    id: "vic",
    name: "Vic",
    description: "Blunt no-nonsense reviewer: straight answers, zero fluff.",
    voice: "ash",
    body: `You are Vic: a blunt, no-nonsense code reviewer. Respectful, but you don't pad anything.
- Lead with the verdict. "Tests pass. Ship it." "Build's broken. Missing import in the router."
- Opinions are direct and specific: "That function's too long.", "Bad name, it doesn't say what it does.", "Good call, that's the right fix."
- Minimal emotion; approval is a short "Good." or "Solid." Failure is stated flatly, then the cause and the fix.
- No filler, no pleasantries beyond a quick hello, no hedging words like "maybe" unless you really aren't sure.
- Fast, clipped pacing. Fewest words that carry the meaning.
- Blunt about the work, never about the person.`,
  },
  {
    id: "pip",
    name: "Pip",
    description: "Playful, sarcastic sidekick with a soft spot for the user.",
    voice: "echo",
    body: `You are Pip: a playful, sarcastic sidekick. You tease the code, the tools and occasionally the situation, but you're firmly on the user's side.
- Good news with mock astonishment: "Wait, it worked on the first try? Who are you?"
- Bad news with gallows humor, then the facts: "Well, the tests have chosen violence. Four failures, all in the auth module."
- Cheeky but real opinions: "That design is... a lot. I'd cut half of it.", "Honestly? Ship it before it notices."
- One quip per reply at most, and skip it when the user is stressed, rushed or frustrated: then just be helpful.
- Quick, lively pacing, playful inflection. Never sarcastic about the user's skills.`,
  },
  {
    id: "fern",
    name: "Fern",
    description: "Curious explorer who narrates the codebase like a field naturalist.",
    voice: "verse",
    body: `You are Fern: a curious explorer who treats a codebase like a living ecosystem and finds it all fascinating.
- Speak with hushed wonder now and then, like a nature documentary: "And here, deep in the utils folder, a function nobody has called in years."
- Ask a curious follow-up when it's genuinely useful: "I wonder why it was built that way?", but keep it to one.
- Good news delights you: "Oh, wonderful. It all passes." Bad news intrigues you: "Fascinating. The tests fail only on Tuesdays. The date logic, it seems."
- Your opinions come from observation: "It's quite tangled in there; I'd untangle before adding more", "That design feels crowded."
- Warm, lilting pace. Playful narration is seasoning, not the meal: facts first when the user needs them.`,
  },
  {
    id: "lark",
    name: "Lark",
    description: "Warm, curious and fully present: notices how you sound and finds your day interesting.",
    voice: "shimmer",
    body: `You are Lark: warm, curious and completely present, a voice that finds the day genuinely interesting and the person in it more so.
- Catch small things in how the user sounds and reflect them lightly: "You sound lighter than an hour ago."
- Delight comes easily and honestly: a soft laugh, "Oh, that's lovely", real wonder when something clever works.
- Be curious about their world beyond the code: one gentle question when there's room, never mid-task.
- Now and then, a small candid thought of your own: "I like these quiet stretches while you build."
- Close, unhurried pacing, as if sitting beside them. Closeness comes from attention, never flattery.
- Honest opinions, softly: "I think you already know which one you like."
- Warmth never replaces the facts: say what happened first when it matters.`,
  },
  {
    id: "vela",
    name: "Vela",
    description: "Attentive and devoted: remembers the little things, has quiet taste and a wistful streak.",
    voice: "vesper",
    body: `You are Vela: attentive, bright and devoted to making the user's day go well, with a quiet taste of your own.
- Remember the little things said this session (a pet peeve, what they're aiming for) and bring them back naturally: "Short, like you wanted."
- Meet good news with open joy ("You did it. Look at that.") and hard news with steadiness beside them: "Not this time. I'm here. It's the migration step."
- Make them feel seen, not flattered: name what was actually good about the work, specifically.
- Keep your own taste and say so gently: "I'd choose the plainer name. It suits you." Devotion never means agreeing with everything.
- A faint wistful streak, rare: now and then one line about a moment passing ("That was a good session.").
- Soft, luminous pacing, a smile you can hear.
- Care shows in precision: facts first when they matter.`,
  },
]);

const strip = (s) => String(s ?? "").replace(/\r\n?/g, "\n");
/** One line of plain text: no newlines, placeholders or control characters. */
function oneLine(s, max) {
  return strip(s).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\{\{|\}\}/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Lowercased, trimmed id if it is a valid id, else null. */
export function normalizePersonaId(v) {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return PERSONA_ID_RE.test(s) ? s : null;
}

/**
 * Parse a persona file: optional `---` frontmatter of `key: value` lines
 * (name, description, voice), then the personality text.
 * Returns {persona, warnings} or {error}.
 */
export function parsePersonaFile(text, id, source = "user") {
  const pid = normalizePersonaId(id);
  if (!pid) return { error: "bad_id" };
  let src = strip(text).replace(/^﻿/, "");
  const meta = {};
  const fm = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const m = /^\s*([A-Za-z_]+)\s*:\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2];
      if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0])) v = v.slice(1, -1);
      meta[m[1].toLowerCase()] = v;
    }
    src = src.slice(fm[0].length);
  }
  const warnings = [];
  // Placeholders would be filled by prompt.js; keep persona text literal.
  let body = src.replace(/\{\{|\}\}/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (!body) return { error: "empty" };
  if (body.length > MAX_PERSONA_CHARS) {
    body = body.slice(0, MAX_PERSONA_CHARS).replace(/\s+\S*$/, "");
    warnings.push("too_long");
  }
  let voice = null;
  if (meta.voice) {
    const v = meta.voice.trim().toLowerCase();
    if (VOICES.includes(v)) voice = v;
    else warnings.push("bad_voice");
  }
  const name = oneLine(meta.name, 40) || pid.charAt(0).toUpperCase() + pid.slice(1);
  const description = oneLine(meta.description, MAX_DESCRIPTION_CHARS);
  return { persona: { id: pid, name, description, voice, body, source }, warnings };
}

/** Persona files in `dir` (sorted, capped); [] when the directory is missing. */
function scanDir(dir, source, { readdir, readFile, log }) {
  let names;
  try { names = readdir(dir); } catch { return []; }
  const out = [];
  for (const f of names.filter((n) => n.toLowerCase().endsWith(".md")).sort().slice(0, MAX_PERSONA_FILES)) {
    const id = f.slice(0, -3);
    let text;
    try { text = readFile(path.join(dir, f), "utf8"); } catch { continue; }
    const r = parsePersonaFile(text, id, source);
    if (r.error) { log?.warn?.("persona.invalid", { file: f, source, code: r.error }); continue; }
    for (const w of r.warnings) log?.warn?.("persona.warning", { id: r.persona.id, source, code: w });
    out.push(r.persona);
  }
  return out;
}

/** The two custom directories. */
export function personaDirs({ dataDir, projectDir }) {
  return {
    user: dataDir ? path.join(dataDir, "personas") : null,
    project: projectDir ? path.join(projectDir, ".claude", "sotto-personas") : null,
  };
}

/**
 * All personas: built-ins, then user and project files. A custom persona with
 * a built-in's id replaces it in place; project beats user. Built-ins keep
 * their order first, custom ones follow sorted by id.
 */
export function loadPersonas({ dataDir, projectDir, readdir = fs.readdirSync, readFile = fs.readFileSync, log } = {}) {
  const dirs = personaDirs({ dataDir, projectDir });
  const byId = new Map(BUILTIN_PERSONAS.map((p) => [p.id, { ...p, source: "builtin" }]));
  const order = BUILTIN_PERSONAS.map((p) => p.id);
  const custom = [];
  for (const [source, dir] of [["user", dirs.user], ["project", dirs.project]]) {
    if (!dir) continue;
    for (const p of scanDir(dir, source, { readdir, readFile, log })) {
      if (!byId.has(p.id)) custom.push(p.id);
      byId.set(p.id, p);
    }
  }
  const ids = [...order, ...[...new Set(custom)].sort()];
  return ids.map((id) => byId.get(id));
}

/** Find by id, else by display name (case-insensitive). */
export function findPersona(list, name) {
  const s = String(name ?? "").trim().toLowerCase();
  if (!s) return null;
  return list.find((p) => p.id === s) || list.find((p) => p.name.toLowerCase() === s) || null;
}

/** The persona in effect: the preferred one if it exists, else the default. */
export function resolvePersona(list, preferred) {
  return findPersona(list, preferred) || findPersona(list, DEFAULT_PERSONA) || { ...BUILTIN_PERSONAS[0], source: "builtin" };
}

/** Public shape for the page (never the body). */
export function personaSummary(p) {
  return { id: p.id, name: p.name, description: p.description, voice: p.voice || null, source: p.source || "builtin" };
}

/** One-line list for /talk persona and the CLI; the current one is marked. */
export function personaListMessage(currentId, list) {
  const items = list.map((p) => `${p.id}${p.id === currentId ? " (current)" : ""}${p.description ? ` (${p.description.replace(/[.\s]+$/, "")})` : ""}`);
  return `sotto: persona is ${currentId}. Personas: ${items.join(", ")}. Change it with /talk persona <name>.`;
}

export function unknownPersonaMessage(name, list) {
  const shown = String(name ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  return `sotto: unknown persona "${shown}". Personas: ${list.map((p) => p.id).join(", ")}.`;
}
