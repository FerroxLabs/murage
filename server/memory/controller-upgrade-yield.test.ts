// SPDX-License-Identifier: AGPL-3.0-or-later
// rc13 real-data run (cand/rc13 9b2d0469c): with the Mac quiet enough that the owner-first load gate admitted it, the idle memory work ran
// beside the history upgrade, and its reads, slowed by the upgrade's own I/O, were 25 of the run's 44 stalls over 250 ms (memory-idle) plus a
// 1032 ms unattributed one (the continuity pass). While the upgrade runs, the idle lanes (consolidation, continuity, lineage warming, the
// status figures) wait; maintenance (the reclaim the upgrade ends with) does not. They come back within UPGRADE_RECHECK_MS of its end, and
// an upgrade that never ends holds them for at most UPGRADE_YIELD_MAX_MS.
import { fork } from "node:child_process";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ioBudget } from "../io-budget.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController, UPGRADE_RECHECK_MS, UPGRADE_YIELD_MAX_MS } from "./worker-controller.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const scans = vi.hoisted(() => ({ health: 0, retention: 0 }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), fork: vi.fn() }));
vi.mock("./health.ts", async importOriginal => ({ ...await importOriginal<typeof import("./health.ts")>(), stepHealthScan: () => { scans.health++; return false; } }));
vi.mock("./retention.ts", async importOriginal => ({ ...await importOriginal<typeof import("./retention.ts")>(), stepRetentionScan: () => { scans.retention++; return false; } }));

let controller: MemoryWorkerController;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-16T00:00:00Z"));
  setMemoryMode("capture"); database();
  scans.health = 0; scans.retention = 0;
  vi.mocked(fork).mockImplementation(() => { throw new Error("no helper is spawned in these tests"); });
});
afterEach(async () => { await controller.stop().catch(() => {}); closeDatabase(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

function lanes(upgrade: { running: boolean }) {
  const sources: Array<string | undefined> = [];
  const idle = vi.fn(async () => false), warm = vi.fn(() => false), maintenance = vi.fn(async () => undefined);
  const continuity = vi.fn(async () => { sources.push(ioBudget.currentSource()); });
  controller = new MemoryWorkerController({ onIdleConsolidation: idle, onLineageWarm: warm, onMaintenance: maintenance, onContinuity: continuity,
    continuityEligible: () => true, upgradeRunning: () => upgrade.running });
  (controller as unknown as { child: unknown }).child = { kill() {}, on() {}, send() { return true; } };
  return { idle, warm, maintenance, continuity, sources };
}

it("while the upgrade runs no idle lane starts; maintenance still does; all of them start within UPGRADE_RECHECK_MS of its end", async () => {
  const upgrade = { running: true };
  const { idle, warm, maintenance, continuity, sources } = lanes(upgrade);
  controller.start();
  controller.wakeLineageWarm(0);
  controller.wake();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(idle).not.toHaveBeenCalled();
  expect(warm).not.toHaveBeenCalled();
  expect(continuity).not.toHaveBeenCalled();
  expect(scans.health + scans.retention).toBe(0);
  expect(maintenance).toHaveBeenCalled();

  upgrade.running = false;
  controller.wake();
  await vi.advanceTimersByTimeAsync(UPGRADE_RECHECK_MS + 1_000);
  expect(idle).toHaveBeenCalled();
  expect(warm).toHaveBeenCalled();
  expect(scans.health).toBeGreaterThan(0);
  // the continuity pass comes with the next sweep, under its own source (no statement of it is unattributed)
  await vi.advanceTimersByTimeAsync(31_000);
  expect(continuity).toHaveBeenCalled();
  expect(sources[0]).toBe("memory-continuity");
});

it("an upgrade that never ends holds the idle lanes for at most UPGRADE_YIELD_MAX_MS", async () => {
  const { idle } = lanes({ running: true });
  const real = performance.now.bind(performance);
  let offset = 0;
  vi.spyOn(performance, "now").mockImplementation(() => real() + offset);
  controller.start();
  controller.wake();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(idle).not.toHaveBeenCalled();
  offset = UPGRADE_YIELD_MAX_MS + 1;
  await vi.advanceTimersByTimeAsync(UPGRADE_RECHECK_MS + 1_000);
  expect(idle).toHaveBeenCalled();
});
