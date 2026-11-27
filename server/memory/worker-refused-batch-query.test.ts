// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: memory helper (worker.ts drain). Consumer owner: fix/1020-io-start (fablehunt-1020q T4: "bot answered with no memory").
// A batch the checked writer refuses (check owed, log over its line) is retried every 50 ms. Once one search was served in that drain,
// every later search waited behind ALL of the retries, past RECALL_WAIT_MS (300 ms), and the turn went out without memory.
// The worker's real drain runs; only storage and the model are doubles (as worker-priority.test.ts).
import { expect, it, vi } from "vitest";
import { workerQueryAuthority, WorkerQueryEligibility } from "./testing/worker-query-fixture.ts";

const state=vi.hoisted(()=>({refusals:0,applyCalls:0}));
vi.mock("./embeddings.ts",()=>({MemoryEmbeddings:class {
  identity="refusal-fixture";
  async embed(texts:string[]){return texts.map(()=>[1]);}
}}));
vi.mock("./index.ts",()=>({MemoryIndex:class {
  static async create() { return new this(); }
  resetDone() { return null; }
  stopInfo() { return null; }
  rebuilt=false;
  prepareModel(){}
  async applyBatch() { state.applyCalls++; if (state.refusals > 0) { state.refusals--; return { status: "failed" as const, reason: "check-owed" as const, committed: 0 }; } return { status: "done" as const }; }
  async maintenanceStep() { return {}; }
  async vector(){}
  search(){return {hits:[],vectorRows:0};}
  purgeRolledCheckpoints(){return {removed:0,examined:0,merged:false,done:true};}
  maintenanceOwed(){return false;}
  close(){}
}}));
vi.mock("./eligibility.ts",()=>({MemoryEligibility:WorkerQueryEligibility}));

async function withWorker(run: (ctx: { emit: (m: unknown) => void; sent: Array<{ type: string; requestId?: string }> }) => Promise<void>) {
  vi.resetModules();
  const realProcess = process, listeners = new Map<string, (message: unknown) => void>(), sent: Array<{ type: string; requestId?: string }> = [];
  const workerProcess = Object.create(realProcess) as NodeJS.Process;
  Object.defineProperties(workerProcess, {
    on: { value: (event: string, listener: (message: unknown) => void) => { if (event === "message" || event === "disconnect") listeners.set(event, listener); return workerProcess; } },
    send: { value: (message: { type: string; requestId?: string }, cb?: (e: Error | null) => void) => { if (typeof cb === "function") cb(null); sent.push(message); return true; } },
    resourceUsage: { value: () => realProcess.resourceUsage() },
  });
  vi.stubGlobal("process", workerProcess);
  try {
    await import("./worker.ts");
    const emit = listeners.get("message")!;
    await emit({ type: "init", indexPath: "/unused/index", authorityPath: "/unused/authority", modelDirectory: "/unused/model", manifest: { model: "fixture", revision: "1", dimensions: 1, files: [] } });
    await run({ emit, sent });
  } finally { state.refusals = 0; vi.unstubAllGlobals(); vi.resetModules(); }
}
const input = (q: string) => ({ ...workerQueryAuthority, query: q, scopeIds: [], policyRevision: 0, deletionEpoch: 0, historical: false, cursor: "", limit: 10, semantic: false });
const answered = (sent: Array<{ type: string; requestId?: string }>, id: string) => sent.some(m => m.type === "query-result" && m.requestId === id);

it("a search arriving while a refused batch is retried is answered between the retries, not after the batch lands", async () => {
  state.refusals = 60; state.applyCalls = 0;   // about 3 s of 50 ms retries
  await withWorker(async ({ emit, sent }) => {
    emit({ type: "query", requestId: "first", input: input("first") });
    emit({ type: "index", requestId: "refused", records: [{ id: "r0", version: 1, scopeId: "scope", text: "r0", deleted: false }] });
    await vi.waitFor(() => { expect(answered(sent, "first")).toBe(true); expect(state.applyCalls).toBeGreaterThanOrEqual(2); }, { timeout: 2000 });
    const at = performance.now();
    emit({ type: "query", requestId: "turn", input: input("turn") });
    await vi.waitFor(() => expect(answered(sent, "turn")).toBe(true), { timeout: 2500, interval: 10 });
    const waited = performance.now() - at;
    console.info("T4 refused-batch search", JSON.stringify({ waitedMs: Math.round(waited), refusalsLeft: state.refusals }));
    // Answered inside the recall wait, while the batch is still being refused (the batch has not landed).
    expect(waited).toBeLessThan(300);
    expect(state.refusals).toBeGreaterThan(0);
    expect(sent.some(m => m.type === "index-result" && m.requestId === "refused")).toBe(false);
    // The batch itself still lands once the writer admits it.
    state.refusals = 0;
    await vi.waitFor(() => expect(sent.some(m => m.type === "index-result" && m.requestId === "refused")).toBe(true), { timeout: 2000 });
  });
}, 20_000);
