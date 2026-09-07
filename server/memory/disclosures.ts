import { database, transaction } from "../database.ts";
import type { MemoryBundle } from "../../shared/memory.ts";
import { assertMemoryAccess, type MemoryAccess } from "./policy.ts";
import { assertMemoryBundle, hydrateMemoryRecord } from "./bundle.ts";

/** Persist before dispatch; records contain references, never duplicated memory text. */
export function prepareMemoryDisclosure(bundle: MemoryBundle, access: MemoryAccess, driverInstance: string) {
  assertMemoryBundle(bundle,access);
  if (!driverInstance) throw new Error("INVALID_MEMORY_DRIVER");
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,NULL,?,?,?,?,?,'prepared',?)")
    .run(bundle.bundleId,access.threadId,driverInstance,JSON.stringify(bundle.recordVersions),JSON.stringify(bundle.sourceVersions),bundle.policyRevision,bundle.deletionEpoch,bundle.tokenCount,Date.now());
}

/** session.started can precede sendTurn completion; binding does not claim delivery. */
export function bindMemoryDisclosureSession(bundleId: string, nativeSession: string) {
  if (!nativeSession) throw new Error("INVALID_MEMORY_SESSION");
  const result = database().prepare("UPDATE memory_disclosures SET native_session=? WHERE bundle_id=? AND (native_session IS NULL OR native_session=?)").run(nativeSession,bundleId,nativeSession);
  if (!result.changes) throw new Error("MEMORY_DISCLOSURE_SESSION_CONFLICT");
}

/** Record actual adapter acceptance while dispatch authority is still live.
 * A terminal event may arrive before sendTurn resolves: its observer must call
 * this BEFORE terminal capability revocation, then skip duplicate finalization
 * at promise resolution. Session binding alone is not acceptance.
 */
export function deliverMemoryDisclosure(bundleId: string, access: MemoryAccess, nativeSession?: string) {
  assertMemoryAccess(access);
  const row = database().prepare("SELECT * FROM memory_disclosures WHERE bundle_id=? AND thread_id=?").get(bundleId,access.threadId);
  if (!row || revoked(row,access)) throw new Error("MEMORY_CONTEXT_REVOKED");
  if (nativeSession) bindMemoryDisclosureSession(bundleId,nativeSession);
  database().prepare("UPDATE memory_disclosures SET state='delivered' WHERE bundle_id=? AND state='prepared'").run(bundleId);
}

type Disclosure = Record<string,string|number|bigint|Uint8Array|null>;
function revoked(row: Disclosure, access: MemoryAccess): boolean {
  if (row.state === "revoked" || row.policy_revision !== access.policyRevision || row.deletion_epoch !== access.deletionEpoch) return true;
  try {
    const records: Array<{id:string;version:number}> = JSON.parse(String(row.record_versions));
    for (const record of records) hydrateMemoryRecord(record.id,record.version,access);
    const sources: Array<{id:string;revision:number}> = JSON.parse(String(row.source_versions));
    for (const source of sources) {
      const current = database().prepare("SELECT scope_id,state,revision FROM memory_sources WHERE id=?").get(source.id);
      if (!current || current.state!=="active" || current.revision!==source.revision || database().prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(source.id,source.revision)) return true;
      assertMemoryAccess(access,String(current.scope_id));
    }
    return false;
  } catch { return true; }
}

/** Unknown historical sessions also require a fresh replay: legacy disclosure is unproven. */
export function continuationMemoryRevoked(threadId: string, driverInstance: string, nativeSession: string, access: MemoryAccess): boolean {
  assertMemoryAccess(access);
  if (threadId !== access.threadId) throw new Error("MEMORY_SCOPE_DENIED");
  const rows = database().prepare("SELECT * FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=?").all(threadId,driverInstance,nativeSession);
  if (!rows.length) return true;
  let invalid = false;
  for (const row of rows) if (revoked(row,access)) {
    database().prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(row.bundle_id);
    invalid = true;
  }
  return invalid;
}

/** Link every generated output, including tool-result/checkpoint message IDs where applicable.
 * A continuation's output inherits all earlier disclosures in that same native session.
 */
export function linkMemoryDisclosureOutput(bundleId: string, messageId: string) {
  if (!messageId) throw new Error("INVALID_MEMORY_OUTPUT");
  transaction(db => {
    const current = db.prepare("SELECT * FROM memory_disclosures WHERE bundle_id=?").get(bundleId);
    if (!current) throw new Error("MEMORY_DISCLOSURE_UNKNOWN");
    const rows = current.native_session
      ? db.prepare("SELECT bundle_id,output_message_ids FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=?").all(current.thread_id,current.driver_instance,current.native_session)
      : [current];
    for (const row of rows) {
      const ids: string[] = JSON.parse(String(row.output_message_ids));
      if (!ids.includes(messageId)) db.prepare("UPDATE memory_disclosures SET output_message_ids=? WHERE bundle_id=?").run(JSON.stringify([...ids,messageId]),row.bundle_id);
    }
  });
}

/** Conservatively omit complete generated messages and downstream paraphrases. Owner text
 * is never inferred dependent: only explicitly linked generated output IDs enter the set.
 */
export function filterMemoryReplay<T extends {id:string}>(threadId: string, messages: readonly T[], access: MemoryAccess): T[] {
  assertMemoryAccess(access);
  if (threadId !== access.threadId) throw new Error("MEMORY_SCOPE_DENIED");
  if (messages.length > 10000) throw new Error("MEMORY_REPLAY_LIMIT");
  if (!messages.length) return [];
  const db = database();
  const threadReceipts = new Map<string,Disclosure[]>();
  const outputs = new Map<string,string[]>();
  const memo = new Map<string,boolean>();
  let receiptCount = 0, nodes = 0;
  const charge = (count=1) => { nodes+=count; if(nodes>10000) throw new Error("MEMORY_REPLAY_LIMIT"); };
  const loadThread = (id:string) => {
    const cached=threadReceipts.get(id); if(cached)return cached;
    // Thread-leading index + LIMIT bounds reads even for a huge old history. Crossing
    // this limit requires bounded replay/checkpoint rebuilding, never unchecked replay.
    const rows=db.prepare(`SELECT bundle_id,thread_id,policy_revision,deletion_epoch,state,
      CASE WHEN length(record_versions)<=262144 THEN record_versions END AS record_versions,
      CASE WHEN length(source_versions)<=262144 THEN source_versions END AS source_versions,
      CASE WHEN length(output_message_ids)<=262144 THEN output_message_ids END AS output_message_ids
      FROM memory_disclosures WHERE thread_id=? LIMIT 2049`).all(id);
    receiptCount+=rows.length;
    if(rows.length>2048 || receiptCount>4096)throw new Error("MEMORY_REPLAY_LIMIT");
    for(const row of rows){
      if(row.record_versions===null||row.source_versions===null||row.output_message_ids===null)throw new Error("MEMORY_REPLAY_LIMIT");
      const ids:string[]=JSON.parse(String(row.output_message_ids));charge(ids.length);
      outputs.set(String(row.bundle_id),ids);
    }
    threadReceipts.set(id,rows);return rows;
  };
  const excluded = new Set<string>();
  const invalidBundles = new Set<string>();
  const visiting = new Set<string>();
  const invalid = (row:Disclosure,depth=0):boolean => {
    const id=String(row.bundle_id),known=memo.get(id);if(known!==undefined)return known;
    if(depth>64)throw new Error("MEMORY_REPLAY_LIMIT");
    if(visiting.has(id))throw new Error("MEMORY_REPLAY_LINEAGE_CYCLE");
    visiting.add(id);charge();
    let bad=row.state==="revoked" || row.policy_revision!==access.policyRevision || row.deletion_epoch!==access.deletionEpoch;
    // Only this replay's receipts are hydrated under its audience. An explicitly
    // approved shared projection does not require access to a private ancestor.
    if(!bad && row.thread_id===threadId)bad=revoked(row,access);
    if(!bad){
      const refs:Array<{id:string;version:number}>=JSON.parse(String(row.record_versions));
      const direct:Array<{id:string;revision:number}>=JSON.parse(String(row.source_versions));
      charge(refs.length+direct.length);
      const sourceIds=new Set(direct.map(source=>source.id));
      for(const source of direct){
        const current=db.prepare("SELECT state,revision FROM memory_sources WHERE id=?").get(source.id);
        if(!current||current.state!=="active"||current.revision!==source.revision){bad=true;break;}
      }
      for(const ref of refs){
        if(bad)break;
        const current=db.prepare("SELECT state FROM memory_records WHERE id=? AND version=?").get(ref.id,ref.version);
        if(!current||current.state!=="active"||db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?)").get(ref.id,ref.version)){bad=true;break;}
        const parents=db.prepare(`WITH RECURSIVE parents(id,version) AS (
          SELECT ?,? UNION SELECT d.parent_id,d.parent_version FROM memory_derivations d
          JOIN parents p ON d.child_id=p.id AND d.child_version=p.version LIMIT 1025)
          SELECT id,version FROM parents`).all(ref.id,ref.version);
        if(parents.length>1024)throw new Error("MEMORY_REPLAY_LIMIT");charge(parents.length);
        for(const parent of parents){
          const evidence=db.prepare("SELECT e.source_id,e.source_revision,s.revision,s.state FROM memory_evidence e LEFT JOIN memory_sources s ON s.id=e.source_id WHERE e.record_id=? AND e.record_version=? LIMIT 1025").all(parent.id,parent.version);
          if(evidence.length>1024)throw new Error("MEMORY_REPLAY_LIMIT");charge(evidence.length);
          for(const source of evidence){
            if(source.state!=="active"||source.revision!==source.source_revision){bad=true;break;}
            sourceIds.add(String(source.source_id));
          }
          if(bad)break;
        }
      }
      for(const sourceId of sourceIds){
        if(bad)break;
        charge();
        const source=db.prepare("SELECT thread_id,message_id,state FROM memory_sources WHERE id=?").get(sourceId);
        if(!source||source.state!=="active"){bad=true;break;}
        if(!source.thread_id||!source.message_id)continue;
        const ancestors=loadThread(String(source.thread_id)).filter(parent=>outputs.get(String(parent.bundle_id))!.includes(String(source.message_id)));
        for(const parent of ancestors)if(invalid(parent,depth+1)){bad=true;break;}
        if(bad)break;
      }
    }
    visiting.delete(id);memo.set(id,bad);if(bad)invalidBundles.add(id);return bad;
  };
  const wanted=new Set(messages.map(message=>message.id));
  for(const row of loadThread(threadId)){
    const relevant=outputs.get(String(row.bundle_id))!.filter(id=>wanted.has(id));
    if(relevant.length && invalid(row))for(const id of relevant)excluded.add(id);
  }
  assertMemoryAccess(access);
  for(const id of invalidBundles)db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(id);
  return messages.filter(message=>!excluded.has(message.id));
}
