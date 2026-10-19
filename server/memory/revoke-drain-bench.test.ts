// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Revoke drain bench (1.0.3 revoke drain): walks the legacy per-receipt revoke jobs of a data COPY and prints counts and timings only.
// Skipped unless DRAIN_DB names a copied messages.db. Never point it at a live data dir.
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { markerSlice, setScopeFlowEdgesRecorded } from "./revoke-marker.ts";
import { lateBuildStep, REVOCATION_MIN_PAUSE_MS, REVOCATION_PAUSE_FACTOR, REVOCATION_SLICE_MS } from "./memory-revocation.ts";
import { beginRevokeMeasure, budgetedMarkerSlice, endRevokeMeasure, resetRevokeWriteBudget, revokeCostPerChange, revokeSliceNeed, revokeWriteMeter, revokeWriteWaitMs, setRevokeBudgetClock } from "./revoke-budget.ts";

const DB = process.env.DRAIN_DB;
const MAX_S = Number(process.env.DRAIN_MAX_S ?? 600);
const JOBS = Number(process.env.DRAIN_JOBS ?? 1);
const out = (o: Record<string, unknown>) => console.log(`DRAIN ${JSON.stringify(o)}`);

describe.skipIf(!DB)("revoke drain bench", () => {
  it("walks legacy jobs on the copy", () => {
    const db = new DatabaseSync(DB!);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA wal_autocheckpoint=0");
    const wal = () => { try { return statSync(`${DB}-wal`).size; } catch { return 0; } };
    let walBytes = 0, walChanges = 0;
    const n = (sql: string, ...a: any[]) => Number((db.prepare(sql).get(...a) as any)?.n ?? 0);
    const ids = (db.prepare("SELECT revoke_id FROM memory_revoke_jobs WHERE state='active' ORDER BY revoke_id").all() as any[]).map(r => Number(r.revoke_id));
    out({ k: "start", active: ids.length, frontier: n("SELECT count(*) n FROM memory_revoke_frontier"), reached: n("SELECT count(*) n FROM memory_revoke_reached") });
    setScopeFlowEdgesRecorded(true); // as index.ts sets it at start
    if (process.env.DRAIN_MODE === "budget") {
      // The runner's own path (memory-revocation.ts tick): budgeted slices of up to 4096 rows and REVOCATION_SLICE_MS, each committed, then
      // the runner's pause (3x the slice). Waits for the minute's budget are skipped on a virtual clock and added to it, so the result is the
      // wall time the runner would take. DRAIN_MEASURED=0 leaves C at the ceiling a row (the seed, never measured); DRAIN_ONLY=0 runs the runner's job
      // order over every job (F3) instead of one job at a time.
      db.exec("PRAGMA wal_autocheckpoint=1000; PRAGMA journal_size_limit=0");
      const measured = process.env.DRAIN_MEASURED !== "0", oneAtATime = process.env.DRAIN_ONLY !== "0";
      const r0 = performance.now();
      let skipped = 0;
      const virt = () => performance.now() - r0 + skipped;
      setRevokeBudgetClock(() => 1_000_000_000 + Math.round(virt()));
      resetRevokeWriteBudget();
      const star = () => n("SELECT count(*) n FROM memory_deny_pending WHERE thread_id='*'");
      let slices = 0, cpu = 0, starGoneAt: number | null = star() ? null : 0, finished = 0, lastOut = 0, c0 = n("SELECT total_changes() n");
      const pick = () => oneAtATime ? (db.prepare("SELECT revoke_id r FROM memory_revoke_jobs WHERE state='active' ORDER BY revoke_id LIMIT 1").get() as any)?.r : undefined;
      let job = pick(), jobStart = 0, jobChanges = c0;
      out({ k: "budget-start", measured, oneAtATime, star: star(), flips: n("SELECT count(*) n FROM memory_receipt_flips") });
      while (performance.now() - r0 < MAX_S * 1000) {
        const wait = revokeWriteWaitMs(revokeSliceNeed(db));
        if (wait > 0) { skipped += wait; continue; }
        const s0 = performance.now();
        db.exec("BEGIN IMMEDIATE");
        const measure = beginRevokeMeasure(db);
        let moved: boolean | "budget";
        try { moved = budgetedMarkerSlice(db, 4096, REVOCATION_SLICE_MS, lateBuildStep, job === undefined ? {} : { only: Number(job) }); db.exec("COMMIT"); }
        catch (e) { try { db.exec("ROLLBACK"); } catch { /* SQLite aborted it already */ } throw e; }
        if (measured) endRevokeMeasure(db, measure); // DRAIN_MEASURED=0: C stays at the ceiling (the seed)
        const ms = performance.now() - s0; cpu += ms; slices++;
        skipped += Math.max(0, Math.max(REVOCATION_MIN_PAUSE_MS, Math.ceil(ms * REVOCATION_PAUSE_FACTOR))); // the runner's pause, not spent on this CPU
        if (starGoneAt === null && star() === 0) { starGoneAt = virt(); out({ k: "star-gone", virtS: Math.round(virt() / 1000), slices }); }
        const state = job === undefined ? "runner" : String((db.prepare("SELECT state FROM memory_revoke_jobs WHERE revoke_id=?").get(job) as any)?.state ?? "gone");
        if (job !== undefined && state !== "active") {
          finished++;
          const ch = n("SELECT total_changes() n");
          out({ k: "job-done", job, virtMin: +((virt() - jobStart) / 60000).toFixed(1), changes: ch - jobChanges, slices, cpuS: Math.round(cpu / 1000) });
          jobStart = virt(); jobChanges = ch; job = pick();
          if (job === undefined || finished >= JOBS) break;
        }
        if (moved === false) break;
        if (performance.now() - lastOut > 30_000) {
          lastOut = performance.now();
          out({ k: "budget-progress", virtMin: +(virt() / 60000).toFixed(1), realS: Math.round((performance.now() - r0) / 1000), cpuS: Math.round(cpu / 1000), slices, finished,
            changes: n("SELECT total_changes() n") - c0, measuredSlices: revokeWriteMeter.measured,
            walBytesPerChange: revokeWriteMeter.measured ? Math.round(revokeWriteMeter.measuredBytes / Math.max(1, revokeWriteMeter.measuredChanges)) : null, costPerChange: Math.round(revokeCostPerChange(db)), chargedMB: +(revokeWriteMeter.charged / 1048576).toFixed(1), overCeiling: revokeWriteMeter.overCeiling,
            star: star(), inFlow: n("SELECT count(*) n FROM memory_revoke_jobs WHERE state='active' AND phase='flow'"), active: n("SELECT count(*) n FROM memory_revoke_jobs WHERE state='active'") });
        }
      }
      const changes = n("SELECT total_changes() n") - c0;
      out({ k: "budget-end", measured, oneAtATime, virtMin: +(virt() / 60000).toFixed(1), realS: Math.round((performance.now() - r0) / 1000), cpuS: Math.round(cpu / 1000), slices, finished, changes,
        changesPerVirtMin: Math.round(changes / Math.max(1e-9, virt() / 60000)), measuredBytes: revokeWriteMeter.measuredBytes, measuredChanges: revokeWriteMeter.measuredChanges, measuredSlices: revokeWriteMeter.measured, chargedBytes: revokeWriteMeter.charged, costPerChange: Math.round(revokeCostPerChange(db)),
        measuredMiBPerVirtMin: +((revokeWriteMeter.measuredBytes / 1048576) / Math.max(1e-9, virt() / 60000)).toFixed(2), overCeiling: revokeWriteMeter.overCeiling, maxPerChange: Math.round(revokeWriteMeter.maxPerChange), maxSliceBytes: revokeWriteMeter.maxSliceBytes,
        starGoneVirtS: starGoneAt === null ? null : Math.round(starGoneAt / 1000), star: star(), active: n("SELECT count(*) n FROM memory_revoke_jobs WHERE state='active'") });
      setRevokeBudgetClock();
      expect(slices).toBeGreaterThan(0);
      return;
    }
    if (process.env.DRAIN_MODE === "flow") {
      // every job's flow phase only (a one-row slice ends right after its flow step): how long until no '*' window is left
      const f0 = performance.now(); let fs = 0;
      for (const only of ids) {
        for (;;) {
          const phase = String((db.prepare("SELECT phase FROM memory_revoke_jobs WHERE revoke_id=?").get(only) as any)?.phase);
          if (phase !== "flow") break;
          db.exec("BEGIN IMMEDIATE"); markerSlice(db, 1, Number.POSITIVE_INFINITY, lateBuildStep, Number.POSITIVE_INFINITY, { only }); db.exec("COMMIT"); fs++;
        }
      }
      out({ k: "flow", ms: Math.round(performance.now() - f0), slices: fs, star: n("SELECT count(*) n FROM memory_deny_pending WHERE thread_id='*'"),
        pending: n("SELECT count(*) n FROM memory_deny_pending"), inFlow: n("SELECT count(*) n FROM memory_revoke_jobs WHERE phase='flow'") });
      return;
    }
    const t0 = performance.now();
    let slices = 0, maxSlice = 0, finished = 0;
    for (const only of ids.slice(0, JOBS)) {
      const j0 = performance.now(), c0 = n("SELECT total_changes() n");
      let last = j0, js = 0;
      for (;;) {
        const s0 = performance.now();
        db.exec("BEGIN IMMEDIATE");
        let moved: boolean | "blocked";
        try { moved = markerSlice(db, 256, Number.POSITIVE_INFINITY, lateBuildStep, Number.POSITIVE_INFINITY, { only }); db.exec("COMMIT"); }
        catch (e) { db.exec("ROLLBACK"); throw e; }
        const ms = performance.now() - s0; slices++; js++; maxSlice = Math.max(maxSlice, ms);
        const state = String((db.prepare("SELECT state FROM memory_revoke_jobs WHERE revoke_id=?").get(only) as any)?.state ?? "gone");
        const now = performance.now();
        if (now - last > 10_000 || state !== "active" || !moved) {
          last = now;
          const reached = db.prepare("SELECT substr(thread_id,1,2) p,count(*) n FROM memory_revoke_reached WHERE revoke_id=? GROUP BY 1").all(only) as any[];
          const cNow = n("SELECT total_changes() n"); walBytes += wal(); walChanges += cNow - c0 - walChanges;
          db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          out({ k: "job", only, state, walBytes, bytesPerChange: walChanges ? Math.round(walBytes / walChanges) : null, phase: (db.prepare("SELECT phase FROM memory_revoke_jobs WHERE revoke_id=?").get(only) as any)?.phase, s: Math.round((now - j0) / 1000), slices: js,
            frontier: n("SELECT count(*) n FROM memory_revoke_frontier WHERE revoke_id=?", only), reached: Object.fromEntries(reached.map(r => [r.p, r.n])),
            changes: n("SELECT total_changes() n") - c0, maxSliceMs: Math.round(maxSlice) });
        }
        if (state !== "active" || !moved) { if (state !== "active") finished++; break; }
        if (now - t0 > MAX_S * 1000) break;
      }
      if (performance.now() - t0 > MAX_S * 1000) break;
    }
    out({ k: "end", s: Math.round((performance.now() - t0) / 1000), slices, finished, active: n("SELECT count(*) n FROM memory_revoke_jobs WHERE state='active'") });
    expect(slices).toBeGreaterThan(0);
  }, 24 * 3600_000);
});
