import { mkdtempSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { fixtureHelperPermits } from "./testing/helper-permits.ts";
import { workerQueryAuthority } from "./testing/worker-query-fixture.ts";

const counts = vi.hoisted(() => ({ writes:0, checkpoints:0, closes:0, ticks:0 }));
vi.mock("./embeddings.ts", () => ({ MemoryEmbeddings: class { identity="fixture"; backend="native"; embed(texts:string[]) { return Promise.resolve(texts.map(()=>[1])); } } }));
vi.mock("./eligibility.ts", () => ({ MemoryEligibility: class { pipRecordIds(){ return []; } warm(){} close(){} } }));
vi.mock("./worker-query.ts", () => ({ answerQuery: () => ({result:{hits:[]},timings:{}}) }));
vi.mock("./index.ts", async () => ({ MemoryIndex: class extends (await import("../testing/worker-index-mock.ts")).MockWorkerIndex {
  maintenanceOwed(){return false;}
  purgeRolledCheckpoints(){return {removed:0,examined:0,merged:false,done:true};}
  override resetDone(){ return 17; }
  override upsert(){ counts.writes++; }
  override tick(){ counts.ticks++; }
  override close(){ counts.closes++; }
  override async sealAndTruncate(){ counts.checkpoints++; return {truncated:true}; }
  async finishRewrite(){ counts.checkpoints++; return true; }
  override async prepareExit(){ counts.checkpoints++; }
} }));

async function fixture(run:(emit:(m:unknown)=>Promise<void>, sent:any[], file:string)=>Promise<void>, marker=true) {
  vi.resetModules(); vi.useFakeTimers(); Object.assign(counts,{writes:0,checkpoints:0,closes:0,ticks:0});
  const root=mkdtempSync(join(tmpdir(),"memw-hold-")), file=join(root,"memory-index.db"), sent:any[]=[];
  if(marker)writeFileSync(`${file}-walstop`, "stop");
  const listeners=new Map<string,(m?:unknown)=>Promise<void>>(), real=process, fake=Object.create(real);
  const permits=fixtureHelperPermits();
  Object.defineProperties(fake,{
    on:{value:(name:string,fn:(m?:unknown)=>Promise<void>)=>{listeners.set(name,fn);return fake;}},
    send:{value:(m:any,cb?:(err:null)=>void)=>{sent.push(m);permits.reply(m,event=>{void listeners.get("message")?.(event);});cb?.(null);return true;}},
    exit:{value:vi.fn()}, resourceUsage:{value:()=>real.resourceUsage()},
  });
  vi.stubGlobal("process",fake);
  const errors=vi.spyOn(console,"error").mockImplementation(()=>{});
  try {
    await import("./worker.ts"); const emit=(m:unknown)=>listeners.get("message")!(m);
    await emit({type:"init",indexPath:file,authorityPath:join(root,"authority.db"),modelDirectory:root,manifest:{model:"fixture",revision:"1",dimensions:1,files:[]},reset:{resetId:17,resets:1,kind:"open"}});
    await run(emit,sent,file);
  } finally {vi.clearAllTimers();errors.mockRestore();vi.unstubAllGlobals();vi.useRealTimers();vi.resetModules();removeTempDirSync(root);}
}

it("K-HOLD: held reset answers more than one query batch but performs no writes or checkpoints",async()=>fixture(async(emit,sent,file)=>{
  await emit({type:"checkpoint",requestId:"cp"});
  await emit({type:"checkpoint",requestId:"rewrite",finishRewrite:true});
  expect(counts.checkpoints,"held reset checkpoint ran").toBe(0);
  for(let i=0;i<33;i++)void emit({type:"query",requestId:`q${i}`,input:{...workerQueryAuthority,query:"memory",scopeIds:[],policyRevision:0,deletionEpoch:0,historical:false,cursor:"",limit:10,semantic:false}});
  void emit({type:"index",requestId:"batch",records:[{id:"r",version:1,scopeId:"s",text:"memory",deleted:false}]});
  await vi.advanceTimersByTimeAsync(250);
  expect(sent.filter(m=>m.type==="query-result")).toHaveLength(33);
  expect(counts.writes,"held reset write ran").toBe(0);
  expect(counts.ticks,"held reset tick ran").toBe(0);
  expect(sent.filter(m=>m.type==="checkpoint-result").map(m=>m.ok)).toEqual([false,false]);
  unlinkSync(`${file}-walstop`);
  await vi.advanceTimersByTimeAsync(100);
  expect(counts.writes).toBe(1);
  expect(sent.filter(m=>m.type==="index-result")).toHaveLength(1);
}));

it("K-ENSURE: reset creates the durable hold marker before announcing initialised",async()=>fixture(async(_emit,sent,file)=>{
  expect(sent.some(m=>m.type==="initialised")).toBe(true);
  expect(existsSync(`${file}-walstop`),"reset initialised without its hold marker").toBe(true);
},false));
