#!/bin/bash
set -euo pipefail
# Run only by MAIN in the Mac gate user's Aqua session.
PACKAGE=${1:?usage: macos.sh /path/Murage.app new-output plan.json-or---admit [case]}
OUT=${2:?new output directory}; PLAN=${3:?plan or --admit}
[[ $(uname -s) == Darwin ]] || { echo 'S0 OPEN: macOS required'; exit 1; }
[[ ! -e "$OUT" ]] || { echo 'S0 OPEN: output exists'; exit 1; }
if [[ "$PLAN" == --admit ]]; then
  exec "$PACKAGE/Contents/MacOS/Murage" --out "$OUT" --admit
fi
ARGS=(--out "$OUT" --plan "$PLAN")
[[ -z ${4:-} ]] || ARGS+=(--case "$4")
exec "$PACKAGE/Contents/MacOS/Murage" "${ARGS[@]}"
