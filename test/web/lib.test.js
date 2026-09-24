// Unit tests for web/lib.js (SPEC §11.3). Pure functions only; no DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as lib from "../../web/lib.js";

const frag = (role, text, start_ms, end_ms, session = "s1") => ({ role, text, start_ms, end_ms, session });

test("reduceCaptions merges same-role fragments within 1500 ms", () => {
  let lines = [];
  lines = lib.reduceCaptions(lines, frag("user", "What is", 1000, 1200));
  lines = lib.reduceCaptions(lines, frag("user", " the branch", 1200, 1400));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "What is the branch");
  assert.equal(lines[0].end_ms, 1400);
  // exactly 1500 ms gap still merges
  lines = lib.reduceCaptions(lines, frag("user", "?", 2900, 3000));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "What is the branch?");
});

test("reduceCaptions splits on role change, gap > 1500 ms, and new session", () => {
  let lines = [];
  lines = lib.reduceCaptions(lines, frag("user", "Hi", 0, 200));
  lines = lib.reduceCaptions(lines, frag("assistant", " Hello there", 300, 800));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].role, "assistant");
  assert.equal(lines[1].text, "Hello there", "leading space trimmed on a new line");
  lines = lib.reduceCaptions(lines, frag("assistant", "Anything else?", 2301, 2600));
  assert.equal(lines.length, 3, "1501 ms gap splits");
  // a new Live session restarts the timeline at 0; it must not merge backwards
  lines = lib.reduceCaptions(lines, frag("assistant", "I'm back.", 0, 500, "s2"));
  assert.equal(lines.length, 4);
});

test("reduceCaptions does not mutate its input and ignores empty deltas", () => {
  const a = lib.reduceCaptions([], frag("user", "one", 0, 100));
  const snapshot = JSON.stringify(a);
  const b = lib.reduceCaptions(a, frag("user", " two", 100, 200));
  assert.equal(JSON.stringify(a), snapshot);
  assert.notEqual(a, b);
  assert.equal(lib.reduceCaptions(b, frag("user", "", 200, 300)), b);
  assert.equal(lib.reduceCaptions(b, null), b);
});

test("reduceCaptions keeps at most 60 lines (newest)", () => {
  let lines = [];
  for (let i = 0; i < 75; i++) {
    lines = lib.reduceCaptions(lines, frag(i % 2 ? "assistant" : "user", `line ${i}`, i * 5000, i * 5000 + 100));
  }
  assert.equal(lines.length, 60);
  assert.equal(lib.MAX_CAPTION_LINES, 60);
  assert.equal(lines[0].text, "line 15");
  assert.equal(lines[59].text, "line 74");
});

test("speakerLabel", () => {
  assert.equal(lib.speakerLabel("user"), "You");
  assert.equal(lib.speakerLabel("assistant"), "Sotto");
});

const devs = (...list) => list.map(([deviceId, label, kind = "audioinput"]) => ({ deviceId, label, kind, groupId: "" }));

test("pickInputDevice prefers a saved id that still exists", () => {
  const d = devs(["default", "Default - AirPods Max"], ["air", "AirPods Max"], ["mbp", "MacBook Pro Microphone"], ["usb", "USB Mic"]);
  assert.deepEqual(lib.pickInputDevice(d, "usb"), { deviceId: "usb", rule: "saved", hint: null });
  // saved id gone -> falls through to the rules
  assert.equal(lib.pickInputDevice(d, "gone").rule, "builtin");
});

test("pickInputDevice avoids a Bluetooth default in favour of the built-in mic", () => {
  const d = devs(
    ["default", "Default - AirPods Max"],
    ["air", "AirPods Max"],
    ["spk", "MacBook Pro Speakers", "audiooutput"],
    ["mbp", "MacBook Pro Microphone"],
  );
  const pick = lib.pickInputDevice(d, null);
  assert.equal(pick.deviceId, "mbp");
  assert.equal(pick.rule, "builtin");
  assert.equal(pick.hint, "Using the built-in mic so your headphones keep high-quality audio.");
  for (const label of ["Bose QC Bluetooth", "Jabra Headset", "Hands-Free Link", "Galaxy Buds2"]) {
    const p = lib.pickInputDevice(devs(["default", `Default - ${label}`], ["x", label], ["b", "Built-in Microphone"]), null);
    assert.equal(p.deviceId, "b", label);
  }
});

test("pickInputDevice falls back to the default", () => {
  // default is already built-in
  const a = lib.pickInputDevice(devs(["default", "Default - MacBook Pro Microphone"], ["mbp", "MacBook Pro Microphone"]), null);
  assert.deepEqual(a, { deviceId: "default", rule: "default", hint: null });
  // Bluetooth default but no built-in mic available
  const b = lib.pickInputDevice(devs(["default", "Default - AirPods"], ["air", "AirPods"]), null);
  assert.equal(b.deviceId, "default");
  assert.equal(b.rule, "default");
  // no "default" pseudo device: the first input is the default
  const c = lib.pickInputDevice(devs(["usb", "USB Mic"], ["mbp", "MacBook Pro Microphone"]), undefined);
  assert.equal(c.deviceId, "usb");
  // no inputs at all
  assert.deepEqual(lib.pickInputDevice([], null), { deviceId: null, rule: "none", hint: null });
  assert.deepEqual(lib.pickInputDevice(devs(["spk", "Speakers", "audiooutput"]), null).rule, "none");
});

test("pickOutputDevice keeps an existing saved speaker, else system default", () => {
  const d = devs(["default", "Default - AirPods", "audiooutput"], ["air", "AirPods", "audiooutput"], ["mic", "Mic"]);
  assert.equal(lib.pickOutputDevice(d, "air"), "air");
  assert.equal(lib.pickOutputDevice(d, "mic"), "", "an input id is not a speaker");
  assert.equal(lib.pickOutputDevice(d, null), "");
});

test("deviceLabel falls back when labels are hidden", () => {
  assert.equal(lib.deviceLabel({ deviceId: "x", label: "USB Mic", kind: "audioinput" }), "USB Mic");
  assert.equal(lib.deviceLabel({ deviceId: "default", label: "", kind: "audioinput" }), "System default");
  assert.equal(lib.deviceLabel({ deviceId: "y", label: "", kind: "audiooutput" }, 1), "Speaker 2");
});

test("statusLabel covers every state", () => {
  const expected = {
    off: "Off",
    waiting_page: "Opening",
    connecting: "Connecting",
    live: "Live",
    paused: "Paused",
    sleeping: "Sleeping",
    reconnecting: "Reconnecting",
    closing: "Closing",
  };
  for (const [state, label] of Object.entries(expected)) assert.equal(lib.statusLabel(state), label);
  assert.deepEqual([...lib.KNOWN_STATES].sort(), Object.keys(expected).sort());
  assert.equal(lib.statusLabel("some_new_state"), "Some new state");
  assert.equal(lib.statusLabel(undefined), "Unknown");
});

test("formatDuration is whole, human units", () => {
  assert.equal(lib.formatDuration(0), "0 min");
  assert.equal(lib.formatDuration(-5), "0 min");
  assert.equal(lib.formatDuration(NaN), "0 min");
  assert.equal(lib.formatDuration(1), "under a minute");
  assert.equal(lib.formatDuration(59.9), "under a minute");
  assert.equal(lib.formatDuration(60), "1 min");
  assert.equal(lib.formatDuration(852), "14 min");
  assert.equal(lib.formatDuration(3599), "59 min");
  assert.equal(lib.formatDuration(3600), "1 hr");
  assert.equal(lib.formatDuration(3900), "1 hr 5 min");
  assert.equal(lib.formatDuration(7200), "2 hr");
  assert.equal(lib.formatDuration(0, { long: true }), "0 minutes");
  assert.equal(lib.formatDuration(60, { long: true }), "1 minute");
  assert.equal(lib.formatDuration(300, { long: true }), "5 minutes");
  assert.equal(lib.formatDuration(3660, { long: true }), "1 hour 1 minute");
  assert.equal(lib.formatDuration(7200, { long: true }), "2 hours");
});

test("formatMoney / formatCost / formatUsage", () => {
  assert.equal(lib.formatMoney(0), "$0.00");
  assert.equal(lib.formatMoney(0.004), "<$0.01");
  assert.equal(lib.formatMoney(0.075), "$0.08");
  assert.equal(lib.formatMoney(12.5), "$12.50");
  assert.equal(lib.formatCost(852), "$0.71");
  assert.equal(lib.formatCost(3), "<$0.01");
  assert.equal(lib.formatCost(7200), "$6.00");
  assert.equal(lib.formatUsage(852), "14 min · $0.71");
  assert.equal(lib.formatUsage(90), "1 min · $0.08");
  assert.equal(lib.formatUsage(20), "under a minute · $0.02");
  assert.equal(lib.formatUsage(0), "0 min · $0.00");
  assert.equal(lib.formatUsage(3900), "1 hr 5 min · $3.25");
});

test("stableUsage holds the reading for 10 s unless the minute or the day changes", () => {
  let r = lib.stableUsage(null, 852, 0);
  assert.deepEqual(r, { seconds: 852, at: 0 });
  assert.equal(lib.stableUsage(r, 855, 3000), r, "same minute, 3 s later: held");
  assert.deepEqual(lib.stableUsage(r, 858, 10_000), { seconds: 858, at: 10_000 }, "10 s later: updates");
  r = lib.stableUsage(null, 895, 0);
  assert.deepEqual(lib.stableUsage(r, 901, 500), { seconds: 901, at: 500 }, "minute changed: updates at once");
  assert.deepEqual(lib.stableUsage(r, 4, 500), { seconds: 4, at: 500 }, "day rolled over: updates at once");
});

test("sessionText", () => {
  assert.equal(lib.sessionText(0), "session just started");
  assert.equal(lib.sessionText(42_000), "session just started");
  assert.equal(lib.sessionText(60_000), "1 min this session");
  assert.equal(lib.sessionText(3_900_000), "1 hr 5 min this session");
});

test("todaySeconds adds only data-channel usage beyond what the daemon counted", () => {
  const status = { today: { seconds: 100 }, live: { session_id: "live_1", usage_seconds: 20 } };
  assert.equal(lib.todaySeconds(status, 30, "live_1"), 110);
  assert.equal(lib.todaySeconds(status, 10, "live_1"), 100, "stale dc figure never lowers the total");
  assert.equal(lib.todaySeconds(status, 30, "live_other"), 100, "different session ignored");
  assert.equal(lib.todaySeconds({ today: { seconds: 5 }, live: null }, 30, "live_1"), 5);
  assert.equal(lib.todaySeconds(null), 0);
});

test("connectReason", () => {
  assert.equal(lib.connectReason("paused"), "resume");
  assert.equal(lib.connectReason("waiting_page"), "start");
  assert.equal(lib.connectReason(undefined), "start");
  assert.equal(lib.connectReason("reconnecting"), "reconnect");
  assert.equal(lib.connectReason("sleeping"), "resume", "Space / Wake now from sleep");
  assert.equal(lib.connectReason("sleeping", "notify"), "notify", "the daemon woke the session to speak");
  assert.equal(lib.connectReason("paused", "on"), "resume");
});

test("delegation labels and upsert keep the newest 3", () => {
  for (const s of ["collecting", "sent", "delivered", "held_suspected", "answered", "answered_stale", "superseded", "dropped_echo", "dropped_empty", "failed", "orphaned"]) {
    const { label, tone } = lib.delegationLabel(s);
    assert.ok(label && !label.includes("_"), s);
    assert.match(tone, /^(active|warn|done|muted|error)$/);
  }
  let list = [];
  list = lib.upsertDelegation(list, { id: "a", status: "collecting", text: "" });
  list = lib.upsertDelegation(list, { id: "a", status: "sent", text: "what branch" });
  list = lib.upsertDelegation(list, { id: "b", status: "sent", text: "run tests" });
  list = lib.upsertDelegation(list, { id: "a", status: "answered" });
  assert.deepEqual(list[0], { id: "a", status: "answered", text: "what branch" });
  list = lib.upsertDelegation(list, { id: "c", status: "sent", text: "c" });
  list = lib.upsertDelegation(list, { id: "d", status: "sent", text: "d" });
  assert.deepEqual(list.map((d) => d.id), ["d", "c", "a"]);
  assert.equal(lib.upsertDelegation(list, { status: "x" }), list, "no id -> unchanged");
});

test("closed reasons, mic errors, paused messages", () => {
  assert.equal(lib.closedReasonMessage("content"), "The voice session was ended by a safety filter.");
  assert.equal(lib.closedReasonMessage("close_requested"), null);
  assert.ok(lib.closedReasonMessage("weird").includes("weird"));
  assert.match(lib.micErrorMessage("NotAllowedError"), /Allow the microphone in Chrome settings/);
  assert.ok(lib.micErrorMessage("Nope"));
  assert.equal(lib.pausedMessage("idle", 5), "Paused after 5 minutes of silence");
  assert.equal(lib.pausedMessage("idle", 1), "Paused after 1 minute of silence");
  assert.equal(lib.pausedMessage("idle", 1, 60), "Paused after 1 minute of silence");
  assert.equal(lib.pausedMessage("idle", 1, 90), "Paused after 90 seconds of silence");
  assert.equal(lib.pausedMessage("idle", 5, 300), "Paused after 5 minutes of silence");
  assert.equal(lib.pausedMessage("idle", 5, 150), "Paused after 3 minutes of silence", "no decimal minutes");
  assert.equal(lib.pausedMessage("idle", 90), "Paused after 1 hour 30 minutes of silence");
  assert.equal(lib.pausedMessage(null), "Paused");
  assert.match(lib.pausedMessage("daily_cap"), /limit/);
});

test("errorBannerText only for errors without a client_event_id", () => {
  assert.equal(lib.errorBannerText({ type: "error", error: { message: "boom" } }), "boom");
  assert.equal(lib.errorBannerText({ type: "error", error: { message: "x", client_event_id: "clv_1" } }), null);
  assert.equal(lib.errorBannerText({ type: "error", client_event_id: "clv_1", error: { message: "x" } }), null);
  assert.equal(lib.errorBannerText({ type: "info" }), null);
});

test("activityView maps SSE activity kinds", () => {
  assert.deepEqual(lib.activityView({ kind: "tool", text: "running the tests" }), {
    text: "Claude: running the tests",
    busy: true,
    summary: null,
    tone: "work",
  });
  const end = lib.activityView({ kind: "turn_end", text: "All 12 tests pass." });
  assert.equal(end.text, "Claude finished");
  assert.equal(end.busy, false);
  assert.equal(end.summary, "All 12 tests pass.");
  assert.equal(lib.activityView({ kind: "permission", text: "run a shell command" }).tone, "attention");
  assert.equal(lib.activityView({ kind: "turn_start" }).busy, true);
});

test("hotkeyAction", () => {
  const live = { live: true, paused: false };
  const paused = { live: false, paused: true };
  assert.equal(lib.hotkeyAction({ key: "m", code: "KeyM", targetTag: "BODY" }, live), "mute");
  assert.equal(lib.hotkeyAction({ key: "M", targetTag: "BODY" }, live), "mute");
  assert.equal(lib.hotkeyAction({ key: " ", code: "Space", targetTag: "BODY" }, live), "mute");
  assert.equal(lib.hotkeyAction({ key: " ", code: "Space", targetTag: "BODY" }, paused), "resume");
  assert.equal(lib.hotkeyAction({ key: "m", targetTag: "BODY" }, paused), null, "M does nothing while paused");
  assert.equal(lib.hotkeyAction({ key: "m", targetTag: "BODY" }, { live: false, paused: true, sleeping: true }), "mute", "M mutes wake listening while sleeping");
  assert.equal(lib.hotkeyAction({ key: " ", code: "Space", targetTag: "BODY" }, { live: false, paused: true, sleeping: true }), "resume");
  assert.equal(lib.hotkeyAction({ key: "m", targetTag: "SELECT" }, live), null, "ignored in a select");
  assert.equal(lib.hotkeyAction({ key: " ", targetTag: "SELECT" }, paused), null);
  assert.equal(lib.hotkeyAction({ key: " ", targetTag: "BUTTON" }, live), null, "a focused button handles Space itself");
  assert.equal(lib.hotkeyAction({ key: "m", targetTag: "BODY", meta: true }, live), null);
  assert.equal(lib.hotkeyAction({ key: "m", targetTag: "BODY", repeat: true }, live), null);
  assert.equal(lib.hotkeyAction({ key: "x", targetTag: "BODY" }, live), null);
});

test("rms and levelFromRms", () => {
  assert.equal(lib.rms(new Float32Array(0)), 0);
  assert.ok(Math.abs(lib.rms(Float32Array.from([0.5, -0.5, 0.5, -0.5])) - 0.5) < 1e-9);
  assert.equal(lib.levelFromRms(0), 0);
  assert.equal(lib.levelFromRms(1), 1);
  assert.equal(lib.levelFromRms(0.001), 0); // -60 dB
  const mid = lib.levelFromRms(0.03);
  assert.ok(mid > 0 && mid < 1);
});

test("activity detector: >300 ms above threshold, at most once per 10 s", () => {
  const d = lib.createActivityDetector({ threshold: 0.02, holdMs: 300, minIntervalMs: 10_000 });
  assert.equal(d.update(0.05, 0), false);
  assert.equal(d.update(0.05, 300), false, "not more than 300 ms yet");
  assert.equal(d.update(0.05, 301), true);
  assert.equal(d.update(0.05, 2000), false, "rate limited");
  assert.equal(d.update(0.0, 2100), false);
  assert.equal(d.update(0.05, 10_400), false, "hold restarts after silence");
  assert.equal(d.update(0.05, 10_800), true);
  // brief blips never fire
  const e = lib.createActivityDetector();
  for (let t = 0; t < 5000; t += 200) {
    assert.equal(e.update(t % 400 === 0 ? 0.1 : 0, t), false);
  }
});

test("backoffDelay caps at 5 s", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 10].map(lib.backoffDelay), [500, 1000, 2000, 4000, 5000, 5000]);
});

test("parseEventData and truncate", () => {
  assert.deepEqual(lib.parseEventData('{"type":"status","status":{}}'), { type: "status", status: {} });
  assert.equal(lib.parseEventData("not json"), null);
  assert.equal(lib.parseEventData("[1,2]"), null);
  assert.equal(lib.truncate("short"), "short");
  const t = lib.truncate("word ".repeat(100), 40);
  assert.ok(t.length <= 40 && t.endsWith("…"));
});
