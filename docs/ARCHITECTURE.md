# Sotto architecture

Why Sotto is built the way it is. [SPEC.md](SPEC.md) is the binding contract between the parts; this page is the rationale behind it. Where the two disagree, the spec wins, and [SPEC-DEVIATIONS.md](SPEC-DEVIATIONS.md) records every change made after the spec was written.

Findings marked **measured** were checked with probes against Claude Code 2.1.281 on macOS 26 with Chrome 153 in September 2026. Behaviour of either product can change in later versions.

## 1. The shape in one paragraph

Voice has to reach a Claude Code session that is *already running*, without a relaunch, and the answer has to come back as speech. Sotto does this with three pieces: a set of Claude Code hooks (the plugin shell), a small local Node daemon, and a voice window (a native macOS panel or a Chrome app window) that holds the WebRTC call to OpenAI's `gpt-live-1`. The voice model runs the conversation; when a request needs the code, it *delegates*, and the daemon forwards that request into the Claude Code session as a message. Claude's reply comes back through hooks and is handed to the voice model to say.

## 2. Turning voice on without a model turn

`/talk` is a skill, but the skill body is never meant to reach the model. A `UserPromptExpansion` hook matched to the skill's namespaced name (`^sotto:talk$`) runs `scripts/toggle.sh` and prints `{"continue":false,"stopReason":…}`. Claude Code stops the prompt there: zero model turns, no tokens, and the toggle takes well under a second (**measured**). The matcher must be anchored because the command name contains a colon and is always namespaced, even when the user types bare `/talk`.

Two rules follow from how hooks run:

- **Hooks fire in every session on the machine.** Each non-toggle hook is a bash gate (`scripts/hook.sh`) that checks one state file and exits silently unless this session owns voice. Plugin `http` hooks were rejected: when the daemon is not running, a refused connection shows a visible hook error.
- **A child process that keeps a hook's stdout or stderr open makes Claude Code wait for it** (**measured**). The daemon is therefore started with `nohup … >/dev/null 2>&1 </dev/null & disown`, and every network call a hook makes is backgrounded with all three streams redirected.

## 3. Getting speech into the running session

Claude Code exposes a per-session cross-session messaging socket (`CLAUDE_CODE_MESSAGING_SOCKET`, with a token in `CLAUDE_CODE_MESSAGING_TOKEN`) to hooks and tools. The daemon writes the transcribed request to the owner session's socket, authenticated with that session's own token. If Claude is idle this starts a turn; if it is busy, the message is taken between tool calls (**measured**).

Claude Code frames such messages as coming from another session, not from the user, and that framing cannot be removed. Sotto compensates in two places: the message carries a per-activation tag (`[sotto voice <code>] …`), and the `UserPromptSubmit` hook adds context telling Claude that tagged messages are the user's own transcribed speech, that recognition errors happen, and that replies should lead with a short spoken summary. Permission prompts still need the user at the terminal.

Ownership is keyed to the socket path, so it survives `/clear` and `/resume`. One session owns voice at a time; `/talk on` elsewhere moves it.

## 4. Getting Claude's answer back out

- The `Stop` hook's `last_assistant_message` is the authoritative end-of-turn text. The daemon turns it into something speakable (no code blocks, file names instead of paths, no URLs or secrets) and sends it to the voice model tied to the pending delegation.
- `PreToolUse`, `PermissionRequest`, `MessageDisplay`, `StopFailure` and related hooks provide progress notes, approval requests and errors. A speaking policy (`quiet`, `milestones`, `walkthrough`) decides which of these are spoken and which are passed to the model as silent context.
- A result for a request the user has since superseded (for example after barge-in) is delivered silently instead of being spoken over newer conversation.

No extra language-model call rewrites text for speech; `gpt-live-1` paraphrases natively.

## 5. The gpt-live-1 session

`gpt-live-1` uses OpenAI's Live API (`/v1/live/sessions`), not the Realtime API, and has its own event vocabulary. Its **client delegation** mode is the slot Claude Code fills: the model decides a request needs the backend, emits `session.delegation.created`, says a short acknowledgement itself, and waits for the client to append results.

- **Transport.** The page creates a WebRTC offer; the daemon, which holds the API key, proxies it to OpenAI and returns the answer, then attaches a server-side *sideband* WebSocket to the same session. The sideband is where the daemon reads transcripts and delegations and appends context. It works for WebRTC sessions only.
- **Prompting.** The session instructions follow OpenAI's Live prompting guide (backchannel, interruption and delegation policies), plus a glossary of project and skill names so they are transcribed correctly.
- **Secrets.** Anything appended to the session may be spoken aloud, so the key, tokens and raw tool output are never sent. Only Claude's prose summary and short milestone labels are.

## 6. Echo cancellation and audio

The Live API does not cancel echo on the server. Without local echo cancellation the model hears itself, interrupts itself, and can delegate its own words.

- **Chrome** gives WebRTC's echo canceller when the page asks for `echoCancellation`, `noiseSuppression` and `autoGainControl` and plays the remote track through an `<audio>` element.
- **The desktop app** (WKWebView) routes capture through Apple's voice-processing unit, so `echoCancellation` there is Apple's canceller (**measured**). Its cost: a Bluetooth headset that is the default input switches to its lower-quality headset profile, and other apps' audio is lowered while the mic is open. That is why the default `auto` window choice falls back to Chrome when the default input is Bluetooth.
- The microphone is never gated while the model speaks, because that would break barge-in.

## 7. Cost and idle sleep

`gpt-live-1` bills per connected minute, including silence and mute. Sotto therefore closes the paid session after a period with no speech and no pending request (never while a delegation is still in flight), keeps a small voice detector running locally in the page, and starts a new session seeded with the recent conversation when the user speaks again. A daily cap pauses voice once reached, and `/talk status` and the window show minutes and dollars used today.

## 8. Alternatives considered

| Option | Why it is not the default |
|---|---|
| Channels (an MCP server declaring `claude/channel`) | Gives user-level framing and permission relay, but must be enabled when Claude Code launches, not mid-session. |
| Plugin monitors | Output arrives as task notifications, monitors are never re-spawned, and they are interactive-only. |
| Typing into a terminal multiplexer (`tmux send-keys`) | Requires the session to run inside tmux and is brittle. |
| OpenAI Realtime API | A different model family with server VAD and function tools; `gpt-live-1` is not available there. |
| A native audio helper plus the primary Live WebSocket | Would need its own echo cancellation and jitter buffer. The desktop app gets Apple's canceller through WKWebView instead. |

## 9. Sources

Claude Code:
- [Hooks reference](https://code.claude.com/docs/en/hooks) and [hooks guide](https://code.claude.com/docs/en/hooks-guide)
- [Plugins reference](https://code.claude.com/docs/en/plugins-reference) and [skills](https://code.claude.com/docs/en/skills)
- [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
- [Headless mode](https://code.claude.com/docs/en/headless)

OpenAI:
- [gpt-live-1 model page](https://developers.openai.com/api/docs/models/gpt-live-1)
- [Live API guide](https://developers.openai.com/api/docs/guides/live), [delegation](https://developers.openai.com/api/docs/guides/live-delegation), [prompting](https://developers.openai.com/api/docs/guides/live-prompting), [conversations](https://developers.openai.com/api/docs/guides/live-conversations)
- [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc) and the [sideband WebSocket reference](https://developers.openai.com/api/reference/resources/live/sideband-websocket)
- [Latency and cost](https://developers.openai.com/api/docs/guides/voice-latency-cost)

Web platform:
- [MediaTrackConstraints.echoCancellation (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/echoCancellation)
