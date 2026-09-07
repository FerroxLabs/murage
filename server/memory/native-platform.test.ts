import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { MemoryEmbeddings, supportsNativeMemoryModel } from "./embeddings.ts";
import { MemoryIndex } from "./index.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { memoryOwnerRoute, memoryOwnerStatus } from "./settings.ts";
const roster={bots:[{id:"intel-owner",threadId:"intel-thread"}],groups:[]};
beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});reconcileMemoryRoster(roster);});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();closeDatabase();});
function intel(){const actual=process;vi.stubGlobal("process",new Proxy(actual,{get(target,key){return key==="platform"?"darwin":key==="arch"?"x64":Reflect.get(target,key,target);}}));}
it("limits the unavailable native path to Intel macOS",()=>{
  expect(supportsNativeMemoryModel("darwin","x64")).toBe(false);
  for(const [platform,arch] of [["darwin","arm64"],["linux","x64"],["win32","x64"]] as const)expect(supportsNativeMemoryModel(platform,arch)).toBe(true);
});
it("refuses unsupported inference before reading model files or importing the native runtime",async()=>{
  intel();const model=new MemoryEmbeddings(join(DATA_DIR,"absent-model"),{model:"test",revision:"test",dimensions:2,files:[{path:"absent",bytes:1,sha256:"0".repeat(64)}]});
  await expect(model.embed(["query"])).rejects.toThrow("MEMORY_SEMANTIC_PLATFORM_UNAVAILABLE");
});
it("reports unsupported availability and never downloads while keyword access remains scoped",async()=>{
  intel();const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
  const owner=ownerMemoryTicket();expect(memoryOwnerStatus(owner,roster).model).toMatchObject({state:"failed",error:expect.stringContaining("keyword memory")});
  await expect(memoryOwnerRoute("/api/memory/action",{action:"model-download",confirm:true},owner,roster)).rejects.toMatchObject({status:409,message:expect.stringContaining("keyword memory")});expect(fetch).not.toHaveBeenCalled();expect(existsSync(join(DATA_DIR,"memory-model"))).toBe(false);
  const index=new MemoryIndex(join(DATA_DIR,"index.db"));
  try{
    index.upsert(["allowed","private"].map(id=>({id,version:1,scopeId:id,text:"backups run nightly",deleted:false})));
    const found=index.search("backups",[{id:"allowed",version:1}],null,"unused");
    expect(found.hits.map(hit=>hit.id)).toEqual(["allowed"]);expect(found.vectorRows).toBe(0);
  }finally{index.close();}
});
