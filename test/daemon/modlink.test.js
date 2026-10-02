// ModLink (SPEC §6.21): long-poll outbox, take/fallback, receipts, ordered
// uplink with seq dedupe, heartbeat loss, release.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ModLink, POLL_HOLD_MS, LOST_MS, TAKE_MS } from "../../daemon/modlink.js";
import { createFakeClock, flushMicrotasks } from "../helpers/fake-clock.js";
import { createMemoryLogger } from "../../daemon/log.js";

function mk() {
  const clock = createFakeClock();
  const log = createMemoryLogger();
  const lost = [];
  const m = new ModLink({ clock, log, onLost: (r) => lost.push(r) });
  return { clock, log, lost, m };
}

describe("ModLink", () => {
  test("the fetch cap bounds the hold: holds stay at or under 20 s, well inside $.http.fetch's 30 s", () => {
    assert.ok(POLL_HOLD_MS <= 20_000);
    assert.ok(LOST_MS > POLL_HOLD_MS);
    assert.ok(TAKE_MS < POLL_HOLD_MS);
  });

  test("without a link a send falls back at once and a poll is refused", async () => {
    const { m } = mk();
    assert.deepEqual(await m.send({ content: "x", msgId: "a" }), { ok: false, code: "no_mod", fallback: true });
    assert.equal((await m.poll({ instance: "i1", after: 0 })).status, 410);
  });

  test("a parked poll is answered the moment a message arrives; the send resolves as taken", async () => {
    const { m, clock } = mk();
    m.hello({ instance: "i1" });
    const p = m.poll({ instance: "i1", after: 0 });
    await flushMicrotasks();
    assert.equal(m.polling, true);
    const s = m.send({ content: "[sotto voice] hi", msgId: "clv-1-1" });
    const r = await p;
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 1);
    assert.deepEqual(r.body.items[0], { seq: 1, kind: "inject", msg_id: "clv-1-1", text: "[sotto voice] hi", priority: "next" });
    assert.equal(r.body.seq, 1);
    assert.deepEqual(await s, { ok: true, via: "mod", how: "taken" });
    await clock.advance(TAKE_MS + 10);
    assert.equal(m.linked, true, "a taken message does not end the link");
  });

  test("an empty hold is answered after POLL_HOLD_MS with no items", async () => {
    const { m, clock } = mk();
    m.hello({ instance: "i1" });
    const p = m.poll({ instance: "i1", after: 0 });
    await clock.advance(POLL_HOLD_MS);
    assert.deepEqual(await p, { status: 200, body: { items: [], seq: 0 } });
    assert.equal(m.polling, false);
  });

  test("not taken within TAKE_MS: withdrawn, fallback, and the link ends (classic at once)", async () => {
    const { m, clock, lost } = mk();
    m.hello({ instance: "i1" });
    const s = m.send({ content: "x", msgId: "a" });
    await clock.advance(TAKE_MS);
    assert.deepEqual(await s, { ok: false, code: "not_taken", fallback: true });
    assert.equal(m.linked, false);
    assert.deepEqual(lost, ["not_taken"]);
    assert.equal(m.outbox.length, 0);
  });

  test("at least once: an unreceipted item is offered again to a new instance, never to the same poll twice", async () => {
    const { m } = mk();
    m.hello({ instance: "i1" });
    void m.send({ content: "x", msgId: "a" });
    const r1 = await m.poll({ instance: "i1", after: 0 });
    assert.equal(r1.body.items.length, 1);
    // Same instance, after the seq it got: nothing new (parks).
    let answered = false;
    m.poll({ instance: "i1", after: r1.body.seq }).then(() => { answered = true; });
    await flushMicrotasks();
    assert.equal(answered, false);
    // A hot reload: the new instance's hello re-offers it; the old poll is told to go.
    const h = m.hello({ instance: "i2" });
    await flushMicrotasks();
    assert.equal(answered, true);
    const r2 = await m.poll({ instance: "i2", after: h.after });
    assert.deepEqual(r2.body.items.map((i) => i.msg_id), ["a"]);
    // A receipt drops it for good.
    m.accept({ instance: "i2", events: [{ seq: 1, kind: "receipt", msg_id: "a", how: "submitted" }] });
    const h3 = m.hello({ instance: "i3" });
    assert.equal(m.ready(h3.after).length, 0);
  });

  test("uplink: events in seq order, retries skipped, receipts counted", () => {
    const { m } = mk();
    m.hello({ instance: "i1" });
    const r = m.accept({ instance: "i1", events: [{ seq: 2, kind: "classic", event: "Stop" }, { seq: 1, kind: "classic", event: "UserPromptSubmit" }] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.fresh.map((e) => e.seq), [1, 2]);
    assert.equal(r.acked, 2);
    const again = m.accept({ instance: "i1", events: [{ seq: 2, kind: "classic", event: "Stop" }, { seq: 3, kind: "receipt", msg_id: "x", how: "appended" }] });
    assert.deepEqual(again.fresh.map((e) => e.seq), [3]);
    assert.equal(m.counters.dup_events, 1);
    assert.equal(m.counters.receipts, 1);
    assert.equal(m.accept({ instance: "other", events: [] }).status, 410);
  });

  test("heartbeat: no poll parked and none for LOST_MS ends the link", async () => {
    const { m, clock, lost } = mk();
    m.hello({ instance: "i1" });
    const p = m.poll({ instance: "i1", after: 0 });
    await clock.advance(POLL_HOLD_MS); // answered empty; the mod would poll again
    await p;
    m.check();
    assert.equal(m.linked, true);
    await clock.advance(LOST_MS + 1);
    m.check();
    assert.equal(m.linked, false);
    assert.deepEqual(lost, ["heartbeat"]);
  });

  test("a parked poll counts as alive however long ago it started", async () => {
    const { m, clock } = mk();
    const lm = new ModLink({ clock, holdMs: 10 * LOST_MS, onLost: () => {} });
    lm.hello({ instance: "i1" });
    void lm.poll({ instance: "i1", after: 0 });
    await clock.advance(2 * LOST_MS);
    lm.check();
    assert.equal(lm.linked, true);
    void m;
  });

  test("a closed poll connection is dropped", async () => {
    const { m } = mk();
    m.hello({ instance: "i1" });
    let close;
    const p = m.poll({ instance: "i1", after: 0 }, (fn) => { close = fn; });
    close();
    assert.equal(await p, null);
    assert.equal(m.polling, false);
  });

  test("release answers the parked poll with release and fails pending sends over to classic", async () => {
    const { m, lost } = mk();
    m.hello({ instance: "i1" });
    const p = m.poll({ instance: "i1", after: 0 });
    await flushMicrotasks();
    m.outbox.push({ seq: 99, kind: "inject", msg_id: "z", text: "t", priority: "next", takenAt: 0 }); // not woken
    const s = m.send({ content: "x", msgId: "b" });
    // the send woke the poll; a second message waits untaken
    await p;
    const s2 = m.send({ content: "y", msgId: "c" });
    m.release("off");
    assert.deepEqual(await s2, { ok: false, code: "off", fallback: true });
    assert.equal((await s).ok, true);
    assert.equal(m.linked, false);
    assert.deepEqual(lost, [], "a release is not a loss");
  });

  test("status reports the mode and counters", () => {
    const { m } = mk();
    assert.equal(m.status().mode, "classic");
    m.hello({ instance: "i1", cli: "2.1.287" });
    const st = m.status();
    assert.equal(st.mode, "mod");
    assert.equal(st.cli, "2.1.287");
    assert.equal(st.counters.links, 1);
  });
});
