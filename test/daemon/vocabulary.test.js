import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectVocabulary, renderVocabulary, findTerms, vocabularyHint, parseGlossary, parseFrontmatter,
  editDistance, skeleton, keyOf, TIER, VOCAB_TOKENS,
} from "../../daemon/vocabulary.js";
import { estTokens } from "../../daemon/speech.js";
import { renderForPolicy, render, POLICY_TEXT, vocabularyUpdateInstruction } from "../../daemon/prompt.js";
import { delegationHarness, sentRecord } from "../helpers/delegation-harness.js";
import { makeHarness, SESSION } from "../helpers/daemon-harness.js";

// ---- fixture: a fake HOME, project and data dir ---------------------------------

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const skill = (name, extra = "") => `---\nname: ${name}\ndescription: >\n  Does ${name} things.\n  Second line.\n${extra}---\n\nBody.\n`;

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clv-vocab-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cwd = path.join(root, "work", "claude-live");
  const dataDir = path.join(root, "data");
  const cache = path.join(home, ".claude", "plugins", "cache");

  // ~/.claude/skills: two skills, one hidden, one symlinked skills-dir plugin.
  write(path.join(home, ".claude/skills/impeccable/SKILL.md"), skill("impeccable"));
  write(path.join(home, ".claude/skills/humanizer/SKILL.md"), skill("humanizer"));
  write(path.join(home, ".claude/skills/secret-helper/SKILL.md"), skill("secret-helper", "user-invocable: false\n"));
  write(path.join(home, ".claude/skills/not-a-skill/README.md"), "nothing");
  const dirPlugin = path.join(root, "src", "voicey");
  write(path.join(dirPlugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "voicey" }));
  write(path.join(dirPlugin, "skills/talk/SKILL.md"), skill("talk"));
  fs.symlinkSync(dirPlugin, path.join(home, ".claude/skills/voicey"));

  // Installed plugins: enabled, disabled, other project's, custom skills path.
  const intent = path.join(cache, "intent/intent/1.6.0");
  write(path.join(intent, ".claude-plugin/plugin.json"), JSON.stringify({ name: "intent" }));
  write(path.join(intent, "skills/articulate/SKILL.md"), skill("articulate"));
  write(path.join(intent, "skills/intent/SKILL.md"), skill("intent"));
  write(path.join(intent, "commands/wireframe.md"), "# wireframe\n");
  const custom = path.join(cache, "mk/marketing/1.0.0");
  write(path.join(custom, ".claude-plugin/plugin.json"), JSON.stringify({ name: "marketing", skills: ["./extra/"] }));
  write(path.join(custom, "extra/copywriting/SKILL.md"), skill("copywriting"));
  const off = path.join(cache, "x/disabled-thing/1.0.0");
  write(path.join(off, "skills/disabledskill/SKILL.md"), skill("disabledskill"));
  const other = path.join(cache, "x/elsewhere/1.0.0");
  write(path.join(other, "skills/elsewhereskill/SKILL.md"), skill("elsewhereskill"));
  write(path.join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: {
      "intent@intent": [{ scope: "user", installPath: intent }],
      "marketing@mk": [{ scope: "user", installPath: custom }],
      "disabled-thing@x": [{ scope: "user", installPath: off }],
      "elsewhere@x": [{ scope: "project", projectPath: path.join(root, "other-project"), installPath: other }],
    },
  }));
  write(path.join(home, ".claude/settings.json"), JSON.stringify({
    enabledPlugins: { "intent@intent": true, "marketing@mk": true, "disabled-thing@x": false, "elsewhere@x": true },
  }));

  // Project: its own skill and glossary, a few folders.
  write(path.join(cwd, ".claude/skills/deploy-it/SKILL.md"), skill("deploy-it"));
  write(path.join(cwd, ".claude/sotto-vocabulary.txt"), "AppSumo: the marketplace\n");
  for (const d of ["daemon", "web", "node_modules", ".git", "docs"]) fs.mkdirSync(path.join(cwd, d), { recursive: true });

  // User glossary in the plugin data dir.
  write(path.join(dataDir, "vocabulary.txt"), "# my names\n\nTinyFish: web automation service\nimpeccable: my design skill\nappsumo-bd:cal-pitch\n");
  return { root, home, cwd, dataDir };
}

// ---- parsing ------------------------------------------------------------------

test("parseGlossary: one term per line, optional 'term: hint', comments and blanks skipped", () => {
  assert.deepEqual(parseGlossary("# c\n\nTinyFish: web automation\nAppSumo\n plugin:skill \nquo\"te: a\\b\n"), [
    { term: "TinyFish", hint: "web automation" },
    { term: "AppSumo", hint: "" },
    { term: "plugin:skill", hint: "" },
    { term: "quo te", hint: "a b" },
  ]);
  assert.deepEqual(parseGlossary(null), []);
});

test("parseFrontmatter reads top-level scalars and ignores folded continuation lines", () => {
  const fm = parseFrontmatter(skill("impeccable", "user-invocable: false\nargument-hint: \"[x]\"\n"));
  assert.equal(fm.name, "impeccable");
  assert.equal(fm.description, ">");
  assert.equal(fm["user-invocable"], "false");
  assert.equal(fm["argument-hint"], "[x]");
  assert.deepEqual(parseFrontmatter("no front matter"), {});
});

// ---- collection -----------------------------------------------------------------

test("collectVocabulary: all sources, priority order, dedupe, filters, fast", async (t) => {
  const f = makeFixture(t);
  // A generous deadline: this test is about content, and under load (npm test
  // runs files in parallel, maybe next to a build) the default 200 ms deadline
  // can cut the scan short. Unloaded the fixture scan takes ~10 ms; the
  // deadline itself is tested below with deadlineMs: 0.
  const v = await collectVocabulary({ home: f.home, cwd: f.cwd, dataDir: f.dataDir, project: "claude-live", branch: Promise.resolve("feat/vocabulary"), deadlineMs: 10000 });
  assert.equal(v.partial, false);
  assert.ok(v.ms < 2000, `took ${v.ms} ms`);
  const by = Object.fromEntries(v.terms.map((x) => [x.term, x]));
  const names = v.terms.map((x) => x.term);

  // User glossary first; its "impeccable" wins over the skill but keeps both kinds.
  assert.deepEqual(names.slice(0, 3), ["TinyFish", "impeccable", "appsumo-bd:cal-pitch"]);
  assert.equal(by.TinyFish.hint, "web automation service");
  assert.equal(by.impeccable.tier, TIER.glossary);
  assert.deepEqual(by.impeccable.kinds, ["glossary", "skill"]);
  assert.equal(by.AppSumo.tier, TIER.projectGlossary);
  assert.equal(by["claude-live"].tier, TIER.project);
  assert.equal(by["feat/vocabulary"].kinds[0], "branch");
  assert.equal(by["deploy-it"].tier, TIER.project);
  assert.equal(by.daemon.kinds[0], "folder");
  assert.equal(by.humanizer.tier, TIER.skill);
  assert.equal(by.voicey.kinds[0], "plugin", "a skills-dir plugin symlink counts as a plugin");
  assert.equal(by.talk.tier, TIER.skill);
  assert.equal(by.intent.tier, TIER.plugin);
  assert.deepEqual(by.intent.kinds, ["plugin", "skill"]);
  assert.equal(by.articulate.tier, TIER.pluginSkill);
  assert.equal(by.copywriting.tier, TIER.pluginSkill, "manifest skills path is scanned");
  assert.equal(by.wireframe.kinds[0], "command");

  for (const absent of ["secret-helper", "not-a-skill", "disabledskill", "disabled-thing", "elsewhereskill", "elsewhere", "node_modules", ".git"]) {
    assert.ok(!names.includes(absent), `${absent} must not be collected`);
  }
  // Tiers never decrease along the list.
  for (let i = 1; i < v.terms.length; i++) assert.ok(v.terms[i].tier >= v.terms[i - 1].tier);
  // Keys are unique.
  assert.equal(new Set(v.terms.map((x) => x.key)).size, v.terms.length);
});

test("collectVocabulary: missing everything yields only the project; trivial branches are skipped", async () => {
  const v = await collectVocabulary({ home: "/nonexistent/home", cwd: "/nonexistent/cwd", dataDir: "/nonexistent/data", project: "proj", branch: "main", deadlineMs: 10000 });
  assert.deepEqual(v.terms.map((x) => x.term), ["proj"]);
  const none = await collectVocabulary({});
  assert.deepEqual(none.terms, []);
});

test("collectVocabulary stops at the deadline with what it has", async (t) => {
  const f = makeFixture(t);
  const v = await collectVocabulary({ home: f.home, cwd: f.cwd, dataDir: f.dataDir, project: "p", deadlineMs: 0 });
  assert.ok(v.terms.some((x) => x.term === "p"));
  assert.equal(typeof v.partial, "boolean");
});

// ---- rendering and budget -------------------------------------------------------

const term = (t, tier, kind = "skill", hint = "") => ({ term: t, key: keyOf(t), kinds: [kind], tier, hint });

test("renderVocabulary: priority order, hints, folders, collapsed families, budget", () => {
  const terms = [
    term("TinyFish", TIER.glossary, "glossary", "web automation service"),
    term("claude-live", TIER.project, "project", "this project"),
    term("daemon", TIER.folder, "folder"),
    term("impeccable", TIER.skill),
    ...Array.from({ length: 6 }, (_, i) => term(`gws-tool${i}`, TIER.skill)),
    term("intent", TIER.plugin, "plugin"),
    term("commit", TIER.command, "command"),
  ];
  const text = renderVocabulary(terms);
  assert.match(text, /^Vocabulary: names the user may say\./);
  assert.ok(text.indexOf("- TinyFish (web automation service)") < text.indexOf("- claude-live (this project)"));
  assert.match(text, /Folders in this project: daemon\./);
  assert.match(text, /Skills, plugins and commands: impeccable, gws-\.\.\. \(6 names\), intent \(plugin\), commit \(command\)\./);
  assert.equal(renderVocabulary([]), "");
});

test("renderVocabulary keeps within the token budget and says how many were left out", () => {
  const terms = [
    ...Array.from({ length: 40 }, (_, i) => term(`Glossaryname${i}`, TIER.glossary, "glossary", "a fairly long user-provided hint for this term")),
    ...Array.from({ length: 3000 }, (_, i) => term(`uniqueskill${i}x`, TIER.pluginSkill)),
  ];
  const text = renderVocabulary(terms);
  assert.ok(estTokens(text) <= VOCAB_TOKENS, `estimated ${estTokens(text)} tokens`);
  assert.ok(text.includes("- Glossaryname0 ("), "top-priority terms kept");
  assert.match(text, /and \d+ more\.$/);
  const small = renderVocabulary(terms, { maxTokens: 200 });
  assert.ok(estTokens(small) <= 200);
});

// ---- fuzzy matching --------------------------------------------------------------

const GLOSSARY = [
  term("TinyFish", TIER.glossary, "glossary"), term("AppSumo", TIER.glossary, "glossary"),
  term("claude-live", TIER.project, "project", "this project"),
  term("impeccable", TIER.skill), term("humanizer", TIER.skill), term("writing-style", TIER.skill),
  term("design-principles", TIER.skill), term("casting", TIER.skill), term("taste", TIER.skill),
  term("schedule", TIER.skill), term("simplify", TIER.skill), term("loop", TIER.skill), term("run", TIER.skill),
  term("intent", TIER.plugin, "plugin"), term("commit", TIER.command, "command"), term("hooks", TIER.skill),
  term("daemon", TIER.folder, "folder"), term("scripts", TIER.folder, "folder"), term("test", TIER.folder, "folder"),
];

test("findTerms: common mishearings map to the glossary term", () => {
  const one = (u) => findTerms(u, GLOSSARY).map((m) => `${m.heard}=>${m.term}`);
  assert.deepEqual(one("can you run in peccable on the landing page"), ["in peccable=>impeccable"]);
  assert.deepEqual(one("use tiny fish to scrape it"), ["tiny fish=>TinyFish"]);
  assert.deepEqual(one("check the app sumo dashboard"), ["app sumo=>AppSumo"]);
  assert.deepEqual(one("use the in tent skill"), ["in tent=>intent"]);
  assert.deepEqual(one("open the clawed live settings"), ["clawed live=>claude-live"]);
  assert.deepEqual(one("is the impecable skill installed"), ["impecable=>impeccable"]);
  assert.deepEqual(one("run in peccable and then the human eyes er"), ["in peccable=>impeccable", "human eyes er=>humanizer"]);
  assert.deepEqual(one("tiny fish then app sumo then in peccable then in tent"), ["tiny fish=>TinyFish", "app sumo=>AppSumo", "in tent=>intent"], "at most 3, exact joins first, in utterance order");
});

test("findTerms: ordinary speech and correctly spelled names give nothing", () => {
  for (const u of [
    "can you run the tests and tell me what failed",
    "please list the files in this project",
    "what is this costing us",
    "commit and push the changes",
    "show me the commits from today",
    "make the button look better",
    "schedule a meeting for tomorrow and simplify the plan",
    "that tastes great",
    "use impeccable to polish it",
    "try the humanizer on this",
    "run the writing style skill",
    "apply the design principles",
    "restart the daemon and check the hooks",
    "hey how are you doing today",
    "",
  ]) {
    assert.deepEqual(findTerms(u, GLOSSARY), [], u);
  }
  assert.deepEqual(findTerms("in peccable", []), []);
});

test("vocabularyHint annotates without rewriting", () => {
  assert.equal(vocabularyHint("hello there", GLOSSARY), null);
  assert.equal(
    vocabularyHint("run in peccable on the tiny fish page", GLOSSARY),
    "(Possible names, from speech-recognition matching against the voice glossary, not the user's words: 'in peccable' may be impeccable (skill); 'tiny fish' may be TinyFish (glossary).)",
  );
});

test("editDistance and skeleton basics", () => {
  assert.equal(editDistance("kitten", "sitting"), 3);
  assert.equal(editDistance("abc", "abc"), 0);
  assert.ok(editDistance("abcdef", "uvwxyz", 1) > 1);
  assert.equal(skeleton("claudelive"), skeleton("clawedlive"));
  assert.equal(skeleton("impeccable"), skeleton("inpeccable"));
  assert.notEqual(skeleton("impeccable"), skeleton("important"));
});

// ---- prompt assembly -------------------------------------------------------------

test("instructions: vocabulary sits before the policy text; template contract intact", () => {
  const vocab = renderVocabulary([term("TinyFish", TIER.glossary, "glossary", "web automation")]);
  const t = renderForPolicy("claude-live", "quiet", vocab);
  assert.ok(t.includes(`nearby conversation as a new request.\n\n${vocab}\n\n${POLICY_TEXT.quiet}\n\nDelegation policy:`));
  assert.ok(t.endsWith("Delegate before giving an answer that depends on backend work.\nDo not guess the result while waiting."));
  assert.ok(!t.includes("{{"));
  // Without a vocabulary the text is exactly the v1 template.
  const plain = renderForPolicy("claude-live", "quiet");
  assert.ok(plain.includes(`nearby conversation as a new request.\n\n${POLICY_TEXT.quiet}\n\nDelegation policy:`));
  assert.equal(renderForPolicy("claude-live", "quiet", "   "), plain);
  // User glossary text is inserted literally: no placeholder or $-pattern expansion.
  const odd = render({ project: "p", policyText: "P", vocabulary: "- a{{project}}b $& $1 {{policy_text}}" });
  assert.ok(odd.includes("- a{{project}}b $& $1 {{policy_text}}\n\nP"));
  // A full-size glossary keeps the instructions far below the 16,384-token limit.
  const big = renderVocabulary(Array.from({ length: 3000 }, (_, i) => term(`skill${i}name`, TIER.skill)));
  assert.ok(estTokens(renderForPolicy("p", "milestones", big)) < 5000); // API limit: 16,384
});

test("vocabularyUpdateInstruction", () => {
  assert.equal(vocabularyUpdateInstruction(""), null);
  assert.match(vocabularyUpdateInstruction("Vocabulary: x"), /^Names for the new project, in addition to the vocabulary you already have:\nVocabulary: x$/);
});

// ---- delegation and voice wiring --------------------------------------------------

test("delegated prompt: the hint goes on its own line after the user's words", async () => {
  const h = delegationHarness();
  h.engine.fx.vocabularyHint = (text) => vocabularyHint(text, GLOSSARY);
  await sentRecord(h, "d1", "run in peccable on the page", 1000);
  assert.equal(h.sends.length, 1);
  const lines = h.sends[0].content.split("\n");
  assert.match(lines[0], /^\[sotto voice\] run in peccable on the page$/);
  assert.equal(lines.at(-1), "(Possible names, from speech-recognition matching against the voice glossary, not the user's words: 'in peccable' may be impeccable (skill).)");

  const h2 = delegationHarness();
  h2.engine.fx.vocabularyHint = () => { throw new Error("boom"); };
  await sentRecord(h2, "d2", "list the files", 1000);
  assert.equal(h2.sends[0].content, "[sotto voice] list the files", "a failing matcher never blocks delivery");
});

test("voice: session instructions carry the data-dir glossary; SOTTO_VOCAB=0 turns it off", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  fs.writeFileSync(path.join(h.dataDir, "vocabulary.txt"), "TinyFish: web automation service\n");
  h.on();
  const r = await h.voice.createSession({ sdp: "v=0 offer", reason: "start" });
  assert.equal(r.status, 201);
  const ins = h.fetchCalls[0].body.session.instructions;
  assert.match(ins, /Vocabulary: names the user may say\./);
  assert.ok(ins.includes("- TinyFish (web automation service)"));
  assert.ok(h.voice.vocab.terms.some((x) => x.term === "TinyFish"));

  const h2 = await makeHarness({ env: { OPENAI_API_KEY: "sk-test-key", SOTTO_VOCAB: "0" } });
  t.after(() => h2.cleanup());
  fs.writeFileSync(path.join(h2.dataDir, "vocabulary.txt"), "TinyFish\n");
  h2.on();
  await h2.voice.createSession({ sdp: "v=0 offer", reason: "start" });
  assert.ok(!h2.fetchCalls[0].body.session.instructions.includes("Vocabulary:"));
});

test("voice: collection starts at bind and is reused; an owner switch sends the new project's names", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clv-vocab-sw-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projB = path.join(root, "proj-b");
  write(path.join(projB, ".claude/sotto-vocabulary.txt"), "Kubrick: the render farm\n");
  const h = await makeHarness();
  t.after(() => h.cleanup());
  h.on();
  const job = h.voice.vocabJob;
  assert.ok(job && job.promise, "prewarmed at bind");
  const ws = await h.goLive();
  assert.equal(h.voice.vocabJob, job, "session start reused the bind-time collection");
  h.on(SESSION("/tmp/clv-owner-b.sock", { cwd: projB, project_dir: projB }));
  await h.voice.vocabJob.promise;
  await new Promise((r) => setImmediate(r));
  assert.match(appendsOf(ws, "commentary").map((e) => e.content).at(-1), /switched to a different Claude Code session/);
  assert.ok(!appendsOf(ws, "instructions").some((e) => /^Names for the new project/.test(e.content)), "the glossary is silent context, not instructions");
  const ins = appendsOf(ws, "thinking").map((e) => e.content);
  assert.match(ins.at(-1), /^Names for the new project, in addition to the vocabulary you already have:\nVocabulary:/);
  assert.ok(ins.at(-1).includes("- Kubrick (the render farm)"));
  assert.ok(estTokens(ins.at(-1)) <= 450);
  assert.ok(h.voice.vocab.terms.some((x) => x.term === "Kubrick"), "matcher uses the new project's terms");
});

const appendsOf = (ws, kind) => ws.sent.filter((e) => e.type === `session.${kind}.append`);
