// SPDX-License-Identifier: AGPL-3.0-or-later
import {EventEmitter} from "node:events";
import {fork} from "node:child_process";
import {mkdirSync} from "node:fs";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {DATA_DIR} from "../config.ts";
import {closeDatabase} from "../database.ts";
import {ioBudget} from "../io-budget.ts";
import * as meter from "../io-meter.ts";
import {removeTempDirSync} from "../testing/cleanup.ts";
import {MemoryWorkerController} from "./worker-controller.ts";
vi.mock("node:child_process",async real=>({...await real<typeof import("node:child_process")>(),fork:vi.fn()}));
class Helper extends EventEmitter {
  pid=12345;
  send=vi.fn((_message:unknown,callback?: (error:Error|null)=>void)=>{callback?.(null);return true;});
  kill(){this.emit("exit",null,"SIGKILL");return true;}
  disconnect(){this.emit("exit",0);}
}
let controller:MemoryWorkerController,child:Helper;
const generation=()=>vi.mocked(fork).mock.calls.at(-1)![2]!.env!.MURAGE_IO_GENERATION;
const receipt=(sequence:number,bytes:number,extra:Record<string,unknown>={})=>child.emit("message",{type:"io",ioProtocol:1,generation:generation(),sequence,fsWriteBlocks:0,ioBytes:bytes,known:true,final:false,...extra});
const bytes=()=>{ioBudget.sampleByteSource("memory-worker");return ioBudget.pendingBytes("memory-worker");};
beforeEach(()=>{
  closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});
  child=new Helper();vi.mocked(fork).mockReturnValue(child as unknown as ReturnType<typeof fork>);
  vi.spyOn(meter,"markIoMeterUnknown").mockImplementation(()=>{});
  controller=new MemoryWorkerController({startHoldMs:0});
});
afterEach(async()=>{child.emit("exit",0);await controller.stop();closeDatabase();vi.unstubAllEnvs();vi.restoreAllMocks();vi.clearAllMocks();});
const spawn=()=>{(controller as unknown as {spawn():void}).spawn();};
it("a packaged helper inherits the native resource location and a fresh receipt generation",()=>{
  vi.stubEnv("MURAGE_RESOURCES_PATH","/fixture/resources");vi.stubEnv("OMB_RESOURCES_PATH","/fixture/old-resources");
  spawn();const env=vi.mocked(fork).mock.calls.at(-1)![2]!.env!;
  expect(env.MURAGE_RESOURCES_PATH).toBe("/fixture/resources");expect(env.OMB_RESOURCES_PATH).toBe("/fixture/old-resources");
  expect(env.MURAGE_IO_GENERATION).toMatch(/^[0-9a-f-]{36}$/);
});
it("an unconfirmed helper exit invalidates coverage while retaining every observed byte",()=>{
  spawn();const before=bytes();receipt(1,8192);expect(bytes()-before).toBe(8192);
  child.emit("exit",0);expect(meter.markIoMeterUnknown).toHaveBeenCalled();expect(bytes()-before).toBe(8192);
});
it("a final receipt is charged and acknowledged even while stopping, before the helper exits",()=>{
  spawn();const before=bytes();
  (controller as unknown as {stopping:boolean}).stopping=true;
  receipt(1,16384,{final:true});
  expect(bytes()-before).toBe(16384);
  expect(child.send).toHaveBeenCalledWith({type:"io-final-ack",generation:generation(),sequence:1});
  child.emit("exit",0);expect(meter.markIoMeterUnknown).not.toHaveBeenCalled();
});
it("duplicate and stale generations cannot add bytes or acknowledge a final receipt",()=>{
  spawn();const before=bytes();receipt(1,8192);receipt(1,8192);receipt(2,65536,{generation:"stale",final:true});
  expect(bytes()-before).toBe(8192);expect(child.send).not.toHaveBeenCalledWith(expect.objectContaining({type:"io-final-ack"}));
});
it("a queued index acknowledgement cannot reset a newer cumulative receipt and charge it twice",()=>{
  spawn();const before=bytes();receipt(1,8192);
  const ack={type:"index-result",ioProtocol:1,generation:generation(),sequence:2,fsWriteBlocks:0,ioBytes:16384,known:true,final:false,requestId:"none",records:[]};
  child.emit("message",ack);receipt(3,32768);
  // A write-bearing acknowledgement can wait behind a writer hold while its
  // accounting has already passed the hold; dispatch it after the newer IO.
  (controller as unknown as {onWorkerMessage(child:unknown,message:unknown):void}).onWorkerMessage(child,ack);
  expect(bytes()-before).toBe(32768);
});
it("a decreasing counter in one launch invalidates coverage without inventing another launch",()=>{
  spawn();const before=bytes();receipt(1,8192);receipt(2,4096);
  expect(meter.markIoMeterUnknown).toHaveBeenCalled();expect(bytes()-before).toBe(8192);
});
it.each([NaN,Infinity,-1,0.5,Number.MAX_SAFE_INTEGER+1])("an invalid cumulative receipt (%s) invalidates coverage and adds no bytes",invalid=>{
  spawn();const before=bytes();receipt(1,invalid);
  expect(meter.markIoMeterUnknown).toHaveBeenCalled();expect(bytes()-before).toBe(0);
});
it("a missing native receipt stays unknown even when a measured byte floor exists",()=>{
  spawn();const before=bytes();receipt(1,4096,{known:false});
  expect(bytes()-before).toBe(4096);expect(meter.markIoMeterUnknown).toHaveBeenCalled();
});
