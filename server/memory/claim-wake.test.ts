// SPDX-License-Identifier: AGPL-3.0-or-later
// T8: a wake that arrives while a tick runs is replayed when the tick ends (CLAIM-REDESIGN.md section 5).
import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { captureSource } from "./capture.ts";
import * as jobs from "./jobs.ts";
import { setMemoryMode } from "./repository.ts";
import { MEMORY_IDLE_SWEEP_MS, MemoryWorkerController } from "./worker-controller.ts";

vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), fork: vi.fn() }));
vi.mock("./jobs.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./jobs.ts")>();
  return { ...actual, claimMemoryJob: vi.fn(actual.claimMemoryJob) };
});
class Helper extends EventEmitter {
  send = vi.fn((message: { type?: string }) => { if (message.type === "init") setTimeout(() => this.emit("message", { type: "initialised" }), 0); return true; });
  kill = vi.fn(() => { this.emit("exit", 0); return true; });
  disconnect() { this.emit("exit", 0); }
}
let helper: Helper;
let controller: MemoryWorkerController;
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
  setMemoryMode("capture");
  helper = new Helper();
  vi.mocked(fork).mockImplementation(() => { setTimeout(() => helper.emit("message", { type: "ready" }), 0); return helper as unknown as ReturnType<typeof fork>; });
  controller = new MemoryWorkerController();
});
afterEach(async () => { await controller.stop(); closeDatabase(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });
const enqueue = (id: string) => captureSource(database(), { id, threadId: "thread", kind: "text", speaker: "owner", outcome: "recorded", text: "A notebook remembers the owner's context" });

it("a claim that yields (and wakes the worker inside its tick) is followed by a tick within the pacing gap, not 30 s later", async () => {
  enqueue("a"); enqueue("b");
  const actual = await vi.importActual<typeof import("./jobs.ts")>("./jobs.ts");
  let yielded = false;
  vi.mocked(jobs.claimMemoryJob).mockImplementation((...args) => {
    if (!yielded) { yielded = true; jobs.notifyMemoryWork(); return null; }
    return actual.claimMemoryJob(...args);
  });
  controller.start();
  await vi.advanceTimersByTimeAsync(2000);
  expect(MEMORY_IDLE_SWEEP_MS).toBe(30_000);
  expect(jobs.claimMemoryJob).toHaveBeenCalledTimes(2);   // without the replay the second tick is 30 s away
  expect(fork).toHaveBeenCalledTimes(1);
  expect(database().prepare("SELECT count(*) AS n FROM memory_jobs WHERE status='leased'").get()!.n).toBe(1);
});

it("a wake during a tick that dispatched work schedules nothing extra", async () => {
  enqueue("a"); enqueue("b");
  const actual = await vi.importActual<typeof import("./jobs.ts")>("./jobs.ts");
  vi.mocked(jobs.claimMemoryJob).mockImplementation((...args) => { const work = actual.claimMemoryJob(...args); jobs.notifyMemoryWork(); return work; });
  controller.start();
  await vi.advanceTimersByTimeAsync(2000);
  expect(jobs.claimMemoryJob).toHaveBeenCalledTimes(1);   // the work is with the helper: completion, not the owed wake, continues
});
