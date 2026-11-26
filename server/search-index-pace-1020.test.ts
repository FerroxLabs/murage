// SPDX-License-Identifier: AGPL-3.0-or-later
// recallcap-1020-n3d: the search index rebuild after a reset re-indexed every message at 4-11 GB/min on an owner start
// (owner copy: one worker thread wrote 17 GB in minutes 1-3). The worker reports each step's measured write bytes and the
// parent spaces steps at SEARCH_WRITE_BYTES_PER_MIN. Real worker, real search.db, real rebuild; the meter is the process's
// own write syscalls (/proc/self/io wchar), independent of what the worker reports.
import { removeTempDirSync } from "./testing/cleanup.ts";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { initializeMessageTables } from "./message-tables.ts";
import * as search from "./message-search-index.ts";
import * as wal from "./wal-maintenance.ts";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  search.searchIndexTestHooks.event = null;
  await search.stopSearchIndex();
  await wal.stopWalMaintenance(100, 1000);
  for (const f of cleanup.splice(0).reverse()) await f();
});
const wchar = () => existsSync("/proc/self/io") ? Number(/wchar: (\d+)/.exec(readFileSync("/proc/self/io", "utf8"))![1]) : NaN;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

it("W-SEARCH-PACE: a full search rebuild writes at most SEARCH_WRITE_BYTES_PER_MIN, measured, and reports honest bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murage-search-pace-")); cleanup.push(() => removeTempDirSync(dir));
  const file = join(dir, "messages.db"), db = new DatabaseSync(file); cleanup.push(() => db.close());
  db.exec("PRAGMA journal_mode=WAL;PRAGMA secure_delete=ON;PRAGMA journal_size_limit=0");
  initializeMessageTables(db);
  // 30k distinct ~1 KB messages: the rebuild needs far more than the 8 s window at the paced rate.
  db.prepare(`WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<30000)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT 'history'||(x%40),CAST(x AS TEXT),x,'user','text',hex(randomblob(512)),'{}' FROM n`).run();
  const steps: Array<{ at: number; bytes: number; worked: boolean; rebuilding: boolean }> = [];
  search.searchIndexTestHooks.event = (e: { type: string; bytes?: number; worked?: boolean; rebuilding?: boolean }) => {
    if (e.type === "stepped") steps.push({ at: performance.now(), bytes: Number(e.bytes), worked: !!e.worked, rebuilding: !!e.rebuilding });
  };
  search.startSearchIndex(db, file);
  // Wait until the rebuild is actually running, then meter a fixed window.
  const until = performance.now() + 20_000;
  while (!steps.some(s => s.rebuilding && s.worked) && performance.now() < until) await sleep(20);
  expect(steps.some(s => s.rebuilding && s.worked), "rebuild started").toBe(true);
  const w0 = wchar(), t0 = performance.now(), first = steps.length;
  await sleep(8_000);
  const w1 = wchar(), minutes = (performance.now() - t0) / 60_000, window = steps.slice(first);
  const reported = window.reduce((n, s) => n + (Number.isFinite(s.bytes) ? s.bytes : 0), 0);
  const measuredMBmin = (w1 - w0) / 1048576 / minutes, reportedMBmin = reported / 1048576 / minutes;
  const limitMBmin = search.SEARCH_WRITE_BYTES_PER_MIN / 1048576;
  console.log(`[W-SEARCH-PACE] measured ${measuredMBmin.toFixed(1)} MB/min (wchar), reported ${reportedMBmin.toFixed(1)} MB/min, limit ${limitMBmin} MB/min, steps ${window.length}`);
  // Literal design number: 256 MiB/min, never the constant under test alone.
  expect(limitMBmin).toBe(256);
  // Honest bytes: every worked step reports a positive measured cost, and the reported total covers the file the rebuild grew.
  expect(window.filter(s => s.worked).length).toBeGreaterThan(0);
  expect(window.filter(s => s.worked).every(s => Number.isFinite(s.bytes) && s.bytes > 0), "worked steps report bytes").toBe(true);
  expect(steps.reduce((n, s) => n + (s.bytes || 0), 0)).toBeGreaterThanOrEqual(statSync(join(dir, "search.db")).size / 2);
  // Spacing: a step that wrote N bytes is followed by a gap of at least N / rate (5 ms timer slack).
  for (let i = 1; i < window.length; i++) if (window[i - 1].worked)
    expect(window[i].at - window[i - 1].at + 5, `gap after step ${i - 1}`).toBeGreaterThanOrEqual(window[i - 1].bytes * 60_000 / search.SEARCH_WRITE_BYTES_PER_MIN);
  // Measured rate (process write syscalls, includes everything this test process wrote) within the limit plus one 4 MiB batch of slack.
  if (Number.isFinite(measuredMBmin)) expect(measuredMBmin, "measured MB/min").toBeLessThanOrEqual(limitMBmin * 1.15 + 8 / minutes);
}, 60_000);

