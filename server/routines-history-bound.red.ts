// SPDX-License-Identifier: AGPL-3.0-or-later
// Skip-free S1 design proof. Explicit entrypoint: server/testing/routine-history-bound.config.mjs.
// Owners: rhist-s1b owns measurements/assertions; MAIN owns deferred 1.0.20 production scheduling.
import { expect, it } from "vitest";
import { historyMeasurements } from "./testing/routine-history-http.ts";

for (const id of ["H2", "H3", "H4", "H5", "H6", "H7", "H8", "F1", "W1", "R1"]) it(`${id} retained history never enters an ordinary operation`, () => {
  const records = historyMeasurements.filter(row => row.work && row.path.startsWith(id));
  expect(records.length, `${id} measured at both scales`).toBeGreaterThanOrEqual(2);
  for (const row of records) {
    const work = row.work!, label = `${row.path}@${row.size}`;
    expect.soft(row.rows, `${label}: proposed page exists`).toBeGreaterThanOrEqual(0);
    expect.soft(work.storeTraversals, `${label}: no store enumeration`).toBe(0);
    expect.soft(work.storeVisits, `${label}: no retained store visits`).toBe(0);
    expect.soft(work.runsMaterialized, `${label}: no owner view`).toBe(0);
    expect.soft(work.journalFullTraversals, `${label}: no full journal traversal`).toBe(0);
    const rows = Math.max(0, row.rows);
    // Fixed ten definitions plus changed/returned rows; hydrate has a 300-row newest page.
    const bound = row.path === "H2 hydrate" ? 300 + 10 + 3 : rows + 10;
    expect.soft(work.runArrayVisits, `${label}: record visits follow output/live work`).toBeLessThanOrEqual(16 * bound);
    expect.soft(work.runSortComparisons, `${label}: record sorting follows bounded output`).toBeLessThanOrEqual(16 * bound);
    expect.soft(work.cloneRun, `${label}: copies follow output/live work`).toBeLessThanOrEqual(4 * bound);
    expect.soft(work.serializedRuns, `${label}: serializers follow output/live work`).toBeLessThanOrEqual(4 * bound);
    expect.soft(work.trieCalls, `${label}: fixed-width index calls`).toBeLessThanOrEqual(64 * bound);
    if (row.path === "H2 hydrate") expect.soft(row.rows, `${label}: hydrate window`).toBeLessThanOrEqual(313);
    if (row.path === "H8 legacy" || row.path === "H8 fallback and start") expect.soft(row.rows, `${label}: latest per routine`).toBeLessThanOrEqual(10);
  }
  const paths = new Set(records.map(row => row.path));
  for (const path of paths) {
    const scales = records.filter(row => row.path === path);
    const small = scales[0];
    for (const large of scales.slice(1)) {
    // Compare identical stimuli and output cardinalities. A ten-row history cannot return a 300-row page.
    if (small.rows !== large.rows) continue;
    for (const key of ["runArrayVisits", "runSortComparisons", "storeVisits", "storeTraversals", "cloneRun", "serializedRuns", "runsMaterialized", "journalFullTraversals", "fullCommits", "trieCalls"] as const)
      expect.soft(large.work![key], `${path}: ${key} identical at 10/10000`).toBe(small.work![key]);
    }
  }
});
