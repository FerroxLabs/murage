#!/bin/sh
# Real-size rig entry point (release gate). Linux build host: runs inside one --network none node container; macOS canary
# (or any checkout with node_modules installed): runs directly. Exit 0 = GREEN, 1 = RED, 2 = INVALID (the pressure was not created) or rig failure.
# RIG_NODE_MODULES (container mode): a node_modules dir for this lockfile, linked only for the run.
# RIG_HOST=<user@host> (+ RIG_SSH_KEY): run on the dedicated rig host instead (remote.sh); same exit codes, evidence copied back.
#   scripts/rig-realsize/run.sh <evidence-root> [container]     knobs: RIG_* (see rig.mts header), RIG_PROFILE_DIR (default <evidence-root>/profile-<run id>)
# Each run writes only into <evidence-root>/<RIG_RUN_ID> (a new id when unset; an existing one is refused) and seals it last;
# replay it with: node scripts/rig-realsize/verdict.mjs <evidence-root> <run id>
# The profile (about RIG_DB_GB) is written under RIG_PROFILE_DIR and removed at the end unless RIG_KEEP_PROFILE=1.
set -eu
OUT=${1:?evidence root}; MODE=${2:-direct}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
RIG_RUN_ID=${RIG_RUN_ID:-$(date -u +%Y%m%dT%H%M%S)-$$}; export RIG_RUN_ID
case "$RIG_RUN_ID" in *[!A-Za-z0-9._-]*|[!A-Za-z0-9]*) echo "RIG_RUN_ID must be [A-Za-z0-9._-]" >&2; exit 2 ;; esac
if [ -e "$OUT/$RIG_RUN_ID" ]; then echo "[rig] run $RIG_RUN_ID already exists in $OUT: use a new RIG_RUN_ID" >&2; exit 2; fi
echo "[rig] run $RIG_RUN_ID: evidence $OUT/$RIG_RUN_ID, replay: node scripts/rig-realsize/verdict.mjs $OUT $RIG_RUN_ID" >&2
if [ -n "${RIG_HOST:-}" ]; then exec sh "$ROOT/scripts/rig-realsize/remote.sh" "$OUT"; fi   # RIG_HOST: run on the rig host, evidence comes back to $OUT
PROFILE=${RIG_PROFILE_DIR:-$OUT/profile-$RIG_RUN_ID}; mkdir -p "$PROFILE"
if [ "$MODE" = container ]; then
  ENVS=$(env | grep '^RIG_' | sed 's/^/-e /' | tr '\n' ' ')
  # shellcheck disable=SC2086
  exec docker run --init --rm --name "${RIG_CONTAINER_NAME:-murage-rig-realsize}" --network none --cpus "${RIG_CPUS:-10}" --memory "${RIG_MEMORY:-20g}" \
    -e HOME=/tmp/home -e CI=1 -e NO_COLOR=1 -e TMPDIR=/profile -e RIG_OUT=/out $ENVS \
    -v "$ROOT:/work" ${RIG_NODE_MODULES:+-v "$RIG_NODE_MODULES:/nm:ro"} -v "$OUT:/out" -v "$PROFILE:/profile" -w /work "${RIG_IMAGE:-node:24-bookworm}" \
    sh -c 'mkdir -p /tmp/home; if [ -d /nm ] && [ ! -e node_modules ]; then ln -sfn /nm node_modules; trap "rm -f node_modules" EXIT; fi; node --experimental-strip-types scripts/rig-realsize/rig.mts'
fi
cd "$ROOT"
TMPDIR=$PROFILE RIG_OUT=$OUT exec node --experimental-strip-types scripts/rig-realsize/rig.mts
