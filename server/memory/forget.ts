import { randomUUID } from "node:crypto";
import { database, transaction } from "../database.ts";
import { requireMemoryOwner } from "./authority.ts";
import { applyMemoryTombstones } from "./restore.ts";

export function forgetMemory(ticket: object, target: {kind:"source"|"record";id:string;revision?:number}) {
  requireMemoryOwner(ticket);
  if(!target.id || target.revision!==undefined && (!Number.isSafeInteger(target.revision)||target.revision<0))throw new Error("INVALID_MEMORY_TARGET");
  return transaction(db=>{
    const exists=target.kind==="source"?db.prepare("SELECT 1 FROM memory_sources WHERE id=?").get(target.id):db.prepare("SELECT 1 FROM memory_records WHERE id=?").get(target.id);
    if(!exists)throw new Error("MEMORY_NOT_FOUND");
    db.exec("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1,policy_revision=policy_revision+1 WHERE id=1");
    const epoch=Number(db.prepare("SELECT deletion_epoch FROM memory_meta WHERE id=1").get()!.deletion_epoch);
    db.prepare("INSERT INTO memory_tombstones VALUES(?,?,?,?,NULL,?,'owner-forget',?)").run(randomUUID(),target.kind,target.id,target.revision??null,epoch,Date.now());
    const sources=target.kind==="source"?db.prepare("SELECT s.id,s.scope_id,v.revision,v.content_hash FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id WHERE s.id=? AND (? IS NULL OR v.revision=?)").all(target.id,target.revision??null,target.revision??null)
      :db.prepare("SELECT DISTINCT s.id,s.scope_id,v.revision,v.content_hash FROM memory_sources s JOIN memory_evidence e ON e.source_id=s.id JOIN memory_source_versions v ON v.source_id=e.source_id AND v.revision=e.source_revision WHERE e.record_id=? AND (? IS NULL OR e.record_version=?)").all(target.id,target.revision??null,target.revision??null);
    for(const source of sources) {
      db.prepare("INSERT INTO memory_tombstones VALUES(?,'import',?,NULL,?,?,'forgotten-original',?)").run(randomUUID(),String(source.scope_id),String(source.content_hash),epoch,Date.now());
      // Source expansion must not reveal a forgotten record through its original span.
      if(target.kind==="record") db.prepare("INSERT INTO memory_tombstones VALUES(?,'source',?,?,NULL,?,'forgotten-supporting-source',?)").run(randomUUID(),String(source.id),Number(source.revision),epoch,Date.now());
    }
    applyMemoryTombstones(db);
    const pending=Number(db.prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE lexical_status='delete-pending' OR embedding_status='delete-pending'").get()!.n);
    return {status:"excluded" as const,deletionEpoch:epoch,derivedCleanup:pending?"pending":"complete",externalHistory:"already-delivered provider text cannot be erased",originals:"retained outside memory; supporting source revisions and automatic reimport excluded"};
  });
}

export function memoryDeletionStatus() {
  return {pending:Number(database().prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE lexical_status='delete-pending' OR embedding_status='delete-pending'").get()!.n)};
}
