// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A failed stepped merge waits out its back-off (5 min doubling to 1 h). Index batches that keep arriving must not restart
// maintenance or cancel that wait; the back-off resets only after a pass succeeds.
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ attempts: [] as number[], fail: true, owed: true }));
vi.mock("./embeddings.ts", () => ({ MemoryEmbeddings: class { identity = "backoff"; embed(texts: string[]) { return Promise.resolve(texts.map(() => [1])); } } }));
vi.mock("./index.ts", () => ({ MemoryIndex: class {
  rebuilt = false;
  prepareModel() {}
  upsert() {}
  vector() {}
  search() { return { hits: [], vectorRows: 0 }; }
  purgeRolledCheckpoints() { state.attempts.push(Date.now()); if (state.fail) throw new Error("merge failed"); return { removed: 0, examined: 0, merged: false, done: true }; }
  maintenanceOwed() { return state.owed; }
  close() {}
} }));
vi.mock("./eligibility.ts", () => ({ MemoryEligibility: class { read() { return { allowed: [], capacity: false }; } warm() {} close() {} } }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

it("successful upserts do not cancel or reset a pending failure back-off", async () => {
  vi.resetModules(); state.attempts.length = 0; state.fail = true;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: false });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const realProcess = process, listeners = new Map<string, (message: unknown) => void>();
  const workerProcess = Object.create(realProcess) as NodeJS.Process;
  Object.defineProperties(workerProcess, {
    on: { value: (event: string, listener: (message: unknown) => void) => { if (event === "message" || event === "disconnect") { listeners.set(event, listener); return workerProcess; } return realProcess.on(event, listener); } },
    send: { value: () => true },
    resourceUsage: { value: () => realProcess.resourceUsage() },
  });
  vi.stubGlobal("process", workerProcess);
  await import("./worker.ts");
  const emit = listeners.get("message")!;
  const MIN = 60_000, start = Date.now();
  emit({ type: "init", indexPath: "/unused/index", authorityPath: "/unused/authority", modelDirectory: "/unused/model", manifest: { model: "fixture", revision: "1", dimensions: 1, files: [] } });
  await vi.advanceTimersByTimeAsync(10);
  expect(state.attempts.length).toBe(1);                       // the first merge fails; the retry is due in 5 min
  let n = 0;
  const upsert = async () => { emit({ type: "index", requestId: `i${n}`, records: [{ id: `r${n}`, version: 1, scopeId: "s", text: "t", deleted: false }] }); n++; await vi.advanceTimersByTimeAsync(1000); };
  for (let i = 0; i < 30; i++) await upsert();                  // 30 s of successful upserts
  expect(state.attempts.length).toBe(1);
  await vi.advanceTimersByTimeAsync(5 * MIN - 31_000 - 20);
  for (let i = 0; i < 3; i++) await upsert();
  await vi.advanceTimersByTimeAsync(2 * MIN);                   // past the first 5 min: the retry fires once (and fails again)
  expect(state.attempts.length).toBe(2);
  // the second failure doubles the wait to 10 min, whatever the upserts do
  const second = state.attempts[1];
  for (let i = 0; i < 100; i++) await upsert();
  await vi.advanceTimersByTimeAsync(second + 10 * MIN - 2000 - Date.now());
  expect(state.attempts.length).toBe(2);
  state.fail = false; state.owed = false;
  await vi.advanceTimersByTimeAsync(3000);
  expect(state.attempts.length).toBe(3);
  expect(state.attempts[2] - second).toBeGreaterThanOrEqual(10 * MIN);
  expect(state.attempts[0] - start).toBeLessThan(MIN);
  // success resets the back-off: a batch now starts maintenance again at once
  state.owed = true;
  emit({ type: "index", requestId: "last", records: [{ id: "last", version: 1, scopeId: "s", text: "t", deleted: false }] });
  state.owed = false;                                           // the batch saw the debt; the pass then ends (no spin in the fixture)
  await vi.advanceTimersByTimeAsync(100);
  expect(state.attempts.length).toBe(4);
});
