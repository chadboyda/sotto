# Native Sotto app (v0.3.0): the binding contract

Status: binding for the `feat/native-app` build-out. Changing a name, shape or number below means editing this file in the same commit and telling the other builders in the commit message. SPEC.md remains the contract for everything this file does not change; builders record every divergence in SPEC-DEVIATIONS.md.

**Architecture: the daemon owns the session.** For the native app, the daemon opens the OpenAI Live **primary WebSocket** (`wss://api.openai.com/v1/live/sessions`) itself and runs all existing logic on it: delegation, policy and speaker, speech queue, mirror, echo filter, wake and sleep, voice switch, key setup, self-update restart. The native app is audio I/O plus a SwiftUI UI. It talks to the daemon over one authenticated loopback WebSocket that carries binary PCM16 frames and JSON messages. The Chrome page keeps WebRTC + sideband + SSE **unchanged** and stays the fallback.

```
 Sotto.app (SwiftUI)                    daemon (Node 22)                               OpenAI
 SottoAudio  mic 20 ms frames ──bin──▶  native.js ─▶ NativeController ─▶ pacer ─▶ PrimarySession ──wss──▶ gpt-live-1
             playout  ◀──────── bin ──  (/api/native)   (native-session.js)        (live-ws.js)  ◀────
 SottoUI     StateModel ◀────── json ── status / captions / activity / notices ...
 SottoApp    commands ──────── json ─▶  voice.js (unchanged core: delegation, policy, speech, mirror, echo, wake)
 Chrome page (fallback): WebRTC + sideband + SSE exactly as today
```

Live API facts this rests on (the public OpenAI Live API reference for the primary WebSocket; `daemon/preview.js` already runs this path in production):
- Connect with `Authorization: Bearer <key>`. The first message is `session.start` (the `session` object of `buildSessionBody()` minus `client`, plus `audio.format {type:"audio/pcm", rate:24000}`). Send no audio before `session.started`.
- Input is `session.input_audio.append {audio:<base64 pcm16 24 kHz mono>}`. **It must stream continuously in real time.** Without input the session timeline stops and the model never speaks.
- Output is `session.output_audio.delta {delta:<base64>}`, paced in real time. Primary deltas carry no `start_ms`/`end_ms`, and there is no "audio done" event.
- There is no interruption or truncate event. The model stops talking when the user barges in, and the frames after that are silence.
- The daemon's existing client commands (`session.update`, `input_audio.mute`/`unmute`, `instructions`/`thinking`/`commentary.append`, `session.close`) and server events (transcript deltas, `delegation.created`, `usage.updated`, `closed`, `error`, `info`) have the same shapes on the primary socket as on the sideband.
- Voice, format, instructions and delegation are immutable, so a voice switch still means close plus a new session. A primary session bills per second with no 15 s minimum.

---

## 1. Loopback WebSocket endpoint

| Item | Value |
|---|---|
| URL | `ws://127.0.0.1:<daemon port>/api/native` (the existing HTTP server's `upgrade` event; no new port) |
| Subprotocol | `Sec-WebSocket-Protocol: sotto-native.v1` (the daemon echoes it; absent is also accepted) |
| Host check | `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, else HTTP 421 `bad_host` |
| Origin check | The `Origin` header must be **absent**, else 403 `bad_origin`. Every browser sends one, so no web page can open this socket. |
| Auth | Header `X-Sotto-Page: <page token>`, compared in constant time. No query-string token. Else 403 `bad_token`. |
| Token source | `GET /api/bootstrap` (unchanged) with `X-Sotto-Launch: <k>` (the one-time code from `sotto://open?port=<p>&k=<k>&data=<dataDir>`) or `X-Sotto-Boot: <page secret>` (read from `<dataDir>/page.secret`, only after the existing `daemonRecordsPort` ownership checks). The response gives `page_token`, `page_secret`, `version`, `build`, `status`. The app keeps both in memory only. |
| Max message | 1 MiB (close 1009) |
| Clients | One native client. A new authenticated hello replaces the old connection, which gets close `4002 replaced` (log `native.replaced`). |
| Keepalive | The daemon sends `ping` JSON every 5 s. The app answers `pong`. WS-level ping/pong is also answered. No pong within 15 s means the daemon closes with 1001 and treats the app as gone (§4.4). |

**Handshake.** The app sends a text frame first, within 5 s (else close `4003 hello_timeout`):
```json
{"type":"hello","protocol":1,"client":"app","version":"0.3.0","build":"<sources hash or null>","test":false,
 "capabilities":["native_audio"],"audio":{"rate":24000,"frame_ms":20,"format":"pcm16le"}}
```
If `protocol` is not 1, the daemon closes with `4001 protocol_mismatch` and the app shows "Update Sotto" plus **Open in Browser**. Otherwise the daemon replies:
```json
{"type":"welcome","protocol":1,"version":"0.3.0","build":"<web build hash>","status":{...PageStatus},"settings":{...Settings}}
```
Nothing else is sent before `welcome`. From `welcome` on, the app is **the audio client** (§4.3).

**Close codes:** 1000 normal, 1001 going away, 4001 protocol_mismatch, 4002 replaced, 4003 hello_timeout, 4004 bad_message (unparseable JSON, unknown binary kind), 4005 daemon_exit (the daemon is shutting down or handing over for a self-update; the app reconnects).

**App reconnect.** After any close except 4001 and 4002, the app retries with backoff 0.05, 0.25, 0.5, 1, 2 s, then every 2 s, for 60 s, then goes idle until the next `sotto://open`. Every retry re-bootstraps with `X-Sotto-Boot` first, because the page token changes when the daemon restarts. A 403 on bootstrap means the secret is stale, so the app re-reads `page.secret`. Credentials are sent only to the port `<dataDir>/daemon.port` records at that moment: once the daemon exits (it removes the file) the app keeps retrying without sending anything, so a process that takes the freed port never gets the page secret. A launch code is kept until the daemon answers; a refused code is final (`.failed("launch_refused")`), never a fallback to `page.secret`. A `sotto://open` with a code for the daemon the app is already connected to is verified with its own bootstrap first, and a refused one leaves the working link alone.

---

## 2. Audio

### 2.1 Binary frames (both directions)
Little-endian, 16-byte header, then PCM:

| Offset | Size | Field |
|---|---|---|
| 0 | u8 | `kind`: 1 = mic (app → daemon), 2 = speaker (daemon → app) |
| 1 | u8 | `flags`. Mic: `0x01 MUTED` (the payload is zeros), `0x02 FAKE` (test audio). Speaker: `0x01 AFTER_FLUSH` (the first frame after `audio_flush`) |
| 2 | u16 | reserved, 0 |
| 4 | u32 | `seq`, per direction and connection, starting at 0 and wrapping |
| 8 | u64 | timestamp in ns. Mic: capture host time (`clock_gettime_nsec_np(CLOCK_UPTIME_RAW)` of the frame's first sample). Speaker: daemon `process.hrtime.bigint()` when the delta arrived from OpenAI |
| 16 | n | PCM16LE mono 24 kHz |

- **Mic frames are exactly 960 bytes of PCM (480 samples, 20 ms).** Other sizes close the socket with 4004.
- **Speaker frames are 960 bytes.** The daemon re-chunks deltas (`createRechunker`) and zero-pads the tail at a flush.
- Golden vector, pinned by both test suites: mic, flags MUTED|FAKE, seq 7, ts `0x0123456789abcdef`, samples [1, −129] → `0103000007000000efcdab896745230101007fff`.
- The codec is implemented in `daemon/native-proto.js` and `app-native/Sources/SottoClient/Protocol.swift`. Use them; do not re-implement.

### 2.2 Uplink (the app's mic)
- **Continuous.** While the app is attached and `status.state` ∈ {`connecting`, `live`, `reconnecting`, `sleeping`}, the app sends one mic frame every 20 ms from its capture clock. In `paused`, `off` and `closing` it sends nothing, and it releases the input device (privacy; the menu-bar mic indicator goes off).
- **Mute.** While muted, the app sends frames of zeros with `MUTED` set, never mic data. The daemon also zeroes any frame while `live.muted` is set, as a defense.
- The daemon never sends mic audio to OpenAI when no session is open. In `sleeping`, frames go only to the daemon's local wake VAD (§4.5). Audio is never logged or written to disk.

### 2.3 Daemon input pacer (`daemon/pacer.js`)
- It ticks every 20 ms while a PrimarySession is ready and forwards queued app frames as `session.input_audio.append`.
- When the app falls more than 60 ms behind the wall clock, it sends silence to fill the gap (counter `pacer_fill_frames`). Frames that arrive later are **not** charged against the filled gap (v0.3.1 did that, and after a capture rebuild, route change or sleep/wake, whose missing audio never arrives, it dropped every later frame and sent only silence). Instead the latency is bounded: a queue above 3 frames (60 ms) for 500 ms is trimmed back to 3 (counter `dropped_late`), and a `route` message trims it at once (`resync`). The timeline never counts time twice because frames only leave at wall-clock rate.
- Queue cap: 10 frames (200 ms). Past that, drop the oldest (counter `pacer_dropped`).
- Over each 5 s window, more than 5 % of the app's frames dropped, or silence sent for more than 5 % of the slots while the app was sending, logs `pacer.drop_rate` (warn) with the counts; `drop_warnings` counts them in `native.audio`.
- If the app disconnects while live, the pacer keeps filling silence for up to 10 s (`APP_GRACE_MS`) and then calls `voice.pause("app_gone")`.
- It exposes the session timeline `inputMs = framesSent × 20`.

### 2.4 Downlink (the model's voice)
- The daemon forwards each `session.output_audio.delta` as soon as it arrives: decode, re-chunk to 960-byte speaker frames, send. The daemon adds no pacing, because OpenAI already paces in real time.
- Backpressure: if the link's `bufferedAmount` is over 256 KiB, speaker frames are dropped and counted (`native_speaker_dropped`). This happens only when the app is stuck.
- App jitter buffer: target 60 ms (minimum 40, maximum 200). Start playout when the target is reached.
  - On underrun, play silence and raise the target by 20 ms for 30 s.
  - On overrun (> 300 ms), drop only quiet frames (peak < 1200) until the buffer is back at target.
- **Flush.** The daemon sends `{"type":"audio_flush","reason":R}`, where R is one of `session_end` | `voice_change` | `pause` | `sleep` | `off` | `barge_in`. It sends it when the session closes or is replaced, and the next speaker frame carries `AFTER_FLUSH`. On a flush the app drops its buffer at once with a ≤ 5 ms fade. `barge_in` is reserved: the daemon does not emit it in v0.3.0, because the model goes silent on its own. The app treats every reason the same.

### 2.5 Clock and latency stamps
- About once a second, the app sends `{"type":"audio_stats","playout_seq":N,"playout_host_ns":T,"buffer_ms":B,"underruns":U,"overruns":O,"capture_drops":D,"mode":"vpio|split|listen|fake","mic_seq":M}`. `playout_seq`/`playout_host_ns` name the speaker frame that was audible at that host time. The daemon logs a summary every 30 s (`native.audio`).
- `ping {t}` / `pong {t}` (`t` is daemon ms) gives the daemon the link RTT.
- The daemon stamps `lastAssistantAudibleAt` from speaker frames with a peak ≥ 1200, delayed by `buffer_ms`. That is the alignment the echo and hearing monitors need.

---

## 3. JSON messages

Every text frame is one JSON object with a `type` string. Unknown types are ignored (logged at debug). Names are snake_case, as in SSE. Constants live in `daemon/native-proto.js` (`SERVER_TYPES`, `CLIENT_TYPES`, `COMMANDS`, `LIVE_FORWARD`).

### 3.1 Daemon → app

| type | Payload | When |
|---|---|---|
| `welcome` | `protocol, version, build, status, settings` | once, after hello |
| `status` | `status: PageStatus` | **a full snapshot on every change** (the same trigger as the SSE `status`, `voice.changed()`). There are no status patches: the app replaces its copy each time. |
| `settings` | `Settings` | after `welcome`, and whenever the voice list, persona list or choice, window pref or voice-switch state changes |
| `activity` | `kind, text, …extra` | verbatim SSE `activity`. `kind` ∈ `turn_start`, `turn_end`, `text`, `tool`, `permission` (with `agent`: a subagent's approval), `approval_cleared` (with `busy`; SPEC §6.10.4), `agents` (with `count`), plus any the page's `lib.activityView` knows. `status.claude.approval` null clears a shown approval |
| `delegation` | `id, status, text` | verbatim SSE `delegation` |
| `notice` | `level` (`info`\|`warn`\|`error`), `code`, `text` | verbatim SSE `notice`. Native adds codes `cant_hear`, `echo_detected`, `app_took_over` (page only), `mic_error` |
| `notice_clear` | `code` | when a condition ends (e.g. `cant_hear` once the user is heard) |
| `result_pending` | `text` | verbatim SSE |
| `wake_heard` | `text` | verbatim SSE: words spoken before a woken session could hear them (show as a user caption) |
| `command` | `command, reason` | verbatim SSE. The app acts only on `close_window` (voice off: hide the panel, stop audio, keep the menu-bar item) and `play_echo_sample` (play the cached voice sample, `GET /api/voice-preview?voice=<current>&cached=1`, through the output unit, then send `played {what:"echo_test"}`). It ignores `connect`/`disconnect`/`reconnect`, which the daemon handles itself for native clients |
| `caption` | `role` (`user`\|`assistant`), `text` (a delta), `start_ms`, `end_ms`, `session` (Live id) | for every `session.input_transcript.delta` / `output_transcript.delta`, raw (not echo-filtered). The app reduces them with the port of `lib.reduceCaptions` (joins same-role deltas within 1500 ms, keeps 60 lines) |
| `live` | `event: {…}` | the other allowlisted Live server events, verbatim: `session.started`, `session.closed`, `session.input_audio.muted`, `session.input_audio.unmuted`, `session.usage.updated`, `error`, `info` |
| `audio_flush` | `reason` | §2.4 |
| `ping` | `t` | every 5 s |
| `result` | `id, ok, data?` or `id, ok:false, error:{code,message}` | exactly one per `cmd` |

**PageStatus**: exactly `voice.pageStatus()` plus one new field. The page's SSE status carries these fields, and the page ignores the new one.
```
state            "off"|"waiting_page"|"connecting"|"live"|"reconnecting"|"sleeping"|"paused"|"closing"
owner            {project, cwd} | null
voice            string
persona          string                  (the persona id in effect, SPEC §4.6; also set from the terminal)
speaking_policy  "quiet"|"milestones"|"walkthrough"
idle_minutes     number
idle_seconds     number
echo_guard       "auto"|"on"|"off"
echo_heard_ms_ago number|null
wake             {enabled, sensitivity, boost_db, not_before}
live             {session_id, expires_at, usage_seconds, muted} | null
today            {seconds, cap_minutes}
claude           {busy}
last_error       {code, message} | null
key              {present, source, file, hint, label, can_change, can_remove, keychain, setup}
audio_client     "app"|"page"|null      (NEW, added by B2)
```

**Settings**:
```
{ "voices": {voices:[...], current, live, live_voice}      // voice.voices()
  "personas": {personas:[{id, name, description, voice|null, source}], current, use_voice, live, live_persona}
                                                            // voice.personas(): summaries, never a persona's text;
                                                            // source "builtin"|"user"|"project"; use_voice = the
                                                            // "Switch to the persona's own voice" toggle (added in 0.3.1)
  "window": "auto"|"app"|"chrome"|"default",                // voice.windowPref()
  "policies": ["quiet","milestones","walkthrough"],
  "wake_sensitivities": ["off","low","medium","high"],
  "data_dir": "<absolute path>",                            // so the app can open logs/ itself
  "version": "0.3.0" }
```

Usage and timers are derived by the app: the header's Session / Today / Cost readout (v0.3.2, quiet capsule since fix/pills-v2; the page's `lib.usagePills`) come from the Live session start, `status.today.seconds` + `status.live.usage_seconds` (throttled by `lib.stableUsage`, advanced by wall time while live by `lib.tickingToday`; the price per second is the page's `lib` constant), and "Claude working for 0:42" comes from the `activity` `turn_start` receive time. The daemon adds nothing for these.

### 3.2 App → daemon (non-command)

| type | Payload | Daemon action |
|---|---|---|
| `hello` | §1 | handshake |
| `route` | `mode, input:{id,name,bluetooth}, output:{id,name,bluetooth,headphones}, echo_cancellation` | log `native.route`; kept for `/status` |
| `audio_stats` | §2.5 | stats/log |
| `pong` | `t` | RTT |
| `played` | `what` (`sample`\|`echo_test`), `voice` | same as page `played` → `onPagePlayed` (the echo filter learns the sample's words) |
| `log` | `level, message` | same as page `log` (`src:"app"`) |
| `system` | `event` (`sleep`\|`wake`) | Mac sleep: a graceful close. Live → `sleeping` (or `paused` with wake off). Mac wake: nothing (the app restarts audio; the session resumes only on voice/notify wake or user action) |
| `mic_error` | `name, message` | same as page `mic_error` |
| `activity` | `{}` | user touched the UI (same as page `activity`) |

### 3.3 Commands: `{"type":"cmd","id":"<uuid>","name":N,"args":{…}}`
Each is answered by `result` with the same `id` within 10 s (the app times out at 15 s and shows the error). Error codes are the ones the HTTP routes use today.

| name | args | Maps to | result `data` |
|---|---|---|---|
| `mute` | `on: bool` | `session.input_audio.mute`/`unmute` on the primary; `live.muted` | `{muted}` |
| `pause` | — | `voice.pause("pause")` (closes the session; state `paused`) | `{}` |
| `resume` | — | start a native session with reason `resume` (from `paused`/`waiting_page`/`sleeping`) | `{}` |
| `wake` | — | start a native session with reason `wake` from `sleeping` (a user tap, not voice) | `{}` |
| `end` | — | `voice.off("user")` (same as page `stop`) | `{}` |
| `set_voice` | `voice` | `voice.setVoice(voice, "app")` | `{voice, switching, message}` |
| `set_persona` | `persona?`, `use_voice?` (at least one) | as `POST /api/persona`: `use_voice` → `voice.setPersonaVoice`, then `persona` (id or name) → `voice.setPersona(persona, "app")`; error `bad_persona` | `{persona, voice, switching, message, use_voice}`, or `{use_voice}` for the toggle alone (added in 0.3.1) |
| `set_policy` | `policy` | `voice.setPolicy` | `{policy}` |
| `set_wake` | `sensitivity` | `voice.setWakeSensitivity` | `{sensitivity}` |
| `set_window` | `mode` | `voice.setWindow(mode)` | `{window, message}` |
| `key_save` | `key` | `voice.saveKey(key)`. **Args never logged** (native.js redacts `cmd` args for `key_save`) | the `/api/key` POST body (hint only) |
| `key_remove` | — | `voice.removeKey()` | the `/api/key/remove` body |
| `get_voices` | — | `voice.voices()` | that object |
| `echo_test` | — | run the echo measurement (§4.5): the daemon sends `command {command:"play_echo_sample"}`, measures the mic against it, and answers | `{verdict, leak_db, corr, level}` |
| `open_browser` | — | open the Chrome page as a manual fallback (window.js `open()` with want `chrome`). The daemon drops the app as audio client first | `{mode}` |

These are handled **in the app**, with no daemon command: mic/speaker list and choice (CoreAudio), echo cancellation Automatic/Always/Never (UserDefaults), "Open logs" (opens `<data_dir>/logs/daemon.log` via NSWorkspace), hotkeys, panel geometry, stay-in-menu-bar.
**Voice preview** uses the existing HTTP route: `GET /api/voice-preview?voice=<v>` with `X-Sotto-Page` (WAV). The app plays it through its output unit (so VPIO has the reference) and then sends `played {what:"sample", voice}`.

---

## 4. Daemon layout and behavior

### 4.1 Modules
| File | Owner | Role |
|---|---|---|
| `daemon/native-proto.js` | contract (done) | constants, frame codec, rechunker. Pure, tested. |
| `daemon/wsserver.js` | B1 | minimal RFC 6455 server over `node:http` `upgrade`: handshake, masking, fragmentation, ping/pong, close, 1 MiB cap. Pure frame encode/parse exported for tests. Zero deps. |
| `daemon/native.js` | B1 | `createNativeEndpoint({port, pageToken, controller, log, clock})`: Host/Origin/token checks, subprotocol, hello timeout, protocol check, one-client replace, JSON parse + type allowlist, binary decode + size check, keepalive, redaction. Hands off to `NativeController`. |
| `daemon/native-session.js` | B2 | `NativeController`: the seam between the link and `voice.js`: `attach(link, hello)` → welcome payload, `detach`, `onMessage`, `onMicFrame`, `connected`. Owns the pacer, the rechunker, the SSE→native fan-out (it subscribes to what `voice.js` broadcasts), captions, the `cmd` dispatch. |
| `daemon/live-ws.js` | B2 | `PrimarySession`: the same surface as `Sideband` (`connect/send/append/close`, `id`, `state`, `expiresAt`, events `ready/event/ack/append_failed/session_closed/lost/socket_closed`) plus `pushAudio(pcm)` and event `audio`. `buildPrimaryStart()` is done. |
| `daemon/pacer.js` | B2 | §2.3, pure, clock-injected. |
| `daemon/voice.js` | B2 | the split (below). No other builder edits voice.js. |
| `daemon/index.js`, `daemon/http.js` | B1 | wire `server.on("upgrade", endpoint.handleUpgrade)` (a non-matching path gets 404 + destroy); construct `NativeController` with `voice`. |
| `daemon/window.js` | B6 | chooser + source hash + launch (§4.6). |
| `test/helpers/fake-native-app.js` | B1 | Node client speaking this protocol (global `WebSocket` + headers). It streams frames from a WAV or silence at 20 ms, collects speaker frames into a Buffer and records JSON. Used by B1/B2 tests and the daemon e2e. |
| `test/helpers/fake-live-server.js` | B2 | a fake primary-WS Live server (session.start → session.started, echoes transcripts, emits paced output deltas from a WAV, delegation.created on cue). |

### 4.2 voice.js split (B2)
- Split `createSession({sdp,…})` into `prepareSession(reason)`, which holds the owner/cap/key/restart checks, seed, vocabulary, instructions and bookkeeping, plus two transports:
  - `createWebRtcSession` is today's SDP proxy + `attachSideband`, **byte-for-byte behavior**.
  - `startNativeSession(reason)` creates a `PrimarySession` and assigns it to `this.sideband`. Every `deliver/append/close` path is then unchanged. `onSidebandReady` fires on `session.started`.
- `this.audioClient` is `"app"` | `"page"` | `null`. Wherever voice.js now sends SSE `command connect|reconnect`, it calls `startNativeSession(reason)` directly when `audioClient === "app"`. That covers start on `waiting_page`, resume, the expiry reconnect, the voice switch (after `session.closed`, ≤ 2 s), notify wake, voice wake and self-update `restore()`.
- Output audio: `PrimarySession` `audio` → `NativeController` → speaker frames. Transcript/usage/muted/closed/error/info events flow through `onLiveEvent` as today, and `NativeController` also forwards them as `caption`/`live`.
- A lost primary socket goes to `reconnect("primary_lost")`, with the existing limiter (≤ 3 per 10 min) and backoff 0.5/1/2 s.
- A handshake failure before `open` runs `checkKey()` once to map the failure to `openai_auth` or `openai_error`.
- One audio client: when the app attaches while an SSE page holds the session, the page gets `command disconnect` with reason `app_took_over` plus a `notice` "Voice is in the Sotto app". The Live session is re-created on the native path (`reconnect`). When the app detaches past the grace period, the state is `paused`, and a page that connects later works as today.
- `pageStatus()` gains `audio_client`. The page ignores it.

### 4.3 Session lifecycle for the app
1. `/talk on` binds the owner, and `window.open()` chooses the app.
2. The daemon runs `open -a <bundle> 'sotto://open?port=P&k=CODE&data=D'`. The URL is unchanged from today.
3. The app bootstraps, connects, and sends `hello` → `welcome`. The daemon sets `audioClient="app"`. If state is `waiting_page`, it calls `startNativeSession("start")`.
4. The app starts capture on `welcome` whenever the state is connecting/live/reconnecting/sleeping, so frames already flow when `session.started` arrives. The pacer starts on ready, and the greeting follows as today.
5. On voice off, the daemon sends `audio_flush off` and then `command close_window`. The app stops audio and hides the panel. The link stays up while the daemon lives.

### 4.4 App gone, self-update, Mac sleep
- **App link lost while live:** the pacer fills silence for ≤ 10 s. On reattach it continues with the same session. After 10 s: `pause("app_gone")`.
- **Self-update handover (SPEC §6.17):** `prepareRestart` closes the primary session at a quiet moment and closes the link with 4005. The successor listens on the same port. The app re-bootstraps with `X-Sotto-Boot` and reconnects. `restore()` sees `audioClient` restored on hello and calls `startNativeSession("reconnect")` with the update greeting. The snapshot records `audio_client:"app"`, so the successor waits ≤ 10 s for the app's hello before it falls back to `waiting_page`.
- **Mac sleep:** the app sends `system {event:"sleep"}` on `NSWorkspace.willSleepNotification` (§3.2).

### 4.5 Parity on relayed audio (B2, milestone M3)
The daemon now sees both streams, so it runs the page's **pure** modules in Node instead of porting them to Swift. They are imported from `web/`.
- **Voice wake:** while `sleeping`, `createVad` (profile `native`: high-passed analysis, `SENSITIVITY_NATIVE`, floor seeded from the mic's floor measured while live; SPEC §7.6)/`createClipRecorder` from `web/wake.js` run on mic frames. `wake.listen` logs `profile` and `floor_db`, `wake.trigger` adds `level_db`, `floor_db` and `near_misses`, and near misses are `wake.near` at debug level. On a trigger, the daemon calls `startNativeSession("wake")` and passes the clip to the existing `onWakeAudio` path. `WakeGovernor` and its cooldowns are unchanged.
- **Can't hear:** `createHearingMonitor` from `web/lib.js` runs on mic RMS. It raises `notice cant_hear` and later sends `notice_clear cant_hear`. `onCantHear` is unchanged.
- **Echo:** `createLeakEstimator`/`classifyLeak` from `web/echo.js` compare speaker frames (aligned by `audio_stats`) with the mic. The result goes to `onPageEcho` and, above threshold, `notice echo_detected`. There is no echo gate DSP in v0.3.0, because VPIO does the AEC. The transcript echo filter (SPEC §6.8.1) is unchanged.

### 4.6 window.js (B6)
- `chooseWindow`: `auto`/`app` pick the app whenever it is `ready` on darwin. The Bluetooth-input → Chrome rule and `needRoute` are removed, because the native app never opens a Bluetooth input for capture (§5.3). Chrome remains for non-macOS, a missing or broken app, or `window: chrome`/`default`.
- The launch is unchanged (`open -a` + `sotto://open`). The app-opened check (`APP_PAGE_TIMEOUT_MS`, 15 s) now waits for the native `hello` (`controller.connected`) instead of a page hello. On timeout the daemon marks the app broken for the session and opens Chrome (as today).
- `appSourceHash` and `build-app.sh source_hash` hash **`app-native/**` minus `.build/` and `.swiftpm/`**, plus `scripts/build-app.sh`. The same byte-order sort and line format are used in both.
- `APP_TEST_ENV` becomes `SOTTO_APP_DEBUG_LOG`, `SOTTO_APP_MIC_FIXTURE`, `SOTTO_APP_MIC_FIXTURE_LEAD_MS`, `SOTTO_APP_OUT_WAV`, `SOTTO_APP_ECHO_SIM_DB`, `SOTTO_APP_TEST` (as built, also `SOTTO_APP_TEST_MUTE_AFTER_MS` and `SOTTO_APP_MIC_QUEUE_DIR`).

---

## 5. Swift package `app-native/`

```
app-native/
  Package.swift                 swift-tools 6.0, macOS 14, Swift 5 language mode, no dependencies
  Bundle/Info.plist             CFBundleIdentifier com.chadboyda.sotto, LSUIElement, CFBundleURLTypes sotto, LSMinimumSystemVersion 14.0,
                                NSMicrophoneUsageDescription, CFBundleShortVersionString 0.3.0
  Bundle/Sotto.entitlements     com.apple.security.device.audio-input only (hardened runtime)
  Sources/SottoAudio/           B3: AudioIO impls. No SottoClient import.
  Sources/SottoClient/          B4: Protocol.swift (codec, done), Messages.swift, DaemonLink.swift → LinkClient, Bootstrap, LaunchRequest parsing
  Sources/SottoUI/              B5: StateModel + views
  Sources/SottoApp/             B6: main.swift, AppDelegate, MenuBar, FloatingPanel, Hotkeys, URL scheme, single instance, Options, Controller
  Tests/Sotto{Audio,Client,UI}Tests/   XCTest, silent, no devices, no network
```
Target graph: `SottoApp` → {`SottoAudio`, `SottoClient`, `SottoUI`}. `SottoUI` → `SottoClient`. `SottoAudio` depends on nothing. The public surfaces stubbed in the contract commit (`AudioIO`, `PCMFrame`, `AudioDevice`, `AudioRouteInfo`, `PlayoutStats`, `EchoCancellation`; `DaemonLink`, `LinkState`, `LaunchRequest`, `WireFrame`, `PageStatus`, `ServerMessage`, `ClientMessage`, `JSONValue`; `StateModel`, `PanelView`, `CommandError`) may gain members, but must not lose or rename any without a NATIVE.md edit.

### 5.1 SottoApp (B6)
- `NSApplication` accessory app (LSUIElement). There is **one instance per bundle id**: a second launch forwards its URL through LaunchServices and exits.
- Menu bar: an `NSStatusItem` whose icon follows state (off/connecting/live/you speaking/assistant speaking/Claude working/muted/sleeping/paused/error). The menu holds Show/Hide Panel, Mute (⌥⌘M), Pause/Resume, End Voice, Open in Browser, Open Logs, Settings…, Quit.
- Floating panel: an `NSPanel` (non-activating, floating, all Spaces, resizable) hosting `NSHostingView(PanelView)`, with frame persistence. Hide really orders the panel out, since there is no WebKit visibility trick anymore.
- Hotkeys: M / Space in the panel (the `web/lib.js` `hotkeyAction` rules: Space resumes when paused and wakes when sleeping). Global ⌥⌘M for mute and ⌥⌘T for show / expand / hide, the WKWebView app's defaults, overridable with the `HotkeyMute` / `HotkeyShow` defaults (B6: ⌥⌘T kept instead of ⌥⌘S so existing muscle memory and prefs carry over).
- Voice off (`command close_window`): the app stops audio, hides the panel and then **quits unless "Stay in Menu Bar When Voice Is Off" is on** (`StayResident`), the WKWebView app's behavior; the daemon relaunches it on the next `/talk on`. The link stays up while the app runs.
- URL scheme: `sotto://open?port&k&data` → daemon ownership check (port Support.swift's `daemonRecordsPort`) → a launch code is required (any web page can fire the URL; a code-less one only re-shows the panel for the daemon already connected) → `DaemonLink.connect`. `sotto://close?port` → hide the panel and stop audio. `sotto://show` → show the panel.
- **Controller** wiring:
  - link `onMessage` → `StateModel.apply`, and state drives `AudioIO.start/stop` (§2.2).
  - `audio_flush` → `flushPlayback`.
  - Speaker frames → `enqueuePlayback`.
  - `onMicFrame` → `WireFrame(kind:.mic)` → `sendMicFrame`.
  - `onRoute` → `route` message; `stats()` every 1 s → `audio_stats`.
  - `StateModel.sendCommand` → `cmd`/`result` correlation.
  - `NSWorkspace` sleep → `system`.
- Controller wiring uses B4's `AudioPump` (SottoClient) for the protocol rules (seq, MUTED/FAKE, flush ordering, capture demand from the state, `audio_stats`); SottoApp gives it the engine (`setCapture` → `AudioIO.start/stop`, `play` → `enqueuePlayback`, `flush` → `flushPlayback`, `stats` → `AudioIO.stats`) and sets `localMute` while a mute `cmd` is in flight.
- CLI flags:
  - `--test` (fake audio, hidden panel, no status item, no global hotkeys, never forwards to another running instance, UserDefaults suite `com.chadboyda.sotto.test`, `FAKE` flag on frames).
  - `--port N --data-dir D` (direct launch without a URL; bootstraps with page.secret).
  - `--debug-log F` (JSONL).
  - `--exit-after S`.
  - `--selftest <name> [json]` (pure checks with JSON on stdout, driven from node:test). SottoApp's: `panel-frame`, `url`, `icon`, `keys`, `hotkey`, `options`, `bundle`; an unknown name exits 2.
  - `--version`.
- `--test` must never instantiate a CoreAudio unit.

### 5.2 SottoClient (B4)
- `Bootstrap`: `GET http://127.0.0.1:P/api/bootstrap` with `X-Sotto-Launch` or `X-Sotto-Boot`, and no `Origin`.
- `LinkClient: DaemonLink` uses `URLSessionWebSocketTask`, sets the `X-Sotto-Page` header and the subprotocol, sends hello, and follows the §1 reconnect policy.
  - Mic sends go through a serial queue. When more than 10 frames are unsent, it drops the oldest (count them).
  - It answers `ping` itself.
- `ServerMessage`/`ClientMessage` get full Codable coverage of §3. `ServerMessage` adds typed cases for every §3.1 type, keeping `.other` for forward compatibility.
- `fetchVoicePreview` sends the page token header.
- As built (B4; additive surface, all in `SottoClient`):
  - `ServerMessage` has a typed case per §3.1 type (`.settings`, `.activity`, `.delegation`, `.notice`, `.noticeClear`, `.resultPending`, `.wakeHeard`, `.command`, `.caption`, `.live`, `.audioFlush`, `.ping`, `.result`); `.other(type:raw:)` is now only an unknown type or a known type with a malformed payload, and `.unknown` is text that is not a JSON object with a `type`. `settingsPayload` reads `settings` from a `welcome` or a `settings`. `ClientMessage` has typed cases per §3.2 (`.route`, `.audioStats`, `.pong`, `.played`, `.log`, `.system`, `.micError`, `.activity`) and `redactedDescription` (never shows `key_save` args).
  - `LinkClient(config:)`: `onState`/`onMessage` arrive on `config.callbackQueue` (main by default); `onSpeakerFrame` and `addMessageTap` run on the link's serial queue in socket order, so an `audio_flush` is always handled before the frames after it. `command(name, args)` (callback or `async`) does the `cmd`/`result` correlation and resolves `CommandFailure` codes `not_connected`, `timeout` (15 s) or `link_lost` itself. Nothing is delivered before `welcome`.
  - `LinkState` after a stop: `.failed("replaced")` (4002), `.failed("protocol_mismatch")` (4001, or a welcome with protocol != 1), `.failed("unreachable")` (the 60 s retry window ran out; "idle until the next `sotto://open`"). `.idle` only after `close()`.
  - Liveness: no text or binary from the daemon for 15 s (it pings every 5 s) closes the socket and retries. A missing `welcome` 5 s after the socket was created does the same.
  - On retry the port follows `<data dir>/daemon.port` when that file passes the ownership check (a daemon restarted on another port), and the launch code is used only once.
  - `AudioPump(link:fake:hooks:)` is the audio bridge the Controller wires to `AudioIO`: `hooks.setCapture(.full|.listen|.off)` (from `status.state` per §2.2: connecting/live/reconnecting → full, sleeping → listen, else off; kept during a reconnect backoff, off when the link gives up), `hooks.play(pcm, seq, afterFlush)`, `hooks.flush(reason)`, `hooks.stats()` → `audio_stats` every 1 s. `pushMic(samples:hostTimeNs:muted:)` sends per-connection seq from 0, `FAKE` when `fake`, `MUTED` zeros when the frame, `localMute` or `status.live.muted` says so, and drops anything but 960 bytes.
  - `UrlCommand`/`parseUrlCommand`, `daemonRecordsPort` and `DataDirTrust` (`pageSecret`, `recordedPort`) are the ports of app/Sources/Support.swift.
  - `LinkSelfTest.run(port:dataDir:version:build:)` is what `--selftest link` prints (one JSON line with `"selftest":"link"`); `test/app/native-link.test.mjs` skips until SottoApp routes the flag to it.
  - Extra fixture: `test/fixtures/native/server-extra.jsonl` (status, settings, wake_heard, play_echo_sample, live error, app_took_over, an unknown type).

### 5.3 SottoAudio (B3)
- **Modes** come from a pure `AudioPlan.decide(output:, input:, pref:)`:
  - `vpio`: the output is speakers (built-in/USB/HDMI/AirPlay/unknown). One voice-processing IO: `AVAudioEngine` input `setVoiceProcessingEnabled(true)`, **then** bind the chosen input/output devices. If binding a non-default output fails, fall back to a raw `kAudioUnitSubType_VoiceProcessingIO`. Set the ducking of other audio to minimum (`voiceProcessingOtherAudioDuckingConfiguration`). If voice processing will not start at all, the session falls back to `split` on the same devices (route reason gets `,vpio_failed`, `echo_cancellation: false`; the daemon echo filter still runs); a later forced rebuild (configuration change) retries `vpio`. A bound plain-AUHAL input is rebuilt when its device nominal rate changes (AUHAL input does not resample). Only one output unit renders the playout at a time: a preview output is stopped before a session output starts. `stopSample()` stops a preview without touching the session playout.
  - `split`: the output is headphones (Bluetooth, the `hdpn` data source, headphone-named USB). Input is a plain AUHAL input-only unit on a **non-Bluetooth** mic (built-in by default; port `app/Sources/NativeMic.swift`). Output is a separate output-only unit on the headphones. No VP, so AirPods never switch to HFP.
  - `listen`: sleeping. Input only, same device rule, no VP.
  - `fake`: `--test`.
  - `off`.
  - Pref `EchoCancellation.always` forces `vpio`; `.never` forces split-style plain units.
- Mic device rule (port of the current MicPlan): the saved device if present, else the system default unless it is Bluetooth, else built-in.
- **Never** touch `AVAudioEngine.inputNode` in `split`/`listen`/`fake`. Instantiating it opens the default input, which flips AirPods to HFP.
- Capture: device rate → `AVAudioConverter` (one persistent instance per route) → 24 kHz Int16 → 480-sample frames stamped with host time → `onMicFrame`. The converter is fed at most 1024 frames per call: given a larger buffer (a drain that fell behind, a whole WAV) it silently drops part of it. After each route change the app sends a `log` line with the capture rate and the device's nominal rate (`sotto: capture <mode> from <mic> at <rate> Hz (device <rate> Hz), <reason>`), since `route` carries no rates.
- Playout: a lock-free SPSC ring feeding an `AVAudioSourceNode` at 24 kHz, with the §2.4 jitter buffer. The render thread does no allocation, locks, logging or Swift concurrency.
- Route/device changes: device list, default device, `DeviceIsAlive`, `AVAudioEngineConfigurationChange` and data-source listeners, debounced 0.4 s. Rebuild only when the plan changes, and emit `onRoute`.
- `FakeAudioIO`:
  - input: the WAV from `SOTTO_APP_MIC_FIXTURE` (any rate/channels, resampled to 24 kHz mono), paced by a `DispatchSourceTimer` at 20 ms, starting after `SOTTO_APP_MIC_FIXTURE_LEAD_MS`, then silence (a quiet tone if the env var is unset).
  - output: through the same jitter buffer, clocked by a timer, into memory and written to `SOTTO_APP_OUT_WAV` (24 kHz mono PCM16) on stop and every 1 s.
  - `SOTTO_APP_ECHO_SIM_DB` mixes played output back into the input 40 ms later at that gain.
  - `playSample` writes into the same output.
  - `SOTTO_APP_MIC_QUEUE_DIR` (integration addition): a directory the test drops WAV clips into while the app runs. Each clip is taken within 100 ms (renamed `*.taken`) and spoken into the mic after the clip before it, over silence (no tone in this mode). The real-API app e2e (`npm run e2e:app`) speaks at the moments it chooses this way: the question, a barge-in over the answer, the voice wake.
  - `onTestEvent` (wired to the debug log only in test mode): `mic_clip {name, phase}`, `out_speech {phase, buffer_ms | frames, max_buffer_ms, underruns, overruns}` (first loud rendered frame, peak 800 or more, after 300 ms of quiet), `playout_flush {buffer_ms}`. The app also logs `spk_rx` (first speaker frame after a 400 ms gap) and `notice {code}`; the daemon logs `native.speech_onset` (the same onset rule on the speaker stream). Timing only; never audio or text.
  - The factory `makeAudioIO(test:)` returns `FakeAudioIO` whenever `test` is true. The real engines refuse to start when the process runs with `--test`.
- **B3 additions (additive, landed with SottoAudio):**
  - Package: a tiny C target `CSottoAtomics` (C11 `__atomic` builtins) that `SottoAudio` depends on, because `Synchronization.Atomic` needs macOS 15. The render thread uses it for the SPSC rings.
  - `AudioIO` gains `onError: ((AudioIOError) -> Void)?` (async failures such as a denied prompt or a lost device; main queue), `onMicSilence: ((Bool) -> Void)?` (3 s of exact digital zeros on an unmuted mic, e.g. a privacy-blocked input; main queue) and `route: AudioRouteInfo?`.
  - `AudioIOError` (`micDenied`, `micRestricted`, `noInputDevice`, `testMode`, `engine(String)`) with `name`/`message` for `mic_error`. `name` is `NotAllowedError` for denied/restricted so voice.js maps it to `mic_denied`. `start()` throws `micDenied`/`micRestricted` synchronously; when permission is undetermined it prompts and reports a denial through `onError`.
  - `AudioDevice.transport: AudioTransport` and `AudioRouteInfo.echoCancellation`/`reason` (new stored properties with defaults plus extra inits; the stub inits are unchanged). `AudioPlan.decide(output:input:pref:listenOnly:test:)`, `AudioPlan.pickInput`/`pickOutput`, `MicPermission`, `AudioSelfTest.devicesJSON()` (for B6's `--selftest audio-devices`), `ProcessGuard.isTestProcess` (`--test`, `--selftest`, `SOTTO_APP_TEST=1` or XCTest: real engines throw `testMode`, and `makeAudioIO` always returns the fake).
  - Mic rule detail: an explicitly saved Bluetooth mic is honored. Automatic choice never picks a Bluetooth mic when any other real input exists.
  - Jitter details: running dry counts as an underrun (and raises the target) only when audio resumes within 1 s. A longer gap is the end of a turn. A tail below target starts playing after 60 ms without new frames. A full ring (64 frames) drops new frames, and those count in `overruns`.

### 5.4 SottoUI (B5)
- `StateModel` (`@Observable`, main actor) holds: status, settings, captions (the `reduceCaptions` port), Claude card (activity kind/text, `claudeSays`, tool, busy, summary from `turn_end`, agents count, delegations: last 3 via the `upsertDelegation` port), banners (notice/notice_clear, `live` error/closed via the ports of `lib.errorBannerText`/`closedReasonMessage`), pending result, link state, levels, voices, mute-pending, timers (turn start time, session start).
- Views follow the web page's information design, natively:
  - since feat/hybrid-native, the Filament + Orrery design (design/concepts-v2/hybrid; "Filament + Orrery" under Builder notes): every zone is a fixed box (`HybridLayout`)
  - header: the status word in a fixed 72 pt slot and the project; the usage readout (one flat 26 pt capsule: Session while live, Today, Cost; symbols, hairlines, fixed-width figures)
  - the headline (`ViewText.headline`, the port of `lib.headline`): who holds the floor, else Claude needing you, else Muted, else Claude's news ("Claude is testing", "Claude finished"), else the page's word
  - the string (`FilamentStage`: one `Canvas` in `TimelineView(.animation(minimumInterval:paused:))`, paused when nothing moves; 10 fps while only Claude's bead travels; 15 fps sleeping shiver; 60 fps speech and one-shots) driven by the mic, speaker and wake levels, with the peg as the mute control
  - the caption line (who spoke and their words, or a cause and one action: can't hear + Switch mic, banners, muted, sleeping, the approval's terminal)
  - Claude's column: the row (moon glyph, "Claude · Working", a plain tabular timer) and the page (Claude's words in New York with rendered markdown; the approval's question; a state card's text: key, microphone, off)
  - footer: persona chip (a drawing of the persona's tuning, name, voice; opens Settings), Pause/Resume, End voice, Settings
  - the compact strip (`MiniPanelView`, 320 x 96): peg, string, word, moon and timer, caption, Expand
  - key setup sheet (a `SecureField`; the key goes only into `cmd key_save`, is never stored, and only `key.hint` is displayed)
  - settings: policy picker, persona picker (names, the chosen one's description and voice, "Switch to the persona's own voice"), voice picker + "Hear the voices" previews, mic and speaker pickers (supplied by the app via closures; SottoUI does not import SottoAudio), wake sensitivity, echo cancellation, Test echo, window pref, Open logs, Open in Browser
- **Settings + onboarding (`Sources/SottoUI/Settings/`, builder swift-settings):** `SettingsModel(state:)` (`@Observable`) wraps `StateModel` and uses its `sendCommand` for `set_policy`, `set_voice`, `set_persona`, `set_wake`, `set_window`, `key_save`, `key_remove`, `get_voices`, `echo_test`, `open_browser`. It takes the Settings payload via `ingest(ServerMessage)` (`welcome.raw["settings"]` or a `settings` message) into `NativeSettings`. App-local rows go through `SettingsHooks` closures that SottoApp wires: `selectInput/selectOutput` (nil = automatic), `setEchoCancellation`, `setInputMetering` (per-device meters for "Compare microphones"; the app writes `inputLevels`), `playVoicePreview`/`stopVoicePreview`, `requestMicAccess`/`openMicPrivacySettings`, `setLaunchAtLogin`, `openLogs`, `refreshDevices`. The app also sets `inputDevices`, `outputDevices`, `activeInput/activeOutput` (from `onRoute`), `selectedInput/selectedOutput`, `echoCancellation`, `micPermission` (refresh on `didBecomeActive`), `loginItem`. Default system implementations: `MicAccess` (AVCaptureDevice; never prompts unless `request()` is called) and `LoginItem` (SMAppService.mainApp); neither may be called under `--test`. Views: `SettingsView` (the Settings window), `OnboardingView` (shows `MicAccessView` then `KeySetupView` while `model.onboardingStep != nil`). The key lives only in the view's `SecureField` state until it is sent in `cmd key_save`. Copy: `SettingsText` (ports of `keySettingsView`, `keyCardView`, `echoTestVerdict`, `POLICY_HELP`). Snapshots: `SettingsSnapshots.render(to:)`, PNGs in `design/native/`.
- Status words and card copy are ported from `web/lib.js` `pageView()`/`sleepView()`/`activityView()` as a pure `ViewText` with table tests against the same inputs as `test/web/*`.
- **Milestone stars (hybrid panel):** SottoUI derives them from the existing `activity` stream in `StateModel`, with no new daemon event: port of `lib.milestoneStars`. A star is born at the bead's position (`lib.beadPosition(elapsed)` = 0.05 + 0.85 (1 − e^(−t/60 s))) when an `activity` of kind `text` with non-empty text arrives while Claude is busy, at most one per 20 s, at most 12 (oldest out first); alpha `lib.starAlpha(age)` = max(0.3, 0.92 · 2^(−age/20 min)); cleared when voice turns off. Pinned in `viewtext.json`.
- **As built (B5, additive):**
  - Reducer entry points: `StateModel.apply(_ ServerMessage)` handles every typed case of SottoClient's `ServerMessage` (status, welcome, settings, activity, delegation, notice, notice_clear, result_pending, wake_heard, command, caption, live; audio_flush/ping/result are the app's and the link's). `StateModel.apply(object:)` takes the raw JSON object of any §3.1 message (fixtures, previews). The Controller feeds every link message to `apply(_:)`.
  - The phase is derived, not sent: link not yet connected = `boot`, link lost after a welcome = `lost` (card "Lost contact"), `status.state` live = `live`, connecting/reconnecting/waiting_page = `connecting`, `close_window` then off = `closed`, `micFailure` set = `error`. `pausedReason` comes from `command disconnect {reason}` (the daemon still broadcasts it; the app does not act on it).
  - Set by the app (SottoApp): `linkState`; `micLevel`, `speakerLevel`, `wakeLevel` at any rate (only a visible change is published, so zeros at 50 Hz cost nothing); `micFailure` (`macos`|`notfound`|`busy`|`other`, lib.micFailureKind names) and `micPrompt`; `sendCommand`; closures `openSettings` (swift-settings' window; the gear is disabled while nil), `openMicSwitcher` (the "Switch mic" button on the `cant_hear` banner), `onUserActivity` (send `activity {}`).
  - Actions: `toggleMute()` (optimistic `mutePending`, reverted on a failed result), `pause()`, `resume()` (sends `wake` from sleeping), `end()`, `openInBrowser()`, `saveKey(_:) async` (the key goes only into `cmd key_save`; the field is cleared whatever the outcome), `handleKey(_:)` (M/Space, lib.hotkeyAction; M while sleeping toggles `wakeMuted`).
  - The inline API key card (`pageView` kind `apikey`) carries its own `SecureField`; the settings window (swift-settings) owns the rest of the key UI (`ViewText.keySettingsView` is ported for it).
  - `UISnapshot.render(to:)` renders every canned state (`UISnapshot.states`, 23 states) in light and dark with `ImageRenderer` (silent, no window). B6's `--selftest ui-snapshot [dir]` calls it. `SOTTO_UI_SNAPSHOT_DIR=design/native swift test --filter SnapshotTests` refreshes `design/native/`.
  - Parity: `test/fixtures/native/viewtext.json` holds 209 input/output cases computed by `web/lib.js` and `web/wake.js`. `test/web/native-viewtext.test.js` pins it to lib.js (`SOTTO_UPDATE_FIXTURES=1` regenerates), and `ViewTextTests` checks the Swift port against it, so a copy change on either side fails a test.

### 5.5 Build, bundle ids, tests
- `scripts/build-app.sh` (B6): `swift build -c release --package-path app-native --scratch-path <out>/.swiftpm-build --arch arm64 [--arch x86_64 with --universal]`. The scratch dir lives in the output dir, never in the plugin (an installed plugin stays clean, and a build never looks like a source change to the self-update). It assembles `Sotto.app` from `Bundle/`, writes `Contents/Resources/sotto-source.json {hash, version}`, and signs as today (ad hoc locally; Developer ID + hardened runtime + entitlements in `release-app.sh`). The flags (`--out --force --check --quiet --print-hash --universal`), the stamps and the lock stay the same.
- **Bundle ids:** production `com.chadboyda.sotto` (it replaces the WKWebView app; same name `Sotto.app`, same executable `Sotto`, same URL scheme). LaunchServices test copies use `com.chadboyda.sotto.apptest`; test defaults use `com.chadboyda.sotto.test`. Tests never launch or signal the installed app or the user's daemon.
- `app/` (the WKWebView app) is **deleted by B6** in the same commit that switches `build-app.sh` and `appSourceHash`. Until then it keeps building.
- Tests:
  - `npm run test:native` runs `swift test --package-path app-native` (XCTest: codec golden, jitter buffer, AudioPlan table, WAV I/O, FakeAudioIO pacing, caption reducer, ViewText tables, message decoding from the shared fixtures `test/fixtures/native/welcome.json` and `session.jsonl`; add more there).
  - `npm test` stays Node-only and fast. `npm run test:app` (B6) builds the bundle and runs it `--test` against an in-process temp daemon.
  - `test/scripts/silent-tests.test.js` is extended: every app launch in `test/` passes `--test` or `SOTTO_APP_TEST=1`.

---

## 6. Milestones, builders, acceptance

**Git.** The integration branch is `feat/native-app`. Each builder works in its own worktree: `git -C <repo root> worktree add .claude/worktrees/<slug> -b native/<slug> origin/feat/native-app`, then symlink `.env` and `private/`. **Never check out a branch in the main checkout**: the user's live plugin runs from it, and any change there triggers a daemon self-update. To land:
1. `until mkdir /tmp/sotto-native.lock; do sleep 5; done`
2. fetch and rebase onto `origin/feat/native-app`
3. run your checks
4. squash to one commit, with hooks (no `--no-verify`) and the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
5. `git push origin HEAD:feat/native-app`
6. `rmdir /tmp/sotto-native.lock` (always, even when a step fails)

No builder edits another builder's files. The shared seam files are `native-proto.js`, `Protocol.swift`, `Messages.swift`, `DaemonLink.swift`, `AudioIO.swift`, `StateModel.swift` and this doc. Additive changes to them are allowed and must be called out in the commit message.

**Silence and safety for everyone:**
- No real mic or speakers in automation: fake audio from WAV, output to buffers or files.
- Never touch the user's daemon (its port is in `~/.claude/plugins/data/sotto-skills-dir`) or the installed app.
- Temp daemons use `SOTTO_KEYCHAIN_SERVICE` throwaway names.
- Never print the key.
- Real-API runs are the e2e scripts only, with their budget guards.

| Milestone | Content | Done when |
|---|---|---|
| M0 | this contract + stubs | `npm test`, `npm run test:native` green on `feat/native-app` |
| M1 | B1-B6 land in parallel | each builder's acceptance below |
| M2 | integration: app ↔ daemon ↔ Live end to end | `npm test`, `test:native`, `test:app` green. `test/e2e/native.mjs` (real Live, app `--test` with `ask-files.wav`): `session.started`; a delegation reaches the fake inbox; the output WAV holds speech (peak > 1200); a voice switch reconnects; ≤ 40 billed s |
| M3 | parity: voice wake, can't hear, echo report, self-update with the app attached, Mac sleep | B2 tests + `e2e:restart` variant with the fake native app |
| M4 | release v0.3.0 | version 0.3.0 in plugin.json/package.json/Info.plist. SPEC §6.16 rewrite + a new §6.19 "Native link", SPEC-DEVIATIONS, README, CLAUDE.md layout. PR `feat/native-app` → `main`, squash-merged. `scripts/release-app.sh 0.3.0 --upload` (Developer ID 6M6D2W72ZB, notarytool profile `sotto`). `appfetch.js` installs it. `window: auto` opens the native app by default |

### B1 daemon-link: `wsserver.js`, `native.js`, index.js/http.js wiring, `test/helpers/fake-native-app.js`
Acceptance (unit, no network):
- (a) `acceptKey` RFC vector; frame encode/parse (masking, 7/16/64-bit lengths, fragmentation, ping/pong, close, over-size → 1009), tested against Node's global `WebSocket` client.
- (b) Upgrade auth: wrong Host → 421; Origin present → 403; missing or wrong token → 403; right token → 101 with subprotocol.
- (c) hello timeout → 4003; protocol 2 → 4001; a second client replaces the first (4002).
- (d) A bad mic frame size → 4004; JSON outside `CLIENT_TYPES` is ignored; `key_save` args never appear in the log.
- (e) With a stub controller, `fake-native-app` round-trips hello/welcome, 50 mic frames and 50 speaker frames with seq order intact.
- (f) The page SSE paths are unchanged (existing http tests green).

### B2 daemon-session: `live-ws.js`, `pacer.js`, `native-session.js`, `voice.js` split, `fake-live-server.js`, `test/e2e/native-daemon.mjs`
Acceptance:
- (a) `buildPrimaryStart` shape (no `client`/`transport`, has `audio.format`, seed `input`). `PrimarySession` against the fake-live-server: ready on `session.started`; appends/acks/errors identical to the Sideband tests; `audio` decoding; no re-attach; pre-open close → key-check mapping.
- (b) Pacer on a fake clock: continuous 20 ms cadence, fill after 60 ms, late-frame drop, mute zeros, 10 s grace → `pause("app_gone")`.
- (c) voice-native tests: start, resume, expiry reconnect, voice switch, notify wake and self-update restore each create a primary session with no page; `app_took_over`; delegation end to end with the fake inbox; caption/live/status/audio_flush fan-out; every §3.3 command.
- (d) All existing voice/sideband/page tests stay green (WebRTC path byte-for-byte).
- (e) `node test/e2e/native-daemon.mjs`: real Live with the fake native app streaming `ask-files.wav`. It checks `session.started`, that a delegation reaches the fake inbox, that speaker frames hold speech, and a clean close, in ≤ 25 billed s.
- (f) M3 items in §4.5.

### B3 swift-audio: `SottoAudio`
Acceptance (`swift test`, no devices):
- `AudioPlan.decide` table (speakers → vpio, BT/hdpn/USB headphones → split, sleeping → listen, prefs override, BT mic never chosen for capture)
- the jitter buffer (start at target, underrun raise and decay, quiet-only drop on overrun, flush)
- the resampler (48k/44.1k/16k → 24k length and tone)
- WAV read/write
- `FakeAudioIO`: 50 ± 1 frames/s, 960 bytes each, fixture content in order, zeros + muted when muted, output WAV equals the enqueued PCM, echo sim mixes at −10 dB after 40 ms
- real engines refuse to start under `--test`.

Plus a manual-only `--selftest audio-devices` that lists devices (no capture).

### B4 swift-client: `SottoClient`
Acceptance:
- `swift test`: codec golden; decode of every §3.1 message from `test/fixtures/native/` (`welcome.json`, `session.jsonl`); encode of every §3.2/§3.3 message; the reconnect backoff schedule (pure); launch URL parsing and validation (port of `parseUrlCommand`/`LaunchRequest`); the ownership check on a temp dir.
- A node:test `test/app/native-link.test.mjs` (after B1 lands) runs the SPM-built binary `--selftest link --port P --data-dir D` against a temp daemon: bootstrap via page.secret, hello/welcome, a status received, clean close.

### B5 swift-ui: `SottoUI`
Acceptance (`swift test`):
- `StateModel.apply` over fixture message sequences (status replace, captions merged like `lib.reduceCaptions`, activity → card, delegation upsert last 3, notice/notice_clear, `live session.closed` banner text, mute pending/ack)
- `ViewText` tables matching `web/lib.js` outputs for the same inputs, with the expected strings copied from the JS tests
- `--selftest ui-snapshot` renders `PanelView` for 6 canned states via `ImageRenderer` to PNGs in a temp dir (silent; used for review).
- Every string has no emoji. Product strings keep the `sotto:` prefix where the page uses it.

### B6 swift-app + packaging: `SottoApp`, `Bundle/`, `build-app.sh`, `window.js`, `test/app/*`, deletion of `app/`
Acceptance:
- `bash scripts/build-app.sh --force --out <tmp>` builds a signed (ad hoc) `Sotto.app` from app-native with the Info.plist keys, `sotto-source.json`, and the hash equal to `appSourceHash()`.
- window tests updated (chooser without the route rule; the hash covers app-native; the native hello satisfies the app-opened check).
- `npm run test:app`: the build, then the app `--test` under the apptest bundle id launched through the real chooser (`SOTTO_BROWSER=app`) against a temp daemon with the fake-live-server. The chain is `sotto://open` → link → welcome → fake session → output WAV non-silent → `cmd mute` round trip → `close_window` hides → `--exit-after`.
- `release-app.sh` still works (dry run without `--upload`).
- `silent-tests` enforcement extended.
- `SOTTO_APP_LIVE=1 npm run test:app` is the M2 real run.

---

## Builder notes (additive changes, in the order they landed)

### daemon-live (daemon side of B1 + B2)
- `NativeController.afterWelcome(link)` (new, optional): `native.js` calls it right after sending `welcome`. The controller only starts forwarding (and `voice.onAppAttached()` only starts a session) from then on, so nothing precedes `welcome` even when attaching changes the state.
- The daemon's `window.open(opts)` takes `{want}` (`open_browser` passes `"chrome"`), and `window.showApp()` runs `open -g -a <bundle> sotto://show` (§5.1) when `/talk on` finds the app already connected.
- `cmd wake` starts the session with reason `resume` (a tap is not a heard voice; SPEC-DEVIATIONS "Native app: daemon side" 4).
- `echo_test` result `data` also carries `title` and `advice` (the page's `echoTestVerdict` words); `verdict` is `good|some|heavy|unknown`.
- A page's `POST /api/session` while the app is attached answers 409 `app_took_over`.
- `/status` gains `audio_client` and `native` (link, RTT, route, last `audio_stats`, pacer and frame counters).
- Log events: `native.connect|hello|attach|detach|close|replaced|reject|cmd|route|audio|took_over|app_gone`, `live.open|close|error` (primary socket), `session.create` with `transport:"websocket"`.
- Test helpers: `test/helpers/fake-native-app.js` (`FakeNativeApp`, `bootstrap`, `readWavPcm24k`, `pcmPeak`) and `test/helpers/fake-live-server.js` (`startFakeLiveServer`; point the daemon at it with `SOTTO_OPENAI_BASE=<base>`). Real-API smoke: `npm run e2e:native` (`test/e2e/native-daemon.mjs`, about 8-15 billed s).

### Integration (measured, real gpt-live-1, `npm run e2e:app`)
- One run drives the built app in test mode through the chooser: greeting, the question (`ask-files.wav`) transcribed and delegated to the fake inbox, a Stop answer spoken, a barge-in over it, a voice switch, can't-hear on a silent mic, idle sleep, a voice wake from the app's mic, and voice off quitting the app. About 50 billed seconds over three sessions.
- Latency, three runs on an M-series Mac (median across the run's speech onsets where noted):
  - `/talk on` to the app's `welcome`: 0.55-0.67 s; to live: 1.2-1.8 s.
  - Model audio at the daemon to the first rendered sample in the app: 102-128 ms median, 138-151 ms max (link about 1 ms; the rest is the jitter buffer's 60-140 ms target).
  - Mic clip start to the first input transcript delta: 1.5-1.9 s; end of speech to the last delta: 0.6-0.9 s; transcript arrival vs its own `end_ms` on the session clock: about 370 ms. End of speech to the inbox write: 1.2-1.8 s.
  - Barge-in: the model stops 0.3-2.3 s after the user starts (model behaviour: it may finish a phrase or backchannel first); the app's buffer never held more than 160 ms, so no explicit flush is needed for barge-in.
  - Voice switch to live 1.4-1.5 s; to the new voice playing 2.8-3.4 s. Voice wake: speech onset to trigger 0.64-0.68 s, to live 1.25-2.2 s.
- The primary WebSocket streams output audio continuously (silence included) at real-time pace; the jitter buffer counts underruns in that stream (about a dozen per minute, almost all in silence; one 80 ms gap inside speech was seen in three runs).

### Persona picker (v0.3.1)
- The Settings window has the page drawer's persona picker: a menu of the personas by name (tagged "(yours)" or "(project)" for files), the chosen persona's one-line description and voice under it (`SettingsText.personaHelp`, the page's `renderPersonas` words), and the "Switch to the persona's own voice" checkbox. Both go through `cmd set_persona` (§3.3); the list comes from `settings.personas` (§3.1), so a persona switched from the terminal shows up through `status.persona` and the next `settings`.
- `settings.personas` uses the persona list `pageStatus()` scanned in the last 5 s (`voice.cachedPersonaList()`), so the per-status settings diff costs no directory scan.
- Test mode only: `SOTTO_APP_TEST_ACTION_DIR` (passed through `window.js` APP_TEST_ENV) is a directory the app polls for `*.json` actions (`{"action":"persona","persona":"june"}`, `{"action":"persona_voice","on":false}`) and runs through the same `SettingsModel` calls as the window, logging `test_action` and `cmd_result`. `npm run test:app` (fake Live) and `npm run e2e:app` (real gpt-live-1) switch the persona this way.

### Parity with the page (v0.3.2)
The native branch forked at #4, so the page's #5 (UI polish) and #7 (header pills, appearance) never reached the SwiftUI panel. v0.3.2 ports every user-visible difference. Screenshots, light and dark, at 420 x 720 and 360 x 640: `design/native/parity/`.

| Feature | Web page | Native before (0.3.1) | Native after (0.3.2) |
|---|---|---|---|
| Header usage (#7) | Three pills, Session (live only), Today, Cost: 11 pt label over a 13 pt semibold tabular figure in a fixed box (m:ss/mm:ss, h:mm:ss from the hour; "$00.00", wider from $100), 36 pt, radius 8, 4 pt apart, surface-1 + shadow ring | One capsule "Session 4:12 · 14 min · $0.71 today" on surface-2; its width changed as digits rolled over | Same three pills (`UsagePill`, `ViewText.usagePills`); boxes measured once in the figure font. `HeaderLayoutTests` ticks 0:09, 0:10, 9:59, 10:00, 59:59, 1:00:00 and asserts constant frames except the hour widening |
| Header priority hiding (#7) | Project, detail, Today, then Session; Cost never | Dropped the word "Session", then the session clock | Same order as the page (`HeaderContent.candidates`, `ViewThatFits`); tested down to 150 pt |
| Today ticks between readings (#3) | `stableUsage` + `tickingToday` (at most 15 s ahead while live) | Moved only on usage events | Ported; pinned to lib.js by `viewtext.json` |
| Appearance (#7) | Settings > Appearance: System / Light / Dark (page storage `clv.theme`) | Always followed macOS | Settings > Appearance (segmented, System default) sets `NSApp.appearance` (nil / `.aqua` / `.darkAqua`), kept in the app's defaults (`Appearance`). The daemon has no appearance pref (the page keeps its own), so none was added |
| Light theme tokens (#5) | Cool neutrals, no beige: bg #F4F5F7, attn tint white, amber icon #A8740E, no attention bloom on light | Older tokens: beige attn tint #FBF0D9, amber bloom behind the dial | The page's tokens (`Theme`), plus `attnIcon`, the shadow ring and the dial rest alphas |
| Banners (#5) | Raised neutral surface, tone only in the icon (amber / red) | Amber or red tinted fill with a tinted ring | Neutral raised surface (radius 14, 48 pt), amber or red icon, quiet action button |
| Claude card surfaces (#5) | Raised surface, radius 18, rings as shadows so a state change never moves it; approval neutral in light with a 1.5 pt amber ring; static working icon | Bordered card, amber tinted approval, spinning icon | Ported (`CardSurface`, rings drawn outside the shape) |
| Claude card height (user report on 0.3.1) | Summary clamped to three lines, "More" for the rest, expanded box capped | Grew with long output inside the panel's scroll view; a scroller sat over the text | Collapsed: three lines + More; expanded: a capped scroller in the card's trailing padding, inset from the corner, text padded clear of it; room is reserved under the word so the captions and footer never move (`ClaudeCardLayoutTests`, snapshots 25/26) |
| Claude card in the live view (#3) | Always there ("Claude is idle" as a quiet line under a hairline) | Hidden while idle | Always there in the live view |
| Claude's words, one line (#3) | Claude's own latest words, never a tool label (fix/pills-v2), one line | Ported, but up to three lines | One line |
| Markdown (#3) | `lib.renderMarkdown`, "(code)" when collapsed | Rendered natively | Unchanged |
| Background agents chip (#3) | Quiet text in the card's head | A capsule under the card (added height) | A chip in the head row; "2 agents" when short of room |
| Raw tool labels (#3) | Plain words from the daemon | Same (daemon side) | Same; the snapshot fixture now uses a plain label |
| Calm status word (#3) | 1.3 s hold, fade, Listening / Hearing you / Speaking; one line, fixed hint height | Hold and fade ported; word could wrap and the hint line changed height | Word one line (scales down), hint line fixed at 22 pt in the live view |
| Header status line (#5) | Word in the state's ink only for live / muted / attention / error; detail and project on the second line | Detail on the first line | Ported |
| State cards (#5) | No tinted washes | Tinted by tone | Neutral raised surface, tone in the icon |
| Dial at rest (#5) | Calmer bezel and rest ring on light | Same alphas both themes | `dialBezelAlpha` / `dialRestAlpha` |
| Can't hear only before first words (#7) | Yes | Yes (daemon, #9) | Unchanged; `e2e:app` asserts no warning after a switch |
| Can't-hear banner, Switch mic (#2) | Banner with a mic list | Banner, Switch mic opens Settings | Restyled banner |
| Mic picker with levels (#2) | Drawer list with live bars | Picker + meter, Compare microphones | Unchanged |
| Voice previews | Hear the voices | Yes | Unchanged |
| Persona picker (#8) | Drawer picker + voice toggle | Yes (0.3.1) | Unchanged; `test:app` and `e2e:app` switch it through the app |

### Hybrid panel: web and native parity (Filament + Orrery, v0.4.0; feat/hybrid-web + feat/hybrid-native)
Both sides implement design/concepts-v2/hybrid (IMPLEMENTATION.md is the spec for motion, tokens and zones). The shared words and rules are pure functions in `web/lib.js`, pinned for the Swift port in `test/fixtures/native/viewtext.json` (new fns: `headline`, `statusWord`, `captionNote`, `claudeHead`, `claudeVerb`, `beadPosition`, `starAlpha`, `milestoneStars`; `ViewTextTests` needs a case for each, or it fails with "no Swift port"). Web screenshots: `design/hybrid-impl/web/`.

| Feature | Rule (both sides) | Web (feat/hybrid-web) | Native (feat/hybrid-native) |
|---|---|---|---|
| Headline | `lib.headline(pageView, {attention, question, busy, tool, finishedAt, now})`: talking > approval ("Approve in the terminal"; question: "Answer in the terminal") > **Muted** > "Claude is <claudeVerb(tool)>" > "Claude finished" (30 s) > "Listening"; a card view shows its header label. Muted before Claude's news is a deliberate change to IMPLEMENTATION §6 (the user must not talk into a muted mic unaware) | Done | Done: `ViewText.headline`, `StateModel.headline(at:)`; the strip names the terminal ("Approve in iTerm2") |
| Header word | `lib.statusWord`: "Needs you" while an approval waits (live), else the header label | Done | Done: `ViewText.statusWord` |
| Caption line | One line under the string: `lib.captionNote` (muted: "Sotto can't hear you. Still billing. Press M to listen."; connecting: the sub) else the latest caption; the voice labelled with the persona's name | Done | Done: `ViewText.captionNote`; banners (can't hear + Switch mic) and the sleeping/paused hint (`lib.inlineNote`) are on this line on both; the app adds the approval's "In <terminal> · <project>" (the compact strip shows the command instead) |
| Claude row | `lib.claudeHead`: moon phase new / waxing / eclipse / full, "Claude · Working", "Claude is waiting for you"; timer m:ss (`formatClock`), counts the wait in approval | Done (SVG moon, 12 px) | Done: `ViewText.claudeHead`, `MoonGlyph` (drawn in Canvas) |
| Eclipse timing | The string starts at the event; words, header, Claude row and the question switch at totality (750 ms, `lib.ECLIPSE_TOTALITY_MS`); state already present at launch and Reduce Motion: at once | Done (`data-eclipsing`, `data-eclipse`) | Done: `StateModel.attentionShown(at:)`, `pageView(at:)` |
| Milestone stars | §5.4 rule above | Done (memory only) | Done: `ViewText.milestoneStars` in `StateModel` |
| Cost | Idle 0 fps; working bead 10 fps; approval shimmer only (web: 24 fps clipped to the corona box); sleeping ≤ 15 fps | Done, `test/web/string.test.js` | Done: `FilamentEngine.rate` (0 fps idle, 10 fps bead, ≤ 15 fps sleep, corona quad at 30 fps), paused when hidden or occluded |
| Tokens | IMPLEMENTATION §2 (ground `#05070C` / `#FBFCFD`, need `#FFB547` / `#C4800E` + text `#A55200`) | Done (`styles.css`) | Done: `HybridTheme` (the old `Theme` stays for Settings) |
| Text contrast | Text tokens >= 4.5:1 on the ground in both themes; `ink3` is for glyphs and lines only (3:1), `fg3` / `--fg-3` is its text-safe twin (`#686B73` / `#8A91A0`) | Done | Done: `HybridTheme.fg3`; `HybridContrastTests` checks every text token |
| Increase contrast | macOS Increase contrast raises every quiet token (ink2, ink3, fg3, hairlines, capsule fill, the string) in both themes; the theme itself does not change | Done: `@media (prefers-contrast: more)` after the theme blocks; `string.js` re-reads its colours on the change (`test/web/theme.test.js`) | Done: every view resolves `HybridTheme.of(scheme, increaseContrast:)` from `colorSchemeContrast` (before: the string only) |
| Footer | Persona chip (tuning glyph, name, voice) opens Settings; Pause, End voice, gear as 40 pt icon buttons; the gear left the header | Done | Done |
| Header capsule | Unchanged `lib.usagePills` figures (Today stays m:ss; "32m" from the design was not adopted, to keep the pinned readout) | Kept | Kept |



### Hybrid panel: native notes (feat/hybrid-native)
Screenshots, light and dark, panel 420 x 640, large 640 x 900 and the 320 x 96 strip: `design/hybrid-impl/native/` (`SOTTO_UI_HYBRID_DIR=design/hybrid-impl/native swift test --package-path app-native --filter SnapshotTests/testRenderHybridStates`). What the shared table above does not cover:
- **Views:** `PanelView` places every zone in a fixed box (`HybridLayout`); `FilamentStage` is one `Canvas` in `TimelineView(.animation(minimumInterval:paused:))` over the whole panel (string, tides, persona ghost, stars, bead, frame, peg, eclipse), plus `CoronaLayer`, a 110 pt quad around the peg that alone animates (30 fps) while an approval holds. `ClaudeColumn` holds the row and the page (`ClaudePage`: Claude's words in New York, the last three messages at 100/50/42%, a long summary from its start with More, then scrolling inside the zone; `ApprovalBody`: the command in bare mono, the cwd, Claude's reason, "Show terminal"; `StateBody`: a card's text on the page). `MiniPanelView` is the compact strip (replaces the 290 x 44 pill).
- **Terminal:** `TerminalTracker` (SottoApp) remembers the last known terminal app the user activated (iTerm2, Terminal, Ghostty, Warp, WezTerm, kitty, Alacritty, VS Code, Cursor, Zed, Hyper), else the first running; it names it in the approval ("In iTerm2 · project", "Approve in iTerm2" in the strip) and "Show terminal" activates it (never under `--test`). The page cannot know it and says "the terminal".
- **Menu bar:** Claude's moon (from `claudeHead`) on a short string, a template image; the gold eclipse is the one non-template image; a cut string when muted; dimmed when off, sleeping, paused or connecting; errors keep the warning symbol (`--selftest icon` still reports the voice state). The app is `LSUIElement`, so there is no Dock badge. The panel title follows `lib.windowTitle`.
- **Personas as tunings:** `Tuning` (IMPLEMENTATION concept-3 §5): each persona rings the string in its own harmonic shape, the tides follow its envelope, the peg's detent turns, and a switch glissandos with the old shape lifting away. The footer chip draws the tuning.
- **Corona in Canvas, not Metal:** SwiftPM builds no `.metallib` outside Xcode; one stroked path of 120 value-noise streamers on the quad is cheap.
- **Measured** (visible panel, `--test`, fake audio and fake Live, M-series): 3.7% of one core idle-live, of which 3.1% is the same with the panel hidden (fake audio and the link), so the panel itself costs about 0.5% idle; main before this change measured 63-65% (the old dial's timeline never paused).
- **Tests:** `ClaudeCardLayoutTests` (no zone moves across 17 states, including every instant of the eclipse, at four sizes; the column stays inside the panel at 360-640 pt; "Show terminal" always fits, down to 360 x 420), `FilamentEngineTests` (0 fps idle, 10 fps working, speech settles to 0 fps, at most 3 tides, the 300 ms freeze, the timing table, Reduce Motion), `HybridModelTests` (stars, event clocks, persona switch, caption line), `TuningTests`, and `ViewTextTests` for the shared rules.
