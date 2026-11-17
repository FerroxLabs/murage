// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RoutineManager, routineWorkCounters } from "./routines.ts";
import { collectionWorkProbe } from "./testing/collection-work-probe.ts";
import { routineHistoryFixture } from "./testing/routine-history-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const roots: string[] = [], managers: RoutineManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.stop(); for (const root of roots.splice(0)) removeTempDirSync(root); });
const drained = () => new Promise<void>(resolve => setImmediate(resolve));
for (const size of [100, 2000]) it(`P3 ${size} protected history: 200 individual completion and follow-up windows`, async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-completion-work-")); roots.push(root);
  const fixture = await routineHistoryFixture(root, size), manager = fixture.manager; managers.push(manager);
  const full = vi.spyOn(manager as unknown as { saveFull(): void }, "saveFull");
  const probe = collectionWorkProbe(), measurements: Array<Record<string, number>> = [];
  probe.discover(manager, "manager"); probe.install(); probe.pause();
  try {
    for (let n = 0; n < 200; n++) {
      // Dispatch is setup for this completion window; P2 measures that path independently.
      const queued = manager.enqueueWebhook({ webhookId: "completion-hook", webhookName: "Fake", prompt: "Fake", botId: "fixture-bot-0", runOn: "ember", deliveryId: String(n), receivedAt: fixture.clock.now });
      await drained();
      const running = manager.runById(queued.id)!;
      expect(running.status).toBe("running");
      for (const key of Object.keys(probe.counts)) delete probe.counts[key];
      for (const key of ["cloneRun", "cloneRoutine", "retired", "expiryServiced", "runsMaterialized", "fullCommits", "recoverySaves", "fullVerifiers", "storeTraversals", "journalLines", "compactCopied"] as const) routineWorkCounters[key] = 0;
      routineWorkCounters.trieCalls = {}; full.mockClear();
      probe.resume();
      try {
        manager.handleRuntimeEvent(fixture.event(running.threadId!, "item.completed", { itemType: "assistant_text", text: "Fake completion" }));
        manager.handleRuntimeEvent(fixture.event(running.threadId!, "turn.completed", { ok: true }));
        await drained(); // All actual queued follow-up tick work precedes the assertion boundary.
      } finally { probe.pause(); }
      for (const key of ["runsMaterialized", "fullCommits", "recoverySaves", "fullVerifiers", "storeTraversals"] as const) expect(routineWorkCounters[key], `${n}:${key}`).toBe(0);
      expect(full.mock.calls.length, `${n}:direct saveFull`).toBe(0);
      expect(routineWorkCounters.cloneRun).toBeLessThanOrEqual(32);
      expect(routineWorkCounters.retired).toBeLessThanOrEqual(32);
      expect(routineWorkCounters.expiryServiced).toBeLessThanOrEqual(routineWorkCounters.retired);
      const calls = Object.values(routineWorkCounters.trieCalls).reduce((sum, value) => sum + value, 0);
      // U<=32 tracked updates, K=32, Z=8, A<=4 for the prescribed two events and their follow-up.
      expect(calls).toBeLessThanOrEqual(32 * (32 + 32 + 8 + 4 + 1));
      for (const label of ["manager.runStore", "manager.liveDispatch", "manager.indexes.runsById", "manager.indexes.indexedRuns", "journal.persisted", "journal.routineLines"]) {
        expect(probe.counts[label]?.next ?? 0, `${n}:${label} iteration`).toBe(0);
        expect(probe.counts[label]?.forEachVisit ?? 0, `${n}:${label} callbacks`).toBe(0);
        const row = probe.counts[label] ?? {};
        expect(["get", "has", "set", "add", "delete", "clear"].reduce((sum, key) => sum + (row[key] ?? 0), 0), `${n}:${label} fixed-input primitive calls`).toBeLessThanOrEqual(32 * 8);
      }
      for (const [label, row] of Object.entries(probe.counts)) {
        expect(row.trieEntries ?? 0, `${n}:${label} full trie entries`).toBe(0);
        expect(row.trieAudit ?? 0, `${n}:${label} full trie audit`).toBe(0);
        if (label.startsWith("manager.ownerView")) for (const key of ["numericRead", "next", "arrayVisit", "arrayFrom", "slice", "sortCompare", "shifted", "truncated"]) expect(row[key] ?? 0, `${n}:owner history view ${key}`).toBe(0);
      }
      const triePrimitiveWork = Object.entries(probe.counts).filter(([label]) => label.includes(".children") || label.endsWith(".work")).reduce((sum, [, row]) => sum + Object.values(row).reduce((a, b) => a + b, 0), 0);
      expect(triePrimitiveWork, `${n}:fixed-width trie primitive ceiling`).toBeLessThanOrEqual(32 * (32 + 32 + 8 + 4 + 1) * 64 * (48 + 1));
      const scalars = probe.counts["serialization.scalar"] ?? {};
      expect(scalars.stringify ?? 0, `${n}:at most 32 metadata updates of 128 scalar fields`).toBeLessThanOrEqual(32 * 128);
      expect(scalars.stringifyBytes ?? 0, `${n}:fixed scalar metadata bytes`).toBeLessThanOrEqual(32 * 2500);
      const other = probe.counts.other ?? {};
      const payload = probe.counts["routine.payload"] ?? {};
      expect(Object.entries(payload).filter(([key]) => !key.endsWith("Bytes")).reduce((sum, [, value]) => sum + value, 0), `${n}:32 updates plus 32 clones of 128 fields`).toBeLessThanOrEqual(64 * 128);
      expect(payload.objectkeys ?? 0, `${n}:at most 32 changed-record clone inputs of 128 fields`).toBeLessThanOrEqual(32 * 128);
      expect(payload.stringifyBytes ?? 0, `${n}:fixed changed record bytes`).toBeLessThanOrEqual(32 * 2500);
      if (Object.entries(other).filter(([key]) => !key.endsWith("Bytes")).reduce((sum, [, value]) => sum + value, 0) > 1024) console.info("completion_unclassified", JSON.stringify(other));
      expect(Object.entries(other).filter(([key]) => !key.endsWith("Bytes")).reduce((sum, [, value]) => sum + value, 0), `${n}:fixed-input unclassified work`).toBeLessThanOrEqual(1024);
      expect(other.stringifyBytes ?? 0, `${n}:fixed changed payload bytes`).toBeLessThanOrEqual(32 * 2500);
      // At most eight durable saves in this fixed stimulus; each may synchronously copy <=256 lines.
      expect(routineWorkCounters.journalLines).toBeLessThanOrEqual(32);
      expect(routineWorkCounters.compactCopied).toBeLessThanOrEqual(8 * 256);
      measurements.push({ operation: n, retainedBaseline: size, clones: routineWorkCounters.cloneRun, retired: routineWorkCounters.retired, journalLines: routineWorkCounters.journalLines, compactCopied: routineWorkCounters.compactCopied, trieCalls: calls, triePrimitiveWork, unclassifiedWork: Object.entries(other).filter(([key]) => !key.endsWith("Bytes")).reduce((sum, [, value]) => sum + value, 0), scalarSerializations: scalars.stringify ?? 0, payloadFieldVisits: payload.objectkeys ?? 0 });
      probe.rediscover(manager, "manager"); // Full post-window replacement/array coverage, never hidden production work.
      fixture.dispatched.length = 0;
      if ((n + 1) % 20 === 0) console.info("completion_work", JSON.stringify({ history: size, completed: n + 1 }));
    }
  } finally { probe.uninstall(); }
  expect(manager.verifyIndexes(true)).toEqual([]);
  writeFileSync(join(process.env.RHIST_EVIDENCE_DIR ?? tmpdir(), `s4-B-completion-measurements-${size}.json`), JSON.stringify(measurements, null, 2));
}, 1_800_000);
