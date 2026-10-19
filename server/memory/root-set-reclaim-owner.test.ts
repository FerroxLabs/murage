// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RC3 follow-up (P2-1, P2-4): the sliced hand-back runs beside the owner (no idle wait); only the one VACUUM waits for the owner to be away,
// the button path included, so an owner send never meets the rewrite.
import { mkdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";

const { DATA_DIR } = await import("../config.ts");
const { closeDatabase, database } = await import("../database.ts");
const { lineageBackfillSlice, lineageCertProgress, resetLineageBackfillForTest, setLineageSeedCommitForTest } = await import("./lineage-backfill.ts");
const { buildLegacyHistory, markUpgraded } = await import("./testing/legacy-history-fixture.ts");
const { reclaimRootSetsWhenIdle, reclaimVacuumWaiting, ROOT_SET_RECLAIM_TABLES, setReadTimeJudgeRetired } = await import("./root-set-reclaim.ts");

let seeds = 0;
setLineageSeedCommitForTest(() => ++seeds);
beforeEach(() => { closeDatabase(); resetLineageBackfillForTest(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); seeds = 0; });
afterEach(() => { setReadTimeJudgeRetired(false); });
const gate = (ownerIdleMs: number) => ({ ownerIdleMs: () => ownerIdleMs, liveTurn: () => false, typingHeld: () => false, routineDueWithin: () => false, healthAnswered: () => true, integrityPending: () => false, revocationWaiting: () => false });
const tablesLeft = (db: DatabaseSync) => ROOT_SET_RECLAIM_TABLES.filter(name => db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name)).length;

function certified(): DatabaseSync {
  const db = database();
  buildLegacyHistory(db, { seed: 61, threads: 4, lines: 40 });
  markUpgraded(db);
  let t = 0, guard = 0;
  while (lineageCertProgress(db).phase !== "u1m" && lineageBackfillSlice(db, { budgetMs: 2, now: () => (t += 1) }).more) if (++guard > 100_000) throw new Error("no end");
  setReadTimeJudgeRetired(true);
  return db;
}

describe("the hand-back beside an owner who is at the Mac", () => {
  it("a live turn still stops the sliced steps", async () => {
    const db = certified();
    expect(await reclaimRootSetsWhenIdle(db, { ...gate(60 * 60_000), liveTurn: () => true }, { freeDiskBytes: () => null })).toBe("waiting");
    expect(tablesLeft(db)).toBe(ROOT_SET_RECLAIM_TABLES.length);
    expect(reclaimVacuumWaiting()).toBe(false);
  }, 120_000);
});
