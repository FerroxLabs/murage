#!/bin/bash
# Follow a captured container, then preserve only after proving this run still owns the lane.
set -euo pipefail
umask 077
L=$1; H=$2; label=$3; revision=$4; bundle_hash=$5; RUN_ID=$6; CID=$7; launch_owner=$8; runtime=$9
node_path=${SMOOTH_NODE:-/usr/local/bin/node}
[ -x "$node_path" ] || exit 4
manifest=$(for name in keep-logs.sh keep-logs.mjs scrub-accounting.mjs; do
  digest=$(sha256sum "$runtime/$name") || exit 4
  printf '%s/%s\n' "$name" "${digest%% *}"
done | sha256sum) || exit 4
[ "${manifest%% *}" = "$bundle_hash" ] || { echo 'follower bundle identity mismatch' >&2; exit 4; }
log="$runtime/gate-$RUN_ID.log"
docker logs -f "$CID" > "$log" 2>&1 || printf 'log stream disconnected\n' >> "$runtime/follower.log"
export SMOOTH_OWNER=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
export SMOOTH_TXN=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
owned=0
lock_action() { bash "$runtime/stage-keeper.sh" "$L" "$H" "$label" "$bundle_hash" "$L/src" "$revision" "$1"; }
cleanup() {
  local rc=$?
  trap - EXIT
  if [ "$owned" = 1 ]; then lock_action release || { [ "$rc" -ne 0 ] || rc=4; }; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
wait_seconds=${SMOOTH_FOLLOW_WAIT_SECONDS:-3600}
[[ "$wait_seconds" =~ ^[0-9]+$ ]] && [ "${#wait_seconds}" -le 4 ] && [ "$((10#$wait_seconds))" -le 3600 ] || exit 4
deadline=$((SECONDS + 10#$wait_seconds))
until lock_action acquire >> "$runtime/follower.log" 2>&1; do
  if [ "$SECONDS" -ge "$deadline" ]; then echo 'follower ownership timeout; retaining data' >&2; exit 4; fi
  sleep 10
done
owned=1
expected="$RUN_ID/$CID/$launch_owner"
verify_run() { [ -f "$L/run.id" ] && [ ! -L "$L/run.id" ] && [ "$(wc -l < "$L/run.id")" = 1 ] && [ "$(cat "$L/run.id")" = "$expected" ]; }
verify_run || exit 4
inspect() {
  local answer
  if answer=$(docker inspect -f "$1" "$2" 2>&1); then printf '%s\n' "$answer"
  else case "${answer,,}" in *"no such object"*|*"no such container"*) echo absent ;; *) return 4 ;; esac; fi
}
named=$(inspect '{{.Id}}' "mm-smooth-$label") || exit 4
[ "$named" = absent ] || [ "$named" = "$CID" ] || exit 4
state=$(inspect '{{.State.Running}}' "$CID") || exit 4
case "$state" in false|absent) ;; *) echo 'captured container is live or unknown; retaining data' >&2; exit 4 ;; esac
# stress.pid is read only after both run and container identity checks.
if [ -f "$L/stress.pid" ]; then
  read -r stress_run pid start extra < "$L/stress.pid" || exit 4
  [ "$stress_run" = "$RUN_ID" ] && [[ "$pid" =~ ^[0-9]+$ && "$start" =~ ^[0-9]+$ ]] && [ -z "$extra" ] || exit 4
  if [ -f "/proc/$pid/stat" ]; then
    actual=$(sed 's/.*) //' "/proc/$pid/stat" | awk '{print $20}') || exit 4
    [ "$actual" = "$start" ] || exit 4
    kill -TERM "$pid" || exit 4
  fi
fi
bash "$runtime/keep-logs.sh" "$L/out" "$H/smoothness/logs" "$RUN_ID" "$node_path" || exit 4
cp -p -- "$log" "$H/smoothness/logs/$RUN_ID/gate.log" || exit 4
docker rm "$CID" >> "$runtime/follower.log" 2>&1 || exit 4
[ "$(inspect '{{.State.Running}}' "$CID")" = absent ] || exit 4
verify_run || exit 4
rm -rf -- "${L:?}/data"
