---
name: talk
description: Toggle voice mode (probe)
disable-model-invocation: true
argument-hint: "[on|off]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/mark.sh *)
---
!`${CLAUDE_PLUGIN_ROOT}/scripts/mark.sh $ARGUMENTS`

Reply with exactly: OK
