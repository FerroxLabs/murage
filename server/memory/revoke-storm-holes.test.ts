// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 revoke storm, build review (Astra, astra-revoke-storm-build): the four ways the M3 write budget could lose or stall a revocation.
// 1. No revoke advances while a receipt flip waits: the flip has left memory_disclosure_refs and its consumer edges come only with its drain.
// 2. A flip whose commit is larger than the room left in the minute is woken when the minute has room; one larger than a whole minute
//    hangs on the wildcard pair instead of each item it cites (withholds more, never less), so no minute runs over budget.
// 3. A receipt's commit cost counts its consumer edges and the intern rows they take, so admission never undercounts.
// 4. An owner's inline walk runs under the same budget and deadline, moves only its own revoke and never drains the queued flips.
import { afterEach, describe, expect, it } from "vitest";
import { commitRevoke } from "./revoke-commit.ts";
import { headFlipCost, markerSlice } from "./revoke-marker.ts";
import { refsLookup } from "./deny-read.ts";
import { drainRevokeMarkerBounded, memoryRevocationIdle, memoryRevocationStats, resetMemoryRevocationStats, stopMemoryRevocation, wakeMemoryRevocation } from "./memory-revocation.ts";
import { bytesPerChange, noteRevokeBytes, REVOKE_WRITE_BUDGET, resetRevokeWriteBudget, revokeBytesWritten, setRevokeBudgetClock } from "./revoke-budget.ts";
import { OBJECT_EDGE_LSN, type MemoryRef } from "./lineage-types.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";
import { changes, flipAll, num, storm, THREADS } from "./testing/revoke-storm-fixture.ts";

afterEach(() => { setRevokeBudgetClock(); resetRevokeWriteBudget(); REVOKE_WRITE_BUDGET.bytesPerMinute = 20 * 1024 * 1024; stopMemoryRevocation(); resetMemoryRevocationStats(); });

const slice = (fx: WritetimeFixture, run: () => unknown) => { fx.db.exec("BEGIN IMMEDIATE"); try { return run(); } finally { fx.db.exec("COMMIT"); } };
const drainAll = (fx: WritetimeFixture) => { for (let n = 0; n < 100_000; n++) if (!slice(fx, () => markerSlice(fx.db, 256, 8))) return; throw new Error("unbounded"); };
const flips = (fx: WritetimeFixture) => num(fx, "SELECT count(*) AS n FROM memory_receipt_flips");
/** A revoke's state; a finished one may already be pruned ("done" either way). */
const jobState = (fx: WritetimeFixture, R: number) => String((fx.db.prepare("SELECT state FROM memory_revoke_jobs WHERE revoke_id=?").get(R) as { state?: string } | undefined)?.state ?? "done");
/** Receipt `bundle` cites `first` (when given) and `n` other records none of which was ever interned (the v8 triggers index them). */
function cite(fx: WritetimeFixture, bundle: string, n: number, first?: MemoryRef): void {
  const list = [...(first ? [{ id: first.id, version: first.version }] : []), ...Array.from({ length: n }, (_, i) => ({ id: `${bundle}-cited-${i}`, version: 1 }))];
  fx.db.prepare("UPDATE memory_disclosures SET record_versions=? WHERE bundle_id=?").run(JSON.stringify(list), bundle);
}

describe("revoke storm build review: no revocation is lost or stalled by the write budget", () => {
  it("1: no revoke advances while a flip waits, so a content forget pending before the flip still withholds the receipt's outputs", () => {
    const fx = storm(1);
    try {
      const X: MemoryRef = { kind: "record", id: "rec-x", version: 1 };
      fx.record(X.id, 1, "s-room");
      cite(fx, "b0", 600, X);
      const F = slice(fx, () => commitRevoke(fx.db, { kind: "memory", ref: X, cause: "forget" }, { inline: false })) as number;
      flipAll(fx);
      // slices whose cap cannot hold the flip's commit: nothing moves, the forget included
      for (let n = 0; n < 200; n++) slice(fx, () => markerSlice(fx.db, 256, Number.POSITIVE_INFINITY, null, 40));
      expect(flips(fx)).toBe(1);
      expect(jobState(fx, F)).toBe("active");
      drainAll(fx);
      expect(jobState(fx, F)).toBe("done");
      expect(refsLookup(fx.db, [{ kind: "line", threadId: THREADS[0]!, messageId: "r0" }], CONTENT).state).toBe("withheld");
    } finally { fx.close(); }
  });

  it("2: a flip larger than the room left in the minute wakes the runner once the minute has room; no other wake", async () => {
    const fx = storm(1);
    try {
      cite(fx, "b0", 1500);
      const page = bytesPerChange(fx.db);
      REVOKE_WRITE_BUDGET.bytesPerMinute = 10240 * page;
      flipAll(fx);
      // most of the minute is spent, and that spend leaves the window in 300 ms
      noteRevokeBytes(9000 * page, Date.now() - 59_700);
      wakeMemoryRevocation(() => fx.db, { pauseMs: 1 });
      await Promise.race([memoryRevocationIdle(), new Promise(resolve => setTimeout(resolve, 10_000))]);
      expect(flips(fx)).toBe(0);
      expect(memoryRevocationStats.budgetWaits).toBeGreaterThan(0);
      expect(num(fx, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('active','seeding')")).toBe(0);
    } finally { stopMemoryRevocation(); fx.close(); }
  });

  it("2: a receipt costlier than a whole minute hangs on the wildcard pair: no minute runs over budget, and a forget of what it cites still withholds it", () => {
    const fx = storm(1);
    let now = 5_000_000;
    setRevokeBudgetClock(() => now);
    resetRevokeWriteBudget();
    try {
      const X: MemoryRef = { kind: "record", id: "rec-x", version: 1 };
      fx.record(X.id, 1, "s-room");
      cite(fx, "b0", 1500, X);
      const page = bytesPerChange(fx.db);
      REVOKE_WRITE_BUDGET.bytesPerMinute = 1400 * page;
      flipAll(fx);
      // its per-item commit (1,501 edges) is larger than the whole minute: it is admitted at the wildcard pair's cost
      expect(headFlipCost(fx.db)).toBeLessThan(64);
      const edges = num(fx, "SELECT count(*) AS n FROM memory_lineage_carry WHERE to_lsn=?", OBJECT_EDGE_LSN);
      for (let minutes = 0; drainRevokeMarkerBounded(fx.db, { rows: 1_000_000, ms: 1_000_000 }); minutes++) {
        expect(revokeBytesWritten()).toBeLessThanOrEqual(REVOKE_WRITE_BUDGET.bytesPerMinute);
        expect(minutes).toBeLessThan(60); now += 61_000;
      }
      expect(revokeBytesWritten()).toBeLessThanOrEqual(REVOKE_WRITE_BUDGET.bytesPerMinute);
      expect(flips(fx)).toBe(0);
      expect(num(fx, "SELECT count(*) AS n FROM memory_lineage_carry WHERE to_lsn=?", OBJECT_EDGE_LSN) - edges).toBe(2);
      const F = slice(fx, () => commitRevoke(fx.db, { kind: "memory", ref: X, cause: "forget" }, { inline: false })) as number;
      for (let minutes = 0; drainRevokeMarkerBounded(fx.db, { rows: 1_000_000, ms: 1_000_000 }); minutes++) {
        expect(revokeBytesWritten()).toBeLessThanOrEqual(REVOKE_WRITE_BUDGET.bytesPerMinute);
        expect(minutes).toBeLessThan(60); now += 61_000;
      }
      expect(jobState(fx, F)).toBe("done");
      expect(refsLookup(fx.db, [{ kind: "line", threadId: THREADS[0]!, messageId: "r0" }], CONTENT).state).toBe("withheld");
    } finally { fx.close(); }
  });

  it("2: a receipt whose commit fits a whole minute still hangs on each item it cites", () => {
    const fx = storm(1);
    let now = 6_000_000;
    setRevokeBudgetClock(() => now);
    resetRevokeWriteBudget();
    try {
      cite(fx, "b0", 300);
      const page = bytesPerChange(fx.db);
      REVOKE_WRITE_BUDGET.bytesPerMinute = 1400 * page;
      flipAll(fx);
      const edges = num(fx, "SELECT count(*) AS n FROM memory_lineage_carry WHERE to_lsn=?", OBJECT_EDGE_LSN);
      for (let minutes = 0; drainRevokeMarkerBounded(fx.db, { rows: 1_000_000, ms: 1_000_000 }); minutes++) {
        expect(revokeBytesWritten()).toBeLessThanOrEqual(REVOKE_WRITE_BUDGET.bytesPerMinute);
        expect(minutes).toBeLessThan(60); now += 61_000;
      }
      expect(flips(fx)).toBe(0);
      expect(num(fx, "SELECT count(*) AS n FROM memory_lineage_carry WHERE to_lsn=?", OBJECT_EDGE_LSN) - edges).toBe(300);
    } finally { fx.close(); }
  });

  it("3: a receipt's commit cost counts its edges and intern rows, never fewer than it writes, and admission keeps the minute in budget", () => {
    const fx = storm(1);
    let now = 7_000_000;
    setRevokeBudgetClock(() => now);
    resetRevokeWriteBudget();
    try {
      cite(fx, "b0", 1500);
      const page = bytesPerChange(fx.db);
      REVOKE_WRITE_BUDGET.bytesPerMinute = 8000 * page;
      flipAll(fx);
      noteRevokeBytes(4000 * page);
      // 4,000 pages left hold 1,984 rows at the headroom: 1,500 edges fit, 1,500 edges and 1,500 intern rows do not
      drainRevokeMarkerBounded(fx.db, { rows: 1_000_000, ms: 1_000_000 });
      expect(flips(fx)).toBe(1);
      expect(revokeBytesWritten()).toBeLessThanOrEqual(REVOKE_WRITE_BUDGET.bytesPerMinute);
      now += 61_000;
      drainRevokeMarkerBounded(fx.db, { rows: 1_000_000, ms: 1_000_000 });
      expect(flips(fx)).toBe(0);
      expect(revokeBytesWritten()).toBeLessThanOrEqual(REVOKE_WRITE_BUDGET.bytesPerMinute);
    } finally { fx.close(); }
    for (const n of [0, 3, 1500]) {
      const fx = storm(1);
      setRevokeBudgetClock(); resetRevokeWriteBudget();
      try {
        cite(fx, "b0", n);
        flipAll(fx);
        const estimate = headFlipCost(fx.db), before = changes(fx);
        slice(fx, () => markerSlice(fx.db, 256, Number.POSITIVE_INFINITY));
        const wrote = changes(fx) - before;
        expect(flips(fx)).toBe(0);
        expect(estimate).toBeGreaterThanOrEqual(wrote);
        expect(estimate - wrote).toBeLessThanOrEqual(24);
      } finally { fx.close(); }
    }
  });

  it("4: an owner's inline walk never drains the queued flips and never walks another revoke", () => {
    const fx = storm(2);
    try {
      const X: MemoryRef = { kind: "record", id: "rec-x", version: 1 };
      fx.record(X.id, 1, "s-room");
      const older = slice(fx, () => commitRevoke(fx.db, { kind: "memory", ref: X, cause: "forget" }, { inline: false })) as number;
      const cursor = () => String((fx.db.prepare("SELECT phase||':'||cursor AS c FROM memory_revoke_jobs WHERE revoke_id=?").get(older) as { c: string }).c);
      const held = cursor();
      fx.db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id='b0'").run();
      expect(flips(fx)).toBe(1);
      slice(fx, () => commitRevoke(fx.db, { kind: "line", threadId: THREADS[1]!, messageIds: ["r1"], cause: "forget" }));
      expect(flips(fx)).toBe(1);
      expect(jobState(fx, older)).toBe("active");
      expect(cursor()).toBe(held);
      drainAll(fx);
      expect(flips(fx)).toBe(0);
      expect(jobState(fx, older)).toBe("done");
    } finally { fx.close(); }
  });

  it("4: an owner's inline walk stays inside the write budget: a spent minute leaves it to the runner", () => {
    const fx = storm(1);
    let now = 9_000_000;
    setRevokeBudgetClock(() => now);
    resetRevokeWriteBudget();
    try {
      const page = bytesPerChange(fx.db);
      REVOKE_WRITE_BUDGET.bytesPerMinute = 1400 * page;
      noteRevokeBytes(1400 * page);
      const R = slice(fx, () => commitRevoke(fx.db, { kind: "line", threadId: THREADS[0]!, messageIds: ["r0"], cause: "forget" })) as number;
      expect(jobState(fx, R)).toBe("active");
      expect(revokeBytesWritten()).toBe(1400 * page);
      now += 61_000;
      for (let minutes = 0; drainRevokeMarkerBounded(fx.db, { rows: 1_000_000, ms: 1_000_000 }); minutes++) { expect(minutes).toBeLessThan(60); now += 61_000; }
      expect(jobState(fx, R)).toBe("done");
    } finally { fx.close(); }
  });
});
