// sotto desktop-app microphone layer (SPEC §6.16, "native mic"). Injected by
// the Sotto app at document start, before bridge.js and web/app.js, in the
// page's own JS world. The page is unchanged: it still calls getUserMedia,
// enumerateDevices and permissions.query; this layer answers them.
//
// For every getUserMedia({audio}) it asks the app (window.webkit.messageHandlers
// .sottoMic, a reply handler) for a plan:
//   native  the app captures the chosen input itself (no voice processing, so
//           no Bluetooth hands-free switch and no ducking; used on headphones)
//           and streams 48 kHz Int16 chunks into an AudioWorklet here, whose
//           MediaStreamAudioDestinationNode track goes to the page;
//   webkit  WebKit's own capture (Apple's echo cancellation; used on speakers).
// When the route changes (AirPods connect) the app calls __sottoMicRoute():
// a native capture moves to the new device under the same track; a capture
// whose mode must change ends, and the page re-opens the mic (track "ended",
// the same path as an unplugged device).
//
// enumerateDevices lists the app's inputs (labelled; ids are opaque hashes), so
// the page's device picker and its Bluetooth -> built-in rule work in both modes.
(() => {
  "use strict";
  const H = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.sottoMic;
  const md = navigator.mediaDevices;
  if (!H || !md || typeof md.getUserMedia !== "function" || window.__sottoMicFeed) return;
  const cfg = window.__sottoMicConfig || {};
  const ask = (m) => Promise.resolve(H.postMessage(m));
  const origGUM = md.getUserMedia.bind(md);
  const origEnum = typeof md.enumerateDevices === "function" ? md.enumerateDevices.bind(md) : async () => [];
  const captures = new Map(); // id -> capture
  let seq = 0;
  let permState = null;
  let remote = null; // echo simulation (tests only): the remote voice track

  const domError = (name, message) => {
    try {
      return new DOMException(message || name, name);
    } catch {
      const e = new Error(message || name);
      e.name = name;
      return e;
    }
  };
  const requestedId = (a) => {
    if (!a || typeof a !== "object") return null;
    const d = a.deviceId;
    if (typeof d === "string") return d;
    if (d && typeof d === "object") {
      const v = d.exact !== undefined ? d.exact : d.ideal;
      return Array.isArray(v) ? v[0] || null : v || null;
    }
    return null;
  };
  const isExact = (a) => !!(a && typeof a === "object" && a.deviceId && typeof a.deviceId === "object" && a.deviceId.exact !== undefined);

  // ---- devices ----
  md.enumerateDevices = async () => {
    const real = await origEnum().catch(() => []);
    let list = null;
    try {
      list = await ask({ op: "devices" });
    } catch {
      /* app side gone: WebKit's list */
    }
    if (!list || !Array.isArray(list.inputs)) return real;
    const info = (deviceId, label) => {
      const d = { deviceId, groupId: "", kind: "audioinput", label };
      return { ...d, toJSON: () => d };
    };
    const inputs = [];
    if (list.default) inputs.push(info("default", `Default - ${list.default.label}`));
    for (const d of list.inputs) inputs.push(info(String(d.id), String(d.label || "")));
    return [...inputs, ...real.filter((d) => d.kind !== "audioinput")];
  };

  // ---- permission (macOS privacy for Sotto is the only gate in the app) ----
  const perms = navigator.permissions;
  if (perms && typeof perms.query === "function") {
    const origQuery = perms.query.bind(perms);
    perms.query = async (desc) => {
      if (desc && desc.name === "microphone") {
        try {
          const s = await ask({ op: "permission" });
          if (typeof s === "string") {
            permState = s;
            return { name: "microphone", get state() { return permState; }, onchange: null, addEventListener() {}, removeEventListener() {} };
          }
        } catch {
          /* fall through */
        }
      }
      return origQuery(desc);
    };
  }

  // ---- getUserMedia ----
  md.getUserMedia = async (constraints) => {
    const a = constraints && constraints.audio;
    if (!a || constraints.video) return origGUM(constraints);
    const want = requestedId(a);
    let plan;
    try {
      plan = await ask({ op: "plan", device: want });
      if (plan && plan.error === "NotFoundError" && !isExact(a)) plan = await ask({ op: "plan", device: null });
    } catch {
      return origGUM(constraints);
    }
    if (!plan || plan.error) {
      if (plan && plan.error === "NotFoundError") throw domError(isExact(a) ? "OverconstrainedError" : "NotFoundError", "Requested device not found");
      return origGUM(constraints);
    }
    return plan.mode === "native" ? openNative(plan, want) : openWebKit(plan, want, constraints);
  };

  function register(c) {
    captures.set(c.id, c);
    const t = c.track;
    const settings = typeof t.getSettings === "function" ? t.getSettings.bind(t) : () => ({});
    t.getSettings = () => {
      const s = settings();
      const own = c.mode === "native"
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000, channelCount: 1, sottoSource: "native" }
        : { sottoSource: "webkit" };
      return { ...s, ...own, deviceId: c.device || s.deviceId };
    };
    const stop = t.stop.bind(t);
    t.stop = () => {
      stop();
      release(c);
    };
    t.addEventListener("ended", () => release(c));
  }

  function release(c) {
    if (c.released) return;
    c.released = true;
    captures.delete(c.id);
    if (c.mode !== "native") return;
    clearInterval(c.statsTimer);
    if (c.echo) clearInterval(c.echo.timer);
    sendStats(c);
    ask({ op: "stop", id: c.id }).catch(() => {});
    try {
      c.node.disconnect();
    } catch {
      /* ignore */
    }
    c.ctx.close().catch(() => {});
  }

  async function openWebKit(plan, want, constraints) {
    const audio = typeof constraints.audio === "object" ? { ...constraints.audio } : {};
    delete audio.deviceId;
    // Our ids are not WebKit's: map by label (WebKit labels exist once it has
    // captured once; before that, WebKit's default device).
    const label = plan.device && plan.device.label;
    if (label) {
      const real = await origEnum().catch(() => []);
      const match = real.find((d) => d.kind === "audioinput" && d.label === label && d.deviceId !== "default");
      if (match) audio.deviceId = { exact: match.deviceId };
    }
    const stream = await origGUM({ ...constraints, audio });
    const track = stream.getAudioTracks()[0];
    if (track) register({ id: ++seq, mode: "webkit", track, requested: want, device: plan.device ? String(plan.device.id) : "" });
    return stream;
  }

  const WORKLET = `
class SottoNativeMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = []; this.head = 0; this.buffered = 0; this.playing = false;
    this.pre = Math.round(sampleRate * 0.02);   // start after 20 ms of audio
    this.max = Math.round(sampleRate * 0.12);   // never lag more than 120 ms
    // Latency trim: the render thread pulls in bursts, and a backlog built up
    // while the context started would otherwise stay for the whole session
    // (measured: 54 ms steady). When the smallest queue over ~0.25 s stays above
    // the target, skip the excess.
    this.target = Math.round(sampleRate * 0.015);
    this.minQ = Infinity; this.minN = 0;
    this.under = 0; this.drops = 0; this.trims = 0; this.qSum = 0; this.qN = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d instanceof Int16Array) { this.q.push(d); this.buffered += d.length; return; }
      if (d && d.op === "stats") {
        this.port.postMessage({ queueMs: this.qN ? (this.qSum / this.qN) * 1000 / sampleRate : 0, underruns: this.under, drops: this.drops, trims: this.trims });
        this.qSum = 0; this.qN = 0;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    if (!this.playing) {
      if (this.buffered < this.pre) { out.fill(0); return true; }
      this.playing = true;
    }
    while (this.q.length > 1 && this.buffered - out.length > this.max) {
      this.buffered -= this.q[0].length - this.head; this.q.shift(); this.head = 0; this.drops++;
    }
    this.minQ = Math.min(this.minQ, this.buffered); this.minN++;
    if (this.minN >= 94) {
      let skip = this.minQ - this.target;
      if (skip > 0) {
        this.trims++;
        while (skip > 0 && this.q.length) {
          const c = this.q[0]; const n = Math.min(skip, c.length - this.head);
          this.head += n; this.buffered -= n; skip -= n;
          if (this.head >= c.length) { this.q.shift(); this.head = 0; }
        }
      }
      this.minQ = Infinity; this.minN = 0;
    }
    this.qSum += this.buffered; this.qN++;
    let i = 0;
    while (i < out.length && this.q.length) {
      const c = this.q[0];
      const n = Math.min(out.length - i, c.length - this.head);
      for (let k = 0; k < n; k++) out[i + k] = c[this.head + k] / 32768;
      i += n; this.head += n; this.buffered -= n;
      if (this.head >= c.length) { this.q.shift(); this.head = 0; }
    }
    if (i < out.length) { out.fill(0, i); this.under++; this.playing = false; }
    return true;
  }
}
registerProcessor("sotto-native-mic", SottoNativeMic);
`;
  let workletUrl = null;

  async function openNative(plan, want) {
    const id = ++seq;
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    const c = { id, mode: "native", ctx, requested: want, device: String(plan.device.id), label: String(plan.device.label || ""), lat: [], chunks: 0 };
    try {
      workletUrl = workletUrl || URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(workletUrl);
      c.node = new AudioWorkletNode(ctx, "sotto-native-mic", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
      c.dest = ctx.createMediaStreamDestination();
      c.dest.channelCount = 1;
      c.node.connect(c.dest);
      // Keep the graph pulled even where a stream destination alone is not.
      const keep = ctx.createGain();
      keep.gain.value = 0;
      c.node.connect(keep).connect(ctx.destination);
      c.node.port.onmessage = (e) => onWorkletStats(c, e.data);
      captures.set(id, c); // before start: the first chunks arrive right after
      const r = await ask({ op: "start", id, device: String(plan.device.id) });
      if (!r || r.error) {
        permState = r && r.error === "NotAllowedError" ? "denied" : permState;
        throw domError((r && r.error) || "NotReadableError", (r && r.message) || "Could not start the microphone");
      }
      permState = "granted";
      if (ctx.state !== "running") await ctx.resume().catch(() => {});
      c.track = c.dest.stream.getAudioTracks()[0];
      c.device = String(r.device || c.device);
      c.label = String(r.label || c.label);
      Object.defineProperty(c.track, "label", { value: c.label, configurable: true });
      register(c);
      attachEcho(c);
      c.statsTimer = setInterval(() => c.node.port.postMessage({ op: "stats" }), 2000);
      return new MediaStream([c.track]);
    } catch (err) {
      captures.delete(id);
      ask({ op: "stop", id }).catch(() => {});
      ctx.close().catch(() => {});
      throw err;
    }
  }

  function onWorkletStats(c, w) {
    c.worklet = w;
    sendStats(c);
  }

  function sendStats(c) {
    const lat = c.lat.slice().sort((x, y) => x - y);
    c.lat = [];
    const w = c.worklet || {};
    const m = {
      op: "stats", id: c.id, chunks: c.chunks,
      transportMs: lat.length ? Math.round((lat.reduce((s, v) => s + v, 0) / lat.length) * 10) / 10 : null,
      transportP95Ms: lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] : null,
      queueMs: typeof w.queueMs === "number" ? Math.round(w.queueMs * 10) / 10 : null,
      underruns: w.underruns ?? null, drops: w.drops ?? null, trims: w.trims ?? null, echoSim: !!c.echo,
    };
    if (c.echo) {
      // Proof the simulated echo is really in the mic signal (dBFS peak RMS).
      m.echoDb = c.echo.peak > 0 ? Math.round(20 * Math.log10(c.echo.peak)) : null;
      c.echo.peak = 0;
    }
    c.lastStats = m;
    ask(m).catch(() => {});
  }

  Object.defineProperty(window, "__sottoMicFeed", {
    value: (id, t, b64) => {
      const c = captures.get(id);
      if (!c || c.mode !== "native" || !c.node) return;
      const bin = atob(b64);
      const s = new Int16Array(bin.length >> 1);
      for (let i = 0; i < s.length; i++) s[i] = ((bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)) << 16) >> 16;
      c.chunks++;
      if (c.lat.length < 2000) c.lat.push(Date.now() - t);
      c.node.port.postMessage(s, [s.buffer]);
    },
  });

  // ---- route changes (called by the app, debounced) ----
  Object.defineProperty(window, "__sottoMicRoute", {
    value: async () => {
      for (const c of [...captures.values()]) {
        let plan = null;
        try {
          plan = await ask({ op: "plan", device: c.requested });
          if (plan && plan.error === "NotFoundError") plan = await ask({ op: "plan", device: null });
        } catch {
          continue;
        }
        if (!plan || plan.error || c.released) continue;
        const dev = plan.device ? String(plan.device.id) : "";
        if (plan.mode === c.mode && (c.mode === "webkit" || dev === c.device)) continue;
        if (plan.mode === "native" && c.mode === "native") {
          // Same track, new device: the page never notices.
          const r = await ask({ op: "start", id: c.id, device: dev }).catch(() => null);
          if (r && r.ok) {
            c.device = String(r.device || dev);
            c.label = String(r.label || c.label);
            Object.defineProperty(c.track, "label", { value: c.label, configurable: true });
            continue;
          }
        }
        // Mode flip (speakers <-> headphones): end the track; the page re-opens
        // the mic as for an unplugged device.
        const t = c.track;
        t.stop();
        try {
          t.dispatchEvent(new Event("ended"));
        } catch {
          /* ignore */
        }
      }
    },
  });

  // ---- echo simulation (tests only, SOTTO_APP_ECHO_SIM_DB) ----
  function attachEcho(c) {
    if (cfg.echoSimDb === undefined || c.mode !== "native" || !remote || c.echo || c.released) return;
    const src = c.ctx.createMediaStreamSource(new MediaStream([remote]));
    const delay = c.ctx.createDelay(1);
    delay.delayTime.value = (cfg.echoDelayMs || 40) / 1000;
    const g = c.ctx.createGain();
    g.gain.value = Math.pow(10, cfg.echoSimDb / 20);
    src.connect(delay).connect(g).connect(c.dest);
    const an = c.ctx.createAnalyser();
    g.connect(an);
    const buf = new Float32Array(an.fftSize);
    c.echo = { peak: 0 };
    c.echo.timer = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      c.echo.peak = Math.max(c.echo.peak, Math.sqrt(sum / buf.length));
    }, 100);
  }
  if (cfg.echoSimDb !== undefined && typeof window.RTCPeerConnection === "function") {
    const PC = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends PC {
      constructor(...args) {
        super(...args);
        this.addEventListener("track", (e) => {
          remote = e.track;
          for (const c of captures.values()) attachEcho(c);
        });
      }
    };
  }
})();
