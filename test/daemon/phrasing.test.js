// Spoken phrasing (SPEC §8.1 "How you talk", §6.10): results relayed as
// material, not read as a quote; notices with rotating variants.
import { test } from "node:test";
import assert from "node:assert/strict";
import { relay, relayMaterial, materialOf, stripLabels, isTagline, say, TEMPLATES, TEMPLATE_MAX_CHARS, Rotation, RELAY_MARK } from "../../daemon/phrasing.js";
import { route, Narrator } from "../../daemon/policy.js";
import { renderForPolicy, cantHearInstruction, CANT_HEAR_LINES, personaBlock } from "../../daemon/prompt.js";
import { isBannedOpener, openerKey } from "../../daemon/stylewatch.js";
import { spokenLead } from "../../daemon/speaker.js";
import { estTokens, fitTokens } from "../../daemon/speech.js";
import { MAX_APPEND_TOKENS } from "../../daemon/config.js";
import { createFakeClock } from "../helpers/fake-clock.js";
import fs from "node:fs";
import { TEMPLATE } from "../../daemon/prompt.js";

// A Claude reply in the shape that sounded robotic read aloud (live, 2026-09-24).
const REPORT = [
  "**Fixed the wake bug.** Normal speech wakes the voice now.",
  "",
  "**What changed:**",
  "- **Threshold:** lowered in `/Users/me/dev/sotto/daemon/wake.js` from 0.08 to 0.05",
  "- **Tests:** 3 new cases in `test/daemon/wake.test.js`",
  "",
  "No input needed from you.",
].join("\n");

test("prompt: the conversational speech rules are in every rendered prompt, before the persona can override them", () => {
  for (const policy of ["quiet", "milestones", "walkthrough"]) {
    const t = renderForPolicy("proj", policy, "", { name: "Moss", body: "Dry." });
    assert.match(t, /How you talk: this is a spoken conversation, not a written report\./);
    assert.match(t, /contractions/);
    assert.match(t, /Relay, don't read\./);
    assert.match(t, /Never read out lists, headings, labels/);
    assert.match(t, /Say "Claude", not "Claude Code"/);
    assert.match(t, /React like a person/);
    assert.match(t, /never open two replies the same way/);
    assert.match(t, /Never open with "Claude Code's answer", "Update:"/);
    assert.match(t, /"You're right"/);
    assert.match(t, /acknowledge it at most once per topic/);
    assert.match(t, /Don't over-apologize/);
    assert.match(t, /Never close with a reassurance like "no action needed", "no input needed from you"/);
    assert.match(t, /if nothing is needed from the user, say nothing about it/);
    assert.match(t, /Never repeat a phrase you've already said this session/);
    assert.match(t, /want the details\?/);
    // Background notes are never announced, not even as "nothing for you".
    assert.match(t, /never bring one up unprompted \(no "another background job just finished", no "another agent finished, nothing for you"\)/);
    // The persona block says the rules below win; the speech rules are below it.
    assert.ok(t.indexOf("Every rule below takes precedence") < t.indexOf("How you talk:"));
  }
  assert.ok(personaBlock({ name: "x", body: "y" }).includes("Every rule below takes precedence over the persona on content"));
  // SPEC §8.1 carries the template verbatim.
  assert.ok(fs.readFileSync(new URL("../../docs/SPEC.md", import.meta.url), "utf8").includes("```text\n" + TEMPLATE + "\n```"));
});

test("results are material to relay, never a quote prefixed \"Claude Code's answer\"", () => {
  for (const policy of ["quiet", "milestones", "walkthrough"]) {
    const acts = route("voice_result", policy, { text: REPORT, delegationId: "d1" });
    const c = acts.find((a) => a.kind === "commentary");
    assert.doesNotMatch(c.content, /Claude Code's answer/);
    assert.match(c.content, /^Claude's reply to what the user asked\. Tell the user the gist in your own words, speaking to them as "you", conversationally, in one to three short sentences, in your persona's own voice and style\./);
    assert.match(c.content, /Don't read lists, labels, file paths or formatting aloud/);
    const m = materialOf(c.content);
    assert.equal(m, "Fixed the wake bug. Normal speech wakes the voice now. lowered in wake.js from 0.08 to 0.05. 3 new cases in wake.test.js.");
    assert.ok(estTokens(c.content) <= MAX_APPEND_TOKENS);
    // The full reply stays available silently for follow-ups.
    const full = acts.filter((a) => a.kind === "thinking").map((a) => a.content).join(" ");
    assert.match(full, /full reply, for follow-up questions/);
    assert.match(full, /Threshold/);
  }
  for (const [source, payload] of [["mirror_result", { text: "Found it. The window started late." }], ["typed_result", { text: "Done. Tests pass." }], ["background_voice", { text: "Counted 3 files.", requestText: "count files" }], ["background_result", { text: "All green." }]]) {
    for (const a of route(source, "walkthrough", payload)) {
      assert.doesNotMatch(a.content, /Claude Code's answer|Claude Code, on what you just said|^Update on|^Background work finished:|^Claude Code finished:/, source);
    }
  }
});

test("relayMaterial: no markdown, lists, labels, paths, tag lines or repeated sentences", () => {
  const m = relayMaterial(REPORT);
  assert.doesNotMatch(m, /\*|`|^- |\/Users|Threshold:|Tests:/);
  assert.doesNotMatch(m, /No input needed/i);
  assert.equal(relayMaterial("The build passes. The build passes. Merged."), "The build passes. Merged.");
  assert.equal(relayMaterial("Found it: the window started late."), "Found it: the window started late.", "a colon inside a sentence stays");
  assert.equal(stripLabels("Summary: It works. Next steps: Merge it."), "It works. Merge it.");
  assert.equal(relayMaterial("```js\nx()\n```\nDone."), "Done.");
  assert.ok(relayMaterial("word. ".repeat(500), 900).length <= 900);
});

test("isTagline: stock reassurances, not real content", () => {
  for (const t of ["No input needed from you.", "No action needed.", "Still no action for you.", "No action for you on those.", "Nothing for you to do.",
    "Nothing for you right now.", "No action on your side.", "You don't need to do anything.", "No action from you.", "and no action needed on your end"]) assert.ok(isTagline(t), t);
  for (const t of ["No tests failed.", "Nothing broke.", "You need to approve the edit.", "No, it's the other file.", "The action ran for you."]) assert.ok(!isTagline(t), t);
});

test("spokenLead ignores the relay frame, so repeat detection compares Claude's words", () => {
  const c = relay("answer", "The parser tests pass now. Merged to main.");
  assert.equal(spokenLead(c), "The parser tests pass now. Merged to main.");
  assert.equal(materialOf("plain text"), "plain text");
  assert.ok(c.includes(RELAY_MARK));
});

test("templates: rotate, stay under their length limits, keep their meaning, and never open with a banned opener", () => {
  const LONG = "x".repeat(400);
  for (const [key, list] of Object.entries(TEMPLATES)) {
    const empty = list.map((f) => f({ label: "", msg: "", q: "", title: "", who: "", n: 2, list: "" }));
    // Variants are distinct and rotate.
    if (list.length > 1) assert.equal(new Set(empty).size, list.length, key);
    for (let v = 0; v < list.length * 2; v++) assert.equal(say(key, v, { label: "run a command" }), list[v % list.length]({ label: "run a command" }));
    for (const t of empty) {
      assert.ok(t.length <= TEMPLATE_MAX_CHARS, `${key}: ${t.length} > ${TEMPLATE_MAX_CHARS}: ${t}`);
      assert.ok(!isBannedOpener(t), `${key}: ${t}`);
      assert.doesNotMatch(t, /Claude Code|Update:|—|!/, `${key}: plain spoken words, no dash or exclamation: ${t}`);
    }
    // A long slot still fits one append once the caller clips it.
    for (const f of list) assert.ok(estTokens(fitTokens(f({ label: LONG, msg: LONG, q: LONG, title: LONG, who: "Slack", n: 4, list: LONG }))) <= MAX_APPEND_TOKENS);
  }
  // Semantics that must survive every variant.
  for (let v = 0; v < 3; v++) {
    assert.match(say("permission", v, { label: "edit hooks.json" }), /approval.*terminal|terminal.*approval/);
    assert.match(say("permission", v, { label: "edit hooks.json" }), /edit hooks\.json/);
    assert.match(say("questionOne", v, { q: "Which one?" }), /Which one\?.*terminal/);
    assert.match(say("plan", v, { title: "Ship it" }), /approval.*terminal|terminal.*approval/);
    assert.match(say("idle", v), /terminal/);
    assert.match(say("cantHear", v), /mic in the voice window/);
  }
});

test("templates: the same opener is not used twice in a row, per notice kind", () => {
  for (const key of Object.keys(TEMPLATES)) {
    const list = TEMPLATES[key];
    if (list.length < 2) continue;
    const said = [0, 1, 2].slice(0, list.length).map((v) => say(key, v, { label: "run a shell command", q: "Which layout? Options: A or B.", title: "Ship it", who: "Slack", msg: "Pick a channel.", n: 2, list: "First: A? Second: B?" }));
    const openers = said.map((t) => openerKey(t) || t.split(/\s+/).slice(0, 2).join(" ").toLowerCase());
    assert.equal(new Set(openers).size, openers.length, `${key}: ${JSON.stringify(said)}`);
  }
});

test("Narrator rotates approvals and idle lines; a session never repeats the same line back to back", async () => {
  const clock = createFakeClock();
  const out = [];
  const n = new Narrator({ clock, policy: () => "milestones", emit: (a) => out.push(a) });
  n.onPermission("Bash", { command: "npm test" });
  await clock.advance(11000);
  n.onPermission("Bash", { command: "npm test" });
  await clock.advance(11000);
  n.onPermission("Edit", { file_path: "/a/b.js" });
  const said = out.filter((a) => a.kind === "commentary").map((a) => a.content);
  assert.deepEqual(said, [
    "Claude needs your approval in the terminal to run a shell command.",
    "Heads up, Claude's waiting for your approval in the terminal to run a shell command.",
    "Claude wants to edit b.js. It needs your approval in the terminal.",
  ]);
  for (let i = 1; i < said.length; i++) assert.notEqual(openerKey(said[i]), openerKey(said[i - 1]));
});

test("cant-hear: rotating variants, each said as given", () => {
  assert.equal(CANT_HEAR_LINES.length, 3);
  assert.equal(new Set(CANT_HEAR_LINES).size, 3);
  for (let v = 0; v < 3; v++) assert.equal(cantHearInstruction(v), `Say only "${CANT_HEAR_LINES[v]}" Then stop and listen.`);
  assert.equal(cantHearInstruction(), cantHearInstruction(0));
});

test("Rotation counts per key", () => {
  const r = new Rotation();
  assert.deepEqual([r.next("a"), r.next("a"), r.next("b"), r.next("a")], [0, 1, 0, 2]);
});
