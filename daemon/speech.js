// Speakable text, summaries and chunking (SPEC §6.10 speech.js). Pure.
// Turns Claude's markdown into something a voice model can say: no code,
// no tables, no raw paths/URLs/ids. No LLM call is involved.
import { MAX_APPEND_CHARS, MAX_APPEND_TOKENS } from "./config.js";

const CODE_OMITTED = " (code omitted) ";
const TABLE_OMITTED = " (table omitted) ";
const KNOWN_EXT = "js|mjs|cjs|ts|tsx|jsx|json|jsonl|md|mdx|sh|bash|zsh|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|m|mm|css|scss|html|htm|yml|yaml|toml|ini|cfg|conf|lock|txt|log|sql|xml|svg|png|jpg|jpeg|gif|pdf|csv|env|plist|vue|svelte|php|lua|pl|r|ex|exs|dart|gradle|wav|mp3|mp4";
const EXT_RE = new RegExp(`^[\\w.@+-]+\\.(?:${KNOWN_EXT})$`, "i");

/** Last path segment of a path-like token, keeping trailing punctuation. */
function basenameOf(tok) {
  const m = /^(.*?)([.,;:!?)\]]*)$/.exec(tok);
  const core = m[1].replace(/\/+$/, "");
  const base = core.split("/").pop() || core;
  return base + m[2];
}

/** True when a whitespace-free token looks like a filesystem path. */
function isPathLike(tok) {
  const t = tok.replace(/[.,;:!?)\]]+$/, "").replace(/^[(\[]+/, "");
  if (!t) return false;
  if (t.includes("/")) {
    const segs = t.split("/").filter(Boolean);
    if (segs.length < 2 && !/^[~.]?\//.test(t)) return false;
    // Avoid "and/or" style words: need an absolute/home/relative prefix,
    // a dotted segment, or at least three segments.
    return /^(~|\.{1,2})?\//.test(t) || segs.some((s) => s.includes(".")) || segs.length >= 3;
  }
  return false;
}

function inlineCode(content) {
  const c = content.trim();
  if (!c) return "";
  if (c.length <= 30 && !c.includes("/")) return c;
  if (!/\s/.test(c) && (isPathLike(c) || c.includes("/"))) return basenameOf(c);
  return "some code";
}

const LIST_ITEM_RE = /^(?:[-*+•]|\d{1,3}[.)])\s/;

/** Replace fenced code blocks and markdown tables; returns lines-preserving text. */
function stripBlocks(md) {
  let s = String(md ?? "").replace(/\r\n?/g, "\n");
  // Fenced code (``` or ~~~), including an unterminated trailing fence.
  s = s.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, CODE_OMITTED.trim());
  // Indented code: 2+ lines indented 4+ spaces (or a tab) after a blank line or
  // at the start. Runs that look like nested list items are left alone.
  s = s.replace(/(^|\n[ \t]*\n)((?:(?: {4,}|\t)[^\n]*\S[^\n]*(?:\n|$)){2,})/g, (all, lead, block) => {
    const lines = block.split("\n").filter((l) => l.trim());
    if (lines.some((l) => LIST_ITEM_RE.test(l.trim()))) return all;
    return `${lead}${CODE_OMITTED.trim()}\n`;
  });
  // Tables: 2+ consecutive lines that start and end with a pipe.
  s = s.replace(/(?:^[ \t]*\|.*\|[ \t]*(?:\n|$)){2,}/gm, TABLE_OMITTED.trim() + "\n");
  return s;
}

// Secret-looking names for NAME=value redaction.
const SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASS|PASSWD|PASSWORD|PWD|AUTH|CREDENTIAL|CREDS|PRIVATE|SESSION|COOKIE|SIGNATURE|DSN|DATABASE_URL|CONN)/i;
// Well-known credential shapes, redacted whatever their length.
const TOKEN_PATTERNS = [
  /\b(?:sk|pk|rk)-(?=[\w-]*\d)[\w-]{4,}/g, // OpenAI / Anthropic style (sk-..., sk-proj-..., sk-ant-...)
  /\b(?:sk|pk|rk)_(?:live|test)_[\w]{6,}/g, // Stripe
  /\bgh[pousr]_[A-Za-z0-9]{10,}/g, /\bgithub_pat_\w{10,}/g, // GitHub
  /\bglpat-[\w-]{10,}/g, // GitLab
  /\bxox[abposr]-[\w-]{8,}/g, // Slack
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bAIza[\w-]{20,}/g, // Google API keys
  /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g, // JWTs
];

/**
 * Remove credentials before anything else runs (ARCHITECTURE §5: everything
 * appended may be spoken). Covers URL userinfo, NAME=value secrets, labelled
 * passwords/tokens, bearer tokens and well-known token prefixes.
 */
export function redactSecrets(text) {
  let s = String(text ?? "");
  // scheme://user:pass@host → scheme://host (any scheme: https, postgres, redis…).
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>]+@/gi, "$1");
  // Authorization headers.
  s = s.replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+\/=-]{8,}/g, "$1 (a secret)");
  // NAME=value where NAME looks secret-bearing (export FOO_API_KEY=...).
  s = s.replace(/\b([A-Za-z_][A-Za-z0-9_]{2,})=("[^"\n]*"|'[^'\n]*'|[^\s`]+)/g, (all, name) => (SECRET_NAME.test(name) ? `${name} is set` : all));
  // "password: hunter2", "api key = abc123", "token is xyz".
  s = s.replace(/\b(password|passwd|passphrase|api[ _-]?key|secret|access[ _-]?token|auth[ _-]?token)(\s*(?:[:=]|\bis\b)\s*)[`"']?([^\s`"']{4,})[`"']?/gi, (all, label, sep, val) => (/\d|[A-Z].*[a-z]|[^\w]/.test(val) ? `${label}${sep}(redacted)` : all));
  for (const re of TOKEN_PATTERNS) s = s.replace(re, "a secret token");
  return s;
}

/** Inline-level cleanup of one line/paragraph of text (steps 4–10). */
function cleanInline(text) {
  let s = redactSecrets(text);
  // Inline code first so its content is not mangled by later rules.
  s = s.replace(/`([^`\n]+)`/g, (_, c) => inlineCode(c));
  // Images and links.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => (alt ? alt : "an image"));
  s = s.replace(/\[([^\]]+)\]\((?:[^()\s]|\([^)]*\))*\)/g, "$1");
  // Bare URLs → "a link to <host>".
  s = s.replace(/\b(?:https?|wss?|ftp):\/\/([^\s/?#<>)"']+)[^\s<>)"']*/gi, (_, host) => `a link to ${host.replace(/^www\./i, "").replace(/:\d+$/, "")}`);
  s = s.replace(/<(a link to [^>]+)>/g, "$1");
  // Bold / italic / strikethrough markers.
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2");
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1$2");
  s = s.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2");
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1");
  // Path-like tokens → basename.
  s = s.replace(/[^\s]+/g, (tok) => (isPathLike(tok) ? basenameOf(tok) : tok));
  // UUIDs and long hex ids → "an id" (must contain a digit, so plain words survive).
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "an id");
  s = s.replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{12,}\b/gi, "an id");
  // Very long tokens → "a long token".
  s = s.replace(/[A-Za-z0-9_-]{24,}/g, (t) => (t.includes("_") || t.includes("-") || /\d/.test(t) || /[a-z][A-Z]/.test(t) ? "a long token" : t));
  return s;
}

function endSentence(s) {
  const t = s.trim();
  if (!t) return "";
  return /[.!?:;…]$/.test(t) ? t : t + ".";
}

/**
 * Convert markdown into paragraphs of plain speakable text.
 * Returns an array of paragraphs (already whitespace-collapsed).
 */
export function speakableParagraphs(md) {
  const blocks = stripBlocks(md).split(/\n[ \t]*\n+/);
  const out = [];
  for (const block of blocks) {
    const sentences = [];
    let cur = [];
    const flush = () => { if (cur.length) { sentences.push(cur.join(" ")); cur = []; } };
    for (let line of block.split("\n")) {
      line = line.trim();
      if (!line) continue;
      if (/^([-*_])(\s*\1){2,}$/.test(line)) { flush(); continue; } // horizontal rule
      line = line.replace(/^>+\s?/, "");
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      const bullet = /^(?:[-*+•]|\d{1,3}[.)])\s+(.*)$/.exec(line);
      if (heading || bullet) {
        flush();
        sentences.push(endSentence(cleanInline((heading || bullet)[1].replace(/\s#+$/, ""))));
        continue;
      }
      cur.push(cleanInline(line));
    }
    flush();
    let para = sentences.map((x) => endSentence(x)).join(" ");
    para = para.replace(/\s+/g, " ").replace(/(\(code omitted\)[\s.]*){2,}/g, "(code omitted). ").trim();
    if (para) out.push(para);
  }
  // Collapse runs of "(code omitted)" that ended up in separate paragraphs.
  const merged = [];
  for (const p of out) {
    const prevOmit = merged.length && /^\(code omitted\)\.?$/.test(merged[merged.length - 1]);
    if (prevOmit && /^\(code omitted\)\.?$/.test(p)) continue;
    merged.push(p);
  }
  return merged;
}

/** Full speakable text (SPEC §6.10 steps 1–11). */
export function speakable(md) {
  return speakableParagraphs(md).join(" ").replace(/\s+/g, " ").trim();
}

/** Split text into sentences, keeping terminal punctuation. */
export function sentences(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  return t.split(/(?<=[.!?…])\s+(?=\S)/);
}

/** Cut `text` to ≤ max chars at a word boundary. */
export function cutWords(text, max) {
  const t = String(text ?? "").trim();
  if (t.length <= max) return t;
  const slice = t.slice(0, max);
  const sp = slice.lastIndexOf(" ");
  return (sp > max * 0.5 ? slice.slice(0, sp) : slice).trim();
}

/** Plain truncation with an ellipsis, for quoting user text etc. */
export function clip(text, max) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return cutWords(t, max - 1) + "…";
}

/**
 * The leading spoken summary: speakable text of the first paragraph(s), up to
 * maxChars, cut at a sentence end (word boundary if a single sentence is too long).
 */
export function summary(md, maxChars = 900) {
  const out = [];
  let len = 0;
  for (const para of speakableParagraphs(md)) {
    for (const s of sentences(para)) {
      const add = (out.length ? 1 : 0) + s.length;
      if (len + add > maxChars) {
        if (!out.length) return cutWords(s, maxChars);
        return out.join(" ");
      }
      out.push(s);
      len += add;
    }
  }
  return out.join(" ");
}

/** First n sentences of already-speakable text. */
export function firstSentences(text, n = 2) {
  return sentences(text).slice(0, n).join(" ");
}

/**
 * Split text into chunks ≤ max chars at sentence ends; a sentence longer than
 * max is hard-split at word boundaries (or mid-word as a last resort).
 */
export function chunks(text, max = MAX_APPEND_CHARS) {
  const out = [];
  let cur = "";
  const push = (piece) => {
    if (!cur) cur = piece;
    else if (cur.length + 1 + piece.length <= max) cur += " " + piece;
    else { out.push(cur); cur = piece; }
  };
  for (const s of sentences(text)) {
    if (s.length <= max) { push(s); continue; }
    let rest = s;
    while (rest.length > max) {
      let cut = rest.lastIndexOf(" ", max);
      if (cut <= 0) cut = max;
      push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) push(rest);
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Conservative token estimate for the Live API's 500-token append limit.
 * ASCII runs about 4 chars/token in prose but closer to 3 in identifier-dense
 * text, so count 1 token per 3 ASCII chars. Non-ASCII (CJK, accented Latin,
 * Cyrillic…) is often ~1 token per code point, astral chars (emoji) more.
 */
export function estTokens(text) {
  let ascii = 0;
  let other = 0;
  for (const ch of String(text ?? "")) {
    const c = ch.codePointAt(0);
    if (c < 0x80) ascii++;
    else if (c > 0xffff) other += 2.5;
    else other += 1.2;
  }
  return Math.ceil(ascii / 3 + other);
}

/** Clip `text` (word boundary + "…") until it fits `maxTokens`. */
export function fitTokens(text, maxTokens = MAX_APPEND_TOKENS) {
  let t = String(text ?? "");
  let est = estTokens(t);
  while (est > maxTokens && t.length > 1) {
    const max = Math.max(1, Math.floor(t.length * (maxTokens / est) * 0.95));
    t = clip(t, max);
    est = estTokens(t);
  }
  return t;
}

/**
 * chunks() that also respects the token budget: every chunk is ≤ maxChars and
 * ≤ maxTokens (estimated). Chunks over the token budget are split further.
 */
export function tokenChunks(text, maxTokens = MAX_APPEND_TOKENS, maxChars = MAX_APPEND_CHARS) {
  const out = [];
  const visit = (c, max) => {
    const est = estTokens(c);
    if (est <= maxTokens) { out.push(c); return; }
    const next = Math.max(1, Math.min(max - 1, Math.floor(c.length * (maxTokens / est) * 0.95)));
    for (const sub of chunks(c, next)) visit(sub, next);
  };
  for (const c of chunks(text, maxChars)) visit(c, maxChars);
  return out;
}

// Trailing option lists: "- A", "1. A", "2) A", "(a) A", "a) A".
const OPTION_LINE = /^(?:[-*•+]|\d{1,2}[.)]|\(?[a-hA-H][.)])\s+(\S.*)$/;
const ASKING = /\b(?:which|what|how|should|shall|prefer|pick|choose|want|option|options|like|decide|either|or|ok|okay)\b/i;

/**
 * Is Claude's final message waiting for the user (SPEC §6.10.3)? Returns a
 * short speakable form of the question, or null. Two shapes count:
 *  - the message ends with a question ("Want me to merge it?");
 *  - it ends with a list of 2 to 8 options introduced by a line that ends in
 *    "?" or ":" and reads like a choice ("Which should I use:").
 * Code blocks are ignored; nothing here is spoken as is (the caller sends it
 * as silent context).
 */
export function awaitingQuestion(md) {
  if (typeof md !== "string") return null;
  const text = md.replace(/```[\s\S]*?(?:```|$)/g, "\n").replace(/\*\*|__/g, "");
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  let i = lines.length;
  while (i > 0 && OPTION_LINE.test(lines[i - 1])) i--;
  const n = lines.length - i;
  if (n >= 2 && n <= 8 && i > 0) {
    const lead = lines[i - 1].replace(/^#+\s*/, "");
    if (/[?:]\s*$/.test(lead) && ASKING.test(lead)) {
      const opts = lines.slice(i).map((l) => clip(speakable(OPTION_LINE.exec(l)[1]).replace(/[.;:,]+$/, ""), 60)).filter(Boolean);
      const q = speakable(lead.replace(/:\s*$/, "?")).replace(/[.]+$/, "?");
      return clip(`${q} Options: ${opts.join("; ")}.`, 300);
    }
  }
  const last = lines[lines.length - 1].replace(/[*_`)\]"'”’\s]+$/, "");
  if (!/\?$/.test(last) || /^\|/.test(last)) return null;
  const ss = sentences(speakable(last));
  const q = ss.length ? ss[ss.length - 1] : "";
  return q.trim() ? clip(q.trim(), 300) : null;
}
