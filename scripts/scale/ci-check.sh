#!/bin/zsh
# Copyright 2026 Ferrox Labs
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# CI budget check: fails when a SCALE-PLAN budget or the growth slope regresses.
#   scripts/scale/ci-check.sh <label> <commit> [baseline results json]
# Runs the small `pr` shape under load. NOT on the default CI path: the 500-turn slope alone takes
# up to an hour on today's trees (SCALE_SLOPE_CAP_MS), well over the 15 minute limit. Run it from
# .github/workflows/scale-budget.yml (manual and nightly only). With SCALE_SLOPE_CAP_MS=600000 and
# SCALE_SCENARIOS limited to the non-slope set it fits in about 12 minutes, at the cost of the slope check.
set -eu
label=${1:?}; commit=${2:?}; base=${3:-}
here=${0:A:h}
extra=()
if [[ -n $base ]]; then
  H=/root/mb-0161-hz
  ssh -o ControlMaster=no -o ControlPath=none build-host "mkdir -p $H/scale-$label/out"
  scp -o ControlMaster=no -o ControlPath=none "$base" "build-host:$H/scale-$label/out/baseline.json"
  extra=(-e BASELINE=baseline.json)
fi
OUT=${OUT:-$PWD/scale-out} exec "$here/baseline.sh" "$label" "$commit" pr "${extra[@]}"
