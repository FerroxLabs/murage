// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW controller side (spec 1.8 R2-R4, 1.11, 1.13, r3.2.2 D1): a helper's stop becomes a reset-exit sent once per helper and reset id; while
// it waits or runs no batch is formed and Settings says the checking note (never an error); reset_done = R completes it; a batch answered
// segment-gate holds until gate-clear, merge-floor until the next helper start or an hour; the drain closes every read until the helper
// lifts it; a checkpoint charge is acked in the same handler turn, refused for the first 60 s after a controller start.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { indexWriterDrainOn, lexicalPage, ownerIndexHandle, setIndexWriterDrain, vectorlessAmong, memoryIndexReaderOpens } from "./index-reader.ts";
import { setMemoryMode } from "./repository.ts";
import { CHARGE_START_HOLD_MS, INDEX_MERGE_FLOOR_REASK_MS, MemoryWorkerController } from "./worker-controller.ts";

type Internals = { startReset: { child: unknown; resetId: number } | null; child: unknown; ready: boolean; onWorkerMessage(child: unknown, message: unknown): void; settleOverrun(child: unknown): boolean; status(): { indexNote?: string; error: string | null }; workerBytes: number; indexRequestId: string | null };
let controller: MemoryWorkerController, internals: Internals, sent: Array<Record<string, unknown>>;
const fakeChild = () => ({ kill() {}, on() {}, send: (m: Record<string, unknown>) => { sent.push(m); return true; } });
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture");
  vi.useFakeTimers({ toFake: ["Date", "performance"] }); vi.setSystemTime(new Date("2026-11-08T00:00:00Z"));
  sent = [];
  controller = new MemoryWorkerController();
  internals = controller as unknown as Internals;
  internals.child = fakeChild(); internals.ready = true;
});
afterEach(async () => { setIndexWriterDrain(false); await controller.stop().catch(() => {}); vi.useRealTimers(); closeDatabase(); });


it("T2(15) controller side: segment-gate holds until gate-clear; merge-floor shows the scale note and is asked again at a helper start or after an hour", () => {
  internals.indexRequestId = "r1";
  internals.onWorkerMessage(internals.child, { type: "index-result", requestId: "r1", failed: "segment-gate", committed: 0, records: [], embeddingStatus: "indexed" });
  expect(internals.settleOverrun(internals.child)).toBe(true);
  internals.onWorkerMessage(internals.child, { type: "gate-clear" });
  expect(internals.settleOverrun(internals.child)).toBe(false);
  internals.indexRequestId = "r2";
  internals.onWorkerMessage(internals.child, { type: "index-result", requestId: "r2", failed: "merge-floor", committed: 0, records: [], embeddingStatus: "indexed" });
  expect(internals.settleOverrun(internals.child)).toBe(true);
  expect(internals.status().indexNote).toBe("MEMORY_INDEX_SCALE_FREEZE");
  expect(internals.status().error).toBeNull();
  vi.advanceTimersByTime(INDEX_MERGE_FLOOR_REASK_MS);
  expect(internals.settleOverrun(internals.child)).toBe(false);
  internals.indexRequestId = "r3";
  internals.onWorkerMessage(internals.child, { type: "index-result", requestId: "r3", failed: "merge-floor", committed: 0, records: [], embeddingStatus: "indexed" });
  internals.onWorkerMessage(internals.child, { type: "initialised", reset: false, resetDone: null, walOverStop: null, gateClear: false, fileId: "a1", wasm: false, scrubOwed: false });
  expect(internals.settleOverrun(internals.child)).toBe(false);
});

it("T2(2) the drain: no read reaches the index while it is on (0 scans, 0 handle opens), DRAIN_MAX_MS never lifts it, the helper's exit does; acked at once", async () => {
  const opens = memoryIndexReaderOpens();
  internals.onWorkerMessage(internals.child, { type: "wal-drain", on: true });
  expect(sent.at(-1)).toEqual({ type: "wal-drain-ack" });
  expect(indexWriterDrainOn()).toBe(true);
  vi.advanceTimersByTime(60_000);
  expect(ownerIndexHandle()).toBeNull();
  expect(lexicalPage("smoke round", ["s"], 10)).toBeNull();
  expect(vectorlessAmong([{ id: "x", version: 1 }], "m")).toBeNull();
  expect(memoryIndexReaderOpens()).toBe(opens);
  internals.onWorkerMessage(internals.child, { type: "wal-drain", on: false });
  expect(indexWriterDrainOn()).toBe(false);
});

it("r3.2.2 D1: a charge is acked in the handler turn; refused (nothing charged) for the first 60 s, then granted and charged", () => {
  internals.onWorkerMessage(internals.child, { type: "charge", fileId: "a1", attempt: 1, bytes: 4096, helperRunId: "r1" });
  expect(sent.at(-1)).toEqual({ type: "charge-ack", fileId: "a1", attempt: 1, granted: false, helperRunId: "r1" });
  expect(internals.workerBytes).toBe(0);
  vi.advanceTimersByTime(CHARGE_START_HOLD_MS);
  internals.onWorkerMessage(internals.child, { type: "charge", fileId: "a1", attempt: 2, bytes: 4096, helperRunId: "r1" });
  expect(sent.at(-1)).toEqual({ type: "charge-ack", fileId: "a1", attempt: 2, granted: true, helperRunId: "r1" });
  expect(internals.workerBytes).toBe(4096);
  // an unusable charge is refused, never charged
  internals.onWorkerMessage(internals.child, { type: "charge", fileId: "a1", attempt: 3, bytes: -1, helperRunId: "r1" });
  expect(sent.at(-1)).toMatchObject({ attempt: 3, granted: false });
  expect(internals.workerBytes).toBe(4096);
});

it("owner 20:25Z: a batch answered age-blocked is held like segment-gate (no batch formed) until gate-clear, and starts no wal-drain", () => {
  internals.indexRequestId = "b-age";
  internals.onWorkerMessage(internals.child, { type: "index-result", requestId: "b-age", failed: "age-blocked", committed: 0, records: [] });
  expect(internals.settleOverrun(internals.child)).toBe(true);
  expect(indexWriterDrainOn()).toBe(false);
  expect(sent.some(m => m.type === "wal-drain-ack")).toBe(false);
  internals.onWorkerMessage(internals.child, { type: "gate-clear" });
  expect(internals.settleOverrun(internals.child)).toBe(false);
});
