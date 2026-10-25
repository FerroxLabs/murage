// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Conversation-deletion drain bench (1.0.5 SELF-OVERLOAD, item 1): N conversation deletions committed on a data COPY, drained the runner's
// way (budgeted slices on a virtual clock, every job in the runner's order), printing counts and timings only. Skipped unless DCB_DB names a
// copied messages.db. Never point it at a live data dir; never prints a message, a thread id or any content.
//   DCB_JOBS      deletions to commit (default 13, as the owner's store had)
//   DCB_MAX_S     wall seconds for the drain (default 2400)
//   DCB_COVER=0   leaves the deletion cover off (the base's per-job walk); the knob is read through the module object so the file runs on
//                 the base too (where there is no knob and the walk is per job either way)
// The deleted threads are chosen deterministically: by outgoing carry count, every 5th of the top 5N (a mix of heavily and lightly cited
// chats, not only the worst case).
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { commitRevoke } from "./revoke-commit.ts";
import * as marker from "./revoke-marker.ts";
import { lateBuildStep, REVOCATION_MIN_PAUSE_MS, REVOCATION_PAUSE_FACTOR, REVOCATION_SLICE_MS } from "./memory-revocation.ts";
import { beginRevokeMeasure, budgetedMarkerSlice, endRevokeMeasure, resetRevokeWriteBudget, revokeCostPerChange, revokeSliceNeed, revokeWriteMeter, revokeWriteWaitMs, setRevokeBudgetClock } from "./revoke-budget.ts";

const DB = process.env.DCB_DB;
const JOBS = Number(process.env.DCB_JOBS ?? 13);
const MAX_S = Number(process.env.DCB_MAX_S ?? 2400);
const out = (o: Record<string, unknown>) => console.log(`DCB ${JSON.stringify(o)}`);

describe.skipIf(!DB)("conversation deletion drain bench", () => {
  it("commits N deletions on the copy and drains them the runner's way", () => {
    const db = new DatabaseSync(DB!);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA wal_autocheckpoint=1000; PRAGMA journal_size_limit=0");
    const n = (sql: string, ...a: unknown[]) => Number((db.prepare(sql).get(...(a as never[])) as { n?: number } | undefined)?.n ?? 0);
    const M = marker as unknown as Record<string, any>;
    const coverOn = process.env.DCB_COVER !== "0";
    if (M.DELETION_COVER) M.DELETION_COVER.enabled = coverOn;
    marker.setScopeFlowEdgesRecorded(true); // as index.ts sets it at start
    out({ k: "store", coverOn, knob: Boolean(M.DELETION_COVER), activeBefore: n("SELECT count(*) n FROM memory_revoke_jobs WHERE state IN ('active','seeding')"),
      sources: n("SELECT count(*) n FROM memory_sources"), records: n("SELECT count(*) n FROM memory_records"), carries: n("SELECT count(*) n FROM memory_lineage_carry"),
      lines: n("SELECT count(*) n FROM memory_line_lineage"), denyMemory: n("SELECT count(*) n FROM memory_deny_memory"), denyLine: n("SELECT count(*) n FROM memory_deny_line") });
    // the threads: every 5th of the top 5N by outgoing carries (thread ids never printed)
    const ranked = db.prepare(`SELECT t.thread_id AS id FROM memory_lineage_carry c JOIN memory_thread_no t ON t.no=c.parent_thread_no
      WHERE t.thread_id NOT LIKE char(1)||'%' GROUP BY c.parent_thread_no ORDER BY count(*) DESC LIMIT ?`).all(5 * JOBS) as Array<{ id: string }>;
    const chosen = ranked.filter((_, i) => i % 5 === 0).slice(0, JOBS).map(r => r.id);
    const committed: number[] = [];
    // DCB_JOBS=0: no new deletion; the jobs already in the file (the owner's own backlog) are the ones tracked
    if (JOBS === 0) committed.push(...(db.prepare("SELECT revoke_id r FROM memory_revoke_jobs WHERE state IN ('active','seeding') ORDER BY revoke_id").all() as Array<{ r: number }>).map(r => Number(r.r)));
    for (const T of chosen) {
      db.exec("BEGIN IMMEDIATE");
      committed.push(commitRevoke(db, { kind: "thread", threadId: T, cause: "delete-conversation" }));
      db.exec("COMMIT");
    }
    out({ k: "committed", jobs: committed.length, newDeletions: chosen.length, kinds: db.prepare(`SELECT kind,phase,count(*) n FROM memory_revoke_jobs WHERE revoke_id IN (${committed.length ? committed.join(",") : "-1"}) GROUP BY 1,2`).all(), pending: n("SELECT count(*) n FROM memory_deny_pending"), star: n("SELECT count(*) n FROM memory_deny_pending WHERE thread_id='*'") });
    const r0 = performance.now();
    let skipped = 0;
    const virt = () => performance.now() - r0 + skipped;
    setRevokeBudgetClock(() => 1_000_000_000 + Math.round(virt()));
    resetRevokeWriteBudget();
    const c0 = n("SELECT total_changes() n");
    let slices = 0, cpu = 0, lastOut = 0, lastActive = -1;
    const active = () => n("SELECT count(*) n FROM memory_revoke_jobs WHERE state IN ('active','seeding','undoing')");
    const ids = committed.length ? committed.join(",") : "-1";
    const ours = () => n(`SELECT count(*) n FROM memory_revoke_jobs WHERE state IN ('active','seeding') AND revoke_id IN (${ids})`);
    const windows = () => n(`SELECT count(*) n FROM memory_deny_pending WHERE revoke_id IN (${ids})`);
    const doneAt: Array<{ left: number; virtMin: number; changes: number; cpuS: number }> = [];
    while (performance.now() - r0 < MAX_S * 1000 && marker.markerWorkPending(db)) {
      const wait = revokeWriteWaitMs(revokeSliceNeed(db));
      if (wait > 0) { skipped += wait; continue; }
      const s0 = performance.now();
      db.exec("BEGIN IMMEDIATE");
      const measure = beginRevokeMeasure(db);
      let moved: boolean | "budget";
      try { moved = budgetedMarkerSlice(db, 4096, REVOCATION_SLICE_MS, lateBuildStep); db.exec("COMMIT"); }
      catch (e) { try { db.exec("ROLLBACK"); } catch { /* aborted */ } throw e; }
      endRevokeMeasure(db, measure);
      const ms = performance.now() - s0; cpu += ms; slices++;
      skipped += Math.max(REVOCATION_MIN_PAUSE_MS, Math.ceil(ms * REVOCATION_PAUSE_FACTOR)); // the runner's pause, not spent here
      const left = ours();
      if (left !== lastActive) { lastActive = left; doneAt.push({ left, virtMin: +(virt() / 60000).toFixed(1), changes: n("SELECT total_changes() n") - c0, cpuS: Math.round(cpu / 1000) }); }
      if (moved === false) break;
      if (performance.now() - lastOut > 60_000) {
        lastOut = performance.now();
        out({ k: "progress", virtMin: Math.round(virt() / 60000), realS: Math.round((performance.now() - r0) / 1000), cpuS: Math.round(cpu / 1000), slices, changes: n("SELECT total_changes() n") - c0,
          active: active(), ours: left, windows: windows(), frontier: n("SELECT count(*) n FROM memory_revoke_frontier"), denyMemory: n("SELECT count(*) n FROM memory_deny_memory"),
          probe: { ...(M.COVER_PROBE ?? {}) } });
      }
    }
    const changes = n("SELECT total_changes() n") - c0;
    out({ k: "done", coverOn, finished: !marker.markerWorkPending(db), oursLeft: ours(), windowsLeft: windows(), virtMin: +(virt() / 60000).toFixed(1), realS: Math.round((performance.now() - r0) / 1000), cpuS: Math.round(cpu / 1000),
      slices, changes, measuredMB: +(revokeWriteMeter.measuredBytes / 1048576).toFixed(1), chargedMB: +(revokeWriteMeter.charged / 1048576).toFixed(1), bytesPerChange: revokeWriteMeter.measuredChanges ? Math.round(revokeWriteMeter.measuredBytes / revokeWriteMeter.measuredChanges) : null,
      costPerChange: Math.round(revokeCostPerChange(db)), denyMemory: n("SELECT count(*) n FROM memory_deny_memory"), denyLine: n("SELECT count(*) n FROM memory_deny_line"), denyRange: n("SELECT count(*) n FROM memory_deny_range"),
      denySession: n("SELECT count(*) n FROM memory_deny_session"), frontier: n("SELECT count(*) n FROM memory_revoke_frontier"), probe: { ...(M.COVER_PROBE ?? {}) }, doneAt });
    setRevokeBudgetClock();
    db.close();
    expect(slices).toBeGreaterThan(0);
  }, 24 * 3600_000);
});
