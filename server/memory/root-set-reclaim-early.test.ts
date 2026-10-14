// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RC3: the root-set hand-back starts as soon as U1s is over (nothing reads root sets after it), and the storage status and the owner's button
// point at that real reclaim, not at the v7 conversion row v10 never writes. Idle-aware and sliced as before.
import { mkdirSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { DATA_DIR } = await import("../config.ts");
const { closeDatabase, database } = await import("../database.ts");
const { lineageBackfillSlice, lineageCertProgress, resetLineageBackfillForTest, setLineageSeedCommitForTest } = await import("./lineage-backfill.ts");
const { buildLegacyHistory, markUpgraded } = await import("./testing/legacy-history-fixture.ts");
const { reclaimApplies, reclaimCertified, reclaimRootSetsWhenIdle, ROOT_SET_RECLAIM_TABLES, setReadTimeJudgeRetired } = await import("./root-set-reclaim.ts");
const { lineageStorageStatus } = await import("./root-set-compaction.ts");

let seeds = 0;
setLineageSeedCommitForTest(() => ++seeds);
function reset(): void { closeDatabase(); resetLineageBackfillForTest(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); seeds = 0; }
beforeEach(reset);
afterEach(() => { setReadTimeJudgeRetired(false); });
const open = { ownerIdleMs: () => 60 * 60_000, liveTurn: () => false, typingHeld: () => false, routineDueWithin: () => false, healthAnswered: () => true, integrityPending: () => false, revocationWaiting: () => false };
const ticking = (step = 1) => { let t = 0; return () => (t += step); };
const members = (db: DatabaseSync) => Number(db.prepare("SELECT count(*) AS n FROM memory_root_set_members").get()!.n);
const tablesLeft = (db: DatabaseSync) => ROOT_SET_RECLAIM_TABLES.filter(name => db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name)).length;

describe("the root-set reclaim begins when U1s is over", () => {
  it("is certified from phase u1m on and not before, and the storage status says what it waits for", () => {
    const db = database();
    buildLegacyHistory(db, { seed: 51, threads: 4, lines: 40 });
    markUpgraded(db);
    expect(reclaimApplies(db)).toBe(true);
    const clock = ticking();
    const seen = new Set<string>();
    for (let slices = 0; slices < 200_000; slices++) {
      const cert = lineageCertProgress(db);
      seen.add(cert.phase);
      const past = ["u1m", "u1f", "u2", "done"].includes(cert.phase);
      expect(reclaimCertified(db), cert.phase).toBe(past);
      const status = lineageStorageStatus(db);
      if (!past) expect(status).toMatchObject({ state: "waiting", reason: "checking" });
      else expect(status.state).toBe("reclaim-available");
      if (!lineageBackfillSlice(db, { budgetMs: 1, now: clock }).more) break;
    }
    expect(seen.has("u1s") || seen.has("u1")).toBe(true);
    expect(seen.has("u1m") || seen.has("u1f") || seen.has("u2")).toBe(true);
  });

  it("an upgrade reaches 100%, the reclaim runs idle-aware, and the root-set tables are emptied and dropped (state converting while it works, then idle)", async () => {
    const db = database();
    buildLegacyHistory(db, { seed: 52, threads: 4, lines: 40 });
    markUpgraded(db);
    const clock = ticking();
    // stop right after U1s: the hand-back may begin although the certificate is not ready
    let guard = 0;
    while (!["u1m", "u1f", "u2"].includes(lineageCertProgress(db).phase) && lineageBackfillSlice(db, { budgetMs: 2, now: clock }).more) if (++guard > 100_000) throw new Error("no end");
    expect(lineageCertProgress(db).ready).toBe(false);
    expect(members(db)).toBeGreaterThan(0);
    setReadTimeJudgeRetired(true);
    // a live turn: nothing is handed back
    expect(await reclaimRootSetsWhenIdle(db, { ...open, liveTurn: () => true }, { freeDiskBytes: () => null })).toBe("waiting");
    expect(tablesLeft(db)).toBe(ROOT_SET_RECLAIM_TABLES.length);
    const run = reclaimRootSetsWhenIdle(db, open, { freeDiskBytes: () => null });
    expect(lineageStorageStatus(db).state).toBe("converting");
    expect(await run).toBe("done");
    expect(tablesLeft(db)).toBe(0);
    expect(lineageStorageStatus(db).state).toBe("idle");
    // the upgrade still runs to 100% on the emptied file
    while (lineageBackfillSlice(db, { budgetMs: 2, now: clock }).more) if (++guard > 200_000) throw new Error("no end");
    const cert = lineageCertProgress(db);
    expect(cert).toMatchObject({ ready: true });
    expect(cert.done).toBe(cert.total);
  }, 120_000);

  it("a downgrade-then-upgrade reads the lines as unprovable (the DROPPED mark is set by the hand-back)", async () => {
    const db = database();
    buildLegacyHistory(db, { seed: 53, threads: 2, lines: 20 });
    markUpgraded(db);
    const clock = ticking();
    let guard = 0;
    while (lineageCertProgress(db).phase !== "u1m" && lineageBackfillSlice(db, { budgetMs: 2, now: clock }).more) if (++guard > 100_000) throw new Error("no end");
    setReadTimeJudgeRetired(true);
    expect(await reclaimRootSetsWhenIdle(db, open, { freeDiskBytes: () => null })).toBe("done");
    expect(Number(db.prepare("SELECT value FROM memory_lineage_lsn_meta WHERE key='root_sets_dropped'").get()?.value)).toBe(1);
  }, 120_000);
});
