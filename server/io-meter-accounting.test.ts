// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from "vitest";
import {IoBudget} from "./io-budget.ts";
const M=1024*1024;
it("adds disjoint child writes after taking the process's OS/native/application maximum",()=>{
 let reading={at:0,fsWriteBlocks:0,cpuMicros:0,meterBytes:0},dbBytes=0,child=0;
 const budget=new IoBudget({read:()=>reading,systemOverloaded:()=>null,log:()=>{}});
 budget.registerByteSource("database:fixture",()=>dbBytes);
 Reflect.apply(budget.registerByteSource,budget,["memory-worker",()=>child,{child:true}]);
 budget.tick();dbBytes=150*M;child=100*M;
 reading={at:60000,fsWriteBlocks:200*M/512,cpuMicros:0,meterBytes:150*M};
 expect(budget.tick()?.writeBytesPerMinute).toBe(300*M);
});
it("the native total covers plain files without adding the overlapping database bucket twice",()=>{
 let reading={at:0,fsWriteBlocks:0,cpuMicros:0,meterBytes:0},dbBytes=0,child=0;
 const budget=new IoBudget({read:()=>reading,systemOverloaded:()=>null,log:()=>{}});
 budget.registerByteSource("database:fixture",()=>dbBytes);
 Reflect.apply(budget.registerByteSource,budget,["memory-worker",()=>child,{child:true}]);
 budget.tick();dbBytes=20*M;child=10*M;
 reading={at:60000,fsWriteBlocks:80*M/512,cpuMicros:0,meterBytes:100*M};
 expect(budget.tick()?.writeBytesPerMinute).toBe(110*M);
});
it("compares deltas even when the OS cumulative counter predates native bootstrap",()=>{
 let reading={at:0,fsWriteBlocks:1024*M/512,cpuMicros:0,meterBytes:0};
 const budget=new IoBudget({read:()=>reading,systemOverloaded:()=>null,log:()=>{}});budget.tick();
 reading={...reading,at:60000,meterBytes:4*M};
 expect(budget.tick()?.writeBytesPerMinute).toBe(4*M);
});
