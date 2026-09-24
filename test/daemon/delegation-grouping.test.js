// Regression: a request spoken with pauses must reach Claude whole (SPEC-DEVIATIONS,
// "Utterance grouping"). The fixture is the real delta stream from a live session
// (2026-09-23) where the old 20 s lookback sent only "skill, um. Give you a good...".
import { test } from "node:test";
import assert from "node:assert/strict";
import { delegationHarness as harness, sentRecord } from "../helpers/delegation-harness.js";
import { collectRequest, REQUEST_MAX_CHARS } from "../../daemon/delegation.js";

// [delta, start_ms, end_ms, wall ms since the first delta]
const LIVE = [[" Cool", 106600, 106800, 0], [". What", 106800, 107000, 132], [" else", 107400, 107600, 737], [" should", 108000, 108200, 1384], [" we", 108200, 108400, 1536], [" do", 108600, 108800, 1929], [" to", 109000, 109200, 2343], [" ", 110000, 110200, 3361], ["to", 110200, 110400, 3596], [" make it", 110400, 110600, 3724], [" better", 110800, 111000, 4133], ["? Also", 112000, 112200, 5411], [", can we", 112200, 112400, 5537], [" update", 112800, 113000, 6167], [" the", 113000, 113200, 6322], [" UI a", 113400, 113600, 6731], [" bit", 113800, 114000, 7229], ["? Like can", 114000, 114200, 7376], [" we", 114200, 114400, 7564], [" use", 114600, 114800, 7947], [" um", 115000, 115200, 8323], [" the", 116200, 116400, 9519], [" impeccable", 117400, 117600, 10744], [". Design", 118400, 118600, 11729], [" skill", 119000, 119200, 12332], [", um", 119600, 119800, 12990], [". Give", 119800, 120000, 13186], [" you a", 120000, 120200, 13354], [" good", 120400, 120600, 13724], [" design", 120800, 121000, 14128], [" system", 121200, 121400, 14603], [", maybe", 121400, 121600, 14732], [" generate a", 121800, 122000, 15168], [" few", 122000, 122200, 15328], [" mockups", 122600, 122800, 15922], [" first", 123200, 123400, 16538], [" and", 123600, 123800, 16973], [" use", 123800, 124000, 17171], [" that", 124000, 124200, 17366], [" with", 124200, 124400, 17584], [" the", 124400, 124600, 17733], [" intent", 125000, 125200, 18327], [". um", 126400, 126600, 19732], [", UX", 126800, 127000, 20149], [" skill", 127200, 127400, 20578], [" to", 127400, 127600, 20732], [" improve", 128000, 128200, 21325], [" the", 129000, 129200, 22364], [" layout", 129200, 129400, 22578], [" here", 129400, 129600, 22844], [". Like some", 129600, 129800, 22987], [" of your", 129800, 130000, 23183], [" buttons", 130000, 130200, 23383], [" are", 130200, 130400, 23578], [" really", 130400, 130600, 23768], [" tight", 130600, 130800, 24001], [". Like", 130800, 131000, 24215], [" you... have", 131000, 131200, 24385], [" a", 131200, 131400, 24530], [" kind", 131600, 131800, 24987], [" of", 131800, 132000, 25141], [" ugly", 132200, 132400, 25550], [" like", 132600, 132800, 25999], [" AI", 132800, 133000, 26129], [" slop", 133200, 133400, 26576], [" beige", 133400, 133600, 26723], [" color", 133800, 134000, 27126], [". Like", 134200, 134400, 27596], [" how do", 134400, 134600, 27771], [" we", 134600, 134800, 27989], [" make", 134800, 135000, 28195], [" your", 135000, 135200, 28343], [" UI", 135400, 135600, 28735], [" much", 135800, 136000, 29172], [" better", 136000, 136200, 29400], [" where it", 136200, 136400, 29550], [" currently", 136800, 137000, 30161], [" is", 137200, 137400, 30550]];

/** Replay the live deltas with their real wall-clock spacing. */
async function replay(h, deltas = LIVE) {
  let wall = 0;
  for (const [d, s, e, at] of deltas) {
    await h.clock.advance(at - wall);
    wall = at;
    h.transcript.add("user", d, s, e);
  }
}

test("live regression: a paused request reaches Claude whole, from 'Cool' to 'where it currently is'", async () => {
  const h = harness();
  // The previous delegation (offset 68400) consumed speech through 66600.
  h.say("No, I want you to work from my active session", 58800);
  h.transcript.add("assistant", " Mm-hmm.", 63400, 63600);
  const first = h.create("item_1", 68400);
  await h.clock.advance(700);
  assert.equal(first.status, "sent");
  await h.clock.advance(30000);

  await replay(h);
  await h.clock.advance(32287 - 30550); // delegation.created arrived 1.7 s after "is"
  const rec = h.create("item_2", 138800);
  // The Live model's acknowledgement arrives on output_transcript while we settle.
  h.transcript.add("assistant", " Uh. Right. Yeah. I've asked Claude Code in your session to look at the current UI", 139000, 141000);
  await h.clock.advance(3000);

  assert.equal(rec.status, "sent");
  const content = h.sends[1].content;
  assert.ok(content.startsWith("[sotto voice] Cool. What else should we do"), content);
  assert.match(content, /make it better\? Also, can we update the UI a bit\?/);
  assert.match(content, /use um the impeccable\. Design skill/);
  assert.match(content, /with the intent\. um, UX skill to improve the layout here/);
  assert.ok(content.endsWith("how do we make your UI much better where it currently is"), content);
  assert.doesNotMatch(content, /No, I want you/, "speech already sent is not re-sent");
  assert.doesNotMatch(content, /asked Claude Code|Mm-hmm/, "assistant speech never leaks in");
  assert.doesNotMatch(content, /^\[sotto voice\] \.\.\./, "nothing was trimmed");
  // The Live model hears the whole request back too.
  assert.match(h.appends.at(-1).content, /Request sent to Claude Code: "Cool\. What else/);
});

test("pauses of several seconds and assistant backchannels between groups stay in one request", async () => {
  const h = harness();
  h.say("can we update the UI a bit", 0);
  await h.clock.advance(4000);
  h.transcript.add("assistant", " Mm-hmm.", 3000, 3300);
  h.say("use the impeccable design skill", 6000);
  await h.clock.advance(6000);
  h.say("and make the buttons less tight", 14000);
  await h.clock.advance(1500);
  const rec = h.create("item_1", 16000);
  await h.clock.advance(1000);
  assert.equal(rec.text, "can we update the UI a bit use the impeccable design skill and make the buttons less tight");
});

test("words spoken after delegation.created are included while the user keeps talking", async () => {
  const h = harness();
  h.say("please update the UI", 0);
  await h.clock.advance(1000);
  const rec = h.create("item_1", 1200);
  await h.clock.advance(500);
  h.say("with the impeccable skill", 1700); // resumes 500 ms after created
  await h.clock.advance(500);
  assert.equal(rec.status, "collecting");
  await h.clock.advance(600);
  assert.equal(rec.text, "please update the UI with the impeccable skill");
});

test("a request longer than the cap keeps the newest words and says it was trimmed", async () => {
  const h = harness();
  const logs = [];
  h.engine.log = { info: (ev, o) => logs.push({ ev, ...o }), debug() {}, warn() {} };
  const many = Array.from({ length: 600 }, (_, i) => `w${i}`).join(" ");
  h.say(many, 0);
  const rec = h.create("item_1", 120400);
  await h.clock.advance(1000);
  assert.ok(rec.text.startsWith("... "));
  assert.ok(rec.text.length <= REQUEST_MAX_CHARS + 4);
  assert.ok(rec.text.endsWith("w598 w599"));
  const trim = logs.find((l) => l.ev === "delegation.request");
  assert.ok(trim && trim.trimmed_chars > 0, "trim is logged");
});

test("an echo line inside a long request is dropped and not re-sent later", async () => {
  const h = harness();
  h.transcript.add("assistant", " I'll check the current git branch for you", 0, 1500);
  h.say("I'll check the current git branch", 1600); // mic picked the assistant up
  await h.clock.advance(20000);
  h.say("now also run the tests please", 20000);
  const rec = h.create("item_1", 21600);
  await h.clock.advance(1000);
  assert.equal(rec.text, "now also run the tests please");
  h.say("thanks", 30000);
  const b = h.create("item_2", 30400);
  await h.clock.advance(1000);
  assert.equal(b.text, "thanks");
});

test("collectRequest: two groups separated by a long pause are joined in order", () => {
  const h = harness();
  h.say("first group", 0);
  h.say("second group", 10000);
  const r = collectRequest(h.transcript, 0, 12000);
  assert.equal(r.text, "first group second group");
  assert.equal(r.consumedTo, 10400);
  assert.equal(r.trimmed, 0);
});

test("an older record whose words a newer one already took is superseded, not 'didn't catch'", async () => {
  const h = harness();
  const a = await sentRecord(h, "item_a", "first", 0);
  assert.equal(a.status, "sent");
  h.say("check the tests", 5000);
  const b = h.create("item_b", 5400);
  await h.clock.advance(100);
  h.say("and the lint", 5700);
  const c = h.create("item_c", 6100);
  await h.clock.advance(1500);
  assert.equal(b.status, "superseded");
  assert.equal(c.status, "sent");
  assert.equal(c.text, "check the tests and the lint");
  assert.equal(h.appends.filter((x) => /didn't catch/.test(x.content)).length, 0);
});
