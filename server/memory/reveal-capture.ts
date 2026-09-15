import type { DatabaseSync } from "node:sqlite";
import { database, transaction } from "../database.ts";
import { assertHumanPrincipal, isWorkspaceOwner, threadHumanPrincipal } from "../human-principals.ts";
import { redactSecretsInText } from "../redact.ts";
import { botIdentityRecordId } from "./identity.ts";
import { groundMemoryClaim, type TextOnlyExtractor } from "./extract.ts";
import { readMemoryLearning } from "./learning-policy.ts";
import type { MemoryRoster } from "./policy.ts";

type Receipt={cursor:string;status:"pending"|"complete";retryAt:number;reason?:string};
const receiptId=(jobId:string)=>`reveal-capture:${jobId}`;
function receipt(db:DatabaseSync,jobId:string):Receipt {
  const row=db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(receiptId(jobId));
  return row?JSON.parse(String(row.intent)):{cursor:"",status:"pending",retryAt:0};
}
function persist(db:DatabaseSync,jobId:string,scope:string,value:Receipt){
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','reveal-capture',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent")
    .run(receiptId(jobId),scope,JSON.stringify(value));
}
/** Startup discovery includes completed capture jobs whose callback was interrupted.
 * No parallel queue/store: existing jobs plus bounded processing metadata. */
export function pendingBotRevealJobs(limit=1):string[]{
  return database().prepare(`SELECT j.id FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision
    LEFT JOIN memory_scope_bindings b ON b.id='reveal-capture:'||j.id
    WHERE j.stage='capture' AND j.status='complete' AND s.state='active' AND s.kind='text'
    AND s.speaker NOT IN ('owner','tool','harness') AND s.speaker NOT LIKE 'person:%'
    AND (b.id IS NULL OR (json_extract(b.intent,'$.status')='pending' AND json_extract(b.intent,'$.retryAt')<=?))
    ORDER BY j.rowid LIMIT ?`).all(Date.now(),Math.min(4,Math.max(1,Math.trunc(limit)||1))).map(row=>String(row.id));
}
function sourceFor(jobId:string,roster:MemoryRoster){
  const db=database(),source=db.prepare(`SELECT s.*,v.payload,j.cursor,length(CAST(json_extract(v.payload,'$.text') AS BLOB)) AS bytes
    FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision
    JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
    WHERE j.id=? AND j.stage='capture' AND j.status='complete' AND s.state='active'`).get(jobId);
  if(!source||source.kind!=="text"||source.cursor!==source.bytes||!source.message_id)return null;
  if(db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(source.id,source.revision))return null;
  const raw=db.prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(source.thread_id,source.message_id);
  if(!raw)return null;
  const message=JSON.parse(String(raw.json)),payload=JSON.parse(String(source.payload));
  if(message.kind!=="text"||message.role!=="bot"||message.turnTerminal!==true||typeof message.text!=="string"||redactSecretsInText(message.text)!==payload.text)return null;
  const threadId=String(source.thread_id);
  if(roster.groups.some(g=>g.threadId===threadId||g.tasks?.some(t=>t.threadId===threadId)))return null;
  const bots=roster.bots.filter(b=>b.threadId===threadId||b.tasks?.some(t=>t.threadId===threadId));
  if(bots.length!==1||message.from?.botId&&message.from.botId!==bots[0].id||!["assistant",bots[0].id].includes(String(source.speaker)))return null;
  const principal=threadHumanPrincipal(threadId);assertHumanPrincipal(principal);
  if(!isWorkspaceOwner(principal))return null;
  const meta=db.prepare("SELECT mode,policy_revision,deletion_epoch FROM memory_meta WHERE id=1").get()!;
  if(!["capture","active"].includes(String(meta.mode))||db.prepare("SELECT state FROM memory_scope_bindings WHERE id='memory-roster-policy'").get()?.state!=="granted")return null;
  if(db.prepare("SELECT 1 FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings' AND e.value=?").get(threadId))return null;
  const scope=db.prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND owner_key=?").get(bots[0].id);
  if(!scope)return null;
  return {source,text:String(payload.text),botId:bots[0].id,scopeId:String(scope.id),meta,principal};
}
function liveCanon(db:DatabaseSync,scopeId:string,cursor:string){
  return db.prepare(`SELECT r.id,r.version,r.text FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version
    WHERE r.scope_id=? AND r.kind='character-canon' AND r.state='active' AND d.partition='identity' AND r.id>?
    AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.target_type='record' AND t.target_id=r.id AND (t.revision IS NULL OR t.revision=r.version))
    ORDER BY r.id LIMIT 1`).get(scopeId,cursor);
}
/** One canonical detail per visit, under the existing worker's single synthesis
 * slot. Only the whole-message equality path is deterministic; every paraphrase
 * needs the configured, budgeted grounding evaluator. No model memory-tool call
 * or supplied audience controls this observation. */
export async function captureBotReveals(jobId:string,roster:()=>MemoryRoster,extractor:TextOnlyExtractor|null,signal:AbortSignal){
  const db=database(),saved=receipt(db,jobId);
  if(saved.status==="complete")return {status:"unchanged" as const};
  const ineligible=(reason:string)=>{
    const source=db.prepare("SELECT s.scope_id FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE j.id=?").get(jobId);
    if(source)persist(db,jobId,String(source.scope_id),{...saved,status:"pending",retryAt:Date.now()+60000,reason});
    return {status:"deferred" as const,reason};
  };
  let observed:ReturnType<typeof sourceFor>;
  try{observed=sourceFor(jobId,roster());}catch{return ineligible("reveal-authority-unavailable");}
  const initial=observed;
  if(!initial)return ineligible("reveal-source-ineligible");
  const learning=readMemoryLearning(db);
  const defer=(reason:string)=>{
    persist(db,jobId,String(initial!.source.scope_id),{...saved,status:"pending",retryAt:Date.now()+60000,reason});
    return {status:"deferred" as const,reason};
  };
  if(signal.aborted||!learning.automaticFacts)return defer("reveal-learning-disabled-or-cancelled");
  const canon=liveCanon(db,initial.scopeId,saved.cursor);
  if(!canon){persist(db,jobId,String(initial.source.scope_id),{...saved,status:"complete",retryAt:0});return {status:"complete" as const};}
  if(!initial.text.trim()||Buffer.byteLength(initial.text)>65536)return defer("reveal-source-budget");
  const exact=initial.text===canon.text;
  const support=exact?{supported:true,reason:"exact-terminal-canon"}:await groundMemoryClaim({purpose:"reveal",text:String(canon.text),quote:initial.text,claimType:"reveal-state",speaker:initial.botId,outcome:"visible-terminal-message"},extractor,signal);
  if(!support.supported&&support.reason!=="unsupported-claim")return defer(support.reason);
  return transaction(()=>{
    const current=sourceFor(jobId,roster()),now=Date.now();
    if(signal.aborted||!current||current.source.revision!==initial.source.revision||current.meta.policy_revision!==initial.meta.policy_revision||current.meta.deletion_epoch!==initial.meta.deletion_epoch||JSON.stringify(current.principal)!==JSON.stringify(initial.principal)||readMemoryLearning(db).revision!==learning.revision||receipt(db,jobId).cursor!==saved.cursor)throw new Error("MEMORY_REVEAL_REVOKED");
    const currentCanon=liveCanon(db,current.scopeId,saved.cursor);
    if(!currentCanon||currentCanon.id!==canon.id||currentCanon.version!==canon.version)throw new Error("MEMORY_REVEAL_CANON_CHANGED");
    let written=false;
    if(support.supported){
      const id=botIdentityRecordId(current.botId,"reveal-state",String(canon.id));
      const previous=db.prepare("SELECT * FROM memory_records WHERE id=? ORDER BY version DESC LIMIT 1").get(id);
      const tombstoned=db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=?").get(id);
      const previousCanon=previous&&db.prepare("SELECT parent_id,parent_version FROM memory_derivations WHERE child_id=? AND child_version=? AND parent_id=?").get(id,previous.version,canon.id);
      // Repeated disclosure adds no duplicate version. Explicit owner changes,
      // pins and forgetting are never overwritten by the automatic observer.
      if(!tombstoned&&(!previous||previous.assertion!=="owner-statement"&&previous.owner_pinned!==1&&previous.state==="active"&&previousCanon?.parent_version!==canon.version)){
        const version=Number(previous?.version??0)+1,state=learning.reviewMode?"candidate":"active";
        if(previous)db.prepare("UPDATE memory_records SET state='superseded',valid_to=? WHERE id=? AND version=?").run(now,id,previous.version);
        const text=JSON.stringify({canonId:canon.id,canonVersion:canon.version,audience:"owner-private",revealed:true,note:`Observed disclosure of fictional canon: ${String(canon.text)}`});
        db.prepare("INSERT INTO memory_records VALUES(?,?,?,'reveal-state',?,'assistant-inference',?,0,?,NULL,?,?)").run(id,version,current.scopeId,text,state,now,previous?id:null,now);
        db.prepare("UPDATE memory_record_details SET partition='identity',attention='current',confidence_basis=?,entities=? WHERE record_id=? AND record_version=?")
          .run(`Observed terminal disclosure (${support.reason}); fictional continuity only, not world truth`,JSON.stringify(["owner-private",canon.id]),id,version);
        db.prepare("INSERT INTO memory_derivations VALUES(?,?,?,?)").run(canon.id,canon.version,id,version);
        db.prepare("INSERT INTO memory_evidence VALUES(?,?,?,?,0,?)").run(id,version,current.source.id,current.source.revision,Buffer.byteLength(current.text));
        db.prepare("INSERT INTO memory_projection_receipts VALUES(?,?,0,'pending','pending',NULL)").run(id,version);
        db.exec("UPDATE memory_meta SET data_revision=data_revision+1,policy_revision=policy_revision+1; UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked'");
        written=true;
      }
    }
    persist(db,jobId,String(current.source.scope_id),{cursor:String(canon.id),status:"pending",retryAt:0});
    return {status:"partial" as const,written,canonId:String(canon.id)};
  });
}
