import type { DatabaseSync } from "node:sqlite";
import { PIP_ALL_KINDS_SQL } from "./pip-kinds.ts";

/** Records whose derived index entries are waiting to be written or removed.
 * Owner-authored continuity kinds (PIP) are never INSERTED: they are not part of
 * the shared recall index, so its corpus statistics are the same with or without
 * them. They may still be REMOVED: a `delete-pending` receipt for one is real
 * work, so an entry indexed before that rule existed leaves the index when its
 * record is deleted. The same predicate answers "is anything pending" and "what
 * is next". */
const PENDING = `p.lexical_status IN ('pending','pending-archive','delete-pending') AND (r.kind NOT IN ${PIP_ALL_KINDS_SQL} OR p.lexical_status='delete-pending')`;

export function hasPendingProjection(db:DatabaseSync):boolean {
  return Boolean(db.prepare(`SELECT 1 FROM memory_projection_receipts p
    JOIN memory_records r ON r.id=p.record_id AND r.version=p.record_version
    WHERE ${PENDING} LIMIT 1`).get());
}

export function pendingProjectionRecords(db:DatabaseSync,limit=16) {
  return db.prepare(`SELECT r.id,r.version,r.scope_id AS scopeId,CASE WHEN r.kind IN ${PIP_ALL_KINDS_SQL} THEN '' ELSE r.text END AS text,CASE WHEN r.kind IN ${PIP_ALL_KINDS_SQL} THEN 'deleted' ELSE r.state END AS state FROM memory_projection_receipts p
    JOIN memory_records r ON r.id=p.record_id AND r.version=p.record_version
    WHERE ${PENDING}
    ORDER BY p.lexical_status,p.record_id,p.record_version LIMIT ?`).all(limit);
}
