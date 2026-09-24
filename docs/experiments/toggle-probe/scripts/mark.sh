#!/bin/bash
echo "$(date +%s.%N) INLINE-RAN $*" >> "$(dirname "$0")/../hooklog.txt"; echo "voice state: $*"
