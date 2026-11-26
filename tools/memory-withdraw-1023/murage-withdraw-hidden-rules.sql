-- q1023-cleanopus: one-time WITHDRAW of every open memory revoke on a Murage store (owner: q1023-cleanopus; rulings: MAIN).
-- Run ONLY with Murage quit, through murage-withdraw-hidden-rules.sh (it makes the backup first). Needs only the sqlite3 that ships with macOS.
--
-- Effect = the app's own undo of each open revoke (revoke-commit.ts undoRevoke -> revoke-marker.ts undoStep, then pruneFinished and
-- clearOrphanPending), applied to EVERY open revoke, including the folded, audience and deletion ones the app's undo refuses
-- (foldRefusesUndo). The owner waived that guard: content those revokes would still have hidden may show in memory again.
-- KEPT on purpose:
--   * memory_deny (the deleted conversations / removed bots) and each deletion's receipt line (memory_deny_line at FIRST_LSN,
--     reason 'delete-conversation'): capture.ts captureThreadDeletion treats a deletion as committed only while BOTH stand; without
--     them the start-up deletion replay commits a NEW revoke job + pending windows at the next start (the backlog comes back).
--   * the owner's own clean-up jobs (memory_scope_bindings 'memory-revocation'): the app's runner finishes them as usual.
--   * every message, record, source, tombstone, evidence and lineage row (no statement here names them).
-- One transaction: either all of it happens or none of it does.
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;
PRAGMA secure_delete=ON;
PRAGMA temp_store=MEMORY;
BEGIN IMMEDIATE;
CREATE TEMP TABLE w_open AS SELECT revoke_id FROM main.memory_revoke_jobs WHERE state NOT IN ('done','undone');
CREATE TEMP TABLE w_receipt AS SELECT * FROM main.memory_deny_line
  WHERE lsn=-9007199254740991 AND reason='delete-conversation' AND revoke_id IN (SELECT revoke_id FROM w_open);
-- undoStep, per revoke: its frontier, every mark and pending row with its id, its visited rows
DELETE FROM main.memory_revoke_frontier    WHERE revoke_id IN (SELECT revoke_id FROM w_open);
DELETE FROM main.memory_deny_line          WHERE revoke_id IN (SELECT revoke_id FROM w_open);
DELETE FROM main.memory_deny_range         WHERE revoke_id IN (SELECT revoke_id FROM w_open);
DELETE FROM main.memory_deny_session       WHERE revoke_id IN (SELECT revoke_id FROM w_open);
DELETE FROM main.memory_deny_memory        WHERE revoke_id IN (SELECT revoke_id FROM w_open);
DELETE FROM main.memory_deny_pending       WHERE revoke_id IN (SELECT revoke_id FROM w_open);
DELETE FROM main.memory_deny_pending_scope WHERE revoke_id IN (SELECT revoke_id FROM w_open);
DELETE FROM main.memory_revoke_reached     WHERE revoke_id IN (SELECT revoke_id FROM w_open);
INSERT INTO main.memory_deny_line SELECT * FROM w_receipt;
-- the undo's end (phase done, state undone, empty cursor), then pruneFinished (the newest row stays: ids are never taken again)
UPDATE main.memory_revoke_jobs SET phase='done', cursor='{}', state='undone' WHERE revoke_id IN (SELECT revoke_id FROM w_open);
DELETE FROM main.memory_revoke_jobs WHERE state IN ('done','undone') AND revoke_id<(SELECT max(revoke_id) FROM main.memory_revoke_jobs);
-- clearOrphanPending: pending rows no job owns; then the quiet tidy's last stage (cover -3 and walker -5 rows, no job open)
DELETE FROM main.memory_deny_pending       WHERE NOT EXISTS (SELECT 1 FROM main.memory_revoke_jobs j WHERE j.revoke_id=memory_deny_pending.revoke_id);
DELETE FROM main.memory_deny_pending_scope WHERE NOT EXISTS (SELECT 1 FROM main.memory_revoke_jobs j WHERE j.revoke_id=memory_deny_pending_scope.revoke_id);
DELETE FROM main.memory_revoke_reached WHERE revoke_id IN (-3,-5)
  AND NOT EXISTS (SELECT 1 FROM main.memory_revoke_jobs WHERE state NOT IN ('done','undone'));
-- the deny generation moves as the app's would: once when each undo starts, once when it ends, once for the sweep (2N+1 moves).
-- Each move writes one change-log row (trigger memory_session_proof_deny_generation): the first 2N rows are written here, in order,
-- and the last by the trigger on the final UPDATE, so the log is the same row for row as the app's 2N+1 single moves.
INSERT INTO main.memory_session_change_log(id)
  WITH RECURSIVE k(i) AS (SELECT 1 WHERE (SELECT count(*) FROM w_open)>0 UNION ALL SELECT i+1 FROM k WHERE i<2*(SELECT count(*) FROM w_open))
  SELECT 'deny-gen:'||((SELECT value FROM main.memory_lineage_lsn_meta WHERE key='deny_generation')+i) FROM k ORDER BY i;
UPDATE main.memory_lineage_lsn_meta SET value=value+2*(SELECT count(*) FROM w_open)+1 WHERE key='deny_generation';
SELECT 'withdrawn', count(*) FROM w_open;
COMMIT;
-- q1023-cleanfix: from here on an error no longer ends the session: the wrapper's own checks and, if they fail, its restore run next
-- in this same session, under the same exclusive lock (murage-withdraw-hidden-rules.sh)
.bail off
SELECT 'committed|1';
PRAGMA wal_checkpoint(TRUNCATE);
SELECT 'jobs_open', count(*) FROM main.memory_revoke_jobs WHERE state NOT IN ('done','undone');
SELECT 'deny_pending', (SELECT count(*) FROM main.memory_deny_pending)+(SELECT count(*) FROM main.memory_deny_pending_scope);
SELECT 'frontier', count(*) FROM main.memory_revoke_frontier;
PRAGMA quick_check;
