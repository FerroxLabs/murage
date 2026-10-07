import { database, transaction } from "../database.ts";
import { isPipKind } from "./pip-kinds.ts";
import { requireMemoryOwner, readCorrectionTarget, approveCorrection, assertGenericMemoryTarget } from "./authority.ts";
import { revokeRecordDisclosures } from "./revocation.ts";

function transition(ticket:object,id:string,version:number,from:"active"|"archived",to:"active"|"archived"){
  requireMemoryOwner(ticket);
  transaction(db=>{
    const row=db.prepare("SELECT * FROM memory_records WHERE id=? AND version=? AND state=?").get(id,version,from);
    if(!row)throw new Error("MEMORY_VERSION_CONFLICT");
    // I-10: a PIP row is never archived or restored here; refused before any receipt rewrite, revision bump or revoke.
    if(isPipKind(row.kind))throw new Error("MEMORY_IDENTITY_WRITE_REQUIRED");
    if(row.owner_pinned===1)throw new Error("MEMORY_PIN_MUST_BE_UNPINNED");
    if(to==="active" && db.prepare(`SELECT 1 FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id WHERE e.record_id=? AND e.record_version=? AND (s.state!='active' OR s.revision!=e.source_revision) LIMIT 1`).get(id,version))throw new Error("MEMORY_SOURCE_UNAVAILABLE");
    if(to==="active"){
      const latest=db.prepare("SELECT max(version) version FROM memory_records WHERE id=?").get(id);
      if(latest?.version!==version)throw new Error("This memory changed. Restore the current version.");
      // Owner edits retain the original correction's external target through
      // their same-id derivations, even after multiple edits.
      const origin=row.supersedes_id===id?db.prepare(`WITH RECURSIVE earlier(version) AS (
        SELECT ?
        UNION
        SELECT d.parent_version FROM earlier e JOIN memory_derivations d
          ON d.child_id=? AND d.child_version=e.version
          WHERE d.parent_id=? AND d.parent_version<e.version
      ) SELECT r.version FROM earlier e JOIN memory_records r ON r.id=? AND r.version=e.version
        WHERE r.version=1 AND r.supersedes_id IS NOT NULL AND r.supersedes_id!=?`).get(version,id,id,id,id):null;
      const correction=row.supersedes_id===id
        ?origin?readCorrectionTarget(db,id,Number(origin.version)):null
        :readCorrectionTarget(db,id,version);
      // An unavailable original cannot be reactivated or superseded here.
      if(correction && correction.status!=="unavailable"){
        const target=correction.target;
        // An approved correction can be archived while its exact target remains
        // superseded. Restore it only when no other replacement is current.
        const retiredTarget=correction.status==="changed" && target?.state==="superseded" &&
          db.prepare("SELECT max(version) version FROM memory_records WHERE id=?").get(target.id)?.version===target.version;
        const replacement=target && db.prepare(`WITH RECURSIVE replacements(id,version) AS (
          SELECT child.id,child.version FROM memory_derivations d JOIN memory_records child
            ON child.id=d.child_id AND child.version=d.child_version
            WHERE d.parent_id=? AND d.parent_version=? AND child.supersedes_id=d.parent_id
          UNION
          SELECT child.id,child.version FROM replacements p JOIN memory_derivations d
            ON d.parent_id=p.id AND d.parent_version=p.version JOIN memory_records child
            ON child.id=d.child_id AND child.version=d.child_version WHERE child.supersedes_id=d.parent_id
        ) SELECT 1 FROM replacements p JOIN memory_records r ON r.id=p.id AND r.version=p.version
          WHERE r.state='active' AND r.id!=? LIMIT 1`).get(target.id,target.version,id);
        if(replacement || (row.supersedes_id!==id && correction.status!=="current" && !retiredTarget))throw new Error("The memory this corrects has changed. Forget this proposal or approve a fresh one.");
        if(target){
          assertGenericMemoryTarget(db,target.id,target.version);
          if(target.scopeId!==row.scope_id)throw new Error("MEMORY_CORRECTION_SCOPE_MISMATCH");
        }
        if(correction.status==="current"){
          if(target?.ownerPinned)throw new Error("Unpin the current memory before restoring this correction.");
          db.prepare("UPDATE memory_records SET state='candidate' WHERE id=? AND version=?").run(id,version);
          approveCorrection(db,row,correction,{});
        }
      }
    }
    db.prepare("UPDATE memory_records SET state=? WHERE id=? AND version=?").run(to,id,version);
    db.prepare("UPDATE memory_projection_receipts SET lexical_status=? WHERE record_id=? AND record_version=?").run(to==="active"?"pending":"pending-archive",id,version);
    db.exec("UPDATE memory_meta SET data_revision=data_revision+1");
    revokeRecordDisclosures(db,to==="archived"?"archive":"restore-archive",{recordIds:[id]});
  });
  return {id,version,state:to};
}
export function archiveMemoryRecord(ticket:object,id:string,version:number){return transition(ticket,id,version,"active","archived");}
export function restoreArchivedMemoryRecord(ticket:object,id:string,version:number){return transition(ticket,id,version,"archived","active");}
export function memoryRetentionStatus(){
  const db=database();
  return {records:db.prepare("SELECT state,count(*) AS count,sum(length(CAST(text AS BLOB))) AS bytes FROM memory_records GROUP BY state").all(),
    sourceBytes:Number(db.prepare("SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM memory_source_versions").get()!.bytes),
    automaticPermanentForgetting:false,originalSourcesRetained:true};
}
