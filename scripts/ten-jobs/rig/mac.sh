#!/bin/bash
# Copyright 2026 Ferrox Labs
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# macOS leg of the ten-jobs gate. Needs a logged-in GUI (Aqua) session: on a disposable EC2 Mac that is
# ec2-user with console auto-login, and the run is started INSIDE that session through launchd, because an
# ssh shell has no window server (Electron starts but never opens a window).
#   bash mac.sh launch <app path .app> <40-hex build commit> <mouse|keyboard> [jobs]   # from ssh: submits a gui/<uid> job
#   bash mac.sh run    <app path .app> <40-hex build commit> <mouse|keyboard> [jobs]   # what that job runs
# Log $TJ/runs/<label>/run.out, marker run.done (holds run.mjs's exit code). No deletes, no pattern kills.
# Env: TJ (default ~/gate/tj), TJ_NODE (default: node on PATH), TJ_PW (default ~/gate/pw), TEN_JOBS_FLUX_KEY_FILE (default ~/.config/flux/fuigo.key).
set -u -o pipefail
CMD=${1:?launch or run}; APPDIR=${2:?.app path}; TREE=${3:?build commit}; MODE=${4:?mouse or keyboard}; JOBS=${5:-}
export PATH=/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/gate/npm/bin:/usr/bin:/bin:/usr/sbin:/sbin
TJ=${TJ:-$HOME/gate/tj}; PW=${TJ_PW:-$HOME/gate/pw}; NODE=${TJ_NODE:-$(command -v node)}
SRC=$(cd "$(dirname "$0")/.." && pwd); SELF="$SRC/rig/mac.sh"
EXE="$APPDIR/Contents/MacOS/Murage"
if [ "$CMD" = launch ]; then
  U=$(id -u); LBL=com.ferroxlabs.tenjobs.$(date -u +%H%M%S)
  launchctl print "gui/$U" > /dev/null 2>&1 || { echo "STOP: no GUI session for uid $U (log in on the console first)"; exit 2; }
  PL="$TJ/$LBL.plist"; mkdir -p "$TJ"
  /usr/libexec/PlistBuddy -c "Add :Label string $LBL" -c "Add :ProgramArguments array" -c "Add :ProgramArguments:0 string /bin/bash" \
    -c "Add :ProgramArguments:1 string $SELF" -c "Add :ProgramArguments:2 string run" -c "Add :ProgramArguments:3 string $APPDIR" \
    -c "Add :ProgramArguments:4 string $TREE" -c "Add :ProgramArguments:5 string $MODE" -c "Add :ProgramArguments:6 string ${JOBS:-all}" \
    -c "Add :RunAtLoad bool true" -c "Add :LimitLoadToSessionType string Aqua" "$PL" > /dev/null || exit 2
  launchctl bootstrap "gui/$U" "$PL" && echo "submitted $LBL; watch $TJ/runs/ for run.done"
  exit $?
fi
[ "$JOBS" = all ] && JOBS=""
LABEL=${TREE:0:12}-$MODE-$(date -u +%Y%m%dT%H%M%SZ); R=$TJ/runs/$LABEL
mkdir -p "$R" || exit 2
L() { echo "=== $(date -u +%FT%TZ) $*" >> "$R/run.out"; }
[ -x "$EXE" ] || { L "STOP no exe $EXE"; echo 2 > "$R/run.done"; exit 2; }
L "exe $(shasum -a 256 "$EXE" | cut -c1-16) tree $TREE mode $MODE jobs ${JOBS:-all}; free $(df -h / | tail -1 | awk '{print $4}')"
"$NODE" "$SRC/run.mjs" --exe "$EXE" --root "$R/root" --pw "$PW" --tree "$TREE" --mode "$MODE" ${JOBS:+--jobs "$JOBS"} --out "$R/verdict.json" >> "$R/run.out" 2>&1
RC=$?
L "run.mjs exit $RC: $(grep -E '^(JOB|VERDICT) ' "$R/run.out" | tr '\n' ' ' | cut -c1-1500)"
echo "$RC" > "$R/run.done"
