// Deterministic clock for daemon tests: {now, setTimeout, clearTimeout,
// setInterval, clearInterval} plus advance(ms), which runs due timers in order
// and lets pending promises settle between them.

export async function flushMicrotasks(rounds = 6) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

export function createFakeClock(start = new Date(2026, 8, 23, 12, 0, 0).getTime()) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  const add = (fn, ms, every) => {
    const id = ++seq;
    timers.set(id, { id, at: now + Math.max(0, Number(ms) || 0), fn, every });
    return id;
  };
  const clock = {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, 0),
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: (fn, ms) => add(fn, ms, Math.max(1, Number(ms) || 1)),
    clearInterval: (id) => { timers.delete(id); },
    pending: () => timers.size,
    /** Advance time by ms, firing every timer that falls due (in time order). */
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flushMicrotasks();
        let next = null;
        for (const t of timers.values()) {
          if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
        }
        if (!next) break;
        now = next.at;
        if (next.every) next.at += next.every;
        else timers.delete(next.id);
        next.fn();
      }
      now = end;
      await flushMicrotasks();
    },
    /** Jump the wall clock without firing timers (e.g. to simulate a date change). */
    set(ms) { now = ms; },
  };
  return clock;
}
