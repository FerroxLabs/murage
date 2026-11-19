// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ reason: "segment-gate", applications: 0, blockedCheck: false, embedded: [] as string[] }));
vi.mock("./embeddings.ts", () => ({ MemoryEmbeddings: class {
  identity = "fixture"; backend = "native";
  async embed(texts: string[]) { state.embedded.push(...texts); return texts.map(() => [1]); }
} }));
vi.mock("./eligibility.ts", () => ({ MemoryEligibility: class {
  pipRecordIds() { return []; } warm() {} close() {}
} }));
vi.mock("node:sqlite", () => ({ DatabaseSync: class { exec() {} prepare() { return { get: () => ({ ready: 1 }) }; } close() {} } }));
vi.mock("./index.ts", () => ({ MemoryIndex: class {
  static async create() { return new this(); }
  rebuilt = false;
  prepareModel() {} purgeRecords() {} close() {} tick() {}
  purgeRolledCheckpoints() { return { done: true }; }
  maintenanceOwed() { return false; }
  async maintenanceStep() { if(state.blockedCheck){const {BgDeferred}=await import("../bg-admission.ts");throw new BgDeferred(25);} return { ran: null, gateClear: false }; }
  writerCheckOwed() { return state.blockedCheck; }
  stopInfo() { return null; } resetDone() { return null; }
  ageFillOwed() { return false; }
  async applyBatch() { state.applications++; return { status: "failed", reason: state.reason, committed: 1 }; }
} }));
type Message = { type: string; requestId?: string; [key: string]: unknown };
for (const reason of ["segment-gate", "merge-floor", "age-blocked"]) {
  it(`${reason} returns the committed prefix to the controller and releases the helper for capture`, async () => {
    vi.resetModules(); vi.useFakeTimers(); Object.assign(state, { reason, applications: 0, blockedCheck: false, embedded: [] });
    const realProcess = process, listeners = new Map<string, (message: unknown) => Promise<void>>(), sent: Message[] = [];
    const workerProcess = Object.create(realProcess);
    Object.defineProperties(workerProcess, {
      on: { value: (event: string, fn: (message: unknown) => Promise<void>) => { listeners.set(event, fn); return workerProcess; } },
      send: { value: (message: Message, cb?: (error: Error | null) => void) => { sent.push(message); cb?.(null); return true; } },
      exit: { value: vi.fn() }, resourceUsage: { value: () => realProcess.resourceUsage() },
    });
    vi.stubGlobal("process", workerProcess);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await import("./worker.ts");
      const emit = (message: unknown) => listeners.get("message")!(message);
      await emit({ type: "init", indexPath: "/unused/index", authorityPath: "/unused/authority", modelDirectory: "/unused/model", manifest: { model: "fixture", revision: "1", dimensions: 1, files: [] } });
      await vi.advanceTimersByTimeAsync(0);
      const records = ["committed", "pending"].map(id => ({ id, version: 1, scopeId: "scope", text: id, deleted: false }));
      await emit({ type: "index", requestId: "refused", records });
      await vi.advanceTimersByTimeAsync(200);
      expect(sent.filter(message => message.type === "index-result")).toEqual([expect.objectContaining({requestId:"refused",failed:reason,committed:1,records:[{id:"committed",version:1,deleted:false}],embeddingStatus:"unavailable"})]);
      expect(state.applications).toBe(1);
      expect(state.embedded).toEqual([]);
      await emit({ id:"capture",sourceId:"source",revision:1,leaseGeneration:1,policyRevision:0,deletionEpoch:0,scopeId:"scope",stage:"capture",kind:"text",speaker:"owner",outcome:"recorded",cursor:0,totalBytes:5,text:"hello" });
      await vi.advanceTimersByTimeAsync(0);
      expect(sent.filter(message => message.type === "result")).toHaveLength(1);
    } finally {
      await listeners.get("disconnect")?.(undefined);
      vi.clearAllTimers(); errors.mockRestore(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetModules();
    }
  });
}

it('a refused index writer check cannot hold a CPU capture behind its admission wait',async()=>{
 vi.resetModules();vi.useFakeTimers();Object.assign(state,{reason:'segment-gate',applications:0,blockedCheck:false,embedded:[]});
 const realProcess=process,listeners=new Map<string,(message:unknown)=>Promise<void>>(),sent:Message[]=[];
 const workerProcess=Object.create(realProcess);Object.defineProperties(workerProcess,{
  on:{value:(event:string,fn:(message:unknown)=>Promise<void>)=>{listeners.set(event,fn);return workerProcess;}},
  send:{value:(message:Message,cb?:(error:Error|null)=>void)=>{sent.push(message);cb?.(null);return true;}},
  exit:{value:vi.fn()},resourceUsage:{value:()=>realProcess.resourceUsage()},
 });vi.stubGlobal('process',workerProcess);const errors=vi.spyOn(console,'error').mockImplementation(()=>{});
 try{
  await import('./worker.ts');const emit=(message:unknown)=>listeners.get('message')!(message);
  await emit({type:'init',indexPath:'/unused/index',authorityPath:'/unused/authority',modelDirectory:'/unused/model',manifest:{model:'fixture',revision:'1',dimensions:1,files:[]}});
  await vi.advanceTimersByTimeAsync(0);state.blockedCheck=true;
  await emit({type:'index',requestId:'blocked-check',records:[{id:'record',version:1,scopeId:'scope',text:'fixture',deleted:false}]});
  await vi.advanceTimersByTimeAsync(200);
  const accepted=emit({id:'capture',sourceId:'source',revision:1,leaseGeneration:1,policyRevision:0,deletionEpoch:0,scopeId:'scope',stage:'capture',kind:'text',speaker:'owner',outcome:'recorded',cursor:0,totalBytes:5,text:'hello'});
  await vi.advanceTimersByTimeAsync(1);await accepted;
  expect(sent.filter(message=>message.type==='result'),'capture answers while index admission is still refused').toHaveLength(1);
  expect(sent.filter(message=>message.type==='index-result'),'no premature index acknowledgement').toHaveLength(0);
  expect(state.blockedCheck).toBe(true);
  state.blockedCheck=false;await vi.advanceTimersByTimeAsync(200);
  expect(sent.filter(message=>message.type==='index-result')).toHaveLength(1);
 }finally{state.blockedCheck=false;await vi.advanceTimersByTimeAsync(200);await listeners.get('disconnect')?.(undefined);vi.clearAllTimers();errors.mockRestore();vi.unstubAllGlobals();vi.useRealTimers();vi.resetModules();}
});
