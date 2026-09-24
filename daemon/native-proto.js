// Native app link protocol (docs/NATIVE.md): constants, the binary audio
// frame codec and the message-name tables. Pure; shared by daemon/native.js
// (the endpoint), daemon/native-session.js (the session driver glue) and the
// tests. The Swift side mirrors this file in
// app-native/Sources/SottoClient/Protocol.swift; the golden vectors in
// test/daemon/native-proto.test.js pin both.

/** Bump on any incompatible change to frames or messages. */
export const PROTOCOL = 1;
/** WebSocket upgrade path on the daemon's HTTP port (loopback only). */
export const NATIVE_PATH = "/api/native";
/** Sec-WebSocket-Protocol value; the daemon echoes it back. */
export const SUBPROTOCOL = "sotto-native.v1";

export const SAMPLE_RATE = 24000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (SAMPLE_RATE / 1000) * FRAME_MS; // 480
export const FRAME_BYTES = FRAME_SAMPLES * 2; // 960, PCM16LE mono
export const HEADER_BYTES = 16;
/** Largest binary or text frame either side accepts (bytes). */
export const MAX_MESSAGE_BYTES = 1 << 20;

export const KIND = Object.freeze({ MIC: 1, SPEAKER: 2 });
export const FLAG = Object.freeze({
  /** mic: the payload is zeros because the user is muted (never mic data). */
  MUTED: 0x01,
  /** mic: synthetic input (test fixture / fake audio). */
  FAKE: 0x02,
  /** speaker: first frame after an audio_flush (start a fresh jitter buffer). */
  AFTER_FLUSH: 0x01,
});

/** WebSocket close codes the endpoint uses (4000-4999 are application codes). */
export const CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_MISMATCH: 4001,
  REPLACED: 4002,
  HELLO_TIMEOUT: 4003,
  BAD_MESSAGE: 4004,
  DAEMON_EXIT: 4005,
});

/** Text message types, daemon -> app. */
export const SERVER_TYPES = Object.freeze([
  "welcome", "status", "settings", "activity", "delegation", "notice", "notice_clear",
  "result_pending", "wake_heard", "command", "caption", "live", "audio_flush", "ping", "result",
]);
/** Text message types, app -> daemon. */
export const CLIENT_TYPES = Object.freeze([
  "hello", "cmd", "route", "audio_stats", "pong", "played", "log", "system", "mic_error", "mic_silent", "activity",
]);
/** `cmd` names (app -> daemon); each is answered by one `result` with the same id. */
export const COMMANDS = Object.freeze([
  "mute", "pause", "resume", "wake", "end", "set_voice", "set_persona", "set_policy", "set_wake", "set_window",
  "key_save", "key_remove", "get_voices", "echo_test", "open_browser",
]);
/** Live server events forwarded as {type:"live", event} (transcript deltas go as `caption`). */
export const LIVE_FORWARD = Object.freeze([
  "session.started", "session.closed", "session.input_audio.muted", "session.input_audio.unmuted",
  "session.usage.updated", "error", "info",
]);

/**
 * Encode one audio frame: u8 kind | u8 flags | u16 reserved(0) | u32 seq LE |
 * u64 timestamp ns LE | PCM16LE mono 24 kHz. `pcm` is a Buffer/Uint8Array of
 * even length; `tsNs` a BigInt (or number) nanoseconds.
 */
export function encodeFrame({ kind, flags = 0, seq, tsNs = 0n, pcm }) {
  const body = pcm instanceof Uint8Array ? pcm : Buffer.alloc(0);
  if (body.length % 2) throw new Error("pcm length must be even");
  const out = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  out.writeUInt8(kind & 0xff, 0);
  out.writeUInt8(flags & 0xff, 1);
  out.writeUInt16LE(0, 2);
  out.writeUInt32LE(seq >>> 0, 4);
  out.writeBigUInt64LE(BigInt.asUintN(64, BigInt(tsNs)), 8);
  out.set(body, HEADER_BYTES);
  return out;
}

/** Decode a binary frame; null when malformed. `pcm` is a view (no copy). */
export function decodeFrame(buf) {
  if (!(buf instanceof Uint8Array) || buf.length < HEADER_BYTES || (buf.length - HEADER_BYTES) % 2) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.length);
  const kind = b.readUInt8(0);
  if (kind !== KIND.MIC && kind !== KIND.SPEAKER) return null;
  return {
    kind,
    flags: b.readUInt8(1),
    seq: b.readUInt32LE(4),
    tsNs: b.readBigUInt64LE(8),
    pcm: b.subarray(HEADER_BYTES),
  };
}

/**
 * Re-chunk arbitrary PCM16 byte runs into FRAME_BYTES frames. push() returns
 * the complete frames; flush({pad}) returns the remainder (zero-padded to a
 * full frame when pad is true) and resets.
 */
export function createRechunker(frameBytes = FRAME_BYTES) {
  let rest = Buffer.alloc(0);
  return {
    push(chunk) {
      const all = rest.length ? Buffer.concat([rest, chunk]) : Buffer.from(chunk);
      const frames = [];
      let off = 0;
      for (; off + frameBytes <= all.length; off += frameBytes) frames.push(all.subarray(off, off + frameBytes));
      rest = Buffer.from(all.subarray(off));
      return frames;
    },
    flush({ pad = true } = {}) {
      if (!rest.length) return [];
      const f = pad ? Buffer.concat([rest, Buffer.alloc(frameBytes - rest.length)]) : rest;
      rest = Buffer.alloc(0);
      return [f];
    },
    get pending() { return rest.length; },
  };
}
