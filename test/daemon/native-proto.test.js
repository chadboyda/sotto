import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL, NATIVE_PATH, SUBPROTOCOL, FRAME_BYTES, FRAME_SAMPLES, HEADER_BYTES, KIND, FLAG,
  encodeFrame, decodeFrame, createRechunker, COMMANDS, SERVER_TYPES, CLIENT_TYPES,
} from "../../daemon/native-proto.js";

test("protocol constants are the docs/NATIVE.md contract", () => {
  assert.equal(PROTOCOL, 1);
  assert.equal(NATIVE_PATH, "/api/native");
  assert.equal(SUBPROTOCOL, "sotto-native.v1");
  assert.equal(FRAME_SAMPLES, 480);
  assert.equal(FRAME_BYTES, 960);
  assert.equal(HEADER_BYTES, 16);
  assert.ok(COMMANDS.includes("mute") && COMMANDS.includes("key_save"));
  // Mirrored by app-native/Tests/SottoClientTests/MessageTests.swift testEveryCommandNameEncodes.
  assert.deepEqual([...COMMANDS], ["mute", "pause", "resume", "wake", "end", "set_voice", "set_persona", "set_policy", "set_wake", "set_cap",
    "set_window", "key_save", "key_remove", "get_voices", "echo_test", "open_browser"]);
  assert.ok(SERVER_TYPES.includes("caption") && CLIENT_TYPES.includes("hello"));
});

// Golden vector, mirrored by app-native/Tests/SottoClientTests/FrameCodecTests.swift.
const GOLDEN_HEX = "0103000007000000efcdab896745230101007fff";

test("encodeFrame matches the golden vector", () => {
  const pcm = Buffer.from([0x01, 0x00, 0x7f, 0xff]); // samples 1, -129
  const f = encodeFrame({ kind: KIND.MIC, flags: FLAG.MUTED | FLAG.FAKE, seq: 7, tsNs: 0x0123456789abcdefn, pcm });
  assert.equal(f.toString("hex"), GOLDEN_HEX);
});

test("decodeFrame round-trips and rejects malformed frames", () => {
  const d = decodeFrame(Buffer.from(GOLDEN_HEX, "hex"));
  assert.equal(d.kind, KIND.MIC);
  assert.equal(d.flags, 3);
  assert.equal(d.seq, 7);
  assert.equal(d.tsNs, 0x0123456789abcdefn);
  assert.deepEqual([...d.pcm], [0x01, 0x00, 0x7f, 0xff]);
  assert.equal(decodeFrame(Buffer.alloc(15)), null);
  assert.equal(decodeFrame(Buffer.alloc(17)), null);
  const bad = Buffer.from(GOLDEN_HEX, "hex"); bad[0] = 9;
  assert.equal(decodeFrame(bad), null);
});

test("rechunker emits full frames and pads the remainder on flush", () => {
  const r = createRechunker(4);
  assert.deepEqual(r.push(Buffer.from([1, 2, 3])), []);
  const out = r.push(Buffer.from([4, 5, 6, 7, 8, 9]));
  assert.deepEqual(out.map((b) => [...b]), [[1, 2, 3, 4], [5, 6, 7, 8]]);
  assert.equal(r.pending, 1);
  assert.deepEqual(r.flush().map((b) => [...b]), [[9, 0, 0, 0]]);
  assert.deepEqual(r.flush(), []);
});
