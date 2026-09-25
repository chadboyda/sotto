// VOICE_INFO (daemon/config.js): every voice has a short description for the
// pickers, and its copies (bin/sotto, the README table) match it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VOICES, VOICE_INFO, VOICE_PRESENTATIONS } from "../../daemon/config.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("every voice has info: tone, presentation, accent and a description of 60 characters or fewer", () => {
  assert.deepEqual(Object.keys(VOICE_INFO).sort(), [...VOICES].sort(), "one entry per voice, no extras");
  for (const v of VOICES) {
    const i = VOICE_INFO[v];
    assert.ok(i, `${v} has info`);
    for (const k of ["tone", "presentation", "accent", "description"]) assert.ok(typeof i[k] === "string" && i[k].trim(), `${v}.${k}`);
    assert.ok(VOICE_PRESENTATIONS.includes(i.presentation), `${v} presentation ${i.presentation}`);
    assert.ok(i.description.length <= 60, `${v}: ${i.description.length} characters`);
    assert.ok(i.description.startsWith(`${i.tone} · `) && i.description.endsWith(` · ${i.accent}`), `${v} description format`);
    assert.doesNotMatch(i.description, /gemini|hz|\d/i, `${v}: public copy, no sources or measurements`);
  }
});

test("OpenAI's voice table: presentation and accent where it lists the voice", () => {
  const doc = {
    quartz: ["feminine", "Australian"], ripple: ["masculine", "Australian"], vesper: ["masculine", "British"],
    willow: ["feminine", "Irish"], stone: ["masculine", "Irish"], gleam: ["feminine", "North American"],
    meridian: ["masculine", "North American"], bossa: ["feminine", "Brazilian"], tempo: ["masculine", "Brazilian"],
    beacon: ["masculine", "Filipino"], delta: ["feminine", "Southern US"], cinder: ["masculine", "Southern US"],
  };
  for (const [v, [pres, accent]] of Object.entries(doc)) {
    assert.equal(VOICE_INFO[v].presentation, pres, `${v} presentation`);
    assert.equal(VOICE_INFO[v].accent, accent, `${v} accent`);
  }
});

test("bin/sotto mirrors every description", () => {
  const src = readFileSync(`${root}bin/sotto`, "utf8");
  for (const v of VOICES) {
    const m = src.match(new RegExp(`^\\s+${v}\\)\\s+printf '%s' "([^"]*)" ;;$`, "m"));
    assert.ok(m, `bin/sotto has ${v}`);
    assert.equal(m[1], VOICE_INFO[v].description, `bin/sotto ${v}`);
  }
});

test("the README voice table lists every voice with its info", () => {
  const md = readFileSync(`${root}README.md`, "utf8");
  for (const v of VOICES) {
    const [tone, presentation, accent] = VOICE_INFO[v].description.split(" · ");
    const row = `| \`${v}\` | ${tone} | ${presentation} | ${accent} |`;
    assert.ok(md.includes(row), `README row for ${v}: ${row}`);
  }
});
