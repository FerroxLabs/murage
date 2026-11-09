// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ALL.eld250: with no job owed at boot no helper ran, so the first search forked one, and that cold start outlasted the query
// deadline: the first turn after a restart went out with no recall. The helper is now started soon after boot and on owner intent.
import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { memoryState, setMemoryMode } from "./repository.ts";
import { memoryIndexReaderState, ownerIndexHandle } from "./index-reader.ts";
import { hasClaimableMemoryJob } from "./jobs.ts";
import { MEMORY_BOOT_WARM_MS, MEMORY_IDLE_SWEEP_MS, MEMORY_WORKER_INIT_MS, MemoryWorkerController } from "./worker-controller.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), fork: vi.fn() }));
vi.mock("./repository.ts", async importOriginal => { const real = await importOriginal<typeof import("./repository.ts")>(); return { ...real, memoryState: vi.fn(real.memoryState) }; });
vi.mock("./jobs.ts", async importOriginal => ({ ...await importOriginal<typeof import("./jobs.ts")>(), hasClaimableMemoryJob: vi.fn(() => false) }));
class Helper extends EventEmitter {
  send = vi.fn(() => true);
  kill = vi.fn(() => { this.emit("exit", 0); return true; });
  disconnect() { this.emit("exit", 0); }
}
let controller: MemoryWorkerController;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-06T00:00:00Z"));
  vi.mocked(hasClaimableMemoryJob).mockReturnValue(false);
  const helper = new Helper();
  vi.mocked(fork).mockImplementation(() => { setTimeout(() => helper.emit("message", { type: "ready" }), 0); return helper as unknown as ReturnType<typeof fork>; });
  controller = new MemoryWorkerController();
});
afterEach(async () => { await controller.stop(); closeDatabase(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it("with memory active and nothing owed, a helper is started after the boot wait, not before", async () => {
  setMemoryMode("active");
  controller.start();
  await vi.advanceTimersByTimeAsync(MEMORY_BOOT_WARM_MS - 100);
  expect(fork).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  expect(fork).toHaveBeenCalledTimes(1);
});

it("owner intent starts a helper that never ran, and a second intent does not start another", async () => {
  setMemoryMode("active");
  controller.start();
  controller.warmForIntent();
  controller.warmForIntent();
  expect(fork).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(MEMORY_BOOT_WARM_MS + 100);
  expect(fork).toHaveBeenCalledTimes(1);
});

it("memory not active starts no helper for recall", async () => {
  setMemoryMode("capture");
  controller.start();
  controller.warmForIntent();
  await vi.advanceTimersByTimeAsync(MEMORY_BOOT_WARM_MS + 100);
  expect(fork).not.toHaveBeenCalled();
});

it("a stop before the boot wait ends cancels the start", async () => {
  setMemoryMode("active");
  controller.start();
  await controller.stop();
  await vi.advanceTimersByTimeAsync(MEMORY_BOOT_WARM_MS + 100);
  expect(fork).not.toHaveBeenCalled();
});

it("the warm never blocks boot: start() returns with no fork, and a fork that throws never leaves the timer", async () => {
  setMemoryMode("active");
  vi.mocked(fork).mockImplementation(() => { throw new Error("no fork today"); });
  controller.start();
  expect(fork).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(MEMORY_BOOT_WARM_MS + 100);
  expect(fork).toHaveBeenCalledTimes(1);
  expect(controller.status().running).toBe(false);
});

it("a warm whose fork throws waits out the back-off, shows the owner nothing, and leaves recall able to read the index", async () => {
  setMemoryMode("active");
  vi.mocked(fork).mockImplementation(() => { throw new Error("no fork today"); });
  controller.start();
  for (let i = 0; i < 50; i++) controller.warmForIntent();
  expect(fork).toHaveBeenCalledTimes(1);
  expect(controller.error).toBeNull();
  ownerIndexHandle();
  expect(memoryIndexReaderState()).not.toBe("blocked");
  await vi.advanceTimersByTimeAsync(MEMORY_IDLE_SWEEP_MS - 1_000);
  for (let i = 0; i < 50; i++) controller.warmForIntent();
  expect(fork).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2_000);
  controller.warmForIntent();
  expect(fork).toHaveBeenCalledTimes(2);
  expect(controller.error).toBeNull();
});

it("a warm helper that dies before it is ready is not restarted in a loop, and the owner sees nothing", async () => {
  setMemoryMode("active");
  const dying: Helper[] = [];
  vi.mocked(fork).mockImplementation(() => { const helper = new Helper(); dying.push(helper); setTimeout(() => helper.emit("exit", 1), 0); return helper as unknown as ReturnType<typeof fork>; });
  controller.start();
  controller.warmForIntent();
  await vi.advanceTimersByTimeAsync(10);
  for (let i = 0; i < 50; i++) controller.warmForIntent();
  await vi.advanceTimersByTimeAsync(MEMORY_BOOT_WARM_MS);
  expect(dying).toHaveLength(1);
  expect(controller.error).toBeNull();
});

it("a warm helper that keeps dying right after it is ready is started at most once per sweep, whatever the owner presses", async () => {
  setMemoryMode("active");
  const helpers: Helper[] = [];
  vi.mocked(fork).mockImplementation(() => { const helper = new Helper(); helpers.push(helper); return helper as unknown as ReturnType<typeof fork>; });
  controller.start();
  controller.warmForIntent();
  helpers[0]!.emit("message", { type: "initialised", wasm: false });
  helpers[0]!.emit("exit", 1);
  for (let i = 0; i < 50; i++) controller.warmForIntent();
  expect(helpers).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(MEMORY_IDLE_SWEEP_MS + 100);
  controller.warmForIntent();
  expect(helpers).toHaveLength(2);
});

it("a failed mode read at a warm means no warm this time: no back-off, no owner error, and the next intent starts a helper", async () => {
  setMemoryMode("active");
  controller.start();
  vi.mocked(memoryState).mockImplementationOnce(() => { throw new Error("database is locked"); });
  expect(() => controller.warmForIntent()).not.toThrow();
  expect(fork).not.toHaveBeenCalled();
  expect(controller.error).toBeNull();
  controller.warmForIntent();
  expect(fork).toHaveBeenCalledTimes(1);
});

it("a warm helper stuck starting with nothing owed is ended at the deadline: recall is not shut out, and the owner sees nothing", async () => {
  setMemoryMode("active");
  const helpers: Helper[] = [];
  vi.mocked(fork).mockImplementation(() => { const helper = new Helper(); helpers.push(helper); return helper as unknown as ReturnType<typeof fork>; });
  controller.start();
  controller.warmForIntent();
  ownerIndexHandle();
  expect(memoryIndexReaderState()).toBe("blocked");
  await vi.advanceTimersByTimeAsync(MEMORY_WORKER_INIT_MS + MEMORY_IDLE_SWEEP_MS + 100);
  expect(helpers[0]!.kill).toHaveBeenCalledWith("SIGKILL");
  ownerIndexHandle();
  expect(memoryIndexReaderState()).not.toBe("blocked");
  expect(controller.status().running).toBe(false);
  expect(controller.error).toBeNull();
});

it("a warm helper that errors and never started has no exit to wait for: recall is not shut out, and the next start waits", async () => {
  setMemoryMode("active");
  const helpers: Helper[] = [];
  vi.mocked(fork).mockImplementation(() => { const helper = new Helper(); helpers.push(helper); return helper as unknown as ReturnType<typeof fork>; });
  controller.start();
  controller.warmForIntent();
  helpers[0]!.emit("error", new Error("spawn ENOENT"));
  ownerIndexHandle();
  expect(memoryIndexReaderState()).not.toBe("blocked");
  expect(controller.status().running).toBe(false);
  expect(controller.error).toBeNull();
  for (let i = 0; i < 50; i++) controller.warmForIntent();
  expect(helpers).toHaveLength(1);
});

it("a warm helper that real work came to need does report its failure", async () => {
  setMemoryMode("active");
  const helpers: Helper[] = [];
  vi.mocked(fork).mockImplementation(() => { const helper = new Helper(); helpers.push(helper); return helper as unknown as ReturnType<typeof fork>; });
  controller.start();
  controller.warmForIntent();
  vi.mocked(hasClaimableMemoryJob).mockReturnValue(true);
  controller.wake();
  await vi.advanceTimersByTimeAsync(1_000);
  helpers[0]!.emit("exit", 1);
  expect(controller.error).toBe("MEMORY_WORKER_START_FAILED");
});

it("a search waiting on a warm helper that dies does report the failure: it is no longer only a warm", async () => {
  setMemoryMode("active");
  const helpers: Helper[] = [];
  vi.mocked(fork).mockImplementation(() => { const helper = new Helper(); helpers.push(helper); return helper as unknown as ReturnType<typeof fork>; });
  controller.start();
  controller.warmForIntent();
  const answer = controller.search({ query: "x" } as Parameters<MemoryWorkerController["search"]>[0], new AbortController().signal).catch((error: Error) => error.message);
  helpers[0]!.emit("exit", 1);
  expect(await answer).toBe("MEMORY_WORKER_EXITED");
  expect(controller.error).toBe("MEMORY_WORKER_START_FAILED");
  expect(helpers).toHaveLength(1);
});
