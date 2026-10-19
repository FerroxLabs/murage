// SPDX-License-Identifier: AGPL-3.0-or-later
// T2 (STALLS-FINAL-DESIGN RC-B2, database.ts invariant 2): while a writer hold is in force (the root-set VACUUM, an index build) the memory
// worker starts no background writer on the serving thread: no idle learning pass, no maintenance pass, no lineage warming, no status scan,
// and a helper message whose handling writes is queued, not dispatched. Once the hold is released, each runs within BUSY_RETRY_MS (one
// listener on the writer gate, never a poll) and the queued message is dispatched once.
import { fork } from "node:child_process";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, holdWritersForIndexBuild } from "../database.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const scans = vi.hoisted(() => ({ health: 0, retention: 0 }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), fork: vi.fn() }));
vi.mock("./health.ts", async importOriginal => ({ ...await importOriginal<typeof import("./health.ts")>(), stepHealthScan: () => { scans.health++; return false; } }));
vi.mock("./retention.ts", async importOriginal => ({ ...await importOriginal<typeof import("./retention.ts")>(), stepRetentionScan: () => { scans.retention++; return false; } }));

type Internals = { heldMessages: unknown[]; ready: boolean; onWorkerMessage(child: unknown, message: unknown): void };
let controller: MemoryWorkerController;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
  setMemoryMode("capture"); database();
  scans.health = 0; scans.retention = 0;
  vi.mocked(fork).mockImplementation(() => { throw new Error("no helper is spawned in these tests"); });
});
afterEach(async () => { holdWritersForIndexBuild(false); await controller.stop().catch(() => {}); closeDatabase(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it("a writer hold keeps every background pass and write-bearing helper message off the serving thread until it is released", async () => {
  const idle = vi.fn(async () => false), maintenance = vi.fn(async () => undefined), warm = vi.fn(() => false);
  controller = new MemoryWorkerController({ onIdleConsolidation: idle, onMaintenance: maintenance, onLineageWarm: warm });
  const internals = controller as unknown as Internals & { child: unknown; receiveWorkerMessage(child: unknown, message: unknown): void };
  const child = { kill() {}, on() {}, send() { return true; } };
  internals.child = child; // a helper already running (no spawn in this test)
  const dispatched = vi.spyOn(internals, "onWorkerMessage");
  holdWritersForIndexBuild(true);
  controller.start();
  controller.wakeLineageWarm(0);
  controller.wake();
  // the helper answers a search (read-only: dispatched at once) and says it is initialised (that writes the index owing: it waits)
  internals.receiveWorkerMessage(child, { type: "checkpoint-result", requestId: "none", ok: true });
  internals.receiveWorkerMessage(child, { type: "initialised" });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(idle).not.toHaveBeenCalled();
  expect(maintenance).not.toHaveBeenCalled();
  expect(warm).not.toHaveBeenCalled();
  expect(scans.health + scans.retention).toBe(0);
  const types = () => dispatched.mock.calls.map(call => (call[1] as { type?: string }).type);
  expect(types()).toEqual(["checkpoint-result"]);
  expect(internals.heldMessages).toHaveLength(1);
  expect(internals.ready).toBe(false);

  holdWritersForIndexBuild(false);
  await vi.advanceTimersByTimeAsync(250);
  expect(idle).toHaveBeenCalled();
  expect(maintenance).toHaveBeenCalled();
  expect(warm).toHaveBeenCalled();
  expect(scans.health).toBeGreaterThan(0);
  expect(types().filter(type => type === "initialised")).toHaveLength(1);
  expect(internals.heldMessages).toHaveLength(0);
  expect(internals.ready).toBe(true);
});

it("a hold that begins again before the queue drains keeps the messages queued, in order", async () => {
  controller = new MemoryWorkerController();
  const internals = controller as unknown as Internals & { child: unknown; receiveWorkerMessage(child: unknown, message: unknown): void };
  const order: string[] = [];
  vi.spyOn(internals, "onWorkerMessage").mockImplementation((_child, message) => { order.push(String((message as { type: string }).type)); });
  const child = { kill() {}, on() {}, send() { return true; } };
  internals.child = child;
  holdWritersForIndexBuild(true);
  internals.receiveWorkerMessage(child, { type: "result", n: 1 });
  internals.receiveWorkerMessage(child, { type: "query-result", requestId: "q" }); // read-only: not held
  internals.receiveWorkerMessage(child, { type: "index-result", n: 2 });
  expect(order).toEqual(["query-result"]);
  holdWritersForIndexBuild(false);
  holdWritersForIndexBuild(true); // a second hold before the drain's turn
  await vi.advanceTimersByTimeAsync(10);
  expect(order).toEqual(["query-result"]);
  holdWritersForIndexBuild(false);
  await vi.advanceTimersByTimeAsync(10);
  expect(order).toEqual(["query-result", "result", "index-result"]);
});
