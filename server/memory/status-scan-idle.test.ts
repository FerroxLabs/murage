// SPDX-License-Identifier: AGPL-3.0-or-later
// F22: the 10-minute status passes skip an unchanged store, and the small-store check no longer counts every row.
import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { PagedScan, SCAN_PAGE_MIN_ROWS, SCAN_PAGE_TARGET_MS, storeAtMost, writeStampOf } from "./status-scan.ts";

function table(rows: number) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t(x)");
  const insert = db.prepare("INSERT INTO t VALUES(?)");
  for (let n = 0; n < rows; n++) insert.run(n);
  return db;
}

it("a pass is skipped when nothing was written since the last one started, and runs again after a write", () => {
  const db = table(10);
  let pages = 0;
  const scan = new PagedScan<{ n: number }, number>({
    init: () => ({ n: 0 }),
    page: (handle, cursor, acc) => { pages++; const rows = handle.prepare("SELECT rowid AS r FROM t WHERE rowid>? ORDER BY rowid LIMIT 4").all(cursor); if (!rows.length) return null; acc.n += rows.length; return Number(rows.at(-1)!.r); },
    finish: acc => acc.n,
    stamp: writeStampOf,
  }, 1000);
  while (scan.step(db, 100, 0)) { /* one pass */ }
  expect(scan.result).toBe(10);
  const walked = pages;
  // ten minutes later, nothing written: no page is read, the figure stands
  expect(scan.step(db, 100, 5_000)).toBe(false);
  expect(pages).toBe(walked);
  expect(scan.result).toBe(10);
  // a write: the next pass walks again
  db.exec("INSERT INTO t VALUES(99)");
  while (scan.step(db, 100, 10_000)) { /* pass */ }
  expect(pages).toBeGreaterThan(walked);
  expect(scan.result).toBe(11);
  // asking for a pass forces one even with nothing written
  scan.invalidate();
  const before = pages;
  while (scan.step(db, 100, 10_001)) { /* pass */ }
  expect(pages).toBeGreaterThan(before);
});

it("the small-store check reads at most limit+1 rows of a table", () => {
  const db = table(50);
  expect(storeAtMost(db, ["t"], 50)).toBe(true);
  expect(storeAtMost(db, ["t"], 49)).toBe(false);
  expect(storeAtMost(db, ["t", "t"], 99)).toBe(false);
  expect(storeAtMost(db, ["t", "t"], 100)).toBe(true);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT count(*) AS n FROM (SELECT 1 FROM t LIMIT ?)").all(6).map(row => String(row.detail)).join(" ");
  expect(plan).toMatch(/SCAN t/); // bounded by the LIMIT inside the subquery
});

it("rc13: a page that reads slower than SCAN_PAGE_TARGET_MS is halved for the next (never below SCAN_PAGE_MIN_ROWS), a quick one grows back to the most", () => {
  const db = table(5000);
  let slow = true;
  const sizes: number[] = [];
  const scan = new PagedScan<{ n: number }, number>({
    init: () => ({ n: 0 }),
    page: (handle, cursor, acc, rows) => {
      sizes.push(rows);
      // a page beside the upgrade: every read is slow, whatever its size
      if (slow) { const end = performance.now() + SCAN_PAGE_TARGET_MS + 5; while (performance.now() < end) { /* held */ } }
      const read = handle.prepare("SELECT rowid AS r FROM t WHERE rowid>? ORDER BY rowid LIMIT ?").all(cursor, rows);
      if (!read.length) return null;
      acc.n += read.length; return Number(read[read.length - 1]!.r);
    },
    finish: acc => acc.n,
  }, 1000, 400);
  expect(scan.pageRows).toBe(100);
  for (let i = 0; i < 6; i++) scan.step(db, 0, 0);
  expect(sizes.slice(0, 4)).toEqual([100, 50, 25, SCAN_PAGE_MIN_ROWS]);
  expect(Math.min(...sizes)).toBe(SCAN_PAGE_MIN_ROWS);
  slow = false;
  while (scan.step(db, 0, 0)) { /* the rest of the pass */ }
  expect(scan.result).toBe(5000);
  expect(Math.max(...sizes)).toBe(400);
});
