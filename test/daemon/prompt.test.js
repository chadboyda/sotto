import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { render, renderForPolicy, buildSeed, buildSeedInput, SEED_TOKENS, VOICE_HISTORY_NOTE, VOICE_HISTORY_END, greeting, policyChangeInstruction, ownerSwitchInstruction, POLICY_TEXT } from "../../daemon/prompt.js";
import { estTokens } from "../../daemon/speech.js";
import { parseTranscript, readTranscriptTail, gitBranch } from "../../daemon/claude-context.js";

const HEADINGS = ["Backchannel policy:", "Interruption policy:", "Delegation policy:", "Backend tools:", "Delegate to the backend when:", "Do not delegate to the backend when:"];

test("instructions: six verbatim headings in order, closing lines, no placeholders", () => {
  for (const policy of ["quiet", "milestones", "walkthrough"]) {
    const t = renderForPolicy("sotto", policy);
    let pos = -1;
    for (const h of HEADINGS) {
      const i = t.indexOf(h, pos + 1);
      assert.ok(i > pos, `${h} missing or out of order`);
      pos = i;
    }
    assert.ok(t.endsWith("Delegate before giving an answer that depends on backend work.\nDo not guess the result while waiting."));
    assert.ok(!t.includes("{{"));
    assert.ok(t.length <= 40000);
    assert.ok(t.includes(POLICY_TEXT[policy]));
    assert.ok(t.includes('project "sotto"'));
  }
});

test("instructions: 'done' only on a Claude result for that request; otherwise working on it / pass it on", () => {
  // Observed live (2026-09-24): asked about the app's title bar, the voice said
  // "That one's done" with no result saying so.
  for (const policy of ["quiet", "milestones", "walkthrough"]) {
    const t = renderForPolicy("sotto", policy);
    assert.ok(t.includes("Say that something is done, fixed, finished or ready only when a result from Claude Code for that request says so."));
    assert.ok(t.includes(`Until then say, in your own words, that Claude's working on it or that you'll pass it on, and delegate it.`));
    assert.ok(t.includes("If the user asks whether something is done and no result says so, do not guess: delegate the question."));
  }
  // SPEC §8.1 carries the same template text.
  const spec = fs.readFileSync(new URL("../../docs/SPEC.md", import.meta.url), "utf8");
  assert.ok(spec.includes("Say that something is done, fixed, finished or ready only when a result from Claude Code for that request says so."));
});

test("render sanitizes quotes in the project name", () => {
  const t = render({ project: 'we"ird\nname', policyText: "X" });
  assert.ok(t.includes('project "we ird name"'));
});

test("greetings and runtime instructions", () => {
  assert.equal(greeting("start", "quiet", "p"), 'Say only "Ready." Then stop and listen.');
  assert.match(greeting("start", "milestones", "proj"), /connected to Claude Code in proj/);
  assert.match(greeting("resume", "walkthrough", "p"), /^Say "I'm back\."/);
  assert.equal(greeting("reconnect", "milestones", "p"), null);
  assert.equal(policyChangeInstruction("quiet"), `The update preference has changed. ${POLICY_TEXT.quiet} Apply it from now on without announcing it.`);
  assert.match(ownerSwitchInstruction("other"), /in the project other\..*connected to other\./);
});

test("seed: header, exchanges, voice history only on resume, pending result", () => {
  const s = buildSeed({
    project: "proj", cwd: "/a/b/folder", branch: "main", reason: "start",
    exchanges: [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }],
    voiceHistory: [{ role: "user", text: "voice line" }],
    pendingResult: "It passed.",
  });
  assert.ok(s.startsWith("[Background reference; not user speech]\nProject: proj   Folder: folder   Git branch: main\nVoice session: start."));
  assert.ok(s.includes("User: hi\nClaude Code: hello"));
  assert.ok(!s.includes("Earlier voice conversation"));
  assert.ok(s.endsWith("Result that arrived while voice was paused: It passed."));

  const r = buildSeed({ project: "p", cwd: "/x", branch: null, reason: "resume", voiceHistory: [{ role: "assistant", text: "a" }, { role: "user", text: "b" }] });
  assert.ok(r.includes("Git branch: unknown"));
  assert.ok(r.includes("Voice session: resumed after a pause."));
  assert.ok(r.includes("Earlier voice conversation (oldest first):\nYou said: a\nThe user said: b"));
});

test("seed stays within 24,000 chars and drops the oldest material first", () => {
  const exchanges = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `EX${i} ` + "x".repeat(590) }));
  const voiceHistory = Array.from({ length: 30 }, (_, i) => ({ role: "user", text: `V${i} ` + "y".repeat(590) }));
  const full = buildSeed({ project: "p", cwd: "/p", branch: "b", reason: "reconnect", exchanges, voiceHistory });
  assert.ok(full.length <= 24000);
  const small = buildSeed({ project: "p", cwd: "/p", branch: "b", reason: "reconnect", exchanges, voiceHistory, maxChars: 12000 });
  assert.ok(small.length <= 12000);
  assert.ok(!small.includes("EX0 "), "oldest exchange dropped");
  assert.ok(small.includes("V29 "), "newest voice line kept");
  const tiny = buildSeed({ project: "p", cwd: "/p", branch: "b", reason: "reconnect", exchanges, voiceHistory, maxChars: 8000 });
  assert.ok(!tiny.includes("EX7 "), "all exchanges dropped before voice lines");
  assert.ok(tiny.includes("V29 "));
  assert.ok(!tiny.includes("V0 "));
});

const FIXTURE = [
  { type: "summary", summary: "x" },
  { type: "user", message: { role: "user", content: "What branch am I on?" } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Let me check." }, { type: "tool_use", id: "t", name: "Bash", input: {} }] } },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "main" }] } },
  { type: "user", isMeta: true, message: { role: "user", content: "meta stuff" } },
  { type: "user", message: { role: "user", content: "/talk on" } },
  { type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "You are on **main** in `src/app/index.ts`." }] } },
].map((o) => JSON.stringify(o)).join("\n") + "\n{not json\n";

test("transcript-tail parser keeps text, skips tool/meta/commands", () => {
  const out = parseTranscript(FIXTURE);
  assert.deepEqual(out, [
    { role: "user", text: "What branch am I on?" },
    { role: "assistant", text: "You are on main in index.ts." },
  ]);
});

test("readTranscriptTail reads only the tail and never throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clv-tt-"));
  const f = path.join(dir, "t.jsonl");
  const filler = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ type: "user", message: { role: "user", content: `old ${i} ` + "z".repeat(100) } })).join("\n");
  fs.writeFileSync(f, filler + "\n" + FIXTURE);
  const out = readTranscriptTail(f);
  assert.ok(out.length <= 8);
  assert.deepEqual(out.slice(-2), [
    { role: "user", text: "What branch am I on?" },
    { role: "assistant", text: "You are on main in index.ts." },
  ]);
  assert.deepEqual(readTranscriptTail(path.join(dir, "missing.jsonl")), []);
  assert.deepEqual(readTranscriptTail(null), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("gitBranch uses execFile and handles errors", async () => {
  const ok = (cmd, args, opts, cb) => { assert.equal(cmd, "git"); assert.deepEqual(args.slice(0, 2), ["-C", "/repo"]); assert.equal(opts.timeout, 800); cb(null, "feat/x\n"); };
  assert.equal(await gitBranch("/repo", { execFile: ok }), "feat/x");
  assert.equal(await gitBranch("/repo", { execFile: (c, a, o, cb) => cb(new Error("no")) }), null);
  assert.equal(await gitBranch(null), null);
});

test("buildSeedInput: voice history as user/assistant messages, merged by role, under the API limits", () => {
  const voiceHistory = [
    { role: "user", text: "what branch" }, { role: "user", text: "are we on?" },
    { role: "assistant", text: "Let me ask Claude." }, { role: "assistant", text: "You're on banana." },
  ];
  const msgs = buildSeedInput({ project: "p", cwd: "/x/p", branch: "b", reason: "reconnect", voiceHistory, estTokens });
  assert.equal(msgs[0].role, "developer");
  assert.ok(msgs[0].text.includes(VOICE_HISTORY_NOTE));
  assert.ok(!/You said|The user said/.test(msgs[0].text), "history is not quoted in the developer message");
  assert.deepEqual(msgs.slice(1), [
    { role: "user", text: "what branch are we on?" },
    { role: "assistant", text: "Let me ask Claude. You're on banana." },
    { role: "developer", text: VOICE_HISTORY_END },
  ]);
  // start: no history at all.
  assert.equal(buildSeedInput({ project: "p", cwd: "/x", reason: "start", voiceHistory, estTokens }).length, 1);
  // Budget: big exchanges and history still fit SEED_TOKENS (API: 8,192 combined) and 128 messages.
  const long = "word ".repeat(200);
  const big = buildSeedInput({
    project: "p", cwd: "/x", reason: "reconnect", estTokens,
    exchanges: Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: long })),
    voiceHistory: Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: long })),
  });
  const total = big.reduce((n, m) => n + estTokens(m.text) + 4, 0);
  assert.ok(total <= SEED_TOKENS, `${total} tokens`);
  assert.ok(big.length <= 128);
  assert.ok(big.some((m) => m.role === "assistant"), "recent voice lines survive");
  assert.ok(long.startsWith(big.at(-2).text.slice(0, -1)), "the newest line is kept (capped at 600 chars)");
});

test("instructions: never invent reasons for a problem; say plainly you didn't catch it", () => {
  const t = render({ project: "p", policyText: "", vocabulary: "", persona: null });
  assert.match(t, /Never invent reasons for a problem \("just a short delay", "a small glitch"\)/);
  assert.match(t, /"Sorry, I didn't catch that"/);
  assert.match(t, /"I'm having trouble hearing you\. You might want to check the mic\."/);
});
