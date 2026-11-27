// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: q1023-oneindex (oneindex.ts scopeSetHandle/scopeSetWire, search.ts bridge.search). Consumer owner: memory helper (worker.ts
// query handler, worker-protocol.ts searchInputSchema, worker-query.ts adoptScopeSet).
// FABLE b50b7c3cdc H-A: an access issued from the computed scope set carries a handle "scopes:<sha256>" @ "<epoch>", not two uuids. The helper
// parsed every query against the uuid-only handle schema, refused it as INVALID_MEMORY_SEARCH, and meaning recall was dead for every reader.
// The worker's real message handler, schema and drain run; only storage and the model are doubles (as worker-refused-batch-query.test.ts).
import { expect, it, vi } from "vitest";
import { scopeSetHandle, scopeSetWire, type RecallScopeSet } from "./oneindex.ts";

const seen = vi.hoisted(() => ({ views: [] as unknown[] }));
vi.mock("./embeddings.ts", () => ({ MemoryEmbeddings: class { identity = "oneindex-fixture"; async embed(texts: string[]) { return texts.map(() => [1]); } } }));
vi.mock("./index.ts", () => ({ MemoryIndex: class {
  static async create() { return new this(); }
  resetDone() { return null; } stopInfo() { return null; } rebuilt = false; prepareModel() {}
  async applyBatch() { return { status: "done" as const }; } async maintenanceStep() { return {}; } async vector() {}
  search() { return { hits: [], vectorRows: 0 }; }
  purgeRolledCheckpoints() { return { removed: 0, examined: 0, merged: false, done: true }; } maintenanceOwed() { return false; } close() {}
} }));
vi.mock("./eligibility.ts", () => ({ MemoryEligibility: class {
  validate() {}
  read(input: { view?: unknown }) { seen.views.push(input.view); return { allowed: [], capacity: false }; }
  lexical() { return { hits: [] }; } warm() {} close() {}
} }));

type Sent = { type: string; requestId?: string; reason?: string };
async function withWorker(run: (emit: (m: unknown) => void, sent: Sent[]) => Promise<void>) {
  vi.resetModules();
  const realProcess = process, listeners = new Map<string, (message: unknown) => void>(), sent: Sent[] = [];
  const workerProcess = Object.create(realProcess) as NodeJS.Process;
  Object.defineProperties(workerProcess, {
    on: { value: (event: string, listener: (message: unknown) => void) => { if (event === "message" || event === "disconnect") listeners.set(event, listener); return workerProcess; } },
    send: { value: (message: Sent, cb?: (e: Error | null) => void) => { if (typeof cb === "function") cb(null); sent.push(message); return true; } },
    resourceUsage: { value: () => realProcess.resourceUsage() },
  });
  vi.stubGlobal("process", workerProcess);
  try {
    await import("./worker.ts");
    const emit = listeners.get("message")!;
    await emit({ type: "init", indexPath: "/unused/index", authorityPath: "/unused/authority", modelDirectory: "/unused/model", manifest: { model: "fixture", revision: "1", dimensions: 1, files: [] } });
    await run(emit, sent);
  } finally { vi.unstubAllGlobals(); vi.resetModules(); }
}

it("W-WORKER-SCOPESET: the helper answers a search whose access was issued from the computed scope set (no INVALID_MEMORY_SEARCH)", async () => {
  const set: RecallScopeSet = Object.freeze({ scopes: Object.freeze(["scope-a", "scope-b"]), lineage: Object.freeze([]), personScopes: new Set(["scope-b"]), room: true });
  // The handle and wire exactly as policy.ts issues them and search.ts sends them (bridge.search input).
  const view = scopeSetHandle(set, 7), wire = scopeSetWire(view)!;
  const input = { query: "kettle", scopeIds: [], view, scopeSet: wire,
    reader: { botId: "fixture-bot", threadId: "fixture-thread", humanPrincipal: { personId: "fixture-owner", bindingId: "fixture-binding", revision: 0 }, notOwnerAudience: false },
    policyRevision: 0, deletionEpoch: 0, historical: false, cursor: "", limit: 10, semantic: true };
  await withWorker(async (emit, sent) => {
    emit({ type: "query", requestId: "scopeset", input });
    await vi.waitFor(() => expect(sent.some(m => m.requestId === "scopeset")).toBe(true), { timeout: 3000 });
    const answer = sent.filter(m => m.requestId === "scopeset").map(m => m.reason ? `${m.type}:${m.reason}` : m.type);
    expect(answer).toEqual(["query-result"]);
    expect(seen.views).toEqual([{ viewId: view.viewId, generation: view.generation, digest: view.digest }]);
    // The helper's own module realm (the worker imported it after resetModules) adopted the set from the wire under the handle's digest.
    const { scopeSetOf } = await import("./oneindex.ts");
    const adopted = (() => { try { return scopeSetOf(view)?.set.scopes; } catch (error) { return String(error); } })();
    expect(adopted).toEqual(["scope-a", "scope-b"]);
  });
}, 20_000);

