// SPDX-License-Identifier: AGPL-3.0-or-later
import {afterEach,expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({bytes:0,seals:0}));
vi.mock("./embeddings.ts",()=>({MemoryEmbeddings:class{identity="fixture";embed(texts:string[]){return Promise.resolve(texts.map(()=>[1]));}}}));
vi.mock("./index.ts",()=>({MemoryIndex:class{
  static async create(){return new this();}
  resetDone(){return null;}stopInfo(){return null;}rebuilt=false;prepareModel(){}
  purgeRolledCheckpoints(){return {removed:0,examined:0,merged:false,done:true};}maintenanceOwed(){return false;}
  async prepareExit(){state.seals++;state.bytes+=8192;}
}}));
vi.mock("./eligibility.ts",()=>({MemoryEligibility:class{pipRecordIds(){return [];}warm(){}close(){}}}));
vi.mock("../io-meter.ts",async real=>({...await real<typeof import("../io-meter.ts")>(),ioMeterActive:()=>true,ioMeterTotal:()=>state.bytes,ioMeterSnapshot:()=>({known:true,total:state.bytes,buckets:[]})}));
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();vi.restoreAllMocks();});
async function fixture(ack=true){
  vi.resetModules();state.bytes=0;state.seals=0;
  const real=process,listeners=new Map<string,(value?:unknown)=>unknown>(),sent:Array<Record<string,unknown>>=[],exits:number[]=[];
  const child=Object.create(real) as NodeJS.Process;
  Object.defineProperties(child,{
    env:{value:{...real.env,MURAGE_IO_GENERATION:"fixture-generation"}},connected:{value:true},
    on:{value:(event:string,listener:(value?:unknown)=>unknown)=>{listeners.set(event,listener);return child;}},
    send:{value:(message:Record<string,unknown>,cb?:(e:Error|null)=>void)=>{
      sent.push(message);cb?.(null);
      if(ack&&message.final)setImmediate(()=>listeners.get("message")?.({type:"io-final-ack",generation:message.generation,sequence:message.sequence}));
      return true;
    }},
    exit:{value:(code:number)=>{exits.push(code);}},resourceUsage:{value:()=>real.resourceUsage()},
  });
  vi.stubGlobal("process",child);await import("./worker.ts");
  await listeners.get("message")!({type:"init",indexPath:"/unused/index",authorityPath:"/unused/authority",modelDirectory:"/unused/model",manifest:{model:"fixture",revision:"1",dimensions:1,files:[]}});
  return {listeners,sent,exits};
}
it("a graceful helper seals before its final cumulative receipt and waits for the matching acknowledgement",async()=>{
  const f=await fixture(false);
  const exiting=f.listeners.get("message")!({type:"io-stop"});
  await vi.waitFor(()=>expect(f.sent.some(m=>m.final===true)).toBe(true));
  const final=f.sent.find(m=>m.final===true)!;
  expect(state.seals).toBe(1);expect(final.ioBytes).toBe(8192);expect(final.known).toBe(true);expect(f.exits).toEqual([]);
  await f.listeners.get("message")!({type:"io-final-ack",generation:"stale",sequence:final.sequence});
  expect(f.exits).toEqual([]);
  await f.listeners.get("message")!({type:"io-final-ack",generation:final.generation,sequence:final.sequence});
  await exiting;expect(f.exits).toEqual([0]);
});
it("a lost final acknowledgement has a bounded wait and preserves the final receipt",async()=>{
  const f=await fixture(false),start=performance.now();await f.listeners.get("message")!({type:"io-stop"});
  expect(f.sent.find(m=>m.final===true)?.ioBytes).toBe(8192);expect(f.exits).toEqual([0]);expect(performance.now()-start).toBeLessThan(1500);
});
