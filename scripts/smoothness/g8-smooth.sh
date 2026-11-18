#!/bin/bash
# Run on the configured Linux hub, using only fake engines.
# Usage: bash scripts/smoothness/g8-smooth.sh PRODUCT idle|load
set -Eeuo pipefail
umask 077
shopt -s inherit_errexit
trap 'rc=$?; echo "g8-smooth: line $LINENO failed ($rc): $BASH_COMMAND" >&2; exit "$rc"' ERR
product=${1:?product commit}; mode=${2:?idle|load}
[[ $mode == idle || $mode == load ]] || { echo 'mode must be idle|load' >&2; exit 2; }
here=$(cd -- "$(dirname -- "$0")" && pwd)
host=${G8_SSH_HOST:?set G8_SSH_HOST to the test worker}
remote_root=${G8_HOST_ROOT:?set G8_HOST_ROOT to the worker scratch root}
[[ $remote_root =~ ^/[a-zA-Z0-9_./-]+$ && $remote_root != / && $remote_root != /dev && $remote_root != /dev/* ]] || { echo 'invalid G8_HOST_ROOT' >&2; exit 2; }
hub=${G8_HUB:-$(git -C "$here" rev-parse --absolute-git-dir)}
rig=${G8_RIG:-$(git -C "$here" rev-parse HEAD)}
product=$(git --git-dir="$hub" rev-parse --verify "$product^{commit}")
rig=$(git --git-dir="$hub" rev-parse --verify "$rig^{commit}")
pb=${PREBUILD:-1}; [[ $pb == 0 || $pb == 1 ]] || { echo 'PREBUILD must be 0|1' >&2; exit 2; }
limit=${G8_TIMEOUT_SECONDS:-2400}
[[ $limit =~ ^[1-9][0-9]*$ ]] || { echo 'G8_TIMEOUT_SECONDS must be positive' >&2; exit 2; }
job=${G8_JOB:-${TMPDIR:-/tmp}/murage-smoothness}
mkdir -p "$job"
if [[ -n ${G8_STATE:-} ]]; then state=$G8_STATE; mkdir "$state"; else state=$(mktemp -d "$job/run-$mode.XXXXXXXX"); fi
finish() {
  local rc=$?
  trap - EXIT
  printf '%s\n' "$rc" > "$state/done.tmp"
  mv "$state/done.tmp" "$state/done"
  echo "g8-smooth: exit=$rc state=$state"
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
stat=$(cat "/proc/$$/stat"); fields=${stat##*) }; start=$(awk '{print $20}' <<< "$fields")
printf '%s %s\n' "$$" "$start" > "$state/launcher.tmp"
mv "$state/launcher.tmp" "$state/launcher"
echo "g8-smooth: state=$state product=$product rig=$rig mode=$mode PREBUILD=$pb"
overlay=$(bash "$here/g8-overlay.sh" "$product" "$rig" "$state")
echo "$overlay" > "$state/overlay"
ssh_args=(-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
if [[ -n ${G8_SSH_IDENTITY:-} ]]; then ssh_args+=(-i "$G8_SSH_IDENTITY"); fi
run="v7-${product:0:12}-$mode-$(date -u +%Y%m%d%H%M%S)-$$"
remote=$remote_root/smooth-$run
ssh "${ssh_args[@]}" "$host" "umask 077; mkdir '$remote'; mkdir '$remote/src' '$remote/out'"
git --git-dir="$hub" archive "$overlay" | ssh "${ssh_args[@]}" "$host" "tar -xf - -C '$remote/src'"
printf '%s\n' "$host:$remote" > "$state/remote"
# Both the remote worker and the SSH client have hard deadlines. The worker owns
# container/stress cleanup and stays bounded even if this launcher is SIGKILLed.
if timeout --foreground --kill-after=30 "$((limit + 180))" \
  ssh "${ssh_args[@]}" "$host" \
  "G8_HOST_ROOT='$remote_root' G8_FIXTURE_MANIFEST='${G8_FIXTURE_MANIFEST:-}' timeout --kill-after=60 '$limit' bash '$remote/src/scripts/smoothness/g8-host.sh' '$remote' '$run' '$overlay' '$mode' '$pb'" \
  2>&1 | tee "$state/launcher.log"; then
  statuses=("${PIPESTATUS[@]}")
else
  statuses=("${PIPESTATUS[@]}")
fi
# A failed gate is an expected worker result, not a tee/launcher exception.
# Capture both statuses before another command overwrites PIPESTATUS.
printf '%s\n' "${statuses[0]}" > "$state/worker.exit"
printf '%s\n' "${statuses[1]}" > "$state/tee.exit"
if (( statuses[1] != 0 )); then
  echo "g8-smooth: launcher log write failed (tee exit=${statuses[1]}; worker exit=${statuses[0]})" >&2
  exit 4
fi
echo "g8-smooth: worker exit=${statuses[0]}; log saved=$state/launcher.log"
exit "${statuses[0]}"
