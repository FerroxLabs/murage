// Debt producer owner: recall-fix-j. Recovery/status consumer owner: recall-prod-x.
import type { DatabaseSync } from 'node:sqlite';

/** Bound the index walk before reading any marker payload or source. */
export function checkpointDebtCount(db:DatabaseSync,limit=1):number {
  return Number(db.prepare("SELECT count(*) AS n FROM (SELECT 1 FROM memory_scope_bindings INDEXED BY memory_bindings_subject WHERE subject_type='system' AND subject_id='checkpoint-pending' LIMIT ?)").get(limit)?.n??0);
}
