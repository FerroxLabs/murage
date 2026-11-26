#!/bin/sh
# Run the real-size rig on a dedicated rig host (RIG_HOST), then bring the evidence back. Called by run.sh when RIG_HOST is set.
#   RIG_HOST=<user@host> RIG_SSH_KEY=<key file> scripts/rig-realsize/run.sh <evidence-root>
# Owner of the host and of what runs on it: the rig lane. The host runs only --network none rig containers named rig-<run id>.
# Sends the checkout's tracked and new files (not .git, not node_modules) to <RIG_HOST_DIR>/runs/<id>/src, runs the same container
# as run.sh container mode on the host (the rig writes and seals out/<id>), copies it back to <evidence-root>/<id>, removes the
# host run dir (RIG_HOST_KEEP=1 keeps it). The host's docker tail and exit code land next to it (<id>.rig-host-*), never inside.
# node_modules come from <RIG_HOST_DIR>/nm/<lockfile hash>/node_modules (RIG_NODE_MODULES here is sent once if the host lacks them).
# Exit code = the rig's (0 GREEN, 1 RED, 2 INVALID/rig failure). RIG_HOST_DRY=1 prints the commands and runs none of them.
set -eu
OUT=${1:?evidence dir}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HOST=${RIG_HOST:?}
HDIR=${RIG_HOST_DIR:-/srv/rig}
KEY=${RIG_SSH_KEY:?set RIG_SSH_KEY to the ssh key file for RIG_HOST}
ID=${RIG_RUN_ID:-$(date -u +%Y%m%dT%H%M%S)-$$}
case "$ID" in *[!A-Za-z0-9._-]*|[!A-Za-z0-9]*|"") echo "RIG_RUN_ID must be [A-Za-z0-9._-], starting with a letter or digit" >&2; exit 2 ;; esac
NAME=rig-$ID
SEAL=run-complete.json   # verdict.mjs RUN_COMPLETE
RD=$HDIR/runs/$ID
SSHO="-i $KEY -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ConnectTimeout=20"
rs() { ssh $SSHO "$HOST" "$@"; }
fail() { echo "[rig-host] $*" >&2; exit 2; }
run() { if [ -n "${RIG_HOST_DRY:-}" ]; then echo "+ $*"; else "$@"; fi; }
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
[ ! -e "$OUT/$ID" ] || fail "run $ID already exists in $OUT: use a new RIG_RUN_ID"

LH=$(sha256sum "$ROOT/pnpm-lock.yaml" | cut -c1-16)
NM=$HDIR/nm/$LH/node_modules
if [ -z "${RIG_HOST_DRY:-}" ] && ! rs "test -d $NM"; then
  if [ -n "${RIG_NODE_MODULES:-}" ] && [ -d "$RIG_NODE_MODULES" ]; then
    echo "[rig-host] sending node_modules for lockfile $LH" >&2
    tar -C "$(dirname "$(readlink -f "$RIG_NODE_MODULES")")" -c "$(basename "$(readlink -f "$RIG_NODE_MODULES")")" | zstd -T8 -3 |
      rs "T=$HDIR/nm/$LH.tmp.$ID; rm -rf \${T:?}; mkdir -p \$T $HDIR/nm/$LH && cd \$T && zstd -d | tar -x && mv \$T/$(basename "$(readlink -f "$RIG_NODE_MODULES")") $NM && rm -rf \${T:?}" || fail "could not send node_modules"
  else
    echo "[rig-host] no node_modules for lockfile $LH on the host; set RIG_NODE_MODULES to a local copy" >&2; exit 2
  fi
fi

echo "[rig-host] $HOST run $ID container $NAME" >&2
if [ -z "${RIG_HOST_DRY:-}" ] && rs "test -e $RD"; then fail "run dir $RD already exists on the host: use a new RIG_RUN_ID"; fi
cleanup() { rs "rm -rf ${RD:?}" >/dev/null 2>&1 || true; }
run ssh $SSHO "$HOST" "mkdir -p $RD/src $RD/out $RD/profile"
FILES=$(mktemp)
stop() {
  echo "[rig-host] interrupted: stopping $NAME" >&2
  rs "docker stop -t 20 $NAME; sleep 5; docker rm -f $NAME" >/dev/null 2>&1 || true
  [ -n "${RIG_HOST_KEEP:-}" ] || cleanup
}
trap 'rm -f "$FILES"' EXIT
trap 'stop; exit 2' INT TERM
if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$ROOT" ls-files -z --cached --others --exclude-standard --deduplicate > "$FILES"
else
  (cd "$ROOT" && find . -path ./node_modules -prune -o -path ./.git -prune -o -type f -print0 | sed -z 's|^\./||') > "$FILES"
fi
run rsync -a --ignore-missing-args --from0 --files-from="$FILES" -e "ssh $SSHO" "$ROOT/" "$HOST:$RD/src/"

ENVS=$(env | grep -E '^RIG_[A-Z_]+=' | grep -vE '^RIG_(HOST|HOST_DIR|HOST_KEEP|HOST_DRY|SSH_KEY|RUN_ID|NODE_MODULES|OUT|CONTAINER_NAME|IMAGE|PROFILE_DIR)=' | sed "s/'/'\\\\''/g; s/^/-e '/; s/\$/'/" | tr '\n' ' ')
IMG=${RIG_IMAGE:-node:24-bookworm}
CMD="docker run --init --rm --name $NAME --label owner=rig-host --network none --cpus ${RIG_CPUS:-10} --memory ${RIG_MEMORY:-20g} -e HOME=/tmp/home -e CI=1 -e NO_COLOR=1 -e TMPDIR=/profile -e RIG_OUT=/out -e RIG_RUN_ID=$ID $ENVS -v $RD/src:/work -v $NM:/nm:ro -v $RD/out:/out -v $RD/profile:/profile -w /work $IMG sh -c 'mkdir -p /tmp/home; ln -sfn /nm node_modules; node --experimental-strip-types scripts/rig-realsize/rig.mts'"
# Detached on the host (an ssh drop must not kill a 75 minute run); the exit code lands in $RD/exit.
run ssh $SSHO "$HOST" "cd $RD && nohup sh -c '$(printf '%s' "$CMD" | sed "s/'/'\\\\''/g"); echo \$? > $RD/exit' > $RD/docker.log 2>&1 < /dev/null &"
if [ -n "${RIG_HOST_DRY:-}" ]; then echo "+ wait for $RD/exit, rsync $RD/out back to $OUT, remove $RD"; exit 0; fi

CODE=""; GONE=0; START=$(date +%s); MAXMIN=${RIG_HOST_MAX_MIN:-150}
while [ -z "$CODE" ]; do
  sleep 30
  C=$(rs "cat $RD/exit 2>/dev/null" 2>/dev/null || true)
  case "$C" in ''|*[!0-9]*) ;; *) CODE=$C; continue ;; esac
  if [ -n "$(rs "docker ps -q --filter name=^$NAME\$" 2>/dev/null || true)" ]; then GONE=0; else GONE=$((GONE+1)); fi
  [ "$GONE" -lt 6 ] || { echo "[rig-host] container $NAME is gone and wrote no exit code" >&2; CODE=2; }
  [ $(( $(date +%s) - START )) -lt $((MAXMIN * 60)) ] || { echo "[rig-host] run exceeded ${MAXMIN} min" >&2; stop; CODE=2; }
done
trap - INT TERM
# Copy-back: the local run dir is created here with a non-recursive mkdir, which fails if anything already has the id (another run,
# or one that took it while this one ran): then nothing is written into it, the host run dir is kept, exit 2. The run's files are
# copied into the new dir and its seal (run-complete.json) comes last, so an interrupted copy leaves an unsealed dir (INVALID).
if ! rs "test -d $RD/out/$ID"; then echo "[rig-host] the run left no evidence dir out/$ID on the host (host exit $CODE); run dir kept: $RD" >&2; exit 2; fi
mkdir "$OUT/$ID" 2>/dev/null || { echo "[rig-host] refused: cannot create $OUT/$ID ($([ -e "$OUT/$ID" ] && echo "already exists: another run has id $ID" || echo "mkdir failed")); nothing written into it; this run (host exit $CODE) is kept on the host: $RD" >&2; exit 2; }
rsync -a --exclude="/$SEAL" -e "ssh $SSHO" "$HOST:$RD/out/$ID/" "$OUT/$ID/" || { echo "[rig-host] could not copy the evidence back; run dir kept: $RD" >&2; exit 2; }
# exit 0/1 means the rig sealed its verdict, so the seal must come back; a 2 may or may not be sealed (a run that failed early is not)
case "$CODE" in 0|1) WANT=1 ;; *) WANT=$(rs "test -f $RD/out/$ID/$SEAL" && echo 1 || echo "") ;; esac
if [ -n "$WANT" ]; then
  rsync -a -e "ssh $SSHO" "$HOST:$RD/out/$ID/$SEAL" "$OUT/$ID/$SEAL" || { echo "[rig-host] could not copy the seal of run $ID back (host exit $CODE); local copy unsealed, run dir kept: $RD" >&2; exit 2; }
fi
rs "tail -n 40 $RD/docker.log" > "$OUT/$ID.rig-host-docker.log" 2>&1 || true
echo "$CODE" > "$OUT/$ID.rig-host-exit.txt"
if [ -z "${RIG_HOST_KEEP:-}" ]; then cleanup; else rs "rm -rf ${RD:?}/src"; [ -n "${RIG_KEEP_PROFILE:-}" ] || rs "rm -rf ${RD:?}/profile"; fi
echo "[rig-host] done exit $CODE, evidence in $OUT/$ID (replay: node scripts/rig-realsize/verdict.mjs $OUT $ID)" >&2
exit "$CODE"
