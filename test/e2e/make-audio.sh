#!/bin/bash
# Build the fake-mic WAV for the e2e smoke test (SPEC §11.4 step 1).
# Usage: test/e2e/make-audio.sh <out.wav> ["spoken text"] [lead-in ms, default 2000]
set -euo pipefail
OUT="${1:?usage: make-audio.sh <out.wav> [text] [lead-in ms]}"
TEXT="${2:-Hey, can you ask Claude what the current git branch is?}"
DELAY="${3:-2000}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say -v Samantha -o "$TMP/q.aiff" "$TEXT"
# Leading silence (SPEC: 2 s; the smoke test passes more so the request lands
# after the greeting), then pad to keep the session clock running for ~60 s.
ffmpeg -loglevel error -y -i "$TMP/q.aiff" -af "adelay=${DELAY}:all=1,apad=pad_dur=60" -ar 48000 -ac 1 -c:a pcm_s16le "$OUT"
