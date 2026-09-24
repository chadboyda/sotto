// AudioWorklet for echo measurement and the echo guard (SPEC §7.7). Runs on
// the audio thread, so it keeps working in a background or occluded window
// (requestAnimationFrame stops there). Input 0: the mic after the browser's
// echo cancellation (plus, in tests only, a simulated echo). Input 1: the
// remote voice (an unplayed clone of the remote track). Output: the mic, through
// the guard's gain (1 unless engaged). The DSP is web/echo.js (unit-tested).
//
// Messages in:  {engaged:boolean}, {model:{leakDb, lagMs}}, {reset:true}
// Messages out: {type:"stats", est, gate, engaged} every REPORT_MS.
import { createLeakEstimator, createEchoGate, meanSquare, BLOCK_QUANTA, classifyLeak } from "./echo.js";

const REPORT_MS = 500;

class SottoEcho extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.gate = createEchoGate({ sampleRate });
    this.gate.engaged = !!o.engaged;
    this.est = createLeakEstimator({ blockMs: (128 * BLOCK_QUANTA * 1000) / sampleRate, windowMs: o.windowMs || 6000 });
    this.acc = { mic: 0, ref: 0, k: 0 };
    this.sinceReport = 0;
    this.reportQ = Math.round((REPORT_MS / 1000) * sampleRate / 128);
    this.alive = true;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (typeof m.engaged === "boolean") this.gate.engaged = m.engaged;
      if (m.model) this.gate.setModel(m.model);
      if (m.reset) { this.est.reset(); this.gate.resetStats(); }
      if (m.stop) this.alive = false;
    };
  }

  process(inputs, outputs) {
    const mic = inputs[0] && inputs[0][0];
    const ref = inputs[1] && inputs[1][0];
    const out = outputs[0] && outputs[0][0];
    this.gate.process(mic || null, ref || null, out || null);
    this.acc.mic += meanSquare(mic);
    this.acc.ref += meanSquare(ref);
    if (++this.acc.k >= BLOCK_QUANTA) {
      this.est.push(this.acc.mic / this.acc.k, this.acc.ref / this.acc.k);
      this.acc.mic = this.acc.ref = 0;
      this.acc.k = 0;
    }
    if (++this.sinceReport >= this.reportQ) {
      this.sinceReport = 0;
      const est = this.est.estimate();
      // The guard follows the measured echo path whenever the measurement is
      // clearly echo (correlated, above the floor); otherwise it keeps the last one.
      if (est.valid && !est.belowFloor && est.corr >= 0.5) this.gate.setModel({ leakDb: est.leakDb, lagMs: est.lagMs });
      this.port.postMessage({ type: "stats", est, level: classifyLeak(est), gate: this.gate.stats(), engaged: this.gate.engaged });
      this.gate.resetStats();
    }
    return this.alive;
  }
}

registerProcessor("sotto-echo", SottoEcho);
