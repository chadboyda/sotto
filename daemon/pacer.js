// Input pacer for the primary session (docs/NATIVE.md §2.3). Pure, clock-injected.
//
// The Live primary WebSocket needs input audio in real time, continuously:
// without it the session timeline stops and the model never speaks (measured
// in daemon/preview.js). The app's mic frames arrive over a loopback socket
// with jitter, and not at all while the app reconnects, so the pacer owns the
// cadence: every tick it sends what the wall clock says is due, taking app
// frames first and silence when the app is more than `fillAfterMs` behind.
// App frames that arrive after their slot was filled with silence are dropped
// (one per filled frame), so the session timeline never counts time twice.
//
// createPacer({ clock, frameMs = 20, fillAfterMs = 60, graceMs = 10_000, maxQueue = 10,
//               send(pcm), onGraceExpired(), isMuted() })
//   push(pcm)      an app mic frame (960 bytes); zeros when muted
//   start()/stop() tick every frameMs while a session is ready
//   appGone()/appBack()  app link lost/restored: keep filling silence up to graceMs, then onGraceExpired()
//   stats()        {sent_frames, fill_frames, dropped_late, dropped, queued, input_ms}
import { FRAME_BYTES, FRAME_MS } from "./native-proto.js";

export function createPacer({
  clock, frameMs = FRAME_MS, frameBytes = FRAME_BYTES, fillAfterMs = 60, graceMs = 10_000, maxQueue = 10,
  send, onGraceExpired = () => {}, isMuted = () => false,
}) {
  const silence = Buffer.alloc(frameBytes);
  let queue = [];
  let running = false;
  let t0 = 0;
  let sent = 0; // frames sent since start (the session timeline: sent × frameMs)
  let owed = 0; // silence frames sent in place of app frames still to come
  let timer = null;
  let graceTimer = null;
  const st = { sent_frames: 0, fill_frames: 0, dropped_late: 0, dropped: 0 };

  const out = (pcm) => {
    st.sent_frames++;
    sent++;
    try { send(isMuted() ? silence : pcm); } catch { /* the session decides */ }
  };

  function tick() {
    if (!running) return;
    const due = Math.floor((clock.now() - t0) / frameMs) + 1;
    while (sent < due) {
      if (queue.length) { out(queue.shift()); continue; }
      // Behind by more than fillAfterMs: fill the gap with silence now.
      if ((due - sent) * frameMs > fillAfterMs) {
        st.fill_frames++;
        owed++;
        out(silence);
        continue;
      }
      break; // the next app frame is probably on its way
    }
  }

  return {
    push(pcm) {
      if (!running) return; // no session: never buffered, never sent
      if (owed > 0) { owed--; st.dropped_late++; return; }
      queue.push(pcm);
      if (queue.length > maxQueue) { queue.shift(); st.dropped++; }
    },
    start() {
      if (running) return;
      running = true;
      t0 = clock.now();
      sent = 0;
      owed = 0;
      queue = [];
      tick();
      timer = clock.setInterval(tick, frameMs);
    },
    stop() {
      running = false;
      queue = [];
      owed = 0;
      if (timer !== null) { clock.clearInterval(timer); timer = null; }
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
