import { DatabaseSync } from "node:sqlite";
import { MemoryQueryCache } from "./cache.ts";

export const CURRENT_MEMORY = `r.state='active' AND NOT EXISTS (
  SELECT 1 FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id
  WHERE e.record_id=r.id AND e.record_version=r.version AND (s.state!='active' OR s.revision!=e.source_revision))`;
export const HISTORICAL_MEMORY = `r.state IN ('active','archived','superseded') AND NOT EXISTS (
  SELECT 1 FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id WHERE e.record_id=r.id AND e.record_version=r.version AND s.state='deleted')`;
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
      rows=this.db.prepare(`SELECT r.id,r.version FROM memory_records r WHERE ${input.historical?HISTORICAL_MEMORY:CURRENT_MEMORY}
        AND r.scope_id IN (SELECT value FROM json_each(?)) AND r.id>? ORDER BY r.id,r.version LIMIT 12001`).all(JSON.stringify(scopes),input.cursor).map(r=>({id:String(r.id),version:Number(r.version)}));
      for(const row of rows)Object.freeze(row);Object.freeze(rows);
      this.cache.set(key,rows);
    }
    return {allowed:rows.length<=12000?rows:rows.slice(0,12000),capacity:rows.length>12000,nextCursor:rows.length>12000?rows[11999].id:undefined};
  }
  close(){this.db.close();this.cache.clear();}
}
