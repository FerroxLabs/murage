// SPDX-License-Identifier: AGPL-3.0-or-later
// rc13 round 3 (M2): the memory status, the idle lanes and the claim index key on one reading of "the history upgrade runs": the background
// upgrade or the transcript backfill. The status keyed on the upgrade alone, so it read its tables live while the lanes still held back.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { historyUpgradeRunning } from "./database.ts";

it("is true while either the upgrade or the transcript backfill runs", () => {
  expect(historyUpgradeRunning({ upgrade: () => false, backfill: () => false })).toBe(false);
  expect(historyUpgradeRunning({ upgrade: () => true, backfill: () => false })).toBe(true);
  expect(historyUpgradeRunning({ upgrade: () => false, backfill: () => true })).toBe(true);
  // the process's own reading: nothing runs in a bare test process
  expect(historyUpgradeRunning()).toBe(false);
});

it("every server caller that yields to the upgrade uses the same reading", () => {
  const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  const sites = [...source.matchAll(/[uU]pgradeRunning\s*[:(]\s*(?:\(\)\s*=>\s*)?([A-Za-z]+)/g)].map(m => m[1]);
  // memoryClaimIndex.setUpgradeRunning, the memory worker's upgradeRunning, the memory status route's upgradeRunning
  expect(sites.length).toBeGreaterThanOrEqual(3);
  expect(new Set(sites)).toEqual(new Set(["historyUpgradeRunning"]));
  expect(source).not.toMatch(/upgradeRunning\s*:\s*backgroundUpgradeRunning\b/);
});
