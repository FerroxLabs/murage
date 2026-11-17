// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { directRoutineHistoryFixture, historyInside } from "./testing/routine-history-fixture.ts";
import { measureHistoryWork } from "./testing/routine-history-work.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

it("S1 probe catches iteration, cached clones, serialization and a replacement store without method scopes", async () => {
  const root = mkdtempSync(join(tmpdir(), "routine-history-probe-"));
  const { manager } = directRoutineHistoryFixture(root, 10), inside = historyInside(manager);
  try {
    manager.listRuns(); // The owner view is warm; clones must still be counted.
    const copied = await measureHistoryWork(manager, () => manager.listRuns());
    expect(copied.work.storeVisits).toBe(0); expect(copied.work.cloneRun).toBe(10);
    const measured = await measureHistoryWork(manager, () => {
      for (const _run of inside.runStore) { /* real iterator work */ }
      inside.runStore.forEach(() => {});
      JSON.stringify(manager.listRuns());
      [...inside.liveDispatch]; // Even an empty retained-map enumeration is observable.
    });
    expect(measured.work.storeTraversals).toBe(2); expect(measured.work.storeVisits).toBe(20);
    expect(measured.work.retainedMapTraversals).toBe(1); expect(measured.work.serializedRuns).toBe(10);
    const list = manager.listRuns(); inside.replaceStore(list);
    const replacement = await measureHistoryWork(manager, () => Array.from(inside.runStore.values()));
    expect(replacement.work.storeTraversals).toBe(1); expect(replacement.work.storeVisits).toBe(10);
  } finally { manager.stop(); removeTempDirSync(root); }
});

it("S1 labels every index field and observes collections replaced during a window", async () => {
  const root = mkdtempSync(join(tmpdir(), "routine-history-replacement-"));
  const { manager } = directRoutineHistoryFixture(root, 10), inside = historyInside(manager);
  try {
    const { workCollectionLabel } = await import("./work-collections.ts");
    for (const [field, collection] of Object.entries(inside.indexes)) expect(workCollectionLabel(collection)).toBe(`routines.indexes.${field}`);
    const list = manager.listRuns();
    const replacement = await measureHistoryWork(manager, () => {
      inside.replaceStore(list);
      [...inside.runStore]; inside.runStore.forEach(() => {});
      [...inside.indexes.runsById]; inside.indexes.runsById.forEach(() => {});
      [...inside.indexes.openRuns];
      [...inside.indexes.scheduledAll.entries()];
    });
    expect(replacement.work.storeTraversals).toBeGreaterThanOrEqual(2);
    expect(replacement.work.storeVisits).toBeGreaterThanOrEqual(20);
    expect(replacement.work.indexTraversals).toBeGreaterThanOrEqual(3);
    expect(replacement.work.indexVisits).toBeGreaterThanOrEqual(20);
    expect(replacement.work.retainedMapVisits).toBeGreaterThanOrEqual(20);
    expect(replacement.work.trieEnumerations).toBeGreaterThan(0);
  } finally { manager.stop(); removeTempDirSync(root); }
});

it("S1 legacy completion guards and identity labels share real index counters", async () => {
  const root = mkdtempSync(join(tmpdir(), "routine-history-alias-"));
  const { manager } = directRoutineHistoryFixture(root, 10), inside = historyInside(manager);
  try {
    const { collectionWorkProbe } = await import("./testing/collection-work-probe.ts");
    const probe = collectionWorkProbe(); probe.discover(manager, "manager");
    const run = inside.indexes.runsById.get("history-run-0")!;
    probe.measure(() => {
      for (let n = 0; n < 300; n++) { inside.indexes.runsById.get(run.id); inside.indexes.indexedRuns.get(run); }
      [...inside.indexes.runsById]; [...inside.indexes.indexedRuns];
    });
    for (const field of ["runsById", "indexedRuns"]) {
      const row = probe.counts[`manager.indexes.${field}`];
      expect(row).toBe(probe.counts[`routines.indexes.${field}`]);
      expect(row.get).toBe(300); expect(row.next).toBe(11);
    }
  } finally { manager.stop(); removeTempDirSync(root); }
});
