import { expect, it, vi } from "vitest";

// Delay actual worker drain awaits, not a parallel reimplementation of its
// selection rule. Storage/model doubles keep this scheduling regression offline.
const state=vi.hoisted(()=>({started:[] as string[][],release:[] as Array<()=>void>,indexed:[] as string[]}));
vi.mock("./embeddings.ts",()=>({MemoryEmbeddings:class {
  identity="scheduling-fixture";
  embed(texts:string[]){
    state.started.push([...texts]);
    return new Promise<number[][]>(resolve=>state.release.push(()=>resolve(texts.map(()=>[1]))));
  }
}}));
vi.mock("./index.ts",()=>({MemoryIndex:class {
  rebuilt=false;
  prepareModel(){}
  upsert(records:Array<{text:string}>){state.indexed.push(...records.map(record=>record.text));}
  vector(){}
  search(){return {hits:[],vectorRows:0};}
  close(){}
}}));
vi.mock("./eligibility.ts",()=>({MemoryEligibility:class {
  read(){return {allowed:[],capacity:false};}
  warm(){}
  close(){}
}}));

it("makes index progress under continued queries, then returns query priority and respects cancellation",async()=>{
  vi.resetModules();state.started.length=0;state.release.length=0;state.indexed.length=0;
  const realProcess=process;
  const listeners=new Map<string,(message:unknown)=>void>();
  const sent:Array<{type:string;requestId?:string}>=[];
  const workerProcess=Object.create(realProcess) as NodeJS.Process;
  Object.defineProperties(workerProcess,{
    on:{value:(event:string,listener:(message:unknown)=>void)=>{
      if(event==="message"||event==="disconnect"){listeners.set(event,listener);return workerProcess;}
      return realProcess.on(event,listener);
    }},
    send:{value:(message:{type:string;requestId?:string})=>{sent.push(message);return true;}},
    resourceUsage:{value:()=>realProcess.resourceUsage()},
  });
  vi.stubGlobal("process",workerProcess);
  try{
    await import("./worker.ts");
    const emit=listeners.get("message")!;expect(emit).toBeTypeOf("function");
    emit({type:"init",indexPath:"/unused/index",authorityPath:"/unused/authority",modelDirectory:"/unused/model",manifest:{model:"fixture",revision:"1",dimensions:1,files:[]}});
    const query=(id:string)=>emit({type:"query",requestId:id,input:{query:id,scopeIds:["scope"],policyRevision:0,deletionEpoch:0,historical:false,cursor:"",limit:10,semantic:true}});
    const index=(id:string)=>emit({type:"index",requestId:id,records:[{id,version:1,scopeId:"scope",text:id,deleted:false}]});
    query("query-one");query("query-two");index("index-one");index("index-two");
    expect(state.started).toEqual([["query-one"]]);
    state.release.shift()!();
    await vi.waitFor(()=>expect(state.started).toEqual([["query-one"],["index-one"]]));
    // Arrival during indexing must regain priority before the second index
    // batch. A cancelled request must never enter model work or emit a result.
    query("query-cancelled");emit({type:"cancel",requestId:"query-cancelled"});
    state.release.shift()!();
    await vi.waitFor(()=>expect(state.started[2]).toEqual(["query-two"]));
    query("query-three");
    state.release.shift()!();
    await vi.waitFor(()=>expect(state.started[3]).toEqual(["index-two"]));
    state.release.shift()!();
    await vi.waitFor(()=>expect(state.started[4]).toEqual(["query-three"]));
    state.release.shift()!();
    await vi.waitFor(()=>expect(sent.filter(message=>message.requestId).map(message=>message.requestId)).toEqual([
      "query-one","index-one","query-two","index-two","query-three",
    ]));
    expect(state.indexed).toEqual(["index-one","index-two"]);
    expect(sent.some(message=>message.type==="error"||message.type==="index-error")).toBe(false);
  }finally{
    // Resolve any finite fixture work left by a failed assertion before restoring
    // process, so no continuation can write to the runner's real IPC channel.
    for(let i=0;i<12;i++){while(state.release.length)state.release.shift()!();await Promise.resolve();}
    vi.unstubAllGlobals();vi.resetModules();
  }
});
