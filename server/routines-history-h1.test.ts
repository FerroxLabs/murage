// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: rhist-s1b owns this proof; rhist-h1 owns the memory-only accessor and route fix.
// H1 is gated; the deferred history slices remain explicit design reds.
import { expect, it } from "vitest";
import { historyMeasurements } from "./testing/routine-history-http.ts";

for (const kind of ["chats", "search"]) for (const state of ["cold", "warm", "after-write"]) it(`H1 ${kind} ${state}: lookup work follows C=80 candidates, independently of N`, () => {
  const rows = historyMeasurements.filter(row => row.work && row.path === `H1 ${kind} ${state}`);
  expect(rows.map(row => row.size)).toEqual([10, 2_000, 10_000]);
  const cap = kind === "chats" ? 80 : 160;
  for (const row of rows) {
    expect.soft(row.rebuilds, `no history rebuild @${row.size}`).toBe(0);
    expect.soft(row.before).toBe(row.size); expect.soft(row.after).toBe(row.size);
    expect.soft(row.lookupCalls, `candidate lookups @${row.size}`).toBe(cap);
    for (const key of ["storeTraversals", "storeVisits", "runsMaterialized", "cloneRun", "journalFullTraversals", "trieEnumerations", "indexTraversals", "indexVisits", "serializedRuns", "retainedMapTraversals", "retainedMapVisits", "fullCommits"] as const)
      expect.soft(row.work![key], `${row.path}@${row.size}: ${key}=0`).toBe(0);
    expect.soft(row.work!.trieCalls, `one constant trie lookup per candidate @${row.size}`).toBeLessThanOrEqual(cap);
    for (const key of ["trieCalls", "runArrayVisits", "runSortComparisons"] as const)
      expect.soft(row.work![key], `${row.path}: ${key} identical at every N`).toBe(rows[0].work![key]);
  }
});
