// Mod pure logic for /talk from the mod, the seed and the terminal UI (SPEC §6.21).
import { test } from "node:test";
import assert from "node:assert/strict";
import { optionEnv, isTalkCommand, transcriptPathFor, expansionInput, toggleText, contextOf, phaseOf, fit, bandRows, bandLines } from "../../hooks/modcore.mjs";

test("optionEnv: userConfig values as toggle.sh's CLAUDE_PLUGIN_OPTION_* (idle_minutes kept meaningful)", () => {
  assert.deepEqual(optionEnv({ voice: "cedar", port: 47821, idle_seconds: 60, idle_minutes: 5, nested: { a: 1 } }), {
    CLAUDE_PLUGIN_OPTION_VOICE: "cedar", CLAUDE_PLUGIN_OPTION_PORT: "47821", CLAUDE_PLUGIN_OPTION_IDLE_SECONDS: "60", CLAUDE_PLUGIN_OPTION_IDLE_MINUTES: "5",
  });
  const legacy = optionEnv({ idle_seconds: 60, idle_minutes: 10 });
  assert.equal(legacy.CLAUDE_PLUGIN_OPTION_IDLE_SECONDS, undefined);
  assert.equal(legacy.CLAUDE_PLUGIN_OPTION_IDLE_MINUTES, "10");
});

test("/talk from the mod: the command, the expansion stdin toggle.sh parses, its answer", () => {
  assert.equal(isTalkCommand("sotto:talk"), true);
  assert.equal(isTalkCommand("talk"), true);
  assert.equal(isTalkCommand("other:talk"), false);
  assert.equal(transcriptPathFor("/h/.claude", "/private/tmp/x y", "s1"), "/h/.claude/projects/-private-tmp-x-y/s1.jsonl");
  const j = JSON.parse(expansionInput({ sessionId: "s1", transcriptPath: "/t", cwd: "/w", permissionMode: "bypassPermissions", args: "voice cedar" }));
  assert.deepEqual([j.session_id, j.command_args, j.permission_mode, j.hook_event_name, j.prompt], ["s1", "voice cedar", "bypassPermissions", "UserPromptExpansion", "/sotto:talk voice cedar"]);
  assert.equal(JSON.parse(expansionInput({})).permission_mode, "default");
  assert.equal(toggleText('{"continue":false,"stopReason":"sotto: voice ON (proj)."}\n'), "voice ON (proj).");
  assert.equal(toggleText("garbage"), null);
});

test("contextOf: user and assistant text only, newest last, bounded", () => {
  const rows = [{ role: "user", text: "a" }, { role: "assistant", text: "" }, { role: "system", text: "x" }, { role: "assistant", text: "b", toolUses: [] }];
  assert.deepEqual(contextOf(rows), [{ role: "user", text: "a" }, { role: "assistant", text: "b" }]);
  assert.equal(contextOf(Array.from({ length: 100 }, (_, i) => ({ role: "user", text: `m${i}` })), 5).at(-1).text, "m99");
  assert.equal(contextOf([{ role: "user", text: "z".repeat(9000) }])[0].text.length, 4000);
});

test("terminal UI: one band, header then caption, fitted to narrow widths", () => {
  const s = { state: "live", persona: "vela", voice: "willow", busy: false, said: "Mm. Passing it along to Claude now.", activity: "" };
  assert.equal(phaseOf(s), "listening");
  assert.equal(phaseOf({ ...s, busy: true }), "Claude is working");
  assert.equal(phaseOf({ ...s, approval: "run tests" }), "approval needed");
  assert.equal(phaseOf({ state: "sleeping" }), "asleep, talk to wake it");
  assert.equal(fit("abcdef", 4), "abc…");
  assert.equal(fit("a\n  b", 10), "a b");
  assert.deepEqual(bandLines(s, 80), ["sotto · listening · vela · willow", "\"Mm. Passing it along to Claude now.\""]);
  // persona and voice dimmed, the name bold, no warning style in the normal state
  const [head, cap] = bandRows(s, 80);
  assert.deepEqual(head.map((g) => [g.text, !!g.bold, !!g.dim, !!g.warn]), [["sotto", true, false, false], [" · listening", false, false, false], [" · vela", false, true, false], [" · willow", false, true, false]]);
  assert.equal(cap[0].warn, undefined);
  // narrow: the voice goes first, then the persona, then the phase is cut
  assert.equal(bandLines(s, 26)[0], "sotto · listening · vela");
  assert.equal(bandLines(s, 18)[0], "sotto · listening");
  for (const cols of [10, 14, 20, 33]) for (const l of bandLines({ ...s, busy: true, said: "x".repeat(200) }, cols)) assert.ok([...l].length <= cols, `${cols}: ${l}`);
  assert.deepEqual(bandLines({ state: "paused" }, 40), ["sotto · paused"]);
  // voice off: nothing at all
  assert.deepEqual(bandRows({ state: "off", persona: "vela" }, 80), []);
  assert.deepEqual(bandRows(null, 80), []);
});

test("terminal UI: a real problem takes the header in the warning style", () => {
  const s = { state: "live", persona: "vela", voice: "willow", said: "hi" };
  for (const [kind, word] of [["held", "held"], ["cant_hear", "can't hear you"], ["error", "error"]]) {
    const rows = bandRows({ ...s, problem: { kind, text: "what to do" } }, 80);
    assert.equal(rows[0][1].text, ` · ${word}`);
    assert.equal(rows[0][1].warn, true);
    assert.deepEqual(rows[1], [{ text: "what to do", warn: true }]);
  }
  assert.equal(bandRows({ ...s, problem: { kind: "other", text: "x" } }, 80)[0][1].warn, undefined);
});
