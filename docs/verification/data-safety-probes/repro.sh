#!/usr/bin/env bash
# repro.sh <label> <checkout> <command...>
# Runs one candidate (a test runner, a script, a spec load) against a checkout
# with:
#   - HOME/USERPROFILE = a fresh fake home holding a fake .murage with markers
#   - MURAGE_E2E_DATA_DIR / MURAGE_DATA_DIR / MURAGE_COMPANION_DIR and the
#     lane port variables unset (the "inherited or missing variable" case)
#   - deny-data-dir.sh denying every write under the account's real data dirs
# and reports (a) missing markers in the fake home, (b) denied writes to the
# real data dir surfaced as EPERM / "Operation not permitted" in the log.
# Homes and logs land under $MURAGE_REPRO_SCRATCH (default: a mkdtemp).
set -u
here=$(cd "$(dirname "$0")" && pwd)
LABEL=$1; CWD=$2; shift 2
ROOT=${MURAGE_REPRO_SCRATCH:-$(mktemp -d -t murage-data-safety-repro)}
H=$ROOT/repro-homes/$LABEL
mkdir -p "$ROOT/repro-homes" "$ROOT/repro-logs"
bash "$here/mkhome.sh" "$H" >/dev/null
LOG=$ROOT/repro-logs/$LABEL.log
( cd "$CWD" && env -u MURAGE_E2E_DATA_DIR -u MURAGE_DATA_DIR -u MURAGE_COMPANION_DIR -u MURAGE_E2E_PORT -u MURAGE_E2E_UI_PORT \
    HOME="$H" USERPROFILE="$H" "$here/deny-data-dir.sh" "$@" ) > "$LOG" 2>&1
STATUS=$?
echo "== $LABEL (exit $STATUS, $(wc -l < "$LOG" | tr -d ' ') log lines, log $LOG)"
bash "$here/checkhome.sh" "$H" "$LABEL"
echo "   denied-write mentions in log: $(grep -c -E 'EPERM|Operation not permitted' "$LOG")"
grep -n -E 'EPERM|Operation not permitted' "$LOG" | head -5 | sed 's/^/   /'
