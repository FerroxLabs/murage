import { existsSync,mkdirSync,rmSync,writeFileSync,readFileSync } from "node:fs";
import { join,resolve } from "node:path";
import { beforeEach,expect,it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { database,closeDatabase } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { MemoryIndex } from "./index.ts";
import { MemoryEmbeddings } from "./embeddings.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import { setMemoryMode } from "./repository.ts";
import { reconcileMemoryRoster,memoryAccess } from "./policy.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { searchMemory } from "./search.ts";
import { MemoryQueryCache } from "./cache.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { forgetMemory } from "./forget.ts";

beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});});
/** The pinned real model (shared/memory-model-manifest.json) is a prepared
 * fixture, not a checked-in file: CI runs the prepare step before the suite
 * (.github/workflows/ci.yml). A missing model is a missing prerequisite and
 * must fail by name, not as an ENOENT or a 10 s "unavailable" timeout. */
function pinnedModelDirectory(){
  const directory=resolve(".planning/memory-evidence/model");
  if(!existsSync(join(directory,"onnx/model_quantized.onnx")))throw new Error(`MEMORY_MODEL_FIXTURE_MISSING: prepare it first with "node --experimental-strip-types scripts/qualify-memory-runtime.ts --prepare-model --allow-download --destination ${directory}"`);
  return directory;
}
it("retrieves lexical candidates with exact allowed IDs and versions without embeddings",()=>{
  const index=new MemoryIndex(join(DATA_DIR,"index.db"));
  try{
    index.upsert([
      {id:"gold",version:1,scopeId:"allowed",text:"nightly database backups",deleted:false},
      {id:"gold",version:2,scopeId:"allowed",text:"nightly database backups updated",deleted:false},
      {id:"secret",version:1,scopeId:"denied",text:"nightly database backups",deleted:false},
    ]);
    const result=index.search("database backups",[{id:"gold",version:2}],null,"unused");
    expect(result.hits.map(({id,version})=>({id,version}))).toEqual([{id:"gold",version:2}]);
    expect(result.vectorRows).toBe(0);
    expect(index.search("database backups",[],null,"unused").hits).toEqual([]);
    expect(index.search("database backups",[{id:"gold",version:3}],null,"unused").hits).toEqual([]);
  }finally{index.close();}
});
it("retrieves semantic candidates independently and excludes unauthorized IDs before ranking",()=>{
  const index=new MemoryIndex(join(DATA_DIR,"index.db"));
  try{
    const records=[{id:"gold",version:1,scopeId:"allowed",text:"nightly database copies",deleted:false},{id:"secret",version:1,scopeId:"denied",text:"PRIVATE_CANARY",deleted:false}];
    index.prepareModel("model");
    index.upsert(records);index.vector(records[0],"model",0,[1,0]);index.vector(records[1],"model",0,[1,0]);
    const result=index.search("restoration schedule",[{id:"gold",version:1}],[1,0],"model");
    expect(result.hits.map(h=>h.id)).toEqual(["gold"]);expect(result.vectorRows).toBe(1);
    expect(index.search("PRIVATE_CANARY",[{id:"gold",version:1}],null,"model").hits).toEqual([]);
    index.upsert([{...records[0],deleted:true}]);
    expect(index.search("restoration schedule",[{id:"gold",version:1}],[1,0],"model").hits).toEqual([]);
  }finally{index.close();}
});
it("rebuilds a corrupt derived index without treating it as authoritative",()=>{
  const path=join(DATA_DIR,"index.db");writeFileSync(path,"corrupt fixture");
  const index=new MemoryIndex(path);try{expect(index.rebuilt).toBe(true);}finally{index.close();}
});
it("bounds query cache storage and evicts old entries",()=>{
  const cache=new MemoryQueryCache<string>();for(let i=0;i<129;i++)cache.set(String(i),"value");
  expect(cache.get("0")).toBeUndefined();expect(cache.get("128")).toBe("value");
  cache.clear();expect(cache.get("128")).toBeUndefined();
});
it("refuses altered model metadata without falling back to a download",async()=>{
  const manifest=JSON.parse(readFileSync(resolve("shared/memory-model-manifest.json"),"utf8"));manifest.files[0].sha256="0".repeat(64);
  const embedding=new MemoryEmbeddings(pinnedModelDirectory(),manifest);
  await expect(embedding.embed(["query"])).rejects.toThrow("MEMORY_MODEL_UNVERIFIED");
});
it("uses the real local model through the worker and invalidates results after forgetting",async()=>{
  const roster={bots:[{id:"bot",threadId:"thread"}],groups:[]};reconcileMemoryRoster(roster);setMemoryMode("capture");
  appendMessage("thread",{id:"source",at:1,role:"user",kind:"text",text:"Database backups are made every night."});
  const controller=new MemoryWorkerController({modelDirectory:pinnedModelDirectory()});controller.start();
  try{
    const deadline=Date.now()+10000;
    while(Date.now()<deadline&&!database().prepare("SELECT 1 FROM memory_projection_receipts WHERE embedding_status='indexed'").get())await new Promise(r=>setTimeout(r,50));
    expect(database().prepare("SELECT embedding_status FROM memory_projection_receipts").get()?.embedding_status).toBe("indexed");
    const registry=new InternalCapabilities();registry.begin("bot","thread","turn");
    const token=registry.mint({botId:"bot",threadId:"thread",generation:"turn",depth:0,kind:"memory",skillAuthoring:false});
    const context=memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
    const result=await searchMemory("How frequently do we save recovery copies?",context,controller);
    expect(result.vectorRows).toBeGreaterThan(0);expect(result.hits[0]?.text).toContain("every night");
    expect(result.degradedReason).toBeUndefined();
    forgetMemory(ownerMemoryTicket(),{kind:"record",id:result.hits[0].id});
    await expect(searchMemory("recovery copies",context,controller)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
  }finally{await controller.stop();}
});

it("keeps allowed lexical results when denied matches exceed the candidate limit",()=>{
  const index=new MemoryIndex(join(DATA_DIR,"rank-filter.db"));
  try{
    const denied=Array.from({length:100},(_,i)=>({id:`denied-${i}`,version:1,scopeId:"denied",text:"backup",deleted:false}));
    index.upsert([...denied,{id:"allowed",version:2,scopeId:"allowed",text:"backup with additional surrounding context",deleted:false}]);
    expect(index.search("backup",[{id:"allowed",version:2}],null,"unused",1).hits.map(h=>h.id)).toEqual(["allowed"]);
    expect(index.search("backup",[{id:"allowed",version:1}],null,"unused",1).hits).toEqual([]);
    expect(index.search("backup",[],null,"unused",1).hits).toEqual([]);
  }finally{index.close();}
});
