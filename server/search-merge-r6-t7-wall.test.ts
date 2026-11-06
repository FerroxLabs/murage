// SPDX-License-Identifier: AGPL-3.0-or-later
// SMOOTH-FTS T7, wall-clock half (NON-BLOCKING, ci/extended-tests.txt). The blocking T7 in search-merge-r6.test.ts counts index work per insert
// deterministically; this file reads the 20 ms insert-commit budget on the clock. Wall time is not reliable on a shared host (load ~8.5 on
// build host failed it 5 of 5), so it only shows. The budget is unchanged: warm-up, then best of 3 chunks, with a slow-insert mutation proof.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { closeMessageDb, insertMessage } from "./message-db.ts";
import { afterCommit } from "./tx-scope.ts";
import { searchMergeFastPath, searchMergeTestHooks, SEARCH_MERGE_PAGES } from "./search-merge-runner.ts";
import { stopWalMaintenance, walMaintenanceReady, walMaintenanceTestHooks } from "./wal-maintenance.ts";
import type { Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { ftsLevels, spread } from "./testing/search-merge-fixtures.ts";

let clock = 1_000;
const msg = (id: string, text: string): Message => ({ id, role: "user", kind: "text", text, at: ++clock });

function resetHooks() {
  searchMergeTestHooks.onEvent = null; searchMergeTestHooks.halt = false; searchMergeTestHooks.kickMs = 10; searchMergeTestHooks.startPages = SEARCH_MERGE_PAGES;
  searchMergeTestHooks.backoffFirstMs = 200; searchMergeTestHooks.replyLostMs = 60_000; searchMergeTestHooks.segments = false;
  walMaintenanceTestHooks.retryMs = 50; walMaintenanceTestHooks.holdMs = 0; walMaintenanceTestHooks.restartDelaysMs = [50, 100, 200];
  walMaintenanceTestHooks.failPragma = null;
}
beforeEach(async () => {
  closeMessageDb(); closeDatabase(); await stopWalMaintenance();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  resetHooks();
});
afterEach(async () => { resetHooks(); searchMergeTestHooks.kickMs = 250; walMaintenanceTestHooks.retryMs = 30_000; walMaintenanceTestHooks.restartDelaysMs = [1000, 5000, 30_000, 120_000, 300_000]; closeMessageDb(); closeDatabase(); await stopWalMaintenance(); });

async function ready() {
  const db = database();
  await vi.waitFor(() => { expect(walMaintenanceReady()).toBe(true); expect(searchMergeFastPath()).toBe(true); }, { timeout: 10_000 });
  return db;
}

describe("T7 wall: with automerge=0 the worker's positive slices keep the levels low", () => {
  it("5,000 inserts at a steady cadence: no level reaches 16 while the worker is up and no insert commit takes over 20 ms; stopped, the crossing COMMIT is timed and reported", { tags: ["nightly"], timeout: 400_000 }, async () => {
    searchMergeTestHooks.kickMs = 250; // production kick
    const db = await ready();
    // the same connection's bare commit cost (synchronous=FULL, one fsync), with no index write: the floor under every insert below
    db.exec("CREATE TABLE IF NOT EXISTS t7_floor(n INTEGER)");
    const floor: number[] = [];
    for (let i = 0; i < 300; i++) { const began = performance.now(); db.exec("BEGIN IMMEDIATE"); db.prepare("INSERT INTO t7_floor VALUES(?)").run(i); db.exec("COMMIT"); floor.push(performance.now() - began); await new Promise(resolve => setTimeout(resolve, 20)); }
    // The 20 ms budget is read on a quiet core: 200 warm-up inserts are not scored, then three chunks of whole inserts (the whole run is
    // still 5,000 inserts for the level checks) and the budget is the BEST chunk's slowest commit (the fastestRunOf idea, inline). A budget the code
    // really misses (a slow commit, a foreground crisismerge) is over it in every chunk; a host stall (CPU steal, a disk flush) lands in one.
    const ms: number[] = [];
    let highest = 0, highestLevel0BeforeCommit = 0;
    const runChunk = async (count: number, slowMs = 0): Promise<number[]> => {
      const commit: number[] = [];
      for (let i = 0; i < count; i++) {
        const began = performance.now();
        let opStart = 0, opEnd = 0, committed = 0;
        transaction(() => {
          if (slowMs) { const until = performance.now() + slowMs; while (performance.now() < until) { /* deliberately slow insert (mutation proof) */ } }
          opStart = performance.now();
          highestLevel0BeforeCommit = Math.max(highestLevel0BeforeCommit, ftsLevels(db)[0]?.segments ?? 0);
          insertMessage(`t${i % 7}`, msg(`m${seq}`, `steady insert ${seq} delta echo foxtrot ${seq * 17}`));
          afterCommit(() => { committed = performance.now(); });
          opEnd = performance.now();
        });
        seq++;
        ms.push(performance.now() - began);
        // the insert's commit: the wait for the write lock (BEGIN IMMEDIATE, where a worker slice can hold it) plus the COMMIT itself
        commit.push((opStart - began) + (committed - opEnd));
        highest = Math.max(highest, ...ftsLevels(db).map(level => level.segments));
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return commit;
    };
    let seq = 0;
    await runChunk(200); // warm-up: statement cache, page cache and the first worker slices; not scored
    const chunks: number[][] = [];
    for (let c = 0; c < 3; c++) chunks.push(await runChunk(1600));
    const chunkMax = chunks.map(chunk => Math.max(...chunk));
    const commit = chunks.flat();
    const levels = ftsLevels(db);
    console.log(`[T7] commit floor ${JSON.stringify(spread(floor))} insert lock-wait+commit ${JSON.stringify(spread(commit))} chunk max ms=${JSON.stringify(chunkMax.map(x => +x.toFixed(2)))} over20=${commit.filter(x => x > 20).length} insert wall ${JSON.stringify(spread(ms))} highest level segments=${highest} level 0 before a commit at most=${highestLevel0BeforeCommit} levels=${JSON.stringify(levels.map(l => l.segments))}`);
    expect(highest).toBeLessThan(16);
    expect(highestLevel0BeforeCommit, "no foreground commit could cross the crisismerge threshold").toBeLessThan(15);
    expect(Math.min(...chunkMax), "the best chunk's slowest insert commit").toBeLessThanOrEqual(20);
    // mutation proof: the same scoring fails when every insert is deliberately slow (25 ms before its commit), in every chunk
    const slowChunks: number[][] = [];
    for (let c = 0; c < 3; c++) slowChunks.push(await runChunk(20, 25));
    expect(Math.min(...slowChunks.map(chunk => Math.max(...chunk))), "a deliberately slow insert must fail the budget").toBeGreaterThan(20);
    // the worker stopped (no merge op posted): inserts until level 0 crosses 16 and crisismerge fires inside a COMMIT
    searchMergeTestHooks.halt = true;
    let crossing = -1, crossingMs = 0;
    for (let i = 0; i < 64 && crossing < 0; i++) {
      const before = ftsLevels(db)[0]?.segments ?? 0;
      const began = performance.now();
      insertMessage("crisis", msg(`c${i}`, `crisis insert ${i} golf hotel`));
      const took = performance.now() - began;
      const after = ftsLevels(db)[0]?.segments ?? 0;
      if (after < before) { crossing = i; crossingMs = took; }
    }
    console.log(`[T7] worker stopped: crisismerge COMMIT after ${crossing + 1} inserts took ${crossingMs.toFixed(2)} ms (reported, not budgeted)`);
    expect(crossing).toBeGreaterThanOrEqual(0);
  });
});
