# shellcheck shell=bash
# sotto shared shell helpers (SPEC §5.5). Sourced, never executed.
# Defines functions only; sourcing this file prints nothing.
#
# Compatibility: macOS ships /bin/bash 3.2, so no bash-4 features here
# (no ${var,,}, no associative arrays, no printf '%(...)T').
#
# NOTE: hook.sh deliberately does NOT source this file on its gated-off path;
# it inlines the gate so sessions without voice pay only one stat + one read.

# clv_data_dir -> prints the plugin data dir D (SPEC §3).
#   D = $CLAUDE_PLUGIN_DATA when set and non-empty, else $HOME/.sotto
clv_data_dir() {
  printf '%s' "${CLAUDE_PLUGIN_DATA:-$HOME/.sotto}"
}

# json_escape [-v VAR] STRING
#   Escapes STRING for use inside a JSON string literal: backslash, double
#   quote, \n \r \t, and every other control char (0x01-0x1f) as \u00XX.
#   Prints the result, or with -v VAR stores it in VAR (no subshell / fork).
#   Pure bash: parameter expansion plus a per-char loop that only runs when
#   a rare control character is present.
json_escape() {
  local __var=""
  if [[ "$1" == "-v" ]]; then __var=$2; shift 2; fi
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  # Remaining control chars (rare): escape one by one.
  if [[ "$s" == *[$'\001'-$'\037']* ]]; then
    local out="" c i hex
    for (( i = 0; i < ${#s}; i++ )); do
      c=${s:i:1}
      case "$c" in
        [$'\001'-$'\037'])
          printf -v hex '\\u%04x' "'$c"
          out+=$hex ;;
        *) out+=$c ;;
      esac
    done
    s=$out
  fi
  if [[ -n "$__var" ]]; then
    printf -v "$__var" '%s' "$s"
  else
    printf '%s' "$s"
  fi
}

# clv_read_active D
#   Reads "$D/active" (one line: <owner_socket>\t<port>\t<key>[\t<nonce>]) and
#   sets CLV_OWNER, CLV_PORT, CLV_KEY and CLV_NONCE. Returns 1 if
#   missing/unreadable/empty.
clv_read_active() {
  local d=$1
  CLV_OWNER="" CLV_PORT="" CLV_KEY="" CLV_NONCE=""
  [[ -f "$d/active" && -r "$d/active" ]] || return 1
  # read's status is ignored on purpose: it is non-zero when the last line has
  # no trailing newline even though the fields were read.
  IFS=$'\t' read -r CLV_OWNER CLV_PORT CLV_KEY CLV_NONCE _ < "$d/active" 2>/dev/null
  [[ -n "$CLV_OWNER" && -n "$CLV_PORT" ]] || return 1
  return 0
}
