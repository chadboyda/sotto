# Probe plugins

Two throwaway plugins used to measure Claude Code behaviour before Sotto was written. They are kept as a record of how the findings in [ARCHITECTURE.md](../ARCHITECTURE.md) were checked, not as part of the product.

- `toggle-probe/`: a `/talk` skill plus a `UserPromptExpansion` hook, used to confirm that a hook can stop a slash command with zero model turns, and to record the hook firing order. Its scripts append to a `hooklog.txt` next to the plugin.
- `e2e-probe/`: logs the `MessageDisplay`, `Stop` and related hook payloads and tries a plugin monitor, used to compare ways of getting text into and out of a running session.

Load one with `claude --plugin-dir docs/experiments/<name>` in a scratch directory. They write log files inside their own folder.
