#!/bin/bash
# sotto courier launcher (SPEC §6.9.2), run by Claude Code as the plugin's
# stdio MCP server (.mcp.json) in every session. Picks a runtime like
# toggle.sh (SOTTO_NODE, else node, else Bun) and execs daemon/courier.js,
# so the courier itself is Claude Code's child. No output of its own: stdout
# is the MCP channel.
exec 2>/dev/null
ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${BASH_SOURCE[0]%/*}/.." && pwd)}"
for cand in "$SOTTO_NODE" node bun "$HOME/.bun/bin/bun"; do
  [[ -n "$cand" ]] && command -v "$cand" >/dev/null && exec "$cand" "${ROOT%/}/daemon/courier.js"
done
exit 1
