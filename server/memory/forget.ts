import { randomUUID } from "node:crypto";
import { database, transaction } from "../database.ts";
import { requireMemoryOwner } from "./authority.ts";
import { applyMemoryTombstones } from "./restore.ts";

/** Told, inside the forget's own transaction, which messages the forgotten
 * material came from: derived project text citing them goes stale (SPEC-P
 * 15.3, project-tables.ts markProjectDerivedStale; registered by index.ts). */
type ForgottenMessagesHook = (db: import("node:sqlite").DatabaseSync, messageIds: string[]) => void;
let forgottenMessagesHook: ForgottenMessagesHook | null = null;
export function onMemoryMessagesForgotten(hook: ForgottenMessagesHook | null): void { forgottenMessagesHook = hook; }

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
    // A room's notes (its checkpoint) quote room messages every member still
    // reads. Forgetting the notes forgets the notes: a reply made with them is
    // withheld for using them, but the messages they quoted are not forgotten
    // with them (0.1.61 final check 2, N2: every earlier reply read "you chose
    // to forget it" and the bots lost the room's history).
    const notes=target.kind==="record"&&Boolean(db.prepare("SELECT 1 FROM memory_records WHERE id=? AND kind='checkpoint' AND (? IS NULL OR version=?) LIMIT 1").get(target.id,target.revision??null,target.revision??null));
    for(const source of sources) {
      db.prepare("INSERT INTO memory_tombstones VALUES(?,'import',?,NULL,?,?,'forgotten-original',?)").run(randomUUID(),String(source.scope_id),String(source.content_hash),epoch,Date.now());
      // Source expansion must not reveal a forgotten record through its original span.
      if(target.kind==="record"&&!notes) db.prepare("INSERT INTO memory_tombstones VALUES(?,'source',?,?,NULL,?,'forgotten-supporting-source',?)").run(randomUUID(),String(source.id),Number(source.revision),epoch,Date.now());
    }
    applyMemoryTombstones(db);
    const messageIds=[...new Set(sources.map(source=>db.prepare("SELECT message_id FROM memory_sources WHERE id=?").get(String(source.id))?.message_id).filter((id):id is string=>typeof id==="string"&&id.length>0))];
    // The messages the room's notes quoted are not forgotten with them.
    if(messageIds.length&&!notes)forgottenMessagesHook?.(db,messageIds);
    const pending=Number(db.prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE lexical_status='delete-pending' OR embedding_status='delete-pending'").get()!.n);
    return {status:"excluded" as const,deletionEpoch:epoch,derivedCleanup:pending?"pending":"complete",externalHistory:"already-delivered provider text cannot be erased",originals:"retained outside memory; supporting source revisions and automatic reimport excluded"};
  });
}

export function memoryDeletionStatus() {
  return {pending:Number(database().prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE lexical_status='delete-pending' OR embedding_status='delete-pending'").get()!.n)};
}
