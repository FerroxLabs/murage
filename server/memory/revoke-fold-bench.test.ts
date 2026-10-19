// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Revoke fold bench (1.0.3 REVOKE-FOLD-DESIGN F1.8): drains the legacy per-receipt revoke jobs of a data COPY through the runner's own path
// (budgeted slices, the runner's pause, the minute's write budget on a virtual clock) with the fold, and prints counts and timings only.
// Skipped unless FOLD_DB names a copied messages.db. Never point it at a live data dir.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import "./revoke-commit.ts";
import { markerWorkPending, setScopeFlowEdgesRecorded } from "./revoke-marker.ts";
import { statSync } from "node:fs";
import { reclaimCertified, reclaimRootSetsWhenIdle, setReadTimeJudgeRetired, rootSetReclaimStatus, lastReclaimStats } from "./root-set-reclaim.ts";
import { integrityFlags } from "./integrity-flags.ts";
import { ensureRevokeLateObjects } from "./schema.ts";
import { lateBuildStep, revocationWorkPending, REVOCATION_MIN_PAUSE_MS, REVOCATION_PAUSE_FACTOR, REVOCATION_SLICE_MS } from "./memory-revocation.ts";
import { beginRevokeMeasure, budgetedMarkerSlice, endRevokeMeasure, resetRevokeWriteBudget, revokeSliceNeed, revokeWriteMeter, revokeWriteWaitMs, setRevokeBudgetClock } from "./revoke-budget.ts";

const DB = process.env.FOLD_DB;
const MAX_S = Number(process.env.FOLD_MAX_S ?? 7200);
const out = (o: Record<string, unknown>) => console.log(`FOLD ${JSON.stringify(o)}`);

describe.skipIf(!DB)("revoke fold bench", () => {
  it("folds and drains the legacy jobs on the copy", () => {
    const db = new DatabaseSync(DB!);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA wal_autocheckpoint=1000; PRAGMA journal_size_limit=0");
    ensureRevokeLateObjects(db);
    const n = (sql: string) => Number((db.prepare(sql).get() as { n?: number } | undefined)?.n ?? 0);
    const live = () => n("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('active','seeding','undoing')");
    const folds = () => n("SELECT count(*) AS n FROM memory_revoke_jobs WHERE json_valid(root) AND json_extract(root,'$.cause')='fold'");
    const seeding = () => n("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state='seeding'");
    const star = () => n("SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id='*'");
    out({ k: "start", active: live(), audience: n("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state='active' AND revoke_id IN (SELECT revoke_id FROM memory_revoke_audience)"),
      frontier: n("SELECT count(*) AS n FROM memory_revoke_frontier"), flips: n("SELECT count(*) AS n FROM memory_receipt_flips") });
    setScopeFlowEdgesRecorded(true); // as index.ts sets it at start
    const r0 = performance.now();
    let wasSeeding = false, skipped = 0, slices = 0, cpu = 0, lastOut = 0, foldedAt: number | null = null, starGoneAt: number | null = null;
    const virt = () => performance.now() - r0 + skipped;
    setRevokeBudgetClock(() => 1_000_000_000 + Math.round(virt()));
    resetRevokeWriteBudget();
    const c0 = n("SELECT total_changes() AS n");
    while (performance.now() - r0 < MAX_S * 1000) {
      const wait = revokeWriteWaitMs(revokeSliceNeed(db));
      if (wait > 0) { skipped += wait; continue; }
      const s0 = performance.now();
      db.exec("BEGIN IMMEDIATE");
      const measure = beginRevokeMeasure(db);
      let moved: boolean | "budget";
      try { moved = budgetedMarkerSlice(db, 4096, REVOCATION_SLICE_MS, lateBuildStep); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
      endRevokeMeasure(db, measure);
      const ms = performance.now() - s0; cpu += ms; slices++;
      skipped += Math.max(REVOCATION_MIN_PAUSE_MS, Math.ceil(ms * REVOCATION_PAUSE_FACTOR));
      const seedNow = seeding();
      if (wasSeeding && !seedNow) { foldedAt = virt(); out({ k: "fold-active", virtMin: +(virt() / 60000).toFixed(1), maps: n("SELECT count(DISTINCT bulk_id) AS n FROM memory_revoke_fold"), active: live(), slices }); }
      wasSeeding = seedNow > 0;
      if (starGoneAt === null && foldedAt !== null && star() === 0) { starGoneAt = virt(); out({ k: "star-gone", virtMin: +(virt() / 60000).toFixed(1) }); }
      if (moved === false && live() === 0) break;
      if (performance.now() - lastOut > 60_000) {
        lastOut = performance.now();
        out({ k: "progress", virtMin: +(virt() / 60000).toFixed(1), realS: Math.round((performance.now() - r0) / 1000), cpuS: Math.round(cpu / 1000), slices, folds: folds(), seeding: seeding(),
          active: live(), star: star(), changes: n("SELECT total_changes() AS n") - c0, measuredMB: Math.round(revokeWriteMeter.measuredBytes / 1048576) });
      }
    }
    out({ k: "end", virtMin: +(virt() / 60000).toFixed(1), realS: Math.round((performance.now() - r0) / 1000), cpuS: Math.round(cpu / 1000), slices, folds: folds(), active: live(),
      foldedVirtMin: foldedAt === null ? null : +(foldedAt / 60000).toFixed(1), starGoneVirtMin: starGoneAt === null ? null : +(starGoneAt / 60000).toFixed(1),
      changes: n("SELECT total_changes() AS n") - c0, measuredMB: Math.round(revokeWriteMeter.measuredBytes / 1048576),
      cohorts: (db.prepare("SELECT count(*) AS n FROM memory_revoke_fold GROUP BY bulk_id ORDER BY bulk_id").all() as Array<{ n: number }>).map(r => r.n) });
    setRevokeBudgetClock();
    db.close();
    expect(slices).toBeGreaterThan(0);
  }, 24 * 3600_000);

  // After the drain: the root-set hand-back (root-set-reclaim.ts, the server's idle path) with the server's own revocation gate
  // (index.ts rootSetReclaimGate.revocationWaiting) and an owner away. Rows before and after, its time, the file after its VACUUM.
  it("the root-set hand-back runs once the backlog is drained", async () => {
    const db = new DatabaseSync(DB!);
    db.exec("PRAGMA busy_timeout=5000");
    const n = (sql: string) => { try { return Number((db.prepare(sql).get() as { n?: number } | undefined)?.n ?? 0); } catch { return -1; } };
    const size = () => { try { return statSync(DB!).size + (() => { try { return statSync(`${DB}-wal`).size; } catch { return 0; } })(); } catch { return 0; } };
    const waiting = () => markerWorkPending(db) || revocationWorkPending(db);
    let integrity: unknown = null;
    try { integrity = integrityFlags(db).pending; } catch { integrity = "n/a"; }
    out({ k: "reclaim-start", members: n("SELECT count(*) AS n FROM memory_root_set_members"), certified: reclaimCertified(db), revocationWaiting: waiting(), markerWork: markerWorkPending(db),
      revocationJobs: n("SELECT count(*) AS n FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='memory-revocation'"), integrityPending: integrity, fileMB: Math.round(size() / 1048576) });
    setReadTimeJudgeRetired(true); // as index.ts sets it at start (flowEdges)
    const gate = { ownerIdleMs: () => 3_600_000, liveTurn: () => false, typingHeld: () => false, routineDueWithin: () => false, healthAnswered: () => true, integrityPending: () => false, revocationWaiting: waiting };
    const t0 = performance.now();
    let result: string = "waiting", passes = 0;
    while (passes < 400 && performance.now() - t0 < MAX_S * 1000) {
      result = await reclaimRootSetsWhenIdle(db, gate, { runMs: 60_000 });
      passes++;
      out({ k: "reclaim-pass", passes, result, s: Math.round((performance.now() - t0) / 1000), status: rootSetReclaimStatus(), stats: lastReclaimStats(),
        members: n("SELECT count(*) AS n FROM memory_root_set_members"), fileMB: Math.round(size() / 1048576) });
      if (result === "done" || (result === "waiting" && waiting())) break;
      if (passes > 3 && lastReclaimStats().batches === 0) break; // not moving: reported below
    }
    out({ k: "reclaim-end", result, passes, s: Math.round((performance.now() - t0) / 1000), members: n("SELECT count(*) AS n FROM memory_root_set_members"), fileMB: Math.round(size() / 1048576) });
    db.close();
    expect(passes).toBeGreaterThan(0);
  }, 24 * 3600_000);
});
