// sotto: AudioWorklet that batches mic audio into fixed-size frames for
// the local wake detector (web/wake.js, SPEC §7.6).
//
// Why a worklet and not requestAnimationFrame + AnalyserNode (the level ring's
// approach): rAF stops when the window is hidden or occluded, and sleeping is
// exactly when the window sits in the background. The audio thread keeps
// running; messages to the page are not throttled like timers are.
//
// The node has no outputs, so it never plays anything; Chrome still pulls a
// zero-output AudioWorkletNode as long as its input is connected.

const FRAME = 1024;

class WakeTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(FRAME);
    this.n = 0;
    this.on = true;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === "enable") this.on = !!e.data.on;
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!this.on || !ch) return true;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(ch.length - i, FRAME - this.n);
      this.buf.set(ch.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === FRAME) {
        const out = this.buf;
        this.port.postMessage(out, [out.buffer]);
        this.buf = new Float32Array(FRAME);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor("clv-wake-tap", WakeTap);
