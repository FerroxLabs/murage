// Offline helpers: no runtime configuration, Store or provider imports.
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateMemorySchema, validateMemorySchema } from "./schema.ts";

export function applyMemoryTombstones(db: DatabaseSync) {
  db.exec(`UPDATE memory_sources SET state='deleted' WHERE EXISTS (
    SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=memory_sources.id
    AND (t.revision IS NULL OR t.revision=memory_sources.revision));
    WITH RECURSIVE affected(id,version) AS (
      SELECT r.id,r.version FROM memory_records r WHERE EXISTS (
        SELECT 1 FROM memory_tombstones t WHERE t.target_type='record' AND t.target_id=r.id AND (t.revision IS NULL OR t.revision=r.version))
      UNION SELECT e.record_id,e.record_version FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id WHERE s.state='deleted' OR EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=e.source_id AND (t.revision IS NULL OR t.revision=e.source_revision))
      UNION SELECT d.child_id,d.child_version FROM memory_derivations d JOIN affected a ON d.parent_id=a.id AND d.parent_version=a.version
    ) UPDATE memory_records SET state='deleted',owner_pinned=0 WHERE (id,version) IN (SELECT id,version FROM affected);
    UPDATE memory_jobs SET status='cancelled',lease_generation=lease_generation+1,lease_owner=NULL,lease_until=0
      WHERE status!='cancelled' AND (source_id IN (SELECT id FROM memory_sources WHERE state='deleted') OR EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=memory_jobs.source_id AND (t.revision IS NULL OR t.revision=memory_jobs.source_revision)));
    UPDATE memory_projection_receipts SET lexical_status='delete-pending',embedding_status='delete-pending'
      WHERE (record_id,record_version) IN (SELECT id,version FROM memory_records WHERE state='deleted');
    UPDATE memory_disclosures SET state='revoked' WHERE EXISTS (
      SELECT 1 FROM json_each(memory_disclosures.record_versions) j JOIN memory_records r
      ON r.id=json_extract(j.value,'$.id') AND r.version=json_extract(j.value,'$.version') WHERE r.state='deleted'
    ) OR EXISTS (SELECT 1 FROM json_each(memory_disclosures.source_versions) j JOIN memory_sources s
      ON s.id=json_extract(j.value,'$.id') WHERE s.state='deleted' OR EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=s.id AND (t.revision IS NULL OR t.revision=json_extract(j.value,'$.revision'))));`);
}

/** Caller owns the surrounding offline restore transaction. */
export function pauseRestoredMemory(db: DatabaseSync) {
  if (!validateMemorySchema(db).size) return false;
  db.exec("UPDATE memory_meta SET mode='paused',policy_revision=policy_revision+1 WHERE id=1;");
  db.prepare("UPDATE memory_jobs SET status='pending',lease_owner=NULL,lease_until=0,lease_generation=lease_generation+1 WHERE status='leased'").run();
  db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked'").run();
  db.prepare("UPDATE memory_projection_receipts SET lexical_status=CASE WHEN (SELECT r.state FROM memory_records r WHERE r.id=record_id AND r.version=record_version)='active' THEN 'pending' ELSE 'pending-archive' END,embedding_status='pending' WHERE lexical_status!='delete-pending'").run();
  applyMemoryTombstones(db);return true;
}

/** Existing destination is held by the installation restore lease. */
export function mergeDestinationMemoryDeletions(destination: string, candidate: string) {
  const original=join(destination,"messages.db"), target=join(candidate,"messages.db");
  if(!existsSync(original))return {merged:0,history:"backup-only"};
  const stat=lstatSync(original);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error("UNSAFE_MEMORY_LEDGER");
  const source=new DatabaseSync(original,{readOnly:true});
  let rows: Array<Record<string,unknown>>, identity:string, epoch:number;
  try {
    if(!validateMemorySchema(source).size)return {merged:0,history:"legacy-destination"};
    rows=source.prepare("SELECT * FROM memory_tombstones").all();
    const meta=source.prepare("SELECT installation_id,deletion_epoch FROM memory_meta WHERE id=1").get()!;
    identity=String(meta.installation_id);epoch=Number(meta.deletion_epoch);
  } finally {source.close();}
  const db=new DatabaseSync(target);
  try {
    db.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    if(!existsSync(target)||!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='messages'").get()) {
      db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id)); CREATE INDEX messages_thread ON messages(thread_id); CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,active_leaf_id TEXT);");
    }
    migrateMemorySchema(db);
    db.exec("BEGIN IMMEDIATE");
    const insert=db.prepare("INSERT OR IGNORE INTO memory_tombstones VALUES(?,?,?,?,?,?,?,?)");
    for(const row of rows)insert.run(String(row.id),String(row.target_type),String(row.target_id),row.revision as number|null,row.content_hash as string|null,Number(row.epoch),String(row.reason),Number(row.created_at));
    db.prepare("UPDATE memory_meta SET installation_id=?,deletion_epoch=max(deletion_epoch,?),policy_revision=policy_revision+1 WHERE id=1").run(identity,epoch);
    pauseRestoredMemory(db);
    db.exec("COMMIT");
    return {merged:rows.length,history:"destination-ledger-preserved"};
  } catch(error) {try{db.exec("ROLLBACK");}catch{/* no transaction */}throw error;}
  finally{db.close();}
}
