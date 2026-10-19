// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.3 lane 3 (stall r1): the lineage warmer's message scan page follows time (lineageScanPageRows): halved after a page slower than the target,
// down to its floor and never below; doubled back after quick pages, up to its cap. Untested before.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { bumpLineageWarm, lineageScanPageRows, lineageWarmIdle, lineageWarmStep, resetLineageWarmForTest, SCAN_PAGE_TARGET_MS } from "./lineage-warm.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { forgetKeptLineageForTest, thawRootSetWritesForTest } from "./replay-lineage.ts";
import { setMemoryMode } from "./repository.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
const thread = "conv-scan";
beforeEach(() => { thawRootSetWritesForTest(true); resetLineageWarmForTest(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { vi.restoreAllMocks(); thawRootSetWritesForTest(false); });

it("halves the page after slow pages down to its floor, and doubles it back after quick ones up to its cap", () => {
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
  const db = database();
  db.exec(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<20000)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT '${thread}','m'||n,n,'user','text','x','{}' FROM seq`);
  closeDatabase(); forgetKeptLineageForTest(); resetLineageWarmForTest(); database();
  const cap = lineageScanPageRows();
  bumpLineageWarm(thread);
  // every page looks like 30 ms: each one halves the next
  let clock = 0, step = SCAN_PAGE_TARGET_MS + 10;
  vi.spyOn(performance, "now").mockImplementation(() => (clock += step));
  const slow: number[] = [];
  for (let n = 0; n < 8; n++) { expect(lineageWarmStep(50)).toBe(true); slow.push(lineageScanPageRows()); }
  for (let n = 1; n < slow.length; n++) expect(slow[n]).toBeLessThanOrEqual(slow[n - 1]!);
  expect(slow[0]).toBeLessThanOrEqual(cap / 2);
  const floor = slow.at(-1)!;
  expect(floor).toBeGreaterThan(0);
  expect(slow.at(-2)).toBe(floor); // it stops at the floor
  // quick pages (1 ms apart on the clock): doubled back, never past the cap, and the thread's scan runs to its end
  step = 1;
  const quick: number[] = [];
  for (let n = 0; n < 2_000 && lineageWarmStep(50); n++) quick.push(lineageScanPageRows());
  expect(Math.max(...quick, lineageScanPageRows())).toBe(cap);
  expect(lineageWarmIdle()).toBe(true);
});
