// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Opening Memory used to run two full scans on the server's only thread (health: every
// source payload parsed twice; retention: every payload measured), 460 ms on the test
// store and seconds on a large one (EVIDENCE section 2). The numbers they produce only
// need to be recent, so the worker computes them a slice at a time in the background and
// the status call reads the last finished value, stamped "as of" (PROPOSAL-v2 13, item 0.9).
import type { DatabaseSync } from "node:sqlite";

/** A scan that walks one table by rowid in small pages and keeps a running total. */
export interface PagedScanSpec<Acc, Result> {
  init(): Acc;
  /** Read at most `rows` rows after `cursor`; fold them into `acc`; return the last rowid read, or null when the table is finished. */
  page(db: DatabaseSync, cursor: number, acc: Acc, rows: number): number | null;
  finish(acc: Acc): Result;
  /** A cheap reading that changes whenever the scanned tables may have changed. When it reads the same as at the
   * start of the last finished pass, the next pass is skipped (F22: an idle store is not walked every 10 minutes). */
  stamp?(db: DatabaseSync): string;
}
/** One page's read is kept near this: a page that takes longer is halved for the next, one much quicker doubled back (rc13 real-data run: a
 * fixed 400-row page of the health figures read 68 to 102 ms while the upgrade wrote beside it). */
export const SCAN_PAGE_TARGET_MS = 20;
export const SCAN_PAGE_MIN_ROWS = 16;
export class PagedScan<Acc, Result> {
  private acc: Acc | null = null;
  private cursor = 0;
  private lastResult: Result | null = null;
  private lastAsOf: number | null = null;
  private nextScanAt = 0;
  /** The stamp read when the running pass started, and when the last finished one did. */
  private passStamp: string | null = null;
  private lastStamp: string | null = null;
  private readonly spec: PagedScanSpec<Acc, Result>;
  private readonly minIntervalMs: number;
  private readonly maxRows: number;
  /** The rows the next page reads (adaptive, SCAN_PAGE_MIN_ROWS to maxRows). */
  private rows: number;
  constructor(spec: PagedScanSpec<Acc, Result>, minIntervalMs: number, maxRows = 400) {
    this.spec = spec; this.minIntervalMs = minIntervalMs;
    this.maxRows = Math.max(SCAN_PAGE_MIN_ROWS, Math.floor(maxRows));
    this.rows = Math.max(SCAN_PAGE_MIN_ROWS, Math.min(this.maxRows, 100));
  }
  /** The rows the next page will read. */
  get pageRows(): number { return this.rows; }
  get result(): Result | null { return this.lastResult; }
  get asOf(): number | null { return this.lastAsOf; }
  /** True while a pass is part-way. */
  get running(): boolean { return this.acc !== null; }
  /** Publish a result computed some other way (a small store computes it in one go). */
  set(result: Result, now = Date.now()): void { this.lastResult = result; this.lastAsOf = now; this.nextScanAt = now + this.minIntervalMs; this.acc = null; this.cursor = 0; this.lastStamp = null; }
  /** Forget everything (a different database, a test). */
  clear(): void { this.acc = null; this.cursor = 0; this.lastResult = null; this.lastAsOf = null; this.nextScanAt = 0; this.passStamp = null; this.lastStamp = null; }
  /** Request a new pass as soon as the next step runs. */
  invalidate(): void { this.nextScanAt = 0; this.lastStamp = null; }
  /** Run pages until `budgetMs` is spent. Returns true when more remains (the caller comes back soon). */
  step(db: DatabaseSync, budgetMs: number, now = Date.now()): boolean {
    if (!this.acc) {
      if (now < this.nextScanAt) return false;
      const stamp = this.spec.stamp ? this.spec.stamp(db) : null;
      // Nothing was written since the last pass started: its figures still stand.
      if (stamp !== null && stamp === this.lastStamp && this.lastResult !== null) { this.nextScanAt = now + this.minIntervalMs; return false; }
      this.passStamp = stamp;
      this.acc = this.spec.init(); this.cursor = 0;
    }
    const until = performance.now() + budgetMs;
    do {
      const pageStarted = performance.now();
      const next = this.spec.page(db, this.cursor, this.acc, this.rows);
      const pageMs = performance.now() - pageStarted;
      if (pageMs > SCAN_PAGE_TARGET_MS) this.rows = Math.max(SCAN_PAGE_MIN_ROWS, Math.floor(this.rows / 2));
      else if (pageMs < SCAN_PAGE_TARGET_MS / 4) this.rows = Math.min(this.maxRows, this.rows * 2);
      if (next === null) {
        this.lastResult = this.spec.finish(this.acc); this.lastAsOf = now; this.acc = null; this.cursor = 0;
        this.nextScanAt = now + this.minIntervalMs; this.lastStamp = this.passStamp;
        return false;
      }
      this.cursor = next;
    } while (performance.now() < until);
    return true;
  }
}

/** A store this small is measured in one go, as before: the scan costs a few milliseconds. */
export const SMALL_STORE_ROWS = 5000;
export function storeRowCount(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0);
}
/** Whether these tables hold at most `limit` rows together, reading at most limit+1 rows of each (a count(*)
 * walks the whole table: on a large store that was itself a scan every sweep). */
export function storeAtMost(db: DatabaseSync, tables: readonly string[], limit = SMALL_STORE_ROWS): boolean {
  let total = 0;
  for (const table of tables) {
    total += Number(db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM ${table} LIMIT ?)`).get(limit + 1)?.n ?? 0);
    if (total > limit) return false;
  }
  return true;
}
/** Every write this connection made, and every commit another connection made: equal readings mean nothing changed. */
export function writeStampOf(db: DatabaseSync): string {
  const row = db.prepare("SELECT total_changes() AS changes,(SELECT data_version FROM pragma_data_version) AS version").get();
  return `${row?.changes}:${row?.version}`;
}
/** A stamp of the memory CONTENT the scans of `tables` read, not of every write (SELF-OVERLOAD-105 item 4): the write-time marker commits
 * dozens of times a second while a revoke walks, which moved writeStampOf and re-ran every status pass over the whole store each interval
 * though no memory had changed. Reads: memory_meta.data_revision (every content writer bumps it), the newest rowid of each scanned table
 * (new rows), and deny_generation (a revoke's phase ended: receipts and records it flipped). None of them moves per marker slice. A table
 * or meta row that is not there reads as absent, so a file without it still stamps. */
export function contentStampOf(db: DatabaseSync, tables: readonly string[]): string {
  const parts: string[] = [];
  const read = (sql: string): string => { try { const row = db.prepare(sql).get() as Record<string, unknown> | undefined; return String(row ? Object.values(row)[0] : "-"); } catch { return "-"; } };
  parts.push(read("SELECT data_revision FROM memory_meta WHERE id=1"));
  for (const table of tables) parts.push(read(`SELECT max(rowid) FROM ${table}`));
  parts.push(read("SELECT value FROM memory_lineage_lsn_meta WHERE key='deny_generation'"));
  return parts.join(":");
}
