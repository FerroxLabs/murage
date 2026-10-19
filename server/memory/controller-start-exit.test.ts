// SPDX-License-Identifier: AGPL-3.0-or-later
// A memory helper that exits before it says it is ready (it could not even load: RED2C on a host whose account has no
// home directory) is a failed start: the status says so, the next start waits out the backoff, and the queued capture
// is claimed once a helper does start. Before 1.0.3 such an exit left the jobs pending with no attempts and no error.
import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { captureSource } from "./capture.ts";
import { setMemoryMode } from "./repository.ts";
import { MEMORY_IDLE_SWEEP_MS, MemoryWorkerController } from "./worker-controller.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

vi.mock("node:child_process",async importOriginal=>({...await importOriginal<typeof import("node:child_process")>(),fork:vi.fn()}));
class Helper extends EventEmitter {
  constructor(private readonly starts:boolean){super();}
  send=vi.fn((message:{type?:string})=>{
    if(message.type==="init")setTimeout(()=>this.emit("message",{type:"initialised"}),0);
    return true;
  });
  kill=vi.fn(()=>{this.emit("exit",null,"SIGKILL");return true;});
  disconnect(){this.emit("exit",0);}
  boot(){setTimeout(()=>this.starts?this.emit("message",{type:"ready"}):this.emit("exit",1,null),0);}
}
let helpers:Helper[];
let starts:number[];
let controller:MemoryWorkerController;
beforeEach(()=>{
  closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});
  vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-19T00:00:00Z"));
  setMemoryMode("capture");
  helpers=[];starts=[];
  controller=new MemoryWorkerController();
});
afterEach(async()=>{await controller.stop();closeDatabase();vi.useRealTimers();vi.restoreAllMocks();vi.clearAllMocks();});
function helpersThatCrash(crashes:number){
  vi.mocked(fork).mockImplementation(()=>{
    const next=new Helper(helpers.length>=crashes);helpers.push(next);starts.push(Date.now());next.boot();
    return next as unknown as ReturnType<typeof fork>;
  });
}
const jobStatus=()=>database().prepare("SELECT status,attempts FROM memory_jobs").get() as {status:string;attempts:number};

it("a helper that exits before it is ready is a failed start: the error shows, the restart backs off, and the capture is claimed once one starts",async()=>{
  helpersThatCrash(2);
  captureSource(database(),{id:"source",threadId:"thread",kind:"text",speaker:"owner",outcome:"recorded",text:"The smoke round is two."});
  controller.start();
  await vi.advanceTimersByTimeAsync(10);
  expect(helpers).toHaveLength(1);
  expect(controller.error).toBe("MEMORY_WORKER_START_FAILED");
  expect(jobStatus()).toEqual({status:"pending",attempts:0});
  // Each failed start doubles the wait before the next one (30 s, then 60 s); the third helper starts and stays.
  for(let second=0;second<5*60&&helpers.length<3;second++)await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(10);
  expect(helpers).toHaveLength(3);
  expect(starts[1]!-starts[0]!).toBeGreaterThanOrEqual(MEMORY_IDLE_SWEEP_MS);
  expect(starts[2]!-starts[1]!).toBeGreaterThanOrEqual(2*MEMORY_IDLE_SWEEP_MS);
  expect(controller.error).toBeNull();
  expect(helpers[2]!.send).toHaveBeenCalledWith(expect.objectContaining({id:expect.any(String)}));
  expect(jobStatus().status).toBe("leased");
});

it("the helper gets the server's data directory and home, so loading the config never asks the account database for a home",async()=>{
  helpersThatCrash(0);
  captureSource(database(),{id:"source",threadId:"thread",kind:"text",speaker:"owner",outcome:"recorded",text:"The smoke round is two."});
  controller.start();
  await vi.advanceTimersByTimeAsync(10);
  expect(fork).toHaveBeenCalledTimes(1);
  const options=vi.mocked(fork).mock.calls[0]![2] as {env:Record<string,string|undefined>};
  expect(options.env.MURAGE_DATA_DIR).toBe(DATA_DIR);
  expect(process.env.HOME).toBeTruthy();
  expect(options.env.HOME).toBe(process.env.HOME);
});
