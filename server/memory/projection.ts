import type { DatabaseSync } from "node:sqlite";
import { PIP_ALL_KINDS_SQL } from "./pip-kinds.ts";
import { RECORD_KEYS_TABLE, recordKeysPresent } from "./schema.ts";

/** Records whose derived index entries are waiting to be written or removed.
 * Owner-authored continuity kinds (PIP) are never INSERTED: they are not part of
 * the shared recall index, so its corpus statistics are the same with or without
 * them. They may still be REMOVED: a `delete-pending` receipt for one is real
 * work, so an entry indexed before that rule existed leaves the index when its
 * record is deleted. The same predicate answers "is anything pending" and "what
 * is next". */
const PENDING = `p.lexical_status IN ('pending','pending-archive','delete-pending') AND (r.kind NOT IN ${PIP_ALL_KINDS_SQL} OR p.lexical_status='delete-pending')`;

/** An old version of a thread checkpoint: archived because a newer version of the same checkpoint replaced it. A
 * checkpoint rolls on every captured message and each version only re-quotes excerpts of sources whose own records stay
 * indexed, so its old versions are left out of the derived index altogether (msearch review P2): projected as deleted,
 * like a PIP row. On a long thread they filled whole word pages, and filtering them at query time walked every one.
 * A checkpoint archived with no successor (its thread lost its evidence) is still indexed, for historical search.
 * `table` qualifies the newer-version lookup (an attached authority database). */
export function rolledCheckpointSql(alias:string,table="memory_records"):string{
  return `(${alias}.kind='checkpoint' AND ${alias}.state!='active' AND EXISTS(SELECT 1 FROM ${table} rolled WHERE rolled.id=${alias}.id AND rolled.version>${alias}.version))`;
}

/** Only the removals an owner deletion owes (`delete-pending`): what is still projected with memory off or paused (memdel r2 High #2). */
const DELETIONS = "p.lexical_status='delete-pending'";
export function hasPendingProjection(db:DatabaseSync,deletionsOnly=false):boolean {
  return Boolean(db.prepare(`SELECT 1 FROM memory_projection_receipts p
    JOIN memory_records r ON r.id=p.record_id AND r.version=p.record_version
    WHERE ${deletionsOnly?DELETIONS:PENDING} LIMIT 1`).get());
}

/** Records in these scopes whose projection is still pending, at most `limit` (no order: the caller only asks whether the
 * reader may read any of them). Unlike hasPendingProjection this does not look past the reader's own scopes. */
export function pendingProjectionRefsIn(db:DatabaseSync,scopeIds:readonly string[],limit:number):Array<{id:string;version:number}> {
  return db.prepare(`SELECT r.id,r.version FROM memory_projection_receipts p
    JOIN memory_records r ON r.id=p.record_id AND r.version=p.record_version
    WHERE ${PENDING} AND r.scope_id IN (SELECT value FROM json_each(?)) LIMIT ?`).all(JSON.stringify(scopeIds),limit).map(row=>({id:String(row.id),version:Number(row.version)}));
}

/** The next records after `after` (a receipt row id; 0 starts) in these scopes whose projection is still pending, in receipt
 * order, at most `limit`, with the row id to continue from. A reader's coverage is decided by walking this to the first record
 * it may read, however many it may not (search.ts), so the walk is keyed, never counted. */
export function pendingProjectionRefsAfter(db:DatabaseSync,scopeIds:readonly string[],after:number,limit:number):Array<{id:string;version:number;rowid:number}> {
  return db.prepare(`SELECT p.rowid AS rowid,r.id,r.version FROM memory_projection_receipts p
    JOIN memory_records r ON r.id=p.record_id AND r.version=p.record_version
    WHERE p.rowid>? AND ${PENDING} AND r.scope_id IN (SELECT value FROM json_each(?)) ORDER BY p.rowid LIMIT ?`).all(after,JSON.stringify(scopeIds),limit).map(row=>({id:String(row.id),version:Number(row.version),rowid:Number(row.rowid)}));
}

/** `ageKey`: the record's age key (schema.ts RECORD_KEYS_SCHEMA), the rowid of its FTS row in an index in age order; null until the key
 * backfill reaches it (or on a file an older build left without the key table). */
export function pendingProjectionRecords(db:DatabaseSync,limit=16,deletionsOnly=false) {
  const keyed=recordKeysPresent(db);
  return db.prepare(`SELECT r.id,r.version,r.scope_id AS scopeId,CASE WHEN r.kind IN ${PIP_ALL_KINDS_SQL} OR ${rolledCheckpointSql("r")} THEN '' ELSE r.text END AS text,CASE WHEN r.kind IN ${PIP_ALL_KINDS_SQL} OR ${rolledCheckpointSql("r")} THEN 'deleted' ELSE r.state END AS state,CASE WHEN r.kind NOT IN ${PIP_ALL_KINDS_SQL} AND r.state!='deleted' AND p.lexical_status!='delete-pending' AND ${rolledCheckpointSql("r")} THEN 1 ELSE 0 END AS rolled,${keyed?"k.age_key":"NULL"} AS ageKey FROM memory_projection_receipts p
    JOIN memory_records r ON r.id=p.record_id AND r.version=p.record_version
    ${keyed?`LEFT JOIN ${RECORD_KEYS_TABLE} k ON k.record_id=r.id AND k.record_version=r.version`:""}
    WHERE ${deletionsOnly?DELETIONS:PENDING}
    ORDER BY p.lexical_status,p.record_id,p.record_version LIMIT ?`).all(limit);
}
