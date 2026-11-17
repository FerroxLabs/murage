// Producer/consumer owner: recall-s1s2h. Warm continuation contract owner: warm-keep.
import {mkdirSync,readFileSync} from 'node:fs';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {DATA_DIR} from '../config.ts';
import {database,closeDatabase} from '../database.ts';
import {removeTempDirSync} from '../testing/cleanup.ts';
import {LineageAllowance} from './lineage-allowance.ts';
import {WritetimeFixture} from './testing/writetime-fixture.ts';
import {stopRecallViewMaintenance} from './recall-view.ts';
import {continuationMemoryRevoked} from './disclosures.ts';
import {authorityStamp} from './authority-epoch.ts';
import {ensureScope} from './policy.ts';
import {setupProofFixture,proofModule,receipts} from './session-proof-fixture.ts';
beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});});
afterEach(()=>{stopRecallViewMaintenance();closeDatabase();});
async function quoted() {
 const f=setupProofFixture(),db=database(),scope=ensureScope('room','room');
 new WritetimeFixture(db).owner('other-room','quoted-reply',2).source('quoted-source',scope,{thread:'other-room',message:'quoted-reply'});
 const ids=await receipts(f,1);
 db.prepare('UPDATE memory_disclosures SET source_versions=? WHERE bundle_id=?').run(JSON.stringify([{id:'quoted-source',revision:1}]),ids[0]);
 return f;
}
for(const missing of [false,true])it(`G-D1: cited cross-room reply without flow is relevant, missing lineage=${missing}`,async()=>{
 const f=await quoted(),p=await proofModule(),db=database();
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toEqual({kind:'resume'});
 if(missing)db.exec("DELETE FROM memory_line_lineage WHERE message_id='quoted-reply'");
 db.exec(`UPDATE messages SET json='{"withheldFromBots":true}' WHERE id='quoted-reply'`);
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toMatchObject({kind:'fresh',reason:'changed:line'});
});
for(const state of ['withheld','checking','missing'])it(`G-D2: cold receipt refuses pre-existing ${state} cite`,async()=>{
 const f=await quoted(),db=database(),p=await proofModule();
 if(state==='missing')db.exec("DELETE FROM memory_line_lineage WHERE message_id='quoted-reply'");
 else db.prepare('UPDATE messages SET json=? WHERE id=?').run(JSON.stringify({withheldFromBots:state==='checking'?'checking':true}),'quoted-reply');
 // A lost/upgrade cache must prove the old content, never inherit a warm answer.
 if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_session_checks'").get())db.exec('DELETE FROM memory_session_checks;DELETE FROM memory_session_check_cites');
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true}).kind).toBe('fresh');
});
it('G-D3: unknown disclosure and missing receipts cannot certify recall-free context',async()=>{
 const f=setupProofFixture(),p=await proofModule();
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:undefined,reader:{audience:null}})).toMatchObject({kind:'fresh',reason:'no-receipts'});
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access})).toMatchObject({kind:'fresh',reason:'no-receipts'});
});
it('G-D4: an authority-stamp hold cannot bypass a new line change',async()=>{
 const f=await quoted(),db=database(),why:{reason?:string}={};
 expect(continuationMemoryRevoked(LineageAllowance.tool(),f.key.threadId,f.key.driverInstance,f.key.nativeSession,f.access,why)).toBe(false);
 const stamp=authorityStamp();
 db.exec(`UPDATE messages SET json='{"withheldFromBots":true}' WHERE id='quoted-reply'`);
 expect(authorityStamp()).toBe(stamp);
 expect(continuationMemoryRevoked(LineageAllowance.tool(),f.key.threadId,f.key.driverInstance,f.key.nativeSession,f.access,why)).toBe(true);
});
it('G-D5: checking transition is logged and replaces recalled context',async()=>{
 const f=await quoted(),p=await proofModule(),db=database();
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toEqual({kind:'resume'});
 db.exec(`UPDATE messages SET json='{"withheldFromBots":"checking"}' WHERE id='quoted-reply'`);
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toMatchObject({kind:'fresh',reason:'checking'});
});
it('G-D6: no-receipt steer proves recall-free and room last resort judges before return',()=>{
 const s=readFileSync(new URL('../index.ts',import.meta.url),'utf8');
 const steer=s.slice(s.indexOf('const steerSessionHolds'),s.indexOf('// Only an engine',s.indexOf('const steerSessionHolds')));
 expect(steer).toContain('proveRetainedSession(');expect(steer).toContain('sessionHadFrame(');
 const room=s.slice(s.indexOf('const prepareRoomMemory=async'),s.indexOf('const selection=memberTurnSelection',s.indexOf('const prepareRoomMemory=async')));
 expect(room.indexOf('proveRetainedSession(')).toBeGreaterThan(0);
 expect(room.indexOf('proveRetainedSession(')).toBeLessThan(room.indexOf('return;'));
 expect(room).toContain('await resetRoomMemberSession()');expect(room).toContain('roomMemoryReset=true');
});
it('G-D3: a failed frame bind persists disclosure across restart',async()=>{
 const f=setupProofFixture(),db=database(),p=await proofModule();
 const {MemoryDispatchReceipt}=await import('./dispatch.ts');
 const {buildMemoryBundle}=await import('./bundle.ts');
 const receipt=new MemoryDispatchReceipt(await buildMemoryBundle('',f.access,{async search(){return {hits:[],vectorRows:0};}},{allowance:LineageAllowance.tool()}),f.access,f.key.driverInstance);
 db.prepare('DELETE FROM memory_disclosures WHERE bundle_id=?').run(receipt.bundle.bundleId);
 expect(()=>receipt.sessionStarted(f.key.nativeSession)).toThrow();
 closeDatabase();f.issue();
 const state=await import('./session-proof-schema.ts');
 expect(state.sessionHadFrame(database(),f.key)).toBe(true);
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:undefined,reader:{audience:null},disclosed:state.sessionHadFrame(database(),f.key)})).toMatchObject({kind:'fresh',reason:'held-session-holds-recall'});
});
for(const gap of ['oversized','trimmed'] as const)it(`G-D1: ${gap} log cannot certify held cross-room cites`,async()=>{
 const f=await quoted(),p=await proofModule(),db=database();
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toEqual({kind:'resume'});
 if(gap==='trimmed')db.exec('DELETE FROM memory_session_change_log');
 const insert=db.prepare('INSERT INTO memory_session_change_log(id) VALUES(?)');
 for(let n=0;n<5000;n++)insert.run('source:unrelated');
 if(gap==='trimmed')db.exec('DELETE FROM memory_session_change_log WHERE seq<(SELECT max(seq) FROM memory_session_change_log)');
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toMatchObject({kind:'fresh',reason:'change-log-span'});
});

// MAIN RULING 1115-RECALL-GROK-Q1Q2: a fresh provider event is not a recall-free checkpoint.
for(const carried of ['receipt-line','roots','frame','unknown'] as const)it(`Q2 crash: fresh event cannot certify carried ${carried} after restart`,async()=>{
 const f=setupProofFixture(),db=database(),p=await proofModule();
 let state:any;try{state=await import(/* @vite-ignore */ new URL('./session-proof-schema.ts',import.meta.url).href);}catch{state={noteSessionFrame(){}};}
 state.noteSessionFrame(db,f.key,false);
 if(carried==='receipt-line'){
  new WritetimeFixture(db).owner(f.key.threadId,'fixture-crash-line',5).receipt('crash-receipt',f.key.threadId,f.key.driverInstance,f.key.nativeSession);
  db.prepare('INSERT OR IGNORE INTO memory_session_no(thread_id,driver_instance,native_session,no) VALUES(?,?,?,1)').run(f.key.threadId,f.key.driverInstance,f.key.nativeSession);
  db.prepare("INSERT OR REPLACE INTO memory_receipt_lines SELECT 'crash-receipt',no,5,(SELECT no FROM memory_session_no WHERE thread_id=? AND driver_instance=? AND native_session=?) FROM memory_thread_no WHERE thread_id=?").run(f.key.threadId,f.key.driverInstance,f.key.nativeSession,f.key.threadId);
  db.exec("DELETE FROM memory_disclosures WHERE bundle_id='crash-receipt'");
  expect(db.prepare("SELECT count(*) AS n FROM memory_receipt_lines WHERE bundle_id='crash-receipt'").get()?.n).toBe(1);
 }
 if(carried==='roots')db.prepare('INSERT OR REPLACE INTO memory_session_roots(thread_id,driver_instance,native_session,set_id) VALUES(?,?,?,?)').run(f.key.threadId,f.key.driverInstance,f.key.nativeSession,'unproven-roots');
 if(carried==='frame')state.noteSessionFrame(db,f.key,true);
 if(carried==='unknown'&&db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_session_state'").get())db.exec('DELETE FROM memory_session_state');
 closeDatabase();const access=f.issue();
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access,disclosed:true}).kind).toBe('fresh');
 expect(database().prepare("SELECT 1 FROM memory_session_checks WHERE reader_key='recall-free'").get()).toBeUndefined();
});

// MAIN RULING 1115-RECALL-GROK-Q1Q2: protect the first frame on a known empty retained cursor before a native callback.
it('Q2 retained first frame: submission cannot leave the empty-session bit across restart',async()=>{
 const f=setupProofFixture('direct'),db=database(),p=await proofModule();
 let state:any;try{state=await import(/* @vite-ignore */ new URL('./session-proof-schema.ts',import.meta.url).href);}catch{state={noteSessionFrame(){},sessionHadFrame(){return undefined;}};}
 state.noteSessionFrame(db,f.key,false);
 p.initializeFreshSessionProof?.(f.key,f.access);
 const {MemoryDispatchReceipt}=await import('./dispatch.ts');
 const {buildMemoryBundle}=await import('./bundle.ts');
 const receipt=new MemoryDispatchReceipt(await buildMemoryBundle('',f.access,{async search(){return {hits:[],vectorRows:0};}},{allowance:LineageAllowance.tool()}),f.access,f.key.driverInstance);
 receipt.resumes(f.key.nativeSession);
 receipt.accepted();
 expect(state.sessionHadFrame(db,f.key)).toBe(true);
 expect(db.prepare('SELECT native_session FROM memory_disclosures WHERE bundle_id=?').get(receipt.bundle.bundleId)?.native_session).toBe(f.key.nativeSession);
 closeDatabase();f.issue();
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:undefined,reader:{audience:null},disclosed:false})).toMatchObject({kind:'fresh',reason:'held-session-holds-recall'});
});

it('K-Q2-explicit-fresh: omitted freshness cannot initialize across ordinary S1 refusal',async()=>{
 const f=setupProofFixture('direct'),db=database(),p=await proofModule();
 const {forgetSendReplaySessionProof}=await import('./replay-lineage.ts');
 const {noteSessionFrame}=await import('./session-proof-schema.ts');
 forgetSendReplaySessionProof(f.key.threadId,f.key.driverInstance,f.key.nativeSession);
 noteSessionFrame(db,f.key,false);
 p.initializeFreshSessionProof(f.key,f.access);
 expect(db.prepare('SELECT 1 FROM memory_session_checks WHERE thread_id=? AND driver_instance=? AND native_session=?').get(f.key.threadId,f.key.driverInstance,f.key.nativeSession)).toBeUndefined();
});
it('K-Q2-explicit-fresh: a caller boolean and bind callback cannot mint native birth',async()=>{
 const f=setupProofFixture('direct'),db=database(),p=await proofModule();
 const {forgetSendReplaySessionProof}=await import('./replay-lineage.ts');
 const {noteSessionFrame}=await import('./session-proof-schema.ts');
 forgetSendReplaySessionProof(f.key.threadId,f.key.driverInstance,f.key.nativeSession);
 noteSessionFrame(db,f.key,false);
 p.initializeFreshSessionProof(f.key,f.access,()=>noteSessionFrame(db,f.key,true),{fresh:true});
 expect(db.prepare('SELECT 1 FROM memory_session_checks WHERE thread_id=? AND driver_instance=? AND native_session=?').get(f.key.threadId,f.key.driverInstance,f.key.nativeSession)).toBeUndefined();
});
