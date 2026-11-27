#!/usr/bin/env bash
# witness-wrapper.sh <scratch-dir> [row]   (owner: q1023-cleanfix; the wrapper under test: murage-withdraw-hidden-rules.sh, q1023-cleanopus)
# Runs the wrapper itself (its production entry point: `bash murage-withdraw-hidden-rules.sh <data-dir>`) on a small store, with a failure
# injected into the clean-up and an app that opens the store the moment the wrapper's sqlite3 session ends (SQLITE= a shim that starts it).
#   W-RESTORE-LOCKED  the clean-up commits but fails its checks (a trigger adds a record): the store must be the backup again, restored
#                     before any other opener could take the store, and the attempt kept.
#   W-PRECOMMIT       an error before the commit: the store must be unchanged.
#   W-POSTCOMMIT-ERROR an error in any statement after the commit (the checkpoint first): the same as W-RESTORE-LOCKED (q1023-wdfix).
#   W-KEPT-WRITEFAIL  the disk fills while the session writes anything under its run lock dir (a short write at each length, then a failed
#                     symlink): the run is either fully kept or fully restored in the same locked session, never stopped in between (q1023-wdfix).
#   W-ROLLBACK-ERROR  --rollback whose checkpoint after its .restore fails: the report never says the store is unchanged (q1023-wdfix).
#   W-SUCCESS         no failure: no job open, no pending window, every real row kept; exit 0.
# Needs bash and sqlite3 only. Counts and digests only.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); SELF="tools/memory-withdraw-1023/witness-wrapper.sh"
SCRATCH=${1:?scratch dir}; ONLY=${2:-all}; REAL=${REAL_SQLITE:-$(command -v sqlite3)}
fail=0; mkdir -p "$SCRATCH"; SHIM_ENV=
assert_eq() { # assert_eq <name> <actual> <expected>
  if [ "$2" != "$3" ]; then echo "AssertionError at $SELF:${BASH_LINENO[0]} $1: expected [$3] got [$2]"; fail=1; else echo "ok $1"; fi
}
digest() { bash "$HERE/digest.sh" "$1" | sha256sum | cut -c1-16; }
store() { # store <dir> <injection>: open revoke jobs with pending windows, real rows, a deletion receipt
  mkdir -p "$1"; "$REAL" "$1/messages.db" <<SQL
PRAGMA journal_mode=WAL;
CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(thread_id,id));
CREATE TABLE memory_records(id TEXT,version INTEGER,PRIMARY KEY(id,version));
CREATE TABLE memory_sources(id TEXT PRIMARY KEY);
CREATE TABLE memory_tombstones(id TEXT PRIMARY KEY);
CREATE TABLE memory_evidence(record_id TEXT,source_id TEXT);
CREATE TABLE memory_deny(kind TEXT,id TEXT,PRIMARY KEY(kind,id));
CREATE TABLE memory_revoke_jobs(revoke_id INTEGER PRIMARY KEY,state TEXT,phase TEXT,cursor TEXT);
CREATE TABLE memory_revoke_frontier(revoke_id INTEGER,thread_id TEXT);
CREATE TABLE memory_deny_line(thread_id TEXT,lsn INTEGER,revoke_id INTEGER,mark_lsn INTEGER,reason TEXT);
CREATE TABLE memory_deny_range(revoke_id INTEGER);
CREATE TABLE memory_deny_session(revoke_id INTEGER);
CREATE TABLE memory_deny_memory(revoke_id INTEGER);
CREATE TABLE memory_deny_pending(thread_id TEXT,since_lsn INTEGER,revoke_id INTEGER);
CREATE TABLE memory_deny_pending_scope(scope_id TEXT,since_lsn INTEGER,revoke_id INTEGER);
CREATE TABLE memory_revoke_reached(revoke_id INTEGER,thread_id TEXT);
CREATE TABLE memory_session_change_log(id TEXT PRIMARY KEY);
CREATE TABLE memory_lineage_lsn_meta(key TEXT PRIMARY KEY,value INTEGER);
INSERT INTO memory_lineage_lsn_meta VALUES('deny_generation',7);
INSERT INTO messages VALUES('t1','m1',1),('t1','m2',2),('t2','m3',3);
INSERT INTO memory_records VALUES('r1',1); INSERT INTO memory_sources VALUES('s1'); INSERT INTO memory_tombstones VALUES('tb1');
INSERT INTO memory_evidence VALUES('r1','s1'); INSERT INTO memory_deny VALUES('thread','tdel');
INSERT INTO memory_revoke_jobs VALUES(1,'done','done','{}'),(2,'active','mark','{}'),(3,'active','flow','{}'),(4,'folded','mark','{}');
INSERT INTO memory_revoke_frontier VALUES(2,'t1'),(3,'t2');
INSERT INTO memory_deny_line VALUES('tdel',-9007199254740991,2,0,'delete-conversation'),('t1',10,3,10,'line');
INSERT INTO memory_deny_pending VALUES('t1',5,2),('t2',6,3),('t9',1,99);
INSERT INTO memory_deny_pending_scope VALUES('s-room',4,3);
$2
PRAGMA wal_checkpoint(TRUNCATE);
SQL
}
# the shim: the real sqlite3, then (once the wrapper's own session has ended) an app that opens the store and holds it a few seconds (only after a
# session on the store itself: a probe on :memory: does not count)
shim() { # shim <file> <data-dir>
  cat > "$1" <<SH
#!/usr/bin/env bash
env $SHIM_ENV "$REAL" "\$@"; rc=\$?
case " \$* " in *" $2/messages.db "*) store_session=1 ;; *) store_session=0 ;; esac
if [ "\$store_session" = 1 ] && [ ! -e "$2/.app-started" ]; then
  : > "$2/.app-started"
  ( { echo "BEGIN IMMEDIATE;"; echo "SELECT 'app-saw|'||count(*) FROM memory_revoke_jobs WHERE state NOT IN ('done','undone');"; echo ".shell touch '$2/.app-holding'"; sleep 4; echo "COMMIT;"; } | "$REAL" "$2/messages.db" > "$2/.app.log" 2>&1 ) > /dev/null 2>&1 &
  for i in \$(seq 1 50); do [ -e "$2/.app-holding" ] && break; sleep 0.1; done
fi
exit \$rc
SH
  chmod +x "$1"
}
run() { # run <row> <injection> -> sets out, code, dir
  dir="$SCRATCH/$1"; rm -rf -- "${dir:?}"; store "$dir" "$2"
  snap=$(digest "$dir/messages.db"); shim "$SCRATCH/$1.shim" "$dir"
  out=$(SQLITE="$SCRATCH/$1.shim" bash "$HERE/murage-withdraw-hidden-rules.sh" "$dir" 2>&1 < /dev/null); code=$?
  assert_eq "$1 the app opened the store as the session ended" "$([ -e "$dir/.app-holding" ] && echo yes)" "yes"
  sleep 4.5
  echo "$1 exit=$code"; printf '%s\n' "$out" | grep -E '^(STOP|OK|BEFORE|AFTER|the clean-up)' | cut -c1-200
}

if [ "$ONLY" = all ] || [ "$ONLY" = W-RESTORE-LOCKED ]; then
  run W-RESTORE-LOCKED "CREATE TRIGGER inject AFTER UPDATE ON memory_revoke_jobs BEGIN INSERT OR IGNORE INTO memory_records VALUES('injected',1); END;"
  assert_eq "W-RESTORE-LOCKED store is the backup again" "$(digest "$dir/messages.db")" "$snap"
  # the app that opened the store the moment the session ended saw the backup's 3 open jobs, never the failed clean-up's store
  assert_eq "W-RESTORE-LOCKED the app saw the restored store" "$(grep -o 'app-saw|[0-9]*' "$dir/.app.log")" "app-saw|3"
  # the report says "restored" only when the store is the backup again
  assert_eq "W-RESTORE-LOCKED the report is true" "$(printf '%s\n' "$out" | grep -c 'was restored in the same locked session')$([ "$(digest "$dir/messages.db")" = "$snap" ] && echo -same || echo -changed)" "1-same"
  assert_eq "W-RESTORE-LOCKED attempt kept" "$(ls "$dir" | grep -c '^messages.db.failed-withdraw-')" "1"
  assert_eq "W-RESTORE-LOCKED refused with exit 3" "$code" "3"
fi
if [ "$ONLY" = all ] || [ "$ONLY" = W-PRECOMMIT ]; then
  run W-PRECOMMIT "CREATE TRIGGER inject BEFORE UPDATE ON memory_revoke_jobs BEGIN SELECT RAISE(ABORT,'injected'); END;"
  assert_eq "W-PRECOMMIT store unchanged" "$(digest "$dir/messages.db")" "$snap"
  assert_eq "W-PRECOMMIT refused with exit 3" "$code" "3"
fi
if [ "$ONLY" = all ] || [ "$ONLY" = W-INTERRUPT ]; then
  # sqlite3 stops right after the clean-up's COMMIT, before anything else it prints (the run's copy of the .sql exits there with code 1)
  cp -a "$HERE" "$SCRATCH/interrupt-tools"; sed -i 's/^COMMIT;$/COMMIT;\n.exit 1/' "$SCRATCH/interrupt-tools/murage-withdraw-hidden-rules.sql"
  HERE_SAVED=$HERE; HERE="$SCRATCH/interrupt-tools"; run W-INTERRUPT ""; HERE=$HERE_SAVED
  # the report says "unchanged" only when the store is unchanged; here the clean-up committed: the report must say so
  assert_eq "W-INTERRUPT the report is true" "$(printf '%s\n' "$out" | grep -c 'the store is unchanged')$([ "$(digest "$dir/messages.db")" = "$snap" ] && echo -same || echo -changed)" "0-changed"
  assert_eq "W-INTERRUPT tells the owner not to start Murage" "$(printf '%s\n' "$out" | grep -c 'do NOT start Murage')" "1"
  # the same with no open job and no pending window left (the clean-up still prunes finished jobs and moves the deny generation)
  HERE="$SCRATCH/interrupt-tools"; run W-INTERRUPT-SETTLED "UPDATE memory_revoke_jobs SET state='done'; DELETE FROM memory_deny_pending; DELETE FROM memory_deny_pending_scope;"; HERE=$HERE_SAVED
  assert_eq "W-INTERRUPT-SETTLED the report is true" "$(printf '%s\n' "$out" | grep -c 'the store is unchanged')$([ "$(digest "$dir/messages.db")" = "$snap" ] && echo -same || echo -changed)" "0-changed"
fi
if [ "$ONLY" = all ] || [ "$ONLY" = W-POSTCOMMIT-ERROR ]; then
  # q1023-wdfix: one row per statement that runs after the clean-up's COMMIT (SITES.md in the lane dir), the checkpoint first. The run's
  # copy of the tools has that ONE statement replaced by one that fails (no such function at prepare; CKPT-RUNTIME: an integer overflow
  # while it runs; COUNTS-AFTER/OPEN-AFTER: the clean-up's own after-counts query reads a missing table); everything else is the
  # wrapper as shipped.
  # The wrapper must restore the checked backup in the SAME locked session and never report the run kept: the app that opens the
  # store the moment the session ends (the shim) must see the backup's 3 open jobs, never the half-done clean-up.
  rows=0
  while IFS='#' read -r site file from to; do
    rows=$((rows + 1)); printf -v from '%b' "$from"; printf -v to '%b' "$to"
    t="$SCRATCH/postcommit-$site-tools"; rm -rf -- "${t:?}"; cp -a "$HERE" "$t"
    src=$(cat "$t/$file"); rest=${src//"$from"/}; n=$(( (${#src} - ${#rest}) / ${#from} ))
    assert_eq "W-POSTCOMMIT-ERROR/$site the injected statement is found once" "$n" "1"
    printf '%s\n' "${src/"$from"/$to}" > "$t/$file"
    HERE_SAVED=$HERE; HERE=$t; run "W-POSTCOMMIT-ERROR-$site" ""; HERE=$HERE_SAVED
    assert_eq "W-POSTCOMMIT-ERROR/$site the racing app saw the backup, never the half-done clean-up" "$(grep -o 'app-saw|[0-9]*' "$dir/.app.log")" "app-saw|3"
    assert_eq "W-POSTCOMMIT-ERROR/$site store is the backup again" "$(digest "$dir/messages.db")" "$snap"
    assert_eq "W-POSTCOMMIT-ERROR/$site never reported kept, refused with exit 3" "$(printf '%s\n' "$out" | grep -c 'OK: start Murage')-$code" "0-3"
    assert_eq "W-POSTCOMMIT-ERROR/$site the report says restored" "$(printf '%s\n' "$out" | grep -c 'was restored in the same locked session')" "1"
  done <<'ROWS'
CKPT#murage-withdraw-hidden-rules.sql#PRAGMA wal_checkpoint(TRUNCATE);#SELECT injected_checkpoint_failure();
CKPT-RUNTIME#murage-withdraw-hidden-rules.sql#PRAGMA wal_checkpoint(TRUNCATE);#SELECT abs(-9223372036854775807-1);
COMMITTED#murage-withdraw-hidden-rules.sql#SELECT 'committed|1';#SELECT injected_failure();
JOBS#murage-withdraw-hidden-rules.sql#SELECT 'jobs_open', count(*)#SELECT injected_failure(), count(*)
PENDING#murage-withdraw-hidden-rules.sql#SELECT 'deny_pending', (#SELECT injected_failure(), (
FRONTIER#murage-withdraw-hidden-rules.sql#SELECT 'frontier', count(*)#SELECT injected_failure(), count(*)
QC#murage-withdraw-hidden-rules.sql#PRAGMA quick_check;#SELECT injected_failure();
COUNTS-AFTER#murage-withdraw-hidden-rules.sh#.read '$SQL'\n$COUNTS\n#.read '$SQL'\n${COUNTS/main.messages/main.injected_missing_table}\n
OPEN-AFTER#murage-withdraw-hidden-rules.sh#.read '$SQL'\n$COUNTS\n#.read '$SQL'\n${COUNTS/main.memory_revoke_jobs/main.injected_missing_table}\n
DECISION#murage-withdraw-hidden-rules.sh#(SELECT count(*) FROM main.memory_revoke_jobs WHERE state NOT IN ('done','undone'))=0#injected_failure()=0
ROWS
  assert_eq "W-POSTCOMMIT-ERROR every row ran" "$rows" "10"
fi
if [ "$ONLY" = all ] || [ "$ONLY" = W-KEPT-WRITEFAIL ]; then
  # q1023-wdfix: a clean run (every check passes, so the session writes its kept marker) on a disk that fills under the run lock dir. The
  # run lock dir is the only place the wrapper's session may write while it runs; FULLDISK_LIMIT=n lets a file take n bytes and then fails
  # the write (short fwrite, as ENOSPC mid-write does). Whatever the length, the outcome must be one of two whole states: KEPT (exit 0, the
  # clean-up in place, the racing app saw 0 open jobs) or RESTORED (exit 3, the store the backup again, the app saw its 3 open jobs, the
  # report says restored). A run that stops between them (the clean-up in place, the restore never run) is the failure.
  shim_so="$SCRATCH/full-disk-shim.so"
  gcc -shared -fPIC -O1 -o "$shim_so" "$HERE/full-disk-shim.c" -ldl 2>/dev/null || { echo "AssertionError at $SELF:$LINENO full-disk-shim.c did not build"; fail=1; }
  kept_verdict() { # kept_verdict <row>: CONSISTENT, or what the run did
    local open app restored same
    open=$("$REAL" "$dir/messages.db" "SELECT count(*) FROM memory_revoke_jobs WHERE state NOT IN ('done','undone')")
    app=$(grep -o 'app-saw|[0-9]*' "$dir/.app.log"); restored=$(printf '%s\n' "$out" | grep -c 'was restored in the same locked session')
    [ "$(digest "$dir/messages.db")" = "$snap" ] && same=1 || same=0
    if [ "$code" = 0 ] && [ "$open" = 0 ] && [ "$app" = "app-saw|0" ] && [ "$same" = 0 ]; then echo CONSISTENT
    elif [ "$code" = 3 ] && [ "$same" = 1 ] && [ "$app" = "app-saw|3" ] && [ "$restored" = 1 ]; then echo CONSISTENT
    else echo "exit=$code open_jobs_now=$open store_is_backup=$same $app restored_report=$restored"; fi
  }
  for limit in 0 9 24 40; do
    SHIM_ENV="LD_PRELOAD=$shim_so FULLDISK_DIR=.murage-withdraw-running FULLDISK_LIMIT=$limit"
    run "W-KEPT-WRITEFAIL-$limit" ""
    assert_eq "W-KEPT-WRITEFAIL/$limit the run is kept whole or restored whole, never stopped in between" "$(kept_verdict)" "CONSISTENT"
  done
  # the kept marker cannot be made at all: the run is never reported kept, the restore runs
  SHIM_ENV="LD_PRELOAD=$shim_so FULLDISK_DIR=.murage-withdraw-running FULLDISK_SYMLINK=1"
  run W-KEPT-SYMLINKFAIL ""
  assert_eq "W-KEPT-WRITEFAIL/symlink the run is restored whole, never reported kept" "$(kept_verdict)-$([ "$code" = 3 ] && echo refused)" "CONSISTENT-refused"
  # the kept marker is made, then the session's stderr is lost (the disk is full for the one diagnostic line the deliberate stop prints): the
  # session still stops at the marker, so the run is kept whole (exit 0, clean-up in place, store unlocked with nothing half done), never
  # reported as a failure with the clean-up committed
  SHIM_ENV="LD_PRELOAD=$shim_so FULLDISK_DIR=.murage-withdraw-running FULLDISK_LOSTERR=1"
  run W-KEPT-LOSTERR ""
  assert_eq "W-KEPT-WRITEFAIL/lost-diagnostic the run is kept whole, not reported failed with the clean-up committed" "$(kept_verdict)" "CONSISTENT"
  SHIM_ENV=
fi
if [ "$ONLY" = all ] || [ "$ONLY" = W-ROLLBACK-ERROR ]; then
  # q1023-wdfix, the same class in --rollback: a clean run, then a rollback whose checkpoint AFTER its .restore fails (the run's copy has
  # that one statement replaced). The store is then the backup again, so the report must never say "the store is unchanged".
  run W-ROLLBACK-ERROR ""; cleaned=$(digest "$dir/messages.db")
  t="$SCRATCH/rollback-error-tools"; rm -rf -- "${t:?}"; cp -a "$HERE" "$t"
  from=$'PRAGMA wal_checkpoint(TRUNCATE);\nPRAGMA quick_check;'; src=$(cat "$t/murage-withdraw-hidden-rules.sh"); rest=${src//"$from"/}
  assert_eq "W-ROLLBACK-ERROR the injected statement is found once" "$(( (${#src} - ${#rest}) / ${#from} ))" "1"
  printf '%s\n' "${src/"$from"/$'SELECT injected_checkpoint_failure();\nPRAGMA quick_check;'}" > "$t/murage-withdraw-hidden-rules.sh"
  out=$(SQLITE="$REAL" bash "$t/murage-withdraw-hidden-rules.sh" --rollback "$dir" 2>&1 < /dev/null); code=$?
  printf '%s\n' "$out" | grep -E '^(STOP|ROLLED)' | cut -c1-200
  assert_eq "W-ROLLBACK-ERROR the report is true" "$(printf '%s\n' "$out" | grep -c 'the store is unchanged')$([ "$(digest "$dir/messages.db")" = "$cleaned" ] && echo -same || echo -changed)" "0-changed"
  assert_eq "W-ROLLBACK-ERROR refused with exit 3, never reported rolled back" "$(printf '%s\n' "$out" | grep -c '^ROLLED BACK')-$code" "0-3"
fi
if [ "$ONLY" = all ] || [ "$ONLY" = W-SUCCESS ]; then
  run W-SUCCESS ""
  assert_eq "W-SUCCESS open and pending" "$("$REAL" "$dir/messages.db" "SELECT (SELECT count(*) FROM memory_revoke_jobs WHERE state NOT IN ('done','undone'))||' '||((SELECT count(*) FROM memory_deny_pending)+(SELECT count(*) FROM memory_deny_pending_scope))")" "0 0"
  assert_eq "W-SUCCESS real rows and receipt kept" "$("$REAL" "$dir/messages.db" "SELECT (SELECT count(*) FROM messages)||' '||(SELECT count(*) FROM memory_records)||' '||(SELECT count(*) FROM memory_deny_line WHERE reason='delete-conversation')")" "3 1 1"
  assert_eq "W-SUCCESS exit 0" "$code" "0"
fi
[ "$fail" = 0 ] && echo "WITNESS PASS $ONLY" || echo "WITNESS FAIL $ONLY"
exit $fail
