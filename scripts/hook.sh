#!/bin/bash
# sotto hook gate + forwarder (SPEC §5.6).
#
# Registered for UserPromptSubmit, PreToolUse, PermissionRequest,
# MessageDisplay, Notification, Elicitation, SubagentStop, TaskCompleted,
# TeammateIdle, PostToolUseFailure, Stop, StopFailure and SessionEnd in EVERY
# session where the plugin is installed. Invoked as: hook.sh <EventName>, hook
# JSON on stdin. Only UserPromptSubmit and PreToolUse ever print; every other
# event is forward-only (an Elicitation hook that printed a decision would
# answer the MCP server's dialog for the user).
#
# Off path (voice off, or another session owns voice): exit 0 with no output,
# without reading stdin, after one stat and one `read` builtin. No forks, no
# subshells, no `source` before the owner check.
#
# Owner path: forward the raw hook JSON to the daemon in a fully detached
# background curl (a child holding our stdio pipes would make Claude Code wait
# for it), print the event-specific context JSON if any, and exit 0.
#
# Never writes to stderr; stdout is empty or exactly one JSON object.
# Must stay compatible with macOS /bin/bash 3.2.

exec 2>/dev/null

# --- gate -------------------------------------------------------------------
D="${CLAUDE_PLUGIN_DATA:-$HOME/.sotto}"
[[ -f "$D/active" && -n "$CLAUDE_CODE_MESSAGING_SOCKET" ]] || exit 0
# read's exit status is ignored: it is non-zero for a missing trailing newline.
IFS=$'\t' read -r OWNER PORT KEY NONCE _ < "$D/active"
[[ -n "$OWNER" && "$OWNER" == "$CLAUDE_CODE_MESSAGING_SOCKET" ]] || exit 0
[[ "$PORT" =~ ^[0-9]+$ ]] || exit 0

# --- owner path ---------------------------------------------------------------
EVENT="$1"
INPUT="$(cat)"
# Voice marker for this bind: "[sotto voice <nonce>]" (the nonce is hex).
if [[ "$NONCE" =~ ^[0-9a-f]+$ ]]; then MARK="[sotto voice $NONCE]"; else MARK="[sotto voice]"; fi

# Fire-and-forget POST. All three std streams of the background job are
# redirected so nothing keeps the hook's pipes open (ARCHITECTURE §2 hang).
( printf '%s' "$INPUT" | curl -s -m 3 -o /dev/null -X POST \
    -H 'Content-Type: application/json' \
    -H "X-Sotto-Key: $KEY" \
    -H "X-Sotto-Socket: $OWNER" \
    --data-binary @- "http://127.0.0.1:$PORT/hook/$EVENT" ) >/dev/null 2>&1 </dev/null &

# print_context <HookEventName>: one-line additionalContext JSON (SPEC §5.8).
# voice-context.txt is guaranteed free of '"', '\' and newlines, so it is
# embedded without escaping; `read` strips the trailing newline. Its @MARKER@
# placeholder becomes this bind's exact marker (hex nonce: JSON-safe).
print_context() {
  local root ctx
  root="${CLAUDE_PLUGIN_ROOT:-${BASH_SOURCE[0]%/*}/..}"
  IFS= read -r ctx < "$root/scripts/voice-context.txt"
  [[ -n "$ctx" ]] || return 0
  ctx=${ctx//@MARKER@/$MARK}
  printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}' "$1" "$ctx"
}

case "$EVENT" in
  UserPromptSubmit)
    # Voice messages arrive through the inbox prefixed with this bind's
    # marker. Anchored to the start of the prompt field (Claude Code sends
    # compact JSON, and the prompt is the raw message text), so a typed or
    # peer message that merely mentions the marker gets no voice framing.
    if [[ "$INPUT" == *"\"prompt\":\"$MARK"* || "$INPUT" == *"\"prompt\": \"$MARK"* ]]; then
      print_context UserPromptSubmit
    fi
    ;;
  PreToolUse)
    # The daemon drops this flag when it sent a voice message while Claude
    # was busy, as a fallback for a mid-turn absorption without its own
    # UserPromptSubmit (CLI 2.1.281 does fire one; the daemon then removes the
    # flag as soon as that UserPromptSubmit reaches it). The claim
    # is a rename(2) to a per-process name: of concurrent hooks exactly one
    # rename succeeds. (`rm` is NOT safe here: macOS /bin/rm stats before
    # unlinking and exits 0 in both racers about 1 time in 4, measured.)
    # Only the main thread claims it: a subagent's tool call (agent_id in the
    # input) runs with the same env but is not where the message was absorbed.
    if [[ -f "$D/pending-context" && "$INPUT" != *'"agent_id"'* ]]; then
      if mv "$D/pending-context" "$D/pending-context.$$" 2>/dev/null; then
        rm -f "$D/pending-context.$$"
        print_context PreToolUse
      fi
    fi
    ;;
esac

exit 0
