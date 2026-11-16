#!/bin/bash
set -euo pipefail
PACKAGE=${1:?usage: linux.sh /path/murage new-output plan.json-or---admit [case]}
OUT=${2:?new output directory}; PLAN=${3:?plan or --admit}
[[ $(uname -s) == Linux && -n ${DBUS_SESSION_BUS_ADDRESS:-} && ( -n ${DISPLAY:-} || -n ${WAYLAND_DISPLAY:-} ) ]] || { echo 'S0 OPEN: real desktop and session bus required'; exit 1; }
[[ ! -e "$OUT" ]] || { echo 'S0 OPEN: output exists'; exit 1; }
if [[ "$PLAN" == --admit ]]; then exec "$PACKAGE" --out "$OUT" --admit; fi
ARGS=(--out "$OUT" --plan "$PLAN")
[[ -z ${4:-} ]] || ARGS+=(--case "$4")
exec "$PACKAGE" "${ARGS[@]}"
