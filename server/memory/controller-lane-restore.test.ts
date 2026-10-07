// The mobile lane's pacing, restored on the combined head: a cycle's claim and its deferred idle prefix
// are one measurement (costs add, they do not overlap), and idle consolidation is eligible at most once a
// second on its own deadline while capture wakes stay prompt.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { ioBudget } from "../io-budget.ts";
import { appendMessage } from "../message-db.ts";
import { resetParkSweep } from "./park.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import type { MemoryWork } from "./worker-protocol.ts";

const state = vi.hoisted(() => ({ claimCost: 0, cost: 0 }));
vi.mock("./jobs.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./jobs.ts")>();
  return { ...actual, claimMemoryJob: (...args: Parameters<typeof actual.claimMemoryJob>) => {
    const work = actual.claimMemoryJob(...args);
    if (work) state.cost += state.claimCost;
    return work;
  } };
});

type Internals = { child: unknown; ready: boolean; nextEligibleWorkAt: number; onWorkerMessage(child: unknown, message: unknown): void };
let controller: MemoryWorkerController, internals: Internals, sent: MemoryWork[];
const build = (options: ConstructorParameters<typeof MemoryWorkerController>[0] = {}) => {
  controller = new MemoryWorkerController(options);
  internals = controller as unknown as Internals;
  internals.child = { kill() {}, on() {}, send: (message: any) => {
    if (message.type === "index") internals.onWorkerMessage(internals.child, { type: "index-result", requestId: message.requestId, records: message.records, embeddingStatus: "indexed" });
    else sent.push(message);
  } };
  internals.ready = true;
};
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); resetParkSweep();
  state.claimCost = 0; state.cost = 0; sent = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date"] });
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() + state.cost);
});
afterEach(async () => { await controller.stop().catch(() => {}); vi.useRealTimers(); vi.restoreAllMocks(); });
const messages = (n: number) => { for (let i = 0; i < n; i++) appendMessage("thread", { id: `m${i}`, ...(i ? { parentId: `m${i - 1}` } : {}), at: i + 1, role: "user", kind: "text", text: `Durable evidence number ${i}` }); };

it("a 2 s claim plus a 2 s idle prefix pauses 16 s from the cycle start, not 10 s", async () => {
  messages(1);
  state.claimCost = 2000;
  build({ onIdleConsolidation: async () => { state.cost += 2000; } });
  const t0 = performance.now();
  controller.start();
  await vi.advanceTimersByTimeAsync(250);
  expect(sent).toHaveLength(1);
  const next = internals.nextEligibleWorkAt - t0;
  expect(next).toBeGreaterThanOrEqual(16000);
  expect(next).toBeLessThan(16300);
});

it("a burst of work notifications runs at most one empty consolidation scan per second", async () => {
  let scans = 0;
  build({ onIdleConsolidation: async () => { scans++; return false; } });
  controller.start();
  for (let i = 0; i < 19; i++) { controller.wake(); await vi.advanceTimersByTimeAsync(50); }
  expect(scans).toBe(1);
  // The arrivals inside the deadline are owed one look when it passes (not left for the 30 s idle sweep)...
  await vi.advanceTimersByTimeAsync(100);
  expect(scans).toBe(2);
  // ...and that look covers all of them: nothing more until the next arrival, which waits out its own second.
  await vi.advanceTimersByTimeAsync(1000);
  expect(scans).toBe(2);
  controller.wake(); await vi.advanceTimersByTimeAsync(50);
  expect(scans).toBe(3);
});

it("a capture wake is not delayed by the consolidation throttle", async () => {
  build({ onIdleConsolidation: async () => false });
  controller.start();
  controller.wake(); await vi.advanceTimersByTimeAsync(50);  // an empty scan: the consolidation deadline is now a second out
  messages(1);
  controller.wake();
  await vi.advanceTimersByTimeAsync(50);
  expect(sent).toHaveLength(1);
});

it("a burst of notifications after a consolidation that did work still waits out the one-second deadline", async () => {
  let scans = 0;
  build({ onIdleConsolidation: async () => { scans++; return true; } });
  controller.start();
  for (let i = 0; i < 19; i++) { controller.wake(); await vi.advanceTimersByTimeAsync(50); }
  expect(scans).toBe(1);
  // A run that did work continues on its own once the deadline passes, without another wake, and keeps the pace.
  await vi.advanceTimersByTimeAsync(100);
  expect(scans).toBe(2);
  for (let i = 0; i < 18; i++) { controller.wake(); await vi.advanceTimersByTimeAsync(50); }
  expect(scans).toBe(2);
  await vi.advanceTimersByTimeAsync(100);
  expect(scans).toBe(3);
});

it("a capture wake stays prompt after a consolidation that did work", async () => {
  build({ onIdleConsolidation: async () => true });
  controller.start();
  controller.wake(); await vi.advanceTimersByTimeAsync(50);
  messages(1);
  controller.wake();
  await vi.advanceTimersByTimeAsync(50);
  expect(sent).toHaveLength(1);
});

it("an owed consolidation deferred by the I/O budget retries on a bounded delay, not a 1 ms tick storm", async () => {
  let scans = 0;
  build({ onIdleConsolidation: async () => { scans++; return true; } });
  controller.start();
  controller.wake(); await vi.advanceTimersByTimeAsync(50);
  expect(scans).toBe(1);
  // The budget now defers memory-idle work for longer than the test window; capture has nothing queued.
  const defer = vi.spyOn(ioBudget, "shouldDefer").mockImplementation(source => source === "memory-idle");
  vi.spyOn(ioBudget, "deferredForMs").mockImplementation(source => source === "memory-idle" ? 400 : 0);
  await vi.advanceTimersByTimeAsync(1000); // the one-second deadline passes: the continuation is owed but deferred
  const before = controller.wakeCount;
  await vi.advanceTimersByTimeAsync(1000);
  expect(scans).toBe(1);
  expect(controller.wakeCount - before).toBeLessThanOrEqual(4);
  expect(controller.wakeCount - before).toBeGreaterThanOrEqual(1);
  // The deferral lifts: the owed continuation still runs without another wake.
  defer.mockReturnValue(false);
  await vi.advanceTimersByTimeAsync(500);
  expect(scans).toBe(2);
});
