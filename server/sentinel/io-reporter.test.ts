// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it,vi,afterEach} from "vitest";
import {ChildIoReporter,setChildIoFinisher,exitWithChildIoReceipt,type IoMessage} from "./io-child-receipts.ts";
afterEach(()=>{vi.useRealTimers();setChildIoFinisher(undefined);});
it("T11 seals before its final receipt, and only the matching generation and sequence release the ack wait",async()=>{
 const sent:IoMessage[]=[];let bytes=1,sealed=false,done=false;
 const reporter=new ChildIoReporter("fixture-generation",()=>({blocks:0,bytes,known:true}),m=>sent.push(m));
 reporter.report();const finish=reporter.finish(()=>{sealed=true;bytes=4096;}).then(()=>{done=true;});
 await Promise.resolve();expect(sealed).toBe(true);expect(sent.at(-1)?.ioBytes).toBe(4096);expect(sent.at(-1)?.final).toBe(true);expect(done).toBe(false);
 const final=sent.at(-1)!;
 reporter.accept({type:"io-final-ack",generation:"stale",sequence:final.sequence});await Promise.resolve();expect(done).toBe(false);
 reporter.accept({type:"io-final-ack",generation:final.generation,sequence:final.sequence-1});await Promise.resolve();expect(done).toBe(false);
 reporter.accept({type:"io-final-ack",generation:final.generation,sequence:final.sequence});await finish;expect(done).toBe(true);
 reporter.report();expect(sent).toHaveLength(2);
});
it("T11 missing acknowledgement waits exactly 500 ms; repeated stop shares the sealed final",async()=>{
 vi.useFakeTimers();const send=vi.fn(),seal=vi.fn(),reporter=new ChildIoReporter("fixture-generation",()=>({blocks:0,bytes:0,known:true}),send);
 let done=false;const finish=reporter.finish(seal).then(()=>{done=true;});
 expect(reporter.finish(seal)).not.toBeUndefined();await Promise.resolve();
 await vi.advanceTimersByTimeAsync(499);expect(done).toBe(false);
 await vi.advanceTimersByTimeAsync(1);await finish;expect(done).toBe(true);expect(seal).toHaveBeenCalledTimes(1);expect(send).toHaveBeenCalledTimes(1);
});
it("T11 a failed seal sends no final receipt",async()=>{
 const send=vi.fn(),reporter=new ChildIoReporter("fixture-generation",()=>({blocks:0,bytes:1,known:true}),send);
 await expect(reporter.finish(()=>{throw Error("seal failed");})).rejects.toThrow("seal failed");expect(send).not.toHaveBeenCalled();
});

it("T11 changed counters during the acknowledgement wait invalidate the seal",async()=>{
 let bytes=1;const sent:IoMessage[]=[];
 const reporter=new ChildIoReporter("fixture-generation",()=>({blocks:0,bytes,known:true}),m=>sent.push(m));
 const finish=reporter.finish();await Promise.resolve();const final=sent.at(-1)!;
 bytes=2;reporter.accept({type:"io-final-ack",generation:final.generation,sequence:final.sequence});
 await expect(finish,"late bytes must not leave a successful final receipt").rejects.toThrow("CHILD_IO_NOT_SEALED");
});
it("T11 a failed child seal exits unsuccessfully so its parent invalidates coverage",async()=>{
 setChildIoFinisher(()=>Promise.reject(Error("CHILD_IO_NOT_SEALED")));const exit=vi.fn();
 await exitWithChildIoReceipt(0,exit);expect(exit).toHaveBeenCalledExactlyOnceWith(1);
});
