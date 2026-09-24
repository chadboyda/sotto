// Input pacer for the primary session (docs/NATIVE.md §2.3). Pure, clock-injected.
//
// The Live primary WebSocket needs input audio in real time, continuously:
// without it the session timeline stops and the model never speaks (measured
// in daemon/preview.js). The app's mic frames arrive over a loopback socket
// with jitter, and not at all while the app reconnects or rebuilds its
// capture, so the pacer owns the cadence: every tick it sends what the wall
// clock says is due, taking app frames first and silence when the app is more
// than `fillAfterMs` behind.
//
// Latency is bounded by trimming the queue, never by a debt of "late" frames.
// v0.3.1 dropped one incoming app frame per silence frame it had filled
// ("owed"), assuming the missing audio would arrive later in a burst. After a
// capture rebuild, a route change or a sleep/wake the missing audio never
// comes: the app simply resumes in real time. The debt then never cleared,
// the queue stayed empty, the lag stayed above fillAfterMs, and every later
// frame was dropped while silence was sent in its place (measured in a live
// log: +1499 fill_frames, +1500 dropped_late per 30 s, so the model heard
// nothing while the app's meters showed speech). Now a frame is only dropped
// when the queue holds more than `targetQueue` frames for `trimAfterMs` (a
// burst or an app clock running fast), or past the hard cap `maxQueue`.
//
// createPacer({ clock, frameMs = 20, fillAfterMs = 60, graceMs = 10_000, maxQueue = 10,
//               targetQueue = 3, trimAfterMs = 500, rateWindowMs = 5000, warnRatio = 0.05,
//               send(pcm), onGraceExpired(), isMuted(), onDropRate(info) })
//   push(pcm)      an app mic frame (960 bytes); zeros when muted
//   start()/stop() tick every frameMs while a session is ready
//   resync()       the app rebuilt its capture (route change): trim the queue to target now
//   appGone()/appBack()  app link lost/restored: keep filling silence up to graceMs, then onGraceExpired()
//   stats()        {sent_frames, fill_frames, dropped_late, dropped, queued, input_ms, drop_warnings}
//   onDropRate     called at most once per rateWindowMs when, over that window, more than
//                  warnRatio of the app's frames were dropped, or silence was substituted for
//                  more than warnRatio of the sent frames while the app was sending
import { FRAME_BYTES, FRAME_MS } from "./native-proto.js";

export function createPacer({
  clock, frameMs = FRAME_MS, frameBytes = FRAME_BYTES, fillAfterMs = 60, graceMs = 10_000, maxQueue = 10,
  targetQueue = 3, trimAfterMs = 500, rateWindowMs = 5000, warnRatio = 0.05,
  send, onGraceExpired = () => {}, isMuted = () => false, onDropRate = () => {},
}) {
  const silence = Buffer.alloc(frameBytes);
  let queue = [];
  let running = false;
  let t0 = 0;
  let sent = 0; // frames sent since start (the session timeline: sent × frameMs)
  let overSince = null; // when the queue last went above targetQueue
  let timer = null;
  let graceTimer = null;
  const st = { sent_frames: 0, fill_frames: 0, dropped_late: 0, dropped: 0, drop_warnings: 0 };
  let win = null; // {start, pushed, dropped, sent, fill}

  const newWindow = () => ({ start: clock.now(), pushed: 0, dropped: 0, sent: 0, fill: 0 });

  const out = (pcm) => {
    st.sent_frames++;
    sent++;
    if (win) win.sent++;
    try { send(isMuted() ? silence : pcm); } catch { /* the session decides */ }
  };

  function trim(n) {
    if (n <= 0) return;
    queue.splice(0, n);
    st.dropped_late += n;
    if (win) win.dropped += n;
  }

  function checkRate() {
    if (!win) return;
    const now = clock.now();
    if (now - win.start < rateWindowMs) return;
    const w = win;
    win = newWindow();
    if (w.pushed === 0) return; // the app sent nothing: grace/app-gone handles that
    const dropRatio = w.dropped / w.pushed;
    const fillRatio = w.sent ? w.fill / w.sent : 0;
    if (dropRatio > warnRatio || fillRatio > warnRatio) {
      st.drop_warnings++;
      try {
        onDropRate({
          window_ms: now - w.start, pushed: w.pushed, dropped: w.dropped, sent: w.sent, fill: w.fill,
          drop_ratio: Math.round(dropRatio * 1000) / 1000, fill_ratio: Math.round(fillRatio * 1000) / 1000,
        });
      } catch { /* logging only */ }
    }
  }

  function tick() {
    if (!running) return;
    const now = clock.now();
    const due = Math.floor((now - t0) / frameMs) + 1;
    while (sent < due) {
      if (queue.length) { out(queue.shift()); continue; }
      // Behind by more than fillAfterMs: fill the gap with silence now.
      if ((due - sent) * frameMs > fillAfterMs) {
        st.fill_frames++;
        if (win) win.fill++;
        out(silence);
        continue;
      }
      break; // the next app frame is probably on its way
    }
    // Bound the latency: a queue that stays above target (a burst after a stall,
    // or an app clock slightly fast) is trimmed back to target.
    if (queue.length > targetQueue) {
      if (overSince === null) overSince = now;
      else if (now - overSince >= trimAfterMs) { trim(queue.length - targetQueue); overSince = null; }
    } else overSince = null;
    checkRate();
  }

  return {
    push(pcm) {
      if (!running) return; // no session: never buffered, never sent
      if (win) win.pushed++;
      queue.push(pcm);
      if (queue.length > maxQueue) {
        queue.shift();
        st.dropped++;
        if (win) win.dropped++;
      }
    },
    start() {
      if (running) return;
      running = true;
      t0 = clock.now();
      sent = 0;
      overSince = null;
      queue = [];
      win = newWindow();
      tick();
      timer = clock.setInterval(tick, frameMs);
    },
    stop() {
      running = false;
      queue = [];
      overSince = null;
      win = null;
      if (timer !== null) { clock.clearInterval(timer); timer = null; }
    },
    /** The app rebuilt its capture (a new route): whatever is queued beyond target is stale. */
    resync() {
      if (!running) return;
      trim(queue.length - targetQueue);
      overSince = null;
    },
    get running() { return running; },
    appGone() {
      if (graceTimer !== null) return;
      graceTimer = clock.setTimeout(() => { graceTimer = null; onGraceExpired(); }, graceMs);
    },
    appBack() {
      if (graceTimer !== null) { clock.clearTimeout(graceTimer); graceTimer = null; }
    },
    get graceActive() { return graceTimer !== null; },
    /** For tests and the scheduler: run a tick now. */
    tick,
    stats() {
      return { ...st, queued: queue.length, input_ms: sent * frameMs };
    },
    dispose() {
      this.stop();
      this.appBack();
    },
  };
}
