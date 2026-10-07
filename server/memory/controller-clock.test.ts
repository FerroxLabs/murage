// R3: the pacing deadline and the wake-up delay are measured on the monotonic
// clock (performance.now), so setting the wall clock back cannot hold work off
// beyond the pause a cycle earned (1 s at most). Persisted lease timestamps keep
// wall-clock time and are not touched by this.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { resetParkReconcile, resetParkSweep } from "./park.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import type { MemoryWork } from "./worker-protocol.ts";

const state = vi.hoisted(() => ({ claimCost: 0, cost: 0, mono: 0, claims: 0 }));
vi.mock("./jobs.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./jobs.ts")>();
  return { ...actual, claimMemoryJob: (...args: Parameters<typeof actual.claimMemoryJob>) => {
    const work = actual.claimMemoryJob(...args);
    if (work) { state.claims++; state.cost += state.claimCost; }
    return work;
  } };
});

type Internals = { child: unknown; ready: boolean; onWorkerMessage(child: unknown, message: unknown): void };
let controller: MemoryWorkerController, internals: Internals, sent: MemoryWork[];

beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); resetParkSweep(); resetParkReconcile();
  state.claimCost = 0; state.cost = 0; state.mono = 0; state.claims = 0; sent = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date"] });
  // Monotonic time: follows the fake wall clock while it advances, and is kept continuous when the wall clock is set back.
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() + state.cost + state.mono);
  controller = new MemoryWorkerController();
  internals = controller as unknown as Internals;
  internals.child = { kill() {}, on() {}, send: (message: any) => {
    if (message.type === "index") internals.onWorkerMessage(internals.child, { type: "index-result", requestId: message.requestId, records: message.records, embeddingStatus: "indexed" });
    else sent.push(message);
  } };
  internals.ready = true;
});
afterEach(async () => { await controller.stop().catch(() => {}); vi.useRealTimers(); vi.restoreAllMocks(); });

const finish = (work: MemoryWork) => internals.onWorkerMessage(internals.child, { type: "result", result: { id: work.id, leaseGeneration: work.leaseGeneration, status: "complete", nextCursor: work.totalBytes,
  chunks: [{ text: work.text, startByte: 0, endByte: Buffer.byteLength(work.text) }] } });
const setWallClockBack = (ms: number) => { vi.setSystemTime(Date.now() - ms); state.mono += ms; };

it("a wall clock set back one hour does not delay work beyond the 1 s pacing cap", async () => {
  for (let i = 0; i < 2; i++) appendMessage("thread", { id: `m${i}`, ...(i ? { parentId: `m${i - 1}` } : {}), at: i + 1, role: "user", kind: "text", text: `Durable evidence number ${i}` });
  state.claimCost = 100;  // a 100 ms cycle earns a 300 ms pause
  controller.start();
  await vi.advanceTimersByTimeAsync(250);
  expect(state.claims).toBe(1);
  setWallClockBack(3_600_000);
  finish(sent[0]);  // the result arrives inside the pause; the next cycle waits for the deadline
  await vi.advanceTimersByTimeAsync(1_000);
  expect(state.claims).toBe(2);
});
