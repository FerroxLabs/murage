// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ioBudget } from "../io-budget.ts";
import { ownerFirst } from "../owner-first.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";

type Sweep = { independentWork(startup?: boolean): void; maintenanceTask: Promise<void> | null };
let controller: MemoryWorkerController;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
  setMemoryMode("capture");
  database().exec("CREATE TABLE maintenance_io_fixture (payload TEXT)");
  vi.spyOn(ownerFirst, "admit").mockReturnValue({ admitted: true, forced: false });
  ioBudget.start();
});
afterEach(async () => {
  await controller?.stop(); ioBudget.stop(); closeDatabase();
  vi.restoreAllMocks(); vi.useRealTimers();
});

it("periodic maintenance waits for shared writing debt, while startup recovery still runs", async () => {
  const maintenance = vi.fn(async () => {});
  controller = new MemoryWorkerController({ onMaintenance: maintenance });
  const sweep = controller as unknown as Sweep;
  ioBudget.noteBytes("record-keys-backfill", 2 * 1024 * 1024);
  sweep.independentWork(); await sweep.maintenanceTask;
  expect(maintenance).not.toHaveBeenCalled();
  sweep.independentWork(true); await sweep.maintenanceTask;
  expect(maintenance).toHaveBeenCalledExactlyOnceWith(true, expect.any(AbortSignal));
});

it("maintenance writes after an await are charged before another periodic writer is admitted", async () => {
  const sources: Array<string | undefined> = [];
  controller = new MemoryWorkerController({ onMaintenance: async () => {
    await Promise.resolve(); sources.push(ioBudget.currentSource());
    database().prepare("INSERT INTO maintenance_io_fixture VALUES(?)").run("x".repeat(64 * 1024));
  } });
  const sweep = controller as unknown as Sweep;
  sweep.independentWork(); await sweep.maintenanceTask;
  expect(sources).toEqual(["memory-idle"]);
  expect(ioBudget.pendingBytes("memory-idle")).toBeGreaterThan(64 * 1024);
  expect(ioBudget.shouldDefer("search-index")).toBe(true);
});
