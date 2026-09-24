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
  assert.deepEqual(lib.pickInputDevice(d, "usb"), { deviceId: "usb", rule: "saved", hint: null, label: "USB Mic", savedMissing: false });
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
  assert.deepEqual(a, { deviceId: "default", rule: "default", hint: null, label: "MacBook Pro Microphone", savedMissing: false });
  // Bluetooth default but no built-in mic available
  const b = lib.pickInputDevice(devs(["default", "Default - AirPods"], ["air", "AirPods"]), null);
  assert.equal(b.deviceId, "default");
  assert.equal(b.rule, "default");
  // no "default" pseudo device: the built-in mic, else the first plain input
  const c = lib.pickInputDevice(devs(["usb", "USB Mic"], ["mbp", "MacBook Pro Microphone"]), undefined);
  assert.equal(c.deviceId, "mbp");
  assert.equal(c.rule, "builtin");
  assert.equal(lib.pickInputDevice(devs(["cam", "OBSBOT Meet 2 Microphone"], ["usb", "USB Mic"]), null).deviceId, "usb");
  // no inputs at all
  assert.deepEqual(lib.pickInputDevice([], null), { deviceId: null, rule: "none", hint: null, label: "", savedMissing: false });
  assert.deepEqual(lib.pickInputDevice(devs(["spk", "Speakers", "audiooutput"]), null).rule, "none");
});

// The live case (2026-09-24): Chrome's own device ranking put the webcam first,
// the macOS default was the MacBook mic, and AirPods were connected too.
const LIVE_2026_09_24 = [
  ["default", "Default - MacBook Pro Microphone (Built-in)"],
  ["cam", "OBSBOT Meet 2 Microphone (3564:fefb)"],
  ["mbp", "MacBook Pro Microphone (Built-in)"],
  ["phone", "Chad\u2019s iPhone Microphone"],
  ["teams", "Microsoft Teams Audio Device (Virtual)"],
  ["zoom", "ZoomAudioDevice (Virtual)"],
  ["air", "AirPods Pro"],
];

test("pickInputDevice follows the macOS default by id, never Chrome's ranking (webcam first)", () => {
  const p = lib.pickInputDevice(devs(...LIVE_2026_09_24), null);
  assert.equal(p.deviceId, "default", "opened as exact 'default', not by leaving deviceId out");
  assert.equal(p.rule, "default");
  assert.equal(p.label, "MacBook Pro Microphone (Built-in)");
  // A remembered "System default" choice resolves the same way.
  const s = lib.pickInputDevice(devs(...LIVE_2026_09_24), "default");
  assert.deepEqual([s.deviceId, s.rule, s.label], ["default", "saved", "MacBook Pro Microphone (Built-in)"]);
  // An explicit webcam choice is respected.
  assert.equal(lib.pickInputDevice(devs(...LIVE_2026_09_24), "cam").deviceId, "cam");
});

test("pickInputDevice: AirPods as the default go to the built-in mic, not the webcam", () => {
  const list = LIVE_2026_09_24.map(([id, label]) => (id === "default" ? [id, "Default - AirPods Pro"] : [id, label]));
  const p = lib.pickInputDevice(devs(...list), null);
  assert.deepEqual([p.deviceId, p.rule, p.label], ["mbp", "builtin", "MacBook Pro Microphone (Built-in)"]);
});

test("pickInputDevice: a remembered mic that is gone falls back by the rules and says so", () => {
  const p = lib.pickInputDevice(devs(...LIVE_2026_09_24), "usb-gone");
  assert.equal(p.deviceId, "default");
  assert.equal(p.savedMissing, true);
  assert.match(p.hint, /isn't connected/);
  // No system default known (no pseudo device): built-in beats webcam, phone and virtual devices.
  const noDefault = LIVE_2026_09_24.filter(([id]) => id !== "default");
  const q = lib.pickInputDevice(devs(...noDefault), "usb-gone");
  assert.deepEqual([q.deviceId, q.rule, q.savedMissing], ["mbp", "builtin", true]);
  const r = lib.pickInputDevice(devs(...noDefault.filter(([id]) => id !== "mbp")), null);
  assert.equal(r.deviceId, "air", "virtual, phone and webcam mics are avoided; only the headset is left");
});

test("isAvoidedLabel and inputOptionLabel", () => {
  for (const l of ["OBSBOT Meet 2 Microphone (3564:fefb)", "ZoomAudioDevice (Virtual)", "Microsoft Teams Audio Device (Virtual)", "Chad's iPhone Microphone", "BlackHole 2ch", "Logitech BRIO"]) assert.ok(lib.isAvoidedLabel(l), l);
  for (const l of ["MacBook Pro Microphone (Built-in)", "Shure MV7", "USB Audio CODEC"]) assert.ok(!lib.isAvoidedLabel(l), l);
  assert.equal(lib.inputOptionLabel({ deviceId: "default", label: "Default - MacBook Pro Microphone", kind: "audioinput" }), "System default (MacBook Pro Microphone)");
  assert.equal(lib.inputOptionLabel({ deviceId: "default", label: "", kind: "audioinput" }), "System default");
  assert.equal(lib.inputOptionLabel({ deviceId: "x", label: "USB Mic", kind: "audioinput" }), "USB Mic");
});

test("hearing monitor: a silent mic is reported once, 20 s after going live", () => {
  const h = lib.createHearingMonitor();
  let t = 0;
  h.start(t);
  let fired = null;
  for (; t <= 25_000 && !fired; t += 50) fired = h.sample({ rms: 0.0005, now: t });
  assert.equal(fired?.kind, "silent");
  assert.ok(t >= 20_000 && t <= 20_100, String(t));
  assert.equal(h.sample({ rms: 0, now: t + 50 }), null, "once per start");
  h.start(t);
  assert.equal(h.fired, null, "a new session or mic re-arms it");
});

test("hearing monitor: muted time does not count; a working quiet mic is not 'silent'", () => {
  const h = lib.createHearingMonitor();
  h.start(0);
  let t = 0;
  for (; t < 30_000; t += 50) assert.equal(h.sample({ rms: 0, muted: true, now: t }), null);
  // Unmuted: a fresh 20 s window.
  let fired = null;
  for (; t < 49_000; t += 50) fired ||= h.sample({ rms: 0.0005, now: t });
  assert.equal(fired, null);
  // Room noise above the floor once: the mic works.
  const g = lib.createHearingMonitor();
  g.start(0);
  for (t = 0; t < 60_000; t += 50) fired ||= g.sample({ rms: t === 1000 ? 0.01 : 0.0015, now: t });
  assert.equal(fired, null);
  // The user was heard: never "silent".
  const k = lib.createHearingMonitor();
  k.start(0);
  k.heard(3000);
  for (t = 0; t < 60_000; t += 50) fired ||= k.sample({ rms: 0.0005, now: t });
  assert.equal(fired, null);
});

test("hearing monitor: sound at the mic but no transcript for 40 s", () => {
  const h = lib.createHearingMonitor();
  h.start(0);
  let fired = null;
  let t = 0;
  // Talking (0.03 rms) half the time; the assistant's voice does not count.
  for (; t < 60_000 && !fired; t += 50) fired = h.sample({ rms: Math.floor(t / 1000) % 2 ? 0.03 : 0.004, voice: t < 10_000 ? 0.5 : 0, now: t });
  assert.equal(fired?.kind, "no_transcript");
  assert.ok(t >= 40_000, String(t));
  assert.ok(fired.speech_ms >= 6000);
  // A transcript keeps arriving: never fires.
  const g = lib.createHearingMonitor();
  g.start(0);
  let f2 = null;
  for (t = 0; t < 120_000; t += 50) {
    if (t % 10_000 === 0) g.heard(t);
    f2 ||= g.sample({ rms: 0.03, now: t });
  }
  assert.equal(f2, null);
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
  for (const s of ["collecting", "sent", "delivered", "held_suspected", "answered", "answered_stale", "superseded", "dropped_echo", "dropped_empty", "mirrored", "failed", "orphaned"]) {
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

test("shouldReloadForBuild: only a known build that changed, with no session up (§6.17)", () => {
  assert.equal(lib.shouldReloadForBuild(null, "b1", false), false, "first bootstrap");
  assert.equal(lib.shouldReloadForBuild("b1", "b1", false), false, "same page");
  assert.equal(lib.shouldReloadForBuild("b1", "b2", false), true);
  assert.equal(lib.shouldReloadForBuild("b1", "b2", true), false, "a live session is never dropped for a reload");
  assert.equal(lib.shouldReloadForBuild("b1", null, false), false, "an older daemon without builds");
});

test("reloadUrl drops autostart and keeps the rest", () => {
  assert.equal(lib.reloadUrl("/", "?autostart=1"), "/");
  assert.equal(lib.reloadUrl("/", "?autostart=1&x=2"), "/?x=2");
  assert.equal(lib.reloadUrl("/index.html", ""), "/index.html");
  assert.equal(lib.reloadUrl("", "?y=1"), "/?y=1");
});
