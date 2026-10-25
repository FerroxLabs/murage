import { DatabaseSync } from "node:sqlite";
import { MemoryQueryCache } from "./cache.ts";
import { PIP_ALL_KINDS_SQL } from "./pip-kinds.ts";
import { DENIED_RECORD_SCOPE, DENIED_SOURCE } from "./deny.ts";

// The PIP kind list (brief, owner, lived, concern and episode rows) lives in pip-kinds.ts:
// the exclusion below keeps every one of them out of search, recall and the index (PIP A1, I-15).
// A source in a deleted conversation or bot, or a copy of a forgotten one, is refused from the deletion's commit (deny.ts).
export const CURRENT_MEMORY = `r.kind NOT IN ${PIP_ALL_KINDS_SQL} AND r.state='active' AND NOT ${DENIED_RECORD_SCOPE("r")} AND NOT EXISTS (
  SELECT 1 FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id
  WHERE e.record_id=r.id AND e.record_version=r.version AND (s.state!='active' OR s.revision!=e.source_revision OR ${DENIED_SOURCE("s")}))`;
export const HISTORICAL_MEMORY = `r.kind NOT IN ${PIP_ALL_KINDS_SQL} AND r.state IN ('active','archived','superseded') AND NOT ${DENIED_RECORD_SCOPE("r")} AND NOT EXISTS (
  SELECT 1 FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id WHERE e.record_id=r.id AND e.record_version=r.version AND (s.state='deleted' OR ${DENIED_SOURCE("s")})) AND NOT EXISTS (
  SELECT 1 FROM memory_record_details d WHERE d.record_id=r.id AND d.record_version=r.version AND d.claim_status='provisional')`;
/** The part of "may a reader read this record" that does not depend on the reader, as SQL: a record someone forgot (a record
 * tombstone) and a record resting on nothing (no evidence, and not an owner statement) are refused to every reader by
 * readableMemoryRecord. They are never eligible, so no scan, ranking, count, coverage or cursor is ever shaped by how many
 * of them there are (msearch review round 5). */
export const REACHABLE_RECORD = `NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='record' AND t.target_id=r.id AND (t.revision IS NULL OR t.revision=r.version))
  AND (r.assertion='owner-statement' OR EXISTS (SELECT 1 FROM memory_evidence ev WHERE ev.record_id=r.id AND ev.record_version=r.version))`;
/** Records one chunk of the eligible set holds: the most vectors the helper keeps resident at once. (Mutable only so tests can
 * exercise a scan over many chunks without twelve thousand records per chunk.) */
export const eligibleLimits={chunk:12000};
/** A cursor over the eligible set is the last (id, version) of the previous chunk: the set is ordered by that pair, so a
 * chunk that ends between two versions of one id loses neither. "" is the start. */
export const encodeEligibleCursor=(row:{id:string;version:number})=>JSON.stringify([row.id,row.version]);
function decodeEligibleCursor(cursor:string):[string,number]{
  if(cursor==="")return ["",-1];
  try{const [id,version]=JSON.parse(cursor) as [unknown,unknown];if(typeof id==="string"&&typeof version==="number")return [id,version];}catch{/* refused below */}
  throw new Error("INVALID_MEMORY_CURSOR");
}
/** The eligible records of these scopes after the cursor, in (id, version) order, at most `limit`. The helper reads its
 * chunks with this, and so does the main process when it must learn whether anything the reader may READ is left past
 * where a scan stopped (search.ts): one definition of eligible. */
export function eligibleAfter(db:DatabaseSync,scopeIds:readonly string[],historical:boolean,cursor:string,limit:number):Array<{id:string;version:number}>{
  const [id,version]=decodeEligibleCursor(cursor);
  return db.prepare(`SELECT r.id,r.version FROM memory_records r WHERE ${historical?HISTORICAL_MEMORY:CURRENT_MEMORY} AND ${REACHABLE_RECORD}
    AND r.scope_id IN (SELECT value FROM json_each(?)) AND (r.id,r.version)>(?,?) ORDER BY r.id,r.version LIMIT ?`).all(JSON.stringify(scopeIds),id,version,limit).map(r=>({id:String(r.id),version:Number(r.version)}));
}
export class MemoryEligibility {
  private db:DatabaseSync;
  private cache=new MemoryQueryCache<Array<{id:string;version:number}>>();
  constructor(path:string){this.db=new DatabaseSync(path,{readOnly:true});}
  warm(scopeIds:string[]){
    if(!scopeIds.length)return;
    const meta=this.db.prepare("SELECT policy_revision,deletion_epoch FROM memory_meta WHERE id=1").get()!;
    this.read({scopeIds,policyRevision:Number(meta.policy_revision),deletionEpoch:Number(meta.deletion_epoch),historical:false,cursor:""});
  }
  read(input:{scopeIds:string[];policyRevision:number;deletionEpoch:number;historical:boolean;cursor:string}){
    const meta=this.db.prepare("SELECT policy_revision,deletion_epoch,data_revision FROM memory_meta WHERE id=1").get()!;
    if(meta.policy_revision!==input.policyRevision||meta.deletion_epoch!==input.deletionEpoch)throw new Error("MEMORY_CONTEXT_REVOKED");
    const scopes=this.db.prepare(`SELECT DISTINCT scope_id FROM memory_records WHERE scope_id IN (SELECT value FROM json_each(?)) AND state IN ${input.historical?"('active','archived','superseded')":"('active')"}`).all(JSON.stringify(input.scopeIds)).map(r=>String(r.scope_id)).sort();
    const key=JSON.stringify([scopes,meta.data_revision,meta.policy_revision,meta.deletion_epoch,input.historical,input.cursor]);
    let rows=this.cache.get(key);
    if(!rows){
      rows=eligibleAfter(this.db,scopes,input.historical,input.cursor,eligibleLimits.chunk+1);
      for(const row of rows)Object.freeze(row);Object.freeze(rows);
      this.cache.set(key,rows);
    }
    const chunk=eligibleLimits.chunk,over=rows.length>chunk;
    return {allowed:over?rows.slice(0,chunk):rows,capacity:over,nextCursor:over?encodeEligibleCursor(rows[chunk-1]):undefined};
  }
  /** Ids of every PIP record, any state: what the derived index must not hold. */
  pipRecordIds():string[]{
    return this.db.prepare(`SELECT DISTINCT r.id FROM memory_records r WHERE r.kind IN ${PIP_ALL_KINDS_SQL} ORDER BY r.id`).all().map(r=>String(r.id));
  }
  close(){this.db.close();this.cache.clear();}
}
