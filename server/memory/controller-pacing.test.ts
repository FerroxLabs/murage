// The real MemoryWorkerController with a stand-in child process and fake
// timers: one deadline (nextEligibleWorkAt) paces every entry into a work
// cycle, every wake-up included; each cycle's own synchronous time is
// counted once; timeouts stay independent of the deadline; the one-time park
// sweep runs when the controller has nothing else to do, not ahead of work.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { resetParkSweep } from "./park.ts";
import { ioBudget } from "../io-budget.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import type { MemoryWork } from "./worker-protocol.ts";

const state = vi.hoisted(() => ({ claimCost: 0, cost: 0, claims: [] as number[], gapArgs: [] as number[] }));
vi.mock("./jobs.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./jobs.ts")>();
  return { ...actual, claimMemoryJob: (...args: Parameters<typeof actual.claimMemoryJob>) => {
    const work = actual.claimMemoryJob(...args);
    if (work) { state.claims.push(Date.now()); state.cost += state.claimCost; }
    return work;
  } };
});
vi.mock("./claim-trace.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./claim-trace.ts")>();
  return { ...actual, memoryTickGapMs: (busyMs: number) => { state.gapArgs.push(busyMs); return actual.memoryTickGapMs(busyMs); } };
});

type Internals = { child: unknown; ready: boolean; work: MemoryWork | null; deadline: number; nextEligibleWorkAt: number; onWorkerMessage(child: unknown, message: unknown): void; scheduleTick(start: number): void; tick(): void };
let controller: MemoryWorkerController, internals: Internals, sent: MemoryWork[], killed: number;

beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); resetParkSweep();
  state.claimCost = 0; state.cost = 0; state.claims.length = 0; state.gapArgs.length = 0; sent = []; killed = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date"] });
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() + state.cost);
  controller = new MemoryWorkerController();
  internals = controller as unknown as Internals;
  // The stand-in worker: work goes to `sent`; index batches are acknowledged at once.
  internals.child = { kill: () => { killed++; }, on() {}, send: (message: any) => {
    if (message.type === "index") internals.onWorkerMessage(internals.child, { type: "index-result", requestId: message.requestId, records: message.records, embeddingStatus: "indexed" });
    else sent.push(message);
  } };
  internals.ready = true;
});
afterEach(async () => { await controller.stop().catch(() => {}); vi.useRealTimers(); vi.restoreAllMocks(); });

const messages = (n: number) => { for (let i = 0; i < n; i++) appendMessage("thread", { id: `m${i}`, ...(i ? { parentId: `m${i - 1}` } : {}), at: i + 1, role: "user", kind: "text", text: `Durable evidence number ${i}` }); };
const finishNow = (work: MemoryWork) => internals.onWorkerMessage(internals.child, { type: "result", result: { id: work.id, leaseGeneration: work.leaseGeneration, status: "complete", nextCursor: work.totalBytes,
  chunks: [{ text: work.text, startByte: 0, endByte: Buffer.byteLength(work.text) }] } });
/** Hand the worker's result over and let the publication, which runs after the IPC handler returns, finish. */
const finish = async (work: MemoryWork) => { finishNow(work); await vi.advanceTimersByTimeAsync(0); };
const statuses = () => database().prepare("SELECT status FROM memory_jobs ORDER BY rowid").all().map(r => String(r.status));

it("no wake-up does work before the pacing deadline, and callbacks scheduled for it coalesce", async () => {
  messages(3);
  state.claimCost = 100;  // a 100 ms synchronous cycle earns a 300 ms pause
  const t0 = Date.now();
  controller.start();  // queued work wakes the controller at once (int3 P5: no idle polling)
  await vi.advanceTimersByTimeAsync(250);
  expect(state.claims).toHaveLength(1);
  const claimedAt = state.claims[0];
  expect(internals.nextEligibleWorkAt).toBeGreaterThanOrEqual(claimedAt + state.cost + 300);
  // The result arrives inside the pause (claim at t0, the pause runs to t0+300 on the fake wall clock).
  await finish(sent[0]);
  const timers = vi.getTimerCount();
  internals.scheduleTick(performance.now()); internals.scheduleTick(performance.now());
  expect(vi.getTimerCount()).toBe(timers);  // one wake-up, however often it is requested
  expect(Date.now()).toBe(t0 + 250);
  await vi.advanceTimersByTimeAsync(49);  // t0+299: still inside the pause
  expect(state.claims).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(2);  // the deadline passes
  await vi.advanceTimersByTimeAsync(20);  // the projection batch acknowledged after the handler returned, then the claim
  expect(state.claims).toHaveLength(2);
});

it("a cycle is charged its own synchronous time once: the claim's cost is not carried into the next cycle", async () => {
  messages(1);
  state.claimCost = 100;
  controller.start();
  await vi.advanceTimersByTimeAsync(250);
  expect(sent).toHaveLength(1);
  state.gapArgs.length = 0;
  await finish(sent[0]);  // a result handler that itself takes no time
  expect(state.gapArgs.length).toBeGreaterThan(0);
  expect(Math.max(...state.gapArgs)).toBeLessThan(2);
});

it("a small backlog still drains promptly: cheap cycles leave no pause and need no interval tick", async () => {
  messages(3);
  const t0 = Date.now();
  controller.start();
  await vi.advanceTimersByTimeAsync(250);
  for (let i = 0; i < 3; i++) {
    expect(sent).toHaveLength(i + 1);
    await finish(sent[i]);
    for (let k = 0; k < 4 && sent.length === i + 1 && i < 2; k++) await vi.advanceTimersToNextTimerAsync();
  }
  expect(statuses()).toEqual(["complete", "complete", "complete"]);
  expect(Date.now() - t0).toBeLessThan(260);  // well inside the second 250 ms interval tick
});

it("the work timeout fires while the pacing deadline is far away", async () => {
  messages(1);
  controller.start();
  await vi.advanceTimersByTimeAsync(250);
  expect(sent).toHaveLength(1);
  internals.nextEligibleWorkAt = Date.now() + 10 ** 9;
  internals.deadline = Date.now() - 1;
  internals.tick();
  expect(internals.work).toBeNull();
  expect(killed).toBe(1);
  expect(controller.error).toBe("MEMORY_WORKER_TIMEOUT");
});

it("the park sweep waits for an idle tick instead of running ahead of work", async () => {
  messages(2);
  database().prepare("UPDATE memory_sources SET state='retired' WHERE id=(SELECT source_id FROM memory_jobs ORDER BY rowid DESC LIMIT 1)").run();  // a job stuck behind a retired source
  const stuckStatus = () => String(database().prepare("SELECT j.status FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.state='retired'").get()!.status);
  controller.start();
  await vi.advanceTimersByTimeAsync(250);
  expect(sent).toHaveLength(1);
  expect(stuckStatus()).toBe("pending");  // the first tick claimed work; the sweep did not run first
  await finish(sent[0]);
  await vi.advanceTimersByTimeAsync(500);  // an idle tick follows
  expect(stuckStatus()).toBe("cancelled");
});

it("a notified arrival paced to the deadline is still a notification there: a deferred I/O budget does not hold it for the idle sweep", async () => {
  const defer = vi.spyOn(ioBudget, "shouldDefer").mockImplementation(source => source === "memory-worker");
  messages(2);
  state.claimCost = 100;  // each claim earns a 300 ms pause
  controller.start();
  await vi.advanceTimersByTimeAsync(50);
  expect(state.claims).toHaveLength(1);
  // The result comes back inside the pause; its wake-up is paced to the deadline...
  await finish(sent[0]);
  // ...but an earlier continuation (an idle pass's drain, a park step) fires first, still inside the pause.
  (controller as unknown as { schedule(delay: number): void }).schedule(10);
  await vi.advanceTimersByTimeAsync(400);  // past the deadline, far short of the 30 s idle sweep
  expect(state.claims).toHaveLength(2);
  defer.mockRestore();
});
