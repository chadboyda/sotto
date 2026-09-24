#!/bin/bash
# sotto /talk handler (SPEC §5.7), run by the UserPromptExpansion hook
# matching ^sotto:talk$.
#
# Always exits 0 and always prints exactly one line:
#   {"continue":false,"stopReason":"<message>"}
# so the prompt stops before any model turn. The message is the daemon's
# /control?format=hook response (passed through verbatim) or one of the
# bash-side strings in SPEC §9.1.
#
# Never reads OPENAI_API_KEY. The one key it handles is the sensitive
# userConfig value CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY, which it passes to a
# daemon it spawns through the environment (never argv, never logged, SPEC
# §4.3). Keys typed as /talk arguments are never read or forwarded.
# Never writes to stderr. Errors are appended to $D/logs/toggle.log.
# Must stay compatible with macOS /bin/bash 3.2.

exec 2>/dev/null
umask 077

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
[[ "$SCRIPT_DIR" == "${BASH_SOURCE[0]}" ]] && SCRIPT_DIR=.
ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ROOT="${ROOT%/}"
# shellcheck source=lib.sh
. "$ROOT/scripts/lib.sh" || . "$SCRIPT_DIR/lib.sh"

D="$(clv_data_dir)"
D="${D%/}"
mkdir -p "$D/logs"
chmod 700 "$D" "$D/logs"

ACTION="?"   # for error logging before the action is known

# --- output helpers ---------------------------------------------------------

# finish MESSAGE: print the stop JSON with MESSAGE and exit 0.
finish() {
  local m
  json_escape -v m "$1"
  printf '{"continue":false,"stopReason":"%s"}\n' "$m"
  exit 0
}

# fail REASON MESSAGE: log REASON to toggle.log, then finish with MESSAGE.
fail() {
  printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ACTION" "$1" >> "$D/logs/toggle.log"
  finish "$2"
}

# --- stdin parsing (bash regex; no jq, no node) -------------------------------

INPUT="$(cat)"

# json_field KEY: prints the raw (still JSON-escaped) string value of KEY
# from $INPUT, or nothing. The value is embedded verbatim in our body, so it
# is never unescaped/re-escaped.
json_field() {
  local re="\"$1\"[[:space:]]*:[[:space:]]*\"((\\\\.|[^\"\\\\])*)\""
  if [[ "$INPUT" =~ $re ]]; then printf '%s' "${BASH_REMATCH[1]}"; fi
}

RAW_ARGS="$(json_field command_args)"
IN_TRANSCRIPT="$(json_field transcript_path)"
IN_CWD="$(json_field cwd)"
IN_SESSION="$(json_field session_id)"

# First word of the argument (read trims leading/trailing whitespace).
# Escaped whitespace from JSON (\n, \t) counts as a separator too.
ARGS_WS="${RAW_ARGS//\\n/ }"; ARGS_WS="${ARGS_WS//\\t/ }"; ARGS_WS="${ARGS_WS//\\r/ }"
read -r ARG ARG2 _ <<<"$ARGS_WS"

# --- action mapping (case-insensitive; bash 3.2 has no ${x,,}) ---------------

POLICY=""
VOICE_ARG=""
KEY_SETUP=""
shopt -s nocasematch
case "$ARG" in
  "")                           ACTION=toggle ;;
  on|start)                     ACTION=on ;;
  off|stop)                     ACTION=off ;;
  status)                       ACTION=status ;;
  restart)                      ACTION=restart ;;
  quiet|milestones|walkthrough) ACTION=policy
                                POLICY="$(printf '%s' "$ARG" | tr '[:upper:]' '[:lower:]')" ;;
  voice|voices)                 ACTION=voice
                                VOICE_ARG="$(printf '%s' "$ARG2" | tr '[:upper:]' '[:lower:]')" ;;
  # /talk key shows where the API key comes from. Anything typed after it
  # (or a bare /talk sk-...) is never read: it opens the setup window instead.
  key|keys|apikey|api-key|api_key)
                                ACTION=key
                                [[ -n "$ARG2" ]] && KEY_SETUP=1 ;;
  sk-*)                         ACTION=key; KEY_SETUP=1 ;;
  *)                            ACTION=usage ;;
esac
shopt -u nocasematch

if [[ "$ACTION" == usage ]]; then
  finish "sotto: usage: /talk [on|off|status|restart|quiet|milestones|walkthrough|voice [name]|key]"
fi

# --- config (SPEC §4.1/§4.2); unset, empty or invalid -> default ---------------

# in_list VALUE WORD...: succeeds if VALUE equals one of the WORDs.
in_list() {
  local v=$1 w; shift
  for w in "$@"; do [[ "$v" == "$w" ]] && return 0; done
  return 1
}

# num_or_default VALUE MIN MAX DEFAULT: prints VALUE as a plain JSON number if
# it is a non-negative decimal within [MIN, MAX]; else DEFAULT.
num_or_default() {
  local v=$1 min=$2 max=$3 def=$4 int frac
  if [[ "$v" =~ ^([0-9]+)(\.([0-9]+))?$ ]]; then
    int=${BASH_REMATCH[1]}; frac=${BASH_REMATCH[3]}
    int=$((10#$int))
    while [[ "$frac" == *0 ]]; do frac=${frac%0}; done
    if (( int >= min && (int < max || (int == max && ${#frac} == 0)) )); then
      if [[ -n "$frac" ]]; then printf '%s.%s' "$int" "$frac"; else printf '%s' "$int"; fi
      return
    fi
  fi
  printf '%s' "$def"
}

VOICES="alloy ash ballad beacon bossa cedar cinder coral delta echo gleam marin meridian quartz ripple sage shimmer stone tempo verse vesper willow"
POLICIES="quiet milestones walkthrough"

CFG_VOICE="$CLAUDE_PLUGIN_OPTION_VOICE"
# shellcheck disable=SC2086
in_list "$CFG_VOICE" $VOICES || CFG_VOICE=marin
CFG_POLICY="$CLAUDE_PLUGIN_OPTION_SPEAKING_POLICY"
# shellcheck disable=SC2086
in_list "$CFG_POLICY" $POLICIES || CFG_POLICY=milestones
# Idle sleep (SPEC §4.1, §6.15): idle_seconds wins; a user-set legacy
# idle_minutes still works. Each is sent only when set (and valid), so the
# daemon can tell "unset" from a value and apply its own default (60 s).
CFG_IDLE_S="$(num_or_default "$CLAUDE_PLUGIN_OPTION_IDLE_SECONDS" 0 7200 "")"
CFG_IDLE_M="$(num_or_default "$CLAUDE_PLUGIN_OPTION_IDLE_MINUTES" 0 120 "")"
CFG_WAKE="$CLAUDE_PLUGIN_OPTION_WAKE_SENSITIVITY"
in_list "$CFG_WAKE" off low medium high || CFG_WAKE=medium
CFG_WINDOW="$CLAUDE_PLUGIN_OPTION_WINDOW"
in_list "$CFG_WINDOW" auto app chrome default || CFG_WINDOW=auto
CFG_CAP="$(num_or_default "$CLAUDE_PLUGIN_OPTION_DAILY_CAP_MINUTES" 0 1440 120)"
CFG_MIRROR="$CLAUDE_PLUGIN_OPTION_MIRROR"
in_list "$CFG_MIRROR" all decisions off || CFG_MIRROR=all
CFG_ECHO="$CLAUDE_PLUGIN_OPTION_ECHO_GUARD"
in_list "$CFG_ECHO" auto on off || CFG_ECHO=auto
# The port must be an integer: it is used in URLs and --port.
PORT="$CLAUDE_PLUGIN_OPTION_PORT"
if [[ "$PORT" =~ ^[0-9]+(\.0+)?$ ]]; then PORT=$((10#${PORT%%.*})); else PORT=""; fi
if [[ -z "$PORT" ]] || (( PORT < 1024 || PORT > 65535 )); then PORT=47821; fi

BASE="http://127.0.0.1:$PORT"
SOCK="$CLAUDE_CODE_MESSAGING_SOCKET"

# --- /talk voice (SPEC §4.5) ----------------------------------------------------
# The chosen voice persists in $D/prefs.json ({"voice":"<name>"}), which beats
# userConfig. With our daemon running, /control applies it (and switches a live
# session); without one, this script lists or writes prefs.json itself, so
# /talk voice never spawns a daemon.
PREFS="$D/prefs.json"
voice_list() { # voice_list CURRENT: prints the list with CURRENT marked
  local v out=""
  for v in $VOICES; do
    [[ -n "$out" ]] && out+=", "
    if [[ "$v" == "$1" ]]; then out+="$v (current)"; else out+="$v"; fi
  done
  printf 'sotto: voice is %s. Voices: %s. Change it with /talk voice <name>.' "$1" "$out"
}
pref_voice() { # prints the valid voice from prefs.json, or nothing
  local p="" re='"voice"[[:space:]]*:[[:space:]]*"([a-z]+)"'
  [[ -r "$PREFS" ]] && p="$(<"$PREFS")"
  # shellcheck disable=SC2086
  if [[ "$p" =~ $re ]] && in_list "${BASH_REMATCH[1]}" $VOICES; then printf '%s' "${BASH_REMATCH[1]}"; fi
}
# voice_local: /talk voice with no daemon of ours to ask (exits).
voice_local() {
  local cur
  cur="$(pref_voice)"; [[ -n "$cur" ]] || cur="$CFG_VOICE"
  [[ -z "$VOICE_ARG" ]] && finish "$(voice_list "$cur")"
  [[ "$VOICE_ARG" == "$cur" ]] && finish "sotto: voice is already $VOICE_ARG."
  printf '{"voice":"%s"}\n' "$VOICE_ARG" > "$PREFS.tmp" && chmod 600 "$PREFS.tmp" && mv -f "$PREFS.tmp" "$PREFS" \
    || fail prefs_write "sotto: ERROR could not save the voice to $PREFS."
  finish "sotto: voice set to $VOICE_ARG. It applies to the next voice session."
}
if [[ "$ACTION" == voice && -n "$VOICE_ARG" ]]; then
  # shellcheck disable=SC2086
  if ! in_list "$VOICE_ARG" $VOICES; then
    SHOWN="${VOICE_ARG//[^a-z0-9_-]/}"
    finish "sotto: unknown voice \"${SHOWN:0:40}\". Voices: ${VOICES// /, }."
  fi
fi

# on/toggle need an inbox socket to deliver voice into this session.
if [[ ( "$ACTION" == on || "$ACTION" == toggle ) && -z "$SOCK" ]]; then
  fail no_socket "sotto: ERROR this session has no inbox socket (CLAUDE_CODE_MESSAGING_SOCKET is unset), so voice cannot reach it."
fi

# --- daemon discovery ---------------------------------------------------------

healthz() { curl -s -m 0.3 "${1:-$BASE}/healthz"; }

# wait_gone BASE: poll until nothing answers /healthz at BASE (<= ~4 s).
# A daemon told to shut down stops listening right after it answers, but an
# older daemon may still close its Live session first (up to a few seconds).
wait_gone() {
  local i=0
  while (( i < 80 )) && [[ -n "$(healthz "$1")" ]]; do sleep 0.05; i=$((i + 1)); done
  [[ -z "$(healthz "$1")" ]]
}

# key_header KEY: the daemon-key header line, for `curl -H @<(key_header K)`.
# The key never goes on curl's command line (macOS `ps` shows every user's argv).
key_header() { printf 'X-Sotto-Key: %s\n' "$1"; }

# post_shutdown BASE KEY: ask a daemon to stop (fire and forget).
post_shutdown() {
  printf '{"action":"shutdown"}' | curl -s -m 2 -o /dev/null -X POST \
    -H 'Content-Type: application/json' -H @<(key_header "$2") \
    --data-binary @- "$1/control" >/dev/null
}

# unescape_path S: undo the JSON escapes that can appear in a filesystem path.
unescape_path() {
  local s=$1
  s=${s//\\\//\/}
  s=${s//\\\"/\"}
  s=${s//\\\\/\\}
  printf '%s' "$s"
}

json_escape -v E_D "$D"
json_escape -v E_ROOT "$ROOT"
KEYFILE="$D/daemon.key"

H="$(healthz)"
if [[ -n "$H" ]]; then
  if [[ "$H" != *'"name":"sotto"'* ]]; then
    # Name the program when it says who it is (e.g. an older voice daemon
    # that also answers /healthz), so the user knows what to stop.
    re_nm='"name":"([A-Za-z0-9._-]{1,40})"'
    WHO=""; [[ "$H" =~ $re_nm ]] && WHO=" (${BASH_REMATCH[1]})"
    fail port_in_use "sotto: ERROR port $PORT is used by another program$WHO. Choose another port in /config (sotto), or stop that program."
  fi
  re_dd='"data_dir":"((\\.|[^"\\])*)"'
  re_pr='"plugin_root":"((\\.|[^"\\])*)"'
  H_DD=""; H_PR=""
  [[ "$H" =~ $re_dd ]] && H_DD="${BASH_REMATCH[1]}"
  [[ "$H" =~ $re_pr ]] && H_PR="${BASH_REMATCH[1]}"
  if [[ "$H_DD" != "$E_D" || "$H_PR" != "$E_ROOT" ]]; then
    # A sotto daemon from another install (other data dir or plugin
    # root) holds the port. Talk to it with ITS key.
    OTHER_D="$(unescape_path "$H_DD")"
    [[ -n "$OTHER_D" ]] && KEYFILE="$OTHER_D/daemon.key"
    if [[ "$ACTION" == voice ]]; then
      # The voice lives in OUR prefs.json; a foreign daemon has nothing to do with it.
      voice_local
    fi
    if [[ "$ACTION" == on || "$ACTION" == toggle ]]; then
      # Replace it with ours: ask it to shut down, wait for the port, then spawn.
      OKEY=""; [[ -r "$KEYFILE" ]] && OKEY="$(<"$KEYFILE")"
      post_shutdown "$BASE" "${OKEY%%[[:space:]]*}"
      wait_gone "$BASE" || fail other_daemon_stuck "sotto: ERROR the voice daemon did not answer. See $OTHER_D/logs/daemon.log"
      H=""
      KEYFILE="$D/daemon.key"
    fi
  fi
fi

# Our daemon may still run on a port recorded before the port option changed.
# off/status/policy talk to it there; on/toggle stop it and start on the new port.
if [[ -z "$H" && -r "$D/daemon.port" ]]; then
  RECPORT="$(<"$D/daemon.port")"; RECPORT="${RECPORT%%[[:space:]]*}"
  if [[ "$RECPORT" =~ ^[0-9]+$ && "$RECPORT" != "$PORT" ]]; then
    RBASE="http://127.0.0.1:$RECPORT"
    RH="$(healthz "$RBASE")"
    if [[ "$RH" == *'"name":"sotto"'* && "$RH" == *"\"data_dir\":\"$E_D\""* ]]; then
      if [[ "$ACTION" == on || "$ACTION" == toggle ]]; then
        RKEY=""; [[ -r "$D/daemon.key" ]] && RKEY="$(<"$D/daemon.key")"
        post_shutdown "$RBASE" "${RKEY%%[[:space:]]*}"
        wait_gone "$RBASE" || fail other_daemon_stuck "sotto: ERROR the voice daemon on port $RECPORT did not stop. See $D/logs/daemon.log"
        # The old daemon removes its pid file as it exits; give it a moment so
        # the new one does not refuse to start ("another daemon is running").
        i=0; while (( i < 40 )) && [[ -f "$D/daemon.pid" ]]; do sleep 0.05; i=$((i + 1)); done
      else
        BASE="$RBASE"
        H="$RH"
      fi
    fi
  fi
fi

# daemon_down: the answer for off/status/policy when no daemon runs (exits);
# returns for on/toggle, which then cold-start one.
daemon_down() {
  case "$ACTION" in
    off|status) finish "sotto: voice is off." ;;
    restart)    finish "sotto: voice is off. The next /talk on starts the latest code." ;;
    policy)     finish "sotto: voice is off. Turn it on with /talk on first." ;;
    voice)      voice_local ;;
  esac
  # on/toggle/key continue: key needs a daemon to serve the setup window.
}

# pick_runtime: sets NODE to a runtime that can run the daemon (SPEC §6.2), or
# fails early with how to get one. Node 22+ from PATH (asked from the plugin
# root, where the daemon runs, so version managers pick the same Node); else
# Bun >= 1.1, which runs the daemon unchanged (verified with bun 1.3.5: unit
# probe, real gpt-live-1 e2e and a self-update). Only cold starts pay for
# the `node -v` (measured: 10 ms plain, 140 ms through a nodenv shim).
pick_runtime() {
  local v="" b="" cand
  if [[ -n "$SOTTO_NODE" ]]; then
    NODE="$SOTTO_NODE"
    command -v "$NODE" >/dev/null || fail no_node "sotto: ERROR SOTTO_NODE ($SOTTO_NODE) was not found. Point it at a Node 22 (or Bun) binary, or unset it."
    return 0 # the daemon checks the version itself (D/start-error)
  fi
  if command -v node >/dev/null; then
    v="$(cd "$ROOT" && node -v 2>/dev/null </dev/null)"
    if [[ "$v" =~ ^v([0-9]+)\. ]] && (( BASH_REMATCH[1] >= 22 )); then NODE=node; return 0; fi
  fi
  for cand in bun "$HOME/.bun/bin/bun"; do
    command -v "$cand" >/dev/null || continue
    b="$("$cand" --version 2>/dev/null </dev/null)"
    if [[ "$b" =~ ^([0-9]+)\.([0-9]+) ]] && (( BASH_REMATCH[1] > 1 || (BASH_REMATCH[1] == 1 && BASH_REMATCH[2] >= 1) )); then
      NODE="$cand"; return 0
    fi
  done
  local how="Install Node 22 or newer (brew install node, nvm install 22, or nodejs.org), or Bun (bun.sh), then run /talk on again."
  if [[ -n "$v" ]]; then
    fail no_node "sotto: ERROR node on PATH is $v; sotto needs Node 22 or newer. $how"
  elif command -v node >/dev/null; then
    fail no_node "sotto: ERROR node on PATH did not run (a version manager without an installed version?). $how"
  fi
  fail no_node "sotto: ERROR node was not found on PATH; sotto needs Node 22 or newer. $how"
}

# cold_start: spawn our daemon on $PORT and wait until it answers (sets H).
cold_start() {
  [[ -n "$SOCK" || "$ACTION" == key ]] || fail no_socket "sotto: ERROR this session has no inbox socket (CLAUDE_CODE_MESSAGING_SOCKET is unset), so voice cannot reach it."
  pick_runtime
  ENTRY="${SOTTO_DAEMON_ENTRY:-$ROOT/daemon/index.js}"
  rm -f "$D/start-error"
  # Fully detached: nohup, all stdio redirected, disowned. Anything less and
  # Claude Code waits on the daemon holding the hook's pipes (VERIFIED hang).
  # Spawned from the plugin root, not the session's project: version managers
  # (nodenv, nvm, asdf shims) pick Node from the cwd's .node-version/.nvmrc,
  # and the daemon should not pin the project directory for its lifetime.
  # The sensitive userConfig key reaches the daemon only through its
  # environment (never argv: `ps` shows argv to every local user).
  ( cd "$ROOT" && CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY="${CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY:-}" \
      exec nohup "$NODE" "$ENTRY" --port "$PORT" --data-dir "$D" --plugin-root "$ROOT" ) >/dev/null 2>&1 </dev/null &
  disown
  # Poll /healthz every 50 ms for up to ~5 s (version-manager shims can take a
  # second to start node). bash 3.2 has no sub-second clock, so bound by both
  # SECONDS (4-5 s of wall time) and an iteration cap.
  SECONDS=0
  i=0
  while (( SECONDS < 5 && i < 100 )); do
    H="$(healthz)"
    [[ -n "$H" ]] && break
    [[ -f "$D/start-error" ]] && break
    sleep 0.05
    i=$((i + 1))
  done
  if [[ -z "$H" && -f "$D/start-error" ]]; then
    IFS=$'\t' read -r SE_CODE SE_VER _ < "$D/start-error"
    [[ "$SE_CODE" == node_version ]] && fail no_node "sotto: ERROR node on PATH is $SE_VER; sotto needs Node 22 or newer. Set SOTTO_NODE to a Node 22 binary, or change your default Node."
  fi
  # It must be OUR daemon that answers (same data dir), not a leftover.
  [[ "$H" == *'"name":"sotto"'* && "$H" == *"\"data_dir\":\"$E_D\""* ]] || fail spawn_timeout "sotto: ERROR the voice daemon did not start. See $D/logs/daemon.log"
  BASE="http://127.0.0.1:$PORT"
  KEYFILE="$D/daemon.key"
}

# A daemon of ours without any key, while the plugin settings now hold one:
# the key only reaches a daemon at spawn, so restart it (it cannot be live).
if [[ -n "$H" && -n "$CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY" && "$H" == *'"api_key":false'* \
      && "$H" == *"\"data_dir\":\"$E_D\""* && ( "$ACTION" == on || "$ACTION" == toggle || "$ACTION" == key ) ]]; then
  read_key_file() { local k=""; [[ -r "$D/daemon.key" ]] && k="$(<"$D/daemon.key")"; printf '%s' "${k%%[[:space:]]*}"; }
  post_shutdown "$BASE" "$(read_key_file)"
  wait_gone "$BASE" || fail other_daemon_stuck "sotto: ERROR the voice daemon did not answer. See $D/logs/daemon.log"
  i=0; while (( i < 40 )) && [[ -f "$D/daemon.pid" ]]; do sleep 0.05; i=$((i + 1)); done
  H=""
fi

if [[ -z "$H" ]]; then
  daemon_down
  cold_start
fi

# --- /control -------------------------------------------------------------------

# read_key: the key of the daemon we talk to.
read_key() {
  KEY=""; [[ -r "$KEYFILE" ]] && KEY="$(<"$KEYFILE")"
  KEY="${KEY%%[[:space:]]*}"
}

# Session object: env-derived strings are escaped; stdin-derived strings are
# already JSON-escaped and embedded verbatim. Empty fields are omitted.
SESSION=""
add_field() { # add_field KEY RAW_JSON_VALUE
  [[ -n "$SESSION" ]] && SESSION+=","
  SESSION+="\"$1\":$2"
}
[[ -n "$IN_SESSION" ]] && add_field session_id "\"$IN_SESSION\""
if [[ -n "$SOCK" ]]; then json_escape -v v "$SOCK"; add_field socket "\"$v\""; fi
if [[ -n "$CLAUDE_CODE_MESSAGING_TOKEN" ]]; then json_escape -v v "$CLAUDE_CODE_MESSAGING_TOKEN"; add_field token "\"$v\""; fi
[[ "$CLAUDE_PID" =~ ^[0-9]+$ ]] && add_field claude_pid "$CLAUDE_PID"
[[ -n "$IN_CWD" ]] && add_field cwd "\"$IN_CWD\""
if [[ -n "$CLAUDE_PROJECT_DIR" ]]; then json_escape -v v "$CLAUDE_PROJECT_DIR"; add_field project_dir "\"$v\""; fi
[[ -n "$IN_TRANSCRIPT" ]] && add_field transcript_path "\"$IN_TRANSCRIPT\""

BODY="{\"action\":\"$ACTION\""
[[ "$ACTION" == policy ]] && BODY+=",\"policy\":\"$POLICY\""
[[ "$ACTION" == voice && -n "$VOICE_ARG" ]] && BODY+=",\"voice\":\"$VOICE_ARG\""
[[ "$ACTION" == key && -n "$KEY_SETUP" ]] && BODY+=",\"setup\":true"
BODY+=",\"session\":{$SESSION}"
IDLE_JSON=""
[[ -n "$CFG_IDLE_S" ]] && IDLE_JSON+=",\"idle_seconds\":$CFG_IDLE_S"
[[ -n "$CFG_IDLE_M" ]] && IDLE_JSON+=",\"idle_minutes\":$CFG_IDLE_M"
BODY+=",\"config\":{\"voice\":\"$CFG_VOICE\"$IDLE_JSON,\"speaking_policy\":\"$CFG_POLICY\",\"daily_cap_minutes\":$CFG_CAP,\"wake_sensitivity\":\"$CFG_WAKE\",\"window\":\"$CFG_WINDOW\",\"mirror\":\"$CFG_MIRROR\",\"echo_guard\":\"$CFG_ECHO\",\"open_browser\":true}}"

# post_control: POST the body; pass a one-line JSON answer through and exit.
post_control() {
  read_key
  RESP="$(printf '%s' "$BODY" | curl -s -m 2 -X POST \
    -H 'Content-Type: application/json' \
    -H @<(key_header "$KEY") \
    --data-binary @- "$BASE/control?format=hook")"
  RESP="${RESP%$'\n'}"
  if [[ "$RESP" == \{*\} && "$RESP" == *'"continue":false'* && "$RESP" != *$'\n'* ]]; then
    printf '%s\n' "$RESP"
    exit 0
  fi
}

post_control
# No answer, and the daemon is gone: it exited between discovery and /control
# (an idle daemon exits 3 s after /talk off). Handle it as "no daemon" once.
if [[ -z "$(healthz)" ]]; then
  daemon_down
  cold_start
  post_control
fi
fail bad_response "sotto: ERROR the voice daemon did not answer. See $D/logs/daemon.log"
