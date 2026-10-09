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
  /** Read the page after `cursor`; fold it into `acc`; return the last rowid read, or null when the table is finished. */
  page(db: DatabaseSync, cursor: number, acc: Acc): number | null;
  finish(acc: Acc): Result;
}
export class PagedScan<Acc, Result> {
  private acc: Acc | null = null;
  private cursor = 0;
  private lastResult: Result | null = null;
  private lastAsOf: number | null = null;
  private nextScanAt = 0;
  private readonly spec: PagedScanSpec<Acc, Result>;
  private readonly minIntervalMs: number;
  constructor(spec: PagedScanSpec<Acc, Result>, minIntervalMs: number) { this.spec = spec; this.minIntervalMs = minIntervalMs; }
  get result(): Result | null { return this.lastResult; }
  get asOf(): number | null { return this.lastAsOf; }
  /** True while a pass is part-way. */
  get running(): boolean { return this.acc !== null; }
  /** Publish a result computed some other way (a small store computes it in one go). */
  set(result: Result, now = Date.now()): void { this.lastResult = result; this.lastAsOf = now; this.nextScanAt = now + this.minIntervalMs; this.acc = null; this.cursor = 0; }
  /** Forget everything (a different database, a test). */
  clear(): void { this.acc = null; this.cursor = 0; this.lastResult = null; this.lastAsOf = null; this.nextScanAt = 0; }
  /** Request a new pass as soon as the next step runs. */
  invalidate(): void { this.nextScanAt = 0; }
  /** Run pages until `budgetMs` is spent. Returns true when more remains (the caller comes back soon). */
  step(db: DatabaseSync, budgetMs: number, now = Date.now()): boolean {
    if (!this.acc) {
      if (now < this.nextScanAt) return false;
      this.acc = this.spec.init(); this.cursor = 0;
    }
    const until = performance.now() + budgetMs;
    do {
      const next = this.spec.page(db, this.cursor, this.acc);
      if (next === null) {
        this.lastResult = this.spec.finish(this.acc); this.lastAsOf = now; this.acc = null; this.cursor = 0;
        this.nextScanAt = now + this.minIntervalMs;
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
