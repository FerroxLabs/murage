#!/usr/bin/env bash
# 05f-friction.sh <version> <os> <profile> <rundir> [prev-version]   Release kit step: FRICTION GATE (FRICTION-1025.md s5).
# Owners: step + scorer = lane q1024-frictiongate; the run dir (tasks.json, server.log, transcripts/) = REL canary seat.
# Env FRICTION_RECORD=1 records this score as the version's entry in scripts/friction-gate/scores.json.
# Env FRICTION_SCORES / FRICTION_BUDGET override the record and budget files; FRICTION_SCORER overrides the scorer (tests only).
# Exit 0 PASS, 1 FAIL (increase vs previous release, new kind, failed task, or over the budget table), 2 usage.
set -uo pipefail
[ $# -ge 4 ] || { echo "usage: 05f-friction.sh <version> <os> <profile> <rundir> [prev-version]" >&2; exit 2; }
[ $# -lt 5 ] || [ -n "$5" ] || { echo "FRICTION-SCORE $1 $2/$3 NO-PREV FAIL (an empty previous-release argument is a requested comparison with no name)"; exit 1; }
V=$1 OS=$2 PROFILE=$3 DIR=$4 PREV=${5:-}
H=$(cd "$(dirname "$0")/../friction-gate" && pwd)
SCORER=${FRICTION_SCORER:-$H/friction-score.mjs}
[ -f "$DIR/tasks.json" ] && [ -f "$DIR/server.log" ] || { echo "FRICTION-SCORE $V $OS/$PROFILE NO-INPUT FAIL ($DIR needs tasks.json and server.log)"; exit 1; }
args=("$DIR" --version "$V" --os "$OS" --profile "$PROFILE")
[ -n "$PREV" ] && args+=(--prev-version "$PREV")
[ -n "${FRICTION_SCORES:-}" ] && args+=(--scores "$FRICTION_SCORES")
[ -n "${FRICTION_BUDGET:-}" ] && args+=(--budget "$FRICTION_BUDGET")
[ "${FRICTION_RECORD:-0}" = 1 ] && args+=(--record)
out=$(node "$SCORER" "${args[@]}"); rc=$?
printf '%s\n' "$out"
# A scorer that exits without its verdict line (bad path, crash, wrong guard) must not read as a pass.
printf '%s\n' "$out" | grep -q '^FRICTION-SCORE ' || { echo "FRICTION-SCORE $V $OS/$PROFILE NO-VERDICT FAIL (scorer printed no FRICTION-SCORE line)"; exit 1; }
exit $rc
