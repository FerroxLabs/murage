// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// INTEL-SMOKE-WORKER-EXIT: a helper busy past the stop grace (a long model call on a slow Mac) is ended and the stop finishes, so a
// change of memory mode brings the helper back and a Cloud home's drain goes on to stop its bots. A rejected stop skipped all of that.
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
class HeldHelper extends EventEmitter {
  constructor(private readonly dies:boolean){super();setTimeout(()=>this.emit("message",{type:"ready"}),0);}
  send=vi.fn((message:{type?:string})=>{
    if(message.type==="init")setTimeout(()=>this.emit("message",{type:"initialised"}),0);
    return true;
  });
  kill=vi.fn(()=>{if(this.dies)setTimeout(()=>this.emit("exit",null,"SIGKILL"),10);return true;});
  disconnect=vi.fn();
}
let helpers:HeldHelper[];
let controller:MemoryWorkerController;
const startHeld=async(dies:boolean)=>{
  vi.mocked(fork).mockImplementation(()=>{const next=new HeldHelper(dies);helpers.push(next);return next as unknown as ReturnType<typeof fork>;});
  captureSource(database(),{id:"source",threadId:"thread",kind:"text",speaker:"owner",outcome:"recorded",text:"The smoke round is two."});
  controller.start();
  await vi.advanceTimersByTimeAsync(10);
  expect(helpers).toHaveLength(1);
};
const stopped=async()=>{
  let settled="pending";
  const stop=controller.stop().then(()=>{settled="resolved";},()=>{settled="rejected";});
  await vi.advanceTimersByTimeAsync(4_999);
  expect(settled).toBe("pending");
  expect(helpers[0]!.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_000);
  await stop;
  return settled;
};
beforeEach(()=>{
  closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});
  vi.useFakeTimers();vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
  setMemoryMode("capture");
  helpers=[];
  controller=new MemoryWorkerController();
});
afterEach(async()=>{const stop=controller.stop().catch(()=>{});await vi.advanceTimersByTimeAsync(6_000);await stop;closeDatabase();vi.useRealTimers();vi.restoreAllMocks();vi.clearAllMocks();});

it("a helper held past the grace is ended, the stop finishes, and the next start brings a new helper",async()=>{
  await startHeld(true);
  expect(await stopped()).toBe("resolved");
  expect(helpers[0]!.kill).toHaveBeenCalledWith("SIGKILL");
  controller.start();
  await vi.advanceTimersByTimeAsync(MEMORY_IDLE_SWEEP_MS+10);
  expect(helpers).toHaveLength(2);
});

it("a stop finishes even when the kill is not seen to land, and the next start gets a new helper",async()=>{
  await startHeld(false);
  expect(await stopped()).toBe("resolved");
  controller.start();
  await vi.advanceTimersByTimeAsync(MEMORY_IDLE_SWEEP_MS+10);
  expect(helpers).toHaveLength(2);
  // The first helper's exit arriving now changes nothing about the second.
  helpers[0]!.emit("exit",null,"SIGKILL");
  await vi.advanceTimersByTimeAsync(10);
  helpers[1]!.emit("message",{type:"initialised"});
  expect(helpers).toHaveLength(2);
  expect(controller.error).toBeNull();
});
