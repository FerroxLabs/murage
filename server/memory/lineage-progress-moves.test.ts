// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RC7 branch B (RC6-SPEED-DIAG.md section 3): the write-time backfill's certificate progress never goes backwards, and moves inside every sub-phase
// (sessions, memory edges, live fix, each seed step), so the strip is not flat while one heavy step runs.
import { mkdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import type { RevokeRoot } from "./lineage-types.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const mock = { works: true };
const commits: RevokeRoot[] = [];
const { DATA_DIR } = await import("../config.ts");
const { closeDatabase, database } = await import("../database.ts");
const { lineageBackfillSlice, lineageCertProgress, resetLineageBackfillForTest, setLineageSeedCommitForTest } = await import("./lineage-backfill.ts");
setLineageSeedCommitForTest((_tx, root) => { if (!mock.works) return 0; commits.push(root); return commits.length; });
const { buildLegacyHistory, markUpgraded } = await import("./testing/legacy-history-fixture.ts");

async function reset(): Promise<void> { closeDatabase(); await stopWalMaintenance(); resetLineageBackfillForTest(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); commits.length = 0; mock.works = true; }
beforeEach(async () => { await reset(); });
afterEach(() => { mock.works = true; });
const ticking = (step: number) => { let t = 0; return () => (t += step); };

function trace(db: DatabaseSync, clock: () => number): Array<{ phase: string; done: number }> {
  const out: Array<{ phase: string; done: number }> = [];
  for (let guard = 0; guard < 200_000; guard++) {
    const more = lineageBackfillSlice(db, { budgetMs: 5, now: clock }).more;
    const cert = lineageCertProgress(db);
    out.push({ phase: cert.phase, done: cert.done });
    if (!more) return out;
  }
  throw new Error("no end");
}

describe("write-time backfill progress", () => {
  it("never goes backwards, and ends at total", () => {
    const db = database();
    buildLegacyHistory(db, { seed: 11, threads: 4, lines: 60, copies: 0.2 });
    markUpgraded(db);
    const steps = trace(db, ticking(1));
    for (let i = 1; i < steps.length; i++) expect(steps[i]!.done).toBeGreaterThanOrEqual(steps[i - 1]!.done);
    const cert = lineageCertProgress(db);
    expect(cert).toMatchObject({ ready: true });
    expect(cert.done).toBe(cert.total);
  });
  it("moves inside the later phases: most slices of u1m, u1f and u2 change done", () => {
    const db = database();
    buildLegacyHistory(db, { seed: 11, threads: 4, lines: 60, copies: 0.2 });
    markUpgraded(db);
    const steps = trace(db, ticking(1));
    const later = steps.map((step, at) => ({ ...step, moved: at > 0 && step.done > steps[at - 1]!.done })).filter(step => ["u1f", "u2", "u1m"].includes(step.phase));
    // (a phase that finishes in a single slice has one reading; the rest must be moving)
    expect(later.length).toBeGreaterThan(3);
    expect(later.filter(step => step.moved).length).toBeGreaterThanOrEqual(Math.floor(later.length / 2));
  });
});
