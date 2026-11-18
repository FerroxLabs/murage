// SPDX-License-Identifier: AGPL-3.0-or-later
// Queue admission owner: scperf-p1. Native statement and helper admission owner: scperf-p1.
import { EventEmitter } from "node:events";
import { execFileSync, fork } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { ioBudget, writeStatementCount } from "../io-budget.ts";
import { forgetExclusionAddon } from "../engine-exclusion.ts";
import { checkpointCeiling, commitCeiling, ioGrantSnapshot, ioMeterPageSize, resetIoMeterForTest } from "../io-meter.ts";
import { appendMessage } from "../message-db.ts";
import { stopSearchIndex } from "../message-search-index.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { setMemoryMode } from "./repository.ts";
import { isBgDeferred, type BgDeferred } from "../bg-admission.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { claimMemoryJob } from "./jobs.ts";
import { META_ENVELOPE_FRAMES } from "./index-wal.ts";
vi.mock("../database.ts",async original=>{const actual=await original<typeof import("../database.ts")>();return {...actual,transaction:vi.fn(actual.transaction)};});
vi.mock("./jobs.ts", async original => ({...await original<typeof import("./jobs.ts")>(),claimMemoryJob:vi.fn((...args:Parameters<typeof claimMemoryJob>)=>realClaim(...args))}));
vi.mock("./consolidate.ts", async original => {const actual=await original<typeof import("./consolidate.ts")>();return {...actual,refreshMemoryCheckpoint:vi.fn(actual.refreshMemoryCheckpoint)};});
let realClaim:typeof claimMemoryJob;
vi.mock("node:child_process",async original=>({...await original<typeof import("node:child_process")>(),fork:vi.fn()}));
const root=mkdtempSync(join(tmpdir(),"controller-admission-"));
const prior=process.env.MURAGE_ENGINE_EXCLUSION_PATH;
let at=0,controller:MemoryWorkerController;
const realRead=Reflect.get(ioBudget,"read") as ()=>unknown;
const realAdmissionRead=Reflect.get(ioBudget,"admissionRead") as ()=>unknown;
class Child extends EventEmitter {
 send=vi.fn((_message:unknown)=>true); connected=true; stderr=null;
 kill(){this.emit("exit",0);return true;}disconnect(){this.emit("exit",0);}
}
type Internals={child:Child|null;ready:boolean;started:boolean;indexing:boolean;indexDeadline:number;nextEligibleWorkAt:number;nextWarmAt:number;helperGrants:Map<string,unknown>;tick(requested:boolean):void;later(work:()=>void):void;onWorkerMessage(child:Child,message:unknown):void;receiveWorkerMessage(child:Child,message:unknown):void;spawn():void};
beforeAll(async()=>{
 const original=await vi.importActual<typeof import("./jobs.ts")>("./jobs.ts");realClaim=original.claimMemoryJob;
 const binary=join(root,"meter.node");execFileSync("cc",["-std=c11","-D_GNU_SOURCE","-O2","-Wall","-Werror","-fPIC","-shared","-DNAPI_VERSION=9","-I",resolve(dirname(process.execPath),"../include/node"),"native/engine-exclusion/exclusion.c","native/engine-exclusion/meter.c","-o",binary],{stdio:"pipe"});
 process.env.MURAGE_ENGINE_EXCLUSION_PATH=binary;forgetExclusionAddon();resetIoMeterForTest();
});
beforeEach(async()=>{
 closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});setMemoryMode("capture");
 // The ledger clock below is controlled. Real-clock worker threads must
 // finish before it replaces the process reader; native VFS grants stay real.
 await stopWalMaintenance();await stopSearchIndex();
 // The train separates pacing samples from admission's native clock. Both
 // readers must use the fixture minute; advancing only pacing cannot rotate grants.
 at=0;const read=()=>({at,fsWriteBlocks:0,cpuMicros:0});
 Reflect.set(ioBudget,"read",read);Reflect.set(ioBudget,"admissionRead",read);ioBudget.resetAdmissionForFixture();ioBudget.setIsIdle(()=>false);
 controller=new MemoryWorkerController({startHoldMs:0});const child=new Child();
 const i=controller as unknown as Internals;i.child=child;i.ready=true;
 vi.mocked(claimMemoryJob).mockClear();vi.mocked(fork).mockClear();
});
afterEach(async()=>{await controller.stop();ioBudget.stop();vi.useRealTimers();closeDatabase();Reflect.set(ioBudget,"read",realRead);Reflect.set(ioBudget,"admissionRead",realAdmissionRead);ioBudget.setIsIdle(()=>false);ioBudget.resetAdmissionForFixture();});
afterAll(()=>{if(prior===undefined)delete process.env.MURAGE_ENGINE_EXCLUSION_PATH;else process.env.MURAGE_ENGINE_EXCLUSION_PATH=prior;forgetExclusionAddon();resetIoMeterForTest();rmSync(root,{recursive:true,force:true});});
function fill(){const t=ioBudget.admit("BG",12*1024*1024)!;expect(t,"full-ledger fixture").not.toBeNull();ioBudget.settle(t,t.bytes);}
function enqueue(){appendMessage("fixture-thread",{id:"fixture-message",at:1,role:"user",kind:"text",text:"Remember the fixture preference."});expect(database().prepare("SELECT status FROM memory_jobs LIMIT 1").get()?.status).toBe("pending");}
it("an adaptive helper can replan into remaining BG room; fixed requests keep their full ceiling",()=>{
 const MiB=1024*1024,i=controller as unknown as Internals,child=i.child!;
 const occupied=ioBudget.admit("BG",2*MiB)!;
 expect(occupied).not.toBeNull();
 for(const replan of [undefined,false,"true"]){
  i.onWorkerMessage(child,{type:"bg-grant-request",ceiling:11*MiB,replan});
  expect((child.send.mock.calls.at(-1)![0] as {ticket:unknown}).ticket).toBeNull();
 }
 i.onWorkerMessage(child,{type:"bg-grant-request",ceiling:11*MiB,replan:true});
 const offer=(child.send.mock.calls.at(-1)![0] as {ticket:{id:string;bytes:number;stepBytes:number}}).ticket;
 expect(offer).not.toBeNull();expect(offer.bytes).toBe(8*MiB);expect(offer.stepBytes).toBe(offer.bytes);
 // The parent still needs room to acknowledge receipts and keep capture
 // leases alive while maintenance holds this pool.
 const parent=ioBudget.admit("BG",MiB,MiB)!;expect(parent).not.toBeNull();
 expect(ioBudget.admissionState().reserved).toBe(12*MiB);
 ioBudget.settle(parent,0);
 i.receiveWorkerMessage(child,{type:"bg-grant-settle",id:offer.id,used:0});
 ioBudget.settle(occupied,0);
 expect(ioBudget.admissionState().reserved).toBe(0);
});
it("even an initially fitting adaptive pool leaves a full parent statement and its copy reserve",()=>{
 const MiB=1024*1024,i=controller as unknown as Internals,child=i.child!;
 i.onWorkerMessage(child,{type:"bg-grant-request",ceiling:11*MiB,replan:true});
 const offer=(child.send.mock.calls.at(-1)![0] as {ticket:{id:string;bytes:number;stepBytes:number}}).ticket;
 expect(offer.bytes).toBe(10*MiB);expect(offer.stepBytes).toBe(offer.bytes);
 const parent=ioBudget.admit("BG",MiB,MiB)!;expect(parent).not.toBeNull();
 expect(ioBudget.admissionState().reserved).toBe(12*MiB);
 ioBudget.settle(parent,0);i.receiveWorkerMessage(child,{type:"bg-grant-settle",id:offer.id,used:0});
 expect(ioBudget.admissionState().reserved).toBe(0);
});
it("capture waits for the helper module but can run while index-open admission is pending",async()=>{
 enqueue();const i=controller as unknown as Internals,child=i.child!;i.ready=false;
 Reflect.set(controller,"initDeadline",Date.now()+120000);
 i.tick(true);
 expect(claimMemoryJob).not.toHaveBeenCalled();
 i.onWorkerMessage(child,{type:"ready"});
 // The first tick still owns its pacing delay; module readiness does not
 // bypass it. Observe the next admitted tick before checking the capture.
 await vi.waitFor(()=>{i.tick(true);expect(claimMemoryJob).toHaveBeenCalled();});
 expect(claimMemoryJob).toHaveBeenCalledTimes(1);
 expect(child.send.mock.calls.some(([m])=>(m as {stage?:string}).stage==="capture")).toBe(true);
 expect(child.send.mock.calls.some(([m])=>(m as {type?:string}).type==="index")).toBe(false);
 expect(i.ready).toBe(false);
});
it("T1 requested wake under a full ledger never calls claim and leaves the job pending",()=>{
 enqueue();fill();const i=controller as unknown as Internals;
 ioBudget.withSource("memory-worker",()=>i.tick(true));
 expect(claimMemoryJob,"T1 Admit precedes claim, including requested wakes").not.toHaveBeenCalled();
 expect(database().prepare("SELECT status FROM memory_jobs LIMIT 1").get()?.status,"T1 durable job remains pending").toBe("pending");
 at=60000;i.nextEligibleWorkAt=0;ioBudget.withSource("memory-worker",()=>i.tick(true));
 expect(claimMemoryJob,"T1 passing control claims next active minute").toHaveBeenCalled();
 expect(database().prepare("SELECT status FROM memory_jobs LIMIT 1").get()?.status).toBe("leased");
});
it("T2 saturated indexing cannot lease capture before admission",()=>{
 enqueue();fill();const i=controller as unknown as Internals;i.indexing=true;i.indexDeadline=Date.now()+60000;
 ioBudget.withSource("memory-worker",()=>i.tick(true));
 expect(claimMemoryJob,"T2 capture Admit precedes claim while indexing").not.toHaveBeenCalled();
 expect(database().prepare("SELECT status FROM memory_jobs LIMIT 1").get()?.status,"T2 capture stays pending").toBe("pending");
 at=60000;i.nextEligibleWorkAt=0;ioBudget.withSource("memory-worker",()=>i.tick(true));
 expect(database().prepare("SELECT status FROM memory_jobs LIMIT 1").get()?.status,"T2 admitted control leases").toBe("leased");
});
it("T7 refresh-style later retry re-admits after a full ledger without an error state",async()=>{
 const db=database();db.exec("CREATE TABLE fixture_retry(v)");fill();
 vi.useFakeTimers({toFake:["setTimeout","clearTimeout","setImmediate"]});
 const i=controller as unknown as Internals;
 i.later(()=>db.exec("INSERT INTO fixture_retry VALUES(1)"));await vi.advanceTimersByTimeAsync(1);
 expect(db.prepare("SELECT count(*) n FROM fixture_retry").get()?.n,"T7 refused retry does not step").toBe(0);
 expect(controller.error,"T7 deferral is not an error").toBeNull();
 at=60000;await vi.advanceTimersByTimeAsync(60001);
 expect(db.prepare("SELECT count(*) n FROM fixture_retry").get()?.n,"T7 later re-admits").toBe(1);
});
it("T15 stop releases outstanding permits and prevents parked publication and late settlement",async()=>{
 const db=database();db.exec("CREATE TABLE fixture_parked(v)");
 const i=controller as unknown as Internals,child=i.child!;
 i.onWorkerMessage(child,{type:"bg-grant-request",ceiling:1024*1024});
 expect(i.helperGrants.size,"T15 outstanding permit exists").toBe(1);
 let checkpoint:boolean|null=null;
 const checkpointDone=controller.requestCheckpoint().then(value=>{checkpoint=value;});
 const sent=child.send.mock.calls.map(([m])=>m as {type?:string;requestId?:string}).find(m=>m.type==="checkpoint")!;
 i.later(()=>db.exec("INSERT INTO fixture_parked VALUES(1)"));
 await controller.stop();await Promise.resolve();
 expect(checkpoint,"T15 outstanding checkpoint resolves false on STOP").toBe(false);
 await checkpointDone;
 i.receiveWorkerMessage(child,{type:"checkpoint-result",requestId:sent.requestId,ok:true});
 expect(checkpoint,"T15 late acknowledgement cannot turn STOP into success").toBe(false);await new Promise<void>(resolve=>setImmediate(resolve));
 expect(i.helperGrants.size,"T15 outstanding permits settled on STOP").toBe(0);
 expect(ioBudget.admissionState().reserved,"T15 no reservation leak").toBe(0);
 i.receiveWorkerMessage(child,{type:"bg-grant-settle",id:"stale-permit",used:1});
 expect(db.prepare("SELECT count(*) n FROM fixture_parked").get()?.n,"T15 parked publication never runs after STOP").toBe(0);
});
it("T20 helper never spawns idle and every active spawn carries a boot grant",()=>{
 const i=controller as unknown as Internals;i.child=null;i.ready=false;
 ioBudget.setIsIdle(()=>true);i.spawn();
 expect(fork,"T20 idle helper spawn refused").not.toHaveBeenCalled();
 ioBudget.setIsIdle(()=>false);const child=new Child();vi.mocked(fork).mockReturnValue(child as unknown as ReturnType<typeof fork>);i.spawn();
 expect(fork,"T20 active control starts helper").toHaveBeenCalledTimes(1);
 const options=vi.mocked(fork).mock.calls[0]![2] as {env:NodeJS.ProcessEnv};
 expect(options.env.MURAGE_BG_BOOT,"T20 boot grant carried into environment").toBeTypeOf("string");
 const ticket=JSON.parse(options.env.MURAGE_BG_BOOT!);
 expect(ticket.bytes,"T20 boot allowance is explicit").toBe(1024*1024);
 expect(ticket.expiresAt,"T20 boot allowance lapses").toBeGreaterThan(Date.now());
 expect(ioGrantSnapshot().refusedWrites,"T20 no owner refusal").toBeGreaterThanOrEqual(0);
});

it("T8 receipt publication admits before entering its transaction and retries without losing acknowledgement",async()=>{
 enqueue();const db=database(),scope=String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
 db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES('fixture-record',1,?,'fact','fixture','owner-statement','active',0,0)").run(scope);
 db.exec("INSERT INTO memory_projection_receipts VALUES('fixture-record',1,0,'pending','pending',NULL)");
 const i=controller as unknown as Internals&{indexRequestId:string;indexSent:Map<string,string>};
 i.indexing=true;i.indexRequestId="fixture-index";i.indexSent=new Map([["fixture-record\u00001","active"]]);
 fill();vi.mocked(transaction).mockClear();
 vi.useFakeTimers({toFake:["setTimeout","clearTimeout","setImmediate"]});
 i.onWorkerMessage(i.child!,{type:"index-result",requestId:"fixture-index",records:[{id:"fixture-record",version:1,deleted:false}],embeddingStatus:"indexed"});
 await vi.advanceTimersByTimeAsync(1);
 expect(transaction,"T8 receipt Admit precedes transaction").not.toHaveBeenCalled();
 expect(db.prepare("SELECT lexical_status FROM memory_projection_receipts WHERE record_id='fixture-record'").get()?.lexical_status,"T8 saturated receipt stays pending").toBe("pending");
 at=60000;await vi.advanceTimersByTimeAsync(60001);
 expect(db.prepare("SELECT lexical_status FROM memory_projection_receipts WHERE record_id='fixture-record'").get()?.lexical_status,"T8 receipt control re-admits").toBe("indexed");
 expect(ioBudget.admissionState().bg,"T8 receipt bytes charged").toBeGreaterThan(0);
});
it("T8 independent notebook scheduling retains owner priority and admits its database bytes",()=>{
 const db=database();db.exec("CREATE TABLE fixture_notebook(v)");
 const sources:Array<string|undefined>=[];
 controller=new MemoryWorkerController({onNotebookSync:()=>{sources.push(ioBudget.currentSource());db.exec("INSERT INTO fixture_notebook VALUES(1)");}});
 const run=()=>{(controller as unknown as {syncNotebooks():void}).syncNotebooks();};
 const pacing=vi.spyOn(ioBudget,"shouldDefer").mockReturnValue(false);
 try{
  fill();run();
  expect(db.prepare("SELECT count(*) n FROM fixture_notebook").get()?.n,"T8 notebook cannot bypass byte admission").toBe(0);
  expect(controller.error,"T8 notebook byte deferral is pending").toBeNull();
  at=60000;run();
  expect(db.prepare("SELECT count(*) n FROM fixture_notebook").get()?.n,"T8 admitted notebook control writes").toBe(1);
  expect(sources,"T8 independent notebook owner scheduling source retained").toEqual(["owner-notebook","owner-notebook"]);
  expect(ioBudget.admissionState().bg,"T8 notebook bytes charged").toBeGreaterThan(0);
 }finally{pacing.mockRestore();}
});
it("A3 dispatch plans its step from remaining room after server background work",()=>{
 enqueue();const db=database(),scope=String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
 db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES('fixture-small',1,?,'fact','fixture','owner-statement','active',0,0)").run(scope);
 db.exec("INSERT INTO memory_projection_receipts VALUES('fixture-small',1,0,'pending','pending',NULL)");
 const paid=ioBudget.admit("BG",2*1024*1024)!;ioBudget.settle(paid,paid.bytes);
 const i=controller as unknown as Internals;
 ioBudget.withSource("memory-worker",()=>i.tick(true));
 const sent=i.child!.send.mock.calls.map(([m])=>m as {type?:string;grant?:{bytes:number;stepBytes:number}}).find(m=>m.type==="index");
 expect(sent,"A3 dispatch uses a smaller whole permit without waiting a minute").toBeDefined();
 expect(sent!.grant!.bytes,"A3 dispatch fits remaining minute room").toBeLessThanOrEqual(10*1024*1024);
 expect(sent!.grant!.stepBytes,"A3 issuer carries planning room to the helper").toBe(sent!.grant!.bytes);
 const state=ioBudget.admissionState();expect(state.bg+state.debt+state.reserved,"A3 dispatch preserves minute bound").toBeLessThanOrEqual(12*1024*1024);
});

it.each([[2600960,9900032,40960],[2486272,10022912,36864]])('capture snapshot %i/%i: native minimum commit refuses before lease, settlement restores it', (charged,reserved,cap)=>{
 ioBudget.start();enqueue();
 const paid=ioBudget.admit('BG',charged)!;ioBudget.settle(paid,charged);
 const pool=ioBudget.admit('BG',reserved)!;
 const i=controller as unknown as Internals;
 expect(Math.floor(ioBudget.backgroundRoom()/2)).toBe(cap);
 ioBudget.noteBytes('memory-worker',1024*1024);
 expect(ioBudget.deferredForMs('memory-worker')).toBeGreaterThan(0);
 const writes=writeStatementCount(database()),refusals=ioGrantSnapshot().refusedWrites;
 ioBudget.withSource('memory-worker',()=>i.tick(true));
 expect(writeStatementCount(database()),'minimum commit refused before stepping SQLite').toBe(writes);
 expect(ioGrantSnapshot().refusedWrites,'refusal is parent admission, before the native grant').toBe(refusals);
 expect(database().prepare('SELECT status FROM memory_jobs LIMIT 1').get()?.status).toBe('pending');
 expect(ioBudget.admissionState().reserved).toBe(reserved);
 ioBudget.settle(pool,0);i.nextEligibleWorkAt=0;
 ioBudget.withSource('memory-worker',()=>i.tick(true));
 expect(database().prepare('SELECT status FROM memory_jobs LIMIT 1').get()?.status).toBe('leased');
 expect(ioBudget.admissionState().reserved).toBe(0);
});
it('an owed capture can claim on an idle minute while unrelated BG remains refused',()=>{
 enqueue();at=60000;ioBudget.setIsIdle(()=>true);
 expect(ioBudget.admit('BG',61440,61440)).toBeNull();
 const i=controller as unknown as Internals;
 ioBudget.withSource('memory-worker',()=>i.tick(true));
 expect(database().prepare('SELECT status FROM memory_jobs LIMIT 1').get()?.status).toBe('leased');
 expect(ioBudget.admissionState().reserved).toBe(0);
});
it('a capture write refused only by another holder\'s live reservation retries when it settles, not at the next minute',()=>{
 enqueue();at=23900;
 // Spent BG bytes plus an index step's live reservation leave capture no room; only the reservation is still unsettled.
 const spent=ioBudget.admit('BG',4*1024*1024)!;ioBudget.settle(spent,spent.bytes);
 const held=ioBudget.admit("BG",8*1024*1024-16384)!;expect(held,'index reservation fixture').not.toBeNull();
 const next=ioBudget.nextAdmissionMs();
 const refuse=()=>{try{ioBudget.withSource('memory-capture',()=>transaction(()=>{database().prepare('UPDATE memory_meta SET data_revision=data_revision').run();}));}catch(error){return error;}return null;};
 const retry=(e:unknown)=>(controller as unknown as {bgRetryMs(e:BgDeferred):number}).bgRetryMs(e as BgDeferred);
 const first=refuse();
 expect(isBgDeferred(first),'capture write refused behind the reservation').toBe(true);
 expect(retry(first)).toBeLessThanOrEqual(2000);
 expect(retry(first)).toBeLessThan(next);
 // With the reservation settled the same capture write is admitted.
 ioBudget.settle(held,0);
 expect(refuse()).toBeNull();
});
it('an owed capture job refused only by a live reservation is claimed within a second of its settle, not at the next minute',()=>{
 enqueue();at=23900;
 const spent=ioBudget.admit('BG',4*1024*1024)!;ioBudget.settle(spent,spent.bytes);
 const held=ioBudget.admit("BG",8*1024*1024-16384)!;expect(held,'index reservation fixture').not.toBeNull();
 const rest=ioBudget.admit("BG",ioBudget.backgroundRoom())!;expect(rest,'a second reservation leaves no room').not.toBeNull();expect(ioBudget.backgroundRoom()).toBe(0);
 const i=controller as unknown as Internals;
 const schedule=vi.spyOn(controller as unknown as {schedule(ms:number):void},'schedule');
 i.nextEligibleWorkAt=0;
 ioBudget.withSource('memory-worker',()=>i.tick(true));
 expect(claimMemoryJob).not.toHaveBeenCalled();
 const delays=schedule.mock.calls.map(c=>c[0] as number);
 expect(delays,'the work loop retries at the reservation step').toContain(1000);
 expect(delays,'and does not wait for the minute').not.toContain(ioBudget.nextAdmissionMs());
 ioBudget.settle(held,0);ioBudget.settle(rest,0);i.nextEligibleWorkAt=0;
 ioBudget.withSource('memory-worker',()=>i.tick(true));
 expect(database().prepare('SELECT status FROM memory_jobs LIMIT 1').get()?.status).toBe('leased');
});
it('a non-capture job refused by a live reservation still waits for the next minute',()=>{
 enqueue();at=23900;
 database().prepare("UPDATE memory_jobs SET stage='index'").run();
 const spent=ioBudget.admit('BG',4*1024*1024)!;ioBudget.settle(spent,spent.bytes);
 const held=ioBudget.admit("BG",8*1024*1024-16384)!;expect(held,'index reservation fixture').not.toBeNull();
 const rest=ioBudget.admit("BG",ioBudget.backgroundRoom())!;expect(rest,'a second reservation leaves no room').not.toBeNull();expect(ioBudget.backgroundRoom()).toBe(0);
 const i=controller as unknown as Internals;
 const schedule=vi.spyOn(controller as unknown as {schedule(ms:number):void},'schedule');
 i.nextEligibleWorkAt=0;
 ioBudget.withSource('memory-worker',()=>i.tick(true));
 const delays=schedule.mock.calls.map(c=>c[0] as number);
 expect(delays,'non-capture work waits for the minute').toContain(ioBudget.nextAdmissionMs());
 expect(delays,'no reservation-step retry for non-capture work').not.toContain(1000);
 ioBudget.settle(held,0);ioBudget.settle(rest,0);
});
it('a capture write refused by spent bytes alone still waits for the next minute',()=>{
 enqueue();at=23900;fill();
 const refuse=()=>{try{ioBudget.withSource('memory-capture',()=>transaction(()=>{database().prepare('UPDATE memory_meta SET data_revision=data_revision').run();}));}catch(error){return error;}return null;};
 const err=refuse();
 expect(isBgDeferred(err)).toBe(true);
 expect((controller as unknown as {bgRetryMs(e:BgDeferred):number}).bgRetryMs(err as BgDeferred)).toBe(ioBudget.nextAdmissionMs());
});
it('an owed capture write reserves its copy at the per-frame bound; other writers keep the half split',()=>{
 enqueue();at=60000;ioBudget.setIsIdle(()=>true);
 const os=ioGrantSnapshot().pageSize,page=Number(database().prepare('PRAGMA page_size').get()!.page_size);
 // Every WAL frame is charged at least one OS page of header plus its page span, and owes exactly one page span of copy.
 const copy=Math.ceil(page/os)*os,frame=os+copy;
 const grant=(source:string)=>ioBudget.withSource(source,()=>{
   const room=ioBudget.backgroundRoom();
   return transaction(()=>{
     database().prepare('UPDATE memory_meta SET data_revision=data_revision').run();
     return {room,cap:ioGrantSnapshot().capBytes,reserved:ioBudget.admissionState().reserved};
   });
 });
 const capture=grant('memory-capture');
 expect(capture.room).toBeGreaterThan(0);
 expect(capture.cap).toBe(Math.floor(capture.room*frame/(frame+copy)));
 expect(capture.reserved).toBe(capture.cap+Math.floor(capture.cap/frame)*copy);
 expect(capture.reserved).toBeLessThanOrEqual(capture.room);
 expect(ioBudget.admissionState().reserved).toBe(0);
 const settled=ioBudget.admissionState();
 expect(settled.total+settled.debt).toBeLessThanOrEqual(1024*1024-65536);
 at=120000;ioBudget.setIsIdle(()=>false);
 const worker=grant('memory-worker');
 expect(worker.cap).toBe(Math.min(Math.floor(worker.room/2),1024*1024));
 expect(worker.reserved).toBe(2*worker.cap);
 expect(ioBudget.admissionState().reserved).toBe(0);
});
it('idle capture publishes the real bounded chunk result without opening an index grant',async()=>{
 enqueue();at=60000;ioBudget.setIsIdle(()=>true);
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setImmediate']});
 const i=controller as unknown as Internals,child=i.child!;
 ioBudget.withSource('memory-worker',()=>i.tick(true));
 const work=child.send.mock.calls.map(([m])=>m as import('./worker-protocol.ts').MemoryWork).find(m=>m.stage==='capture');
 expect(work).toBeDefined();
 const {captureWork}=await import('./chunks.ts');
 i.onWorkerMessage(child,{type:'result',result:captureWork(work!)});
 await vi.advanceTimersByTimeAsync(1);
 expect(database().prepare('SELECT status FROM memory_jobs LIMIT 1').get()?.status).toBe('complete');
 expect(child.send.mock.calls.some(([m])=>(m as {type?:string}).type==='index')).toBe(false);
 // Publication can spend this minute's idle room; refresh remains owed for the next admitted minute.
 at=120000;await vi.advanceTimersByTimeAsync(60001);
 expect(database().prepare("SELECT text FROM memory_records WHERE kind='checkpoint' AND state='active'").get()?.text, 'idle completion refreshes its checkpoint without another owner turn').toContain('Remember the fixture preference.');
 const state=ioBudget.admissionState();expect(state.bg+state.debt+state.reserved).toBeLessThanOrEqual(1024*1024-65536);
 expect(state.reserved).toBe(0);
});

it.each([false,true])('an owed checkpoint retries a real idle byte refusal; stopped=%s',async stopped=>{
 enqueue();at=60000;ioBudget.setIsIdle(()=>true);
 const actual=await vi.importActual<typeof import('./consolidate.ts')>('./consolidate.ts');
 let occupied:NonNullable<ReturnType<typeof ioBudget.admit>>|undefined;
 vi.mocked(refreshMemoryCheckpoint).mockClear();
 vi.mocked(refreshMemoryCheckpoint).mockImplementationOnce(id=>{
   occupied=ioBudget.withSource('memory-capture',()=>{
     const half=Math.floor(ioBudget.backgroundRoom()/2);
     return ioBudget.admit('BG',half,half)!;
   });
   expect(occupied, 'reserve the actual idle byte/copy pool before the checkpoint write').not.toBeNull();
   return actual.refreshMemoryCheckpoint(id);
 });
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setImmediate']});
 const i=controller as unknown as Internals,child=i.child!;
 ioBudget.withSource('memory-worker',()=>i.tick(true));
 const work=child.send.mock.calls.map(([m])=>m as import('./worker-protocol.ts').MemoryWork).find(m=>m.stage==='capture')!;
 const {captureWork}=await import('./chunks.ts');
 i.onWorkerMessage(child,{type:'result',result:captureWork(work)});
 await vi.advanceTimersByTimeAsync(1);
 expect(database().prepare('SELECT status FROM memory_jobs LIMIT 1').get()?.status).toBe('complete');
 expect(refreshMemoryCheckpoint).toHaveBeenCalledTimes(1);
 expect(database().prepare("SELECT 1 FROM memory_records WHERE kind='checkpoint'").get()).toBeUndefined();
 ioBudget.settle(occupied!,0);
 if(stopped)await controller.stop();
 at=120000;await vi.advanceTimersByTimeAsync(60001);
 expect(Boolean(database().prepare("SELECT 1 FROM memory_records WHERE kind='checkpoint' AND state='active'").get()), 'owed checkpoint survives refusal, but not controller STOP').toBe(!stopped);
 expect(controller.error).toBeNull();
 expect(ioBudget.admissionState().reserved).toBe(0);
});

it('owed checkpoint retries yield to an in-flight capture before spending idle room',async()=>{
 enqueue();appendMessage('fixture-thread',{id:'fixture-message-two',parentId:'fixture-message',at:2,role:'user',kind:'text',text:'Second fixture preference.'});
 at=60000;ioBudget.setIsIdle(()=>true);
 const actual=await vi.importActual<typeof import('./consolidate.ts')>('./consolidate.ts');
 let occupied:NonNullable<ReturnType<typeof ioBudget.admit>>|undefined;
 vi.mocked(refreshMemoryCheckpoint).mockClear();
 vi.mocked(refreshMemoryCheckpoint).mockImplementationOnce(id=>{
   occupied=ioBudget.withSource('memory-capture',()=>{const half=Math.floor(ioBudget.backgroundRoom()/2);return ioBudget.admit('BG',half,half)!;});
   expect(occupied).not.toBeNull();return actual.refreshMemoryCheckpoint(id);
 });
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setImmediate']});
 const i=controller as unknown as Internals,child=i.child!;
 ioBudget.withSource('memory-worker',()=>i.tick(true));
 const sent=()=>child.send.mock.calls.map(([m])=>m as import('./worker-protocol.ts').MemoryWork).filter(m=>m.stage==='capture');
 const {captureWork}=await import('./chunks.ts');
 i.onWorkerMessage(child,{type:'result',result:captureWork(sent()[0]!)});await vi.advanceTimersByTimeAsync(1);
 expect(database().prepare("SELECT count(*) n FROM memory_jobs WHERE status='complete'").get()?.n).toBe(1);
 ioBudget.settle(occupied!,0);
 at=120000;i.nextEligibleWorkAt=0;ioBudget.withSource('memory-worker',()=>i.tick(true));
 expect(sent()).toHaveLength(2);
 await vi.advanceTimersByTimeAsync(60001);
 expect(refreshMemoryCheckpoint, 'deferred derived work cannot take the idle room of the capture already leased').toHaveBeenCalledTimes(1);
 // This controlled-clock fixture stops the WAL copier. Finish the held result
 // under the ordinary active ceiling; the real API fixture proves idle draining
 // with the copier running. No debt or reservation is reset for this control.
 ioBudget.setIsIdle(()=>false);
 i.onWorkerMessage(child,{type:'result',result:captureWork(sent()[1]!)});await vi.advanceTimersByTimeAsync(1);
 expect(database().prepare("SELECT count(*) n FROM memory_jobs WHERE status='complete'").get()?.n).toBe(2);
 at=180000;await vi.advanceTimersByTimeAsync(60001);
 expect(database().prepare("SELECT text FROM memory_records WHERE kind='checkpoint' AND state='active'").get()?.text).toContain('Second fixture preference.');
});

// H1 (arev-conf-warmcap-par): a capture's checkpoint deferred while its evidence is checked keeps capture admission, also after a restart; bounded.
async function idleCaptureDeferred(always:boolean){
 enqueue();at=60000;ioBudget.setIsIdle(()=>true);
 const actual=await vi.importActual<typeof import('./consolidate.ts')>('./consolidate.ts');
 let captureCalls=0;
 vi.mocked(refreshMemoryCheckpoint).mockClear();
 onTestFinished(()=>{vi.mocked(refreshMemoryCheckpoint).mockImplementation(actual.refreshMemoryCheckpoint);});
 vi.mocked(refreshMemoryCheckpoint).mockImplementation(id=>{
   if(ioBudget.currentSource()==='memory-capture')captureCalls++;
   if(always||captureCalls===1)return {status:'deferred',reason:'evidence-checking'};
   return actual.refreshMemoryCheckpoint(id);
 });
 const i=controller as unknown as Internals,child=i.child!;
 ioBudget.withSource('memory-worker',()=>i.tick(true));
 const work=child.send.mock.calls.map(([m])=>m as import('./worker-protocol.ts').MemoryWork).find(m=>m.stage==='capture')!;
 const {captureWork}=await import('./chunks.ts');
 i.onWorkerMessage(child,{type:'result',result:captureWork(work)});
 await vi.advanceTimersByTimeAsync(1);
 expect(database().prepare('SELECT status FROM memory_jobs LIMIT 1').get()?.status).toBe('complete');
 expect(captureCalls).toBe(1);
 return {captureCalls:()=>captureCalls};
}
const checkpointText=()=>database().prepare("SELECT text FROM memory_records WHERE kind='checkpoint' AND state='active'").get()?.text;
const debtMarkers=()=>database().prepare("SELECT count(*) n FROM memory_scope_bindings WHERE subject_id='checkpoint-pending'").get()?.n;

it('a capture checkpoint deferred while its evidence is checked drains on an idle minute without another owner turn',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setImmediate']});
 await idleCaptureDeferred(false);
 expect(checkpointText()).toBeUndefined();expect(debtMarkers()).toBe(1);
 at=120000;await vi.advanceTimersByTimeAsync(60001);
 expect(checkpointText(), 'the deferred checkpoint is retried under capture admission while idle').toContain('Remember the fixture preference.');
 expect(debtMarkers()).toBe(0);expect(controller.error).toBeNull();
 expect(ioBudget.admissionState().reserved).toBe(0);
});

it('capture checkpoint debt left by a previous run drains on an idle minute after restart',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setImmediate']});
 await idleCaptureDeferred(false);
 await controller.stop();
 expect(checkpointText()).toBeUndefined();expect(debtMarkers()).toBe(1);
 controller=new MemoryWorkerController({startHoldMs:0});
 const i=controller as unknown as Internals;i.child=new Child();i.ready=true;
 vi.spyOn(controller as unknown as {independentWork():void},'independentWork').mockImplementation(()=>{});
 vi.spyOn(controller,'warmForIntent').mockImplementation(()=>{});
 controller.start();
 at=120000;await vi.advanceTimersByTimeAsync(60001);
 expect(checkpointText(), 'restart keeps the capture-owed checkpoint on capture admission').toContain('Remember the fixture preference.');
 expect(debtMarkers()).toBe(0);expect(controller.error).toBeNull();
});

it('a capture checkpoint whose evidence stays in checking is retried for a bounded wait, then left owed and unpublished',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setImmediate','performance']});
 const run=await idleCaptureDeferred(true);
 at=120000;await vi.advanceTimersByTimeAsync(60001);
 expect(run.captureCalls(), 'retried while idle').toBeGreaterThan(1);
 await vi.advanceTimersByTimeAsync(5*60_000);
 const settled=run.captureCalls();
 await vi.advanceTimersByTimeAsync(120_000);
 expect(run.captureCalls(), 'no capture-admission retry past the bounded wait').toBe(settled);
 expect(checkpointText()).toBeUndefined();expect(debtMarkers(), 'the debt stays owed, never published unchecked').toBe(1);
 expect(controller.error).toBeNull();
});

it('a refused helper grant parks the index deadline without killing the capture helper',()=>{
 enqueue();fill();const i=controller as unknown as Internals,child=i.child!,killed=vi.spyOn(child,'kill');
 i.indexing=true;i.indexDeadline=Date.now()-1;
 const before=ioBudget.admissionState();
 i.onWorkerMessage(child,{type:'bg-grant-request',ceiling:1024*1024});
 expect((child.send.mock.calls.at(-1)![0] as {ticket:unknown}).ticket).toBeNull();
 expect(ioBudget.admissionState()).toEqual(before);
 i.tick(true);
 expect(killed,'an acknowledged admission wait is not a hung helper').not.toHaveBeenCalled();
 expect(controller.error).toBeNull();expect(claimMemoryJob).not.toHaveBeenCalled();
 at=60000;i.nextEligibleWorkAt=0;i.tick(true);
 expect(claimMemoryJob,'capture still uses the live helper at the next admitted window').toHaveBeenCalled();
 expect(child.send.mock.calls.some(([m])=>(m as {stage?:string}).stage==='capture')).toBe(true);
});

it('a publication parked by native byte admission does not become a CPU timeout',async()=>{
 enqueue();vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setImmediate']});
 const i=controller as unknown as Internals,child=i.child!,killed=vi.spyOn(child,'kill');
 i.tick(true);const work=child.send.mock.calls.map(([m])=>m as import('./worker-protocol.ts').MemoryWork).find(m=>m.stage==='capture')!;
 const pool=ioBudget.admit('BG',ioBudget.backgroundRoom())!;expect(pool).not.toBeNull();
 try{
  const before=ioBudget.admissionState(),{captureWork}=await import('./chunks.ts');
  i.onWorkerMessage(child,{type:'result',result:captureWork(work)});await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(60001);i.tick(true);
  expect(killed,'the CPU result already arrived; only its byte permit is outstanding').not.toHaveBeenCalled();
  expect(controller.error).toBeNull();
  expect(database().prepare('SELECT status,attempts FROM memory_jobs LIMIT 1').get()).toMatchObject({status:'leased',attempts:0});
  expect(ioBudget.admissionState()).toEqual(before);
  expect(ioBudget.withSource('memory-capture',()=>ioBudget.admit('BG',61440,61440))).toBeNull();
 }finally{ioBudget.settle(pool,0);}
});

it("startup adaptive maintenance leaves capture publication room while copy charges are held",()=>{
 controller=new MemoryWorkerController();const i=controller as unknown as Internals,child=new Child();i.child=child;i.ready=true;
 i.onWorkerMessage(child,{type:"bg-grant-request",ceiling:11*1024*1024,replan:true});
 const offer=(child.send.mock.calls.at(-1)![0] as {ticket:{id:string;bytes:number;stepBytes:number}}).ticket;
 const page=ioMeterPageSize(),frames=META_ENVELOPE_FRAMES+32;
 expect(offer.bytes).toBe(commitCeiling(frames,4096,page)+checkpointCeiling(frames,4096,page)+4*page);
 expect(offer.stepBytes).toBe(offer.bytes);
 const publication=ioBudget.admit("BG",2*1024*1024,2*1024*1024);
 expect(publication).not.toBeNull();
 ioBudget.settle(publication!,0);i.receiveWorkerMessage(child,{type:"bg-grant-settle",id:offer.id,used:0});
 expect(ioBudget.admissionState().reserved).toBe(0);
});
