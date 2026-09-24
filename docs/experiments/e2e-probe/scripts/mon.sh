#!/bin/bash
echo "$(date +%s.%N) monitor-started" >> "$(dirname "$0")/../monlog.txt"
sleep 8
echo "VOICE(user said): What is seven times six? Answer with just the number and the word MONITOR."
echo "$(date +%s) monitor-emitted" >> "$(dirname "$0")/../monlog.txt"
sleep 600
