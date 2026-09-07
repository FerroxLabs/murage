import { createHash } from "node:crypto";
import { database, transaction } from "../database.ts";
import { resultSchema, type MemoryWork, type MemoryWorkResult } from "./worker-protocol.ts";

let lastScope = "";
export function claimMemoryJob(worker: string, now = Date.now()): MemoryWork | null {
  return transaction(db => {
    const meta = db.prepare("SELECT * FROM memory_meta WHERE id=1").get()!;
    if (!["capture","active"].includes(String(meta.mode))) return null;
    if (db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id='memory-roster-policy' AND state='pending'").get()) return null;
    const row = db.prepare(`SELECT j.*,s.scope_id,s.kind,s.speaker,s.outcome,
      length(CAST(json_extract(v.payload,'$.text') AS BLOB)) AS total_bytes
      FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision
      JOIN memory_source_versions v ON v.source_id=j.source_id AND v.revision=j.source_revision
      WHERE s.state='active' AND s.outcome!='working' AND j.attempts<3 AND j.retry_at<=?
      AND (j.status IN ('pending','partial','deferred') OR (j.status='leased' AND j.lease_until<?))
      ORDER BY CASE WHEN s.scope_id>? THEN 0 ELSE 1 END,s.scope_id,j.rowid LIMIT 1`).get(now,now,lastScope);
    if (!row) return null;
    lastScope=String(row.scope_id);
    const cursor=Number(row.cursor), totalBytes=Number(row.total_bytes);
    const payload = db.prepare("SELECT substr(CAST(json_extract(payload,'$.text') AS BLOB),?,65536) AS bytes FROM memory_source_versions WHERE source_id=? AND revision=?").get(cursor+1,row.source_id,row.source_revision)!.bytes as Uint8Array;
    let end=payload.length, text="";
    while (end>=Math.max(0,payload.length-3)) {
      try { text=new TextDecoder("utf-8",{fatal:true}).decode(payload.subarray(0,end));break; } catch {end--;}
    }
    if (end<0 || !text && cursor<totalBytes) throw new Error("INVALID_SOURCE_UTF8");
    const generation=Number(row.lease_generation)+1;
    db.prepare("UPDATE memory_jobs SET status='leased',lease_owner=?,lease_generation=?,lease_until=?,policy_revision=?,deletion_epoch=? WHERE id=?")
      .run(worker,generation,now+30000,meta.policy_revision,meta.deletion_epoch,row.id);
    return {id:String(row.id),sourceId:String(row.source_id),revision:Number(row.source_revision),leaseGeneration:generation,
      policyRevision:Number(meta.policy_revision),deletionEpoch:Number(meta.deletion_epoch),scopeId:String(row.scope_id),stage:String(row.stage),kind:String(row.kind),speaker:String(row.speaker),outcome:String(row.outcome),cursor,totalBytes,text};
  });
}

export function heartbeatMemoryJob(work: MemoryWork, worker: string, now=Date.now()) {
  return Boolean(database().prepare("UPDATE memory_jobs SET lease_until=? WHERE id=? AND lease_owner=? AND lease_generation=? AND status='leased' AND lease_until>=?").run(now+30000,work.id,worker,work.leaseGeneration,now).changes);
}

export function publishMemoryWork(work: MemoryWork, worker: string, input: MemoryWorkResult, now=Date.now()) {
  const result=resultSchema.parse(input);
  transaction(db => {
    const job=db.prepare("SELECT * FROM memory_jobs WHERE id=?").get(work.id), meta=db.prepare("SELECT * FROM memory_meta WHERE id=1").get()!;
    const source=db.prepare("SELECT revision,state FROM memory_sources WHERE id=?").get(work.sourceId);
    if (!job || job.status!=="leased" || job.lease_owner!==worker || job.lease_generation!==work.leaseGeneration || Number(job.lease_until)<now || result.id!==work.id || result.leaseGeneration!==work.leaseGeneration) throw new Error("STALE_MEMORY_LEASE");
    if (!source || source.revision!==work.revision || source.state!=="active" || meta.policy_revision!==work.policyRevision || meta.deletion_epoch!==work.deletionEpoch) throw new Error("STALE_MEMORY_SOURCE");
    if (result.status==="deferred" || result.status==="failed") {
      if(result.chunks.length || result.nextCursor!==work.cursor) throw new Error("INVALID_FAILURE_COVERAGE");
      const attempts=Number(job.attempts)+1;
      db.prepare("UPDATE memory_jobs SET status=?,attempts=?,retry_at=?,lease_owner=NULL,lease_until=0,error=? WHERE id=?")
        .run(attempts>=3?"failed":"deferred",attempts,now+(attempts===1?5000:30000),result.reason??"worker-failed",work.id);return;
    }
    const expectedEnd=work.cursor+Buffer.byteLength(work.text);
    if(result.nextCursor!==expectedEnd || (result.status==="complete")!==(expectedEnd===work.totalBytes)) throw new Error("INCOMPLETE_MEMORY_SOURCE");
    let cursor=work.cursor;
    for (const chunk of result.chunks) {
      if (chunk.startByte!==cursor || chunk.endByte!==cursor+Buffer.byteLength(chunk.text) || chunk.text!==Buffer.from(work.text).subarray(cursor-work.cursor,chunk.endByte-work.cursor).toString("utf8")) throw new Error("INVALID_MEMORY_CHUNK");
      cursor=chunk.endByte;
      const id=createHash("sha256").update(`${work.sourceId}:${work.revision}:${chunk.startByte}:${chunk.endByte}`).digest("hex");
      const assertion=work.speaker==="owner"?"owner-statement":work.speaker==="tool"?"tool-observation":"assistant-inference";
      db.prepare("INSERT OR IGNORE INTO memory_records VALUES(?,1,?,'source',?,?,'active',0,?,NULL,NULL,?)").run(id,work.scopeId,chunk.text,assertion,now,now);
      db.prepare("INSERT OR IGNORE INTO memory_evidence VALUES(?,1,?,?,?,?)").run(id,work.sourceId,work.revision,chunk.startByte,chunk.endByte);
      db.prepare("INSERT OR IGNORE INTO memory_projection_receipts VALUES(?,1,1,'pending','pending',NULL)").run(id);
    }
    if (work.kind!=="turn" && cursor!==expectedEnd) throw new Error("INCOMPLETE_MEMORY_COVERAGE");
    if(result.chunks.length)db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
    db.prepare("UPDATE memory_jobs SET status=?,cursor=?,coverage=?,lease_owner=NULL,lease_until=0,error=NULL WHERE id=?")
      .run(result.status,result.nextCursor,JSON.stringify({throughByte:result.nextCursor,totalBytes:work.totalBytes}),work.id);
  });
}
