import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
// Intel macOS runs the model on ONNX Runtime WebAssembly; keyword-only memory remains only where that runtime is missing too.
const runtime=vi.hoisted(()=>({wasm:true}));
vi.mock("./embedding-runtime.ts",async importOriginal=>{const actual=await importOriginal<typeof import("./embedding-runtime.ts")>();return {...actual,wasmRuntimeAvailable:()=>runtime.wasm&&actual.wasmRuntimeAvailable()};});
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { MemoryEmbeddings, supportsNativeMemoryModel } from "./embeddings.ts";
import { MemoryIndex } from "./index.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { memoryOwnerRoute, memoryOwnerStatus } from "./settings.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
const roster={bots:[{id:"intel-owner",threadId:"intel-thread"}],groups:[]};
beforeEach(()=>{runtime.wasm=true;closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});reconcileMemoryRoster(roster);});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();closeDatabase();});
function intel(){const actual=process;vi.stubGlobal("process",new Proxy(actual,{get(target,key){return key==="platform"?"darwin":key==="arch"?"x64":Reflect.get(target,key,target);}}));}
it("runs the model on every release target: native, or WebAssembly on Intel macOS",()=>{
  for(const [platform,arch] of [["darwin","arm64"],["linux","x64"],["win32","x64"],["darwin","x64"]] as const)expect(supportsNativeMemoryModel(platform,arch)).toBe(true);
  runtime.wasm=false;
  expect(supportsNativeMemoryModel("darwin","x64")).toBe(false);
  for(const [platform,arch] of [["darwin","arm64"],["linux","x64"],["win32","x64"]] as const)expect(supportsNativeMemoryModel(platform,arch)).toBe(true);
});
it("on Intel macOS reports smart search as available and lets the model be set up",()=>{
  intel();const owner=ownerMemoryTicket(),status=memoryOwnerStatus(owner,roster);
  expect(status.model.state).not.toBe("failed");expect(status.model.error).toBeUndefined();
});
it("without any runtime, refuses inference before reading model files or importing the native runtime",async()=>{
  intel();runtime.wasm=false;const model=new MemoryEmbeddings(join(DATA_DIR,"absent-model"),{model:"test",revision:"test",dimensions:2,files:[{path:"absent",bytes:1,sha256:"0".repeat(64)}]});
  await expect(model.embed(["query"])).rejects.toThrow("MEMORY_SEMANTIC_PLATFORM_UNAVAILABLE");
});
it("without any runtime, reports unsupported availability and never downloads while keyword access remains scoped",async()=>{
  intel();runtime.wasm=false;const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
  const owner=ownerMemoryTicket();expect(memoryOwnerStatus(owner,roster).model).toMatchObject({state:"failed",error:expect.stringContaining("keyword memory")});
  await expect(memoryOwnerRoute("/api/memory/action",{action:"model-download",confirm:true},owner,roster)).rejects.toMatchObject({status:409,message:expect.stringContaining("keyword memory")});expect(fetch).not.toHaveBeenCalled();expect(existsSync(join(DATA_DIR,"memory-model"))).toBe(false);
  const index=new MemoryIndex(join(DATA_DIR,"index.db"));
  try{
    index.upsert(["allowed","private"].map(id=>({id,version:1,scopeId:id,text:"backups run nightly",deleted:false})));
    const found=index.search("backups",[{id:"allowed",version:1}],null,"unused");
    expect(found.hits.map(hit=>hit.id)).toEqual(["allowed"]);expect(found.vectorRows).toBe(0);
  }finally{index.close();}
});
