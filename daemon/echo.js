// Transcript echo filter (SPEC §6.8.1): drop the assistant's own voice, picked
// up by the microphone, from what reaches Claude (delegation requests, the
// transcript mirror, wake clips), and keep the user's own words even when both
// talk at once.
//
// Why a second line of defense behind the browser's echo canceller: on
// speakers, residual echo still reaches gpt-live-1 now and then, it transcribes
// it as user speech, and the old whole-line check (≥ 80 % of the words in
// order) missed echo mixed with real words and quote-backs looked like echo.
//
// How: the user's words are aligned (fuzzy, in order) with what the assistant
// said around the same time. The session timeline (`start_ms`) of both
// transcripts is shared, so an echo shows up as a run of ≥ 3 matching words
// heard ECHO_MAX_DELAY_MS or less after the assistant said them. A user
// quoting the assistant back ("the blue one") answers after it spoke them, so
// the delay is longer and the words stay. Matching tolerates ASR differences
// ("Claude"/"cloud", "two"/"2", one dropped or inserted word).
// A few of sotto's own fixed sentences ("I'm connected to Claude Code in …",
// "I just updated myself", voice samples) are dropped wherever they come from:
// another sotto voice in the room (a second session, a test run) sounds the same.
//
// Pure: callers pass fragments ({text, start_ms, end_ms, at}) and references.
import { normalizeWords } from "./transcript.js";

/** Assistant speech this long before a user line is compared with it. */
export const ECHO_WINDOW_MS = 15000;
/** An echo is heard at most this long after the assistant said the words (session timeline). */
export const ECHO_MAX_DELAY_MS = 1200;
/** …and a 3-word run (the weakest evidence) at most this long. */
export const ECHO_MAX_DELAY_SHORT_MS = 900;
/** Timestamps are 200 ms steps and the two timelines can be offset a little: allow the echo to look early. */
export const ECHO_MIN_DELAY_MS = -700;
/** Wall-clock references (other sessions, samples) have no shared timeline: this window, and stronger runs. */
const LEDGER_BEFORE_MS = 20000;
const LEDGER_AFTER_MS = 3000;
/** Minimum matched words for an echo run (session timeline / wall clock only). */
const MIN_RUN = 3;
const MIN_RUN_LEDGER = 4;
/** Gaps tolerated inside a run: an ASR word inserted on the user side, words skipped on the assistant side. */
const RUN_USER_GAP = 2;
const RUN_REF_GAP = 3;

// sotto's fixed sentences (prompt.js greetings, preview.js samples). Matched on
// normalized words. A user does not say these to their own assistant.
const VOICE_NAMES = "alloy|ash|ballad|beacon|bossa|cedar|cinder|coral|delta|echo|gleam|marin|meridian|quartz|ripple|sage|shimmer|stone|tempo|verse|vesper|willow";
export const SOTTO_PHRASES = [
  // Greeting: "Hey! I'm here and connected to Claude Code in dev." / "I'm here with Claude Code in forward."
  /\b(?:(?:hi|hey|hello)\s+)?(?:im|i am)\s+(?:here\s+(?:and\s+)?)?(?:connected\s+to|with)\s+claude\s+code(?:\s+in(?:\s+the)?\s+[a-z0-9]+(?:\s+project)?)?/g,
  /\b(?:and\s+)?connected\s+to\s+claude\s+code\s+in(?:\s+the)?\s+[a-z0-9]+(?:\s+project)?/g,
  // Update greeting ("I just updated myself."); speech recognition cut it to "I just updated my..." once.
  /\bi\s+just\s+updated\s+my(?:self\b|(?=\s+(?:okay|ok|so|now)\b)|$)/g,
  // Delegation acknowledgements: the assistant passes things on, the user does not.
  /\b(?:okay\s+)?(?:ill|i will)\s+pass\s+(?:that|this|it)\s+(?:on|along)(?:\s+to\s+claude(?:\s+code)?)?\b/g,
  /\bpassing\s+(?:that|this|it)\s+(?:on|along|to\s+claude)(?:\s+code)?\b/g,
  new RegExp(`\\bswitched\\s+to\\s+(?:${VOICE_NAMES})\\b`, "g"),
  new RegExp(`\\b(?:hi\\s+)?(?:im|i am)\\s+(?:${VOICE_NAMES})\\s+this\\s+is\\s+how\\s+i\\s+sound\\b`, "g"),
  /\bthis\s+is\s+how\s+i\s+sound\b/g,
];

// Words that carry no request on their own: a line whose only non-echo words
// are these is all echo.
const FILLER = new Set((
  "um umm uh uhh er erm hmm hm mm mmm mhm mmhm ah ahh oh ooh huh ok okay yeah yes yep so and but " +
  "the a an i im to of is it its that this in on you your well like just oh hey hi"
).split(" "));

const NUMBERS = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };

/** A rough sound-alike key: "claude" and "cloud" both give "kld". */
export function soundKey(w) {
  let s = String(w).toLowerCase()
    .replace(/ph/g, "f").replace(/ck/g, "k").replace(/[cq]/g, "k").replace(/z/g, "s").replace(/x/g, "ks");
  const head = s[0] || "";
  s = s.slice(1).replace(/[aeiouyhw]/g, "");
  return (/[aeiouy]/.test(head) ? "a" : head) + s.replace(/(.)\1+/g, "$1");
}

function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Same word, allowing for how speech recognition spells it. */
export function sameWord(a, b) {
  if (a === b) return true;
  if ((NUMBERS[a] || a) === (NUMBERS[b] || b)) return true;
  const n = Math.min(a.length, b.length);
  if (n >= 4 && soundKey(a) === soundKey(b)) return true;
  if (n >= 5 && lev(a, b, 1) <= 1) return true;
  return n >= 8 && lev(a, b, 2) <= 2;
}

/**
 * Words of fragments, each with its fragment, its whitespace piece and a time:
 * `t` on the session timeline (interpolated across the fragment), `at` wall ms.
 */
export function tokensOf(frags, { timed = true } = {}) {
  const out = [];
  frags.forEach((f, fi) => {
    const pieces = String(f.text ?? "").split(/\s+/).filter(Boolean);
    const words = [];
    pieces.forEach((p, pi) => { for (const w of normalizeWords(p)) words.push({ w, fi, pi }); });
    const s = Number(f.start_ms);
    const e = Number(f.end_ms);
    const hasT = timed && !f.prefix && Number.isFinite(s) && Number.isFinite(e) && e > 0;
    words.forEach((x, k) => {
      out.push({ ...x, t: hasT ? s + ((e - s) * k) / Math.max(1, words.length) : null, at: Number(f.at) || 0 });
    });
  });
  return out;
}

/** In-order fuzzy alignment (LCS) of user tokens `u` and reference tokens `r`, where `ok(i, j)` allows a pair. */
function align(u, r, ok) {
  const n = u.length;
  const m = r.length;
  if (!n || !m) return [];
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = ok(i, j) && sameWord(u[i].w, r[j].w) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (L[i][j] === L[i + 1][j + 1] + 1 && ok(i, j) && sameWord(u[i].w, r[j].w)) { pairs.push([i, j]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
};

/**
 * Which of the user's words are echo.
 * @param {object[]} userFrags  user transcript fragments, in order
 * @param {object} refs
 *   session: assistant fragments of the same Live session (shared timeline)
 *   ledger:  [{text, at}] speech without a shared timeline (earlier sessions, samples)
 * @param {object} [o]
 *   timed: false → ignore timing (a bare text; the old whole-text check)
 * @returns {{verdict:"clean"|"partial"|"echo", frags:object[], words:number, echoWords:number,
 *            phraseWords:number, runs:{n:number, delay_ms:number|null, src:string}[]}}
 *   frags: copies of userFrags with echo words removed (empty ones dropped).
 */
export function analyzeEcho(userFrags, refs = {}, { timed = true } = {}) {
  const u = tokensOf(userFrags, { timed });
  const echo = new Uint8Array(u.length);
  const runs = [];

  const markRuns = (ref, src, allow, minRun, delayOk) => {
    if (!ref.length) return;
    const pairs = align(u, ref, allow);
    let cur = [];
    const close = () => {
      if (cur.length >= minRun) {
        const delays = cur.map(([i, j]) => (src === "session" ? u[i].t - ref[j].t : u[i].at - ref[j].at)).filter(Number.isFinite);
        const d = delays.length ? median(delays) : null;
        if (delayOk(d, cur.length)) {
          // Only the matched words: an unmatched word inside the run may be the
          // user talking over the assistant (double talk), so it stays.
          for (const [i] of cur) echo[i] = 1;
          runs.push({ n: cur.length, delay_ms: d == null ? null : Math.round(d), src });
        }
      }
      cur = [];
    };
    for (const p of pairs) {
      const last = cur[cur.length - 1];
      if (last && (p[0] - last[0] > RUN_USER_GAP || p[1] - last[1] > RUN_REF_GAP)) close();
      cur.push(p);
    }
    close();
  };

  // 1. Same session: time-aligned.
  const sess = tokensOf(refs.session || [], { timed });
  const useTime = timed && u.some((x) => x.t != null) && sess.some((x) => x.t != null);
  markRuns(
    sess, "session",
    useTime
      ? (i, j) => u[i].t == null || sess[j].t == null || (u[i].t - sess[j].t >= ECHO_MIN_DELAY_MS && u[i].t - sess[j].t <= ECHO_MAX_DELAY_MS)
      : () => true,
    MIN_RUN,
    (d, n) => !useTime || d == null || (d >= ECHO_MIN_DELAY_MS && d <= (n <= MIN_RUN ? ECHO_MAX_DELAY_SHORT_MS : ECHO_MAX_DELAY_MS)),
  );
  // 2. Ledger (wall clock): stronger runs only.
  const led = tokensOf((refs.ledger || []).map((l) => ({ text: l.text, at: l.at, start_ms: 0, end_ms: 0 })), { timed: false });
  markRuns(
    led, "ledger",
    timed ? (i, j) => !u[i].at || !led[j].at || (u[i].at - led[j].at >= -LEDGER_AFTER_MS && u[i].at - led[j].at <= LEDGER_BEFORE_MS) : () => true,
    timed ? MIN_RUN_LEDGER : MIN_RUN,
    () => true,
  );

  // 3. sotto's own fixed sentences.
  const phrase = new Uint8Array(u.length);
  const joined = u.map((x) => x.w).join(" ");
  if (joined) {
    const starts = [];
    let pos = 0;
    for (const x of u) { starts.push(pos); pos += x.w.length + 1; }
    for (const re of SOTTO_PHRASES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(joined))) {
        if (!m[0]) { re.lastIndex++; continue; }
        const a = m.index;
        const b = a + m[0].length;
        u.forEach((x, k) => { if (starts[k] >= a && starts[k] < b) phrase[k] = 1; });
      }
    }
  }

  let echoWords = 0;
  let phraseWords = 0;
  const kept = [];
  u.forEach((x, k) => {
    if (echo[k]) echoWords++;
    else if (phrase[k]) phraseWords++;
    else kept.push(x);
  });
  const words = u.length;
  if (!echoWords && !phraseWords) return { verdict: "clean", frags: userFrags.slice(), words, echoWords: 0, phraseWords: 0, runs };
  const content = kept.filter((x) => !FILLER.has(x.w)).length;
  if (content < 2) return { verdict: "echo", frags: [], words, echoWords, phraseWords, runs };

  // Rebuild each fragment from the whitespace pieces that still hold a user word.
  const drop = new Set();
  const keepPiece = new Set();
  u.forEach((x, k) => {
    const key = `${x.fi}:${x.pi}`;
    if (echo[k] || phrase[k]) drop.add(key);
    else keepPiece.add(key);
  });
  const frags = [];
  userFrags.forEach((f, fi) => {
    const lead = /^\s*/.exec(String(f.text ?? ""))[0];
    const pieces = String(f.text ?? "").split(/\s+/).filter(Boolean);
    const out = pieces.filter((p, pi) => keepPiece.has(`${fi}:${pi}`) || !drop.has(`${fi}:${pi}`));
    if (out.length) frags.push({ ...f, text: lead + out.join(" ") });
  });
  return { verdict: "partial", frags, words, echoWords, phraseWords, runs };
}

/** Assistant fragments that could have been echoed during `frags` (same session timeline). */
export function sessionReference(assistantFrags, frags) {
  const timed = frags.filter((f) => !f.prefix && Number(f.end_ms) > 0);
  if (!timed.length) return [];
  const s = Math.min(...timed.map((f) => Number(f.start_ms) || 0));
  const e = Math.max(...timed.map((f) => Number(f.end_ms) || 0));
  return assistantFrags.filter((a) => a.end_ms >= s - ECHO_WINDOW_MS && a.start_ms <= e - ECHO_MIN_DELAY_MS);
}
