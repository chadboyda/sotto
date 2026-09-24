#!/usr/bin/env node
// Regenerate the e2e fake-mic speech fixture with OpenAI TTS.
//
//   node test/e2e/make-fixture.mjs [text] [out.wav]
//
// Default output: test/fixtures/ask-files.wav (speech only, no padding; the
// smoke test adds the lead-in silence and the tail pad with ffmpeg at run time
// so the committed file stays small). Reads OPENAI_API_KEY from the env or the
// repo .env; never prints it. Costs a fraction of a cent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveApiKey } from "../../daemon/config.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
export const FIXTURE_TEXT = "Hey, can you ask Claude what files are in this project?";
export const FIXTURE_PATH = path.join(REPO, "test", "fixtures", "ask-files.wav");

const text = process.argv[2] || FIXTURE_TEXT;
const out = process.argv[3] || FIXTURE_PATH;
const key = resolveApiKey({ env: process.env, pluginRoot: REPO });
if (!key) {
  console.error("make-fixture: OPENAI_API_KEY not found (env or .env)");
  process.exit(2);
}

const res = await fetch("https://api.openai.com/v1/audio/speech", {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: text,
    instructions: "Speak casually and clearly, like a developer asking a colleague a quick question.",
    response_format: "wav",
  }),
});
if (!res.ok) {
  const body = await res.text().catch(() => "");
  console.error(`make-fixture: TTS failed ${res.status}: ${body.slice(0, 300)}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
console.log(`make-fixture: wrote ${path.relative(REPO, out)} (${fs.statSync(out).size} bytes)`);
