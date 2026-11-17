// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RoutineManager, routineWorkCounters, isLiveRoutineRunStatus, isOpenRoutineRunStatus, type RoutineRun } from "./routines.ts";
import { collectionWorkProbe } from "./testing/collection-work-probe.ts";
import { routineHistoryFixture } from "./testing/routine-history-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const roots: string[] = [], managers: RoutineManager[] = [];
const dir = () => { const root = mkdtempSync(join(tmpdir(), "murage-accessor-parity-")); roots.push(root); return root; };
afterEach(() => { for (const manager of managers.splice(0)) manager.stop(); for (const root of roots.splice(0)) removeTempDirSync(root); });
type Internals = { replaceStore(runs: Iterable<RoutineRun>): void; recoverPersistence(): void; runStore: Set<RoutineRun>; indexes: { cardRuns: Map<string, { size: number }> }; verifyIndexes(): string[] };
function setHistory(manager: RoutineManager, runs: RoutineRun[]) { (manager as unknown as Internals).replaceStore(runs); }
function resetCounters() { for (const key of Object.keys(routineWorkCounters)) if (key !== "trieCalls") (routineWorkCounters as unknown as Record<string, unknown>)[key] = 0; routineWorkCounters.trieCalls = {}; }

it("P17/P21/P22/P26 200 randomized valid histories preserve list-first, strict-start, event miss and clone semantics", async () => {
  const fixture = await routineHistoryFixture(dir(), 100); managers.push(fixture.manager);
  let random = 71;
  const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
  const statuses = ["queued", "running", "waiting", "needs-you", "completed", "failed"] as const;
  for (let round = 0; round < 200; round++) {
    const input = Array.from({ length: 16 }, (_, n) => ({ ...fixture.runs[n % 100], id: `parity-${n}`, threadId: `thread-${next() % 4}`, routineId: fixture.definitions[n % 10].id,
      status: statuses[next() % statuses.length], scheduledFor: next() % 10, startedAt: next() % 5 === 0 ? undefined : next() % 8, createdAt: next() % 8,
      cardsOpen: next() % 2 ? ["shared"] : undefined, event: { id: `event-${next() % 4}` } as RoutineRun["event"],
    }));
    setHistory(fixture.manager, input);
    const sorted = fixture.manager.listRuns();
    for (let t = 0; t < 4; t++) {
      const thread = `thread-${t}`, live = sorted.find(run => run.threadId === thread && isLiveRoutineRunStatus(run.status));
      expect(fixture.manager.newestLiveRunInThread(thread)?.id).toBe(live?.id);
      const card = sorted.find(run => run.threadId === thread && isOpenRoutineRunStatus(run.status) && run.cardsOpen?.includes("shared"));
      expect(fixture.manager.runWithOpenCard(thread, "shared")?.id).toBe(card?.id);
      const eventId = `event-${t}`;
      expect(fixture.manager.automationRunFor(thread, eventId)?.id).toBe(sorted.find(run => run.threadId === thread && (run.id === eventId || run.event?.id === eventId))?.id);
      expect(fixture.manager.automationRunFor(thread, "missing")).toBeUndefined();
      const running = sorted.filter(run => run.threadId === thread && run.status === "running").sort((a, b) => (b.startedAt ?? b.createdAt ?? 0) - (a.startedAt ?? a.createdAt ?? 0) || b.id.localeCompare(a.id))[0];
      expect(fixture.manager.automationRunFor(thread)?.id).toBe(running?.id);
      for (const after of [-0, 1, 6]) {
        const routineId = fixture.definitions[t].id;
        const expected = sorted.filter(run => run.routineId === routineId && typeof run.startedAt === "number" && Number.isFinite(run.startedAt) && run.startedAt > after).sort((a,b) => a.startedAt! - b.startedAt!)[0]?.startedAt;
        expect(fixture.manager.nextRunStartAfter({ id: "synthetic", routineId, startedAt: after })).toBe(expected);
      }
    }
    for (const routine of fixture.definitions) expect(fixture.manager.hasStartedRun(routine.id)).toBe(sorted.some(run => run.routineId === routine.id && run.startedAt !== undefined));
    const clone = fixture.manager.runById(input[0].id)!; clone.output = "changed clone";
    expect(fixture.manager.runById(input[0].id)?.output).not.toBe("changed clone");
  }
  expect(fixture.manager.verifyIndexes()).toEqual([]);
}, 120_000);

it("P34 2000 settled card holders plus two open holders select one ordered maximum without bucket traversal", async () => {
  const fixture = await routineHistoryFixture(dir(), 2000); managers.push(fixture.manager);
  const settled = fixture.runs.map(run => ({ ...run, threadId: "shared-thread", cardsOpen: ["same"] }));
  const first = { ...settled[0], id: "open-first", status: "waiting" as const, scheduledFor: 20_000_000_000_000 };
  const second = { ...settled[1], id: "open-newest", status: "needs-you" as const, scheduledFor: 30_000_000_000_000 };
  setHistory(fixture.manager, [...settled, first, second]);
  const internals = fixture.manager as unknown as Internals, key = JSON.stringify(["shared-thread", "same"]);
  expect(internals.runStore.size).toBe(2002); expect(internals.indexes.cardRuns.get(key)?.size).toBe(2);
  internals.recoverPersistence(); // Owner fixture replacement is durably initialized outside measurement.
  const probe = collectionWorkProbe(); probe.discover(fixture.manager, "manager"); resetCounters();
  let selected: RoutineRun | null;
  probe.install(); try { selected = fixture.manager.runWithOpenCard("shared-thread", "same"); } finally { probe.uninstall(); }
  expect(selected!.id).toBe("open-newest"); expect(routineWorkCounters.cloneRun).toBe(1);
  expect(Object.entries(routineWorkCounters.trieCalls).filter(([key]) => key.startsWith("latest:")).reduce((sum, [, n]) => sum + n, 0)).toBe(1);
  for (const [label, row] of Object.entries(probe.counts)) if (label.includes("cardRuns")) { expect(row.forEachVisit ?? 0).toBe(0); expect(row.next ?? 0, "card maximum does not enumerate its bucket").toBe(0); }
  const canonical = (id: string) => [...internals.runStore].find(run => run.id === id)!;
  fixture.manager.cardClosed("shared-thread", "same");
  expect(fixture.manager.runById(second.id)?.cardsOpen).toBeUndefined();
  expect(fixture.manager.runWithOpenCard("shared-thread", "same")?.id).toBe("open-first");
  canonical(second.id).cardsOpen = ["same"]; canonical(second.id).status = "needs-you";
  canonical(second.id).status = "completed";
  expect(fixture.manager.runWithOpenCard("shared-thread", "same")?.id).toBe("open-first");
  canonical(first.id).threadId = "moved";
  expect(fixture.manager.runWithOpenCard("shared-thread", "same")).toBeNull();
  expect(fixture.manager.runWithOpenCard("moved", "same")?.id).toBe("open-first");
  canonical(first.id).cardsOpen = ["other"];
  expect(fixture.manager.runWithOpenCard("moved", "same")).toBeNull();
  expect(fixture.manager.verifyIndexes()).toEqual([]);
}, 180_000);
