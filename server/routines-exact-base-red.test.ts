// SPDX-License-Identifier: AGPL-3.0-or-later
// Uses the pre-port public API so the same assertions run at the release base.
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { RoutineManager, type RoutineManagerOptions } from "./routines.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const NOW = 1_800_000_000_000, roots: string[] = [], managers: RoutineManager[] = [];
afterEach(() => { vi.restoreAllMocks(); managers.splice(0).forEach(m => m.stop()); roots.splice(0).forEach(root => removeTempDirSync(root)); });
function fixture(extra: Partial<RoutineManagerOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "murage-core-exact-red-")); roots.push(root); const clock = { now: NOW };
  const file = join(root, "routines.json"), runs = Array.from({ length: 100 }, (_, i) => ({ id: `old-${i}`, routineId: "history", routineName: "History", botId: "bot", threadId: `old-thread-${i}`, target: "bot", runOn: "ember", scheduledFor: NOW - i, startedAt: NOW - i, createdAt: NOW - i, status: "completed", finishedAt: NOW - i }));
  writeFileSync(file, JSON.stringify({ version: 1, routines: [], runs }));
  const m = new RoutineManager({ file, now: () => clock.now, botState: () => "ready", createTask: () => ({ threadId: "live-thread" }), startTurn: async () => {}, ...extra }); managers.push(m);
  const routine = m.create({ name: "Fake", prompt: "Fake", botId: "bot", enabled: false, timeoutMinutes: 5, schedule: { type: "interval", everyMinutes: 5, anchorAt: NOW } });
  return { m, clock, routine };
}
function probes(m: RoutineManager) {
  const core = m as unknown as { runs: unknown[]; commitMutation(fn: () => void): void; saveFull(): void };
  const history = vi.spyOn(core, "runs", "get"), full = vi.spyOn(core, "commitMutation"), save = vi.spyOn(core, "saveFull");
  return () => { expect(history, "gated operation may not enumerate the owner run history").not.toHaveBeenCalled(); expect(full, "gated operation may not clone full history").not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); };
}
for (const operation of ["started", "next-start", "lookup", "webhook-delivery", "origin", "event-budget", "origin-memory"] as const) it(`exact-base P12/P17/P22/P26/P33 ${operation} lookup has no retained-history read`, () => {
  const f = fixture(), check = probes(f.m);
  if (operation === "started") expect(f.m.hasStartedRun("history")).toBe(true);
  if (operation === "next-start") expect(f.m.nextRunStartAfter({ id: "old-99", routineId: "history", startedAt: NOW - 99 })).toBe(NOW - 98);
  if (operation === "lookup") expect(f.m.runById("old-99")?.id).toBe("old-99");
  if (operation === "webhook-delivery") expect(f.m.findWebhookDelivery("missing", "delivery")).toBeNull();
  if (operation === "origin") expect(f.m.activeRunOrigin("missing")).toBeNull();
  if (operation === "event-budget") expect(f.m.getEventBudget("missing")).toBeNull();
  if (operation === "origin-memory") f.m.usageRunForThread("missing");
  check();
});
it("exact-base P1/P3 idle tick never enumerates retained run history", async () => { const f = fixture(), check = probes(f.m); await f.m.tick(); check(); });
it("exact-base P25 timezone reconciliation never enumerates retained run history", () => { const f = fixture(), check = probes(f.m); f.m.rescheduleForZoneChange(); check(); });
it("exact-base P13 webhook ingress persists a scoped append", () => { const f = fixture({ dispatchOpen: () => false }), check = probes(f.m); f.m.enqueueWebhook({ webhookId: "hook", webhookName: "Fake", botId: "bot", prompt: "Fake", runOn: "ember", deliveryId: "delivery", receivedAt: NOW }); check(); });
it("exact-base P14 cancellation persists only the affected run", async () => { const f = fixture({ dispatchOpen: () => false }), run = f.m.runNow(f.routine.id)!, check = probes(f.m); await f.m.cancelRun(run.id); check(); });
for (const mutation of ["admit", "raise", "receipt", "decline", "release", "close"] as const) it(`exact-base P12 event budget ${mutation} persists without a full transaction`, () => {
  const f = fixture({ dispatchOpen: () => false }), run = f.m.enqueueWebhook({ webhookId: "hook", webhookName: "Fake", botId: "bot", prompt: "Fake", runOn: "ember", deliveryId: "delivery", receivedAt: NOW });
  if (mutation === "receipt" || mutation === "release") f.m.admitEventAction(run.id, "admission", "create");
  const check = probes(f.m);
  if (mutation === "admit") expect(f.m.admitEventAction(run.id, "admission", "create")).toBe(true);
  if (mutation === "raise") f.m.raiseEventLimit(run.id, "create", 8);
  if (mutation === "receipt") f.m.recordEventAdmissionReceipt(run.id, "admission", "receipt");
  if (mutation === "decline") f.m.declineEventKind(run.id, "create");
  if (mutation === "release") f.m.releaseEventAdmission(run.id, "admission");
  if (mutation === "close") f.m.closeEventBudget(run.id);
  check();
});
for (const phase of ["open", "close", "timeout"] as const) it(`exact-base P8/P9 card ${phase} persists without a full transaction`, async () => {
  const f = fixture(); f.m.runNow(f.routine.id); await f.m.tick(); await new Promise<void>(resolve => setImmediate(resolve));
  if (phase !== "open") f.m.cardOpened("live-thread", "card", "Fake wait");
  const check = probes(f.m);
  if (phase === "open") expect(f.m.cardOpened("live-thread", "card", "Fake wait")).toBe(true);
  if (phase === "close") { expect(f.m.cardClosed("live-thread", "card")).toBe(false); expect(f.m.activeBotRunForThread("bot", "live-thread")?.cardsOpen).toBeUndefined(); }
  if (phase === "timeout") { f.clock.now += 61 * 60_000; await f.m.enforceRunLimits(); }
  check();
});
