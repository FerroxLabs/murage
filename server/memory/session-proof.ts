// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-s1s2g. Consumer owners: recall-s1s2g (direct/room dispatch), warm-keep (continuation).
import type { FreshReplaySessionConfirmation } from './fresh-replay-session.ts';
import { database, onDatabaseClose } from '../database.ts';
import { heldStep } from '../observe.ts';
import { authorityParts } from './authority-epoch.ts';
import { continuationSessionVerdict } from './continuation-settle.ts';
import { denyGeneration, doorEpochVerdict, memoryLookup } from './deny-read.ts';
import { revokedReason, readerAudience, ownerDirectChat, type Seen } from './disclosures.ts';
import { accessIncludesRoom, assertMemoryAccess, inMemoryAccessPass, lineageReaderAudience, memoryAccessIsOwnerAudience, memoryAccessNotOwnerAudience, type MemoryAccess } from './policy.ts';
import { recallViewContains, type RecallViewHandle } from './recall-view.ts';
import { isLineageLimit, outputRootsBad, preLineageSessionRevoked, sendReplaySessionCurrent, sessionLineageBad, sessionOutputRoots } from './replay-lineage.ts';
import { LineageAllowance, withSecondLook } from './lineage-allowance.ts';
import type { LineageReader, MemoryRef, SessionKey } from './lineage-types.ts';
import { SESSION_LOG_KEEP, sessionHadFrame } from './session-proof-schema.ts';
import { readTimeRetired } from './read-time-retired.ts';
import { sessionKeyOf } from './session-incarnation.ts';

export type SessionProof = {kind:'resume'} | {kind:'fresh';reason:string;cause:'denied'|'checking'|'overflow'|'no-proof';detail?:string};
export type SessionProofContext = {access:MemoryAccess;disclosed?:boolean}|{access:undefined;reader:LineageReader;disclosed?:boolean;room?:boolean};
export const SESSION_PROOF=Object.freeze({NEW_RECEIPTS_MAX:64,LOG_SCAN_MAX:4096,CITE_REPROOF_MAX:1024,FOOTPRINT_MAX:32,COLD_ROWS_MAX:1024,LOG_KEEP:SESSION_LOG_KEEP});
let meter={rows:0,seeks:0,path:''};
export function sessionProofMeter(){return {...meter};}
let commitError:unknown;
let commitFault:(()=>void)|undefined;
export function setSessionProofCommitFaultForTest(hook:(()=>void)|undefined){commitFault=hook;}
const fresh=(reason:string,cause:Extract<SessionProof,{kind:'fresh'}>['cause']='denied',detail?:string):SessionProof=>({kind:'fresh',reason,cause,...(detail?{detail}:{})});
const values=(key:SessionKey)=>[key.threadId,key.driverInstance,key.nativeSession] as const;
const readerKey=(a:MemoryAccess)=>JSON.stringify([a.botId,a.humanPrincipal,memoryAccessIsOwnerAudience(a),memoryAccessNotOwnerAudience(a),a.policyRevision,a.deletionEpoch]);
interface Check {
 up_to:number;log_seq:number;recall_epoch:number;view_id:string|null;view_generation:string|null;view_digest:string|null;
 policy_revision:number;deletion_epoch:number;footprint:string;cites:number;seeding:number;checked:number;
}
// A live turn may give idle maintenance its remaining opportunity to seed. Never
// mint access for maintenance: a dead turn capability cannot authorize hydration.
const seedAccesses=new Map<string,MemoryAccess>();
let closeHooked=false,seedAfter='';
function rememberAccess(access:MemoryAccess){
 if(!closeHooked){closeHooked=true;onDatabaseClose(()=>{seedAccesses.clear();seedAfter='';});}
 const key=JSON.stringify([access.botId,access.threadId]);seedAccesses.delete(key);seedAccesses.set(key,access);
 if(seedAccesses.size>128)seedAccesses.delete(seedAccesses.keys().next().value!);
}

/** The only retained-session decision. Every miss is an authorized fresh replay. */
export function proveRetainedSession(allowance:LineageAllowance,key:SessionKey,ctx:SessionProofContext):SessionProof {
 if(ctx.access&&key.threadId!==ctx.access.threadId)throw new Error('MEMORY_SCOPE_DENIED');
 return prove(allowance,key,ctx,false);
}
export function proveRetainedSessionAtSubmission(allowance:LineageAllowance,key:SessionKey,ctx:{access:MemoryAccess;disclosed?:boolean},confirmation:FreshReplaySessionConfirmation):SessionProof {
 if(key.threadId!==ctx.access.threadId)throw new Error('MEMORY_SCOPE_DENIED');
 return prove(allowance,key,ctx,false,false,()=>confirmation.submissionSessionCurrent(key,ctx.access.generation));
}
function prove(allowance:LineageAllowance,key:SessionKey,ctx:SessionProofContext,seeding:boolean,birth=false,submissionCurrent?:()=>boolean,initialFrame=false):SessionProof {
 meter={rows:0,seeks:0,path:ctx.access?'proof':'recall-free'};
 let result:SessionProof={kind:'resume'};
 const why:{reason?:string}={};
 heldStep('memory.session-check',()=>withSecondLook(allowance,why,a=>{
  try { result=inMemoryAccessPass(()=>proofWork(a,key,ctx,seeding,birth,submissionCurrent,initialFrame)); }
  catch(error) {
   if(isLineageLimit(error)||a.hit)result=fresh('lineage-warming','checking');
   else if(error===commitError){commitError=undefined;throw error;}
   else if(error instanceof Error && error.message==='MEMORY_SCOPE_DENIED')result=fresh('scope-left-view');
   else result=fresh('check-failed','checking');
  }
  if(result.kind==='fresh')why.reason=result.cause==='checking'?'lineage-warming':result.reason;
  return result.kind==='fresh';
 }));
 return result;
}
function proofWork(a:LineageAllowance,key:SessionKey,ctx:SessionProofContext,seeding:boolean,birth:boolean,submissionCurrent?:()=>boolean,initialFrame=false):SessionProof {
 const db=database(),thread=key.threadId,args=values(key);
 // All local SQL reads reserve and pay their ceiling BEFORE touching SQLite.
 const one=(sql:string,...params:Array<string|number|null>)=>{a.spendRows(thread,1);meter.seeks++;return db.prepare(sql).get(...params);};
 const page=(limit:number,sql:string,...params:Array<string|number|null>)=>{a.reserveRows(thread,limit);const rows=db.prepare(sql).all(...params);a.spendRows(thread,rows.length);meter.rows+=rows.length;return rows;};
 const access=ctx.access;
 if(access && thread!==access.threadId)throw new Error('MEMORY_SCOPE_DENIED');
 a.spendNodes(thread,1);meter.seeks++;
 // Room sessions have no direct replay certificate. sendReplaySessionCurrent
 // also consults install-wide direct replay epochs, so it is direct-only.
 if(!birth && (access?!accessIncludesRoom(access):!ctx.room) && !sendReplaySessionCurrent(thread,key.driverInstance,key.nativeSession)) {
  // Recall-free room keys are identified from durable room scope authority,
  // never from a caller-supplied audience flag.
  const view=!access?ctx.reader.audience?.view:undefined;
  const room=view&&one('SELECT 1 FROM memory_recall_views WHERE view_id=? AND generation=? AND room_reader=1',view.viewId,view.generation);
  if(!room&&!(access&&!accessIncludesRoom(access)&&submissionCurrent?.()))return fresh('send-replay-changed');
 }
 a.spendNodes(thread,1);meter.seeks++;
 const door=doorEpochVerdict(db,key);
 // S3 precedes the door diagnostic: no lineage must always be explicit.
 const lineage=one('SELECT first_lsn,last_lsn FROM memory_session_lineage WHERE thread_id=? AND driver_instance=? AND native_session=?',...args);
 if(!lineage)return fresh('no-session-lineage','no-proof');
 if(door.state!=='shown')return fresh('writetime-door-epoch',door.state==='checking'?'checking':'denied');
 a.spendNodes(thread,1);meter.seeks++;
 const reader=access?(ownerDirectChat(thread,access)?{audience:null}:{audience:lineageReaderAudience(access)}):ctx.reader;
 {
  const verdict=continuationSessionVerdict(db,key,reader,a);
  if(verdict.state==='withheld'&&verdict.reason==='deny-session'&&access&&!memoryAccessNotOwnerAudience(access)) {
   assertMemoryAccess(access);
   // A session refusal precedes the tail proof; persist only positively denied receipt content within that same allowance.
   try {
    const receipts=page(SESSION_PROOF.NEW_RECEIPTS_MAX,'SELECT bundle_id,record_versions,source_versions,state FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? ORDER BY rowid DESC LIMIT ?',...args,SESSION_PROOF.NEW_RECEIPTS_MAX);
    for(const receipt of receipts) {
     if(receipt.state==='revoked')continue;
     const records=JSON.parse(String(receipt.record_versions)),sources=JSON.parse(String(receipt.source_versions));
     if(!Array.isArray(records)||!Array.isArray(sources)||records.length>256||sources.length>1024)continue;
     const refs:MemoryRef[]=[...records.map(r=>({kind:'record' as const,id:r.id,version:r.version})),...sources.map(s=>({kind:'source' as const,id:s.id,version:s.revision}))];
     a.spendNodes(thread,refs.length+1);
     if([...memoryLookup(db,refs,reader).values()].some(v=>v.state==='withheld'))db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=? AND state!='revoked'").run(receipt.bundle_id);
    }
   }catch { /* incomplete bookkeeping never changes the proven session refusal */ }
  }
  if(verdict.state!=='shown')return fresh(verdict.state==='checking'?'checking':`writetime-${verdict.reason}`,verdict.state==='checking'?'checking':'denied',verdict.reason);
 }
 const hasReceipt=!!one('SELECT 1 FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? LIMIT 1',...args);
 if(!access) {
  if(ctx.disclosed||hasReceipt
   ||one('SELECT 1 FROM memory_receipt_lines WHERE session_no=(SELECT no FROM memory_session_no WHERE thread_id=? AND driver_instance=? AND native_session=?) LIMIT 1',...args)
   ||(one("SELECT 1 FROM sqlite_schema WHERE name='memory_session_roots'")&&one("SELECT 1 FROM memory_session_roots WHERE thread_id=? AND driver_instance=? AND native_session=? AND set_id!='' LIMIT 1",...args)))return fresh('held-session-holds-recall','no-proof');
  a.spendRows(thread,1);meter.seeks++;const hadFrame=sessionHadFrame(db,key);
  if(hadFrame===true)return fresh('held-session-holds-recall','no-proof');
  if(hadFrame===undefined||ctx.disclosed===undefined)return fresh('no-receipts','no-proof');
  return {kind:'resume'};
 }
 assertMemoryAccess(access);rememberAccess(access);
 const rk=readerKey(access);
 let check=one('SELECT * FROM memory_session_checks WHERE thread_id=? AND driver_instance=? AND native_session=? AND reader_key=?',...args,rk) as unknown as Check|undefined;
 // An invalidated session must finish bounded reclamation before its shared dependent rows can seed a new proof.
 if(!check&&!one('SELECT 1 FROM memory_session_checks WHERE thread_id=? AND driver_instance=? AND native_session=? LIMIT 1',...args)
  &&(one('SELECT 1 FROM memory_session_check_cites WHERE thread_id=? AND driver_instance=? AND native_session=? LIMIT 1',...args)
   ||one('SELECT 1 FROM memory_session_check_messages WHERE thread_id=? AND driver_instance=? AND native_session=? LIMIT 1',...args)))return fresh('session-proof-cleanup','checking');
 const state=one('SELECT had_frame FROM memory_session_state WHERE thread_id=? AND driver_instance=? AND native_session=?',...args);
 const hadFrame=state?Number(state.had_frame)!==0:undefined;
 // MAIN RULING 1115-RECALL-GROK-Q1Q2: an empty provider event is only a bit,
 // never a checkpoint. Prove all three absence claims even after a crash.
 const receiptLine=!!one('SELECT 1 FROM memory_receipt_lines WHERE session_no=(SELECT no FROM memory_session_no WHERE thread_id=? AND driver_instance=? AND native_session=?) LIMIT 1',...args);
 const nonemptyRoots=!!one("SELECT 1 FROM memory_session_roots WHERE thread_id=? AND driver_instance=? AND native_session=? AND set_id!='' LIMIT 1",...args);
 if(!check&&!birth) {
  if(!hasReceipt&&hadFrame===false&&!receiptLine&&!nonemptyRoots)return {kind:'resume'};
  if(!hasReceipt)return fresh('no-receipts','no-proof');
 }
 if(!hasReceipt&&ctx.disclosed===true&&(!check||check.up_to>0||hadFrame!==false))return fresh('no-receipts','no-proof');
 if(hasReceipt&&!check&&hadFrame===undefined)return fresh('upgrade-session-holds-recall','no-proof');
 const epoch=()=>Number(one('SELECT epoch FROM memory_recall_epoch WHERE id=1')?.epoch);
 const seq=()=>Number(one('SELECT coalesce(max(seq),0) AS seq FROM memory_session_change_log')?.seq);
 const before={deny:denyGeneration(db),epoch:epoch(),seq:seq(),parts:authorityParts()};
 let footprint:Set<string>|'wide'=check?(JSON.parse(check.footprint)==='wide'?'wide':new Set<string>(JSON.parse(check.footprint))):new Set<string>();
 if(check) {
  if(check.policy_revision!==access.policyRevision||check.deletion_epoch!==access.deletionEpoch)return fresh('writetime-watermark');
  if(check.recall_epoch!==before.epoch || check.view_digest!==access.view.digest) {
   const prior:RecallViewHandle|undefined=check.view_id&&check.view_generation&&check.view_digest?{viewId:check.view_id,generation:check.view_generation,digest:check.view_digest}:undefined;
   a.spendRows(thread,1);meter.seeks++;
   if(!prior||!recallViewContains(db,access.view,prior)) {
    if(footprint==='wide')return fresh('footprint-wide','checking');
    for(const scope of footprint)assertMemoryAccess(access,scope);
   }
  }
  const min=Number(one('SELECT coalesce(min(seq),0) AS seq FROM memory_session_change_log')?.seq);
  const trimmed=check.log_seq<min-1,span=before.seq-check.log_seq;
  if(trimmed||span>SESSION_PROOF.LOG_SCAN_MAX) {
   // MAIN RULING 1115-RECALL-DESIGN-GROK: neither trimmed history nor
   // an oversized log can prove that held cross-room lines stayed visible.
   if(check.cites>SESSION_PROOF.CITE_REPROOF_MAX)return fresh('cite-overflow','overflow');
   if(check.cites>0 || Number(lineage.last_lsn)>0)return fresh('change-log-span','overflow');
  } else if(span>0) {
   const changes=page(span,'SELECT id FROM memory_session_change_log WHERE seq>? ORDER BY seq LIMIT ?',check.log_seq,SESSION_PROOF.LOG_SCAN_MAX);
   for(const change of changes) {
    const id=String(change.id),at=id.indexOf(':'),kind=id.slice(0,at),ref=id.slice(at+1);
    let relevant=false;
    if(kind==='record'||kind==='source') {
     const cite=one('SELECT bundle_id FROM memory_session_check_cites WHERE thread_id=? AND driver_instance=? AND native_session=? AND kind=? AND ref_id=? LIMIT 1',...args,kind,ref);
     relevant=!!cite;
     if(cite&&!memoryAccessNotOwnerAudience(access))db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=? AND thread_id=? AND driver_instance=? AND native_session=? AND state!='revoked'").run(cite.bundle_id,...args);
    }
    else if(kind==='receipt')relevant=!!one('SELECT 1 FROM memory_disclosures WHERE bundle_id=? AND thread_id=? AND driver_instance=? AND native_session=?',ref,...args);
    else if(kind==='deny-thread')relevant=ref===thread || !!one('SELECT 1 FROM memory_session_check_messages WHERE thread_id=? AND driver_instance=? AND native_session=? AND source_thread=? LIMIT 1',...args,ref) || !!one('SELECT 1 FROM memory_thread_flow WHERE from_thread=? AND to_thread=? AND first_lsn<=?',ref,thread,Number(lineage.last_lsn));
    else if(kind==='deny-scope')relevant=footprint==='wide'||footprint.has(ref);
    else if(kind==='line') {
     const split=ref.indexOf('\u0000'),from=ref.slice(0,split),message=ref.slice(split+1);
     if(split<0)return fresh('changed:line');
     if(from===thread){const held=one('SELECT lsn FROM memory_line_lineage WHERE thread_no=(SELECT no FROM memory_thread_no WHERE thread_id=?) AND message_id=?',thread,message);relevant=!held||Number(held.lsn)<=Number(lineage.last_lsn);}
     else relevant=false;
     relevant=relevant || !!one('SELECT 1 FROM memory_session_check_messages WHERE thread_id=? AND driver_instance=? AND native_session=? AND source_thread=? AND message_id=?',...args,from,message) || !!one('SELECT 1 FROM memory_thread_flow WHERE from_thread=? AND to_thread=? AND first_lsn<=?',from,thread,Number(lineage.last_lsn));
     if(relevant){const line=one('SELECT json FROM messages WHERE thread_id=? AND id=?',from,message);if(line&&JSON.parse(String(line.json)).withheldFromBots==='checking')return fresh('checking','checking');}
    } else return fresh('change-log-unknown','checking');
    if(relevant)return fresh(`changed:${kind}`);
   }
  }
 }
 const cold=seeding||!check||check.seeding===1,limit=cold?SESSION_PROOF.COLD_ROWS_MAX:SESSION_PROOF.NEW_RECEIPTS_MAX;
 meter.path=cold?'cold':'incremental';
 const rows=page(limit+1,'SELECT rowid AS rid,bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,policy_revision,deletion_epoch,state,created_at FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? AND rowid>? ORDER BY rowid LIMIT ?',...args,check?.up_to??0,limit+1);
 if(!cold&&rows.length>limit)return fresh('new-receipts-overflow','overflow');
 const more=rows.length>limit;
 const seen:Seen={records:new Set(),sources:new Set()},cites:Array<{kind:string;id:string;version:number;bundleId:string}>=[];
 let upTo=check?.up_to??0;
 const messages=new Map<string,{thread:string;id:string}>();
 const recordSources=new Map<string,string[]>(),scopes=new Map<string,string>();
 const checkedSources=new Set<string>();
 for(const row of rows.slice(0,limit)) {
  const recordRefs=JSON.parse(String(row.record_versions)),sourceRefs=JSON.parse(String(row.source_versions));
  if(!Array.isArray(recordRefs)||!Array.isArray(sourceRefs)||recordRefs.length>256||sourceRefs.length>1024)return fresh('receipt-cite-overflow','overflow');
  if(check&&check.up_to>0)for(const record of recordRefs) {
   const ref=`${record.id}@${record.version}`;
   if(!seen.records.has(ref)&&one("SELECT 1 FROM memory_session_check_cites c JOIN memory_disclosures d ON d.bundle_id=c.bundle_id WHERE c.thread_id=? AND c.driver_instance=? AND c.native_session=? AND c.kind='record' AND c.ref_id=? AND c.ref_version=? AND d.rowid<=?",...args,record.id,record.version,check.up_to))seen.records.add(ref);
  }
  const reason=revokedReason(a,row,access,seen);
  if(reason) {
   if(reason.includes('MEMORY_SCOPE_DENIED'))return fresh('scope-left-view');
   if(!memoryAccessNotOwnerAudience(access))db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=? AND state!='revoked'").run(row.bundle_id);
   return fresh(`memory-changed (${reason})`);
  }
  // Cold receipts must prove their cited messages even when the old read-time
  // judge has retired. Warm receipts also collect these identities for P3c.
  const sourceIds=new Set<string>(sourceRefs.map((r:{id:string})=>r.id));
  for(const record of recordRefs) {
   const ref=JSON.stringify([record.id,record.version]);
   let evidence=recordSources.get(ref);
   if(!evidence){evidence=page(1025,'SELECT source_id FROM memory_evidence WHERE record_id=? AND record_version=? LIMIT 1025',record.id,record.version).map(row=>String(row.source_id));recordSources.set(ref,evidence);}
   for(const id of evidence)sourceIds.add(id);
  }
  if(sourceIds.size>1024)return fresh('receipt-cite-overflow','overflow');
  for(const id of sourceIds) {
   if(checkedSources.has(id))continue;checkedSources.add(id);
   const source=one('SELECT thread_id,message_id FROM memory_sources WHERE id=?',id);
   if(!source)return fresh('memory-changed');
   if(source.thread_id===null&&source.message_id===null)continue; // non-message source
   if(typeof source.thread_id!=='string'||typeof source.message_id!=='string')return fresh('cold-withhold-unproven','no-proof');
   messages.set(JSON.stringify([source.thread_id,source.message_id]),{thread:source.thread_id,id:source.message_id});
   const message=one('SELECT json FROM messages WHERE thread_id=? AND id=?',source.thread_id,source.message_id);
   const line=one('SELECT lsn FROM memory_line_lineage WHERE thread_no=(SELECT no FROM memory_thread_no WHERE thread_id=?) AND message_id=?',source.thread_id,source.message_id);
   if(!message||!line)return fresh('cold-withhold-unproven','no-proof');
   const withheld=JSON.parse(String(message.json)).withheldFromBots;
   if(withheld==='checking')return fresh('checking','checking');
   if(withheld)return fresh('changed:line');
  }
  for(const kind of ['record','source'] as const) {
   const refs=JSON.parse(String(row[kind==='record'?'record_versions':'source_versions'])) as Array<{id:string;version?:number;revision?:number}>;
   if(refs.length>(kind==='record'?256:1024))return fresh('receipt-cite-overflow','overflow');
   for(const ref of refs) {
    cites.push({kind,bundleId:String(row.bundle_id),id:ref.id,version:Number(kind==='record'?ref.version:ref.revision)});
    const citeKey=JSON.stringify([kind,ref.id,kind==='record'?ref.version:ref.revision]);
    let scope=scopes.get(citeKey);
    if(scope===undefined){
     const current=one(`SELECT scope_id FROM ${kind==='record'?'memory_records':'memory_sources'} WHERE id=?${kind==='record'?' AND version=?':''}`,ref.id,...(kind==='record'?[Number(ref.version)]:[]));
     if(!current)return fresh('memory-changed');scope=String(current.scope_id);scopes.set(citeKey,scope);
    }
    assertMemoryAccess(access,scope);
    if(footprint!=='wide'){footprint.add(scope);if(footprint.size>SESSION_PROOF.FOOTPRINT_MAX)footprint='wide';}
   }
  }
  upTo=Number(row.rid);
 }
 if(cold&&hasReceipt&&readTimeRetired(db)&&!birth&&!initialFrame&&!check)return fresh('cold-withhold-unproven','no-proof');
 if(!more) {
  const bad=new Set<string>();
  if(sessionLineageBad(a,thread,key.driverInstance,key.nativeSession,ownerDirectChat(thread,access)?null:readerAudience(a,access,seen),bad)) {
   if(!a.hit&&!memoryAccessNotOwnerAudience(access))for(const id of bad)db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(id);
   return fresh(a.hit?'lineage-warming':'lineage',a.hit?'checking':'denied');
  }
  const roots=sessionOutputRoots(a,thread,key.driverInstance,key.nativeSession),why:{reason?:string}={};
  if(roots.over)return fresh(roots.unproven?'lineage-warming':'root-ceiling','checking');
  if(outputRootsBad(a,roots,why))return fresh(a.hit?'lineage-warming':'session-roots',a.hit?'checking':'denied');
  if(preLineageSessionRevoked(rows.length?rows:hasReceipt?[{}]:[],thread,key.driverInstance,key.nativeSession))return fresh('pre-lineage');
 }
 const after={deny:denyGeneration(db),epoch:epoch(),seq:seq(),parts:authorityParts()};
 if(!db.isTransaction&&before.deny===after.deny&&before.epoch===after.epoch&&before.seq===after.seq&&before.parts?.stamp===after.parts?.stamp) {
  // Recheck benign log tails; coalesce their writes until 64 changes or the liveness refresh.
  if(check && check.seeding===0 && rows.length===0 && before.seq>=check.log_seq && before.seq-check.log_seq<64 && check.recall_epoch===before.epoch
   && check.view_id===access.view.viewId && check.view_generation===access.view.generation && check.view_digest===access.view.digest
   && Date.now()-check.checked<60_000)return {kind:'resume'};
  const lockGuard=one('SELECT total_changes() AS writes,(SELECT data_version FROM pragma_data_version) AS version');
  try{commitFault?.();}catch(error){commitError=error;throw error;}
  db.exec('BEGIN IMMEDIATE');
  try {
   // Re-read under the writer lock: another connection cannot slip a change
   // between the generation comparison and this checkpoint's commit.
   const locked=one('SELECT total_changes() AS writes,(SELECT data_version FROM pragma_data_version) AS version');
   if(before.deny===denyGeneration(db)&&before.epoch===epoch()&&before.seq===seq()&&lockGuard?.writes===locked?.writes&&lockGuard?.version===locked?.version) {
    const insert=db.prepare('INSERT OR IGNORE INTO memory_session_check_cites VALUES(?,?,?,?,?,?,?)');
    let count=Number(one('SELECT cites FROM memory_session_checks WHERE thread_id=? AND driver_instance=? AND native_session=? LIMIT 1',...args)?.cites??0);
    for(const c of cites)count+=Number(insert.run(...args,c.kind,c.id,c.version,c.bundleId).changes);
    for(const message of messages.values())db.prepare('INSERT OR IGNORE INTO memory_session_check_messages VALUES(?,?,?,?,?)').run(...args,message.thread,message.id);
    db.prepare(`INSERT INTO memory_session_checks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(thread_id,driver_instance,native_session,reader_key) DO UPDATE SET
     up_to=excluded.up_to,log_seq=excluded.log_seq,recall_epoch=excluded.recall_epoch,view_id=excluded.view_id,view_generation=excluded.view_generation,view_digest=excluded.view_digest,
     policy_revision=excluded.policy_revision,deletion_epoch=excluded.deletion_epoch,footprint=excluded.footprint,cites=excluded.cites,seeding=excluded.seeding,checked=excluded.checked`)
     .run(...args,rk,upTo,before.seq,before.epoch,access.view.viewId,access.view.generation,access.view.digest,access.policyRevision,access.deletionEpoch,JSON.stringify(footprint==='wide'?'wide':[...footprint]),count,more?1:0,Date.now());
   }
   db.exec('COMMIT');
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
 }
 if(more)return fresh('session-seeding','checking');
 void seeding;
 return {kind:'resume'};
}
/** One bounded session slice, only while a genuine turn capability is live. */
export function seedSessionChecksSlice(access?:MemoryAccess):SessionProof|undefined {
 const live=access??seedAccesses.values().next().value;
 if(!live)return;
 try{assertMemoryAccess(live);}catch{seedAccesses.delete(JSON.stringify([live.botId,live.threadId]));return;}
 const db=database();
 const row=db.prepare(`SELECT s.driver_instance,s.native_session FROM memory_session_lineage s
 WHERE s.thread_id=? AND s.native_session>? AND EXISTS(SELECT 1 FROM memory_disclosures d WHERE d.thread_id=s.thread_id AND d.driver_instance=s.driver_instance AND d.native_session=s.native_session) AND NOT EXISTS(SELECT 1 FROM memory_session_checks c WHERE c.thread_id=s.thread_id AND c.driver_instance=s.driver_instance AND c.native_session=s.native_session AND c.reader_key=? AND c.seeding=0 AND NOT EXISTS(SELECT 1 FROM memory_disclosures d WHERE d.thread_id=s.thread_id AND d.driver_instance=s.driver_instance AND d.native_session=s.native_session AND d.rowid>c.up_to))
 ORDER BY s.native_session LIMIT 1`).get(live.threadId,seedAfter,readerKey(live));
 if(!row){seedAfter='';return;}
 const result=prove(LineageAllowance.tool(),sessionKeyOf(live.threadId,String(row.driver_instance),String(row.native_session)),{access:live,disclosed:false},true);
 if(result.kind==='resume')seedAfter=String(row.native_session);
 return result;
}

/** Establish the real reader checkpoint for a known empty session or its
 * first live frame. Retained sessions keep ordinary S1 (or the submission-only
 * certificate); durable frame/receipt/root evidence can never acquire this privilege. */
export function initializeFreshSessionProof(key:SessionKey,access:MemoryAccess,bindFrame?:()=>void,options:{fresh?:boolean;confirmation?:FreshReplaySessionConfirmation}={}):void {
 const db=database(),args=values(key);
 const birth=options.fresh===true&&options.confirmation?.firstFrameSessionCurrent(key,access.generation)===true;
 // A positively fresh S6 incarnation can already carry the conservative
 // frame bit written before binding. Only its live event (never a restored
 // bit or a retained cursor) may initialize that first real frame via P6.
 if(sessionHadFrame(db,key)!==false&&!(birth&&bindFrame)){bindFrame?.();return;}
 // The live fresh event may bind its own first frame and immediately prove it.
 // A durable false bit alone can never bless pre-existing carried recall.
 const carried=db.prepare(`SELECT 1 FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=?
  UNION ALL SELECT 1 FROM memory_receipt_lines WHERE session_no=(SELECT no FROM memory_session_no WHERE thread_id=? AND driver_instance=? AND native_session=?)
  UNION ALL SELECT 1 FROM memory_session_roots WHERE thread_id=? AND driver_instance=? AND native_session=? AND set_id!='' LIMIT 1`).get(...args,...args,...args);
 bindFrame?.();
 if(carried)return;
 prove(LineageAllowance.tool(),key,{access,disclosed:false},false,birth,options.confirmation?()=>options.confirmation!.submissionSessionCurrent(key,access.generation):undefined,true);
}
