// Mod pure logic for /talk from the mod, the seed and the terminal UI (SPEC §6.21).
import { test } from "node:test";
import assert from "node:assert/strict";
import { optionEnv, isTalkCommand, transcriptPathFor, expansionInput, toggleText, contextOf, statusLine, phaseOf, fit, bandLines } from "../../hooks/modcore.mjs";

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

test("terminal UI: status line, phase, band fitted to narrow widths", () => {
  const s = { state: "live", persona: "moss", voice: "cedar", busy: false, said: "All forty-two tests pass.", activity: "" };
  assert.equal(statusLine(s), "voice ON | persona moss | voice cedar");
  assert.equal(statusLine(null), undefined);
  assert.equal(phaseOf(s), "listening");
  assert.equal(phaseOf({ ...s, busy: true }), "Claude is working");
  assert.equal(phaseOf({ ...s, approval: "run tests" }), "approval needed");
  assert.equal(phaseOf({ state: "sleeping" }), "asleep, talk to wake it");
  assert.equal(fit("abcdef", 4), "abc…");
  assert.equal(fit("a\n  b", 10), "a b");
  assert.deepEqual(bandLines(s, 80), ["sotto | listening", "\"All forty-two tests pass.\""]);
  for (const cols of [10, 20, 33]) for (const l of bandLines({ ...s, busy: true, said: "x".repeat(200) }, cols)) assert.ok([...l].length <= cols, `${cols}: ${l}`);
  assert.deepEqual(bandLines({ state: "paused" }, 40), ["sotto | paused"]);
});
