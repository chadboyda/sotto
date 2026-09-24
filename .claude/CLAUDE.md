# Sotto: notes for Claude Code sessions working on this repo

Sotto is a Claude Code plugin for full-duplex voice with a running session, built on OpenAI `gpt-live-1` (the Live API, not the Realtime API). The plugin root is the repo root. Read README.md for what it does and how to use it. **docs/SPEC.md is the binding contract** between the parts; docs/ARCHITECTURE.md explains why. Every divergence from the spec is recorded in docs/SPEC-DEVIATIONS.md, so add yours there.

## Layout
- `.claude-plugin/`, `skills/talk/`, `hooks/hooks.json`: the plugin shell. Every hook is an exec-form `command` hook with `args`.
- `bin/sotto`: a CLI on Claude's Bash `PATH` (`sotto voice [name]`, `status`). It wraps `toggle.sh`, so Claude can switch the voice when the user asks by speech.
- `scripts/hook.sh`: the gate plus forwarder for every non-toggle hook. `scripts/toggle.sh` is the `/talk` handler. `scripts/lib.sh` holds shared helpers. Everything here is bash 3.2 (macOS `/bin/bash`).
- `daemon/`: Node 22 ESM with **zero npm dependencies** (global `fetch` and `WebSocket`). `index.js` is the entry and exports `createDaemon()`. `voice.js` is the orchestrator. The pure modules are `delegation.js`, `policy.js`, `speech.js`, `prompt.js` and `transcript.js`. `vocabulary.js` builds the spoken-name glossary (read-only file scan with a deadline) and holds the pure fuzzy matcher. `live.js` handles session creation and the sideband.
- `app/`: the **Sotto** macOS desktop app (Swift, AppKit + WKWebView, no Xcode project): a menu-bar icon and floating panel that host the same voice page. `scripts/build-app.sh` builds it into `D/app` (incremental by sources hash; never commit the bundle). `daemon/window.js` chooses app / Chrome / default browser and falls back to Chrome. `app/Resources/bridge.js` observes the page; `app/Resources/mic.js` + `app/Sources/NativeMic.swift`/`MicBridge.swift` answer the page's `getUserMedia` (native capture without voice processing on headphones, WebKit's on speakers; SPEC §6.16 "Native mic"); the page only reads `window.sottoHost.platform` to word the microphone prompts for macOS instead of Chrome (SPEC-DEVIATIONS, voice window redesign 7). SPEC §6.16.
- `web/`: the voice page. No framework, no build step, no network requests except to the daemon. `dial.js` is the canvas instrument around the mute button (guarded: a failure there must never break the page). `lib.js` is pure and unit-tested (view models in `pageView()`); so is `wake.js` (local voice wake: VAD, pre-roll clip). Idle sleep/wake on the daemon side is `daemon/wake.js` + `daemon/transcribe.js` (SPEC §6.15, §7.6).
- `test/`: `scripts/`, `daemon/` and `web/` hold the node:test unit tests. `helpers/` has the fake inbox, fake clock and fake WebSocket. `e2e/smoke.mjs` runs against the real API. `fixtures/ask-files.wav` is the TTS fake-mic input.

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
  - `.env` is gitignored.
  - The pre-commit hook blocks `.env` files, `sk-proj-…` keys, and the literal key from `.env`.
- **The spec's exact strings are contracts:** event names, headers, messages and file names. Don't rename them casually. The tests pin many of them.
- Product strings contain no emoji and use the prefix `sotto:`.

## Testing
- `npm test` runs all unit tests in about 15 s with no network. It must stay green. Timing tests compare against a bare-bash baseline because `npm test` runs files in parallel.
- `npm run validate` runs `claude plugin validate . --strict`, which must be clean. Also run `claude plugin validate .claude-plugin/plugin.json --strict`.
- `npm run test:app` builds the desktop app and launches it in test mode (hidden panel, mock mic, own defaults) against an in-process temp daemon. Run it after changing `app/`, `daemon/window.js` or the page contracts listed in SPEC §6.16. `SOTTO_APP_LIVE=1` adds a real gpt-live-1 session (about 15 billed seconds). Never launch the app without `--test` from automation: a real-mic launch pops the microphone prompt and can switch the user's AirPods to headset mode.
- `npm run e2e` is the real gpt-live-1 smoke test.
  - Run it after any change to the daemon, the page, the hooks or the prompt.
  - It costs about $0.02 and uses about 20 s of Live time, with a hard 90 s budget guard.
  - It needs Chrome, ffmpeg and the key in `.env`.
  - `SOTTO_E2E_KEEP=1` keeps the temp dir, including the daemon log, for inspection.
  - `npm run e2e` also runs `test/e2e/wake.mjs` (sleep + voice wake, two short sessions, ~30 billed seconds); `npm run e2e:wake` runs it alone.
- **Headless toggle probe** (no model call):
  - Command: `SOTTO_NO_BROWSER=1 claude -p --plugin-dir . --model haiku --output-format json "/talk status"`. Expect `num_turns: 0`.
  - `/talk on` from `-p` starts a real daemon. It releases itself about 30 s after the `-p` process exits, or you can run `/talk off`.
- **Never drive an interactive `claude` TUI from automation.** Use `-p` probes.
- **Clean up** any daemon you start (`daemon.pid` in the data dir) and any headless Chrome.
- Headless Chrome fake-mic needs `--disable-features=AudioServiceSandbox` (Chrome 153); without it the mic is silent.

## Debugging
- Data dir: `${CLAUDE_PLUGIN_DATA}`. For `--plugin-dir` runs that is `~/.claude/plugins/data/sotto-inline`; for the symlink install it is `~/.claude/plugins/data/sotto-skills-dir`. The fallback is `~/.sotto`.
- Useful files there: `logs/daemon.log` (JSONL, `ev` field), `status.json`, and `active` (present only while a session owns voice).
- `SOTTO_DEBUG=1` logs full hook bodies and every non-audio sideband event.
- `curl -s -H "X-Sotto-Key: $(cat $D/daemon.key)" http://127.0.0.1:47821/status` returns full status and counters.

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
