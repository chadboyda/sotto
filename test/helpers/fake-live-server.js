// A fake OpenAI Live PRIMARY WebSocket server (docs/NATIVE.md §4.1) on a
// loopback port, built on daemon/wsserver.js. Point the daemon at it with
// SOTTO_OPENAI_BASE=http://127.0.0.1:<port>/v1.
//
// Behavior (close to gpt-live-1 as the daemon sees it):
//  - Authorization: Bearer <key> is checked (a wrong key gets HTTP 401, no upgrade);
//  - the first message must be session.start (else `error` + close); reply
//    session.started {session:{id, expires_at, model}};
//  - the timeline runs on input audio: session.usage.updated every second of
//    input; nothing is spoken before `greetAfterMs` of input;
//  - after that it speaks `outputPcm` as session.output_audio.delta (100 ms
//    chunks, paced in real time) with an output transcript;
//  - input speech (frames with peak > `speechPeak`) followed by `endSilenceMs`
//    of quiet produces session.input_transcript.delta (`userText`) and, when
//    `delegate` is set, session.delegation.created;
//  - instructions/thinking/commentary appends are acknowledged (…appended);
//  - input_audio.mute/unmute → …muted/unmuted; session.close → session.closed.
import http from "node:http";
import { acceptUpgrade, rejectUpgrade } from "../../daemon/wsserver.js";

export async function startFakeLiveServer({
  key = "sk-test-key", outputPcm = null, greetText = "Hi, I'm listening.", greetAfterMs = 200,
  userText = "List the files in the daemon folder.", delegate = true, speechPeak = 1000, endSilenceMs = 600,
  chunkMs = 100,
} = {}) {
  const sessions = [];
  let n = 0;
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    if (!/\/live\/sessions$/.test(new URL(req.url, "http://x").pathname)) return rejectUpgrade(socket, 404, "not_found");
    if (req.headers.authorization !== `Bearer ${key}`) return rejectUpgrade(socket, 403, "invalid_api_key");
    // The OpenAI endpoint accepts unmasked-server/masked-client like any server.
    const ws = acceptUpgrade(req, socket, head, {});
    if (!ws) return;
    const s = {
      id: `live_fake_${++n}`, ws, events: [], started: false, closed: false, start: null,
      inputFrames: 0, inputBytes: 0, inputMs: 0, speaking: false, heardSpeech: false, quietMs: 0, greeted: false,
      outputTimer: null, outputBytes: 0, muted: false,
    };
    sessions.push(s);
    const send = (obj) => { if (!s.closed) ws.sendText(JSON.stringify(obj)); };
    s.send = send;
    const speak = (pcm, text) => {
      if (!pcm || !pcm.length) { if (text) send({ type: "session.output_transcript.delta", delta: text, start_ms: s.inputMs, end_ms: s.inputMs + 500 }); return; }
      const bytes = Math.round((24000 * 2 * chunkMs) / 1000);
      let off = 0;
      if (text) send({ type: "session.output_transcript.delta", delta: text, start_ms: s.inputMs, end_ms: s.inputMs + Math.round((pcm.length / 48000) * 1000) });
      clearInterval(s.outputTimer);
      s.outputTimer = setInterval(() => {
        if (s.closed || off >= pcm.length) { clearInterval(s.outputTimer); s.outputTimer = null; return; }
        const part = pcm.subarray(off, off + bytes);
        off += bytes;
        s.outputBytes += part.length;
        send({ type: "session.output_audio.delta", delta: part.toString("base64") });
      }, chunkMs);
    };
    s.speak = speak;
    const close = (reason = "close_requested") => {
      if (s.closed) return;
      send({ type: "session.closed", reason, usage: { seconds: Math.round(s.inputMs / 100) / 10 } });
      s.closed = true;
      clearInterval(s.outputTimer);
      ws.close(1000, "");
    };
    s.close = close;
    ws.on("text", (txt) => {
      let e;
      try { e = JSON.parse(txt); } catch { return; }
      if (e.type !== "session.input_audio.append") s.events.push(e);
      if (!s.started) {
        if (e.type !== "session.start") { send({ type: "error", error: { code: "session_not_started", message: "send session.start first" } }); ws.close(1008, ""); return; }
        s.started = true;
        s.start = e.session;
        send({ type: "session.started", session: { id: s.id, expires_at: Math.floor(Date.now() / 1000) + 7200, status: "active", model: e.session?.model } });
        return;
      }
      switch (e.type) {
        case "session.input_audio.append": {
          const pcm = Buffer.from(String(e.audio || ""), "base64");
          s.inputFrames++;
          s.inputBytes += pcm.length;
          const before = s.inputMs;
          s.inputMs = Math.round((s.inputBytes / 48000) * 1000);
          if (Math.floor(before / 1000) !== Math.floor(s.inputMs / 1000)) send({ type: "session.usage.updated", usage: { seconds: Math.floor(s.inputMs / 1000) } });
          if (!s.greeted && s.inputMs >= greetAfterMs) { s.greeted = true; speak(outputPcm, greetText); }
          let peak = 0;
          for (let i = 0; i + 1 < pcm.length; i += 2) { const v = Math.abs(pcm.readInt16LE(i)); if (v > peak) peak = v; }
          const ms = (pcm.length / 48000) * 1000;
          if (!s.muted && peak > speechPeak) { s.speaking = true; s.quietMs = 0; }
          else if (s.speaking) {
            s.quietMs += ms;
            if (s.quietMs >= endSilenceMs) {
              s.speaking = false;
              s.heardSpeech = true;
              send({ type: "session.input_transcript.delta", delta: userText, start_ms: Math.max(0, s.inputMs - 2000), end_ms: s.inputMs });
              if (delegate) send({ type: "session.delegation.created", delegation: { id: `del_${s.id}_${s.inputFrames}`, target: "client" }, offset_ms: s.inputMs });
            }
          }
          break;
        }
        case "session.instructions.append":
        case "session.thinking.append":
        case "session.commentary.append": {
          const kind = e.type.split(".")[1];
          send({ type: `session.${kind}.appended`, client_event_id: e.event_id, start_ms: s.inputMs });
          if (kind === "commentary") speak(null, e.content);
          break;
        }
        case "session.input_audio.mute": s.muted = true; send({ type: "session.input_audio.muted", client_event_id: e.event_id }); break;
        case "session.input_audio.unmute": s.muted = false; send({ type: "session.input_audio.unmuted", client_event_id: e.event_id }); break;
        case "session.close": close("close_requested"); break;
        default: break;
      }
    });
    ws.on("close", () => { s.closed = true; clearInterval(s.outputTimer); });
    ws.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    port,
    base: `http://127.0.0.1:${port}/v1`,
    sessions,
    last: () => sessions[sessions.length - 1],
    async close() {
      for (const s of sessions) { clearInterval(s.outputTimer); if (!s.closed) try { s.ws.close(1001, ""); } catch { /* ignore */ } }
      await new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
      for (const s of sessions) { try { s.ws.socket.destroy(); } catch { /* ignore */ } }
    },
  };
}
