// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: q1022-revokehealth-opus (worker-controller.ts sliceRetryMs: the lineage-warm and status-scan slices). Consumer owner: the memory
// worker controller's callers (index.ts wakeLineageWarm, status-scan.ts noteStatusAsked).
// 1.0.22 MUST-FIX item 5: a lineage-warm or status-scan slice that threw (a deferred write, a busy file, any failure) was never scheduled
// again: warming and the Memory figures stopped until something else happened to wake them. The real controller; only the steps stand in.
import { fork } from "node:child_process";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BgDeferred } from "../bg-admission.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { setMemoryMode } from "./repository.ts";
import { noteStatusAsked } from "./status-scan.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const scans = vi.hoisted(() => ({ health: 0, fail: 0 as number, error: null as null | (() => Error) }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), fork: vi.fn() }));
vi.mock("./health.ts", async importOriginal => ({ ...await importOriginal<typeof import("./health.ts")>(), stepHealthScan: () => { scans.health++; if (scans.fail-- > 0) throw scans.error!(); return false; } }));
vi.mock("./retention.ts", async importOriginal => ({ ...await importOriginal<typeof import("./retention.ts")>(), stepRetentionScan: () => false }));

let controller: MemoryWorkerController;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-25T00:00:00Z"));
  setMemoryMode("capture"); database();
  scans.health = 0; scans.fail = 0; scans.error = null;
  vi.mocked(fork).mockImplementation(() => { throw new Error("no helper is spawned in these tests"); });
});
afterEach(async () => { await controller.stop().catch(() => {}); closeDatabase(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

// SITES.md rows of item 5: each slice (lineage warm, status scan) x each failure class (deferred, other)
const FAILURES: Array<[string, () => Error, number]> = [["a deferred write", () => new BgDeferred(50, true), 1_000], ["any other failure", () => new Error("fixture failure"), 61_000]];

it.each(FAILURES)("W-WARM-RESCHEDULE a lineage-warm slice that threw (%s) is scheduled again and runs", async (_label, error, wait) => {
  let calls = 0;
  controller = new MemoryWorkerController({ onLineageWarm: () => { if (++calls === 1) throw error(); return false; } });
  controller.start();
  controller.wakeLineageWarm(0);
  await vi.advanceTimersByTimeAsync(20);
  expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(wait);
  // base 68ed0def17: the throw was logged and nothing was scheduled again (calls stays 1)
  expect(calls).toBe(2);
});

it.each(FAILURES)("W-SCAN-RESCHEDULE a status-scan slice that threw (%s) on an owner's ask is scheduled again and measures", async (_label, error, wait) => {
  controller = new MemoryWorkerController({});
  controller.start();
  await vi.advanceTimersByTimeAsync(6_000);
  const before = scans.health;
  scans.fail = 1; scans.error = error;
  noteStatusAsked();
  await vi.advanceTimersByTimeAsync(20);
  expect(scans.health).toBe(before + 1);
  await vi.advanceTimersByTimeAsync(wait);
  // base 68ed0def17: the ask was spent on the slice that threw and the figures were never measured
  expect(scans.health).toBeGreaterThanOrEqual(before + 2);
});
