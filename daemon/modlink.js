// The mod link (SPEC §6.21): the daemon side of Sotto's Claude Code mod
// (hooks/sotto-mod.mjs, CLI >= 2.1.287). Pure logic over an injected clock;
// voice.js wires it to the owner, http.js to /mod/*.
//
// Downlink: the mod long-polls GET /mod/poll. Voice messages wait in a
// seq-numbered outbox; a poll returns every item after the seq the mod says it
// has, and a parked poll is answered the moment an item arrives. Delivery is
// at least once: an item stays in the outbox until the mod's receipt for it
// arrives, so a new mod instance (a hot reload) is offered it again, and the
// mod drops a msg_id it has already handled.
//
// Uplink: the mod POSTs /mod/events in seq-numbered batches: the classic
// hook payloads, turn start/complete and its receipts, in the order they
// happened. A seq at or below the last one accepted is a retry and is skipped.
//
// Liveness: the poll is the heartbeat. $.http.fetch has a hard 30 s cap
// (measured on CLI 2.1.287: "no complete answer within 30000ms", not
// configurable, not cancellable), so a parked poll is answered empty after
// POLL_HOLD_MS. A mod not seen for LOST_MS while no poll is parked, or an
// item it did not take within TAKE_MS, ends the link: the owner falls back to
// the classic shell hooks and the courier (SPEC §6.9.2) at once.
export const POLL_HOLD_MS = 20_000;
export const LOST_MS = 30_000;
export const TAKE_MS = 4_000;
const MAX_OUTBOX = 200;
const MAX_BATCH = 500;

export class ModLink {
  /**
   * @param {object} o
   * @param {object} o.clock   {now, setTimeout, clearTimeout}
   * @param {object} [o.log]
   * @param {Function} [o.onLost] (reason) the link ended without a release
   */
  constructor({ clock, log, onLost, holdMs = POLL_HOLD_MS, lostMs = LOST_MS, takeMs = TAKE_MS } = {}) {
    this.clock = clock;
    this.log = log || { info() {}, warn() {}, debug() {} };
    this.onLost = onLost || (() => {});
    this.holdMs = holdMs;
    this.lostMs = lostMs;
    this.takeMs = takeMs;
    this.link = null; // {instance, cli, sessionId, since, lastSeenAt, inSeq}
    this.outbox = []; // {seq, kind, msg_id, text, priority, submit_only, takenAt}
    this.outSeq = 0;
    this.waiters = new Set(); // {after, resolve, timer}
    this.pending = new Map(); // msg_id → {resolve, timer}
    this.counters = { sent: 0, taken: 0, not_taken: 0, receipts: 0, events: 0, dup_events: 0, links: 0, lost: 0 };
    this.lastLost = null; // {reason, at}
    // The voice's state for the mod's terminal UI (status line, band; §6.21):
    // the latest only, versioned; a poll whose `sv` is older gets it at once.
    this.uiState = null;
    this.stateVer = 0;
  }

  /** New UI state for the mod; answered to parked polls at once when it changed. */
  setState(state) {
    const key = JSON.stringify(state ?? null);
    if (key === this.stateKey) return false;
    this.stateKey = key;
    this.uiState = state ?? null;
    this.stateVer++;
    this.wake();
    return true;
  }

  get linked() { return !!this.link; }

  /** The mod of the owner session says hello (voice.js checked it is the owner's). */
  hello({ instance, cli = null, sessionId = null } = {}) {
    const now = this.clock.now();
    if (this.link && this.link.instance !== instance) {
      // A new instance of the same session's mod (a hot reload, /reload-plugins):
      // the old one's parked poll is told to go away, its unreceipted items are
      // offered again below.
      this.answerWaiters(() => ({ status: 410, body: { error: { code: "replaced" } } }));
    }
    const same = this.link && this.link.instance === instance;
    this.link = { instance, cli, sessionId, since: same ? this.link.since : now, lastSeenAt: now, inSeq: same ? this.link.inSeq : 0 };
    if (!same) this.counters.links++;
    // Everything not yet receipted is (re)offered: the mod dedupes by msg_id.
    const first = this.outbox.length ? this.outbox[0].seq - 1 : this.outSeq;
    for (const it of this.outbox) it.takenAt = 0;
    return { after: first };
  }

  /** Is `instance` the linked one? */
  isLinked(instance) { return !!this.link && typeof instance === "string" && this.link.instance === instance; }

  /**
   * GET /mod/poll. Resolves {status, body}: the items after `after` at once,
   * else after the first new item or holdMs with none. `onClose` registration
   * lets the HTTP layer drop a parked poll whose connection went away.
   */
  poll({ instance, after = 0, sv = null } = {}, onClose) {
    if (!this.isLinked(instance)) return Promise.resolve({ status: 410, body: { error: { code: "not_linked" } } });
    this.link.lastSeenAt = this.clock.now();
    const a = Number.isFinite(Number(after)) ? Number(after) : 0;
    // sv absent: a mod that draws nothing (older); never answered for state.
    const v = sv === null || sv === undefined || sv === "" ? null : Number(sv);
    const ready = this.ready(a);
    if (ready.length || this.stateNews(v)) return Promise.resolve(this.take(ready, a, v));
    return new Promise((resolve) => {
      const w = { after: a, sv: v, resolve: null, timer: null };
      const done = (r) => {
        if (!this.waiters.delete(w)) return;
        this.clock.clearTimeout(w.timer);
        if (this.link) this.link.lastSeenAt = this.clock.now();
        resolve(r);
      };
      w.resolve = done;
      w.timer = this.clock.setTimeout(() => done(this.take([], a, v)), this.holdMs);
      this.waiters.add(w);
      onClose?.(() => done(null));
    });
  }

  get polling() { return this.waiters.size > 0; }

  ready(after) { return this.outbox.filter((it) => it.seq > after); }

  stateNews(sv) { return sv !== null && Number.isFinite(sv) && sv < this.stateVer; }

  take(items, after, sv = null) {
    const now = this.clock.now();
    for (const it of items) {
      if (!it.takenAt) {
        it.takenAt = now;
        this.counters.taken++;
        const p = this.pending.get(it.msg_id);
        if (p) { this.pending.delete(it.msg_id); this.clock.clearTimeout(p.timer); p.resolve({ ok: true, via: "mod", how: "taken" }); }
      }
    }
    const out = items.map(({ seq, kind, msg_id, text, priority, submit_only }) => ({ seq, kind, msg_id, text, priority, ...(submit_only ? { submit_only: true } : {}) }));
    const body = { items: out, seq: Math.max(after, ...items.map((i) => i.seq)) };
    if (sv !== null && Number.isFinite(sv)) { body.sv = this.stateVer; if (this.stateNews(sv)) body.state = this.uiState; }
    return { status: 200, body };
  }

  /** Answer every parked poll that has something new. */
  wake() {
    for (const w of [...this.waiters]) {
      const ready = this.ready(w.after);
      if (ready.length || this.stateNews(w.sv)) w.resolve(this.take(ready, w.after, w.sv));
    }
  }

  answerWaiters(fn) { for (const w of [...this.waiters]) w.resolve(fn(w)); }

  /**
   * Hand a voice message to the mod. → {ok:true, via:"mod", how:"taken"} once a
   * poll carried it (the courier's rule: taken means it will be put in), or
   * {ok:false, code, fallback:true} when no mod took it within takeMs: the
   * caller then sends it the classic way, with no double send.
   */
  send({ content, msgId, priority = "next", submitOnly = false } = {}) {
    if (!this.link) return Promise.resolve({ ok: false, code: "no_mod", fallback: true });
    if (typeof content !== "string" || !content) return Promise.resolve({ ok: false, code: "empty", fallback: false });
    const id = typeof msgId === "string" && msgId ? msgId : `mod-${this.outSeq + 1}`;
    if (this.outbox.length >= MAX_OUTBOX) this.outbox.shift();
    const item = { seq: ++this.outSeq, kind: "inject", msg_id: id, text: content, priority: priority === "later" ? "later" : "next", submit_only: !!submitOnly, takenAt: 0 };
    this.outbox.push(item);
    this.counters.sent++;
    return new Promise((resolve) => {
      const timer = this.clock.setTimeout(() => {
        if (!this.pending.delete(id)) return;
        // Not taken: no mod is polling. Withdraw it (the caller sends it the
        // classic way) and end the link, so the next message and the hooks
        // do not wait on a mod that is gone.
        this.outbox = this.outbox.filter((it) => it !== item);
        this.counters.not_taken++;
        resolve({ ok: false, code: "not_taken", fallback: true });
        this.end("not_taken");
      }, this.takeMs);
      this.pending.set(id, { resolve, timer });
      this.wake();
    });
  }

  /**
   * POST /mod/events. → {ok:true, fresh:[events in seq order], acked} or
   * {ok:false, status, code}. Receipts drop their item from the outbox.
   */
  accept({ instance, events } = {}) {
    if (!this.isLinked(instance)) return { ok: false, status: 410, code: "not_linked" };
    this.link.lastSeenAt = this.clock.now();
    const list = Array.isArray(events) ? events.slice(0, MAX_BATCH) : [];
    const fresh = [];
    for (const ev of list.filter((e) => e && Number.isInteger(e.seq)).sort((a, b) => a.seq - b.seq)) {
      if (ev.seq <= this.link.inSeq) { this.counters.dup_events++; continue; }
      this.link.inSeq = ev.seq;
      fresh.push(ev);
      if (ev.kind === "receipt") {
        this.counters.receipts++;
        if (typeof ev.msg_id === "string") this.outbox = this.outbox.filter((it) => it.msg_id !== ev.msg_id);
      }
    }
    this.counters.events += fresh.length;
    return { ok: true, fresh, acked: this.link.inSeq };
  }

  /** Periodic check: a mod gone quiet ends the link. */
  check() {
    if (!this.link || this.polling) return;
    if (this.clock.now() - this.link.lastSeenAt > this.lostMs) this.end("heartbeat");
  }

  /** The link ends without the owner going away: fall back to classic. */
  end(reason) {
    if (!this.link) return;
    const l = this.link;
    this.link = null;
    this.counters.lost++;
    this.lastLost = { reason, at: this.clock.now() };
    this.answerWaiters(() => ({ status: 410, body: { error: { code: reason } } }));
    this.failPending("link_lost");
    // Items it never took go the classic way through failPending; taken ones
    // stay with the mod that took them.
    this.outbox = [];
    this.log.warn("modlink.lost", { reason, instance: l.instance, ms: this.clock.now() - l.since });
    this.onLost(reason);
  }

  /** Voice off or a new owner: tell the mod to stop, drop everything. */
  release(reason = "off") {
    this.answerWaiters(() => ({ status: 200, body: { items: [], release: reason } }));
    this.failPending(reason);
    this.outbox = [];
    if (this.link) this.log.info("modlink.release", { reason, instance: this.link.instance });
    this.link = null;
  }

  failPending(code) {
    for (const [, p] of this.pending) { this.clock.clearTimeout(p.timer); p.resolve({ ok: false, code, fallback: true }); }
    this.pending.clear();
  }

  status() {
    const now = this.clock.now();
    const l = this.link;
    return {
      mode: l ? "mod" : "classic",
      ...(l ? { instance: l.instance, cli: l.cli, since_ms: now - l.since, last_seen_ms: now - l.lastSeenAt, polling: this.polling, in_seq: l.inSeq } : {}),
      outbox: this.outbox.length,
      ...(this.lastLost ? { last_lost: { reason: this.lastLost.reason, ago_ms: now - this.lastLost.at } } : {}),
      counters: { ...this.counters },
    };
  }

  dispose() {
    this.release("shutdown");
  }
}
