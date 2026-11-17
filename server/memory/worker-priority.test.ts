// A turn's query does not wait behind a whole index batch (it is served between slices of the batch's
// model work), and a query whose deadline has passed is dropped without model work or a result.
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
  static async create() { return new this(); }
  resetDone() { return null; }
  stopInfo() { return null; }
  rebuilt=false;
  prepareModel(){}
  async applyBatch(records: Array<{text:string}>) { this.upsert(records); return { status: "done" as const }; }
  upsert(records:Array<{text:string}>){state.indexed.push(...records.map(record=>record.text));}
  vector(){}
  search(){return {hits:[],vectorRows:0};}
  purgeRolledCheckpoints(){return {removed:0,examined:0,merged:false,done:true};}
  maintenanceOwed(){return false;}
  close(){}
}}));
vi.mock("./eligibility.ts",()=>({MemoryEligibility:class {
  read(){return {allowed:[],capacity:false};}
  validate(){}
  lexical(){return {hits:[]};}
  warm(){}
  close(){}
}}));


async function withWorker(run: (ctx: { emit: (m: unknown) => void; sent: Array<{ type: string; requestId?: string }> }) => Promise<void>) {
  vi.resetModules(); state.started.length = 0; state.release.length = 0; state.indexed.length = 0;
  const realProcess = process, listeners = new Map<string, (message: unknown) => void>(), sent: Array<{ type: string; requestId?: string }> = [];
  const workerProcess = Object.create(realProcess) as NodeJS.Process;
  Object.defineProperties(workerProcess, {
    on: { value: (event: string, listener: (message: unknown) => void) => { if (event === "message" || event === "disconnect") { listeners.set(event, listener); return workerProcess; } return workerProcess; } },
    send: { value: (message: { type: string; requestId?: string }, cb?: (e: Error | null) => void) => { if (typeof cb === "function") cb(null); sent.push(message); return true; } },
    resourceUsage: { value: () => realProcess.resourceUsage() },
  });
  vi.stubGlobal("process", workerProcess);
  try {
    await import("./worker.ts");
    const emit = listeners.get("message")!;
    await emit({ type: "init", indexPath: "/unused/index", authorityPath: "/unused/authority", modelDirectory: "/unused/model", manifest: { model: "fixture", revision: "1", dimensions: 1, files: [] } });
    await run({ emit, sent });
  } finally {
    for (let i = 0; i < 12; i++) { while (state.release.length) state.release.shift()!(); await Promise.resolve(); }
    vi.unstubAllGlobals(); vi.resetModules();
  }
}
const input = (q: string, extra: object = {}) => ({ query: q, scopeIds: [], view:{viewId:"00000000-0000-4000-8000-000000000001",generation:"00000000-0000-4000-8000-000000000002",digest:"0".repeat(64)},reader:{botId:"reader",threadId:"thread",humanPrincipal:{personId:"owner",bindingId:"local",revision:1},notOwnerAudience:false}, policyRevision: 0, deletionEpoch: 0, historical: false, cursor: "", limit: 10, semantic: true, ...extra });

it("a query arriving during a long index batch is served between slices of the batch, not after all of it", async () => {
  await withWorker(async ({ emit, sent }) => {
    emit({ type: "index", requestId: "big", records: Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, version: 1, scopeId: "scope", text: `r${i}`, deleted: false })) });
    await vi.waitFor(() => expect(state.started).toHaveLength(1));
    expect(state.started[0].length).toBeLessThanOrEqual(4);
    emit({ type: "query", requestId: "turn", input: input("turn") });
    state.release.shift()!();
    await vi.waitFor(() => expect(state.started).toHaveLength(2));
    expect(state.started[1]).toEqual(["turn"]);
    state.release.shift()!();
    await vi.waitFor(() => expect(sent.some(m => m.requestId === "turn")).toBe(true));
    expect(sent.some(m => m.requestId === "big")).toBe(false);
    for (let i = 0; i < 4; i++) { while (state.release.length) state.release.shift()!(); await new Promise(resolve => setTimeout(resolve, 5)); }
    await vi.waitFor(() => expect(sent.some(m => m.requestId === "big")).toBe(true));
    expect(state.indexed).toHaveLength(12);
  });
});

it("a query whose deadline has passed is dropped: no model work, no result", async () => {
  await withWorker(async ({ emit, sent }) => {
    emit({ type: "query", requestId: "late", input: input("late", { deadlineAt: Date.now() - 1 }) });
    emit({ type: "query", requestId: "live", input: input("live", { deadlineAt: Date.now() + 5000 }) });
    await vi.waitFor(() => expect(state.started).toEqual([["live"]]));
    state.release.shift()!();
    await vi.waitFor(() => expect(sent.some(m => m.requestId === "live")).toBe(true));
    expect(sent.some(m => m.requestId === "late")).toBe(false);
  });
});

const work = (id: string) => ({ id, sourceId: "s", revision: 1, leaseGeneration: 1, policyRevision: 0, deletionEpoch: 0, scopeId: "scope", stage: "capture", kind: "text", speaker: "owner", outcome: "recorded", cursor: 0, totalBytes: 5, text: "hello" });

it("a search that arrives while a capture is waiting is answered first, and the capture is still done", async () => {
  await withWorker(async ({ emit, sent }) => {
    emit(work("job"));
    emit({ type: "query", requestId: "turn", input: input("turn", { semantic: false }) });
    await vi.waitFor(() => expect(sent.filter(message => message.type === "result")).toHaveLength(1));
    const order = sent.map(message => message.type);
    expect(order.indexOf("query-result")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("query-result")).toBeLessThan(order.indexOf("result"));
  });
});

it("a capture that fails inside the helper is reported as rejected work and written to stderr, and the helper goes on", async () => {
  const errors: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")); });
  try {
    await withWorker(async ({ emit, sent }) => {
      emit({ ...work("bad"), totalBytes: 2 });  // 5 bytes of text for a 2 byte source: INVALID_SOURCE_COVERAGE
      await vi.waitFor(() => expect(sent.some(message => message.type === "error")).toBe(true));
      emit(work("good"));
      await vi.waitFor(() => expect(sent.some(message => message.type === "result")).toBe(true));
    });
  } finally { spy.mockRestore(); }
  expect(errors.some(line => line.includes("capture rejected") && line.includes("INVALID_SOURCE_COVERAGE"))).toBe(true);
});

// Producer owner: recall-fix-c (capture scheduling). Consumer owner: recall-fix-c (native warm turns).
it("a capture finishes while an index embedding is still held", async () => {
  await withWorker(async ({emit,sent}) => {
    emit({type:"index",requestId:"held-index",records:[{id:"fixture-record",version:1,scopeId:"scope",text:"fixture text",deleted:false}]});
    await vi.waitFor(() => expect(state.started).toHaveLength(1));
    emit(work("during-index"));
    await vi.waitFor(() => expect(sent.find(message => message.type === "result")).toMatchObject({result:{id:"during-index",status:"complete",chunks:[{text:"hello"}]}}));
    expect(sent.some(message => message.requestId === "held-index")).toBe(false);
    expect(state.release).toHaveLength(1);
  });
});

it("a live query keeps capture priority until it is cancelled during inference", async () => {
  await withWorker(async ({emit,sent}) => {
    emit({type:"query",requestId:"held-query",input:input("held-query")});
    await vi.waitFor(() => expect(state.started).toHaveLength(1));
    emit(work("after-cancel"));
    await new Promise(resolve => setTimeout(resolve,25));
    expect(sent.some(message => message.type === "result")).toBe(false);
    emit({type:"cancel",requestId:"held-query"});
    await vi.waitFor(() => expect(sent.find(message => message.type === "result")).toMatchObject({result:{id:"after-cancel",status:"complete"}}));
    expect(sent.some(message => message.requestId === "held-query")).toBe(false);
    expect(state.release).toHaveLength(1);
  });
});

it("a checked lexical batch returns its unused permit before waiting on embeddings", async () => {
  await withWorker(async ({emit,sent}) => {
    emit({type:"index",requestId:"lexical",grant:{id:"fixture-index-permit",bytes:4096,expiresAt:Date.now()+60_000},records:[{id:"reference",version:1,scopeId:"scope",text:"fixture reference",deleted:false}]});
    await vi.waitFor(() => expect(state.started).toHaveLength(1));
    expect(sent).toContainEqual({type:"bg-grant-settle",id:"fixture-index-permit",used:0});
    expect(sent.some(message=>message.type==="index-result")).toBe(false);
    expect(state.release).toHaveLength(1);
  });
});
