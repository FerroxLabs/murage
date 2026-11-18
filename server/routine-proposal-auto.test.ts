// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { fixture as decisionFixture } from "./decision/fixture.ts";
import { bindServiceTurn } from "./service-no-limits.ts";
import { RoutineManager, routineWorkCounters, type RoutineRequestReceipt } from "./routines.ts";
import { RoutineRequestService, type RoutineRequestStore } from "./routine-requests.ts";
import { WebhookManager } from "./webhooks.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const NOW = 1_800_000_000_000, roots: string[] = [], managers: RoutineManager[] = [];
afterEach(() => { vi.restoreAllMocks(); managers.splice(0).forEach(m => m.stop()); roots.splice(0).forEach(root => removeTempDirSync(root)); });
function automation(size: number, settledReceipts = size) {
  const decision = decisionFixture(); bindServiceTurn("g", "t", "b", () => true, () => ({ ownerAudience: true, origin: "owner", noLimits: true }));
  const root = mkdtempSync(join(tmpdir(), "murage-proposal-auto-")); roots.push(root); const file = join(root, "routines.json");
  writeFileSync(file, JSON.stringify({ version: 1, routines: [{ id: "target", name: "Existing", prompt: "Fake", botId: "b", target: "bot", runOn: "ember", enabled: false, schedule: { type: "interval", everyMinutes: 5, anchorAt: NOW }, nextRunAt: null, createdAt: NOW, updatedAt: NOW }], runs: Array.from({ length: size }, (_, i) => ({ id: `old-${i}`, routineId: "target", routineName: "Old", botId: "b", target: "bot", runOn: "ember", scheduledFor: NOW - i, createdAt: NOW - i, status: "completed", finishedAt: NOW, delivery: { state: "pending" } })),
    routineRequestReceipts: Array.from({ length: settledReceipts }, (_, i) => ({ requestId: `old-${i}`, messageId: `old-${i}`, threadId: "t", botId: "b", action: "pause", fingerprintVersion: 1, fingerprint: "a".repeat(64), resultId: "old", appliedAt: NOW })) }));
  const m = new RoutineManager({ file, now: () => NOW, dispatchOpen: () => false, botState: () => "busy", createTask: () => null, startTurn: async () => {} }); managers.push(m);
  const hooks = new WebhookManager({ file: join(root, "webhooks.json"), now: () => NOW, botState: () => "busy", enqueue: () => ({ id: "fake" }), cancelQueued: (id, message) => m.cancelQueuedWebhook(id, message), pendingRuns: id => m.activeWebhookRunCount(id), findDelivery: (id, delivery) => m.findWebhookDelivery(id, delivery) });
  const cards = vi.fn(() => { throw new Error("automatic proposal presented a card or read a transcript"); });
  const store = { messagesFor: cards, appendMessage: cards, patchMessage: cards } as RoutineRequestStore;
  const service = new RoutineRequestService({ store, routines: m, now: () => NOW, webhooks: () => hooks });
  return { m, hooks, service, decision, cards, authority: { claim: decision.claim, proof: "trusted", identity: { threadId: "t", generation: "g" } } };
}
for (const kind of ["routine", "webhook"] as const) for (const action of ["create", "update", "pause", "resume", "delete", "run_now"] as const) {
  if (kind === "webhook" && action === "run_now") continue;
  it(`P35 actual automatically permitted ${kind} ${action} has bounded begin/action/result/cleanup and callback work`, async () => {
    const counts = [];
    for (const size of [100, 2_000]) {
      const f = automation(size);
      const routine = f.m.listRoutines()[0]!;
      const hook = f.hooks.create({ name: "Existing hook", prompt: "Fake", botId: "b", runOn: "ember", enabled: false }).webhook;
      const core = f.m as unknown as { commitMutation(fn: () => void): void; saveFull(): void; runStore: Set<unknown>; routineRequestReceipts: RoutineRequestReceipt[] };
      const full = vi.spyOn(core, "commitMutation"), save = vi.spyOn(core, "saveFull"), history = vi.spyOn(core.runStore, Symbol.iterator), receipts = vi.spyOn(core, "routineRequestReceipts", "get");
      const webhookSave = vi.spyOn(f.hooks as unknown as { save(): void }, "save"); const lines = routineWorkCounters.journalLines;
      const proposal = kind === "routine" ? action === "create" ? { action, routine: { name: "New", instructions: "Fake", schedule: { type: "interval", everyMinutes: 5 } } } : { action, routineId: routine.id, ...(action === "update" ? { changes: { name: "Changed" } } : {}) }
        : action === "create" ? { kind, action, webhook: { name: "New hook", instructions: "Fake" } } : { kind, action, webhookId: hook.id, ...(action === "update" ? { changes: { name: "Changed hook" } } : {}) };
      const result = await f.service.propose({ botId: "b", threadId: "t", authority: f.authority, proposal }); await new Promise<void>(resolve => setImmediate(resolve));
      expect(result.applied).toBe(true); expect(f.cards).not.toHaveBeenCalled(); expect(f.m.routineRequestReceipt(result.requestId)).toBeNull();
      const work = { full: full.mock.calls.length, saveFull: save.mock.calls.length, history: history.mock.calls.length, receipts: receipts.mock.calls.length, webhookSave: webhookSave.mock.calls.length, lines: routineWorkCounters.journalLines - lines };
      expect(work).toMatchObject({ full: 0, saveFull: 0, history: 0, receipts: 0, webhookSave: kind === "webhook" ? 1 : 0 }); expect(work.lines).toBeLessThanOrEqual(4); counts.push(work);
      full.mockRestore(); save.mockRestore(); history.mockRestore(); receipts.mockRestore(); webhookSave.mockRestore(); f.decision.dispose();
    }
    console.info("P35-auto-work", JSON.stringify({ kind, action, sizes: [100, 2_000], counts })); expect(counts[0]).toEqual(counts[1]);
  });
}
it("P35 settled receipt history varies independently of retained run history", async () => {
  for (const receipts of [100, 2_000]) {
    const f = automation(100, receipts), core = f.m as unknown as { routineRequestReceipts: RoutineRequestReceipt[]; commitMutation(fn: () => void): void };
    const history = vi.spyOn(core, "routineRequestReceipts", "get"), full = vi.spyOn(core, "commitMutation");
    const result = await f.service.propose({ botId: "b", threadId: "t", authority: f.authority, proposal: { action: "create", routine: { name: "New", instructions: "Fake", schedule: { type: "interval", everyMinutes: 5 } } } });
    expect(result.applied).toBe(true); expect(history).not.toHaveBeenCalled(); expect(full).not.toHaveBeenCalled(); history.mockRestore(); full.mockRestore(); f.decision.dispose();
  }
});
for (const failure of ["action", "result", "cleanup"] as const) it(`P35 automatic webhook ${failure} failure preserves bounded recovery state`, async () => {
  const counts = [];
  for (const size of [100, 2_000]) {
    const f = automation(size), core = f.m as unknown as { commitMutation(fn: () => void): void; saveFull(): void; routineRequestReceipts: RoutineRequestReceipt[]; journal: { proposal(input: unknown): void } };
    const full = vi.spyOn(core, "commitMutation"), save = vi.spyOn(core, "saveFull"), history = vi.spyOn(core, "routineRequestReceipts", "get"), callbacks = vi.spyOn(f.hooks as unknown as { save(): void }, "save");
    const begin = vi.spyOn(f.m, "beginRoutineRequest");
    if (failure === "action") vi.spyOn(f.hooks, "create").mockImplementationOnce(() => { throw new Error("fixture action failure"); });
    else {
      const real = core.journal.proposal.bind(core.journal); let calls = 0;
      vi.spyOn(core.journal, "proposal").mockImplementation(input => { if (++calls === (failure === "result" ? 2 : 3)) throw new Error(`fixture ${failure} failure`); real(input); });
    }
    const lines = routineWorkCounters.journalLines;
    const result = await f.service.propose({ botId: "b", threadId: "t", authority: f.authority, proposal: { kind: "webhook", action: "create", webhook: { name: "Failure fixture", instructions: "Fake" } } }).catch(error => error as Error);
    if (failure === "cleanup") expect(result).toMatchObject({ applied: true }); else expect(result).toBeInstanceOf(Error);
    const work = { full: full.mock.calls.length, saveFull: save.mock.calls.length, receipts: history.mock.calls.length, callbacks: callbacks.mock.calls.length, lines: routineWorkCounters.journalLines - lines };
    expect(work).toMatchObject({ full: 0, saveFull: 0, receipts: 0, callbacks: failure === "action" ? 0 : 1 }); expect(work.lines).toBeLessThanOrEqual(4); counts.push(work);
    full.mockRestore(); save.mockRestore(); history.mockRestore(); callbacks.mockRestore();
    const receipt = f.m.routineRequestReceipt(begin.mock.calls[0]![0].requestId);
    if (failure === "action") expect(receipt).toBeNull();
    else if (failure === "result") { expect(receipt).not.toBeNull(); expect(receipt?.resultId).toBeUndefined(); expect(f.hooks.list()).toHaveLength(1); }
    else expect(receipt?.resultId).toBe(f.hooks.list()[0]!.id);
    f.m.stop(); f.decision.dispose(); vi.restoreAllMocks();
  }
  console.info("P35-auto-fault-work", JSON.stringify({ failure, sizes: [100, 2_000], counts })); expect(counts[0]).toEqual(counts[1]);
});
