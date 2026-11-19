#!/bin/bash
# Wait on the HUB for a foreground/background g8-smooth launcher, never forever.
# Usage: bash g8-wait.sh STATE_DIRECTORY [timeout-seconds]
set -Eeuo pipefail
trap 'rc=$?; echo "g8-wait: line $LINENO failed ($rc): $BASH_COMMAND" >&2; exit "$rc"' ERR
state=${1:?state directory}; limit=${2:-2700}
[[ $limit =~ ^[1-9][0-9]*$ ]] || { echo 'g8-wait: timeout must be positive seconds' >&2; exit 2; }
deadline=$((SECONDS + limit))
while :; do
  if [[ -f $state/done ]]; then
    read -r rc < "$state/done"
    [[ $rc =~ ^[0-9]+$ && $rc -le 255 ]] || { echo 'g8-wait: corrupt completion status' >&2; exit 4; }
    echo "g8-wait: launcher exit=$rc; evidence=$state"
    exit "$rc"
  fi
  if (( SECONDS >= deadline )); then
    echo "g8-wait: hard timeout after ${limit}s; evidence=$state" >&2; exit 124
  fi
  if [[ -f $state/launcher ]]; then
    read -r pid start < "$state/launcher"
    [[ $pid =~ ^[1-9][0-9]*$ && $start =~ ^[0-9]+$ ]] || { echo 'g8-wait: corrupt launcher identity' >&2; exit 4; }
    stat=$(cat "/proc/$pid/stat" 2> "$state/wait-proc.err") || stat=''
    fields=${stat##*) }
    read -r process_state _ <<< "$fields"
    actual=$(awk '{print $20}' <<< "$fields")
    if [[ $actual != "$start" || $process_state == Z || $process_state == X ]]; then
      # Recheck completion after observing death; a normal exit writes it first.
      [[ ! -f $state/done ]] || continue
      echo "g8-wait: launcher $pid died without completion; evidence=$state" >&2; exit 4
    fi
  fi
  sleep 1
done
