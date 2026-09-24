// Claude transcript tail reader and git branch lookup (SPEC §8.2).
import fs from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { speakable } from "./speech.js";

const TAIL_BYTES = 256 * 1024;

/** Extract plain text from a transcript message content (string or parts). */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // Any tool_result/tool_use part marks a tool turn, not conversation text.
  if (content.some((p) => p && (p.type === "tool_result" || p.type === "tool_use"))) return "";
  return content.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
}

/**
 * Parse JSONL transcript text into [{role, text}] conversation entries, oldest
 * first. Defensive: bad lines are skipped.
 */
export function parseTranscript(jsonl) {
  const out = [];
  for (const line of String(jsonl).split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || (e.type !== "user" && e.type !== "assistant") || e.isMeta) continue;
    const msg = e.message;
    if (!msg) continue;
    let text = textOf(msg.content).trim();
    if (!text) continue;
    if (e.type === "user" && (text.startsWith("/") || text.startsWith("<command") || text.startsWith("<local-command"))) continue;
    if (e.type === "assistant") text = speakable(text);
    if (text) out.push({ role: e.type, text });
  }
  return out;
}

/**
 * Read at most the last 256 KB of the transcript and return up to the last
 * `maxEntries` user/assistant text entries (≈ 4 exchanges). Never throws.
 */
export function readTranscriptTail(file, { maxEntries = 8, maxBytes = TAIL_BYTES } = {}) {
  const text = readTail(file, maxBytes);
  return text === null ? [] : parseTranscript(text).slice(-maxEntries);
}

/** Last `maxBytes` of a file as whole lines, or null when unreadable. */
function readTail(file, maxBytes) {
  if (!file) return null;
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
    return text;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Which of `contents` (exact inbox message texts) Claude Code absorbed into a
 * running turn? A message absorbed between tool calls is recorded in the
 * transcript as a `queued_command` attachment and as a queue-operation
 * `remove` with reason `absorbed_mid_turn` (observed on CLI 2.1.281). A message
 * queued behind the turn is only `enqueue`d, then `dequeue`d as its own prompt.
 * Returns a Set of the absorbed contents, or null when the transcript cannot
 * be read. Never throws.
 */
export function readAbsorbed(file, contents, { maxBytes = 512 * 1024 } = {}) {
  const want = new Set((contents || []).filter((c) => typeof c === "string" && c));
  const text = readTail(file, maxBytes);
  if (text === null) return null;
  const found = new Set();
  if (!want.size) return found;
  for (const line of text.split("\n")) {
    if (!line.includes("queued_command") && !line.includes("absorbed_mid_turn")) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    let c = null;
    if (e && e.type === "queue-operation" && e.operation === "remove" && e.reason === "absorbed_mid_turn") c = e.content;
    else if (e && e.attachment && e.attachment.type === "queued_command") c = e.attachment.prompt;
    if (typeof c === "string" && want.has(c)) found.add(c);
  }
  return found;
}

/** Current git branch for cwd, or null (800 ms timeout). */
export function gitBranch(cwd, { execFile = execFileCb, timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    if (!cwd) return resolve(null);
    try {
      execFile("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: timeoutMs }, (err, stdout) => {
        const b = !err && String(stdout || "").trim();
        resolve(b || null);
      });
    } catch {
      resolve(null);
    }
  });
}
