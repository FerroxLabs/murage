// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 rehearsal 2 (memory worker write storm): the helper's writes are charged to the io-budget under "memory-worker" from the
// count the helper reports (its process's own fsWrite blocks), so a minute in which the index was the heaviest writer defers the
// next index batch like any other source. The parent's earlier reading of the index file and its log missed every write cycle that
// finished between two samples (a merge, then a truncation, leaves the log at zero and the file the same size).
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { BLOCK_BYTES, ioBudget } from "../io-budget.ts";
import { resetParkReconcile, resetParkSweep } from "./park.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

type Internals = { child: unknown; ready: boolean; onWorkerMessage(child: unknown, message: unknown): void; registerWorkerBytes(): void };
let controller: MemoryWorkerController, internals: Internals;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
/** What the budget holds for the helper in this window: sampling the source moves its growth into the window's bytes. */
const charged = () => { ioBudget.sampleByteSource("memory-worker"); return ioBudget.pendingBytes("memory-worker"); };
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); resetParkSweep(); resetParkReconcile();
  controller = new MemoryWorkerController();
  internals = controller as unknown as Internals;
  internals.child = { kill() {}, on() {}, send() {} };
  internals.ready = true;
  internals.registerWorkerBytes();
});
afterEach(async () => { await controller.stop().catch(() => {}); });

it("the helper's reported write count is charged to the budget under memory-worker, as bytes, by its growth", async () => {
  const before = charged();
  internals.onWorkerMessage(internals.child, { type: "index-result", requestId: "none", records: [], embeddingStatus: "indexed", fsWriteBlocks: 2048 });
  await settle();
  expect(charged() - before).toBe(2048 * BLOCK_BYTES);
  internals.onWorkerMessage(internals.child, { type: "io", fsWriteBlocks: 2048 + 512 });
  expect(charged() - before).toBe((2048 + 512) * BLOCK_BYTES);
  // a repeated or older count charges nothing twice
  internals.onWorkerMessage(internals.child, { type: "io", fsWriteBlocks: 2048 + 512 });
  expect(charged() - before).toBe((2048 + 512) * BLOCK_BYTES);
});

it("a helper that starts again counts from zero: its first report is charged whole, nothing before it is lost", async () => {
  const before = charged();
  internals.onWorkerMessage(internals.child, { type: "io", fsWriteBlocks: 1000 });
  expect(charged() - before).toBe(1000 * BLOCK_BYTES);
  // the next helper's counter is below the last one's: a fresh process, whose writes are all new
  internals.onWorkerMessage(internals.child, { type: "io", fsWriteBlocks: 40 });
  expect(charged() - before).toBe(1040 * BLOCK_BYTES);
  internals.onWorkerMessage(internals.child, { type: "io", fsWriteBlocks: 50 });
  expect(charged() - before).toBe(1050 * BLOCK_BYTES);
  // a new helper whose first count is at or above the last one's is still charged whole: the baseline is the reporting process's own
  const next = { kill() {}, on() {}, send() {} };
  internals.child = next;
  internals.onWorkerMessage(next, { type: "io", fsWriteBlocks: 50 });
  expect(charged() - before).toBe(1100 * BLOCK_BYTES);
  internals.onWorkerMessage(next, { type: "io", fsWriteBlocks: 60 });
  expect(charged() - before).toBe(1110 * BLOCK_BYTES);
});

it("a report that is not a finite count is ignored", async () => {
  const before = charged();
  internals.onWorkerMessage(internals.child, { type: "io", fsWriteBlocks: "many" });
  internals.onWorkerMessage(internals.child, { type: "io", fsWriteBlocks: Number.NaN });
  internals.onWorkerMessage(internals.child, { type: "io" });
  expect(charged() - before).toBe(0);
});
