// The native app's ViewText (app-native/Sources/SottoUI/ViewText.swift) is a port of
// the page's pure view models in web/lib.js and web/wake.js (docs/NATIVE.md §5.4).
// This test pins test/fixtures/native/viewtext.json to what lib.js returns today, and
// the Swift XCTest (ViewTextTests) checks ViewText against the same file, so the two
// cannot drift apart silently. After changing lib.js on purpose, regenerate with
//   SOTTO_UPDATE_FIXTURES=1 node --test test/web/native-viewtext.test.js
// and update the Swift port until `npm run test:native` passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as lib from "../../web/lib.js";
import * as wake from "../../web/wake.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/native/viewtext.json", import.meta.url));

const KEY = (o = {}) => ({ present: false, source: null, file: null, hint: null, label: null, can_change: true, can_remove: false, keychain: true, setup: false, ...o });

const pageInputs = [
  { phase: "boot", state: "off" },
  { phase: "idle", state: "off", unauthorized: true },
  { phase: "replaced", state: "live" },
  { phase: "lost", state: "live" },
  { phase: "closed", state: "off" },
  { phase: "connecting", state: "connecting", micPrompt: true, host: "app" },
  { phase: "connecting", state: "connecting", micPrompt: true },
  { phase: "error", state: "paused", errorCode: "no_api_key", host: "app" },
  { phase: "idle", state: "off", key: KEY({ setup: true }), host: "app" },
  { phase: "error", state: "paused", micFailure: "macos", host: "app" },
  { phase: "error", state: "paused", micFailure: "notfound", host: "app" },
  { phase: "error", state: "off", micFailure: "busy", host: "app" },
  { phase: "error", state: "paused", errorText: "The voice session did not start.", host: "app" },
  { phase: "error", state: "off", host: "app" },
  { phase: "connecting", state: "connecting", connectStage: "network", host: "app" },
  { phase: "connecting", state: "reconnecting", connectReason: "reconnect", host: "app" },
  { phase: "live", state: "live", host: "app" },
  { phase: "live", state: "live", floor: "you", host: "app" },
  { phase: "live", state: "live", floor: "voice", host: "app" },
  { phase: "live", state: "live", muted: true, host: "app" },
  { phase: "live", state: "live", attention: true, host: "app" },
  { phase: "live", state: "live", muted: true, attention: true, host: "app" },
  { phase: "connecting", state: "connecting", attention: true, host: "app" },
  { phase: "idle", state: "off", sseDown: true, host: "app" },
  { phase: "idle", state: "off", host: "app" },
  { phase: "idle", state: "closing", host: "app" },
  { phase: "idle", state: "sleeping", host: "app" },
  { phase: "idle", state: "sleeping", sleep: wake.sleepView({ muted: true }), pendingResult: "Done.", host: "app" },
  { phase: "idle", state: "paused", pausedReason: "idle", idleMinutes: 5, pendingResult: "Done.", host: "app" },
  { phase: "idle", state: "paused", pausedReason: "idle", idleSeconds: 45, host: "app" },
  { phase: "idle", state: "paused", lastError: { code: "daily_cap" }, capMinutes: 120, host: "app" },
  { phase: "idle", state: "paused", lastError: { code: "mic_error", message: "The mic went away." }, host: "app" },
  { phase: "idle", state: "paused", pausedReason: "user", host: "app" },
  { phase: "idle", state: "paused", pausedReason: "session_ended", host: "app" },
  { phase: "idle", state: "waiting_page", host: "app" },
  { phase: "idle", state: "reconnecting", host: "app" },
  { phase: "idle", state: "live", host: "app" },
];

function cases() {
  const out = [];
  const add = (fn, args, value) => out.push({ fn, args, out: value === undefined ? null : value });
  for (const s of ["off", "waiting_page", "live", "sleeping", "some_new_state", ""]) add("statusLabel", [s], lib.statusLabel(s));
  for (const s of [0, 30, 60, 852, 3600, 3900, 7200]) {
    add("formatDuration", [s, false], lib.formatDuration(s));
    add("formatDuration", [s, true], lib.formatDuration(s, { long: true }));
  }
  for (const s of [0, 5, 852, 3909]) add("formatClock", [s], lib.formatClock(s));
  // The header pills (SPEC-DEVIATIONS "header pills"): the text and the one widening.
  for (const p of [
    { sessionSeconds: null, todaySeconds: 0, costSeconds: 0 },
    { sessionSeconds: 9, todaySeconds: 600, costSeconds: 1 },
    { sessionSeconds: 599, todaySeconds: 3599, costSeconds: 852 },
    { sessionSeconds: 3600, todaySeconds: 36_000, costSeconds: 119_999 },
    { sessionSeconds: 59.999, todaySeconds: 3600.4, costSeconds: 120_000 },
  ]) add("usagePills", [p], lib.usagePills(p));
  for (const [prev, s, now] of [[null, 30, 1000], [{ seconds: 30, at: 1000 }, 30, 5000], [{ seconds: 30, at: 1000 }, 45, 5000], [{ seconds: 30, at: 1000 }, 45, 11_000], [{ seconds: 30, at: 1000 }, 61, 2000], [{ seconds: 300, at: 1000 }, 12, 2000]]) {
    add("stableUsage", [prev, s, now], lib.stableUsage(prev, s, now));
  }
  for (const [r, now, o] of [[null, 0, {}], [{ seconds: 100, at: 0 }, 4000, { live: true }], [{ seconds: 100, at: 0 }, 60_000, { live: true }], [{ seconds: 100, at: 0 }, 4000, { live: false }], [{ seconds: 100, at: 0 }, 0, { live: true, shown: 110 }], [{ seconds: 10, at: 0 }, 0, { live: true, shown: 900 }]]) {
    add("tickingToday", [r, now, o], lib.tickingToday(r, now, o));
  }
  for (const t of ["system", "Light", " dark ", "sepia", null]) add("normalizeTheme", [t], lib.normalizeTheme(t));
  for (const s of [0, 1, 852, 90]) add("formatUsage", [s], lib.formatUsage(s));
  for (const d of [0, 0.004, 0.075, 0.71, 12.345]) add("formatMoney", [d], lib.formatMoney(d));
  for (const ms of [0, 42_000, 192_000, 3_720_000]) add("formatElapsed", [ms], lib.formatElapsed(ms));
  for (const t of ["short", "word ".repeat(60), "a".repeat(200), "  spaced\n\ttext  "]) add("truncate", [t, 40], lib.truncate(t, 40));
  for (const st of ["sent", "answered", "held_suspected", "brand_new"]) add("delegationLabel", [st], lib.delegationLabel(st));
  for (const r of ["close_requested", "content", "expired", "remote_hangup", "connection_lost", "weird", null]) add("closedReasonMessage", [r], lib.closedReasonMessage(r));
  for (const a of [["idle", 5, null], ["idle", null, 45], ["idle", null, 120], ["idle", null, 150], ["idle", null, null], ["daily_cap", null, null], ["user", null, null], [null, null, null], ["error", null, null], ["app_gone", null, null]]) {
    add("pausedMessage", a, lib.pausedMessage(...a));
  }
  for (const ev of [{ type: "error", error: { message: "Rate limited" } }, { type: "error", message: "top" }, { type: "error" }, { type: "error", client_event_id: "x", error: { message: "m" } }, { type: "info" }]) {
    add("errorBannerText", [ev], lib.errorBannerText(ev));
  }
  for (const ev of [
    { kind: "turn_start", text: "" },
    { kind: "turn_start", text: "Fix the test" },
    { kind: "tool", text: "Bash: ls daemon" },
    { kind: "text", text: "Looking at the **auth** spec" },
    { kind: "permission", text: "rm -rf build" },
    { kind: "turn_end", text: "There are 34 files in daemon/." },
    { kind: "turn_end", text: "short", summary: "## Done\n- one\n- two" },
    { kind: "agents", text: "1 background agent", count: 1 },
    { kind: "mystery", text: "hello" },
  ]) add("activityView", [ev], lib.activityView(ev));
  const req = { text: "List the files in the daemon folder.", status: "delivered" };
  for (const s of [
    { busy: false },
    { busy: true },
    { busy: true, says: "I'll check the **auth** spec first.", tool: "Bash: npm test", request: req, agents: 2 },
    { busy: true, says: "Old words", saysAt: 0, now: 25_000, tool: "Running `npm test`" },
    { busy: true, says: "Fresh words", saysAt: 10_000, now: 25_000, tool: "Bash: ls" },
    { busy: true, kind: "permission", text: "rm -rf build", request: req, agents: 1 },
    { busy: false, kind: "permission", text: "rm -rf build" },
    { busy: false, summary: "Fixed the flaky test.", request: { text: "Fix it", status: "answered" } },
  ]) add("claudeView", [s], lib.claudeView(s));
  for (const md of ["**Bold** and _it_ and `code` [link](https://x.y)", "## Head\n- a\n- b\n```js\nx()\n```\nend", "> quoted ~~no~~"]) add("stripMarkdown", [md], lib.stripMarkdown(md));
  for (const k of [null, KEY(), KEY({ present: true, source: "keychain", hint: "wxyz", label: "the macOS Keychain", can_remove: true }), KEY({ present: true, source: "env", hint: "abcd", label: "the OPENAI_API_KEY environment variable", can_change: false }), KEY({ present: true, source: "dotenv", file: "/p/.env", hint: "abcd", label: "the .env file" })]) {
    add("keySettingsView", [k], lib.keySettingsView(k));
  }
  for (const o of [{}, { enabled: false }, { micError: "busy" }, { muted: true }, { cooldownMs: 4200 }]) add("sleepView", [o], wake.sleepView(o));
  const hk = [
    [{ key: "m" }, { live: true }], [{ key: "M" }, { sleeping: true }], [{ key: " " }, { paused: true }], [{ key: " " }, { live: true }],
    [{ key: " ", targetTag: "BUTTON" }, { live: true }], [{ key: "m", meta: true }, { live: true }], [{ key: "m", repeat: true }, { live: true }],
    [{ key: "m", targetTag: "INPUT" }, { live: true }], [{ key: "m" }, { paused: true }], [{ key: "x" }, { live: true }],
  ];
  for (const [ev, ctx] of hk) add("hotkeyAction", [ev, ctx], lib.hotkeyAction(ev, ctx));
  // Captions: a fold over fragments; the output is the final list.
  const frags = [
    { role: "assistant", text: "Hi, ", start_ms: 100, end_ms: 300, session: "s1" },
    { role: "assistant", text: "I'm listening.", start_ms: 300, end_ms: 900, session: "s1" },
    { role: "user", text: " List the files ", start_ms: 2000, end_ms: 2600, session: "s1" },
    { role: "user", text: "", start_ms: 2600, end_ms: 2700, session: "s1" },
    { role: "user", text: "please", start_ms: 4101, end_ms: 4300, session: "s1" },
    { role: "user", text: " now", start_ms: 0, end_ms: 100, session: "s2" },
    { role: "robot", text: "x", start_ms: 150, end_ms: 200, session: "s2" },
  ];
  add("reduceCaptions", [frags, 60], frags.reduce((l, f) => lib.reduceCaptions(l, f, 60), []));
  const many = Array.from({ length: 5 }, (_, i) => ({ role: i % 2 ? "user" : "assistant", text: `line ${i}`, start_ms: i * 5000, end_ms: i * 5000 + 100, session: "s1" }));
  add("reduceCaptions", [many, 3], many.reduce((l, f) => lib.reduceCaptions(l, f, 3), []));
  const dels = [{ id: "a", status: "sent", text: "one" }, { id: "b", status: "sent", text: "two" }, { id: "a", status: "answered" }, { id: "c", text: "three" }, { id: "d", status: "failed", text: "four" }, { status: "x" }];
  add("upsertDelegation", [dels, 3], dels.reduce((l, e) => lib.upsertDelegation(l, e, 3), []));
  for (const s of pageInputs) {
    const v = lib.pageView(s);
    add("pageView", [s], v);
    if (v.card) add("cardAnnouncement", [v.card], lib.cardAnnouncement(v.card));
    add("windowTitle", [v.floor, !!s.attention], lib.windowTitle(v, !!s.attention));
  }
  return JSON.parse(JSON.stringify(out));
}

test("native ViewText fixture matches web/lib.js (regenerate with SOTTO_UPDATE_FIXTURES=1)", () => {
  const now = cases();
  if (process.env.SOTTO_UPDATE_FIXTURES === "1") writeFileSync(FIXTURE, `${JSON.stringify(now, null, 1)}\n`);
  const pinned = JSON.parse(readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(now, pinned);
});
