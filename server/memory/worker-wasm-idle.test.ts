// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ONNX Runtime WebAssembly keeps about a gigabyte of linear memory until its process ends. A helper that holds a
// WebAssembly model and has been idle asks its parent for leave to exit, and exits only once leave is given and
// nothing has arrived since. A helper on the native executor never asks.
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ resident: true, closed: 0 }));
vi.mock("./embeddings.ts", () => ({ MemoryEmbeddings: class {
  identity = "idle-fixture";
  backend = "wasm";
  get wasmResident() { return state.resident; }
  embed(texts: string[]) { return Promise.resolve(texts.map(() => [1])); }
} }));
vi.mock("./index.ts", () => ({ MemoryIndex: class {
  rebuilt = false;
  prepareModel() {}
  upsert() {}
  search() { return { hits: [], vectorRows: 0 }; }
  purgeRolledCheckpoints() { return { removed: 0, examined: 0, merged: false, done: true }; }
  maintenanceOwed() { return false; }
  close() { state.closed++; }
} }));
vi.mock("./eligibility.ts", () => ({ MemoryEligibility: class { read() { return { allowed: [], capacity: false }; } warm() {} close() {} } }));

async function withWorker(run: (ctx: { emit: (m: unknown) => void; sent: Array<{ type: string; requestId?: string }>; exits: number[] }) => Promise<void>) {
  vi.resetModules(); state.closed = 0;
  const realProcess = process, listeners = new Map<string, (message: unknown) => void>(), sent: Array<{ type: string; requestId?: string }> = [], exits: number[] = [];
  const workerProcess = Object.create(realProcess) as NodeJS.Process;
  Object.defineProperties(workerProcess, {
    on: { value: (event: string, listener: (message: unknown) => void) => { if (event === "message" || event === "disconnect") { listeners.set(event, listener); return workerProcess; } return realProcess.on(event, listener); } },
    send: { value: (message: { type: string; requestId?: string }) => { sent.push(message); return true; } },
    exit: { value: (code: number) => { exits.push(code); } },
    resourceUsage: { value: () => realProcess.resourceUsage() },
  });
  vi.stubGlobal("process", workerProcess);
  try {
    await import("./worker.ts");
    const emit = listeners.get("message")!;
    emit({ type: "init", indexPath: "/unused/index", authorityPath: "/unused/authority", modelDirectory: "/unused/model", wasmIdleExitMs: 60, manifest: { model: "fixture", revision: "1", dimensions: 1, files: [] } });
    await run({ emit, sent, exits });
  } finally { vi.unstubAllGlobals(); vi.resetModules(); }
}

it("a helper holding a WebAssembly model asks to exit when idle, and exits only when told to", async () => {
  state.resident = true;
  await withWorker(async ({ emit, sent, exits }) => {
    await vi.waitFor(() => expect(sent.some(m => m.type === "idle-exit-request")).toBe(true), { timeout: 3000 });
    expect(exits).toEqual([]);
    emit({ type: "idle-exit" });
    expect(exits).toEqual([0]);
    expect(state.closed).toBe(1);
  });
});

it("work that arrives before leave is given cancels the exit and restarts the idle clock", async () => {
  state.resident = true;
  await withWorker(async ({ emit, sent, exits }) => {
    await vi.waitFor(() => expect(sent.filter(m => m.type === "idle-exit-request")).toHaveLength(1), { timeout: 3000 });
    emit({ type: "query", requestId: "late", input: { query: "q", scopeIds: ["s"], policyRevision: 0, deletionEpoch: 0, historical: false, cursor: "", limit: 10, semantic: true } });
    await vi.waitFor(() => expect(sent.some(m => m.requestId === "late" && m.type === "query-result")).toBe(true));
    // Leave granted for the earlier request while the helper was working is refused if it is still busy; here it has finished.
    await vi.waitFor(() => expect(sent.filter(m => m.type === "idle-exit-request")).toHaveLength(2), { timeout: 3000 });
    expect(exits).toEqual([]);
  });
});

it("a helper on the native executor never asks to exit", async () => {
  state.resident = false;
  await withWorker(async ({ sent }) => {
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(sent.some(m => m.type === "idle-exit-request")).toBe(false);
  });
});
