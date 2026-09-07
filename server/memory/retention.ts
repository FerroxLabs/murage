import { database, transaction } from "../database.ts";
import { requireMemoryOwner } from "./authority.ts";

function transition(ticket:object,id:string,version:number,from:"active"|"archived",to:"active"|"archived"){
  requireMemoryOwner(ticket);
  transaction(db=>{
    const row=db.prepare("SELECT owner_pinned FROM memory_records WHERE id=? AND version=? AND state=?").get(id,version,from);
    if(!row)throw new Error("MEMORY_VERSION_CONFLICT");
    if(row.owner_pinned===1)throw new Error("MEMORY_PIN_MUST_BE_UNPINNED");
    if(to==="active" && db.prepare(`SELECT 1 FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id WHERE e.record_id=? AND e.record_version=? AND (s.state!='active' OR s.revision!=e.source_revision) LIMIT 1`).get(id,version))throw new Error("MEMORY_SOURCE_UNAVAILABLE");
    db.prepare("UPDATE memory_records SET state=? WHERE id=? AND version=?").run(to,id,version);
    db.prepare("UPDATE memory_projection_receipts SET lexical_status=? WHERE record_id=? AND record_version=?").run(to==="active"?"pending":"pending-archive",id,version);
    db.exec("UPDATE memory_meta SET data_revision=data_revision+1,policy_revision=policy_revision+1");
    db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked'").run();
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
