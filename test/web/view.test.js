// Unit tests for the voice-window view models in web/lib.js (UI redesign,
// design/AUDIT.md "Required states"). Pure functions only; no DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as lib from "../../web/lib.js";

const live = (extra = {}) => lib.pageView({ phase: "live", state: "live", ...extra });

test("smoothLevel: fast attack, slow release, clamps, frame-rate independent", () => {
  const up = lib.smoothLevel(0, 1, 40, 40, 220);
  const down = lib.smoothLevel(1, 0, 40, 40, 220);
  assert.ok(up > 0.6 && up < 0.65, `attack ${up}`);
  assert.ok(down > 0.8, `release ${down}`);
  assert.equal(lib.smoothLevel(0.5, 2, 1000), 1 - 0.5 * Math.exp(-1000 / 40));
  // two 8 ms steps == one 16 ms step
  const a = lib.smoothLevel(lib.smoothLevel(0, 1, 8), 1, 8);
  const b = lib.smoothLevel(0, 1, 16);
  assert.ok(Math.abs(a - b) < 1e-9);
  assert.equal(lib.smoothLevel(NaN, NaN, 16), 0);
});

test("gateLevel: room noise reads as silence, speech keeps its range", () => {
  assert.equal(lib.gateLevel(0.1), 0);
  assert.equal(lib.gateLevel(0.12), 0);
  assert.equal(lib.gateLevel(1), 1);
  assert.ok(Math.abs(lib.gateLevel(0.56) - 0.5) < 1e-9);
  assert.equal(lib.gateLevel(undefined), 0);
});

test("quantizeLevel snaps to rest / mid / full for reduced motion", () => {
  assert.equal(lib.quantizeLevel(0), 0);
  assert.equal(lib.quantizeLevel(0.1), 0);
  assert.equal(lib.quantizeLevel(0.3), 0.5);
  assert.equal(lib.quantizeLevel(0.9), 1);
  assert.equal(lib.quantizeLevel(undefined), 0);
});

test("bandLevels maps byte spectra to 0..1 log bands", () => {
  const bytes = new Uint8Array(256);
  bytes.fill(0);
  for (let i = 2; i < 20; i++) bytes[i] = 255; // energy in the low bins only
  const bands = lib.bandLevels(bytes, 16, { minBin: 2, maxBin: 128 });
  assert.equal(bands.length, 16);
  assert.equal(bands[0], 1);
  assert.equal(bands[15], 0);
  for (const v of bands) assert.ok(v >= 0 && v <= 1);
  assert.equal(lib.bandLevels(null, 8).length, 8);
  assert.equal(lib.bandLevels(new Uint8Array(0), 8)[0], 0);
});

test("symmetricProfile is mirror-symmetric and repeats per lobe", () => {
  const bands = Float32Array.from([1, 0.8, 0.5, 0.2, 0.1, 0]);
  const p = lib.symmetricProfile(bands, 72, { lobes: 4, blur: 0 });
  assert.equal(p.length, 72);
  const seg = 18;
  for (let i = 0; i < 72; i++) assert.equal(p[i], p[(i + seg) % 72], `lobe repeat at ${i}`);
  for (let i = 0; i < seg / 2; i++) assert.equal(p[i], p[seg - 1 - i], `mirror at ${i}`);
  assert.equal(p[seg / 2], 1, "the loudest band swells mid-lobe");
  const blurred = lib.symmetricProfile(bands, 72);
  for (const v of blurred) assert.ok(v >= 0 && v <= 1);
});

test("floor tracker: hysteresis in level and time, voice wins ties", () => {
  const f = lib.createFloorTracker({ onLevel: 0.36, offLevel: 0.2, attackMs: 90, releaseMs: 500 });
  assert.equal(f.update(0.9, 0, 0), null, "needs attackMs above the threshold");
  assert.equal(f.update(0.9, 0, 50), null);
  assert.equal(f.update(0.9, 0, 100), "you");
  assert.equal(f.update(0.3, 0, 200), "you", "between off and on: stays");
  assert.equal(f.update(0.1, 0, 300), "you", "release not yet over");
  assert.equal(f.update(0.1, 0, 801), null, "released after releaseMs");
  // assistant speaks
  f.update(0, 0.7, 1000);
  assert.equal(f.update(0, 0.7, 1100), "voice");
  // both: voice unless the mic is clearly louder (echo residue must not steal the floor)
  f.update(0.5, 0.7, 1200);
  assert.equal(f.update(0.5, 0.7, 1300), "voice");
  assert.equal(f.update(0.95, 0.7, 1310), "you");
  f.reset();
  assert.equal(f.update(0, 0, 2000), null);
});

test("micFailureKind tells dismissed, Chrome-blocked and macOS-blocked apart (AUDIT #6)", () => {
  assert.equal(lib.micFailureKind("NotAllowedError", "Permission dismissed", "prompt"), "dismissed");
  assert.equal(lib.micFailureKind("NotAllowedError", "Permission denied", "denied"), "chrome");
  assert.equal(lib.micFailureKind("NotAllowedError", "Permission denied by system", "granted"), "macos");
  assert.equal(lib.micFailureKind("NotAllowedError", "", "granted"), "macos");
  assert.equal(lib.micFailureKind("NotAllowedError", "", null), "chrome");
  assert.equal(lib.micFailureKind("NotFoundError"), "notfound");
  assert.equal(lib.micFailureKind("OverconstrainedError"), "notfound");
  assert.equal(lib.micFailureKind("NotReadableError"), "busy");
  assert.equal(lib.micFailureKind("NotSupportedError"), "unsupported");
  assert.equal(lib.micFailureKind("Weird"), "other");
  for (const kind of ["dismissed", "chrome", "macos", "notfound", "busy", "unsupported", "other", "nope"]) {
    const v = lib.micFailureView(kind);
    assert.ok(v.title && v.body && v.header, kind);
  }
  assert.equal(lib.micFailureView("macos").steps.length, 3);
  assert.match(lib.micFailureView("macos").steps[0], /Privacy & Security/);
  assert.match(lib.micFailureView("chrome").steps[0], /Site settings/);
  assert.equal(lib.micFailureView("dismissed").button, "Ask again");
});

test("connectSteps marks done / active / pending", () => {
  assert.deepEqual(lib.connectSteps("network").map((s) => s.state), ["done", "active", "pending"]);
  assert.deepEqual(lib.connectSteps("mic").map((s) => s.state), ["active", "pending", "pending"]);
  assert.deepEqual(lib.connectSteps(null).map((s) => s.state), ["pending", "pending", "pending"]);
  assert.equal(lib.connectSteps("session")[2].label, "Starting the session");
});

test("claudeView: idle, working, approval (full command), finished", () => {
  assert.deepEqual(lib.claudeView({ busy: false }), { kind: "idle", title: "Claude is idle", request: null, agents: null });
  const w = lib.claudeView({ busy: true, kind: "tool", tool: "Running the tests" });
  assert.equal(w.kind, "working");
  assert.equal(w.title, "Claude is working");
  assert.equal(w.step, "Thinking", "a tool label is never the card's line");
  assert.equal(w.secondary, false);
  assert.equal(lib.claudeView({ busy: true, kind: "turn_start" }).step, "Thinking");
  const cmd = "Bash(rm -rf test/fixtures/tmp && npm test -- --update-snapshots --reporter=verbose --coverage)";
  const a = lib.claudeView({ busy: true, kind: "permission", text: cmd });
  assert.equal(a.kind, "approval");
  assert.equal(a.command, cmd, "never truncated");
  assert.equal(a.note, "Waiting for your approval in the terminal");
  const f = lib.claudeView({ busy: false, kind: "turn_end", summary: "Fixed it." });
  assert.equal(f.kind, "finished");
  assert.equal(f.summary, "Fixed it.");
  const r = lib.claudeView({ busy: true, kind: "tool", text: "x", request: { text: "check the tests", status: "failed" } });
  assert.deepEqual(r.request, { text: "check the tests", label: "Couldn't reach Claude", tone: "error" });
});

test("claudeView: Claude's latest words, never a tool label; agents as a count", () => {
  const base = { busy: true, kind: "tool", tool: "Screenshot only the Sotto app window", says: "I found the **bug** in `voice.js`. Fixing it now.", saysAt: 1000 };
  const fresh = lib.claudeView({ ...base, now: 5000 });
  assert.equal(fresh.step, "I found the bug in voice.js. Fixing it now.", "markdown stripped in the one-line view");
  assert.equal(fresh.secondary, false);
  const old = lib.claudeView({ ...base, now: 1000 + 10 * 60_000 });
  assert.equal(old.step, "I found the bug in voice.js. Fixing it now.", "old words stay: a tool line never replaces them");
  assert.equal(old.secondary, false);
  assert.equal(lib.claudeView({ ...base, says: "", now: 99_000 }).step, "Thinking", "nothing said yet: Thinking, not the tool");
  assert.equal(lib.claudeView({ ...base, agents: 3, now: 5000 }).agents, "3 background agents working");
  assert.equal(lib.claudeView({ ...base, agents: 1, now: 5000 }).agents, "1 background agent working");
  assert.equal(lib.claudeView({ busy: false, agents: 2 }).agents, "2 background agents working");
  for (const v of [fresh, old]) assert.ok(!/helper agent|running cd|Screenshot/.test(v.step));
});

test("pageView: live floors, muted header, approval header", () => {
  assert.equal(live().floor, "listening");
  assert.equal(live().word, "Listening");
  assert.equal(live().view, "live");
  assert.equal(live({ floor: "you" }).word, "Hearing you");
  const v = live({ floor: "voice" });
  assert.equal(v.word, "Speaking");
  assert.equal(v.sub, null, "no extra hint line while the voice speaks");
  const m = live({ muted: true, floor: "you" });
  assert.equal(m.floor, "muted", "muted wins over the floor");
  assert.deepEqual(m.header, { key: "muted", label: "Muted", detail: "Still billing" });
  const a = live({ attention: true });
  assert.equal(a.header.label, "Approval needed");
  assert.equal(a.header.key, "attention");
  assert.equal(lib.windowTitle(a, true), "Approval needed · Sotto");
  assert.equal(lib.windowTitle(live(), false), "Sotto");
});

test("pageView: connecting shows the checklist; reconnecting keeps the mute promise", () => {
  const c = lib.pageView({ phase: "connecting", state: "connecting", connectStage: "network" });
  assert.equal(c.view, "live");
  assert.equal(c.floor, "connecting");
  assert.equal(c.steps[1].state, "active");
  const r = lib.pageView({ phase: "connecting", state: "reconnecting", connectReason: "reconnect" });
  assert.equal(r.floor, "reconnecting");
  assert.equal(r.steps, null);
  assert.equal(r.sub, "Your mute setting is kept.");
  const waiting = lib.pageView({ phase: "idle", state: "waiting_page" });
  assert.equal(waiting.view, "live");
  assert.equal(waiting.sub, "Waiting for Claude Code…");
});

test("pageView: Allow microphone before getUserMedia resolves (AUDIT #1)", () => {
  const p = lib.pageView({ phase: "connecting", state: "connecting", micPrompt: true });
  assert.equal(p.view, "card");
  assert.equal(p.card.kind, "permission");
  assert.equal(p.card.title, "Allow microphone access");
  assert.equal(p.card.arrow, true);
  assert.equal(p.card.button, null, "no wrong action on offer while Chrome asks");
  assert.equal(p.header.label, "Allow mic");
});

test("pageView: mic failures and the generic error", () => {
  const d = lib.pageView({ phase: "error", state: "paused", micFailure: "dismissed" });
  assert.equal(d.card.title, "The microphone prompt closed");
  assert.equal(d.card.button, "Ask again");
  assert.equal(d.card.kbd, true);
  const mac = lib.pageView({ phase: "error", state: "paused", micFailure: "macos" });
  assert.equal(mac.card.steps.length, 3);
  assert.equal(mac.header.label, "Mic blocked");
  const offErr = lib.pageView({ phase: "error", state: "off", micFailure: "busy" });
  assert.equal(offErr.card.button, null, "no retry when voice is off");
  const e = lib.pageView({ phase: "error", state: "paused", errorText: "The voice session did not start." });
  assert.equal(e.card.title, "Voice could not start");
  assert.equal(e.card.body, "The voice session did not start.");
});

test("pageView: API key needed shows the key input", () => {
  const k = lib.pageView({ phase: "error", state: "paused", errorCode: "no_api_key" });
  assert.equal(k.card.kind, "apikey");
  assert.equal(k.card.title, "Add your OpenAI API key to start");
  assert.equal(k.card.keyInput, true);
  assert.equal(k.card.button, null);
  assert.equal(k.header.label, "Key needed");
  const k2 = lib.pageView({ phase: "idle", state: "paused", lastError: { code: "no_api_key" } });
  assert.equal(k2.card.kind, "apikey");
});

const KEY = (o = {}) => ({ present: false, source: null, file: null, hint: null, label: null, can_change: true, can_remove: false, keychain: true, setup: false, ...o });

test("keyCardView: setup, replace, rejected, outside sources, no Keychain", () => {
  // /talk key with voice off: the setup card shows even in state off.
  const setup = lib.pageView({ phase: "idle", state: "off", key: KEY({ setup: true }) });
  assert.equal(setup.card.kind, "apikey");
  assert.equal(setup.card.keyInput, true);
  assert.match(setup.card.body, /macOS Keychain/);
  // Never while live or connecting.
  assert.equal(lib.keyCardView({ phase: "live", state: "live", key: KEY({ setup: true }) }), null);
  assert.equal(lib.keyCardView({ phase: "idle", state: "paused", key: KEY() }), null);
  const replace = lib.keyCardView({ phase: "idle", state: "off", key: KEY({ setup: true, present: true, source: "keychain", hint: "wxyz", label: "the macOS Keychain", can_remove: true }) });
  assert.equal(replace.title, "Replace your OpenAI API key");
  assert.match(replace.body, /ending in wxyz/);
  const rejected = lib.keyCardView({ phase: "error", state: "paused", errorCode: "openai_auth", key: KEY({ present: true, source: "keychain", hint: "wxyz" }) });
  assert.equal(rejected.title, "OpenAI rejected your API key");
  assert.equal(rejected.keyInput, true);
  // A rejected key from .env cannot be replaced here: the plain error card shows.
  assert.equal(lib.keyCardView({ phase: "error", state: "paused", errorCode: "openai_auth", key: KEY({ present: true, source: "dotenv", can_change: false }) }), null);
  const outside = lib.keyCardView({ phase: "idle", state: "off", key: KEY({ setup: true, present: true, source: "dotenv", file: "/p/.env", hint: "abcd", can_change: false }) });
  assert.equal(outside.keyInput, false);
  assert.match(outside.body, /\/p\/\.env/);
  const noKc = lib.keyCardView({ phase: "idle", state: "paused", lastError: { code: "no_api_key" }, key: KEY({ keychain: false, can_change: false }) });
  assert.equal(noKc.keyInput, false);
  assert.match(noKc.body, /OPENAI_API_KEY/);
});

test("keySettingsView: the drawer row never needs the key", () => {
  assert.equal(lib.keySettingsView(null).text, "Checking…");
  const none = lib.keySettingsView(KEY());
  assert.deepEqual([none.text, none.change, none.remove, none.changeLabel], ["No key yet", true, false, "Add key"]);
  const kc = lib.keySettingsView(KEY({ present: true, source: "keychain", hint: "wxyz", label: "the macOS Keychain", can_remove: true }));
  assert.deepEqual([kc.text, kc.change, kc.remove], ["Key ending in wxyz", true, true]);
  const env = lib.keySettingsView(KEY({ present: true, source: "env", hint: "abcd", label: "the OPENAI_API_KEY environment variable", can_change: false }));
  assert.deepEqual([env.change, env.remove], [false, false]);
  assert.match(env.help, /Change it there/);
  const uc = lib.keySettingsView(KEY({ present: true, source: "user_config", hint: "abcd", label: "the plugin settings" }));
  assert.match(uc.help, /replaces it/);
});

test("pageView: paused keeps the SPEC strings; daily cap has no Resume", () => {
  const p = lib.pageView({ phase: "idle", state: "paused", pausedReason: "idle", idleMinutes: 5, pendingResult: "Done." });
  assert.equal(p.card.title, "Paused after 5 minutes of silence");
  assert.match(p.card.body, /^Resume to keep talking with Claude Code\./);
  assert.equal(p.card.pending, "Done.");
  assert.equal(p.card.button, "Resume");
  assert.equal(p.floor, "paused");
  const cap = lib.pageView({ phase: "idle", state: "paused", lastError: { code: "daily_cap" } });
  assert.equal(cap.card.title, "Paused: today's voice limit is reached");
  assert.equal(cap.card.button, null);
  assert.equal(cap.header.label, "Limit reached");
  assert.equal(cap.card.body, "Raise daily_cap_minutes in /config (sotto) to continue today.");
  const cap2 = lib.pageView({ phase: "idle", state: "paused", lastError: { code: "daily_cap" }, capMinutes: 120 });
  assert.equal(cap2.card.body, "You've used today's 2 hours of voice. Raise daily_cap_minutes in /config (sotto) to continue today.");
  const sleeping = lib.pageView({ phase: "idle", state: "sleeping" });
  assert.equal(sleeping.floor, "sleeping");
});

test("pageView: every other required state has a card", () => {
  const kinds = {
    starting: { phase: "boot", state: "off" },
    replaced: { phase: "replaced", state: "live" },
    lost: { phase: "lost", state: "live" },
    closed: { phase: "closed", state: "off" },
    off: { phase: "idle", state: "off" },
    closing: { phase: "idle", state: "closing" },
    disconnected: { phase: "idle", state: "paused", sseDown: true },
    unauthorized: { phase: "idle", state: "off", unauthorized: true },
  };
  for (const [kind, s] of Object.entries(kinds)) {
    const v = lib.pageView(s);
    assert.equal(v.view, "card", kind);
    assert.equal(v.card.kind, kind, kind);
    assert.ok(v.card.title && v.header.label, kind);
  }
  assert.equal(lib.pageView(kinds.replaced).card.button, "Use this window");
  assert.equal(lib.pageView(kinds.replaced).card.action, "reload");
});

test("formatElapsed", () => {
  assert.equal(lib.formatElapsed(42_000), "42 sec");
  assert.equal(lib.formatElapsed(192_000), "3 min 12 sec");
  assert.equal(lib.formatElapsed(3_725_000), "1 hr 2 min");
  assert.equal(lib.formatElapsed(-5), "0 sec");
});

// ---------------------------------------------------------------------------
// Critique round (design/final): approval hero, sleeping, app host, announcements.
// ---------------------------------------------------------------------------

test("pageView: approval takes the hero word; the floor moves to the small line", () => {
  const v = live({ attention: true });
  assert.equal(v.word, lib.APPROVAL_WORD);
  assert.equal(v.wordTone, "attn");
  assert.equal(v.sub, "Listening");
  const m = live({ attention: true, muted: true });
  assert.equal(m.word, lib.APPROVAL_WORD);
  assert.match(m.sub, /^Muted/);
  assert.equal(m.header.detail, "Muted");
  // Not while the voice connection is still coming up.
  const c = lib.pageView({ phase: "connecting", state: "connecting", attention: true });
  assert.notEqual(c.word, lib.APPROVAL_WORD);
  assert.equal(live().wordTone, null);
});

test("pageView: sleeping is its own card with wake.js copy, not a copy of Paused", () => {
  const sleep = { title: "Sleeping — just start talking", body: "Voice wakes up when you speak. Nothing is sent or billed until then.", listening: true };
  const v = lib.pageView({ phase: "idle", state: "sleeping", sleep, pendingResult: "Done." });
  assert.equal(v.card.kind, "sleeping");
  assert.equal(v.card.title, sleep.title);
  assert.equal(v.card.body, sleep.body);
  assert.equal(v.card.button, "Wake now");
  assert.equal(v.card.secondary, true);
  assert.equal(v.card.listening, true);
  assert.equal(v.card.pending, "Done.");
  assert.equal(v.floor, "sleeping");
  assert.notEqual(v.dial, "hidden");
  assert.doesNotMatch(v.card.body, /while paused/);
  const p = lib.pageView({ phase: "idle", state: "paused", pausedReason: "idle", idleSeconds: 45 });
  assert.equal(p.card.kind, "paused");
  assert.equal(p.card.title, "Paused after 45 seconds of silence");
  assert.equal(p.floor, "paused");
});

test("pageView: every card but 'not connected' keeps the dial as its hero", () => {
  const cards = [
    { phase: "connecting", state: "connecting", micPrompt: true },
    { phase: "error", state: "live", micFailure: "chrome" },
    { phase: "error", state: "live", micFailure: "macos" },
    { phase: "error", state: "live", errorCode: "no_api_key" },
    { phase: "error", state: "live", errorText: "x" },
    { phase: "replaced", state: "live" },
    { phase: "closed", state: "off" },
    { phase: "idle", state: "off" },
    { phase: "idle", state: "paused" },
  ];
  for (const s of cards) assert.notEqual(lib.pageView(s).dial, "hidden", JSON.stringify(s));
  assert.equal(lib.pageView({ phase: "idle", state: "off", unauthorized: true }).dial, "hidden");
});

test("pageView: Allow microphone points at Chrome's bubble in a browser, not in the app", () => {
  const b = lib.pageView({ phase: "connecting", state: "connecting", micPrompt: true });
  assert.equal(b.card.arrow, true);
  assert.equal(b.dialHint, "prompt");
  assert.match(b.card.body, /Chrome is asking/);
  const a = lib.pageView({ phase: "connecting", state: "connecting", micPrompt: true, host: "app" });
  assert.equal(a.card.arrow, false);
  assert.notEqual(a.dialHint, "prompt");
  assert.match(a.card.body, /macOS is asking whether Sotto can use the microphone/);
  assert.doesNotMatch(`${a.card.body} ${a.card.note}`, /Chrome/);
});

test("mic failures inside the Sotto app name macOS and Sotto, never Chrome", () => {
  for (const [msg, perm] of [["Permission dismissed", "prompt"], ["Permission denied", "denied"], ["", "granted"]]) {
    assert.equal(lib.micFailureKind("NotAllowedError", msg, perm, "app"), "macos");
  }
  const v = lib.micFailureView("macos", "app");
  assert.ok(v.steps.some((s) => /Turn on Sotto/.test(s)));
  assert.doesNotMatch(JSON.stringify(v), /Chrome/);
  const page = lib.pageView({ phase: "error", state: "live", micFailure: "macos", host: "app" });
  assert.doesNotMatch(JSON.stringify(page.card), /Chrome/);
  // The browser copy is unchanged.
  assert.ok(lib.micFailureView("macos").steps.some((s) => /Google Chrome/.test(s)));
  assert.equal(lib.micFailureKind("NotAllowedError", "Permission dismissed", "prompt"), "dismissed");
});

test("the app's mic-blocked card: exact wording and a button that opens the Microphone privacy pane", () => {
  const v = lib.micFailureView("macos", "app");
  assert.equal(v.title, "Sotto can't use the microphone");
  assert.match(v.body, /^Allow it in System Settings > Privacy & Security > Microphone\./);
  assert.deepEqual(v.link, { href: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone", label: "Open System Settings" });
  assert.equal(lib.MIC_SETTINGS_URL, v.link.href);
  const page = lib.pageView({ phase: "error", state: "live", micFailure: "macos", host: "app" });
  assert.deepEqual(page.card.link, v.link);
  // Failures macOS has nothing to do with get no link.
  assert.equal(lib.pageView({ phase: "error", state: "live", micFailure: "busy", host: "app" }).card.link, undefined);
});

test("cardAnnouncement: title plus the first sentence; errors are assertive", () => {
  const paused = lib.pageView({ phase: "idle", state: "paused", pausedReason: "user" }).card;
  const a = lib.cardAnnouncement(paused);
  assert.equal(a.text, "Paused. Resume to keep talking with Claude Code.");
  assert.equal(a.assertive, false);
  for (const s of [
    { phase: "error", state: "live", micFailure: "chrome" },
    { phase: "error", state: "live", errorText: "The voice session did not start." },
    { phase: "idle", state: "paused", lastError: { code: "daily_cap" } },
  ]) {
    assert.equal(lib.cardAnnouncement(lib.pageView(s).card).assertive, true, JSON.stringify(s));
  }
  const err = lib.cardAnnouncement(lib.pageView({ phase: "error", state: "live", errorText: "The voice session did not start." }).card);
  assert.equal(err.text, "Voice could not start. The voice session did not start.");
  assert.equal(lib.cardAnnouncement(null), null);
});

// Design review (SPEC-DEVIATIONS "Design review of the Filament + Orrery panel" 3): sleeping
// and paused keep the page and speak on the caption line, in the app's words; cards stay cards.
test("inlineCard / inlineNote: sleeping and paused speak on the caption line, the cap keeps its card", () => {
  const sleeping = lib.pageView({ phase: "idle", state: "sleeping", sleep: { title: "Sleeping", body: "Voice wakes up when you speak.", listening: true } });
  assert.equal(lib.inlineCard(sleeping), true);
  assert.equal(lib.inlineNote(sleeping), "Just start talking. Nothing is sent or billed until then.");
  const deaf = lib.pageView({ phase: "idle", state: "sleeping", sleep: { title: "Sleeping", body: "Voice wake is off.", listening: false } });
  assert.equal(lib.inlineNote(deaf), "Voice wake is off.");
  const paused = lib.pageView({ phase: "idle", state: "paused", pausedReason: "idle", idleMinutes: 5 });
  assert.equal(lib.inlineCard(paused), true);
  assert.equal(lib.inlineNote(paused), "Paused after 5 minutes of silence. Press Space to resume.");
  const cap = lib.pageView({ phase: "idle", state: "paused", lastError: { code: "daily_cap" } });
  assert.equal(lib.inlineCard(cap), false);
  assert.equal(lib.inlineNote(cap), null);
  assert.equal(lib.inlineCard(lib.pageView({ phase: "live", state: "live" })), false);
  assert.equal(lib.inlineCard(lib.pageView({ phase: "error", state: "paused", errorText: "x" })), false);
});
