// Glue between the native link (daemon/native.js) and the voice orchestrator
// (daemon/voice.js) for app clients (docs/NATIVE.md §2-§4).
//
// `link` (daemon/native.js) is: { sendJson(obj), sendAudio(pcmBuffer, {flags}), close(code, reason),
//                                  get bufferedAmount, clientInfo /* the hello */ }
// The controller owns, per attached app:
//  - the input pacer (pacer.js): app mic frames -> session.input_audio.append,
//    continuous and in real time, silence while the app lags or is gone;
//  - the speaker path: PrimarySession "audio" -> 960-byte frames -> the app,
//    with audio_flush when a session ends;
//  - the fan-out of everything voice.js broadcasts to the page (status,
//    activity, notices, commands...), plus captions and allowlisted Live events;
//  - the `cmd` dispatch (§3.3), each answered by exactly one `result`;
//  - the parity monitors that the page runs on its own mic (§4.5): voice wake
//    while sleeping (web/wake.js), "can't hear you" (web/lib.js) and the echo
//    report (web/echo.js), all on the relayed audio.
import fs from "node:fs";
import { createPacer } from "./pacer.js";
import { createRechunker, FLAG, FRAME_BYTES, FRAME_MS, PROTOCOL, SAMPLE_RATE, LIVE_FORWARD, COMMANDS } from "./native-proto.js";
import { POLICIES, VERSION } from "./config.js";
import { truncate } from "./log.js";
import { createVad, createClipRecorder, encodeWav, bytesToBase64, cooldownLeft, ONSET_PAD_MS, SENSITIVITIES } from "../web/wake.js";
import { createHearingMonitor } from "../web/lib.js";
import { createLeakEstimator, classifyLeak, echoTestVerdict } from "../web/echo.js";

/** Speaker frames at or above this peak count as audible speech (same bar as preview.js). */
export const LOUD_PEAK = 1200;
/** Summary of the app's audio_stats in the log this often. */
const STATS_LOG_MS = 30_000;
/** VAD frame at 24 kHz: 512 samples (21.3 ms), the page's 1024 at 48 kHz. */
const VAD_FRAME = 512;
/** Speech onset in the speaker stream (log only): peak and quiet run, as the app's FakeAudioIO measures it. */
const SPEECH_ONSET_PEAK = 800;
const SPEECH_ONSET_QUIET_FRAMES = 15;
/** The echo report checks the live leak this often while the assistant talks. */
const ECHO_CHECK_MS = 5000;
/** A `cmd` the daemon cannot answer sooner is answered with a timeout (the app gives up at 15 s). */
const CMD_TIMEOUT_MS = 10_000;
const ECHO_TEST_TIMEOUT_MS = 9_000;
const LIVE_EVENTS = new Set(LIVE_FORWARD);
const CAPTION_EVENTS = { "session.input_transcript.delta": "user", "session.output_transcript.delta": "assistant" };
const FORWARD = new Set(["status", "activity", "delegation", "notice", "notice_clear", "result_pending", "wake_heard", "command"]);

function framePeakRms(pcm) {
  let peak = 0;
  let sum = 0;
  const n = pcm.length >> 1;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sum += v * v;
  }
  return { peak, rms: n ? Math.sqrt(sum / n) / 32768 : 0, pow: n ? sum / n / (32768 * 32768) : 0 };
}

function toFloat(pcm) {
  const n = pcm.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}

export class NativeController {
  constructor({ voice, log, clock, build = null, previewFile = null, hearing = {} } = {}) {
    this.voice = voice; this.log = log; this.clock = clock; this.build = build;
    this.previewFile = previewFile; // (voice) => path of the cached sample WAV, for the echo test
    this.link = null;
    this.welcomed = false;
    this.session = null; // the PrimarySession audio is bound to
    this.bound = new WeakSet();
    this.rechunker = createRechunker();
    this.afterFlush = false;
    this.lastSettings = "";
    this.stats = null; // last audio_stats
    this.statsLoggedAt = 0;
    this.route = null;
    this.rttMs = null;
    this.counters = { mic_frames: 0, speaker_frames: 0, speaker_dropped: 0, flushes: 0, wake_triggers: 0, cmds: 0 };
    this.lastAudibleAt = 0; // daemon ms when the assistant was last audible at the app (send time + buffer)
    this.speakerSlots = new Map(); // 20 ms slot -> speaker power (echo reference)
    this.pacer = createPacer({
      clock,
      send: (pcm) => { this.session?.pushAudio(pcm); },
      isMuted: () => !!(this.voice.muteWanted || this.voice.live?.muted),
      onGraceExpired: () => { if (!this.link) this.voice.onAppGone(); },
    });
    // `hearing` overrides the page's thresholds (tests only: createDaemon nativeOptions).
    this.hearing = createHearingMonitor(hearing);
    this.quietFrames = SPEECH_ONSET_QUIET_FRAMES; // speaker frames since the last loud one (speech onset logging)
    this.hearingNotice = false;
    this.leak = null;
    this.echoCheckAt = 0;
    this.echoNoticed = false;
    this.wake = null; // {vad, rec, acc, accN, capturing, sensitivity}
    this.wakeClip = null; // captured clip waiting for the woken session: {samples}
    this.echoTest = null;
    voice.setNativeController?.(this);
  }

  /** true when an app client is attached (window.js / voice.js use this). */
  get connected() { return !!this.link; }

  // ---- link lifecycle ---------------------------------------------------------------------
  /** A client completed hello. Returns the `welcome` payload (sans type) to send. */
  attach(link, hello) {
    this.link = link;
    this.welcomed = false;
    this.voice.audioClient = "app";
    this.pacer.appBack();
    this.log.info("native.attach", { conn: link.id ?? null, version: hello?.version ?? null, test: !!hello?.test, state: this.voice.state });
    const settings = this.settings();
    this.lastSettings = JSON.stringify(settings);
    return { protocol: PROTOCOL, version: VERSION, build: this.build, status: this.voice.pageStatus(), settings };
  }

  /** After `welcome` went out: the app is the audio client now (§4.3). */
  afterWelcome(link) {
    if (link !== this.link) return;
    this.welcomed = true;
    this.voice.onAppAttached();
  }

  /** The link closed (any reason). */
  detach(link, info = {}) {
    if (link !== this.link) return;
    this.link = null;
    this.welcomed = false;
    this.cancelEchoTest("app_gone");
    const st = this.voice.state;
    this.log.info("native.detach", { code: info.code ?? null, replaced: !!info.replaced, state: st });
    if (this.session || st === "connecting" || st === "live" || st === "reconnecting") this.pacer.appGone();
    this.voice.onAppDetached();
  }

  // ---- daemon -> app ----------------------------------------------------------------------
  send(obj) {
    if (!this.link || !this.welcomed) return false;
    return this.link.sendJson(obj);
  }

  settings() {
    const v = this.voice;
    return {
      voices: v.voices(),
      // The persona picker (§3.1): summaries only, never a persona's body. The
      // list is the one pageStatus() scanned in the last 5 s, so a settings
      // diff on every status costs no directory scan.
      personas: v.personas({ cached: true }),
      window: v.windowPref(),
      policies: [...POLICIES],
      wake_sensitivities: [...SENSITIVITIES],
      data_dir: v.paths.dir,
      version: VERSION,
    };
  }

  /** Everything voice.js broadcasts to the page (voice.emitPage). */
  onBroadcast(msg) {
    if (msg?.type === "status") this.onStatus(msg.status);
    if (!this.link || !this.welcomed || !FORWARD.has(msg?.type)) return;
    this.send(msg);
    if (msg.type === "status") {
      const s = JSON.stringify(this.settings());
      if (s !== this.lastSettings) { this.lastSettings = s; this.send({ type: "settings", ...JSON.parse(s) }); }
    }
  }

  onStatus(status) {
    // Voice wake runs only while sleeping (§4.5); keep the detector in tune.
    const st = status?.state;
    if (st === "sleeping" && status.wake?.enabled) {
      const cfg = status.wake;
      if (!this.wake || this.wake.sensitivity !== cfg.sensitivity) this.armWake(cfg);
      else this.wake.vad.setBoost(cfg.boost_db);
    } else if (this.wake && !this.wake.capturing) {
      this.wake = null;
    }
  }

  // ---- sessions ---------------------------------------------------------------------------
  /** voice.startNativeSession: route this session's audio and events through the app. */
  bindSession(sb) {
    if (this.session && this.session !== sb) this.sessionGone(this.session, "session_end");
    this.session = sb;
    this.bound.add(sb);
    this.rechunker = createRechunker();
    sb.on("audio", (pcm) => this.onSessionAudio(sb, pcm));
    sb.on("event", (evt) => this.onSessionEvent(sb, evt));
    sb.on("ready", () => this.onSessionReady(sb));
    sb.on("socket_closed", () => { if (this.session === sb) this.sessionGone(sb, "session_end"); });
  }

  onSessionReady(sb) {
    if (this.session !== sb) return;
    this.pacer.start();
    // Can't-hear warns only until the user is first heard on the current mic
    // (lib.createHearingMonitor): a new session resets it; a transparent
    // reconnect or a wake on the same mic keeps it, as on the page.
    if (sb.startReason !== "reconnect" && sb.startReason !== "wake") this.hearing.reset();
    this.hearing.start(this.clock.now(), this.micKey());
    this.hearingNotice = false;
    this.leak = createLeakEstimator({ blockMs: FRAME_MS });
    this.echoNoticed = false;
    // A voice wake: the opening words go to the woken session (voice.onWakeAudio).
    if (this.wake?.capturing) {
      const samples = this.wake.rec.finish();
      this.wake = null;
      if (samples.length) {
        const wav = encodeWav(samples, SAMPLE_RATE);
        this.voice.onWakeAudio({ type: "wake_audio", session_id: sb.id, audio: bytesToBase64(wav) })
          .catch((e) => this.log.error("wake.error", { message: String(e && e.message) }));
      }
    }
  }

  /** The session ended or was replaced (voice.js): stop the uplink, flush the app's playout. */
  sessionGone(sb, reason = "session_end") {
    if (!sb || this.session !== sb) return;
    this.session = null;
    this.pacer.stop();
    this.hearing.stop();
    this.rechunker = createRechunker(); // the tail is dropped, not played (the app flushes)
    this.counters.flushes++;
    this.afterFlush = true;
    this.speakerSlots.clear();
    this.send({ type: "audio_flush", reason });
  }

  onSessionAudio(sb, pcm) {
    if (this.session !== sb || !this.link) return;
    const now = this.clock.now();
    const bufMs = Number(this.stats?.buffer_ms) || 60;
    for (const frame of this.rechunker.push(pcm)) {
      const flags = this.afterFlush ? FLAG.AFTER_FLUSH : 0;
      const { peak, pow } = framePeakRms(frame);
      // The Live primary socket streams audio continuously (silence included),
      // so a speech onset is the first loud frame after 300 ms of quiet frames.
      // One log line per onset; the app e2e pairs it with the app's first
      // rendered loud sample (model audio -> playback latency).
      if (peak >= SPEECH_ONSET_PEAK) {
        if (this.quietFrames >= SPEECH_ONSET_QUIET_FRAMES) this.log.info("native.speech_onset", { live_id: sb.id, peak });
        this.quietFrames = 0;
      } else this.quietFrames++;
      if (this.link.sendAudio(frame, { flags })) {
        this.afterFlush = false;
        this.counters.speaker_frames++;
      } else {
        this.counters.speaker_dropped++;
      }
      // Heard by the user about one playout buffer later (§2.5).
      if (peak >= LOUD_PEAK) this.lastAudibleAt = now + bufMs;
      const slot = Math.floor((now + bufMs) / FRAME_MS);
      this.speakerSlots.set(slot, (this.speakerSlots.get(slot) || 0) + pow);
    }
    if (this.speakerSlots.size > 500) {
      const min = Math.floor(now / FRAME_MS) - 50;
      for (const k of this.speakerSlots.keys()) if (k < min) this.speakerSlots.delete(k);
    }
  }

  onSessionEvent(sb, evt) {
    if (!this.link || !this.welcomed) return;
    const role = CAPTION_EVENTS[evt.type];
    if (role) {
      if (this.session !== sb) return;
      this.send({ type: "caption", role, text: typeof evt.delta === "string" ? evt.delta : "", start_ms: evt.start_ms ?? null, end_ms: evt.end_ms ?? null, session: sb.id });
      if (role === "user" && typeof evt.delta === "string" && /[\p{L}\p{N}]/u.test(evt.delta)) {
        this.hearing.heard(this.clock.now());
        if (this.hearingNotice) { this.hearingNotice = false; this.send({ type: "notice_clear", code: "cant_hear" }); }
      }
      return;
    }
    if (LIVE_EVENTS.has(evt.type) && this.bound.has(sb)) this.send({ type: "live", event: evt });
  }

  // ---- app -> daemon ----------------------------------------------------------------------
  /** Binary mic frame, decoded by native-proto.decodeFrame (kind MIC, 960 bytes). */
  onMicFrame(link, frame) {
    if (link !== this.link) return;
    this.counters.mic_frames++;
    const v = this.voice;
    const muted = (frame.flags & FLAG.MUTED) !== 0 || v.muteWanted || !!v.live?.muted;
    // Defense (§2.2): a muted frame never carries mic data to OpenAI.
    const pcm = muted ? Buffer.alloc(FRAME_BYTES) : frame.pcm;
    if (this.session?.ready) this.pacer.push(pcm);
    const now = this.clock.now();
    const needLevel = !muted && (this.session?.ready || this.echoTest || v.state === "sleeping" || this.wake?.capturing);
    const m = needLevel ? framePeakRms(pcm) : null;
    if (this.wake && (v.state === "sleeping" || this.wake.capturing)) this.feedWake(pcm, muted);
    if (this.echoTest) this.echoTest.mic.push(m ? m.pow : 0);
    if (this.session?.ready) {
      const voiceLevel = now < this.lastAudibleAt ? 1 : 0;
      const heard = this.hearing.sample({ rms: m ? m.rms : 0, muted, voice: voiceLevel, now });
      if (heard) this.onCantHear(heard);
      if (!muted && this.leak) this.feedLeak(m.pow, now);
    }
  }

  /** Text message after hello (already JSON-parsed, `type` in CLIENT_TYPES). */
  onMessage(link, msg) {
    if (link !== this.link) return;
    const v = this.voice;
    switch (msg.type) {
      case "cmd": this.onCommand(msg); break;
      case "pong": if (Number.isFinite(Number(msg.t))) this.rttMs = Math.max(0, this.clock.now() - Number(msg.t)); break;
      case "audio_stats": this.onStats(msg); break;
      case "route": {
        const dev = (d) => (d && typeof d === "object" ? { name: truncate(String(d.name ?? ""), 80), bluetooth: d.bluetooth === true, headphones: d.headphones === true } : null);
        const before = this.micKey();
        this.route = { mode: truncate(String(msg.mode ?? ""), 16), input: dev(msg.input), output: dev(msg.output), echo_cancellation: truncate(String(msg.echo_cancellation ?? ""), 16) };
        this.log.info("native.route", this.route);
        // A different mic: not heard on it yet; re-arm the checks if live (as the page does).
        if (this.micKey() !== before) {
          this.hearing.reset();
          if (this.session?.ready) this.hearing.start(this.clock.now(), this.micKey());
        }
        break;
      }
      case "played":
        v.onPagePlayed({ what: msg.what, voice: msg.voice });
        if (msg.what === "echo_test" && this.echoTest) this.finishEchoTest();
        break;
      case "log": {
        const lvl = msg.level === "error" ? "error" : msg.level === "warn" ? "warn" : "info";
        this.log[lvl]("page.log", { src: "app", message: truncate(String(msg.message ?? ""), 500) });
        break;
      }
      case "system":
        if (msg.event === "sleep") v.onSystemSleep();
        else this.log.info("native.system", { event: truncate(String(msg.event ?? ""), 16) });
        break;
      case "mic_error": v.handlePage({ type: "mic_error", name: msg.name, message: msg.message }); break;
      // Exact digital silence on the unmuted mic (SPEC §6.16 "Silent mic"): the same handling as the old app page.
      case "mic_silent": v.handlePage({ type: "mic_silent", host: "app", source: "native", input_label: msg.input_label || this.micKey() || "", ms: msg.ms }); break;
      case "activity": v.handlePage({ type: "activity" }); break;
      default: break;
    }
  }

  /** The hearing monitor's device key: the app's current input name (null when unknown). */
  micKey() { return this.route?.input?.name || null; }

  onStats(msg) {
    const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
    this.stats = {
      playout_seq: num(msg.playout_seq), buffer_ms: num(msg.buffer_ms), underruns: num(msg.underruns), overruns: num(msg.overruns),
      capture_drops: num(msg.capture_drops), mic_seq: num(msg.mic_seq), mode: truncate(String(msg.mode ?? ""), 16),
    };
    const now = this.clock.now();
    if (now - this.statsLoggedAt >= STATS_LOG_MS) {
      this.statsLoggedAt = now;
      this.log.info("native.audio", { ...this.stats, rtt_ms: this.rttMs, ...this.pacer.stats(), speaker_frames: this.counters.speaker_frames, speaker_dropped: this.counters.speaker_dropped });
    }
  }

  // ---- commands (§3.3) ----------------------------------------------------------------------
  onCommand(msg) {
    const id = typeof msg.id === "string" ? msg.id.slice(0, 80) : null;
    const name = typeof msg.name === "string" ? msg.name : "";
    const args = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args) ? msg.args : {};
    const link = this.link;
    this.counters.cmds++;
    // Never the args: key_save carries the API key.
    this.log.info("native.cmd", { name: truncate(name, 32), id });
    if (!id) return;
    let answered = false;
    const reply = (r) => {
      if (answered) return;
      answered = true;
      this.clock.clearTimeout(timer);
      if (link !== this.link || !link) return;
      link.sendJson(r.ok ? { type: "result", id, ok: true, data: r.data ?? {} } : { type: "result", id, ok: false, error: { code: r.code || "error", message: r.message || r.code || "error" } });
    };
    const timer = this.clock.setTimeout(() => reply({ ok: false, code: "timeout", message: "The daemon did not answer in time." }), CMD_TIMEOUT_MS);
    if (!COMMANDS.includes(name)) { reply({ ok: false, code: "unknown_command", message: `Unknown command ${truncate(name, 32)}` }); return; }
    Promise.resolve().then(() => this.runCommand(name, args)).then(reply, (e) => {
      this.log.error("native.cmd_error", { name, message: String(e && e.message) });
      reply({ ok: false, code: "internal", message: "Internal error" });
    });
  }

  async runCommand(name, args) {
    const v = this.voice;
    switch (name) {
      case "mute": return { ok: true, data: v.setMuted(args.on === true) };
      case "pause":
        if (!v.owner) return { ok: false, code: "not_active", message: "Voice is not on." };
        await v.pause("pause");
        return { ok: true };
      case "resume": return wrap(v.resumeFromApp("resume"));
      // A tap on "Wake now" is the user's action, not a heard voice: it
      // resumes (no wake clip, no false-wake bookkeeping).
      case "wake": return wrap(v.resumeFromApp("resume"));
      case "end": v.off("user"); return { ok: true };
      case "set_voice": {
        const r = v.setVoice(args.voice, "app");
        if (!r.ok) return { ok: false, code: r.code || "bad_voice", message: r.message };
        return { ok: true, data: { voice: r.voice, switching: r.switching, message: r.message } };
      }
      case "set_persona": {
        // Same shape as POST /api/persona (SPEC §4.6): `use_voice` sets the
        // "switch to the persona's own voice" toggle, `persona` picks one; both
        // may come together (the toggle applies first).
        const hasToggle = typeof args.use_voice === "boolean";
        const hasPersona = typeof args.persona === "string" && args.persona.length > 0;
        if (!hasToggle && !hasPersona) return { ok: false, code: "bad_persona", message: "Send persona or use_voice." };
        if (hasToggle) v.setPersonaVoice(args.use_voice);
        if (!hasPersona) return { ok: true, data: { use_voice: args.use_voice } };
        const r = v.setPersona(args.persona, "app");
        if (!r.ok) return { ok: false, code: r.code || "bad_persona", message: r.message };
        return { ok: true, data: { persona: r.persona, voice: r.voice, switching: r.switching, message: r.message, use_voice: v.personas({ cached: true }).use_voice } };
      }
      case "set_policy": {
        const r = v.setPolicy(args.policy);
        if (!r.ok) return { ok: false, code: "bad_policy", message: `Unknown speaking policy. Choose ${POLICIES.join(", ")}.` };
        return { ok: true, data: { policy: args.policy } };
      }
      case "set_wake": {
        if (!SENSITIVITIES.includes(args.sensitivity)) return { ok: false, code: "bad_sensitivity", message: `Choose ${SENSITIVITIES.join(", ")}.` };
        v.setWakeSensitivity(args.sensitivity);
        return { ok: true, data: { sensitivity: args.sensitivity } };
      }
      case "set_window": {
        const r = v.setWindow(args.mode);
        if (!r.ok) return { ok: false, code: "bad_window", message: r.message };
        const data = { window: v.windowPref(), message: r.message };
        this.onBroadcast({ type: "status", status: v.pageStatus() }); // settings changed
        return { ok: true, data };
      }
      case "key_save": {
        const r = await v.saveKey(args.key);
        return r.status === 200 ? { ok: true, data: r.body } : { ok: false, code: r.body?.error?.code, message: r.body?.error?.message };
      }
      case "key_remove": {
        const r = v.removeKey();
        return r.status === 200 ? { ok: true, data: r.body } : { ok: false, code: r.body?.error?.code, message: r.body?.error?.message };
      }
      case "get_voices": return { ok: true, data: v.voices() };
      case "echo_test": return this.runEchoTest();
      case "open_browser": {
        const r = await v.openBrowserFromApp();
        return { ok: true, data: { mode: r?.mode ?? null } };
      }
      default: return { ok: false, code: "unknown_command", message: "Unknown command" };
    }
  }

  // ---- parity monitors (§4.5) ---------------------------------------------------------------
  armWake(cfg) {
    this.wake = {
      vad: createVad({ sampleRate: SAMPLE_RATE, sensitivity: cfg.sensitivity, boostDb: cfg.boost_db }),
      rec: createClipRecorder({ sampleRate: SAMPLE_RATE }),
      acc: new Float32Array(VAD_FRAME), accN: 0, capturing: false, sensitivity: cfg.sensitivity,
    };
    this.log.info("wake.listen", { src: "app", sensitivity: cfg.sensitivity, boost_db: cfg.boost_db });
  }

  feedWake(pcm, muted) {
    const w = this.wake;
    const f = toFloat(pcm);
    for (let i = 0; i < f.length; i++) {
      w.acc[w.accN++] = muted ? 0 : f[i];
      if (w.accN < VAD_FRAME) continue;
      w.accN = 0;
      const frame = w.acc.slice();
      w.rec.push(frame);
      if (w.capturing || muted) continue;
      const r = w.vad.process(frame);
      if (r.trigger) this.onWakeTrigger(r);
    }
  }

  onWakeTrigger(r) {
    const v = this.voice;
    const w = this.wake;
    if (v.state !== "sleeping" || !v.owner) return;
    const cfg = v.governor.pageConfig(v.config.wake_sensitivity, true);
    if (!cfg.enabled || cooldownLeft(cfg, this.clock.now()) > 0 || this.echoTest) return;
    const onsetAgoMs = ((w.vad.samples - r.onsetSample) / SAMPLE_RATE) * 1000;
    w.capturing = true;
    w.rec.startCapture(r.onsetSample - Math.round((ONSET_PAD_MS / 1000) * SAMPLE_RATE));
    this.counters.wake_triggers++;
    this.log.info("wake.trigger", { src: "app", voiced_ms: Math.round(r.voicedMs), snr_db: Math.round(r.snrDb * 10) / 10 });
    v.startNativeSession("wake", {
      wake: { onset_to_post_ms: onsetAgoMs, trigger_ms: onsetAgoMs, snr_db: r.snrDb, level_db: r.db, voiced_ms: r.voicedMs, boost_db: cfg.boost_db || 0, sensitivity: cfg.sensitivity || "medium" },
    }).then((res) => { if (!res?.ok && this.wake === w) this.wake = null; });
  }

  onCantHear(f) {
    const v = this.voice;
    const input = this.route?.input?.name || "the current microphone";
    v.onCantHear({ kind: f.kind, input_label: input, peak_rms: f.peak_rms, speech_ms: f.speech_ms, since_ms: f.since_ms });
    this.hearingNotice = true;
    this.send({ type: "notice", level: "warn", code: "cant_hear", text: `I can't hear you — using ${input}.` });
  }

  feedLeak(micPow, now) {
    const slot = Math.floor(now / FRAME_MS);
    this.leak.push(micPow, this.speakerSlots.get(slot) || 0);
    if (now - this.echoCheckAt < ECHO_CHECK_MS) return;
    this.echoCheckAt = now;
    const e = this.leak.estimate();
    const level = classifyLeak(e);
    if (level === "unknown") return;
    this.voice.onPageEcho({ kind: "leak", level, leak_db: e.leakDb, corr: e.corr, lag_ms: e.lagMs, speech_s: e.activeMs / 1000, mode: this.stats?.mode || undefined });
    if (level === "high" && !this.echoNoticed) {
      this.echoNoticed = true;
      this.send({ type: "notice", level: "warn", code: "echo_detected", text: "The microphone hears Sotto's voice. Headphones or a lower speaker volume help." });
    }
  }

  /** cmd echo_test: the app plays the cached voice sample; the mic is measured against it. */
  runEchoTest() {
    if (this.echoTest) return { ok: false, code: "busy", message: "An echo test is already running." };
    const voice = this.voice.currentVoice();
    let ref = null;
    try {
      const file = this.previewFile?.(voice);
      if (file) {
        const wav = fs.readFileSync(file);
        if (wav && wav.length > 44) ref = wav.subarray(44);
      }
    } catch { ref = null; }
    if (!ref) return { ok: false, code: "not_cached", message: "Play a voice sample first (Hear the voices), then test the echo." };
    return new Promise((resolve) => {
      const t = { resolve, ref, mic: [], timer: null };
      t.timer = this.clock.setTimeout(() => this.finishEchoTest(), ECHO_TEST_TIMEOUT_MS);
      this.echoTest = t;
      this.send({ type: "command", command: "play_echo_sample", reason: "echo_test" });
    });
  }

  finishEchoTest() {
    const t = this.echoTest;
    if (!t) return;
    this.echoTest = null;
    this.clock.clearTimeout(t.timer);
    // The sample's 20 ms envelope against the mic's; the start offset (app
    // start-up and playout latency) is found by the estimator's lag search.
    const est = createLeakEstimator({ blockMs: FRAME_MS, windowMs: 10_000, maxLagMs: 1500 });
    const refPow = [];
    for (let off = 0; off + FRAME_BYTES <= t.ref.length; off += FRAME_BYTES) refPow.push(framePeakRms(t.ref.subarray(off, off + FRAME_BYTES)).pow);
    for (let i = 0; i < t.mic.length; i++) est.push(t.mic[i], refPow[i] || 0);
    const e = est.estimate();
    const level = classifyLeak(e);
    const verdict = echoTestVerdict(level);
    const data = { verdict: verdict.level, title: verdict.title, advice: verdict.advice, leak_db: e.leakDb === null ? null : Math.round(e.leakDb * 10) / 10, corr: Math.round((e.corr || 0) * 100) / 100, level };
    this.voice.onPageEcho({ kind: "test", level, leak_db: e.leakDb, corr: e.corr, lag_ms: e.lagMs, speech_s: e.activeMs / 1000, mode: this.stats?.mode || undefined });
    t.resolve({ ok: true, data });
  }

  cancelEchoTest(code) {
    const t = this.echoTest;
    if (!t) return;
    this.echoTest = null;
    this.clock.clearTimeout(t.timer);
    t.resolve({ ok: false, code, message: "The echo test was interrupted." });
  }

  /** For /status. */
  status() {
    return {
      connected: !!this.link, client: this.link?.clientInfo || null, rtt_ms: this.rttMs, route: this.route, stats: this.stats,
      pacer: this.pacer.stats(), counters: { ...this.counters },
    };
  }

  dispose() {
    this.pacer.dispose();
    this.cancelEchoTest("daemon_exit");
  }
}

function wrap(r) {
  return r.ok ? { ok: true, data: {} } : { ok: false, code: r.code, message: r.message };
}
