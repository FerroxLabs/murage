#!/bin/bash
set -euo pipefail
umask 077
out=${1:?out}; root=${2:?root}; id=${3:?run-id}
node_path=${4:-${SMOOTH_NODE:-/usr/local/bin/node}}
[ -x "$node_path" ] || { echo 'keep-logs: explicit Node is unavailable' >&2; exit 4; }
[[ "$id" =~ ^[A-Za-z0-9._-]+$ && "$id" != . && "$id" != .. ]] || exit 2
[ -d "$out" ] || exit 2
mkdir -p -- "$root" || exit 4
stage=$(mktemp -d "$root/.keep-$id.XXXXXXXX") || exit 4
child=
cleanup() {
  local rc=$?
  trap - EXIT
  rm -rf -- "$stage" || { [ "$rc" -ne 0 ] || rc=4; }
  exit "$rc"
}
interrupted() {
  local rc=$1
  if [ -n "$child" ]; then kill -TERM "$child" || true; wait "$child" || true; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'interrupted 130' INT
trap 'interrupted 143' TERM HUP
"$node_path" "$(dirname -- "$0")/keep-logs.mjs" "$out" "$root" "$id" "$stage" &
child=$!
wait "$child"
