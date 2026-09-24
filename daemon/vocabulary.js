// Vocabulary awareness: a glossary of names the user is likely to say (skills,
// plugins, commands, the project, its folders, and a user-editable glossary),
// rendered into the Live instructions, plus a cheap fuzzy matcher that notes
// likely mishearings on the delegated prompt (SPEC-DEVIATIONS "Vocabulary").
//
// Why this exists: speech recognition splits or swaps unusual names
// ("impeccable" -> "in peccable", "TinyFish" -> "tiny fish"). gpt-live-1 has no
// keyword-biasing session field (probed 2026-09-23: `keywords`, `vocabulary`,
// `prompt`, `context`, `transcription` and `audio.input` are all rejected as
// unknown_parameter), so the glossary goes into the instructions, which are
// the only startup context the model has besides `input`.
//
// Everything here is read-only and best-effort: unreadable files are skipped,
// and collection stops at a deadline so a huge plugin cache cannot delay the
// session start.
import fs from "node:fs/promises";
import path from "node:path";
import { estTokens } from "./speech.js";

export const VOCAB_FILE = "vocabulary.txt";
export const PROJECT_VOCAB_FILE = path.join(".claude", "sotto-vocabulary.txt");
/** Token budget for the glossary section of the instructions (limit: 16,384 for all instructions). */
export const VOCAB_TOKENS = 1500;
const DEADLINE_MS = 200;
const HEAD_BYTES = 4096;
const MAX_TERM = 60;
const MAX_HINT = 100;
const MAX_FOLDERS = 30;
const SKIP_FOLDERS = new Set(["node_modules", "dist", "build", "out", "coverage", "vendor", "target", "tmp", "temp", "__pycache__", "venv"]);
const TRIVIAL_BRANCHES = new Set(["main", "master", "head", "develop", "trunk"]);

// Tiers: lower wins on dedupe and comes first in the prompt.
export const TIER = Object.freeze({ glossary: 0, projectGlossary: 1, project: 2, folder: 3, skill: 4, plugin: 5, pluginSkill: 6, command: 7 });

/** "TinyFish", "claude-live" -> "tinyfish", "claudelive". */
export const keyOf = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
/** "claude-live" -> "claude live" (camelCase is NOT split: "TinyFish" said as "tiny fish" is a mishearing worth noting). */
const spacedOf = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const clean = (s, n) => String(s || "").replace(/[\u0000-\u001f"\\]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * Parse a glossary file: one term per line, optional "term: hint". Blank lines
 * and lines starting with # are ignored. The separator is a colon followed by
 * whitespace, so "plugin:skill" stays one term.
 */
export function parseGlossary(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(.+?):\s+(.*)$/);
    const term = clean(m ? m[1] : line, MAX_TERM);
    const hint = m ? clean(m[2], MAX_HINT) : "";
    if (keyOf(term)) out.push({ term, hint });
  }
  return out;
}

/** Minimal YAML front matter reader: top-level `key: value` scalars only. */
export function parseFrontmatter(text) {
  const t = String(text || "");
  if (!t.startsWith("---")) return {};
  const end = t.indexOf("\n---", 3);
  const body = end === -1 ? t.slice(3) : t.slice(3, end);
  const out = {};
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^["'].*["']$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

async function readHead(file, bytes = HEAD_BYTES) {
  let fh;
  try {
    fh = await fs.open(file, "r");
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

async function readText(file, max = 64 * 1024) {
  const t = await readHead(file, max);
  return t;
}

async function readJson(file) {
  const t = await readText(file, 4 * 1024 * 1024);
  if (t === null) return null;
  try { return JSON.parse(t); } catch { return null; }
}

async function listDir(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

const isDirLike = (e) => e.isDirectory() || e.isSymbolicLink();

/**
 * Skills in a skills directory: each `<dir>/<name>/SKILL.md`. Skills whose
 * front matter says `user-invocable: false` are left out. A subdirectory that
 * is a plugin instead (has `.claude-plugin/plugin.json`, as with a symlinked
 * skills-dir plugin) is reported in `plugins`.
 */
async function scanSkillsDir(dir) {
  const skills = [];
  const plugins = [];
  const entries = (await listDir(dir)).filter((e) => isDirLike(e) && !e.name.startsWith("."));
  await Promise.all(entries.map(async (e) => {
    const sub = path.join(dir, e.name);
    const head = await readHead(path.join(sub, "SKILL.md"));
    if (head !== null) {
      const fm = parseFrontmatter(head);
      if (String(fm["user-invocable"]).toLowerCase() === "false") return;
      skills.push(clean(fm.name || e.name, MAX_TERM));
      return;
    }
    const manifest = await readJson(path.join(sub, ".claude-plugin", "plugin.json"));
    if (manifest) plugins.push({ name: clean(manifest.name || e.name, MAX_TERM), root: sub, manifest });
  }));
  skills.sort();
  plugins.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, plugins };
}

/** Skills and commands of one plugin at `root` (default dirs plus manifest `skills` / `commands` paths). */
async function scanPlugin(root, manifest) {
  const asList = (v) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).filter((p) => typeof p === "string");
  const inside = (p) => {
    const abs = path.resolve(root, p);
    return abs === root || abs.startsWith(root + path.sep) ? abs : null;
  };
  const skillDirs = new Set([path.join(root, "skills"), ...asList(manifest?.skills).map(inside).filter(Boolean)]);
  const cmdDirs = new Set([path.join(root, "commands"), ...asList(manifest?.commands).map(inside).filter(Boolean)]);
  const skills = new Set();
  const commands = new Set();
  await Promise.all([
    ...[...skillDirs].map(async (d) => { for (const s of (await scanSkillsDir(d)).skills) skills.add(s); }),
    ...[...cmdDirs].map(async (d) => {
      for (const e of await listDir(d)) if (e.isFile() && e.name.endsWith(".md")) commands.add(clean(e.name.slice(0, -3), MAX_TERM));
    }),
  ]);
  return { skills: [...skills].sort(), commands: [...commands].sort() };
}

/**
 * Enabled plugins from installed_plugins.json, filtered by `enabledPlugins`
 * in the user settings and the project's settings (project wins). A plugin
 * installed for another project (scope project/local) is left out.
 */
async function enabledPlugins(home, cwd) {
  const installed = await readJson(path.join(home, ".claude", "plugins", "installed_plugins.json"));
  const map = installed && typeof installed === "object" ? (installed.plugins && typeof installed.plugins === "object" ? installed.plugins : installed) : {};
  const enabled = {};
  const settingsFiles = [path.join(home, ".claude", "settings.json")];
  if (cwd) settingsFiles.push(path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json"));
  for (const s of await Promise.all(settingsFiles.map(readJson))) {
    if (s && s.enabledPlugins && typeof s.enabledPlugins === "object") Object.assign(enabled, s.enabledPlugins);
  }
  const anyListed = Object.keys(enabled).length > 0;
  const out = [];
  for (const [id, installs] of Object.entries(map)) {
    if (anyListed ? enabled[id] !== true : enabled[id] === false) continue;
    const list = Array.isArray(installs) ? installs : [installs];
    const inst = list.find((i) => i && typeof i.installPath === "string" && (!i.projectPath || (cwd && (cwd === i.projectPath || cwd.startsWith(i.projectPath + path.sep)))));
    if (!inst) continue;
    out.push({ name: clean(id.split("@")[0], MAX_TERM), root: inst.installPath });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function topFolders(cwd) {
  const entries = await listDir(cwd);
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_FOLDERS.has(e.name.toLowerCase()))
    .map((e) => clean(e.name, MAX_TERM))
    .sort()
    .slice(0, MAX_FOLDERS);
}

/** Add a term, deduping on its key; a later (lower-priority) duplicate only adds its kind. */
class TermSet {
  constructor() { this.byKey = new Map(); }
  add(term, kind, tier, hint = "") {
    const key = keyOf(term);
    if (!key) return;
    const have = this.byKey.get(key);
    if (have) {
      if (!have.kinds.includes(kind)) have.kinds.push(kind);
      if (!have.hint && hint) have.hint = hint;
      return;
    }
    this.byKey.set(key, { term, key, kinds: [kind], tier, hint });
  }
  list() { return [...this.byKey.values()].sort((a, b) => a.tier - b.tier); }
}

/**
 * Collect the vocabulary. Never throws. Sources, highest priority first:
 * `<dataDir>/vocabulary.txt`, `<cwd>/.claude/sotto-vocabulary.txt`, the
 * project (name, non-trivial branch, project skills), top-level folders,
 * `~/.claude/skills`, then enabled plugins (names, skills, commands).
 *
 * @param {object} o
 * @param {string} [o.home]     HOME; without it, user skills and plugins are skipped
 * @param {string} [o.cwd]      the owner session's project directory
 * @param {string} [o.dataDir]  the plugin data dir (holds vocabulary.txt)
 * @param {string} [o.project]
 * @param {string|null|Promise<string|null>} [o.branch]
 * @returns {Promise<{terms: object[], counts: object, ms: number, partial: boolean}>}
 */
export async function collectVocabulary({ home, cwd, dataDir, project, branch, deadlineMs = DEADLINE_MS, now = Date.now } = {}) {
  const t0 = now();
  const got = { glossary: [], projectGlossary: [], projectSkills: [], folders: [], userSkills: [], dirPlugins: [], plugins: [] };
  const tasks = [];
  if (dataDir) tasks.push(readText(path.join(dataDir, VOCAB_FILE)).then((t) => { got.glossary = parseGlossary(t); }));
  if (cwd) {
    tasks.push(readText(path.join(cwd, PROJECT_VOCAB_FILE)).then((t) => { got.projectGlossary = parseGlossary(t); }));
    tasks.push(scanSkillsDir(path.join(cwd, ".claude", "skills")).then((r) => { got.projectSkills = r.skills; }));
    tasks.push(topFolders(cwd).then((f) => { got.folders = f; }));
  }
  if (home) {
    tasks.push(scanSkillsDir(path.join(home, ".claude", "skills")).then(async (r) => {
      got.userSkills = r.skills;
      got.dirPlugins = await Promise.all(r.plugins.map(async (p) => ({ name: p.name, ...(await scanPlugin(p.root, p.manifest)) })));
    }));
    tasks.push(enabledPlugins(home, cwd).then(async (list) => {
      got.plugins = await Promise.all(list.map(async (p) => {
        const manifest = await readJson(path.join(p.root, ".claude-plugin", "plugin.json"));
        return { name: p.name, ...(await scanPlugin(p.root, manifest)) };
      }));
    }));
  }
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), deadlineMs); timer.unref?.(); });
  const outcome = await Promise.race([Promise.allSettled(tasks).then(() => "done"), deadline]);
  clearTimeout(timer);

  // `branch` may be a promise (the caller's git lookup runs in parallel).
  const br = await Promise.resolve(branch).catch(() => null);
  const set = new TermSet();
  for (const g of got.glossary) set.add(g.term, "glossary", TIER.glossary, g.hint);
  for (const g of got.projectGlossary) set.add(g.term, "glossary", TIER.projectGlossary, g.hint);
  if (project) set.add(clean(project, MAX_TERM), "project", TIER.project, "this project");
  if (br && typeof br === "string" && !TRIVIAL_BRANCHES.has(br.toLowerCase())) set.add(clean(br, MAX_TERM), "branch", TIER.project, "current git branch");
  for (const s of got.projectSkills) set.add(s, "skill", TIER.project);
  for (const f of got.folders) set.add(f, "folder", TIER.folder);
  for (const s of got.userSkills) set.add(s, "skill", TIER.skill);
  for (const p of got.dirPlugins) {
    set.add(p.name, "plugin", TIER.skill);
    for (const s of p.skills) set.add(s, "skill", TIER.skill);
  }
  for (const p of got.plugins) set.add(p.name, "plugin", TIER.plugin);
  for (const p of got.plugins) for (const s of p.skills) set.add(s, "skill", TIER.pluginSkill);
  for (const p of [...got.dirPlugins, ...got.plugins]) for (const c of p.commands) set.add(c, "command", TIER.command);

  const terms = set.list();
  const counts = {};
  for (const t of terms) counts[t.kinds[0]] = (counts[t.kinds[0]] || 0) + 1;
  return { terms, counts, ms: now() - t0, partial: outcome !== "done" };
}

const label = (t) => (t.hint ? t.hint : t.kinds.join(", "));

/**
 * Render the glossary section of the Live instructions within `maxTokens`
 * (estimated with the same estimator as the appends). Explicit glossary and
 * project terms are listed with a hint; skills, plugins and commands are
 * comma-separated names. Large skill families sharing a first word (for
 * example 40 "gws-..." skills) collapse to "gws-... (40 skills)" so they don't
 * crowd out everything else. Returns "" when there are no terms.
 */
export function renderVocabulary(terms, { maxTokens = VOCAB_TOKENS } = {}) {
  if (!terms || !terms.length) return "";
  const intro = "Vocabulary: names the user may say. Speech recognition can mishear them, for example splitting one into two words or swapping in a similar-sounding word. When the user says something that sounds like one of these, it is that name: use the exact spelling shown here when you talk about it or hand the request to Claude Code. Ask only if it could be more than one of these names.";
  const detailed = [];
  const folders = [];
  const named = []; // skills, plugins, commands in priority order
  for (const t of terms) {
    if (t.tier <= TIER.project) detailed.push(`- ${t.term} (${label(t)})`);
    else if (t.tier === TIER.folder) folders.push(t.term);
    else named.push(t);
  }
  // Collapse families of 5+ names sharing the first word before "-" or ":".
  const fam = new Map();
  for (const t of named) {
    const m = t.term.match(/^([A-Za-z0-9]+)[-:]/);
    if (m) fam.set(m[1].toLowerCase(), (fam.get(m[1].toLowerCase()) || 0) + 1);
  }
  const seenFam = new Set();
  const items = [];
  for (const t of named) {
    const m = t.term.match(/^([A-Za-z0-9]+)[-:]/);
    const f = m && m[1].toLowerCase();
    if (f && fam.get(f) >= 5) {
      if (seenFam.has(f)) continue;
      seenFam.add(f);
      items.push(`${m[1]}-... (${fam.get(f)} names)`);
      continue;
    }
    const k = t.kinds[0];
    items.push(k === "skill" ? t.term : `${t.term} (${k})`);
  }

  const lines = [intro];
  const fits = (extra) => estTokens([...lines, extra].join("\n")) <= maxTokens;
  for (const d of detailed) if (fits(d)) lines.push(d);
  if (folders.length) {
    let line = "Folders in this project:";
    for (const f of folders) { const next = `${line} ${f},`; if (!fits(next)) break; line = next; }
    if (line.endsWith(",")) lines.push(line.slice(0, -1) + ".");
  }
  if (items.length) {
    let line = "Skills, plugins and commands:";
    let n = 0;
    // Leave room for the ", and N more." tail.
    for (const it of items) { const next = `${line} ${it},`; if (!fits(`${next} and ${items.length} more.`)) break; line = next; n++; }
    if (n) lines.push(line.slice(0, -1) + (n < items.length ? `, and ${items.length - n} more.` : "."));
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

// ---- fuzzy matching ------------------------------------------------------------

/** Levenshtein distance with an early exit above `max`. */
export function editDistance(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * A rough consonant skeleton for sound-alike comparison: "claude live" and
 * "clawed live" both give "kldlf"-like keys. Not a real phonetic algorithm;
 * it only has to make common ASR confusions collide.
 */
export function skeleton(s) {
  let t = String(s || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!t) return "";
  t = t
    .replace(/ph/g, "f").replace(/ck/g, "k").replace(/q/g, "k").replace(/x/g, "ks")
    .replace(/c(?=[eiy])/g, "s").replace(/c/g, "k").replace(/z/g, "s")
    .replace(/n(?=[pb])/g, "m").replace(/([aeiou])[wy]/g, "$1").replace(/([^aeiou])h/g, "$1")
    .replace(/(.)\1+/g, "$1");
  return (t[0] + t.slice(1).replace(/[aeiouy]/g, "")).replace(/(.)\1+/g, "$1");
}

const MIN_EXACT_JOIN = 5; // "app sumo" -> appsumo
const MIN_FUZZY = 8; // single-word or near matches only for long, distinctive names
const MIN_FUZZY_SPLIT = 6;

/**
 * Find glossary terms the utterance probably meant but did not spell. Only
 * mishearings are reported: a term already said as-is ("impeccable",
 * "writing style" for writing-style) is not. Rules, to keep false positives
 * low on ordinary speech:
 * - several words that join to exactly the term (len >= 5): "tiny fish";
 * - several words within 1 edit (2 for terms of 10+ chars) or the same
 *   sound skeleton, for terms of 6+ chars: "in peccable", "clawed live";
 * - one word within 1-2 edits or the same skeleton, for terms of 8+ chars,
 *   and not a prefix of the term or vice versa (so "commits" is not "commit").
 *
 * @returns {{heard: string, term: string, label: string}[]} at most `max`, in utterance order
 */
export function findTerms(utterance, terms, { max = 3 } = {}) {
  const words = String(utterance || "").toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) || [];
  if (!words.length || !terms || !terms.length) return [];
  const clipped = words.slice(0, 120).map((w) => w.replace(/'/g, ""));
  const cands = terms.filter((t) => t.key.length >= MIN_EXACT_JOIN).map((t) => ({ t, spaced: spacedOf(t.term), skel: skeleton(t.key) }));
  const hits = [];
  for (let i = 0; i < clipped.length; i++) {
    for (let n = 1; n <= 4 && i + n <= clipped.length; n++) {
      const win = clipped.slice(i, i + n);
      const joined = win.join("");
      const spaced = win.join(" ");
      if (joined.length < MIN_EXACT_JOIN) continue;
      let wskel = null;
      for (const c of cands) {
        const key = c.t.key;
        if (Math.abs(joined.length - key.length) > 2) continue;
        // Said correctly, alone or inside this window ("impeccable to"): nothing to note.
        if (spaced === c.spaced || win.includes(key) || ` ${spaced} `.includes(` ${c.spaced} `)) continue;
        let score = null;
        const maxEd = key.length >= 10 ? 2 : 1;
        if (n > 1) {
          if (joined === key) score = 0;
          else if (key.length >= MIN_FUZZY_SPLIT) {
            const d = editDistance(joined, key, maxEd);
            if (d <= maxEd) score = d;
            else if (c.skel.length >= 4 && (wskel ??= skeleton(joined)) === c.skel) score = maxEd + 0.5;
          }
        } else if (key.length >= MIN_FUZZY && !key.startsWith(joined) && !joined.startsWith(key)) {
          const d = editDistance(joined, key, maxEd);
          if (d <= maxEd) score = d + 0.25;
          else if (c.skel.length >= 5 && (wskel ??= skeleton(joined)) === c.skel) score = maxEd + 0.75;
        }
        if (score !== null) hits.push({ i, n, score, t: c.t, heard: spaced });
      }
    }
  }
  // Best first: lower score, longer term, higher-priority tier; then keep
  // non-overlapping spans and one hit per term.
  hits.sort((a, b) => a.score - b.score || b.t.key.length - a.t.key.length || a.t.tier - b.t.tier || a.i - b.i);
  const used = new Set();
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    if (out.length >= max) break;
    if (seen.has(h.t.key)) continue;
    let overlap = false;
    for (let k = h.i; k < h.i + h.n; k++) if (used.has(k)) overlap = true;
    if (overlap) continue;
    for (let k = h.i; k < h.i + h.n; k++) used.add(k);
    seen.add(h.t.key);
    out.push({ i: h.i, heard: h.heard, term: h.t.term, label: label(h.t) });
  }
  return out.sort((a, b) => a.i - b.i).map(({ heard, term, label: l }) => ({ heard, term, label: l }));
}

/**
 * One-line annotation for the delegated prompt, or null. It never rewrites the
 * user's words; it only says what a phrase may have meant.
 */
export function vocabularyHint(utterance, terms, opts) {
  const found = findTerms(utterance, terms, opts);
  if (!found.length) return null;
  const parts = found.map((f) => `'${f.heard}' may be ${f.term} (${f.label})`);
  return `(Possible names, from speech-recognition matching against the voice glossary, not the user's words: ${parts.join("; ")}.)`;
}
