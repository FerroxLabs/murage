#!/bin/bash
# Copyright 2026 Ferrox Labs
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Smoothness gate, real-engine leg (SMOOTHNESS-GATE-105 section 5). Runs ON the real-engine gate box as the engine user
# (muragegate), with the engines signed in under that user's own home. No container (the sign-ins live in the home), so:
#   - the tree under test is at $R/src (with node_modules), node 24 at $R/node/bin/node;
#   - the data dir is a FRESH empty $R/data/murage (Sean's data never leaves the real-data box), so S5 (long thread) and
#     S6 (a) (old conversation delete) have nothing to work on and say so;
#   - Fuigo's key is read from SMOOTH_FUIGO_KEY_FILE by smooth.mjs into the server env only;
#   - one run at a time (a 4-core box). Results in $R/out; the log $R/gate.log ends with REALEXIT=<gate exit>.
#   real-smooth.sh <label>        env: SMOOTH_REAL_FAST, SMOOTH_REAL_SCRIPTED, SMOOTH_REAL_CLAUDE (engine instance per role),
#                                      SMOOTH_ENGINES_NOT_RUN, SMOOTH_FUIGO_KEY_FILE, SMOOTH_SCENARIOS, SMOOTH_IDLE_S,
#                                      SMOOTH_APP_DIR (rig v5.8: inherited unpacked/installed app path; unset uses source)
set -u
umask 077
label=${1:?label}
[[ "$label" =~ ^[a-z0-9-]+$ ]] || { echo "bad label"; exit 2; }
R=${SMOOTH_REAL_DIR:-$HOME/smooth-real}
R=$(realpath -- "$R") || exit 4
lane=$(printf "%s" "$R" | sha256sum) || exit 4; lane=real-${lane:0:16}
[ "$(id -un)" != root ] || { echo "run as the engine user, not root"; exit 2; }
[ -d "$R/src/node_modules/.pnpm" ] || { echo "no tree with node_modules at $R/src"; exit 3; }
[ -x "$R/node/bin/node" ] || { echo "no node 24 at $R/node/bin/node"; exit 4; }
# every run's server log is kept: $SMOOTH_LOGS/<run-id>/ (default ~/smoothness/logs), copied before any working copy is deleted
LOGS=${SMOOTH_LOGS:-$HOME/smoothness/logs}
KEEP="$R/src/scripts/smoothness/keep-logs.sh"
O=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
RUN_ID="$label-$(date -u +%Y%m%dT%H%M%SZ)-$O"
# Preserve evidence before checkout/lock setup can fail, using Node before PATH setup.
# This only copies evidence; clearing it and starting a run require lane ownership below.
# an earlier run that never reached its own keep step (killed, box rebooted): its out dir is kept before it is cleared
has_evidence=0
for file in "$R/out"/server-*.log "$R/out"/failed-turns-*.jsonl; do [ ! -e "$file" ] || has_evidence=1; done
if [ "$has_evidence" = 1 ]; then bash "$KEEP" "$R/out" "$LOGS" "orphan-$RUN_ID" "$R/node/bin/node" || { echo "could not keep the earlier run's log; refusing to clear $R/out"; exit 3; }; fi
# The stager also excludes hz label locks for this canonical directory.
H=${SMOOTH_HOST_ROOT:-$HOME/smoothness}
STAGER="$R/src/scripts/smoothness/stage-keeper.sh"
P=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
if [ -f "$R/src/.smooth-sha" ]; then sha=$(cat "$R/src/.smooth-sha");
else sha=$(git -C "$R/src" rev-parse --short=12 HEAD) || exit 4; fi
export TREE_SHA="$sha" # the gate header and results.json carry the build sha (was "tree ?")
khash=$(for name in keep-logs.sh keep-logs.mjs scrub-accounting.mjs; do
  digest=$(sha256sum "$R/src/scripts/smoothness/$name") || exit 4
  printf '%s/%s\n' "$name" "${digest%% *}"
done | sha256sum); khash=${khash%% *}
release_lock() {
  local rc=$?
  trap - EXIT
  exec 9>&-
  SMOOTH_OWNER="$O" SMOOTH_RELEASE_IF_OWNED=1 bash "$STAGER" "$R" "$H" "$lane" "$khash" "$R/src" "$sha" release || { [ "$rc" -ne 0 ] || rc=4; }
  rm -f -- "$H/smoothness/locks/owners/$O"
  exit "$rc"
}
trap release_lock EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
# The cleanup traps exist before the marker does, so a signal in this window cannot leave it behind.
mkdir -p "$H/smoothness/locks/owners" || exit 4
# Written before the child can acquire, independent of the ready-line handoff.
printf '%s\n' "$$" > "$H/smoothness/locks/owners/$O" || exit 4
ready=$(SMOOTH_REAL_OWNER=1 SMOOTH_OWNER="$O" SMOOTH_TXN="$P" bash "$STAGER" "$R" "$H" "$lane" "$khash" "$R/src" "$sha" acquire) || exit $?
[ "$ready" = "keeper-ready:$sha:$khash:$O" ] || exit 4
# A host process uses PID and start ticks in place of the container ID.
# A host process uses PID and start ticks in place of the container ID. Linux: start ticks from /proc. macOS has no /proc:
# the process start time in epoch seconds from ps lstart, written and parsed in UTC so no DST fold (the gate Mac, rig rev 6.6/6.7).
if [ -r "/proc/$$/stat" ]; then start=$(sed 's/.*) //' "/proc/$$/stat" | awk '{print $20}')
else start=$(TZ=UTC LC_ALL=C date -j -f '%a %b %e %T %Y' "$(TZ=UTC LC_ALL=C ps -o lstart= -p $$ | sed 's/ *$//')" +%s); fi
[[ "$start" =~ ^[0-9]+$ ]] || exit 4
exec 9>>"$H/smoothness/locks/$lane.flock"; flock -x 9 || exit 4
read -r version phase txn active rev utc < "$H/smoothness/locks/$lane.d/owner" || exit 4
[ "$active" = "$O" ] && [ "$phase" = active ] || exit 4
printf '%s/pid-%s-%s/%s\n' "$RUN_ID" "$$" "$start" "$O" > "$R/.run-id-$O" || exit 4
mv -- "$R/.run-id-$O" "$R/run.id" || exit 4
flock -u 9
exec 9>&-
export SMOOTH_CTL=${SMOOTH_CTL:-/tmp/smooth-ctl-real}
export SMOOTH_RUN_ID="$RUN_ID"
rm -rf -- "${R:?}/data" "${R:?}/out/"*; mkdir -p "$R/data/murage" "$R/out"
export PATH="$R/node/bin:$PATH"
cd "$R/src"
{
  echo "STEP run $(date +%T) label=$label engines=real"
  MURAGE_DATA_DIR="$R/data/murage" SMOOTH_ENGINES=real SMOOTH_WORK="$R/src" SMOOTH_OUT="$R/out" SMOOTH_LABEL="$label" \
    node scripts/smoothness/smooth.mjs
  RUNNER=$?
  echo "runner exit $RUNNER"
  node scripts/smoothness/smooth-gate.mjs "$R/out/results-$label.json" --md "$R/out/gate-$label.md"
  GATE=$?
  if [ "$RUNNER" -ne 0 ]; then GATE=$RUNNER; fi
  prompts="${SMOOTH_CTL}/prompts"
  if [ "$SMOOTH_CTL" != /tmp/smooth-ctl-real ]; then
    # The single keeper branch below must never reach the legacy default cleanup.
    custom_prompts=1
  else custom_prompts=0; fi
  if bash "$KEEP" "$R/out" "$LOGS" "$RUN_ID" "$R/node/bin/node"; then rm -rf -- "$prompts" "${R:?}/data"
    if [ "$custom_prompts" = 0 ]; then rm -rf -- /tmp/smooth-ctl-real/prompts "${R:?}/data"; else
      : # Custom prompts were removed above; leave the default path alone.
    fi
  else echo "log not kept: the data copy stays at $R/data"; fi
  echo "RUNID=$RUN_ID"
  echo "REALEXIT=$GATE"
} > "$R/gate.log" 2>&1
cp -p "$R/gate.log" "$LOGS/$RUN_ID/gate.log" || true
exit "$GATE"
