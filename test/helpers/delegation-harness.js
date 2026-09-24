// DelegationEngine with recording fake effects, shared by the delegation tests.
import { DelegationEngine } from "../../daemon/delegation.js";
import { Transcript } from "../../daemon/transcript.js";
import { newCounters } from "../../daemon/voice.js";
import { createFakeClock } from "./fake-clock.js";

/**
 * @param {object} [opts]
 * @param {string|null} [opts.live]  when given, the engine gets a liveId() effect
 *   returning `h.live` (tests change h.live to simulate a new Live session)
 */
export function delegationHarness(opts = {}) {
  const clock = createFakeClock();
  const transcript = new Transcript({ clock });
  const h = {
    clock, transcript, appends: [], routes: [], sends: [], pendingCreated: 0, pendingRemoved: 0,
    liveness: 0, lastError: null, notices: [], counters: newCounters(), inboxResult: { ok: true },
    live: opts.live, absorbedFn: null,
  };
  h.engine = new DelegationEngine({
    clock, transcript,
    effects: {
      inboxSend: async (m) => { h.sends.push(m); return h.inboxResult; },
      append: (kind, content, id) => h.appends.push({ kind, content, id }),
      route: (source, payload) => h.routes.push({ source, ...payload }),
      createPendingContext: () => h.pendingCreated++,
      removePendingContext: () => h.pendingRemoved++,
      setLastError: (code) => { h.lastError = code; },
      notice: (level, code) => h.notices.push(code),
      checkLiveness: () => h.liveness++,
      project: () => "proj",
      ownerSocket: () => "/tmp/x.sock",
      counters: h.counters,
      ...(opts.live !== undefined ? { liveId: () => h.live } : {}),
      // Transcript absorption check: null (unreadable) unless a test sets h.absorbedFn.
      absorbed: (path, contents) => (h.absorbedFn ? h.absorbedFn(path, contents) : null),
    },
  });
  /** Speak words as 200 ms user fragments starting at session time `startMs`. */
  h.say = (text, startMs) => {
    let t = startMs;
    for (const w of text.split(" ")) { transcript.add("user", " " + w, t, t + 200); t += 200; }
    return t;
  };
  h.create = (id, offset_ms) => h.engine.onCreated({ type: "session.delegation.created", offset_ms, delegation: { id, type: "delegation", target: "client" } });
  return h;
}

/** Speak `words`, create delegation `id` and let it settle and send. */
export async function sentRecord(h, id, words, at) {
  h.say(words, at);
  const r = h.create(id, at + 200);
  await h.clock.advance(700);
  return r;
}
