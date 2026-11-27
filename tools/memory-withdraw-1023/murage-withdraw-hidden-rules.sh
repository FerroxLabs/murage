#!/bin/bash
# q1023-cleanopus: one-time memory clean-up for ONE Murage install, with Murage QUIT. Needs only macOS's own /usr/bin/sqlite3 (no node/npm).
# Owner of this script and of murage-withdraw-hidden-rules.sql: q1023-cleanopus. Owner of the app modules whose effect it reproduces:
# the revoke marker (revoke-marker.ts undoStep / pruneFinished / clearOrphanPending). Rulings: MAIN.
#
#   bash murage-withdraw-hidden-rules.sh [data-dir]            (default data dir: ~/.murage)
#   bash murage-withdraw-hidden-rules.sh --rollback [data-dir] (puts the backup this script made back)
#
# What it does: withdraws every open memory revoke job and every pending "checking" window (memory_deny_pending/_scope), so owner turns
# stop reading "Memory wasn't ready". Content those revokes would still have hidden may show in memory again (owner waiver). It keeps
# every message, record, source and the deleted-conversation rules (memory_deny) and their receipts. Prints counts only.
set -euo pipefail
SQLITE=${SQLITE:-/usr/bin/sqlite3}
HERE=$(cd "$(dirname "$0")" && pwd)
SQL="$HERE/murage-withdraw-hidden-rules.sql"
mode=run
if [ "${1:-}" = "--rollback" ]; then mode=rollback; shift; fi
DATA=${1:-$HOME/.murage}
DB="$DATA/messages.db"
BK="$DATA/messages.db.before-withdraw"
die() { echo "STOP: $*" >&2; exit 3; }

running() { pgrep -x Murage >/dev/null 2>&1; }
# restore, inside ONE locked sqlite3 session (-bail, exclusive lock: an app started meanwhile cannot open the store): the backup is
# checked first, the store as it is now is saved under the name $1, then the backup is copied INTO the live file in one transaction
# (.restore). messages.db is never missing or half-written: a stop at any point leaves it as it was.
restore_from_backup() {
  local keep="$1" out rc
  [ ! -e "$keep" ] || return 1
  set +e
  out=$("$SQLITE" -bail "$DB" 2>&1 <<SQLEOF
PRAGMA locking_mode=EXCLUSIVE;
BEGIN IMMEDIATE;
COMMIT;
ATTACH '$BK' AS bk;
SELECT 'bkcheck|'||CASE WHEN (SELECT group_concat(quick_check) FROM bk.pragma_quick_check)='ok' THEN 'ok' ELSE json('the backup did not check out') END;
DETACH bk;
.backup '$keep'
.restore '$BK'
PRAGMA wal_checkpoint(TRUNCATE);
PRAGMA quick_check;
SQLEOF
)
  rc=$?
  set -e
  [ "$rc" = 0 ] && [ "$(printf '%s\n' "$out" | tail -1)" = ok ]
}

[ -x "$SQLITE" ] || die "no sqlite3 at $SQLITE"
[ -f "$DB" ] || die "no Murage store at $DB"
# Murage must be fully quit (menu Murage > Quit); never run this while it is open. During the run the store is also held with an
# exclusive lock, so an app started meanwhile cannot open it (it reports the store busy; nothing is written by both).
if running; then die "Murage is running: quit it (Murage > Quit), then run this again"; fi
# one run of this script at a time (mkdir is atomic): a second run can neither take nor remove the first run's backup
RUNLOCK="$DATA/.murage-withdraw-running"
mkdir "$RUNLOCK" 2>/dev/null || die "another run of this script is going on (or one was cut off: if none is running, remove $RUNLOCK and run again)"
trap 'rm -f -- "${RUNLOCK:?}/session-errors.txt" "${RUNLOCK:?}/kept.sql" "${RUNLOCK:?}/kept.link" "${RUNLOCK:?}/fileio-probe" "${RUNLOCK:?}/fileio-link"; rmdir "$RUNLOCK" 2>/dev/null || true' EXIT
# a kept copy never overwrites an earlier one
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

if [ "$mode" = rollback ]; then
  [ -f "$BK" ] || die "no backup at $BK"
  echo "Rollback puts back the store as it was BEFORE the clean-up: anything written since (new messages included) goes with the cleaned store."
  if [ -t 0 ]; then printf 'Type yes to roll back: '; read -r answer; [ "$answer" = yes ] || die "not rolled back"; fi
  if ! restore_from_backup "$DB.after-withdraw-$STAMP"; then
    # q1023-wdfix: "unchanged" only when the session stopped before it saved the store as it was (and so before its .restore); an error
    # after that (the checkpoint after .restore included) may leave the store already rolled back: never reported unchanged
    [ -e "$DB.after-withdraw-$STAMP" ] || die "the store could not be locked or the backup did not check out; the store is unchanged"
    die "the rollback stopped after it began (the store may already be the backup; the store as it was is kept as $DB.after-withdraw-$STAMP): do NOT start Murage; run: bash \"$0\" --rollback \"$DATA\" again"
  fi
  echo "ROLLED BACK: $DB is the backup again (the store as it was is kept as $DB.after-withdraw-$STAMP; delete it when you are happy)"
  exit 0
fi

[ -f "$SQL" ] || die "murage-withdraw-hidden-rules.sql must sit next to this script"
[ ! -e "$BK" ] || die "a backup already exists at $BK (this clean-up already ran?). Move it away first if you really want to run again"
need=$(( $(wc -c < "$DB") * 2 / 1024 ))
free=$(df -k "$DATA" | awk 'NR==2{print $4}')
[ "$free" -gt "$need" ] || die "not enough free disk for the backup (need about $((need/1048576)) GB free)"

# counts that must not change (real records, deleted-conversation rules and their receipts), and the two that must end at 0
COUNTS="SELECT 'counts|'||(SELECT count(*) FROM main.messages)||' '||(SELECT count(*) FROM main.memory_records)||' '||(SELECT count(*) FROM main.memory_sources)||' '||(SELECT count(*) FROM main.memory_tombstones)||' '||(SELECT count(*) FROM main.memory_evidence)||' '||(SELECT count(*) FROM main.memory_deny)||' '||(SELECT count(*) FROM main.memory_deny_line WHERE lsn=-9007199254740991 AND reason='delete-conversation');
SELECT 'open|'||(SELECT count(*) FROM main.memory_revoke_jobs WHERE state NOT IN ('done','undone'))||' '||((SELECT count(*) FROM main.memory_deny_pending)+(SELECT count(*) FROM main.memory_deny_pending_scope));"

# q1023-cleanfix: the checks after the clean-up's commit, and the restore when they fail, run in this SAME session under the same
# exclusive lock: there is no moment between the commit and the restore at which an app started meanwhile can open the store. The
# restore keeps the attempt as $FAILED, then .restore copies the checked backup INTO the live file in one transaction.
COUNTS_EXPR="(SELECT count(*) FROM main.messages)||' '||(SELECT count(*) FROM main.memory_records)||' '||(SELECT count(*) FROM main.memory_sources)||' '||(SELECT count(*) FROM main.memory_tombstones)||' '||(SELECT count(*) FROM main.memory_evidence)||' '||(SELECT count(*) FROM main.memory_deny)||' '||(SELECT count(*) FROM main.memory_deny_line WHERE lsn=-9007199254740991 AND reason='delete-conversation')"
FAILED="$DB.failed-withdraw-$STAMP"
# whether the store IS the checked backup again (a restore is reported only when this reads 1): every table the clean-up writes, row for
# row both ways, and the counts above; never inferred from quick_check alone
SAME_EXPR="($COUNTS_EXPR)=(${COUNTS_EXPR//main./bk.})"
for t in memory_revoke_jobs memory_revoke_frontier memory_deny_line memory_deny_range memory_deny_session memory_deny_memory memory_deny_pending \
  memory_deny_pending_scope memory_revoke_reached memory_session_change_log memory_lineage_lsn_meta; do
  SAME_EXPR="$SAME_EXPR AND NOT EXISTS (SELECT * FROM main.$t EXCEPT SELECT * FROM bk.$t) AND NOT EXISTS (SELECT * FROM bk.$t EXCEPT SELECT * FROM main.$t)"
done
# q1023-wdfix: an error in ANY statement after the commit (the checkpoint, a check, the decision itself) must restore the backup in this
# same locked session and never leave the run kept. sqlite3 keeps going after such an error (.bail off), so the session reads its own
# stderr ($ERRF, unbuffered) and decides "kept" only while it is empty and every check passes. The restore is written INLINE after the
# decision. Only a kept decision ends the session before it, and no file written while the session runs can drive that: $KEPTF (".bail on"
# + a statement that fails on purpose) is written and verified by this script BEFORE the session starts (a failure there changes
# nothing), and a kept decision only creates the symlink $KEPTL to it (one atomic call: it exists whole or not at all). The session then
# reads $KEPTL: missing (the decision did not pass, or the link could not be made, a full disk included) it is one ignored error and the
# restore runs; present, sqlite3 reads ".bail on" and stops at the statement that fails, before the restore.
ERRF="$RUNLOCK/session-errors.txt"
KEPTF="$RUNLOCK/kept.sql"
KEPTL="$RUNLOCK/kept.link"
# the session's own readfile/writefile (built into the sqlite3 shell, symlinks included) must work, or the run does not start
probe=$("$SQLITE" :memory: "SELECT writefile('$RUNLOCK/fileio-probe','x')=1 AND CAST(readfile('$RUNLOCK/fileio-probe') AS TEXT)='x' AND length(readfile('$RUNLOCK/fileio-probe'))=1; SELECT coalesce(writefile('$RUNLOCK/fileio-link','$RUNLOCK/fileio-probe',41471),'');" 2>/dev/null || true)
[ "$probe" = 1 ] && [ "$(cat "$RUNLOCK/fileio-link" 2>/dev/null)" = x ] || die "this sqlite3 cannot read and write files (readfile/writefile/symlink): nothing was changed"
printf '%s\n%s\n' '.bail on' 'SELECT abs(-9223372036854775807-1) AS kept_stop;' > "$KEPTF" || die "could not write $KEPTF: nothing was changed"
[ "$(cat "$KEPTF")" = ".bail on
SELECT abs(-9223372036854775807-1) AS kept_stop;" ] || die "$KEPTF was not written whole (disk full?): nothing was changed"
echo "1/2 backup (checked) + clean-up in ONE locked sqlite3 session (a few minutes for a large store) -> backup $BK"
# -bail: the first failing statement stops the session; the open transaction is rolled back and nothing after it runs
set +e
out=$("$SQLITE" -bail "$DB" 2>"$ERRF" <<SQLEOF
PRAGMA locking_mode=EXCLUSIVE;
BEGIN IMMEDIATE;
COMMIT;
$COUNTS
PRAGMA temp_store=MEMORY;
CREATE TEMP TABLE w_before AS SELECT ($COUNTS_EXPR) AS c;
.backup '$BK'
ATTACH '$BK' AS bk;
SELECT 'bkcheck|'||CASE WHEN (SELECT group_concat(quick_check) FROM bk.pragma_quick_check)='ok' THEN 'ok' ELSE json('the backup did not check out') END;
DETACH bk;
.read '$SQL'
$COUNTS
SELECT 'decision|kept'||coalesce(writefile('$KEPTL','$KEPTF',41471),'')
  WHERE (SELECT count(*) FROM main.memory_revoke_jobs WHERE state NOT IN ('done','undone'))=0
    AND (SELECT count(*) FROM main.memory_deny_pending)+(SELECT count(*) FROM main.memory_deny_pending_scope)=0
    AND (SELECT c FROM temp.w_before)=($COUNTS_EXPR)
    AND (SELECT group_concat(quick_check) FROM main.pragma_quick_check)='ok'
    AND length(readfile('$ERRF'))=0;
.read '$KEPTL'
SELECT 'decision|restore';
.backup '$FAILED'
.restore '$BK'
PRAGMA wal_checkpoint(TRUNCATE);
ATTACH '$BK' AS bk;
SELECT 'same|'||CASE WHEN $SAME_EXPR AND (SELECT group_concat(quick_check) FROM main.pragma_quick_check)='ok' THEN 1 ELSE 0 END;
DETACH bk;
SQLEOF
)
rc=$?
errs=$(cat "$ERRF" 2>/dev/null || true)
# a kept session ends at $KEPTF's kept_stop on purpose (sqlite3 exit 1, its one integer-overflow line, or no line when a full disk lost it:
# the kept decision is only printed after every check passed and nothing runs after it but the stop); anything else on stderr is a real error
kept_stop_only=0
if printf '%s\n' "$out" | grep -qx 'decision|kept' && ! printf '%s\n' "$out" | grep -qx 'decision|restore' && [ "$rc" = 1 ] \
  && { [ -z "$errs" ] || { [ "$(printf '%s\n' "$errs" | grep -c .)" = 1 ] && printf '%s\n' "$errs" | grep -q 'integer overflow'; }; }; then kept_stop_only=1; rc=0; errs=; fi
[ -z "$errs" ] || out="$out
$errs"
set -e
before_counts=$(printf '%s\n' "$out" | awk -F'|' '$1=="counts"{print $2}' | sed -n 1p)
after_counts=$(printf '%s\n' "$out" | awk -F'|' '$1=="counts"{print $2}' | sed -n 2p)
before_open=$(printf '%s\n' "$out" | awk -F'|' '$1=="open"{print $2}' | sed -n 1p)
after_open=$(printf '%s\n' "$out" | awk -F'|' '$1=="open"{print $2}' | sed -n 2p)
chk=$(printf '%s\n' "$out" | grep -x -c ok || true)
echo "BEFORE  open_jobs+pending: ${before_open:-?}   messages records sources tombstones evidence deny_rules receipts: ${before_counts:-?}"
echo "AFTER   open_jobs+pending: ${after_open:-?}   messages records sources tombstones evidence deny_rules receipts: ${after_counts:-?}"
bk_ok=$(printf '%s\n' "$out" | awk -F'|' '$1=="bkcheck"{print $2}')
if [ "$bk_ok" != ok ]; then
  # the session stopped before the clean-up began (lock, backup or its check failed): the store is unchanged
  rm -f -- "${BK:?}"
  die "could not lock, back up or check the backup (is Murage starting? enough disk?): nothing was changed (sqlite3 exit $rc)"
fi
decision=$(printf '%s\n' "$out" | awk -F'|' '$1=="decision"{print $2}' | tail -1)
same=$(printf '%s\n' "$out" | awk -F'|' '$1=="same"{print $2}' | tail -1)
committed=$(printf '%s\n' "$out" | awk -F'|' '$1=="committed"{print $2}' | tail -1)
case "$decision" in
  restore)
    [ "$same" = 1 ] || die "the clean-up did not pass its checks and the restore in the same session did not give back the checked backup: do NOT start Murage; run: bash \"$0\" --rollback \"$DATA\" (the checked backup is at $BK)"
    die "the clean-up did not pass its checks (sqlite3 exit $rc, open=${after_open:-?}): the checked backup was restored in the same locked session (the attempt is kept as $FAILED)" ;;
  kept) ;;
  *)
    # the session ended before its checks. Whether its COMMIT happened is never inferred from a missing marker (sqlite3 can stop between
    # the COMMIT and the marker): the store itself is compared with the checked backup (read-only, nothing is restored outside the locked
    # session; the same row-for-row comparison of every table the clean-up writes, and the counts) and "unchanged" is said only when equal.
    now=$("$SQLITE" -readonly "$DB" "ATTACH '$BK' AS bk; SELECT 'same|'||CASE WHEN $SAME_EXPR THEN 1 ELSE 0 END;" 2>/dev/null || true)
    if [ "$committed" != 1 ] && [ "$now" = "same|1" ]; then
      die "the clean-up stopped before its commit (sqlite3 exit $rc): it was rolled back as its session closed, the store is unchanged; the checked backup is at $BK"
    fi
    die "the clean-up stopped before its checks and the store is not as it was (sqlite3 exit $rc): do NOT start Murage; run: bash \"$0\" --rollback \"$DATA\" (the checked backup is at $BK)" ;;
esac
if [ "$rc" != 0 ] || [ "$after_open" != "0 0" ] || [ "$chk" -lt 1 ] || [ "$before_counts" != "$after_counts" ]; then
  die "the clean-up's checks passed in its session but its output does not agree (sqlite3 exit $rc, open=${after_open:-?}, quick_check ok lines=$chk): do NOT start Murage; run: bash \"$0\" --rollback \"$DATA\" (the checked backup is at $BK)"
fi
if running; then echo "WARNING: Murage was started during the clean-up; it could not open the store while it ran. Quit and restart it." >&2; fi

echo "2/2 done"
echo "OK: start Murage now. If memory is still off, turn it on in Settings > Memory."
echo "To undo: quit Murage, then: bash \"$0\" --rollback \"$DATA\""
