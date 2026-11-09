#!/bin/bash
# Copyright 2026 Ferrox Labs
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Smoothness gate, container entry (hz-smooth.sh starts it). Mounts: /work = tree under test (with node_modules),
# /smooth-data/murage = this run's copy of the real data (routines.json already deleted, no config.json), /out = results.
# env: LABEL, TREE_SHA, LOAD (recorded only; the load runs on the host), SMOOTH_SCENARIOS, SMOOTH_ENGINES.
set -u
LABEL=${LABEL:?}
mkdir -p /tmp/home /out; export PATH=/tools/bin:$PATH HOME=/tmp/home
cd /work
[ -d node_modules/.pnpm ] || { echo "no node_modules in /work: hz-smooth.sh links them from a lane dir with the same pnpm-lock"; echo REALEXIT=3; exit 3; }
[ -f /smooth-data/murage/routines.json ] && { echo "routines.json still in the data copy"; echo REALEXIT=3; exit 3; }
[ -f /smooth-data/murage/config.json ] && { echo "config.json in the data copy: not allowed"; echo REALEXIT=3; exit 3; }
echo "STEP run $(date +%T) tree=${TREE_SHA:-?} load=${LOAD:-0} engines=${SMOOTH_ENGINES:-fake}"
MURAGE_DATA_DIR=/smooth-data/murage SMOOTH_WORK=/work SMOOTH_OUT=/out SMOOTH_LABEL="$LABEL" SMOOTH_CTL=/tmp/smooth-ctl node scripts/smoothness/smooth.mjs
RUNNER=$?
echo "runner exit $RUNNER"
echo "STEP gate $(date +%T)"
node scripts/smoothness/smooth-gate.mjs "/out/results-$LABEL.json" --md "/out/gate-$LABEL.md" --verdict "/out/verdict-$LABEL.json"
GATE=$?
if [ "$RUNNER" -ne 0 ]; then GATE=$RUNNER; fi
# Only fake prompt dumps are removed here. /out (including failed-turns JSONL)
# is a host mount; hz-smooth.sh keeps it before removing the container or data.
rm -rf -- /tmp/smooth-ctl/prompts
echo "REALEXIT=$GATE"
exit $GATE
