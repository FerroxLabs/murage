// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { historyMeasurements, measureOrdinaryOwnerTurn, measureRoutineOwnerTurn } from "./testing/routine-history-http.ts";

it("S1 measures every ordinary history consumer at all three scales and an uninstrumented timing pass", () => {
  const paths = new Set(historyMeasurements.map(row => row.path));
  expect(paths.size).toBe(45);
  for (const path of paths) {
    expect(historyMeasurements.filter(row => row.path === path && row.work).map(row => row.size)).toEqual([10, 2_000, 10_000]);
    const timings = historyMeasurements.filter(row => row.path === path && !row.work);
    expect([...new Set(timings.map(row => row.size))]).toEqual([10, 2_000, 10_000]);
    if (path.startsWith("H1")) for (const size of [10, 2_000, 10_000]) expect(timings.filter(row => row.size === size)).toHaveLength(20);
  }

});

it("S1 counts H1 cache rebuilds during an actual ordinary owner turn", async () => {
  expect(await measureOrdinaryOwnerTurn()).toBeGreaterThanOrEqual(0);
}, 60000);

it("S1 counts H1 rebuilds for a real routine turn with a chat refresh on each run broadcast", async () => {
  const measured = await measureRoutineOwnerTurn();
  expect(measured.refreshes).toBeGreaterThan(0);
  expect(measured.rebuilds).toBeGreaterThanOrEqual(0);
  expect(measured.rebuilds).toBeLessThanOrEqual(measured.refreshes);
}, 60000);

for (const path of ["B15 bot roster aggregates", "F2 owed delivery retry"]) it(`${path} follows live or owed work, never retained history`, () => {
  const rows = historyMeasurements.filter(row => row.path === path && row.work);
  expect(rows.map(row => row.size)).toEqual([10, 2_000, 10_000]);
  for (const row of rows) for (const key of ["storeTraversals", "storeVisits", "runsMaterialized", "trieEnumerations", "journalFullTraversals"] as const)
    expect(row.work![key], `${path}@${row.size}: ${key}`).toBe(0);
  for (const row of rows) {
    expect(row.work!.cloneRun).toBe(path.startsWith("F2") ? 3 : 0);
    if (path.startsWith("F2")) expect(row.rows).toBe(3);
    for (const key of ["cloneRun", "trieCalls", "runArrayVisits", "runSortComparisons", "serializedRuns"] as const)
      expect(row.work![key], `${path}: ${key} identical at every N`).toBe(rows[0].work![key]);
  }
});

for (const size of [10, 2000, 10000]) it(`H1 real owner and routine turns at ${size} retain zero chat-list rebuilds`, async () => {
  expect(await measureOrdinaryOwnerTurn(size)).toBe(0);
  const measured = await measureRoutineOwnerTurn(size);
  expect(measured.refreshes).toBeGreaterThan(0); expect(measured.rebuilds).toBe(0);
}, 120000);
