#!/bin/zsh
# Copyright 2026 Ferrox Labs
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# ONE command: BASELINE.md for a tree, measured on build-host (extreme shape, overloaded machine).
#   scripts/scale/baseline.sh <label> <commit> [pr|extreme] [extra docker -e flags...]
# Launches the rig (hz-scale.sh), waits with ONE blocking ssh until the log ends with REALEXIT=,
# copies the results back and writes BASELINE-<label>.md (every SCALE-PLAN section 2 budget with
# value and PASS/FAIL) beside the results JSON, in $OUT (default ./scale-out).
# Exit code: 0 all budgets pass, 1 any FAIL, 2+ rig error. Generation is cached per commit, so a
# repeat run of the same commit skips the 1.5 to 2 hour generation step.
set -u
RIG_HOST=${RIG_HOST:-build-host}   # any ssh host with the rig layout (see README, "Other hosts")
label=${1:?label}; commit=${2:?commit}; shape=${3:-extreme}; (( $# >= 3 )) && shift 3 || shift 2
here=${0:A:h}; top=$(git -C "$here" rev-parse --show-toplevel)
OUT=${OUT:-$PWD/scale-out}; mkdir -p "$OUT"
H=/root/mb-0161-hz
SSHO=(-o ControlMaster=no -o ControlPath=none -o ServerAliveInterval=30 -o ConnectTimeout=20)
flags=(-e LOAD=1 -e SLOW_DISK=1); [[ $shape == extreme ]] && flags+=(-e LOAD_BALLOON_GB=16)
start=$(date +%s)
"$here/hz-scale.sh" "$label" "$commit" "$shape" "${flags[@]}" "$@" || exit 2
# one blocking wait (no polling by the caller); ssh reconnect no faster than 60 s
until ssh $SSHO $RIG_HOST "while ! grep -q '^REALEXIT=' $H/scale-$label/gate.log 2>/dev/null; do sleep 30; done"; do sleep 60; done
secs=$(( $(date +%s) - start ))
rsync -e "ssh ${SSHO[*]}" -a "$RIG_HOST:$H/scale-$label/out/" "$OUT/$label/" 
scp $SSHO $RIG_HOST:$H/scale-$label/gate.log "$OUT/$label/gate.log" >/dev/null
code=$(sed -n 's/^REALEXIT=//p' "$OUT/$label/gate.log" | tail -1)
sha=$(git -C "$top" rev-parse --short=12 "$commit^{commit}")
{
  echo "# BASELINE $label"
  echo
  echo "Tree \`$sha\`, shape \`$shape\`, overloaded (LOAD=1, slow disk), fake engines (model time excluded). Wall time of this run: $(( secs / 60 )) min. Rig exit: ${code:-unknown}."
  echo
  if [[ -f "$OUT/$label/gate-$label.md" ]]; then cat "$OUT/$label/gate-$label.md"; else echo "No results: the rig stopped before the gate. See gate.log."; fi
  echo
  [[ -f "$OUT/$label/manifest-$label.txt" ]] && { echo "Data shape actually generated:"; echo; echo '```'; cat "$OUT/$label/manifest-$label.txt"; echo '```'; }
} > "$OUT/BASELINE-$label.md"
echo "wrote $OUT/BASELINE-$label.md (rig exit ${code:-?}, $(( secs / 60 )) min)"
[[ ${code:-9} == 0 || ${code:-9} == 1 ]] && exit ${code} || exit 2
