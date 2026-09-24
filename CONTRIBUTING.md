# Contributing to Sotto

Thanks for helping. Bug reports, measurements on other setups (Intel Macs, other headsets, newer Claude Code versions) and small focused pull requests are all welcome.

## Before you start

- Read [docs/SPEC.md](docs/SPEC.md). It is the binding contract between the hooks, the daemon and the page: event names, headers, file names and messages are pinned by tests, so don't rename them casually. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains why things are the way they are.
- If you change behaviour the spec describes, record it in [docs/SPEC-DEVIATIONS.md](docs/SPEC-DEVIATIONS.md).
- [.claude/CLAUDE.md](.claude/CLAUDE.md) has the hard rules (hooks must never block the terminal, secrets are never logged, bash 3.2 only in `scripts/`). It is written for Claude Code sessions but applies to everyone.

## Setup

```bash
git clone https://github.com/chadboyda/sotto.git && cd sotto
npm ci
npm run hooks:install      # pre-commit: secret scan, npm test, plugin validate --strict
```

Node 22.6 or later is required. There are no runtime npm dependencies; please keep it that way.

## Checks

| Command | When | Needs |
|---|---|---|
| `npm test` | Always. About 15 s, no network. | Node |
| `npm run validate` and `claude plugin validate .claude-plugin/plugin.json --strict` | Always | Claude Code CLI |
| `npm run e2e` | After changing the daemon, the page, the hooks or the prompt | Chrome, ffmpeg, an OpenAI key in `.env` with `gpt-live-1` access. Costs a few cents. |
| `npm run test:app` | After changing `app/`, `daemon/window.js` or the page contracts in SPEC §6.16 | Xcode Command Line Tools |

Never commit with `--no-verify`; fix what the hook reports. Never commit a `.env` file or a key.

## Pull requests

- One change per PR, with a short description of what and why.
- Include the `npm test` result, and the `npm run e2e` result (timings and billed seconds) if you ran it.
- New daemon logic gets a unit test, ideally as a small pure module with injected clock, `fetch` and `WebSocket` so it can run against the fakes in `test/helpers/`.
- Product strings use the `sotto:` prefix and no emoji.

## Private material

Maintainers may keep reference material (saved third-party documentation, research notes) in a `private/` folder at the repo root. It is git-ignored, is its own separate repository, and is never required to build or test Sotto. Don't add third-party text to this repo; link to the public source instead.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
