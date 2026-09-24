// sotto desktop-app bridge (SPEC §6.16). Injected by the Sotto app
// into the voice page at document start, in the page's own JS world, before
// web/app.js runs. The page itself is unchanged: this observes only the
// contracts the page already has with the daemon (SSE status messages, SPEC
// §6.12; the "oai-events" data channel, §7.3/§7.4) and drives the page through
// its documented hotkey (M toggles mute, §7.5).
//
// It forwards state, never text: no captions, no tokens, no secrets reach the
// native side. Messages go to window.webkit.messageHandlers.sottoHost.
(() => {
  "use strict";
  if (window.sottoHost) return;
  const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.sottoHost;
  const post = (m) => {
    try {
      if (handler) handler.postMessage(m);
    } catch {
      /* native side gone */
    }
  };

  // Transcript deltas are frequent; forward at most one "speaking" pulse per
  // role every 250 ms (the native side decays the state after ~1.2 s).
  const lastPulse = { user: 0, assistant: 0 };
  const pulse = (role) => {
    const now = Date.now();
    if (now - lastPulse[role] < 250) return;
    lastPulse[role] = now;
    post({ kind: "speaking", role });
  };

  // The page token stays inside the page; the host API uses it only for the
  // documented page route POST /api/page {type:"stop"} (SPEC §6.4).
  let pageToken = "";

  // ---- SSE tap (status / commands) ----
  const NativeES = window.EventSource;
  if (typeof NativeES === "function") {
    class TappedEventSource extends NativeES {
      constructor(url, init) {
        super(url, init);
        const isEvents = /\/api\/events(\?|$)/.test(String(url));
        if (!isEvents) return;
        try {
          pageToken = new URL(String(url), location.href).searchParams.get("token") || pageToken;
        } catch {
          /* ignore */
        }
        this.addEventListener("open", () => post({ kind: "sse", open: true }));
        this.addEventListener("error", () => post({ kind: "sse", open: false }));
        this.addEventListener("message", (e) => {
          let m;
          try {
            m = JSON.parse(e.data);
          } catch {
            return;
          }
          if (!m || typeof m !== "object") return;
          if (m.type === "status" && m.status) {
            const s = m.status;
            post({
              kind: "status",
              state: String(s.state || ""),
              project: s.owner && s.owner.project ? String(s.owner.project) : "",
              muted: !!(s.live && s.live.muted),
              busy: !!(s.claude && s.claude.busy),
              error: s.last_error && s.last_error.code ? String(s.last_error.code) : "",
              error_message: s.last_error && s.last_error.message ? String(s.last_error.message).slice(0, 200) : "",
            });
          } else if (m.type === "command") {
            post({ kind: "command", command: String(m.command || "") });
          } else if (m.type === "notice" && m.level === "error") {
            post({ kind: "notice", level: "error", code: String(m.code || "") });
          }
        });
      }
    }
    window.EventSource = TappedEventSource;
  }

  // ---- data-channel tap (speaking / mute / session lifecycle) ----
  const PC = window.RTCPeerConnection;
  if (typeof PC === "function" && PC.prototype && typeof PC.prototype.createDataChannel === "function") {
    const orig = PC.prototype.createDataChannel;
    PC.prototype.createDataChannel = function (label, ...rest) {
      const dc = orig.call(this, label, ...rest);
      if (label === "oai-events") {
        dc.addEventListener("message", (e) => {
          if (typeof e.data !== "string") return;
          let ev;
          try {
            ev = JSON.parse(e.data);
          } catch {
            return;
          }
          switch (ev && ev.type) {
            case "session.input_transcript.delta":
              pulse("user");
              break;
            // Transcript deltas only: output audio chunks keep arriving while
            // the voice is silent (SPEC-DEVIATIONS, spoken notifications #8).
            case "session.output_transcript.delta":
              pulse("assistant");
              break;
            case "session.input_audio.muted":
              post({ kind: "muted", muted: true });
              break;
            case "session.input_audio.unmuted":
              post({ kind: "muted", muted: false });
              break;
            case "session.started":
              post({ kind: "live", live: true });
              break;
            case "session.closed":
              post({ kind: "live", live: false, reason: String(ev.reason || "") });
              break;
            default:
              break;
          }
        });
        dc.addEventListener("close", () => post({ kind: "live", live: false, reason: "dc_closed" }));
      }
      return dc;
    };
  }

  // ---- microphone result (error icon, app debug log) ----
  const md = navigator.mediaDevices;
  if (md && typeof md.getUserMedia === "function") {
    const gum = md.getUserMedia.bind(md);
    md.getUserMedia = async (constraints) => {
      try {
        const stream = await gum(constraints);
        const t = stream.getAudioTracks()[0];
        let s = {};
        try {
          s = t ? t.getSettings() : {};
        } catch {
          /* ignore */
        }
        post({ kind: "mic", ok: true, echoCancellation: s.echoCancellation, sampleRate: s.sampleRate });
        return stream;
      } catch (err) {
        post({ kind: "mic", ok: false, name: String((err && err.name) || "Error") });
        throw err;
      }
    };
  }

  // ---- host API used by the native side (evaluateJavaScript) ----
  const host = Object.freeze({
    version: 1,
    platform: "macos-app",
    /** Toggle mute through the page's own §7.5 hotkey handler. */
    toggleMute() {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "m", code: "KeyM", bubbles: true, cancelable: true }));
    },
    /** Voice off (same as the page's End voice button). Returns false without a token. */
    stopVoice() {
      if (!pageToken) return false;
      fetch("/api/page", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sotto-Page": pageToken },
        body: JSON.stringify({ type: "stop" }),
      }).catch(() => {});
      return true;
    },
  });
  Object.defineProperty(window, "sottoHost", { value: host, configurable: false, enumerable: false, writable: false });
  post({ kind: "hello", url: location.origin + location.pathname });
})();
