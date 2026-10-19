// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// On ONNX Runtime WebAssembly (Intel macOS, or a native binding that failed to load) model calls are several times
// slower, so the worker indexes one record per call: a turn's recall waits behind at most one record of indexing,
// never the batch, and is answered before the batch finishes.
import { expect, it, vi } from "vitest";

// Delay actual worker drain awaits, not a parallel reimplementation of its
// selection rule. Storage/model doubles keep this scheduling regression offline.
const state=vi.hoisted(()=>({started:[] as string[][],release:[] as Array<()=>void>,indexed:[] as string[]}));
vi.mock("./embeddings.ts",()=>({MemoryEmbeddings:class {
  identity="scheduling-fixture";
  backend="wasm";
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
  purgeRolledCheckpoints(){return {removed:0,examined:0,merged:false,done:true};}
  maintenanceOwed(){return false;}
  close(){}
}}));
vi.mock("./eligibility.ts",()=>({MemoryEligibility:class {
  read(){return {allowed:[],capacity:false};}
  warm(){}
  close(){}
}}));


async function withWorker(run: (ctx: { emit: (m: unknown) => void; sent: Array<{ type: string; requestId?: string }> }) => Promise<void>) {
  vi.resetModules(); state.started.length = 0; state.release.length = 0; state.indexed.length = 0;
  const realProcess = process, listeners = new Map<string, (message: unknown) => void>(), sent: Array<{ type: string; requestId?: string }> = [];
  const workerProcess = Object.create(realProcess) as NodeJS.Process;
  Object.defineProperties(workerProcess, {
    on: { value: (event: string, listener: (message: unknown) => void) => { if (event === "message" || event === "disconnect") { listeners.set(event, listener); return workerProcess; } return realProcess.on(event, listener); } },
    send: { value: (message: { type: string; requestId?: string }) => { sent.push(message); return true; } },
    resourceUsage: { value: () => realProcess.resourceUsage() },
  });
  vi.stubGlobal("process", workerProcess);
  try {
    await import("./worker.ts");
    const emit = listeners.get("message")!;
    emit({ type: "init", indexPath: "/unused/index", authorityPath: "/unused/authority", modelDirectory: "/unused/model", manifest: { model: "fixture", revision: "1", dimensions: 1, files: [] } });
    await run({ emit, sent });
  } finally {
    for (let i = 0; i < 12; i++) { while (state.release.length) state.release.shift()!(); await Promise.resolve(); }
    vi.unstubAllGlobals(); vi.resetModules();
  }
}
const input = (q: string, extra: object = {}) => ({ query: q, scopeIds: ["scope"], policyRevision: 0, deletionEpoch: 0, historical: false, cursor: "", limit: 10, semantic: true, ...extra });

it("on WebAssembly a turn's recall waits behind one indexed record at most, and is answered before the batch ends", async () => {
  await withWorker(async ({ emit, sent }) => {
    emit({ type: "index", requestId: "backfill", records: Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, version: 1, scopeId: "scope", text: `r${i}`, deleted: false })) });
    await vi.waitFor(() => expect(state.started).toHaveLength(1));
    expect(state.started[0]).toEqual(["r0"]);
    emit({ type: "query", requestId: "turn", input: input("turn") });
    // The record already in the model finishes; the query goes next, ahead of the seven records still owed.
    state.release.shift()!();
    await vi.waitFor(() => expect(state.started).toHaveLength(2));
    expect(state.started[1]).toEqual(["turn"]);
    state.release.shift()!();
    await vi.waitFor(() => expect(sent.some(m => m.requestId === "turn" && m.type === "query-result")).toBe(true));
    expect(sent.some(m => m.requestId === "backfill")).toBe(false);
    expect(state.started.slice(0, 2).flat()).toEqual(["r0", "turn"]);
    // The rest of the batch then indexes, still one record per model call.
    for (let i = 0; i < 12; i++) { while (state.release.length) state.release.shift()!(); await new Promise(resolve => setTimeout(resolve, 5)); }
    await vi.waitFor(() => expect(sent.some(m => m.requestId === "backfill")).toBe(true));
    expect(state.started.slice(2).every(texts => texts.length === 1)).toBe(true);
    expect(state.started.flat().filter(text => text !== "turn")).toHaveLength(8);
  });
});

it("on WebAssembly, queries that keep arriving are each served between single-record slices", async () => {
  await withWorker(async ({ emit, sent }) => {
    emit({ type: "index", requestId: "backfill", records: Array.from({ length: 4 }, (_, i) => ({ id: `r${i}`, version: 1, scopeId: "scope", text: `r${i}`, deleted: false })) });
    await vi.waitFor(() => expect(state.started).toHaveLength(1));
    for (const id of ["q1", "q2"]) {
      emit({ type: "query", requestId: id, input: input(id) });
      state.release.shift()!();
      await vi.waitFor(() => expect(state.started.at(-1)).toEqual([id]));
      state.release.shift()!();
      await vi.waitFor(() => expect(sent.some(m => m.requestId === id)).toBe(true));
      expect(sent.some(m => m.requestId === "backfill")).toBe(false);
      await vi.waitFor(() => expect(state.started.at(-1)?.[0]).toMatch(/^r\d$/));
      expect(state.started.at(-1)).toHaveLength(1);
    }
    for (let i = 0; i < 8; i++) { while (state.release.length) state.release.shift()!(); await new Promise(resolve => setTimeout(resolve, 5)); }
    await vi.waitFor(() => expect(sent.some(m => m.requestId === "backfill")).toBe(true));
  });
});
