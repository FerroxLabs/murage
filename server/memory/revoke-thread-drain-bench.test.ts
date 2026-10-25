// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Thread-deletion drain bench (1.0.4 DELETION-DRAIN-V2): N conversation deletions on a large SYNTHETIC store whose memory is shared across
// chats, drained the runner's way (budgeted slices on a virtual clock), printing counts and timings only. Never a copy of anyone's data.
// Skipped unless TDB_SCALE is set. TDB_JOBS deletions (default 13), TDB_MAX_S wall seconds (default 1800), TDB_FOLD=0 leaves the thread
// fold off (the per-job walk, the base's behaviour).
import { statSync } from "node:fs";
import { StatementSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { commitRevoke } from "./revoke-commit.ts";
import * as foldModule from "./revoke-fold.ts";
import { markerWorkPending, setScopeFlowEdgesRecorded } from "./revoke-marker.ts";
import { lateBuildStep, REVOCATION_MIN_PAUSE_MS, REVOCATION_PAUSE_FACTOR, REVOCATION_SLICE_MS } from "./memory-revocation.ts";
import { beginRevokeMeasure, budgetedMarkerSlice, endRevokeMeasure, resetRevokeWriteBudget, revokeCostPerChange, revokeSliceNeed, revokeWriteWaitMs, setRevokeBudgetClock } from "./revoke-budget.ts";
import { CARRY_CHILD_CODE, FIRST_LSN, lineChildRef, OBJECT_EDGE_LSN, objectCarryThread, recordChildRef, turnChildRef } from "./lineage-types.ts";
import { noteReceiptOutput } from "./receipt-outputs.ts";
import { testThreadNo, WritetimeFixture } from "./testing/writetime-fixture.ts";

const SCALE = Number(process.env.TDB_SCALE ?? 0);
const JOBS = Number(process.env.TDB_JOBS ?? 13);
const MAX_S = Number(process.env.TDB_MAX_S ?? 1800);
const out = (o: Record<string, unknown>) => console.log(`TDB ${JSON.stringify(o)}`);
function mulberry(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** A store of `threads` chats sharing memory: captures, records with evidence from several chats, derivations, object consumers, receipts
 * citing records, carries between chats (lines, turns, records, sources). Every carry's last line is a generated line; every generated line's
 * turn began before the first cap (the deletions come after the whole history, as on a real store whose deletions walk old history). */
function buildStore(fx: WritetimeFixture, scale: number, seed = 7): string[] {
  const rnd = mulberry(seed), db = fx.db;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const threads = Array.from({ length: 40 * scale }, (_, i) => `t${i}`);
  const linesPerThread = 60;
  const lines = new Map<string, number[]>(), gen = new Map<string, number[]>();
  db.exec("BEGIN");
  let lsn = 1;
  for (const T of threads) { lines.set(T, []); gen.set(T, []); }
  // interleaved history: thread by thread in rounds, so positions mix across chats
  for (let round = 0; round < linesPerThread; round++) {
    for (const T of threads) {
      const g = round % 2 === 1;
      if (g) fx.reply(T, `${T}-${lsn}`, lsn, { turnLsn: lsn - 1 }); else fx.owner(T, `${T}-${lsn}`, lsn);
      lines.get(T)!.push(lsn); if (g) gen.get(T)!.push(lsn);
      lsn++;
    }
  }
  const top = lsn;
  for (const T of threads) for (let k = 0; k < 2; k++) { const l = lines.get(T)!; const first = pick(l), last = Math.min(top - 1, first + 20); fx.sessionLineage(T, "fuigo", `${T}-s${k}`, first, last); }
  const capture = db.prepare("INSERT OR IGNORE INTO memory_line_capture(thread_no,lsn,source_id) VALUES(?,?,?)");
  const carry = db.prepare("INSERT OR IGNORE INTO memory_lineage_carry(parent_thread_no,to_lsn,from_lsn,child_kind,child_ref,child_thread_no) VALUES(?,?,?,?,?,?)");
  const sources: string[] = [];
  for (let k = 0; k < 400 * scale; k++) { const T = pick(threads), at = pick(gen.get(T)!), id = `src${k}`; fx.source(id, "s-room", { thread: T, message: `${T}-${at}` }); capture.run(testThreadNo(db, T), at, id); sources.push(id); }
  const records: string[] = [];
  for (let k = 0; k < 300 * scale; k++) { const id = `rec${k}`; const ev = [...new Set([pick(sources), pick(sources)])]; fx.record(id, 1, rnd() < 0.3 ? "s-bot" : "s-room", ev); records.push(id); }
  for (let k = 0; k < 150 * scale; k++) { const a = pick(records), b = pick(records); if (a !== b) { try { fx.derive(a, 1, b, 1); } catch { /* duplicate */ } } }
  for (let k = 0; k < 1500 * scale; k++) {
    const P = pick(threads), pl = lines.get(P)!, from = rnd() < 0.05 ? FIRST_LSN : pick(pl);
    const ends = gen.get(P)!.filter(l => from === FIRST_LSN || (l >= from && l <= from + 400));
    if (!ends.length) continue;
    const to = pick(ends), Q = pick(threads), r = rnd();
    if (Q === P) continue;
    if (r < 0.4) carry.run(testThreadNo(db, P), to, from, CARRY_CHILD_CODE.line, lineChildRef(pick(lines.get(Q)!)), testThreadNo(db, Q));
    else if (r < 0.6) carry.run(testThreadNo(db, P), to, from, CARRY_CHILD_CODE.turn, turnChildRef(pick(gen.get(Q)!) - 1), testThreadNo(db, Q));
    else if (r < 0.8) carry.run(testThreadNo(db, P), to, from, CARRY_CHILD_CODE.record, recordChildRef({ kind: "record", id: pick(records), version: 1 }), 0);
    else carry.run(testThreadNo(db, P), to, from, CARRY_CHILD_CODE.record, recordChildRef({ kind: "source", id: pick(sources) }), 0);
  }
  // object consumers: a reply that read a source or a record (the walk's objectNode fan-out)
  for (let k = 0; k < 300 * scale; k++) {
    const T = pick(threads), ref = rnd() < 0.5 ? { kind: "source" as const, id: pick(sources) } : { kind: "record" as const, id: pick(records) };
    carry.run(testThreadNo(db, objectCarryThread(ref)), OBJECT_EDGE_LSN, OBJECT_EDGE_LSN, CARRY_CHILD_CODE.line, lineChildRef(pick(lines.get(T)!)), testThreadNo(db, T));
  }
  const disclosure = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'fuigo',?,?,'[]','[]',0,0,0,'delivered',0)");
  for (let k = 0; k < 200 * scale; k++) {
    const T = pick(threads), at = pick(gen.get(T)!), b = `bun${k}`;
    disclosure.run(b, T, `ns-${b}`, JSON.stringify([{ id: pick(records), version: 1 }, { id: pick(records), version: 1 }]));
    noteReceiptOutput(db, b, T, at, { driverInstance: "fuigo", nativeSession: `ns-${b}` });
  }
  db.prepare("UPDATE memory_lsn SET next=max(next,?) WHERE id=1").run(top + 10);
  db.exec("COMMIT");
  return threads;
}

describe.skipIf(!SCALE)("thread deletion drain bench", () => {
  it("drains N conversation deletions on a synthetic store", () => {
    const fx = new WritetimeFixture();
    fx.cert(true);
    const db = fx.db;
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA wal_autocheckpoint=1000; PRAGMA journal_size_limit=0");
    const path = String((db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(r => r.name === "main")!.file);
    const n = (sql: string, ...a: any[]) => Number((db.prepare(sql).get(...a) as any)?.n ?? 0);
    const b0 = performance.now();
    const threads = buildStore(fx, SCALE);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    out({ k: "store", scale: SCALE, threads: threads.length, lines: n("SELECT count(*) n FROM memory_line_lineage"), carries: n("SELECT count(*) n FROM memory_lineage_carry"), sources: n("SELECT count(*) n FROM memory_sources"), records: n("SELECT count(*) n FROM memory_records"), bytes: statSync(path).size, buildS: Math.round((performance.now() - b0) / 1000) });
    setScopeFlowEdgesRecorded(true);
    const foldOn = process.env.TDB_FOLD !== "0";
    const F = foldModule as unknown as Record<string, any>;
    if (F.THREAD_FOLD) F.THREAD_FOLD.enabled = foldOn;
    // the deletions: JOBS threads, with a turn written between every pair of commits (as a store in use has), so a cap-merging fold would
    // not be exact here
    const rnd = mulberry(99);
    const deleted: string[] = [];
    let extra = 0;
    for (let i = 0; i < JOBS; i++) {
      const T = threads[Math.floor(rnd() * threads.length)]!;
      if (deleted.includes(T)) { i--; continue; }
      deleted.push(T);
      db.exec("BEGIN IMMEDIATE");
      commitRevoke(db, { kind: "thread", threadId: T, cause: "delete-conversation" }, { inline: false });
      db.exec("COMMIT");
      // a turn in another chat between two deletions
      const U = threads[(extra++) % threads.length]!, next = Number((db.prepare("SELECT next FROM memory_lsn WHERE id=1").get() as any).next);
      db.exec("BEGIN IMMEDIATE");
      fx.owner(U, `${U}-u${next}`, next).reply(U, `${U}-r${next + 1}`, next + 1, { turnLsn: next });
      db.exec("COMMIT");
    }
    const jobs = db.prepare("SELECT revoke_id r,started_lsn c FROM memory_revoke_jobs WHERE state='active' ORDER BY revoke_id").all() as any[];
    out({ k: "committed", jobs: jobs.length, caps: jobs.map(j => Number(j.c)), pending: n("SELECT count(*) n FROM memory_deny_pending"), foldOn });
    // statement counting: every run/get/all on this process (the drain is the only user from here)
    const counts = { run: 0, get: 0, all: 0 };
    const proto = StatementSync.prototype as any;
    const orig = { run: proto.run, get: proto.get, all: proto.all };
    proto.run = function (...a: any[]) { counts.run++; return orig.run.apply(this, a); };
    proto.get = function (...a: any[]) { counts.get++; return orig.get.apply(this, a); };
    proto.all = function (...a: any[]) { counts.all++; return orig.all.apply(this, a); };
    try {
      const r0 = performance.now();
      let skipped = 0;
      const virt = () => performance.now() - r0 + skipped;
      setRevokeBudgetClock(() => 1_000_000_000 + Math.round(virt()));
      resetRevokeWriteBudget();
      let slices = 0, cpu = 0, walBytes = 0, measured = 0, c0 = n("SELECT total_changes() n");
      const pendingJobs = () => n("SELECT count(*) n FROM memory_revoke_jobs WHERE state IN ('active','seeding','undoing')");
      const windowsOpen = () => n("SELECT count(*) n FROM memory_deny_pending");
      let lastOut = 0, firstClose: number | null = null;
      while (performance.now() - r0 < MAX_S * 1000 && markerWorkPending(db)) {
        const wait = revokeWriteWaitMs(revokeSliceNeed(db));
        if (wait > 0) { skipped += wait; continue; }
        const s0 = performance.now();
        db.exec("BEGIN IMMEDIATE");
        const measure = beginRevokeMeasure(db);
        try { budgetedMarkerSlice(db, 4096, REVOCATION_SLICE_MS, lateBuildStep); db.exec("COMMIT"); }
        catch (e) { try { db.exec("ROLLBACK"); } catch { /* aborted */ } throw e; }
        const bytes = endRevokeMeasure(db, measure);
        if (bytes !== null) { walBytes += bytes; measured++; }
        const ms = performance.now() - s0; cpu += ms; slices++;
        skipped += Math.max(0, Math.max(REVOCATION_MIN_PAUSE_MS, Math.ceil(ms * REVOCATION_PAUSE_FACTOR)));
        if (firstClose === null && windowsOpen() < jobs.length * 2) firstClose = virt();
        if (virt() - lastOut > 120_000) {
          lastOut = virt();
          out({ k: "progress", virtMin: Math.round(virt() / 60000), cpuS: Math.round(cpu / 1000), slices, changes: n("SELECT total_changes() n") - c0, jobs: pendingJobs(), pending: windowsOpen(), frontier: n("SELECT count(*) n FROM memory_revoke_frontier"), C: Math.round(revokeCostPerChange(db)), stmts: counts.run + counts.get + counts.all });
        }
      }
      const changes = n("SELECT total_changes() n") - c0;
      const popped = counts.run; // every pop is one frontier DELETE; a lower bound on nodes
      out({ k: "done", finished: !markerWorkPending(db), virtMin: Math.round(virt() / 60000), cpuS: Math.round(cpu / 1000), slices, changes, measuredSlices: measured, walMB: Math.round(walBytes / 1048576), bytesPerChange: measured ? Math.round(walBytes / changes) : null, C: Math.round(revokeCostPerChange(db)),
        stmts: counts, deny: { line: n("SELECT count(*) n FROM memory_deny_line"), range: n("SELECT count(*) n FROM memory_deny_range"), memory: n("SELECT count(*) n FROM memory_deny_memory"), session: n("SELECT count(*) n FROM memory_deny_session") }, reached: n("SELECT count(*) n FROM memory_revoke_reached"), frontier: n("SELECT count(*) n FROM memory_revoke_frontier"), pending: windowsOpen(), jobs: db.prepare("SELECT revoke_id r,kind k,state s,phase p FROM memory_revoke_jobs").all(), popped, dbMB: Math.round(statSync(path).size / 1048576) });
      expect(slices).toBeGreaterThan(0);
    } finally {
      proto.run = orig.run; proto.get = orig.get; proto.all = orig.all;
      setRevokeBudgetClock();
      fx.close();
    }
  }, 7_200_000);
});
