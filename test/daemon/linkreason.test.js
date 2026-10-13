// The band caption (SPEC §6.21 "Terminal UI") and why a session stays on the
// classic link (§6.21 "Link reason").
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHarness, SESSION, tmpDir } from "../helpers/daemon-harness.js";
import { captionOf } from "../../daemon/transcript.js";
import { parseVersion, compareVersions, transcriptVersion, staticLinkReason, notLinkedReason, linkSuffix, linkSentence, MOD_MIN_CLI, LINK_WAIT_MS } from "../../daemon/linkreason.js";

const SOCK = "/tmp/clv-owner-a.sock";
const line = (text, at, role = "assistant") => ({ role, text, at });

// ---- caption ----------------------------------------------------------------------

test("caption: a short line still streaming keeps the previous line; a sentence end or a pause completes it", () => {
  const prev = line(" Sure, I'll check.", 0);
  assert.equal(captionOf([prev, line(" Of", 5000)], 5100), "Sure, I'll check.");
  assert.equal(captionOf([line(" Of", 5000)], 5100), "", "no earlier line: nothing rather than a fragment");
  assert.equal(captionOf([prev, line(" Of course.", 5000)], 5100), "Of course.");
  assert.equal(captionOf([prev, line(" Of", 5000)], 6000), "Of", "quiet for the settle time: complete");
  assert.equal(captionOf([prev, line(" Let me hand this", 5000)], 5100), "Let me hand this", "a few words: shown while streaming");
  assert.equal(captionOf([prev, line(" hi there", 5000, "user")], 5100), "Sure, I'll check.", "user lines never caption");
});

async function linkedLive() {
  const h = await makeHarness();
  h.on(SESSION(SOCK));
  assert.equal(h.voice.modHello({ instance: "inst-1", socket: SOCK, cli: "2.1.287" }).status, 200);
  const ws = await h.goLive();
  return { h, ws };
}

test("band caption follows the voice's words: throttled pushes, the final caption is the whole line", async (t) => {
  const { h, ws } = await linkedLive();
  t.after(() => h.cleanup());
  const ml = h.voice.modlink;
  const delta = (d, s, e) => ws.receive({ type: "session.output_transcript.delta", delta: d, start_ms: s, end_ms: e });
  const v0 = ml.stateVer;
  delta("Of", 0, 200);
  assert.equal(ml.stateVer, v0, "not pushed per delta");
  await h.clock.advance(100);
  delta(" course.", 200, 600);
  await h.clock.advance(100);
  delta(" I'm handing it to Claude now.", 600, 2000);
  await h.clock.advance(100); // 300 ms after the first delta: one throttled push
  assert.equal(ml.stateVer, v0 + 1, "one push for three deltas within 300 ms");
  assert.equal(ml.uiState.said, "Of course. I'm handing it to Claude now.");
  await h.clock.advance(2000); // the settle push finds nothing new: deduped
  assert.equal(ml.uiState.said, "Of course. I'm handing it to Claude now.");
  assert.ok(ml.stateVer - v0 <= 2);

  // The regression: a push that lands on a first delta must not freeze it.
  delta(" Done", 5000, 5200);
  await h.clock.advance(300);
  assert.equal(ml.uiState.said, "Of course. I'm handing it to Claude now.", "a fragment keeps the previous line");
  delta(" with the first part.", 5200, 6000);
  await h.clock.advance(300);
  assert.equal(ml.uiState.said, "Done with the first part.");
});

// ---- link reason ------------------------------------------------------------------

test("version parsing and comparison", () => {
  assert.deepEqual(parseVersion("2.1.285"), [2, 1, 285]);
  assert.deepEqual(parseVersion("2.1.296 (Claude Code)"), [2, 1, 296]);
  assert.equal(parseVersion("2.1"), null);
  assert.equal(parseVersion("2.1.285.4"), null);
  assert.equal(parseVersion(null), null);
  assert.equal(compareVersions("2.1.285", MOD_MIN_CLI), -1);
  assert.equal(compareVersions("2.1.287", MOD_MIN_CLI), 0);
  assert.equal(compareVersions("2.1.1000", "2.1.287"), 1, "numeric, not lexical");
  assert.equal(compareVersions("3.0.0", "2.9.999"), 1);
  assert.equal(compareVersions("x", "2.1.287"), null);
});

test("transcript version: the last `version` field of the tail", (t) => {
  const dir = tmpDir("clv-tv-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, "s.jsonl");
  fs.writeFileSync(f, [
    JSON.stringify({ type: "user", version: "2.1.280" }),
    JSON.stringify({ type: "assistant", version: "2.1.285", message: { content: "a version 9.9.9 in prose" } }),
    JSON.stringify({ type: "summary" }),
  ].join("\n") + "\n");
  assert.equal(transcriptVersion(f), "2.1.285");
  assert.equal(transcriptVersion(path.join(dir, "missing.jsonl")), null);
  assert.equal(transcriptVersion(null), null);
});

test("each reason: suffix and sentence", () => {
  assert.equal(staticLinkReason({ cli: "2.1.296" }), null);
  assert.equal(staticLinkReason({}), null, "unknown version: wait for the mod");
  const old = staticLinkReason({ cli: "2.1.285" });
  assert.equal(old.code, "cli_too_old");
  assert.equal(linkSuffix(old), "link classic (Claude Code 2.1.285)");
  assert.equal(linkSentence(old), "sotto: this session runs Claude Code 2.1.285; mods need 2.1.287+, so voice uses the classic link. Restart it (claude respawn <id> for background sessions, or claude --resume) to get the mod.");
  const cls = staticLinkReason({ integration: "classic", cli: "2.1.285" });
  assert.equal(cls.code, "integration_classic", "the setting wins: a restart would not help");
  assert.equal(linkSuffix(cls), "link classic (integration=classic)");
  assert.match(linkSentence(cls), /integration=classic/);
  const nl = notLinkedReason({ cli: "2.1.296" });
  assert.equal(linkSuffix(nl), "link classic (mod not linked)");
  assert.match(linkSentence(nl), /try \/reload-plugins\.$/);
  assert.equal(linkSuffix(null), "link classic");
});

test("voice on in a 2.1.285 session: says why once, logs it, the status keeps a short suffix", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const session = SESSION(SOCK, { cli_version: "2.1.285" });
  const on = h.voice.control({ action: "on", session, config: { open_browser: false } });
  assert.match(on.message, /this session runs Claude Code 2\.1\.285; mods need 2\.1\.287\+/);
  assert.equal(h.log.find("owner.link_reason")[0].code, "cli_too_old");
  const st = h.voice.control({ action: "status", session });
  assert.match(st.message, /\| link classic \(Claude Code 2\.1\.285\)/);
  assert.doesNotMatch(st.message, /mods need/, "the sentence goes out once per session");
  assert.equal(h.voice.status().owner.link_reason, "cli_too_old");
});

test("the version falls back to the transcript; integration=classic is its own reason", async (t) => {
  const dir = tmpDir("clv-tv-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, "s.jsonl");
  fs.writeFileSync(f, JSON.stringify({ type: "user", version: "2.1.285" }) + "\n");
  const h = await makeHarness();
  t.after(() => h.cleanup());
  h.voice.control({ action: "on", session: SESSION(SOCK, { transcript_path: f }), config: { open_browser: false } });
  assert.equal(h.voice.owner.cli, "2.1.285");
  h.voice.control({ action: "off" });
  const on = h.voice.control({ action: "on", session: SESSION("/tmp/clv-owner-b.sock", { session_id: "sess-b", integration: "classic", cli_version: "2.1.296" }), config: { open_browser: false } });
  assert.match(on.message, /integration=classic/);
  assert.equal(h.log.find("owner.link_reason").at(-1).code, "integration_classic");
});

test("a new-enough CLI whose mod never says hello: after the wait, status says try /reload-plugins once", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const session = SESSION(SOCK, { cli_version: "2.1.296" });
  const on = h.voice.control({ action: "on", session, config: { open_browser: false } });
  assert.doesNotMatch(on.message, /classic/);
  assert.match(h.voice.control({ action: "status", session }).message, /\| link classic$/, "still waiting: no reason yet");
  await h.clock.advance(LINK_WAIT_MS);
  assert.equal(h.log.find("owner.link_reason")[0].code, "not_linked");
  const st = h.voice.control({ action: "status", session }).message;
  assert.match(st, /\| link classic \(mod not linked\)/);
  assert.match(st, /try \/reload-plugins\.$/);
  assert.doesNotMatch(h.voice.control({ action: "status", session }).message, /reload-plugins/);
});

test("a mod that links in time: no reason, no sentence", async (t) => {
  const h = await makeHarness();
  t.after(() => h.cleanup());
  const session = SESSION(SOCK, { cli_version: "2.1.296" });
  h.voice.control({ action: "on", session, config: { open_browser: false } });
  h.voice.modHello({ instance: "inst-1", socket: SOCK, cli: "2.1.296" });
  await h.clock.advance(LINK_WAIT_MS * 2);
  assert.equal(h.log.find("owner.link_reason").length, 0);
  assert.match(h.voice.control({ action: "status", session }).message, /\| link mod$/);
});
