#!/bin/bash
input=$(cat)
echo "$(date +%s.%N) $1 $input" >> "${CLAUDE_PLUGIN_ROOT}/hooklog.txt"
if [ "$1" = "expansion" ]; then
  case "$input" in
    *'"command_args":"detached'*) nohup sleep 20 >/dev/null 2>&1 </dev/null & disown; printf '{"continue":false,"stopReason":"daemon started detached"}';;
    *'"command_args":"attached'*) sleep 20 & printf '{"continue":false,"stopReason":"daemon started attached"}';;
  esac
fi
exit 0
