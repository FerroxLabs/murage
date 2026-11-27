// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1022-idlerest W-HELPER-TICK-IDLE (HIDDEN-COST-fable M2, worker.ts:596): the memory helper's 50 ms maintenance tick ran for the helper's
// whole life, 20 wake-ups a second with nothing to do. A quiet tick now doubles its wait up to a minute; any message brings it back.
// The real worker.ts runs in this process with its parent channel stood in for; the index is a stub that counts its tick calls.
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ ticks: [] as number[] }));
vi.mock("./embeddings.ts", () => ({ MemoryEmbeddings: class { identity = "tick"; embed(texts: string[]) { return Promise.resolve(texts.map(() => [1])); } } }));
vi.mock("./index.ts", () => ({ MemoryIndex: class {
  static async create() { return new this(); }
  resetDone() { return null; }
  stopInfo() { return null; }
  rebuilt = false;
  prepareModel() {}
  async applyBatch() { return { status: "done" as const }; }
  upsert() {}
  vector() {}
  search() { return { hits: [], vectorRows: 0 }; }
  purgeRolledCheckpoints() { return { removed: 0, examined: 0, merged: false, done: true }; }
  maintenanceOwed() { return false; }
  async tick() { state.ticks.push(Date.now()); }
  writerCheckOwed() { return false; }
  close() {}
} }));
vi.mock("./eligibility.ts", () => ({ MemoryEligibility: class { read() { return { allowed: [], capacity: false }; } warm() {} close() {} } }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

it("ten idle minutes: the helper tick wakes at most once a minute; a message brings it back to 50 ms", async () => {
  vi.resetModules(); state.ticks.length = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], shouldAdvanceTime: false });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const realProcess = process, listeners = new Map<string, (message: unknown) => void>();
  const workerProcess = Object.create(realProcess) as NodeJS.Process;
  Object.defineProperties(workerProcess, {
    on: { value: (event: string, listener: (message: unknown) => void) => { if (event === "message" || event === "disconnect") listeners.set(event, listener); return workerProcess; } },
    send: { value: (_m: unknown, cb?: (e: Error | null) => void) => { if (typeof cb === "function") cb(null); return true; } },
    resourceUsage: { value: () => realProcess.resourceUsage() },
  });
  vi.stubGlobal("process", workerProcess);
  await import("./worker.ts");
  const emit = listeners.get("message")!;
  await emit({ type: "init", indexPath: "/unused/index", authorityPath: "/unused/authority", modelDirectory: "/unused/model", manifest: { model: "fixture", revision: "1", dimensions: 1, files: [] } });
  // the first minute settles start-up (the tick backs off from 50 ms)
  await vi.advanceTimersByTimeAsync(60_000);
  const start = Date.now(), from = state.ticks.length;
  const perMinute: number[] = [];
  for (let minute = 0; minute < 10; minute++) { const before = state.ticks.length; await vi.advanceTimersByTimeAsync(60_000); perMinute.push(state.ticks.length - before); }
  expect(state.ticks.slice(from).every(at => at >= start)).toBe(true);
  expect(Math.max(...perMinute), `helper ticks per idle minute: ${JSON.stringify(perMinute)}`).toBeLessThanOrEqual(1);
  // the effect is kept: a message (an index batch) brings the tick back within 100 ms
  const before = state.ticks.length;
  emit({ type: "index", requestId: "i1", records: [{ id: "r1", version: 1, scopeId: "s", text: "t", deleted: false }] });
  await vi.advanceTimersByTimeAsync(100);
  expect(state.ticks.length).toBeGreaterThan(before);
}, 60_000);
