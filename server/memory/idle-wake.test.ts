// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ioBudget } from "../io-budget.ts";
import { captureSource } from "./capture.ts";
import * as jobs from "./jobs.ts";
import { setMemoryMode } from "./repository.ts";
import { MEMORY_IDLE_SWEEP_MS, MemoryWorkerController } from "./worker-controller.ts";
import type { MemorySearchInput } from "./worker-protocol.ts";

vi.mock("node:child_process",async importOriginal=>({...await importOriginal<typeof import("node:child_process")>(),fork:vi.fn()}));
vi.mock("./jobs.ts",async importOriginal=>{
  const actual=await importOriginal<typeof import("./jobs.ts")>();
  return {...actual,claimMemoryJob:vi.fn(actual.claimMemoryJob)};
});
class Helper extends EventEmitter {
  send=vi.fn((message:{type?:string;requestId?:string})=>{
    if(message.type==="init")setTimeout(()=>this.emit("message",{type:"initialised"}),0);
    return true;
  });
  kill=vi.fn(()=>{this.emit("exit",0);return true;});
  disconnect(){this.emit("exit",0);}
}
let helper:Helper;
let controller:MemoryWorkerController;
const input:MemorySearchInput={query:"notebook",scopeIds:[],policyRevision:0,deletionEpoch:0,historical:false,cursor:"",limit:10,semantic:false};
function enqueue(id="source"){
  captureSource(database(),{id,threadId:"thread",kind:"text",speaker:"owner",outcome:"recorded",text:"A notebook remembers the owner's context"});
}
beforeEach(()=>{
  closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});
  vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
  setMemoryMode("capture");
  helper=new Helper();
  vi.mocked(fork).mockImplementation(()=>{
    setTimeout(()=>helper.emit("message",{type:"ready"}),0);
    return helper as unknown as ReturnType<typeof fork>;
  });
  controller=new MemoryWorkerController();
});
afterEach(async()=>{await controller.stop();closeDatabase();vi.useRealTimers();vi.restoreAllMocks();vi.clearAllMocks();});

it("idle controller wakes at most once per 30 s",async()=>{
  const reads=vi.spyOn(database(),"prepare");
  const idle=vi.fn(async()=>false);
  controller=new MemoryWorkerController({onIdleConsolidation:idle});
  controller.start();
  await vi.advanceTimersByTimeAsync(60*60*1000);
  expect(MEMORY_IDLE_SWEEP_MS).toBe(30_000);
  expect(controller.wakeCount).toBeGreaterThan(0);
  expect(controller.wakeCount).toBeLessThanOrEqual(120);
  expect(fork).not.toHaveBeenCalled();
  expect(jobs.claimMemoryJob).not.toHaveBeenCalled();
  // The one-second consolidation deadline may skip a wake that lands inside it (never more than one here).
  expect(idle.mock.calls.length).toBeLessThanOrEqual(controller.wakeCount);
  expect(idle.mock.calls.length).toBeGreaterThanOrEqual(controller.wakeCount-1);
  expect(reads.mock.calls.filter(([sql])=>/FROM memory_jobs/.test(sql)).length).toBeLessThanOrEqual(245);
});

it("queued work wakes promptly",async()=>{
  controller.start();await vi.advanceTimersByTimeAsync(1000);
  expect(fork).not.toHaveBeenCalled();
  enqueue();enqueue("second");
  await vi.advanceTimersByTimeAsync(1000);
  expect(fork).toHaveBeenCalledTimes(1);
  expect(database().prepare("SELECT status FROM memory_jobs WHERE source_id='source'").get()?.status).toBe("leased");
  expect(jobs.claimMemoryJob).toHaveBeenCalledTimes(1);
  const wakes=controller.wakeCount;
  for(let n=0;n<10;n++)database().prepare("UPDATE memory_jobs SET lease_until=lease_until+1 WHERE status='leased'").run();
  await vi.advanceTimersByTimeAsync(1000);
  expect(controller.wakeCount).toBe(wakes);
});

it("a query spawns the helper",async()=>{
  controller.start();await vi.advanceTimersByTimeAsync(1000);
  expect(fork).not.toHaveBeenCalled();
  const result=controller.search(input,new AbortController().signal);
  expect(fork).toHaveBeenCalledTimes(1);
  expect(helper.send.mock.calls.some(([message])=>message.type==="query")).toBe(false);
  await vi.advanceTimersByTimeAsync(10);
  const query=helper.send.mock.calls.map(([message])=>message).find(message=>message.type==="query") as {requestId:string}|undefined;
  expect(query).toBeDefined();
  const hits=[{id:"record",version:1,score:1}];
  helper.emit("message",{type:"query-result",requestId:query!.requestId,result:{hits,vectorRows:0}});
  await expect(result).resolves.toEqual({hits,vectorRows:0});
  await controller.stop();
  await expect(controller.search(input,new AbortController().signal)).rejects.toThrow("MEMORY_WORKER_NOT_READY");
});

it("bounds waiting queries by cancellation and the query cap",async()=>{
  vi.mocked(fork).mockReturnValue(helper as unknown as ReturnType<typeof fork>);
  const cancelled=new AbortController();cancelled.abort();
  await expect(controller.search(input,cancelled.signal)).rejects.toThrow("MEMORY_QUERY_CANCELLED");
  expect(fork).not.toHaveBeenCalled();
  const aborts=Array.from({length:64},()=>new AbortController());
  const pending=aborts.map(abort=>controller.search(input,abort.signal).catch(error=>error.message));
  await expect(controller.search(input,new AbortController().signal)).rejects.toThrow("MEMORY_WORKER_NOT_READY");
  expect(fork).toHaveBeenCalledTimes(1);
  for(const abort of aborts)abort.abort();
  expect(await Promise.all(pending)).toEqual(Array(64).fill("MEMORY_QUERY_DEADLINE"));
  helper.emit("message",{type:"initialised"});
  expect(helper.send.mock.calls.some(([message])=>message.type==="query")).toBe(false);
});

it("lease recovery sweep kept",async()=>{
  enqueue();
  database().prepare("UPDATE memory_jobs SET status='leased',lease_owner='previous',lease_until=?").run(Date.now()+30_000);
  controller.start();
  await vi.advanceTimersByTimeAsync(29_000);expect(fork).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  expect(database().prepare("SELECT status,lease_owner,lease_generation FROM memory_jobs").get()).toMatchObject({status:"leased",lease_generation:1});
  expect(database().prepare("SELECT lease_owner FROM memory_jobs").get()?.lease_owner).not.toBe("previous");
  expect(fork).toHaveBeenCalledTimes(1);
});

it("future retries become due without another write",async()=>{
  enqueue();database().prepare("UPDATE memory_jobs SET status='deferred',retry_at=?").run(Date.now()+5000);
  controller.start();await vi.advanceTimersByTimeAsync(4000);expect(fork).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  expect(database().prepare("SELECT status FROM memory_jobs").get()?.status).toBe("leased");
});

it("idle consolidation drains once at a time and backs off when empty",async()=>{
  let release!:(worked:boolean)=>void;
  const idle=vi.fn(()=>new Promise<boolean>(resolve=>{release=resolve;}));
  controller=new MemoryWorkerController({onIdleConsolidation:idle});controller.start();controller.wake();
  await vi.advanceTimersByTimeAsync(1);expect(idle).toHaveBeenCalledTimes(1);
  controller.wake();await vi.advanceTimersByTimeAsync(1);expect(idle).toHaveBeenCalledTimes(1);
  release(true);await vi.advanceTimersByTimeAsync(1000);expect(idle).toHaveBeenCalledTimes(2);
  release(false);await vi.advanceTimersByTimeAsync(1000);expect(idle).toHaveBeenCalledTimes(2);
  expect(fork).not.toHaveBeenCalled();
});

it("an arrival inside the one-second consolidation deadline is looked at when it passes, not at the idle sweep",async()=>{
  const idle=vi.fn(async()=>false);
  controller=new MemoryWorkerController({onIdleConsolidation:idle});controller.start();controller.wake();
  await vi.advanceTimersByTimeAsync(1);expect(idle).toHaveBeenCalledTimes(1);
  // A review becomes runnable 100 ms after an empty pass: the wake lands inside the deadline.
  await vi.advanceTimersByTimeAsync(99);controller.wake();
  await vi.advanceTimersByTimeAsync(950);expect(idle).toHaveBeenCalledTimes(2);
  // Owed once: no further pass without another arrival before the sweep.
  await vi.advanceTimersByTimeAsync(5000);expect(idle).toHaveBeenCalledTimes(2);
});

it("defers periodic memory work while explicit arrivals keep their priority",async()=>{
  const idle=vi.fn(async()=>false);
  const defer=vi.spyOn(ioBudget,"shouldDefer").mockReturnValue(true);
  controller=new MemoryWorkerController({onIdleConsolidation:idle});controller.start();
  await vi.advanceTimersByTimeAsync(31_000);expect(idle).not.toHaveBeenCalled();
  enqueue();await vi.advanceTimersByTimeAsync(1000);
  expect(database().prepare("SELECT status FROM memory_jobs").get()?.status).toBe("leased");
  expect(defer).toHaveBeenCalled();
});

it("a helper that fails or hangs during initialisation is replaced, so queued work still runs",async()=>{
  const helpers:Helper[]=[];
  const modes=["error","hang","ok"];
  vi.mocked(fork).mockImplementation(()=>{
    const mode=modes[helpers.length]??"ok",next=new Helper();
    next.send=vi.fn((message:{type?:string})=>{
      if(message.type==="init"&&mode==="error")setTimeout(()=>next.emit("message",{type:"error",reason:"INVALID_MEMORY_WORK"}),0);
      if(message.type==="init"&&mode==="ok")setTimeout(()=>next.emit("message",{type:"initialised"}),0);
      return true;
    });
    helpers.push(next);helper=next;
    setTimeout(()=>next.emit("message",{type:"ready"}),0);
    return next as unknown as ReturnType<typeof fork>;
  });
  enqueue();
  controller.start();
  await vi.advanceTimersByTimeAsync(10);
  expect(helpers).toHaveLength(1);
  expect(helpers[0].kill).toHaveBeenCalled();
  expect(controller.error).toBe("MEMORY_WORKER_START_FAILED");
  // The first respawn waits out a 30 s backoff, seen by the next sweep.
  await vi.advanceTimersByTimeAsync(2*MEMORY_IDLE_SWEEP_MS+10);
  expect(helpers).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(3*60_000);
  expect(helpers[1].kill).toHaveBeenCalled();
  expect(controller.error).toBe("MEMORY_WORKER_INIT_TIMEOUT");
  await vi.advanceTimersByTimeAsync(5*60_000);
  // This helper never answers work, so later lease timeouts replace it again.
  expect(helpers.length).toBeGreaterThanOrEqual(3);
  expect(jobs.claimMemoryJob).toHaveBeenCalled();
  expect(helpers[2].send).toHaveBeenCalledWith(expect.objectContaining({id:expect.any(String)}));
});
