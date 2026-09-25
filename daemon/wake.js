// Idle sleep and automatic wake (SPEC §6.15). Pure logic, clock-injected.
//
// A Live session bills every connected second, silence included, so after
// `idle_seconds` with nobody speaking the daemon closes it and goes to
// `sleeping`. The page keeps listening locally ($0) and re-creates the session
// when the user speaks again ("voice" wake); the daemon itself re-creates it
// when it has something the user must hear ("notify" wake).
//
// Billing facts this is built on (guide-voice-latency-cost.md):
//  - a WebRTC session create bills 15 s up front, credited once it runs, so a
//    session is never cheaper than 15 s: sleeping sooner than MIN_AWAKE_MS
//    after a wake saves nothing, and it is the natural "don't thrash" floor;
//  - after that, every second (speech or silence) costs the same.

/** Never sleep sooner than this after the session went live (15 s are billed anyway). */
export const MIN_AWAKE_MS = 15_000;
/** Don't sleep while the model spoke within this long (it may still be playing). */
export const SPEAKING_GRACE_MS = 2_500;
/** Default idle timeout when neither idle_seconds nor idle_minutes is configured. */
export const DEFAULT_IDLE_SECONDS = 60;
/**
 * Back-off before the page may wake again, by number of consecutive false
 * wakes. Short on purpose: live log 2026-09-25 (AirPods, native 0.4.1), four
 * wakes whose speech gpt-live-1 could not hear (too soft, see daemon/agc.js)
 * each counted as false, the fourth set a 120 s cooldown, and the user's next
 * real attempts were ignored until they clicked play.
 */
export const COOLDOWNS_MS = Object.freeze([0, 5_000, 15_000, 30_000]);
/** Each false wake raises the page's SNR bar by this much, up to MAX_BOOST_DB. */
export const BOOST_STEP_DB = 3;
export const MAX_BOOST_DB = 6;
/**
 * A voice-woken session with no words is a false wake only once the local mic
 * has also been quiet this long: an empty wake clip or a model that has not
 * transcribed yet is not proof that nobody is talking.
 */
export const FALSE_WAKE_QUIET_MS = 10_000;
export const WAKE_SENSITIVITIES = Object.freeze(["off", "low", "medium", "high"]);
/**
 * Sources whose message is worth waking a sleeping session for (voice.js
 * sendAppend()): answers to voice requests and anything Claude is blocked on.
 * Typed-turn results and routine completions only wait as pendingResult.
 */
export const WAKE_SOURCES = Object.freeze(new Set(["voice_result", "background_voice", "voice_notice", "permission", "approval_reminder", "question", "attention", "notify"]));

/**
 * Should the live session go to sleep now?
 * @param {object} o
 * @param {number} o.now
 * @param {number} o.idleMs           0 or less disables idle sleep entirely
 * @param {number} o.liveStartedAt
 * @param {number} o.lastUserAt       latest user transcript delta
 * @param {number} o.lastAssistantAt  latest assistant transcript delta
 * @param {number} o.lastPageActivityAt local speech the page detected
 * @param {boolean} o.busy            a delegation is collecting or Claude works on a voice request
 * @param {string|null} o.wokeBy      "voice" when this session was woken by local voice detection
 * @param {boolean} o.heardUser       any user words in this session (live transcript or wake clip)
 * @param {number} [o.lastLocalSpeechAt] latest speech the local mic detector heard (page or app)
 * @param {number} [o.minAwakeMs]
 * @returns {null|"idle"|"false_wake"}
 */
export function sleepDecision({
  now, idleMs, liveStartedAt = 0, lastUserAt = 0, lastAssistantAt = 0, lastPageActivityAt = 0,
  busy = false, wokeBy = null, heardUser = false, lastLocalSpeechAt = 0, minAwakeMs = MIN_AWAKE_MS,
}) {
  if (!(idleMs > 0) || busy) return null;
  if (now - liveStartedAt < minAwakeMs) return null;
  if (lastAssistantAt && now - lastAssistantAt < SPEAKING_GRACE_MS) return null;
  // Woken by "voice" but no words ever arrived and the mic has been quiet for
  // FALSE_WAKE_QUIET_MS: noise, music or a cough. Sleep as soon as the prepaid
  // 15 s are used instead of waiting a full idle period. While the local
  // detector still hears speech the session stays (the normal idle rule).
  if (wokeBy === "voice" && !heardUser && now - Math.max(liveStartedAt, lastLocalSpeechAt) >= FALSE_WAKE_QUIET_MS) return "false_wake";
  const last = Math.max(lastUserAt, lastAssistantAt, lastPageActivityAt, liveStartedAt);
  return now - last >= idleMs ? "idle" : null;
}

/**
 * Tracks wakes and false wakes and adapts the page's wake threshold.
 * Consecutive false wakes raise the SNR bar (boost) and impose a cooldown
 * before the next voice wake; a real wake (words heard) relaxes both.
 */
export class WakeGovernor {
  constructor({ clock }) {
    this.clock = clock;
    this.consecutiveFalse = 0;
    this.boostDb = 0;
    this.notBefore = 0;
    this.current = null; // {kind, at, heard}
    this.stats = { wakes_voice: 0, wakes_notify: 0, false_wakes: 0, sleeps: 0 };
  }

  /** A session was created. kind: "voice" | "notify" | "manual". */
  onWake(kind) {
    this.current = { kind, at: this.clock.now(), heard: false };
    if (kind === "voice") this.stats.wakes_voice++;
    else if (kind === "notify") this.stats.wakes_notify++;
  }

  get wokeBy() { return this.current ? this.current.kind : null; }
  get heardUser() { return !!this.current?.heard; }

  /** User words arrived in the current session. */
  onHeardUser() {
    if (!this.current || this.current.heard) return;
    this.current.heard = true;
    if (this.current.kind === "voice") {
      this.consecutiveFalse = 0;
      this.boostDb = Math.max(0, this.boostDb - BOOST_STEP_DB / 2);
      this.notBefore = 0;
    }
  }

  /** The session went to sleep (idle close). reason: "idle" | "false_wake". */
  onSleep(reason) {
    this.stats.sleeps++;
    if (reason === "false_wake") {
      this.stats.false_wakes++;
      this.consecutiveFalse++;
      this.boostDb = Math.min(MAX_BOOST_DB, this.boostDb + BOOST_STEP_DB);
      const cd = COOLDOWNS_MS[Math.min(this.consecutiveFalse, COOLDOWNS_MS.length - 1)];
      this.notBefore = cd ? this.clock.now() + cd : 0;
    }
    this.current = null;
  }

  /** Session ended some other way (pause, off, error): forget it without judging it. */
  onEnd() { this.current = null; }

  /** What the page needs to listen (PageStatus.wake). */
  pageConfig(sensitivity, enabled) {
    return {
      enabled: !!enabled && sensitivity !== "off",
      sensitivity,
      boost_db: this.boostDb,
      not_before: this.notBefore > this.clock.now() ? this.notBefore : 0,
    };
  }

  status(sensitivity) {
    return { sensitivity, boost_db: this.boostDb, consecutive_false: this.consecutiveFalse, ...this.stats };
  }
}

/** Seconds of idle before sleeping, from the config (idle_seconds wins over legacy idle_minutes). */
export function idleSecondsOf(config) {
  const s = Number(config?.idle_seconds);
  if (Number.isFinite(s) && s >= 0) return s;
  const m = Number(config?.idle_minutes);
  if (Number.isFinite(m) && m >= 0) return m * 60;
  return DEFAULT_IDLE_SECONDS;
}
