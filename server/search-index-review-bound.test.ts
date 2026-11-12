// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { afterEach, it, vi } from 'vitest';
import { expect } from "./testing/search-index-oracle.ts";
import { DATA_DIR } from './config.ts';
import { database, closeDatabase } from './database.ts';
import { appendMessage, insertMessage, setActiveLeaf, updateMessage } from './message-db.ts';
import { MESSAGE_SEARCH_DDL } from './testing/search-index-compat.ts';
import * as search from './testing/search-index-compat.ts';
import { stopWalMaintenance } from './wal-maintenance.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
import { drainRevokeMarker } from './memory/memory-revocation.ts';
import { resetRevokeWriteBudget } from './memory/revoke-budget.ts';
const turnFault=vi.hoisted(()=>{vi.resetModules();return{persistent:false};});
vi.mock('node:worker_threads',async original=>{
 const module=await original<typeof import('node:worker_threads')>();
 return {...module,Worker:class extends module.Worker {
  constructor(source:string,options:import('node:worker_threads').WorkerOptions){
   if(turnFault.persistent)source=source.replace("    if (message.type !== 'step' || resetWaiting) return;", "    if (message.type !== 'step' || resetWaiting) return;throw Error('fixture parked turn');");
   super(source,options);
  }
 }};
});
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
let held:Int32Array|undefined;
afterEach(async()=>{if(held){Atomics.store(held,0,0);Atomics.notify(held,0);}search.searchIndexTestHooks.barrier=null;search.searchIndexTestHooks.event=null;await search.stopSearchIndex();closeDatabase();await stopWalMaintenance();});
function captureQueryPlans(){
  const sql:string[]=[];const evidenceVisits:number[]=[];let enabled=false;
  const plans:Array<{sql:string;details:string[];error?:string}>=[];
  const connections=new WeakMap<StatementSync,DatabaseSync>();
  const prototype=DatabaseSync.prototype,prepare=prototype.prepare,exec=prototype.exec;
  const probe=new DatabaseSync(':memory:');
  const statementPrototype=Object.getPrototypeOf(probe.prepare('SELECT 1')) as StatementSync;probe.close();
  const methods=new Map<string,PropertyDescriptor>();
  let explaining=false;
  const explain=(connection:DatabaseSync,text:string,args:unknown[])=>{
   if(!enabled)return;
   sql.push(text);
   try{
    explaining=true;
    const plan=prepare.call(connection,'EXPLAIN QUERY PLAN '+text);
    const rows=Reflect.apply(statementPrototype.all,plan,args) as Array<{detail:string}>;
    plans.push({sql:text,details:rows.map(row=>row.detail)});
   }catch(error){plans.push({sql:text,details:[],error:String(error)});}
   finally{explaining=false;}
  };
  // Prototype interception includes cached statements prepared by the warm-up,
  // and the owner's separate search reader. EXPLAIN uses the actual bindings.
  prototype.prepare=function(text:string){const statement=prepare.call(this,text);connections.set(statement,this);return statement;};
  for(const method of ['run','get','all','iterate'] as const){
   const descriptor=Object.getOwnPropertyDescriptor(statementPrototype,method)!;
   methods.set(method,descriptor);
   Object.defineProperty(statementPrototype,method,{...descriptor,value:function(this:StatementSync,...args:unknown[]){
    if(!explaining)explain(connections.get(this)!,this.sourceSQL,args);
    const result=Reflect.apply(descriptor.value,this,args);
    if(enabled&&!explaining&&this.sourceSQL.startsWith('SELECT rowid FROM memory_evidence WHERE rowid')&&Array.isArray(result))evidenceVisits.push(result.length);
    return result;
   }});
  }
  prototype.exec=function(text:string){
   // SQLite identifies each statement's exact source span, including quoted
   // semicolons. Do not silently plan only the first statement of an exec batch.
   let remaining=enabled?text:'';
   while(remaining.trim()){
    const statement=prepare.call(this,remaining),source=statement.sourceSQL;
    if(!source.length)throw Error('empty SQL source span');
    explain(this,source,[]);remaining=remaining.slice(source.length);
   }
   return exec.call(this,text);
  };
  return {sql,plans,evidenceVisits,start(){sql.length=0;plans.length=0;evidenceVisits.length=0;enabled=true;},stop(){enabled=false;},restore(){enabled=false;prototype.exec=exec;prototype.prepare=prepare;for(const [method,descriptor]of methods)Object.defineProperty(statementPrototype,method,descriptor);}};
}
// Permit only fixed metadata and bounded transient rowsets. All table/index
// scans (including aliased history tables and covering indexes) are rejected.
const fixedScans=new Set(['SCAN CONSTANT ROW','SCAN sqlite_schema','SCAN temp.identity_epoch','SCAN pragma_data_version VIRTUAL TABLE INDEX 0:','SCAN e VIRTUAL TABLE INDEX 3:','SCAN (subquery-1)']);
function historyScans(plans:Array<{sql:string;details:string[]}>) {
 return plans.flatMap(plan=>plan.details.filter(detail=>/\bSCAN\b/.test(detail)&&!fixedScans.has(detail)).map(detail=>({sql:plan.sql,detail})));
}
function seedEvidence(db:DatabaseSync,n:number) {
 db.exec("INSERT INTO memory_scopes VALUES('e-history','conversation','fixture','[]',1)");
 db.exec("INSERT INTO memory_sources VALUES('e-source','e-history','e-history','message',NULL,1,'fixture','text','user','settled',NULL,'active')");
 db.exec("INSERT INTO memory_source_versions VALUES('e-source',1,'fixture','{}',1)");
 db.exec("INSERT INTO memory_records VALUES('e-record',1,'e-history','fact','fixture','owner-statement','active',0,1,NULL,NULL,1)");
 db.prepare("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO memory_evidence SELECT 'e-record',1,'e-source',1,x,x+1 FROM n").run(n);
}
it('T-TURN-SCAN-GATE: every table and alias scan is rejected',()=>{
 const plans=['messages','search_intents','memory_evidence','memory_receipt_flips','memory_revoke_jobs','arbitrary_history','e'].map(name=>({sql:'fixture',details:['SCAN '+name+' USING COVERING INDEX fixture']}));
 expect(historyScans(plans),'ORACLE:T-TURN-SCAN-GATE').toHaveLength(plans.length);
});
it('T-TURN-HISTORY: populated evidence never scans on the production owner insert',{timeout:120000},async()=>{
 const capture=captureQueryPlans();const evidence:unknown[]=[];
 try {
  for(const n of [1000,1_040_000]) {
   await search.stopSearchIndex();closeDatabase();await stopWalMaintenance();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});
   const db=database();await search.stopSearchIndex();await stopWalMaintenance();seedEvidence(db,n);
   insertMessage('turn',{id:'warm',at:1,role:'user',kind:'text',text:'warm'});drainRevokeMarker(db);resetRevokeWriteBudget();
   capture.start();insertMessage('turn',{id:'new',at:2,role:'user',kind:'text',text:'canary'});capture.stop();
   evidence.push({n,plans:[...capture.plans]});mkdirSync('evidence/bld-fts-amend/afix',{recursive:true});
   writeFileSync('evidence/bld-fts-amend/afix/evidence-insert-plans.json',JSON.stringify(evidence,null,2)+'\n');
   expect(capture.plans.filter(plan=>plan.error),'ORACLE:T-TURN-HISTORY').toEqual([]);
   expect(historyScans(capture.plans),'ORACLE:T-TURN-HISTORY').toEqual([]);
   expect(capture.plans.flatMap(plan=>plan.details).some(detail=>detail.includes('SEARCH memory_evidence USING COVERING INDEX memory_evidence_source_version')),'ORACLE:T-TURN-HISTORY').toBe(true);
  }
 } finally {capture.restore();}
});
// Required-index creation faults are injected only at the pre-listen CREATE,
// after a real file with populated evidence has been closed. Setup stays untagged.
async function failedEvidenceIndex(n:number,error:{code?:string;errcode?:number;name?:string}) {
 mkdirSync('evidence/bld-fts-amend/afix3',{recursive:true});
 await search.stopSearchIndex();closeDatabase();await stopWalMaintenance();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});
 let db=database();await search.stopSearchIndex();await stopWalMaintenance();seedEvidence(db,n);
 db.exec('DROP INDEX memory_evidence_source_version');closeDatabase();
 const exec=DatabaseSync.prototype.exec;
 const fault=vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:DatabaseSync,sql:string){
  if(sql==='CREATE INDEX IF NOT EXISTS memory_evidence_source_version ON memory_evidence(source_id,source_revision)')throw Object.assign(new Error('fixture required index creation'),error);
  return exec.call(this,sql);
 });
 try { db=database();await search.stopSearchIndex();await stopWalMaintenance(); } finally { fault.mockRestore(); }
 return db;
}
it('T-EVIDENCE-REQUIRED: failed required creation logs its class once and stays pending',{timeout:120000},async()=>{
 const indexes=await import('./memory/optional-index.ts') as typeof import('./memory/optional-index.ts') & {REQUIRED_INDEXES?:Array<{name:string}>;requiredIndexRebuildPending?:(db:DatabaseSync,name:string)=>boolean};
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 try {
  for(const error of [{code:'SQLITE_BUSY'},{errcode:13},{code:'ENOSPC'},{name:'FixtureError'}]){
   const db=await failedEvidenceIndex(1000,error);
   const name='memory_evidence_source_version';
   const expected=error.code??(error.errcode===13?'SQLITE_FULL':error.name);
   const warnings=()=>warn.mock.calls.filter(call=>String(call[0]).includes('required index build failed name='+name));
   expect(warnings().map(call=>String(call[0])),'ORACLE:T-EVIDENCE-REQUIRED').toEqual([expect.stringContaining('class='+expected)]);
   expect(indexes.REQUIRED_INDEXES?.some(index=>index.name===name),'ORACLE:T-EVIDENCE-REQUIRED').toBe(true);
   expect(indexes.OPTIONAL_INDEXES.some(index=>index.name===name),'ORACLE:T-EVIDENCE-REQUIRED').toBe(false);
   expect(indexes.requiredIndexRebuildPending?.(db,name),'ORACLE:T-EVIDENCE-REQUIRED').toBe(true);
   // The same failure episode is reported once, even if the next build fails too.
   const broken={...indexes.REQUIRED_INDEXES!.find(index=>index.name===name)!,table:'memory_evidence',minSchemaVersion:9,sql:'CREATE INDEX fixture_failure ON memory_evidence(no_such_column)'};
   // Exercise the registered index so its required classification is preserved.
   const registered=indexes.REQUIRED_INDEXES!.find(index=>index.name===name)! as import('./memory/optional-index.ts').OptionalIndex;
   const sql=registered.sql;registered.sql=broken.sql;
   try{await indexes.buildOptionalIndexOffThread(db,registered,{inline:true});}finally{registered.sql=sql;}
   expect(warnings(),'ORACLE:T-EVIDENCE-REQUIRED').toHaveLength(1);
   warn.mockClear();
  }
 }finally{warn.mockRestore();}
});
it('T-EVIDENCE-FALLBACK: failed creation leaves owner writes bounded by the recent evidence cap',{timeout:120000},async()=>{
 const capture=captureQueryPlans();const measurements:unknown[]=[];
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 try{
  for(const n of [1000,1_040_000]){
   const db=await failedEvidenceIndex(n,{errcode:13,code:'ERR_SQLITE_ERROR'});
   insertMessage('turn',{id:'warm',at:1,role:'user',kind:'text',text:'warm'});drainRevokeMarker(db);resetRevokeWriteBudget();
   capture.start();insertMessage('turn',{id:'deferred',at:2,role:'user',kind:'text',text:'canary'});capture.stop();
   measurements.push({n,visits:[...capture.evidenceVisits],plans:[...capture.plans]});
   writeFileSync('evidence/bld-fts-amend/afix3/fallback-plans.json',JSON.stringify(measurements,null,2)+'\n');
   expect(capture.plans.filter(plan=>plan.error),'ORACLE:T-EVIDENCE-FALLBACK').toEqual([]);
   expect(historyScans(capture.plans),'ORACLE:T-EVIDENCE-FALLBACK').toEqual([]);
   expect(capture.evidenceVisits,'ORACLE:T-EVIDENCE-FALLBACK').toEqual([128]);
   expect(capture.sql.some(sql=>sql.startsWith('INSERT INTO memory_source_versions')),'ORACLE:T-EVIDENCE-FALLBACK').toBe(false);
   expect(db.prepare("SELECT text FROM messages WHERE thread_id='turn' AND id='deferred'").get()?.text,'ORACLE:T-EVIDENCE-FALLBACK').toBe('canary');
   expect(db.prepare("SELECT 1 FROM memory_capture_deferred WHERE source_id='message:turn:deferred'").get(),'ORACLE:T-EVIDENCE-FALLBACK').toBeDefined();
   // Patches replace the queued capture; they do not execute the implicit FK scan either.
   capture.start();updateMessage('turn',{id:'deferred',at:2,role:'user',kind:'text',text:'current canary'});capture.stop();
   expect(historyScans(capture.plans),'ORACLE:T-EVIDENCE-FALLBACK').toEqual([]);
   expect(capture.evidenceVisits,'ORACLE:T-EVIDENCE-FALLBACK').toEqual([128]);
  }
 }finally{capture.restore();warn.mockRestore();}
});
it('T-EVIDENCE-RETRY: the next idle rebuild and the next start restore indexed owner writes',{timeout:120000},async()=>{
 const indexes=await import('./memory/optional-index.ts');
 const {setReadTimeJudgeRetired}=await import('./memory/root-set-reclaim.ts');
 const capture=captureQueryPlans();const plans:unknown[]=[];
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 const idle={ownerIdleMs:()=>3_600_000,liveTurn:()=>false,typingHeld:()=>false,routineDueWithin:()=>false,healthAnswered:()=>true,integrityPending:()=>false,revocationWaiting:()=>false};
 setReadTimeJudgeRetired(true);
 try{
  for(const retry of ['idle','start']){
   let db=await failedEvidenceIndex(1000,{code:'SQLITE_BUSY'});
   insertMessage('turn',{id:'queued',at:1,role:'user',kind:'text',text:'old words'});
   updateMessage('turn',{id:'queued',at:1,role:'user',kind:'text',text:'latest words'});
   expect(db.prepare("SELECT 1 FROM memory_sources WHERE id='message:turn:queued'").get(),'ORACLE:T-EVIDENCE-RETRY').toBeUndefined();
   if(retry==='idle'){
    // Spend the optional budget first. Required failures must still retry on the very next idle pass.
    indexes.resetOptionalIndexWindow();
    const exec=DatabaseSync.prototype.exec;
    const broken=vi.spyOn(db,'exec').mockImplementation(function(this:DatabaseSync,sql:string){
     if(sql.includes('CREATE INDEX IF NOT EXISTS memory_evidence_source_version'))throw Object.assign(new Error('fixture retry'),{code:'SQLITE_BUSY'});
     return exec.call(this,sql);
    });
    try{expect(await indexes.buildOptionalIndexesWhenIdle(db,idle,{inline:true}),'ORACLE:T-EVIDENCE-RETRY').toBeNull();}finally{broken.mockRestore();}
    expect(await indexes.buildOptionalIndexesWhenIdle(db,idle),'ORACLE:T-EVIDENCE-RETRY').toBe('memory_evidence_source_version');
   }else{
    closeDatabase();db=database();await search.stopSearchIndex();await stopWalMaintenance();
   }
   expect(indexes.optionalIndexReady(db,'memory_evidence_source_version'),'ORACLE:T-EVIDENCE-RETRY').toBe(true);
   const {drainDeferredEvidenceCaptures}=await import('./memory/capture.ts');
   expect(drainDeferredEvidenceCaptures(db),'ORACLE:T-EVIDENCE-RETRY').toBeGreaterThan(0);
   expect(db.prepare("SELECT json_extract(payload,'$.text') AS text FROM memory_source_versions WHERE source_id='message:turn:queued'").get()?.text,'ORACLE:T-EVIDENCE-RETRY').toBe('latest words');
   expect(db.prepare('SELECT 1 FROM memory_capture_deferred LIMIT 1').get(),'ORACLE:T-EVIDENCE-RETRY').toBeUndefined();
   insertMessage('turn',{id:'warm',at:1,role:'user',kind:'text',text:'warm'});drainRevokeMarker(db);resetRevokeWriteBudget();
   capture.start();insertMessage('turn',{id:'retry-'+retry,at:2,role:'user',kind:'text',text:'canary'});capture.stop();
   plans.push({retry,plans:[...capture.plans]});
   expect(historyScans(capture.plans),'ORACLE:T-EVIDENCE-RETRY').toEqual([]);
   expect(capture.plans.flatMap(plan=>plan.details).some(detail=>detail.includes('SEARCH memory_evidence USING COVERING INDEX memory_evidence_source_version')),'ORACLE:T-EVIDENCE-RETRY').toBe(true);
  }
  writeFileSync('evidence/bld-fts-amend/afix3/retry-plans.json',JSON.stringify(plans,null,2)+'\n');
 }finally{capture.restore();setReadTimeJudgeRetired(false);warn.mockRestore();}
});
it('T-EVIDENCE-PENDING: appended and patched answers stay deferred until their conversation drains',{timeout:120000},async()=>{
 const indexes=await import('./memory/optional-index.ts');
 const {drainDeferredEvidenceCaptures}=await import('./memory/capture.ts');
 const {EVIDENCE_VERSION}=await import('./memory/schema.ts');
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 try{
  const db=await failedEvidenceIndex(1000,{code:'SQLITE_BUSY'});
  let parentId:string|null=null;
  for(let i=0;i<16;i++){
   const id='filler-'+i;
   appendMessage('turn',{id,at:i,role:'user',kind:'text',text:'ordinary words',parentId});parentId=id;
  }
  const text=Array.from({length:12},(_,i)=>`2024-01-${String(i+1).padStart(2,'0')} Exported note ${i}`).join('\n');
  appendMessage('turn',{id:'z-prompt',at:17,role:'user',kind:'text',text,parentId});
  const answer={id:'a-existing',at:18,role:'bot',kind:'text',text:'old private answer',parentId:'z-prompt',turnId:'existing',turnTerminal:true} as const;
  appendMessage('turn',answer);
  expect(await indexes.buildOptionalIndexOffThread(db,EVIDENCE_VERSION)).toBe(true);
  const appended={...answer,id:'a-new',at:19,turnId:'new',text:'new private answer'};
  appendMessage('turn',appended);
  expect(db.prepare("SELECT 1 FROM memory_sources WHERE id='message:turn:a-new'").get(),'ORACLE:T-EVIDENCE-PENDING').toBeUndefined();
  updateMessage('turn',{...answer,text:'patched private answer'});
  expect(db.prepare("SELECT 1 FROM memory_sources WHERE id='message:turn:a-existing'").get(),'ORACLE:T-EVIDENCE-PENDING').toBeUndefined();
  expect(Number(db.prepare('SELECT count(*) AS n FROM memory_capture_deferred').get()?.n),'ORACLE:T-EVIDENCE-PENDING').toBe(19);
  expect(drainDeferredEvidenceCaptures(db),'ORACLE:T-EVIDENCE-PENDING').toBe(16);
  // Repair and one idle slice have both completed, but the prompt is still queued.
  updateMessage('turn',{...appended,text:'latest private answer'});
  expect(db.prepare("SELECT 1 FROM memory_sources WHERE id='message:turn:a-new'").get(),'ORACLE:T-EVIDENCE-PENDING').toBeUndefined();
  expect(drainDeferredEvidenceCaptures(db),'ORACLE:T-EVIDENCE-PENDING').toBe(3);
  for(const id of ['a-existing','a-new']){
   const payload=JSON.parse(String(db.prepare('SELECT payload FROM memory_source_versions WHERE source_id=?').get('message:turn:'+id)?.payload));
   expect(payload,'ORACLE:T-EVIDENCE-PENDING').toMatchObject({text:'',excluded:'export-paste-reply'});
   expect(db.prepare('SELECT state FROM memory_sources WHERE id=?').get('message:turn:'+id)?.state,'ORACLE:T-EVIDENCE-PENDING').toBe('retired');
  }
  expect(db.prepare('SELECT 1 FROM memory_capture_deferred LIMIT 1').get(),'ORACLE:T-EVIDENCE-PENDING').toBeUndefined();
  appendMessage('turn',{id:'after-drain',at:20,role:'user',kind:'text',text:'ordinary later words',parentId:'a-new'});
  expect(db.prepare("SELECT state FROM memory_sources WHERE id='message:turn:after-drain'").get()?.state,'ORACLE:T-EVIDENCE-PENDING').toBe('active');
 }finally{warn.mockRestore();}
});
it('T-EVIDENCE-SLICE: one ordered indexed query visits at most sixteen queue rows at both history sizes',{timeout:120000},async()=>{
 const {drainDeferredEvidenceCaptures}=await import('./memory/capture.ts');
 const measurements:Array<{n:number;visits:number;queries:number;plans:string[];selected:number[]}>=[];
 for(const n of [100,10000]){
  await search.stopSearchIndex();closeDatabase();await stopWalMaintenance();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});
  const db=database();await search.stopSearchIndex();await stopWalMaintenance();
  // References to deleted messages exercise queue traversal without unrelated capture work.
  db.prepare(`WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?)
   INSERT INTO memory_capture_deferred(source_id,source) SELECT printf('message:queue:%08d',?-x),
   json_object('id',printf('message:queue:%08d',?-x),'threadId','queue','messageId','deleted-'||x,'sequence',x) FROM n`).run(n,n,n);
  let visits=0,queries=0;const plans:string[]=[];const selected:number[]=[];
  db.function('queue_visit',(_source:unknown)=>{visits++;return 1;});
  const prepare=db.prepare;
  const spy=vi.spyOn(db,'prepare').mockImplementation(function(this:DatabaseSync,sql:string){
   if(sql.includes('SELECT q.source_id,q.source FROM memory_capture_deferred q')){
    queries++;
    // A non-deterministic predicate runs for every candidate before sorting/LIMIT,
    // so this counts examined rows, including rows discarded by a scan-and-sort.
    sql=sql.replace('ORDER BY','WHERE queue_visit(q.source_id) ORDER BY');
    plans.push(...prepare.call(this,'EXPLAIN QUERY PLAN '+sql).all().map(row=>String(row.detail)));
    const statement=prepare.call(this,sql),all=statement.all;
    statement.all=function(...args){const rows=Reflect.apply(all,this,args) as ReturnType<typeof all>;selected.push(...rows.map(row=>Number(JSON.parse(String(row.source)).sequence)));return rows;};
    return statement;
   }
   return prepare.call(this,sql);
  });
  try{expect(drainDeferredEvidenceCaptures(db),'ORACLE:T-EVIDENCE-SLICE').toBe(16);}finally{spy.mockRestore();}
  measurements.push({n,visits,queries,plans,selected});
 }
 mkdirSync('evidence/bld-fts-amend/afix5',{recursive:true});
 writeFileSync('evidence/bld-fts-amend/afix5/replay-slice-plans.json',JSON.stringify(measurements,null,2)+'\n');
 for(const row of measurements){
  expect(row.visits,'ORACLE:T-EVIDENCE-SLICE').toBeLessThanOrEqual(16);
  expect(row.queries,'ORACLE:T-EVIDENCE-SLICE').toBe(1);
  expect(row.plans.some(plan=>plan.includes('USING INDEX memory_capture_deferred_order')),'ORACLE:T-EVIDENCE-SLICE').toBe(true);
  expect(row.plans.some(plan=>/TEMP B-TREE/.test(plan)),'ORACLE:T-EVIDENCE-SLICE').toBe(false);
  expect(row.selected,'ORACLE:T-EVIDENCE-SLICE').toEqual(Array.from({length:16},(_,i)=>i+1));
 }
 expect(measurements[0].visits,'ORACLE:T-EVIDENCE-SLICE').toBe(measurements[1].visits);
});
it('T-EVIDENCE-UPGRADE: older queued entries acquire sequence in bounded idle slices before replay',{timeout:120000},async()=>{
 const indexes=await import('./memory/optional-index.ts');
 const {drainDeferredEvidenceCaptures}=await import('./memory/capture.ts');
 const {EVIDENCE_VERSION,ensureRevokeLateObjects}=await import('./memory/schema.ts');
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 try{
  const db=await failedEvidenceIndex(1000,{code:'SQLITE_BUSY'});
  const text=Array.from({length:12},(_,i)=>`2024-01-${String(i+1).padStart(2,'0')} Exported note ${i}`).join('\n');
  let parentId:string|null=null;
  for(let i=0;i<9;i++){
   appendMessage('turn',{id:'z-prompt-'+i,at:i,role:'user',kind:'text',text,parentId});
   appendMessage('turn',{id:'a-reply-'+i,at:i,role:'bot',kind:'text',text:'private reply',parentId:'z-prompt-'+i});parentId='a-reply-'+i;
  }
  // Recreate the prior tip's durable queue and exercise the normal startup DDL.
  db.exec("DROP INDEX memory_capture_deferred_order; UPDATE memory_capture_deferred SET source=json_remove(source,'$.sequence')");
  ensureRevokeLateObjects(db);
  expect(await indexes.buildOptionalIndexOffThread(db,EVIDENCE_VERSION)).toBe(true);
  const sequenced=()=>Number(db.prepare("SELECT count(*) AS n FROM memory_capture_deferred WHERE json_type(source,'$.sequence') IS NOT NULL").get()?.n);
  for(const expected of [16,18]){
   expect(drainDeferredEvidenceCaptures(db),'ORACLE:T-EVIDENCE-UPGRADE').toBe(0);
   expect(sequenced(),'ORACLE:T-EVIDENCE-UPGRADE').toBe(expected);
   expect(db.prepare("SELECT 1 FROM memory_sources WHERE thread_id='turn' LIMIT 1").get(),'ORACLE:T-EVIDENCE-UPGRADE').toBeUndefined();
  }
  expect(drainDeferredEvidenceCaptures(db),'ORACLE:T-EVIDENCE-UPGRADE').toBe(16);
  expect(drainDeferredEvidenceCaptures(db),'ORACLE:T-EVIDENCE-UPGRADE').toBe(2);
  for(let i=0;i<9;i++){
   const payload=JSON.parse(String(db.prepare('SELECT payload FROM memory_source_versions WHERE source_id=?').get('message:turn:a-reply-'+i)?.payload));
   expect(payload,'ORACLE:T-EVIDENCE-UPGRADE').toMatchObject({text:'',excluded:'export-paste-reply'});
  }
 }finally{warn.mockRestore();}
});
it('T-EVIDENCE-ORDER: repaired replay captures export prompts before replies in message sequence across idle slices',{timeout:120000},async()=>{
 const indexes=await import('./memory/optional-index.ts');
 const {drainDeferredEvidenceCaptures}=await import('./memory/capture.ts');
 const {EVIDENCE_VERSION}=await import('./memory/schema.ts');
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 try{
  const db=await failedEvidenceIndex(1000,{code:'SQLITE_BUSY'});
  const text=Array.from({length:12},(_,i)=>`2024-01-${String(i+1).padStart(2,'0')} Exported note ${i}`).join('\n');
  let parentId:string|null=null;
  for(let i=0;i<9;i++){
   appendMessage('turn',{id:'z-prompt-'+i,at:1,role:'user',kind:'text',text,parentId});
   appendMessage('turn',{id:'a-reply-'+i,at:1,role:'bot',kind:'text',text:'private answer '+i,parentId:'z-prompt-'+i,turnId:'reply-'+i,turnTerminal:true});
   parentId='a-reply-'+i;
  }
  // A replacement preserves seq but moves rowid: sorting by rowid or time is also wrong.
  insertMessage('turn',{id:'z-prompt-0',at:99,role:'user',kind:'text',text,parentId:null});
  expect(Number(db.prepare("SELECT seq FROM messages WHERE id='z-prompt-0'").get()?.seq)).toBeLessThan(Number(db.prepare("SELECT seq FROM messages WHERE id='a-reply-0'").get()?.seq));
  expect(Number(db.prepare("SELECT rowid FROM messages WHERE id='z-prompt-0'").get()?.rowid)).toBeGreaterThan(Number(db.prepare("SELECT rowid FROM messages WHERE id='a-reply-0'").get()?.rowid));
  expect(await indexes.buildOptionalIndexOffThread(db,EVIDENCE_VERSION)).toBe(true);
  expect(drainDeferredEvidenceCaptures(db),'ORACLE:T-EVIDENCE-ORDER').toBe(16);
  expect(drainDeferredEvidenceCaptures(db),'ORACLE:T-EVIDENCE-ORDER').toBe(2);
  for(let i=0;i<9;i++){
   const payload=(id:string)=>JSON.parse(String(db.prepare('SELECT payload FROM memory_source_versions WHERE source_id=?').get('message:turn:'+id)?.payload));
   expect(payload('a-reply-'+i),'ORACLE:T-EVIDENCE-ORDER').toMatchObject({text:'',excluded:'export-paste-reply'});
   expect(payload('z-prompt-'+i),'ORACLE:T-EVIDENCE-ORDER').toMatchObject({text:'',excluded:'export-paste'});
   expect(db.prepare('SELECT state FROM memory_sources WHERE id=?').get('message:turn:a-reply-'+i)?.state,'ORACLE:T-EVIDENCE-ORDER').toBe('retired');
  }
 }finally{warn.mockRestore();}
});
it('T-EVIDENCE-BRANCH: replay judges the current branch and creates abandoned sources retired with parked jobs',{timeout:120000},async()=>{
 const indexes=await import('./memory/optional-index.ts');
 const {drainDeferredEvidenceCaptures}=await import('./memory/capture.ts');
 const {EVIDENCE_VERSION}=await import('./memory/schema.ts');
 const {drainBranchChanges}=await import('./memory/branch-change.ts');
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 try{
  for(const leaf of ['kept',null]){
   const db=await failedEvidenceIndex(1000,{code:'SQLITE_BUSY'});
   appendMessage('turn',{id:'root',at:1,role:'user',kind:'text',text:'root words',parentId:null});
   appendMessage('turn',{id:'abandoned',at:2,role:'user',kind:'text',text:'abandoned words',parentId:'root'});
   appendMessage('turn',{id:'reply',at:3,role:'bot',kind:'text',text:'abandoned reply',parentId:'abandoned'});
   appendMessage('turn',{id:'kept',at:4,role:'user',kind:'text',text:'kept words',parentId:'root'});
   setActiveLeaf('turn',leaf);await drainBranchChanges(db);
   expect(db.prepare("SELECT 1 FROM memory_sources WHERE thread_id='turn' LIMIT 1").get()).toBeUndefined();
   expect(await indexes.buildOptionalIndexOffThread(db,EVIDENCE_VERSION)).toBe(true);
   db.exec("CREATE TEMP TABLE replay_states(id TEXT,state TEXT); CREATE TEMP TRIGGER replay_insert AFTER INSERT ON memory_sources BEGIN INSERT INTO replay_states VALUES(new.message_id,new.state); END;");
   expect(drainDeferredEvidenceCaptures(db),'ORACLE:T-EVIDENCE-BRANCH').toBe(4);
   for(const id of ['root','abandoned','reply','kept']){
    const active=leaf!==null&&(id==='root'||id==='kept');
    expect(db.prepare('SELECT state FROM memory_sources WHERE id=?').get('message:turn:'+id)?.state,'ORACLE:T-EVIDENCE-BRANCH').toBe(active?'active':'retired');
    expect(db.prepare('SELECT state FROM replay_states WHERE id=?').get(id)?.state,'ORACLE:T-EVIDENCE-BRANCH').toBe(active?'active':'retired');
    const job=db.prepare('SELECT status,error FROM memory_jobs WHERE source_id=?').get('message:turn:'+id);
    expect(job?.status,'ORACLE:T-EVIDENCE-BRANCH').toBe(active?'pending':'cancelled');
    if(!active)expect(job?.error,'ORACLE:T-EVIDENCE-BRANCH').toMatch(/^parked:/);
   }
   expect(db.prepare('SELECT 1 FROM memory_capture_deferred LIMIT 1').get(),'ORACLE:T-EVIDENCE-BRANCH').toBeUndefined();
  }
 }finally{warn.mockRestore();}
});
it('T-EVIDENCE-REPLAY: durable capture respects rollback, edits, deletion and the idle replay limit',{timeout:120000},async()=>{
 const indexes=await import('./memory/optional-index.ts');
 const {captureSource,drainDeferredEvidenceCaptures}=await import('./memory/capture.ts');
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 try{
  const db=await failedEvidenceIndex(1000,{code:'SQLITE_BUSY'});
  for(let i=0;i<20;i++)insertMessage('turn',{id:'replay-'+i,at:i+1,role:'user',kind:'text',text:'stored '+i});
  updateMessage('turn',{id:'replay-1',at:2,role:'user',kind:'text',text:'latest stored'});
  db.prepare("DELETE FROM messages WHERE thread_id='turn' AND id='replay-2'").run();
  db.exec('BEGIN IMMEDIATE');
  try{insertMessage('turn',{id:'rolled-back',at:30,role:'user',kind:'text',text:'uncommitted'});}finally{db.exec('ROLLBACK');}
  expect(db.prepare("SELECT 1 FROM memory_capture_deferred WHERE source_id='message:turn:rolled-back'").get(),'ORACLE:T-EVIDENCE-REPLAY').toBeUndefined();
  expect(db.prepare('SELECT source FROM memory_capture_deferred LIMIT 1').get()?.source,'ORACLE:T-EVIDENCE-REPLAY').not.toMatch(/stored/);
  captureSource(db,{id:'turn:turn:fixture',threadId:'turn',turnId:'fixture',kind:'turn',speaker:'harness',outcome:'working',text:'Turn working.'});
  expect(drainDeferredEvidenceCaptures(db),'ORACLE:T-EVIDENCE-REPLAY').toBe(0);
  const schema=await import('./memory/schema.ts');
  expect(await indexes.buildOptionalIndexOffThread(db,schema.EVIDENCE_VERSION),'ORACLE:T-EVIDENCE-REPLAY').toBe(true);
  expect(drainDeferredEvidenceCaptures(db),'ORACLE:T-EVIDENCE-REPLAY').toBe(16);
  expect(drainDeferredEvidenceCaptures(db),'ORACLE:T-EVIDENCE-REPLAY').toBe(5);
  expect(db.prepare("SELECT 1 FROM memory_sources WHERE id='message:turn:replay-2'").get(),'ORACLE:T-EVIDENCE-REPLAY').toBeUndefined();
  expect(db.prepare("SELECT json_extract(payload,'$.text') AS text FROM memory_source_versions WHERE source_id='message:turn:replay-1'").get()?.text,'ORACLE:T-EVIDENCE-REPLAY').toBe('latest stored');
  expect(db.prepare("SELECT outcome FROM memory_sources WHERE id='turn:turn:fixture'").get()?.outcome,'ORACLE:T-EVIDENCE-REPLAY').toBe('interrupted');
  expect(db.prepare('SELECT 1 FROM memory_capture_deferred LIMIT 1').get(),'ORACLE:T-EVIDENCE-REPLAY').toBeUndefined();
 }finally{warn.mockRestore();}
});
it('R5 / R7 T-BOUND-OWNER: complete owner writes stay bounded at 1k and 1.04M with crisis segments and an active merge',{timeout:180000},async()=>{
 const measurements:Array<Record<string,unknown>>=[];
 const capture=captureQueryPlans();
 try{
 for(const n of [1000,1_040_000]){
  await search.stopSearchIndex();closeDatabase();await stopWalMaintenance();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});
  const db=database();await search.stopSearchIndex();await stopWalMaintenance();
  db.exec('PRAGMA wal_autocheckpoint=0;PRAGMA journal_size_limit=0');
  db.prepare("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT 'turn',CAST(x AS TEXT),x,'user','text','common repeated trigram '||x,'{}' FROM n").run(n);
  // Real executable foreground-mutant target: an inherited index stays inert.
  db.exec(MESSAGE_SEARCH_DDL);db.exec("INSERT INTO messages_fts(rowid,t) SELECT rowid,text FROM messages");search.settleInheritedSearchMerge(db,false);
  search.prepareMessageSearchBackfill(db);search.syncMessageSearchRow(db,0,null);
  const marker=db.prepare('SELECT seq,CAST(nonce AS TEXT) AS nonce FROM search_intents ORDER BY seq DESC LIMIT 1').get()!;
  const owner=db.prepare("SELECT done FROM transcript_index_state WHERE name='search_owner'").get()!.done;
  removeTempDirSync(join(DATA_DIR,'search.db'));
  await search.stopSearchIndex();
  for(const name of search.SEARCH_FILES)removeTempDirSync(join(DATA_DIR,name));
  const a=new DatabaseSync(join(DATA_DIR,'search.db'));
  try{
   a.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0');a.exec(MESSAGE_SEARCH_DDL);
   a.exec("CREATE TABLE search_state(k TEXT PRIMARY KEY,v TEXT NOT NULL);CREATE TABLE docs(rowid INTEGER PRIMARY KEY,thread_key TEXT NOT NULL,oversized INTEGER NOT NULL DEFAULT 0);CREATE INDEX docs_thread ON docs(thread_key,rowid);CREATE INDEX docs_oversized ON docs(oversized)");
   a.prepare('ATTACH DATABASE ? AS source').run(join(DATA_DIR,'messages.db'));
   a.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES('automerge',0);INSERT INTO messages_fts(messages_fts,rank) VALUES('crisismerge',32)");
   a.prepare('INSERT INTO messages_fts(rowid,t) SELECT rowid,text FROM source.messages WHERE rowid<=?').run(n-11);
   a.exec("INSERT INTO messages_fts(messages_fts) VALUES('optimize')");
   for(let rowid=n-10;rowid<=n;rowid++)a.prepare('INSERT INTO messages_fts(rowid,t) SELECT rowid,text FROM source.messages WHERE rowid=?').run(rowid);
   a.prepare('INSERT INTO docs(rowid,thread_key) SELECT rowid,? FROM source.messages').run(search.threadKey('turn'));
   const segments=Number(a.prepare('SELECT COUNT(DISTINCT segid) AS n FROM messages_fts_idx').get()!.n);expect(segments, "ORACLE:T-BOUND-OWNER").toBeGreaterThanOrEqual(8);
   a.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES('crisismerge',12)");
   const put=a.prepare('INSERT INTO search_state VALUES(?,?)');
   for(const[k,v]of Object.entries({owner,index_id:'fixture-'+n,source_schema:String(db.prepare('PRAGMA schema_version').get()!.schema_version),applied_seq:String(marker.seq),applied_nonce:String(marker.nonce),seen_seq:String(marker.seq),seen_nonce:String(marker.nonce),debt:String(marker.seq)+':0'}))put.run(k,String(v));
   a.exec('DETACH DATABASE source');
  }finally{a.close();}
  // Warm all non-search owner preparation before measuring actual insert+patch.
  insertMessage('turn',{id:'warm',at:1,role:'user',kind:'text',text:'x'});
  // Compare the same memory debt/admission and cache condition at both sizes,
  // as in T-TURN-OPS. Bootstrap revoke work is independent of search history.
  drainRevokeMarker(db);resetRevokeWriteBudget();
  updateMessage('turn',{id:'warm',at:1,role:'user',kind:'text',text:'y'});
  drainRevokeMarker(db);resetRevokeWriteBudget();
  held=new Int32Array(new SharedArrayBuffer(4));search.searchIndexTestHooks.barrier={name:'merge-prove',shared:held.buffer as SharedArrayBuffer};
  let mergeActive=false,steps=0;search.searchIndexTestHooks.event=event=>{if(event.type==='barrier'&&event.name==='merge-prove')mergeActive=true;if(event.type==='stepped')steps++;};
  try{
   capture.start();
   search.startSearchIndex(db,join(DATA_DIR,'messages.db'));
   const deadline=Date.now()+15000;while(!mergeActive&&Date.now()<deadline)await pause(10);
   expect(mergeActive, "ORACLE:T-BOUND-OWNER").toBe(true);expect(search.messageSearchIndexReady(db), "ORACLE:T-BOUND-OWNER").toBe(true);
   // Leave the progress cache cold: the actual owner commit must pay and
   // expose its search-reader lookup as well as its source writes.
   const start=capture.sql.length,startPlans=capture.plans.length;
   const before=statSync(join(DATA_DIR,'messages.db-wal')).size;
   insertMessage('turn',{id:'measured',at:2,role:'user',kind:'text',text:'x'});
   updateMessage('turn',{id:'measured',at:2,role:'user',kind:'text',text:'y'});
   const frames=(statSync(join(DATA_DIR,'messages.db-wal')).size-before)/4120;
   capture.stop();
   const ownerSql=capture.sql.slice(start),foregroundFTS=capture.sql.filter(text=>/(?:INSERT(?: OR \w+)? INTO|DELETE FROM|UPDATE|DROP TABLE).*messages_fts|wal_checkpoint/i.test(text));
   expect(foregroundFTS,"ORACLE:T-BOUND-OWNER" + " " + ('foreground FTS/checkpoint SQL must be empty')).toEqual([]);
   expect(ownerSql.filter(text=>text===search.PRUNE_SQL).length, "ORACLE:T-BOUND-OWNER").toBeGreaterThan(0);
   expect(ownerSql.some(text=>text.includes("FROM search_state WHERE k='applied_seq'")),"ORACLE:T-BOUND-OWNER" + " " + ('owner progress read was measured')).toBe(true);
   const ownerPlans=capture.plans.slice(startPlans);
   expect(ownerPlans, "ORACLE:T-BOUND-OWNER").toHaveLength(ownerSql.length);
   expect(ownerSql, "ORACLE:T-BOUND-OWNER").toContain('BEGIN IMMEDIATE');expect(ownerSql, "ORACLE:T-BOUND-OWNER").toContain('COMMIT');
   expect(ownerPlans.filter(plan=>plan.error),"ORACLE:T-BOUND-OWNER" + " " + ('every owner statement must have a query plan')).toEqual([]);
   // Check every statement on the complete owner path, including trigger/FK
   // plans. Only these non-transcript scans are allowed, with their fixed
   // fixture cardinalities checked separately below. Every other SCAN fails;
   // a message-history aggregate returning one row is still a full scan.
   const scans=historyScans(ownerPlans);
   const fixedRows:Record<string,number>={};
   fixedRows['temp.identity_epoch']=Number(db.prepare('SELECT COUNT(*) AS n FROM temp.identity_epoch').get()!.n);
   expect(fixedRows['temp.identity_epoch'], "ORACLE:T-BOUND-OWNER").toBeLessThanOrEqual(1);
   mkdirSync('.fts-r3-evidence/review',{recursive:true});
   writeFileSync('.fts-r3-evidence/review/owner-plans-'+n+'.json',JSON.stringify(ownerPlans,null,2)+'\n');
   expect(scans,"ORACLE:T-BOUND-OWNER" + " " + ('owner history scans (including single-row aggregates)')).toEqual([]);
   expect(ownerSql.length, "ORACLE:T-BOUND-OWNER").toBeLessThan(300);expect(frames, "ORACLE:T-BOUND-OWNER").toBeLessThan(160);
   expect(Number(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id='turn' AND id='measured' AND text='y'").get()!.n), "ORACLE:T-BOUND-OWNER").toBe(1);
   measurements.push({history:n,statements:ownerSql.length,queryPlans:ownerPlans.length,fixedRows,frames,segments:12,mergeActive,steps,foregroundFTS});
  }finally{capture.stop();Atomics.store(held,0,0);Atomics.notify(held,0);held=undefined;search.searchIndexTestHooks.barrier=null;await search.stopSearchIndex();}
 }
 mkdirSync('.fts-r3-evidence/review',{recursive:true});writeFileSync('.fts-r3-evidence/review/owner-bound.json',JSON.stringify(measurements,null,2)+'\n');
 // The first owner handle can pay a one-time statement-cache miss. Both
 // histories must meet the same absolute bounds and have constant-size deltas.
 expect(Math.abs(Number(measurements[0].statements)-Number(measurements[1].statements)), "ORACLE:T-BOUND-OWNER").toBeLessThanOrEqual(2);
 expect(Math.abs(Number(measurements[0].frames)-Number(measurements[1].frames)), "ORACLE:T-BOUND-OWNER").toBeLessThanOrEqual(8);
 }finally{capture.restore();}
});

it('T-TURN-OPS: production turns have identical history-independent work in each recovery state',{timeout:420000},async()=>{
 const capture=captureQueryPlans(),idleWindows:Array<{n:number,state:string,ms:number,timers:number}>=[],measurements:Array<{n:number,state:string,statements:number,frames:number,sql:string[],pages:unknown[],plans:unknown[]}>=[];
 const wait=async(check:()=>boolean,ms=5000)=>{const end=Date.now()+ms;while(!check()&&Date.now()<end)await pause(10);expect(check(),'ORACLE:T-TURN-OPS').toBe(true);};
 const measure=(db:DatabaseSync,n:number,state:string)=>{
  // Reserve a fixed amount of space in the rightmost messages leaf. The fixture
  // bulk load ends at unrelated page occupancies; page allocation must not be
  // mistaken for recovery work. This runs before warming and before capture.
  const tail=()=>db.prepare("SELECT unused FROM dbstat WHERE name='messages' AND pagetype='leaf' ORDER BY path DESC LIMIT 1").get()!;
  const padding=db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,json) VALUES('fixture-padding',?,1,'user','options','{}')");
  for(let pad=0;Number(tail().unused)<3000;pad++){
   expect(pad,'fixture padding bound').toBeLessThan(128);
   padding.run(state+'-'+pad);
  }
  // Settle unrelated memory revoke debt and its rolling admission ledger so
  // both history fixtures start each measured turn in the same memory state.
  drainRevokeMarker(db);resetRevokeWriteBudget();
  // Warm the complete production path, including lineage caches. Replacing
  // this same real row also frees its exact primary-index key inside the measured
  // transaction, controlling leaf splits without subtracting any WAL frames.
  insertMessage('turn',{id:'ops-'+state,at:2,role:'user',kind:'text',text:'x'});
  updateMessage('turn',{id:'ops-'+state,at:2,role:'user',kind:'text',text:'y'});
  drainRevokeMarker(db);resetRevokeWriteBudget();
  search.pruneMessageSearchIntents(db);
  capture.start();const before=statSync(join(DATA_DIR,'messages.db-wal')).size;
  insertMessage('turn',{id:'ops-'+state,at:2,role:'user',kind:'text',text:'x'});
  updateMessage('turn',{id:'ops-'+state,at:2,role:'user',kind:'text',text:'y'});
  search.pruneMessageSearchIntents(db,search.IDLE_PRUNE_ROWS);
  const frames=(statSync(join(DATA_DIR,'messages.db-wal')).size-before)/4120;capture.stop();
  expect(capture.sql.filter(sql=>/messages_fts|checkpoint|FROM search_state/i.test(sql)),'ORACLE:T-TURN-OPS').toEqual([]);
  expect(capture.plans.filter(plan=>plan.error),'ORACLE:T-TURN-OPS').toEqual([]);
  const scans=historyScans(capture.plans);
  expect(scans,'ORACLE:T-TURN-OPS').toEqual([]);
  expect(capture.sql.length,'ORACLE:T-TURN-OPS').toBeLessThan(320);
  expect(frames,'ORACLE:T-TURN-OPS').toBeLessThan(160);
  const wal=readFileSync(join(DATA_DIR,'messages.db-wal')).subarray(before),pageNumbers:number[]=[];
  for(let offset=0;offset<wal.length;offset+=4120)pageNumbers.push(wal.readUInt32BE(offset));
  const names=db.prepare('SELECT pageno,name,path,pagetype,ncell FROM dbstat WHERE pageno IN ('+[...new Set(pageNumbers)].join(',')+')').all();
  const byPage=new Map(names.map(row=>[Number(row.pageno),row]));
  measurements.push({n,state,statements:capture.sql.length,frames,sql:[...capture.sql],plans:[...capture.plans],pages:pageNumbers.map(page=>byPage.get(page)??{pageno:page})});
  mkdirSync('evidence/bld-fts-amend',{recursive:true});writeFileSync('evidence/bld-fts-amend/turn-ops.json',JSON.stringify(measurements,null,2)+'\n');
 };
 try{
 for(const n of [1000,1_040_000]){
  await search.stopSearchIndex();closeDatabase();await stopWalMaintenance();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});
  const db=database();await search.stopSearchIndex();await stopWalMaintenance();
  db.exec('PRAGMA wal_autocheckpoint=0;PRAGMA journal_size_limit=0');
  db.prepare("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT 'history',CAST(x AS TEXT),x,'user','text','history common','{}' FROM n").run(n);
  seedEvidence(db,n);
  insertMessage('turn',{id:'warm',at:1,role:'user',kind:'text',text:'warm'});
  insertMessage('turn',{id:'ops',at:2,role:'user',kind:'text',text:'x'});
  // This assertion is behavioural on legacy: the serving turn must not write FTS.
  capture.start();updateMessage('turn',{id:'ops',at:2,role:'user',kind:'text',text:'warm'});capture.stop();
  expect(capture.sql.filter(sql=>/(?:INSERT|UPDATE|DELETE).*messages_fts/i.test(sql)),'ORACLE:T-TURN-OPS').toEqual([]);
  search.prepareMessageSearchBackfill(db);search.syncMessageSearchRow(db,0,null);
  const marker=db.prepare('SELECT seq,CAST(nonce AS TEXT) AS nonce FROM search_intents ORDER BY seq DESC LIMIT 1').get()!;
  const owner=db.prepare("SELECT done FROM transcript_index_state WHERE name='search_owner'").get()!.done;
  await search.stopSearchIndex();
  for(const name of search.SEARCH_FILES)removeTempDirSync(join(DATA_DIR,name));
  const a=new DatabaseSync(join(DATA_DIR,'search.db'));
  a.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0');a.exec(MESSAGE_SEARCH_DDL);
  a.exec("CREATE TABLE search_state(k TEXT PRIMARY KEY,v TEXT NOT NULL);CREATE TABLE docs(rowid INTEGER PRIMARY KEY,thread_key TEXT NOT NULL,oversized INTEGER NOT NULL DEFAULT 0);CREATE INDEX docs_thread ON docs(thread_key,rowid);CREATE INDEX docs_oversized ON docs(oversized)");
  const put=a.prepare('INSERT INTO search_state VALUES(?,?)');
  for(const[k,v]of Object.entries({owner,index_id:'ops-'+n,source_schema:String(db.prepare('PRAGMA schema_version').get()!.schema_version),applied_seq:String(marker.seq),applied_nonce:String(marker.nonce),seen_seq:String(marker.seq),seen_nonce:String(marker.nonce)}))put.run(k,String(v));
  a.close();search.searchIndexTestHooks.halted=true;
  search.startSearchIndex(db,join(DATA_DIR,'messages.db'));await wait(()=>search.messageSearchIndexReady(db));
  measure(db,n,'HEALTHY');
  // Reader opens, but halted rebuilding has not completed: RECOVERING stays real.
  search.disableMessageSearchIndex(db,Error('fixture ops reset'));
  await wait(()=>search.messageSearchIndexReady(db)&&search.recovery(db).state==='RECOVERING');
  measure(db,n,'RECOVERING');
  // The op-count fixture controls rebuild position; qualification owns full
  // history throughput. Leave one empty tail slice for the real worker to finish.
  const progress=new DatabaseSync(join(DATA_DIR,'search.db'));
  progress.prepare("UPDATE search_state SET v='1' WHERE k='built'").run();progress.close();
  search.searchIndexTestHooks.halted=false;
  await wait(()=>search.recovery(db).state==='HEALTHY',90000);
  insertMessage('pin',{id:'pin',at:3,role:'user',kind:'text',text:'pinned scrub'});
  await wait(()=>!search.searchCleanupPending(db));
  const reader=new DatabaseSync(join(DATA_DIR,'search.db'),{readOnly:true});
  try{
   reader.exec('BEGIN');reader.prepare('SELECT COUNT(*) FROM messages_fts').get();
   let busy=false,timers=0;search.searchIndexTestHooks.event=e=>{if(e.type==='scrub-busy')busy=true;if(e.type==='timer')timers++;};
   db.exec('BEGIN');search.dropThreadSearchRows(db,'pin');db.exec("DELETE FROM messages WHERE thread_id='pin';COMMIT");
   await wait(()=>busy);measure(db,n,'SCRUB_BUSY');
   // Let the measured turn apply before counting the completely idle interval.
   await pause(300);timers=0;
   await pause(60000);idleWindows.push({n,state:'SCRUB_BUSY',ms:60000,timers});
   writeFileSync('evidence/bld-fts-amend/turn-idle.json',JSON.stringify(idleWindows,null,2)+'\n');
   expect(timers,'ORACLE:T-TURN-OPS').toBeLessThanOrEqual(12);
   reader.exec('COMMIT');
  }finally{reader.close();search.searchIndexTestHooks.event=null;}
  await search.stopSearchIndex();turnFault.persistent=true;search.searchIndexTestHooks.halted=false;
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  search.startSearchIndex(db,join(DATA_DIR,'messages.db'));
  const parkTrace:unknown[]=[];search.searchIndexTestHooks.event=e=>{if(e.type!=='timer')parkTrace.push({type:e.type,message:e.message,recovery:search.recovery(db)});};
  try{await wait(()=>search.recovery(db).state==='PARKED',22000);}catch(error){console.log('PARK TRACE',JSON.stringify(parkTrace));throw error;}
  measure(db,n,'PARKED');let timers=0;
  search.searchIndexTestHooks.event=e=>{if(e.type==='timer')timers++;};
  await pause(60000);idleWindows.push({n,state:'PARKED',ms:60000,timers});
  writeFileSync('evidence/bld-fts-amend/turn-idle.json',JSON.stringify(idleWindows,null,2)+'\n');
  expect(timers,'ORACLE:T-TURN-OPS').toBe(0);
  search.searchIndexTestHooks.event=null;turnFault.persistent=false;warn.mockRestore();
 }
 for(const state of ['HEALTHY','RECOVERING','SCRUB_BUSY','PARKED']){
  const rows=measurements.filter(row=>row.state===state);
  expect(rows[0].statements,'ORACLE:T-TURN-OPS').toBe(rows[1].statements);
  expect(rows[0].frames,'ORACLE:T-TURN-OPS').toBe(rows[1].frames);
 }
 mkdirSync('evidence/bld-fts-amend',{recursive:true});writeFileSync('evidence/bld-fts-amend/turn-ops.json',JSON.stringify(measurements,null,2)+'\n');
 }finally{capture.restore();turnFault.persistent=false;search.searchIndexTestHooks.halted=false;await search.stopSearchIndex();}
});
