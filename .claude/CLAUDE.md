# Sotto: notes for Claude Code sessions working on this repo

Sotto is a Claude Code plugin for full-duplex voice with a running session, built on OpenAI `gpt-live-1` (the Live API, not the Realtime API). The plugin root is the repo root. Read README.md for what it does and how to use it. **docs/SPEC.md is the binding contract** between the parts; docs/ARCHITECTURE.md explains why. Every divergence from the spec is recorded in docs/SPEC-DEVIATIONS.md, so add yours there.

## Layout
- `.claude-plugin/`, `skills/talk/`, `hooks/hooks.json`: the plugin shell. Every hook is an exec-form `command` hook with `args`.
- `bin/sotto`: a CLI on Claude's Bash `PATH` (`sotto voice [name]`, `sotto persona [name]`, `status`). It wraps `toggle.sh`, so Claude can switch the voice or persona when the user asks by speech.
- `scripts/hook.sh`: the gate plus forwarder for every non-toggle hook. `scripts/toggle.sh` is the `/talk` handler. `scripts/lib.sh` holds shared helpers. Everything here is bash 3.2 (macOS `/bin/bash`).
- `daemon/`: Node 22 ESM with **zero npm dependencies** (global `fetch` and `WebSocket`). `index.js` is the entry and exports `createDaemon()`. `voice.js` is the orchestrator. The pure modules are `delegation.js`, `policy.js`, `speech.js`, `prompt.js` and `transcript.js`. `personas.js` holds the built-in personas and loads custom ones (SPEC §4.6); toggle.sh mirrors the built-ins. `vocabulary.js` builds the spoken-name glossary (read-only file scan with a deadline) and holds the pure fuzzy matcher. `live.js` handles session creation and the sideband. `mirror.js` forwards user speech the Live model did not delegate (SPEC §6.18). `echo.js` is the transcript echo filter (pure; SPEC §6.8.1) used by delegation, the mirror and the wake clip. `update.js` (source fingerprint, when to restart) and `handover.js` (preflight, process swap over a stdin pipe) are the self-update (SPEC §6.17): editing daemon/, web/, scripts/ or app-native/ of a running install restarts its daemon at the next quiet moment, so a half-saved file is fine (the preflight refuses code that does not load) but expect `update.*` lines in the log. Bun ≥ 1.1 runs the daemon too (fallback when Node < 22). `apikey.js` resolves the OpenAI key (env > `.env` > macOS Keychain > sensitive userConfig), stores the page-entered key in the Keychain through `/usr/bin/security`, and checks keys with `GET /v1/models` (SPEC §4.3).
- `app-native/`: the **Sotto** macOS desktop app, native (SwiftPM, no Xcode project, no dependencies): SottoAudio (capture/playout, fake audio in test mode), SottoClient (the `/api/native` link), SottoUI (SwiftUI panel), SottoApp (menu bar, floating panel, hotkeys, `sotto://`). **docs/NATIVE.md is the binding contract.** `scripts/build-app.sh` builds it with `swift build` into `D/app` (incremental by sources hash; SwiftPM scratch in `D/app/.swiftpm-build`; never commit the bundle). Users normally get the signed, notarized release instead: `daemon/appfetch.js` downloads `Sotto.zip` for the plugin version from GitHub releases and verifies sha256, sources hash, Developer ID team and notarization before installing, else falls back to build-app.sh (SPEC §6.16 "Release download"). The daemon starts that install at its start and on every `/control`, and holds a window opening during it (SPEC §6.16 "Install lifecycle"); every step lands in `logs/app-build.log` and the outcome in `D/app/install.json`. `/talk app` and `/talk window` persist the window in `prefs.json`. `scripts/release-app.sh <version> [--upload]` makes that release (maintainer; output in the git-ignored `dist/`). `daemon/window.js` chooses app / Chrome / default browser and falls back to Chrome. `npm run test:native` runs the Swift unit tests.
- `web/`: the voice page. No framework, no build step, no network requests except to the daemon. `dial.js` is the canvas instrument around the mute button (guarded: a failure there must never break the page). `lib.js` is pure and unit-tested (view models in `pageView()`); so is `wake.js` (local voice wake: VAD, pre-roll clip), and `echo.js` (echo measurement and the echo guard's DSP, run on the audio thread by `echo-worklet.js`; SPEC §7.7). Idle sleep/wake on the daemon side is `daemon/wake.js` + `daemon/transcribe.js` (SPEC §6.15, §7.6).
- `test/`: `scripts/`, `daemon/` and `web/` hold the node:test unit tests. `helpers/` has the fake inbox, fake clock, fake WebSocket and the silent test Chrome launcher. `e2e/smoke.mjs` runs against the real API. `fixtures/ask-files.wav` is the TTS fake-mic input.

## Hard rules
- **Hooks fire in every session on the machine.** When voice is off or another session owns it, `hook.sh` must exit 0 with no output. It must not read stdin, fork or `source` anything before the owner check. Keep it at one `stat` plus one `read`.
- **Never block the TUI.**
  - Hook work that touches the network is backgrounded with all three std streams redirected: `( … ) >/dev/null 2>&1 </dev/null &`.
  - The daemon is spawned with `nohup … >/dev/null 2>&1 </dev/null & disown`.
  - A child that holds a hook's pipes makes Claude Code hang. This is verified.
- **No `http` hooks.** A refused connection shows a visible "hook error" notice. Never put `${user_config.*}` in hooks.json: the hook silently doesn't run. Scripts read `CLAUDE_PLUGIN_OPTION_*` and apply their own defaults, because unset options are not exported.
- `toggle.sh` always prints exactly one line, `{"continue":false,"stopReason":…}`, and exits 0. The daemon's `/healthz` and `/control?format=hook` responses must stay compact single-line JSON, because toggle.sh matches them as text.
- **Secrets:**
  - `OPENAI_API_KEY`, the inbox token, `daemon.key` and the page token are never logged, echoed, sent to the page or written to disk.
  - No key or token goes on a command line (macOS `ps` shows every user's argv): scripts hand curl the daemon key as `-H @<(printf 'X-Sotto-Key: %s\n' "$KEY")`, and the Keychain write feeds `security -i` on stdin, and toggle.sh passes the userConfig key to the daemon in its environment. The page only ever sees the last four characters. Keys typed after `/talk` are never read.
  - `.env` is gitignored.
  - The pre-commit hook blocks `.env` files, `sk-proj-…` keys, and the literal key from `.env`.
- **The spec's exact strings are contracts:** event names, headers, messages and file names. Don't rename them casually. The tests pin many of them.
- Product strings contain no emoji and use the prefix `sotto:`.

## Testing
- `npm test` runs all unit tests in about 15 s with no network. It must stay green. Timing tests compare against a bare-bash baseline because `npm test` runs files in parallel.
- `npm run validate` runs `claude plugin validate . --strict`, which must be clean. Also run `claude plugin validate .claude-plugin/plugin.json --strict`.
- `npm run test:app` builds the native app and runs its self-tests and test-mode launches (hidden panel, fake audio, no hotkeys, own defaults, LaunchServices copies under `com.chadboyda.sotto.apptest.<pid>`, unique per run because LaunchServices hands a `sotto://` URL to any running app with the same id, so concurrent runs sharing one id steal each other's app) against in-process temp daemons. Run it after changing `app-native/`, `daemon/window.js` or `scripts/build-app.sh`. `SOTTO_APP_LIVE=1` adds a real gpt-live-1 session (40 billed seconds or less). Never launch the app without `--test` from automation: a real-mic launch pops the microphone prompt and can switch the user's AirPods to headset mode.
- `npm run e2e` is the real gpt-live-1 smoke test.
  - Run it after any change to the daemon, the page, the hooks or the prompt.
  - It costs about $0.02 and uses about 20 s of Live time, with a hard 90 s budget guard.
  - It needs Chrome, ffmpeg and the key in `.env`.
  - `SOTTO_E2E_KEEP=1` keeps the temp dir, including the daemon log, for inspection.
  - `npm run e2e` also runs `test/e2e/wake.mjs` (sleep + voice wake, two short sessions, ~30 billed seconds); `npm run e2e:wake` runs it alone.
  - It also runs `test/e2e/restart.mjs` (self-update on a temp copy of the plugin, two short sessions, ~30 billed seconds); `npm run e2e:restart` alone, `SOTTO_NODE=bun` for the Bun runtime.
  - It also runs `test/e2e/keysetup.mjs` (first-run key setup in a temporary Keychain item, ~15 billed seconds); `npm run e2e:key` alone.
- **Keychain in tests:** unit tests use `test/helpers/fake-keychain.js` (the daemon harness default) or a fake `security` via `SOTTO_SECURITY_BIN`; anything that spawns a real daemon sets `SOTTO_KEYCHAIN_SERVICE` to a throwaway name so the user's real `sotto` item never leaks in. Never point a Keychain *write* at a fake `HOME`: `security` then fails with "authorization was canceled by the user".
  - It also runs `test/e2e/echo.mjs` (the page mixes the model's voice back into the mic with `?echo_sim_db`: no echo may reach Claude, a barge-in over the voice must; ~28 billed seconds); `npm run e2e:echo` alone, `SOTTO_E2E_ECHO_MATRIX=1` for the no-echo / guard off / auto / on comparison.
  - It also runs `test/e2e/decisions.mjs` (a spoken decision and a casual request must reach Claude, delegated or mirrored; ~40 billed seconds); `npm run e2e:decisions` runs it alone.
  - It also runs `test/e2e/persona.mjs` (a persona switch mid-session re-creates the session in the new persona and voice, the reply shows it, and requests still reach Claude; ~50 billed seconds); `npm run e2e:persona` runs it alone.
  - It also runs `test/e2e/native-daemon.mjs` (the native app path: the daemon owns the Live primary WebSocket and a Node fake app streams `ask-files.wav` over `/api/native`; a delegation must reach the fake inbox and the speaker frames must hold speech; ~8-15 billed seconds); `npm run e2e:native` alone.
  - It also runs `test/e2e/native-app.mjs` (the real native app in test mode, opened by the chooser: greeting, the question transcribed and delegated, a Stop answer spoken, a barge-in stopping it, a voice switch, no can't-hear after the switch (the user was already heard), idle sleep and a voice wake from the app's mic, voice off quits the app; clips are spoken through `SOTTO_APP_MIC_QUEUE_DIR`, output goes to a WAV; prints mic-to-transcript and model-audio-to-playback latencies; ~45-60 billed seconds); `npm run e2e:app` alone.
  - It also runs `test/e2e/miccheck.mjs` (a spoken mic check must be answered by the voice and reach Claude neither delegated nor mirrored; ~25 billed seconds); `npm run e2e:miccheck` runs it alone.
- **Headless toggle probe** (no model call):
  - Command: `SOTTO_NO_BROWSER=1 claude -p --plugin-dir . --model haiku --output-format json "/talk status"`. Expect `num_turns: 0`.
  - `/talk on` from `-p` starts a real daemon. It releases itself about 30 s after the `-p` process exits, or you can run `/talk off`.
- **Never drive an interactive `claude` TUI from automation.** Use `-p` probes.
- **Clean up** any daemon you start (`daemon.pid` in the data dir) and any headless Chrome.
- Headless Chrome fake-mic needs `--disable-features=AudioServiceSandbox` (Chrome 153); without it the mic is silent.
- Tests must be silent: --mute-audio; never play through speakers (a live voice session's mic will hear it). Launch test Chrome only through `test/helpers/silent-chrome.js` (`spawnSilentChrome`), which refuses to start without `--mute-audio` and the fake-mic flags; the app's `--test` mode uses fake audio (output to a WAV). `test/scripts/silent-tests.test.js` enforces both.

## Debugging
- Data dir: `${CLAUDE_PLUGIN_DATA}`. For `--plugin-dir` runs that is `~/.claude/plugins/data/sotto-inline`; for the symlink install it is `~/.claude/plugins/data/sotto-skills-dir`. The fallback is `~/.sotto`.
- Useful files there: `logs/daemon.log` (JSONL, `ev` field), `status.json`, and `active` (present only while a session owns voice).
- `SOTTO_DEBUG=1` logs full hook bodies and every non-audio sideband event.
- `curl -s -H @<(printf 'X-Sotto-Key: %s\n' "$(<$D/daemon.key)") http://127.0.0.1:47821/status` returns full status and counters.

## Conventions
- ESM, `node:` built-ins, and small pure modules with injected `clock`, `fetchImpl` and `WebSocketImpl` so the logic is testable with fakes. New daemon logic gets a unit test, and a pure module if possible.
- Comment the non-obvious *why*: protocol quirks, measured behaviour, verified hangs. Cite the SPEC section.
- Prefer inline `node -e` or `python3 -c` over temporary scripts in the repo.

## Private material (optional)
- `private/` at the repo root is git-ignored and, where present, is a separate private git repository with the maintainer's reference library: saved Claude Code and OpenAI documentation, prior-art notes and the original research digest. Use it for background when it exists, but never copy text from it into this repo (it is third-party material; link the public source instead), and never make code, tests or docs depend on it. Contributors will not have it.

## Git and PR workflow
- This is a public MIT repository (`chadboyda/sotto`). Never commit secrets, personal paths, email addresses or third-party copyrighted text.
- Enable the hooks once per clone with `npm run hooks:install` (`git config core.hooksPath .githooks`). The pre-commit hook runs the secret scan, `npm test` and `plugin validate --strict`.
- **Never commit with `--no-verify`.** Fix what the hook reports.
- Work on a branch and open a PR to `main`. Don't push, open PRs or merge without an explicit request.
- In the PR description, include the `npm test` result, the e2e result with its timings and billed seconds, and any manual checks from SPEC §12 that you ran. CI (`.github/workflows/ci.yml`) runs `npm test` on macOS.
