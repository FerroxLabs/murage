#!/usr/bin/env bash
# witness-wrapper.sh <scratch-dir> [row]   (owner: q1023-cleanfix; the wrapper under test: murage-withdraw-hidden-rules.sh, q1023-cleanopus)
# Runs the wrapper itself (its production entry point: `bash murage-withdraw-hidden-rules.sh <data-dir>`) on a small store, with a failure
# injected into the clean-up and an app that opens the store the moment the wrapper's sqlite3 session ends (SQLITE= a shim that starts it).
#   W-RESTORE-LOCKED  the clean-up commits but fails its checks (a trigger adds a record): the store must be the backup again, restored
#                     before any other opener could take the store, and the attempt kept.
#   W-PRECOMMIT       an error before the commit: the store must be unchanged.
#   W-SUCCESS         no failure: no job open, no pending window, every real row kept; exit 0.
# Needs bash and sqlite3 only. Counts and digests only.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); SELF="tools/memory-withdraw-1023/witness-wrapper.sh"
SCRATCH=${1:?scratch dir}; ONLY=${2:-all}; REAL=${REAL_SQLITE:-$(command -v sqlite3)}
fail=0
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
# the shim: the real sqlite3, then (once the wrapper's own session has ended) an app that opens the store and holds it a few seconds
shim() { # shim <file> <data-dir>
  cat > "$1" <<SH
#!/usr/bin/env bash
"$REAL" "\$@"; rc=\$?
if [ ! -e "$2/.app-started" ]; then
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
if [ "$ONLY" = all ] || [ "$ONLY" = W-SUCCESS ]; then
  run W-SUCCESS ""
  assert_eq "W-SUCCESS open and pending" "$("$REAL" "$dir/messages.db" "SELECT (SELECT count(*) FROM memory_revoke_jobs WHERE state NOT IN ('done','undone'))||' '||((SELECT count(*) FROM memory_deny_pending)+(SELECT count(*) FROM memory_deny_pending_scope))")" "0 0"
  assert_eq "W-SUCCESS real rows and receipt kept" "$("$REAL" "$dir/messages.db" "SELECT (SELECT count(*) FROM messages)||' '||(SELECT count(*) FROM memory_records)||' '||(SELECT count(*) FROM memory_deny_line WHERE reason='delete-conversation')")" "3 1 1"
  assert_eq "W-SUCCESS exit 0" "$code" "0"
fi
[ "$fail" = 0 ] && echo "WITNESS PASS $ONLY" || echo "WITNESS FAIL $ONLY"
exit $fail
