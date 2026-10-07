// The real MemoryWorkerController with a stand-in worker: the pause after a cycle is three times
// the time the cycle held the loop, with no one-second ceiling, and the idle consolidation pass's
// synchronous time is charged to that same deadline. A long cycle therefore cannot hold the loop for
// most of the wall time; over a long run the loop is held for at most a quarter of it.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { resetParkSweep } from "./park.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import type { MemoryWork } from "./worker-protocol.ts";

const state = vi.hoisted(() => ({ claimCost: 0, idleCost: 0, cost: 0, busy: [] as Array<[number, number]> }));
vi.mock("./jobs.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./jobs.ts")>();
  return { ...actual, claimMemoryJob: (...args: Parameters<typeof actual.claimMemoryJob>) => {
    const work = actual.claimMemoryJob(...args);
    if (work) { const start = performance.now(); state.cost += state.claimCost; state.busy.push([start, start + state.claimCost]); }
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
  state.claimCost = 0; state.idleCost = 0; state.cost = 0; state.busy.length = 0; sent = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date"] });
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() + state.cost);
});
afterEach(async () => { await controller.stop().catch(() => {}); vi.useRealTimers(); vi.restoreAllMocks(); });
const messages = (n: number) => { for (let i = 0; i < n; i++) appendMessage("thread", { id: `m${i}`, ...(i ? { parentId: `m${i - 1}` } : {}), at: i + 1, role: "user", kind: "text", text: `Durable evidence number ${i}` }); };
const finish = (work: MemoryWork) => internals.onWorkerMessage(internals.child, { type: "result", result: { id: work.id, leaseGeneration: work.leaseGeneration, status: "complete", nextCursor: work.totalBytes,
  chunks: [{ text: work.text, startByte: 0, endByte: Buffer.byteLength(work.text) }] } });

it("a cycle that held the loop for three seconds earns a nine second pause, not one second", async () => {
  messages(2);
  state.claimCost = 3000;
  build();
  const t0 = performance.now();
  controller.start();
  await vi.advanceTimersByTimeAsync(250);
  expect(sent).toHaveLength(1);
  expect(internals.nextEligibleWorkAt - t0).toBeGreaterThanOrEqual(9000);
});

it("the idle pass's synchronous time is charged to the same deadline", async () => {
  build({ onIdleConsolidation: async () => { state.cost += 2000; } });
  const t0 = performance.now();
  controller.start();
  // An idle controller runs the idle pass on its 30 s sweep (int3 P5), not on a 250 ms poll.
  await vi.advanceTimersByTimeAsync(30_250);
  expect(internals.nextEligibleWorkAt - (t0 + 30_000)).toBeGreaterThanOrEqual(6000);
});

it("over a minute of backlog the loop is held for at most a quarter of the time in any ten seconds, give or take one cycle", async () => {
  messages(40);
  state.claimCost = 2000;
  build();
  const start = performance.now();
  controller.start();
  for (let step = 0; step < 240; step++) {
    await vi.advanceTimersByTimeAsync(250);
    while (sent.length) finish(sent.shift()!);
  }
  const end = performance.now();
  const busyTotal = state.busy.reduce((sum, [a, b]) => sum + (b - a), 0);
  expect(state.busy.length).toBeGreaterThan(2);
  expect(busyTotal / (end - start)).toBeLessThanOrEqual(0.27);
  for (let from = start; from + 10_000 <= end; from += 500) {
    const held = state.busy.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, from + 10_000) - Math.max(a, from)), 0);
    expect(held).toBeLessThanOrEqual(2500 + 2000);
  }
});
