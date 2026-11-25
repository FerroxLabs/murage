// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: memv2 lane E (design 4.1 E6: the helper's 5-minute index re-walk runs once per helper start and after a lost acknowledgement).
// Owner of the controller's side (worker-controller.ts askRolledPass, the "purge-rolled" message): lane E. Owner of MemoryIndex: unchanged.
//
// The rolled-checkpoint purge (worker.ts purgeRolledCheckpoints) used to walk the index again every 5 minutes after a pass that found
// nothing left: an idle helper woke 12 times an hour for nothing. The pass now runs at start, when a batch or a finished scrub leaves
// maintenance owed, after a failure (its back-off, worker-backoff.test.ts) and when the controller says an acknowledgement was lost.
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ attempts: [] as number[], owed: false, scrub: false, scrubs: 0, order: [] as string[], gate: null as Promise<void> | null, passes: 0, pendingSeq: [] as boolean[] }));
vi.mock("./embeddings.ts", () => ({ MemoryEmbeddings: class { identity = "rolled-pass"; embed(texts: string[]) { return Promise.resolve(texts.map(() => [1])); } } }));
vi.mock("./index.ts", () => ({ MemoryIndex: class {
  static async create() { return new this(); }
  resetDone() { return null; }
  stopInfo() { return null; }
  rebuilt = false;
  scrubBlocked = false;
  scrubDrain = false;
  prepareModel() {}
  async applyBatch() { this.upsert(); return { status: "done" as const }; }
  upsert() {}
  vector() {}
  search() { return { hits: [], vectorRows: 0 }; }
  async purgeRolledCheckpoints() { state.attempts.push(Date.now()); state.order.push("pass"); if (state.gate) await state.gate; state.owed = false; state.passes++; return { removed: 0, examined: 0, merged: false, done: true }; }
  maintenanceOwed() { return state.owed; }
  deletionScrubPending() { return state.pendingSeq.length ? state.pendingSeq.shift()! : state.scrub; }
  async scrubDeleted() { state.scrubs++; state.order.push("scrub"); state.scrub = false; return true; }
  close() {}
} }));
vi.mock("./eligibility.ts", () => ({ MemoryEligibility: class { read() { return { allowed: [], capacity: false }; } warm() {} close() {} } }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

const MIN = 60_000;
async function startHelper() {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: false });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const realProcess = process, listeners = new Map<string, (message: unknown) => void>(), sent: Array<{ type?: string }> = [];
  const workerProcess = Object.create(realProcess) as NodeJS.Process;
  Object.defineProperties(workerProcess, {
    on: { value: (event: string, listener: (message: unknown) => void) => { if (event === "message" || event === "disconnect") listeners.set(event, listener); return workerProcess; } },
    send: { value: (message: { type?: string }, cb?: (e: Error | null) => void) => { sent.push(message); if (typeof cb === "function") cb(null); return true; } },
    resourceUsage: { value: () => realProcess.resourceUsage() },
  });
  vi.stubGlobal("process", workerProcess);
  await import("./worker.ts");
  const emit = listeners.get("message")!;
  await emit({ type: "init", indexPath: "/unused/index", authorityPath: "/unused/authority", modelDirectory: "/unused/model", manifest: { model: "fixture", revision: "1", dimensions: 1, files: [] } });
  await vi.advanceTimersByTimeAsync(10);
  return { emit, sent };
}

it("W-E6-HELPER an idle helper walks the index for rolled versions once at start, not every 5 minutes; a lost acknowledgement asks for one walk", async () => {
  state.attempts.length = 0; state.owed = false; state.scrub = false;
  const { emit } = await startHelper();
  expect(state.attempts.length, "the pass at helper start").toBe(1);
  // an idle hour: the pre-change helper walked again every 5 minutes (12 passes in the hour, RED receipt)
  await vi.advanceTimersByTimeAsync(60 * MIN);
  expect(state.attempts.length, "no re-walk on a clock").toBe(1);
  // worker-controller.ts askRolledPass: the controller lost the helper's answer to an index batch
  await emit({ type: "purge-rolled" });
  await vi.advanceTimersByTimeAsync(10);
  expect(state.attempts.length, "one walk for the lost acknowledgement").toBe(2);
  await vi.advanceTimersByTimeAsync(60 * MIN);
  expect(state.attempts.length).toBe(2);
});

it("W-E6-HELPER-SCRUB a pass that stopped for an owner deletion's scrub resumes when the scrub is done, not 5 minutes later", async () => {
  state.attempts.length = 0; state.order.length = 0; state.owed = true; state.scrub = true; state.scrubs = 0;
  await startHelper();
  await vi.advanceTimersByTimeAsync(5_000);
  // the scrub owns the writer first (the pass at start stops before its first step); the owed pass follows it at once
  expect(state.scrubs, "the scrub ran").toBeGreaterThan(0);
  expect(state.order, "the owed pass resumed as the scrub finished").toEqual(["scrub", "pass"]);
  expect(state.owed).toBe(false);
  await vi.advanceTimersByTimeAsync(60 * MIN);
  expect(state.attempts.length).toBe(1);
});

it("W-E6-HELPER-SCRUB-START a start pass the scrub put off is still owed with no merge pending, and runs when the scrub is done", async () => {
  // MemoryIndex.maintenanceOwed() names only a merge (index.ts purge.merging): a walk not started or part way is not in it
  state.attempts.length = 0; state.order.length = 0; state.owed = false; state.scrub = true; state.scrubs = 0; state.gate = null;
  await startHelper();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(state.order, "the helper's start walk, after the scrub").toEqual(["scrub", "pass"]);
  await vi.advanceTimersByTimeAsync(60 * MIN);
  expect(state.attempts.length).toBe(1);
});

it("W-E6-HELPER-AGAIN a lost acknowledgement reported while a pass runs gets a pass of its own after that one", async () => {
  state.attempts.length = 0; state.order.length = 0; state.owed = false; state.scrub = false; state.passes = 0;
  let open!: () => void;
  state.gate = new Promise<void>(resolve => { open = resolve; });
  const { emit } = await startHelper();
  expect(state.attempts.length, "the start pass is part way").toBe(1);
  await emit({ type: "purge-rolled" });   // its cursor may already be past what the race left behind
  state.gate = null; open();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(state.passes, "the start pass and one more for the lost acknowledgement").toBe(2);
  await vi.advanceTimersByTimeAsync(60 * MIN);
  expect(state.passes).toBe(2);
});

it("W-E6-HELPER-SCRUB-ELSEWHERE a pass put off for a scrub that something else finished (maintain() runs the scrub first) is not lost", async () => {
  state.attempts.length = 0; state.order.length = 0; state.owed = false; state.scrub = false; state.scrubs = 0; state.gate = null;
  // pending when the helper opens and when the start pass looks; gone when the scrub timer looks: another step finished it
  state.pendingSeq = [true, true];
  await startHelper();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(state.scrubs, "the scrub timer had nothing left to do").toBe(0);
  expect(state.order, "the start walk ran all the same").toEqual(["pass"]);
  await vi.advanceTimersByTimeAsync(60 * MIN);
  expect(state.attempts.length).toBe(1);
});
