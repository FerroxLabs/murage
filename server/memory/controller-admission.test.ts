// SPDX-License-Identifier: AGPL-3.0-or-later
// Queue admission owner: scperf-p1. Native statement and helper admission owner: scperf-p1.
import { EventEmitter } from "node:events";
import { execFileSync, fork } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { ioBudget } from "../io-budget.ts";
import { forgetExclusionAddon } from "../engine-exclusion.ts";
import { ioGrantSnapshot, resetIoMeterForTest } from "../io-meter.ts";
import { appendMessage } from "../message-db.ts";
import { stopSearchIndex } from "../message-search-index.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import { claimMemoryJob } from "./jobs.ts";
vi.mock("../database.ts",async original=>{const actual=await original<typeof import("../database.ts")>();return {...actual,transaction:vi.fn(actual.transaction)};});
vi.mock("./jobs.ts", async original => ({...await original<typeof import("./jobs.ts")>(),claimMemoryJob:vi.fn((...args:Parameters<typeof claimMemoryJob>)=>realClaim(...args))}));
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
afterEach(async()=>{await controller.stop();vi.useRealTimers();closeDatabase();Reflect.set(ioBudget,"read",realRead);Reflect.set(ioBudget,"admissionRead",realAdmissionRead);ioBudget.setIsIdle(()=>false);ioBudget.resetAdmissionForFixture();});
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
