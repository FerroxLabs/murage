// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 MEMORY-V2 W5 transport witness (owner of this witness and of io-budget admitIndexDebt: memv2-D; owner of the transport under test,
// worker-controller.ts bg-grant-request: lane E, commit "W5 transport (E-owned)", MAIN-RULING 2026-11-21T20:15:47Z). The harness is the one of
// controller-admission.test.ts (lane E / scperf-p1), copied so lane E's test file is not edited: the real controller handler, a stand-in child.
import { EventEmitter } from "node:events";
import { execFileSync, fork } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { ioBudget } from "../io-budget.ts";
import { forgetExclusionAddon } from "../engine-exclusion.ts";
import { resetIoMeterForTest } from "../io-meter.ts";
import { stopSearchIndex } from "../message-search-index.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import { copyCeiling, indexDebtPage, INDEX_LOG_MAX_FRAMES } from "./index-debt-ceiling.ts";
vi.mock("node:child_process",async original=>({...await original<typeof import("node:child_process")>(),fork:vi.fn()}));
const root=mkdtempSync(join(tmpdir(),"index-debt-controller-"));
const prior=process.env.MURAGE_ENGINE_EXCLUSION_PATH;
let at=0,controller:MemoryWorkerController;
const realRead=Reflect.get(ioBudget,"read") as ()=>unknown;
const realAdmissionRead=Reflect.get(ioBudget,"admissionRead") as ()=>unknown;
class Child extends EventEmitter {
 send=vi.fn((_message:unknown)=>true); connected=true; stderr=null;
 kill(){this.emit("exit",0);return true;}disconnect(){this.emit("exit",0);}
}
type Internals={child:Child|null;ready:boolean;started:boolean;indexing:boolean;indexDeadline:number;nextEligibleWorkAt:number;nextWarmAt:number;initDeadline:number;helperGrants:Map<string,unknown>;tick(requested:boolean):void;later(work:()=>void):void;onWorkerMessage(child:Child,message:unknown):void;receiveWorkerMessage(child:Child,message:unknown):void;spawn():void};
beforeAll(async()=>{
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
 vi.mocked(fork).mockClear();
});
afterEach(async()=>{await controller.stop();ioBudget.stop();vi.useRealTimers();closeDatabase();Reflect.set(ioBudget,"read",realRead);Reflect.set(ioBudget,"admissionRead",realAdmissionRead);ioBudget.setIsIdle(()=>false);ioBudget.resetAdmissionForFixture();});
afterAll(()=>{if(prior===undefined)delete process.env.MURAGE_ENGINE_EXCLUSION_PATH;else process.env.MURAGE_ENGINE_EXCLUSION_PATH=prior;forgetExclusionAddon();resetIoMeterForTest();rmSync(root,{recursive:true,force:true});});
it("W5 an index-debt ask over the background minute gets the one index-debt grant, charged to the background bucket at settle",()=>{
 const MiB=1024*1024,K=copyCeiling(INDEX_LOG_MAX_FRAMES,indexDebtPage()),i=controller as unknown as Internals,child=i.child!,last=()=>(child.send.mock.calls.at(-1)![0] as {ticket:{id:string;bytes:number;purpose:string}|null}).ticket;
 expect(ioBudget.backgroundBucketWait(),"the bucket starts level").toBe(0);
 i.onWorkerMessage(child,{type:"bg-grant-request",ceiling:20*MiB});
 expect(last(),"a background ticket never covers 20 MiB").toBeNull();
 i.onWorkerMessage(child,{type:"bg-grant-request",ceiling:K,purpose:"index-debt"});
 const offer=last();
 expect(offer,"the index-debt grant").not.toBeNull();
 expect(offer!.purpose).toBe("index-debt");expect(offer!.bytes).toBe(K);
 i.onWorkerMessage(child,{type:"bg-grant-request",ceiling:K,purpose:"index-debt"});
 expect(last(),"one at a time").toBeNull();
 i.receiveWorkerMessage(child,{type:"bg-grant-settle",id:offer!.id,used:K});
 expect(ioBudget.admissionState().reserved).toBe(0);
 // a whole-C log (7,126 x 4,096 = 27.8 MiB) at 8 MiB a minute: 209 s of bucket debt, longer than the next minute + the 120 s init watch
 expect(ioBudget.backgroundBucketWait()).toBeGreaterThan(200_000);
 i.ready=false; // the helper is still opening: its init watch is armed on the refusal
 i.onWorkerMessage(child,{type:"bg-grant-request",ceiling:K,purpose:"index-debt"});
 expect(last(),"refused while the bucket is behind").toBeNull();
 const reply=child.send.mock.calls.at(-1)![0] as {retryInMs:number};
 expect(reply.retryInMs,"retried at the bucket door's time, not the next minute").toBeGreaterThan(200_000);
 // Opus r4 review M1: the init watch must not kill a helper that waits on that refusal before its retry
 expect(i.initDeadline-Date.now(),"the init watch outlasts the door's retry").toBeGreaterThan(reply.retryInMs);
});
