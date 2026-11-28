// Producer owner: recall-s1s2g (recall-free session proof). Consumer owner: recall-privacy-close-b (paused/held privacy witness).
// GrokBuild Critical 2 (a77003e6fb): a held redispatch runs with memory paused and no bundle. A retained provider session that
// already carries another room's recalled turn must never be resumed then, whatever state its receipts are in, while the room is
// told that this reply did not use recalled memories. A session that never held recall keeps resuming.
import {mkdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {DATA_DIR} from '../config.ts';
import {closeDatabase,database} from '../database.ts';
import {removeTempDirSync} from '../testing/cleanup.ts';
import {LineageAllowance} from './lineage-allowance.ts';
import {ensureScope} from './policy.ts';
import {stopRecallViewMaintenance} from './recall-view.ts';
import {WritetimeFixture} from './testing/writetime-fixture.ts';
import {proofModule,receipts,setupProofFixture} from './session-proof-fixture.ts';

beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});});
afterEach(()=>{stopRecallViewMaintenance();closeDatabase();});

// The retained session's earlier turn recalled a reply from another room, through a real delivered receipt.
async function recalledOtherRoom(thread:string) {
 const f=setupProofFixture(thread),db=database(),scope=ensureScope('room','room');
 new WritetimeFixture(db).owner('other-room','other-room-reply',2).source('other-room-source',scope,{thread:'other-room',message:'other-room-reply'});
 const ids=await receipts(f,1);
 db.prepare('UPDATE memory_disclosures SET source_versions=? WHERE bundle_id=?').run(JSON.stringify([{id:'other-room-source',revision:1}]),ids[0]);
 return {f,ids};
}
// The recall-free contexts dispatch builds for a held/paused turn (index.ts offContext, room prepareRoomMemory without access).
const heldContext=(venue:'direct'|'room',disclosed:boolean)=>venue==='room'
 ?{access:undefined,room:true,reader:{audience:null},disclosed}
 :{access:undefined,reader:{audience:null},disclosed};

for(const venue of ['direct','room'] as const)for(const receipt of ['delivered','revoked','prepared'] as const)for(const disclosed of [true,false])
it(`C2 ${venue}: held/paused turn never resumes a session that carried another room's recall (receipt ${receipt}, disclosed=${disclosed})`,async()=>{
 const {f,ids}=await recalledOtherRoom(venue==='room'?'room-thread':'direct'),db=database(),p=await proofModule();
 // The audience stops seeing that scope only later, and nothing writes deny_session: the session itself was never refused.
 if(receipt!=='delivered')db.prepare('UPDATE memory_disclosures SET state=? WHERE bundle_id=?').run(receipt,ids[0]);
 expect(db.prepare('SELECT count(*) AS n FROM memory_deny_session').get()?.n).toBe(0);
 const proof=p.proveRetainedSession(LineageAllowance.tool(),f.key,heldContext(venue,disclosed));
 expect(proof.kind).toBe('fresh');
 if(venue==='room')expect(proof).toMatchObject({kind:'fresh',reason:'held-session-holds-recall'});
 // and it stays refused at every adapter write of the same turn
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,heldContext(venue,disclosed)).kind).toBe('fresh');
});

for(const venue of ['direct','room'] as const)it(`C2 ${venue}: the recall frame alone still refuses after its receipts are gone`,async()=>{
 const {f}=await recalledOtherRoom(venue==='room'?'room-thread':'direct'),db=database(),p=await proofModule();
 db.prepare('DELETE FROM memory_disclosures WHERE thread_id=?').run(f.key.threadId);
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,heldContext(venue,false)).kind).toBe('fresh');
});

// Each kind of durable recall evidence refuses on its own, with the recall frame bit already cleared (a crash or an upgrade).
for(const venue of ['direct','room'] as const)for(const carried of ['receipt-rows','receipt-lines'] as const)
it(`C2 ${venue}: ${carried} alone keep a held/paused turn off the session`,async()=>{
 const {f}=await recalledOtherRoom(venue==='room'?'room-thread':'direct'),db=database(),p=await proofModule(),args=[f.key.threadId,f.key.driverInstance,f.key.nativeSession];
 const lines=()=>Number(db.prepare('SELECT count(*) AS n FROM memory_receipt_lines WHERE session_no=(SELECT no FROM memory_session_no WHERE thread_id=? AND driver_instance=? AND native_session=?)').get(...args)?.n??0);
 if(carried==='receipt-rows')db.prepare('DELETE FROM memory_receipt_lines WHERE session_no=(SELECT no FROM memory_session_no WHERE thread_id=? AND driver_instance=? AND native_session=?)').run(...args);
 else {
  new WritetimeFixture(db).owner(f.key.threadId,'fixture-recalled-line',5).receipt('carried-receipt',...args as [string,string,string]);
  db.prepare('INSERT OR IGNORE INTO memory_session_no(thread_id,driver_instance,native_session,no) VALUES(?,?,?,(SELECT coalesce(max(no),0)+1 FROM memory_session_no))').run(...args);
  db.prepare("INSERT OR REPLACE INTO memory_receipt_lines SELECT 'carried-receipt',no,5,(SELECT no FROM memory_session_no WHERE thread_id=? AND driver_instance=? AND native_session=?) FROM memory_thread_no WHERE thread_id=?").run(...args,f.key.threadId);
  db.prepare('DELETE FROM memory_disclosures WHERE thread_id=?').run(f.key.threadId);
  expect(lines()).toBeGreaterThan(0);
 }
 // the frame bit only rises in normal operation; a crash before its write leaves it at 0 (MAIN RULING 1115-RECALL-GROK-Q1Q2)
 try{db.prepare('UPDATE memory_session_state SET had_frame=0 WHERE thread_id=? AND driver_instance=? AND native_session=?').run(...args);}catch{/* no frame bit on this file */}
 if(carried==='receipt-rows'){expect(lines()).toBe(0);expect(db.prepare('SELECT count(*) AS n FROM memory_disclosures WHERE thread_id=?').get(f.key.threadId)?.n).toBe(1);}
 // refused as the held session it is: the reset is logged with this cause (recall-held-session.test.ts T-G2a)
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,heldContext(venue,false))).toMatchObject({kind:'fresh',reason:'held-session-holds-recall'});
});

it('C2 room: a held/paused turn keeps a session that never carried recall',async()=>{
 const f=setupProofFixture('room-thread'),p=await proofModule();
 let state:any;try{state=await import(/* @vite-ignore */ new URL('./session-proof-schema.ts',import.meta.url).href);}catch{state={noteSessionFrame(){}};}
 state.noteSessionFrame(database(),f.key,false);
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,heldContext('room',false))).toEqual({kind:'resume'});
});
