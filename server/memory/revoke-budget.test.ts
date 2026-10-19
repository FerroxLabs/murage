// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 revoke storm, M3 (REVOKE-STORM-DESIGN-M, agreed): the marker walks in bounded slices under a hard write budget per minute, every
// write counted, and yields to foreground turns. Total work is unchanged; it no longer hogs the Mac.
import { afterEach, describe, expect, it } from "vitest";
import { memoryRevocationIdle, memoryRevocationStats, resetMemoryRevocationStats, drainRevokeMarkerBounded, stopMemoryRevocation, wakeMemoryRevocation } from "./memory-revocation.ts";
import { bytesPerChange, REVOKE_WRITE_BUDGET, resetRevokeWriteBudget, revokeBytesWritten, setRevokeBudgetClock } from "./revoke-budget.ts";
import { changes, flipAll, num, storm } from "./testing/revoke-storm-fixture.ts";

afterEach(() => { setRevokeBudgetClock(); resetRevokeWriteBudget(); REVOKE_WRITE_BUDGET.bytesPerMinute = 20 * 1024 * 1024; stopMemoryRevocation(); resetMemoryRevocationStats(); });

describe("M3: the marker stays inside its write budget and yields to foreground turns", () => {
  it("never writes more than the budget in a minute; the rest waits for the next minute and finishes", () => {
    const fx = storm(122);
    let now = 1_000_000;
    setRevokeBudgetClock(() => now);
    resetRevokeWriteBudget();
    const page = bytesPerChange(fx.db);
    REVOKE_WRITE_BUDGET.bytesPerMinute = 900 * page;
    try {
      flipAll(fx);
      let minutes = 0, pending = true;
      while (pending) {
        expect(minutes).toBeLessThan(60);
        const before = changes(fx);
        // the send fence, a refused turn's settle and the upgrade all drain through this, as often as they like within the minute
        for (let n = 0; n < 50 && pending; n++) pending = drainRevokeMarkerBounded(fx.db, { rows: 1_000_000, ms: 1_000_000 });
        const written = (changes(fx) - before) * page;
        expect(written).toBeLessThanOrEqual(REVOKE_WRITE_BUDGET.bytesPerMinute);
        expect(revokeBytesWritten()).toBeLessThanOrEqual(REVOKE_WRITE_BUDGET.bytesPerMinute);
        minutes++;
        now += 61_000;
      }
      // the storm needed more than one minute's budget, and every write of it was charged
      expect(minutes).toBeGreaterThan(1);
      expect(num(fx, "SELECT count(*) AS n FROM memory_receipt_flips")).toBe(0);
      expect(num(fx, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('active','seeding')")).toBe(0);
      expect(num(fx, "SELECT count(*) AS n FROM (SELECT DISTINCT thread_id,driver_instance,native_session FROM memory_deny_session)")).toBe(122);
    } finally { fx.close(); }
  });

  it("the runner walks nothing while a foreground turn is live, then finishes once it ends", async () => {
    const fx = storm(8);
    let busy = true;
    try {
      flipAll(fx);
      wakeMemoryRevocation(() => fx.db, { busy: () => busy, busyPauseMs: 5, pauseMs: 1 });
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(num(fx, "SELECT count(*) AS n FROM memory_receipt_flips")).toBe(8);
      expect(num(fx, "SELECT count(*) AS n FROM memory_revoke_jobs")).toBe(0);
      expect(memoryRevocationStats.markerYields).toBeGreaterThan(0);
      busy = false;
      await memoryRevocationIdle();
      expect(num(fx, "SELECT count(*) AS n FROM memory_receipt_flips")).toBe(0);
      expect(num(fx, "SELECT count(*) AS n FROM memory_deny_session")).toBe(8);
    } finally { stopMemoryRevocation(); fx.close(); }
  });
});

