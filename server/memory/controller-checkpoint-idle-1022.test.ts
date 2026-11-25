// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1022-idlerest W-CHECKPOINT-MARKER-IDLE (HIDDEN-COST-fable H7, worker-controller.ts:1396): a checkpoint-pending marker no pass can roll (a
// refused marker on a dormant thread) kept the capture controller ticking every 500 ms forever, 120 wake-ups a minute with nothing done.
// Unmoved debt now backs off from 500 ms to 30 min; a change in the debt starts again at 500 ms. The real controller, real database.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { ownerFirst } from "../owner-first.ts";
import { resetHealthScan } from "./health.ts";
import { resetRetentionScan } from "./retention.ts";
import { notifyMemoryWork } from "./jobs.ts";
import { stopSearchIndex } from "../message-search-index.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { ensureScope } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import { BgDeferred } from "../bg-admission.ts";

let controller: MemoryWorkerController | undefined;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date", "performance"] });
  vi.setSystemTime(new Date("2026-11-21T00:00:00Z"));
  setMemoryMode("capture");
  resetHealthScan(); resetRetentionScan();
  vi.spyOn(ownerFirst, "admit").mockReturnValue({ admitted: true, forced: false });
});
afterEach(async () => { await controller?.stop(); controller = undefined; closeDatabase(); vi.restoreAllMocks(); vi.useRealTimers(); });
const wakes = () => (controller as unknown as { wakes: number }).wakes;

it("a refused checkpoint marker: ten idle minutes wake the controller at most once a minute; a new marker is looked at again at once", async () => {
  const db = database(); await stopWalMaintenance(); await stopSearchIndex();
  // the marker names a job that does not exist: every pass refuses it, and nothing else will ever move it
  db.prepare("INSERT INTO memory_scope_bindings VALUES('checkpoint-debt:none',?,'system','checkpoint-pending',0,'granted','{}')").run(ensureScope("conversation", "idle-fixture"));
  controller = new MemoryWorkerController({});
  controller.start();
  notifyMemoryWork();
  // the first two minutes are the back-off climbing from 500 ms
  await vi.advanceTimersByTimeAsync(2 * 60_000);
  const perMinute: number[] = [];
  for (let minute = 0; minute < 10; minute++) { const before = wakes(); await vi.advanceTimersByTimeAsync(60_000); perMinute.push(wakes() - before); }
  expect(Math.max(...perMinute), `controller wakes per idle minute: ${JSON.stringify(perMinute)}`).toBeLessThanOrEqual(1);
  // the effect is kept: a second marker (the debt moved) is looked at within a second
  const before = wakes();
  db.prepare("INSERT INTO memory_scope_bindings VALUES('checkpoint-debt:none-2',?,'system','checkpoint-pending',0,'granted','{}')").run(ensureScope("conversation", "idle-fixture"));
  notifyMemoryWork();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(wakes()).toBeGreaterThan(before);
}, 60_000);

// Self-review H3: debt the I/O budget defers is held back, not unmoved. Unfixed, ten minutes of deferral doubled the wait to minutes, so
// the debt sat after the budget freed. Now a deferral keeps the 500 ms retry: the debt is looked at within a second of the budget freeing.
it("W-CHECKPOINT-HELD-BACK: debt the I/O budget defers for ten minutes is looked at again within a second of the budget freeing", async () => {
  const db = database(); await stopWalMaintenance(); await stopSearchIndex();
  db.prepare("INSERT INTO memory_scope_bindings VALUES('checkpoint-debt:none',?,'system','checkpoint-pending',0,'granted','{}')").run(ensureScope("conversation", "idle-fixture"));
  const proto = MemoryWorkerController.prototype as unknown as { refreshCheckpoint: (...args: unknown[]) => unknown };
  const real = proto.refreshCheckpoint;
  let deferred = true, looked = 0;
  vi.spyOn(proto, "refreshCheckpoint").mockImplementation(function (this: unknown, ...args: unknown[]) {
    if (deferred) throw new BgDeferred(500);
    looked++;
    return real.apply(this, args);
  });
  controller = new MemoryWorkerController({});
  controller.start();
  notifyMemoryWork();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  // the budget frees; no notify: only the controller's own retry may look at the debt
  deferred = false;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(looked, "debt looks within a second of the budget freeing").toBeGreaterThan(0);
}, 60_000);
