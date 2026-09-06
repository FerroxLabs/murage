import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoutineManager } from "./routines.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-event-budget-")); roots.push(root);
  const options = { file: join(root, "routines.json"), botState: () => "busy" as const, createTask: () => ({ threadId: "unused" }), startTurn: async () => {} };
  const manager = new RoutineManager(options);
  const run = manager.enqueueWebhook({ webhookId: "hook", webhookName: "Hook", botId: "bot", prompt: "Fixture", runOn: "ember", deliveryId: "delivery", receivedAt: 1 });
  return { options, manager, run };
}
describe("durable cumulative event action budget", () => {
  it("passes the durable event root to the actual turn-dispatch callback", async () => {
    const f = fixture(); let observed: string | undefined;
    const manager = new RoutineManager({ ...f.options, botState: () => "ready",
      startTurn: async (_bot, _thread, _prompt, _runOn, _source, _onError, eventId) => { observed = eventId; } });
    await manager.tick();
    expect(observed).toBe(f.run.id);
  });
  it("retains cumulative admission charges and idempotent IDs across restart without rearming", () => {
    const f = fixture();
    for (let i = 0; i < 4; i++) expect(f.manager.admitEventAction(f.run.id, `create-${i}`, "create")).toBe(true);
    expect(f.manager.admitEventAction(f.run.id, "fifth", "create")).toBe(false);
    expect(f.manager.admitEventAction(f.run.id, "create-0", "create")).toBe(true);
    expect(f.manager.admitEventAction(f.run.id, "create-0", "handoff")).toBe(false);
    const restarted = new RoutineManager(f.options);
    expect(restarted.admitEventAction(f.run.id, "create-0", "create")).toBe(true);
    expect(restarted.admitEventAction(f.run.id, "sixth", "create")).toBe(false);
    for (let i = 0; i < 4; i++) expect(restarted.admitEventAction(f.run.id, `handoff-${i}`, "handoff")).toBe(true);
    expect(restarted.admitEventAction(f.run.id, "fifth-handoff", "handoff")).toBe(false);
    expect(restarted.getEventBudget(f.run.id)?.admissions).toHaveLength(8);
  });
  it("rolls back a failed durable charge and permits one clean retry", () => {
    const f = fixture(); const backup = `${f.options.file}.backup`;
    const before = readFileSync(f.options.file);
    renameSync(f.options.file, backup); mkdirSync(f.options.file);
    expect(() => f.manager.admitEventAction(f.run.id, "retry", "create")).toThrow();
    expect(f.manager.getEventBudget(f.run.id)?.admissions).toEqual([]);
    rmdirSync(f.options.file); renameSync(backup, f.options.file);
    expect(readFileSync(f.options.file)).toEqual(before);
    expect(f.manager.admitEventAction(f.run.id, "retry", "create")).toBe(true);
    expect(f.manager.admitEventAction(f.run.id, "retry", "create")).toBe(true);
    expect(new RoutineManager(f.options).getEventBudget(f.run.id)?.admissions).toEqual([{ id: "retry", kind: "create" }]);
  });
  it("keeps a completed root's allocation available to descendants until explicitly closed", () => {
    const f = fixture();
    const disk = JSON.parse(readFileSync(f.options.file, "utf8")); disk.runs[0].status = "completed";
    writeFileSync(f.options.file, JSON.stringify(disk));
    const restarted = new RoutineManager(f.options);
    expect(restarted.admitEventAction(f.run.id, "descendant", "handoff")).toBe(true);
    expect(restarted.closeEventBudget(f.run.id)).toBe(true);
    expect(restarted.admitEventAction(f.run.id, "later-descendant", "handoff")).toBe(false);
  });
  it("closes durably, denies closed/missing/legacy ledgers and returns isolated clones", async () => {
    const f = fixture(); const clone = f.manager.getEventBudget(f.run.id)!;
    clone.closed = true; clone.admissions.push({ id: "outside", kind: "create" });
    expect(f.manager.getEventBudget(f.run.id)).toMatchObject({ closed: false, admissions: [] });
    expect(f.manager.admitEventAction("absent", "request", "create")).toBe(false);
    expect(f.manager.admitEventAction(f.run.id, "", "create")).toBe(false);
    expect(f.manager.closeEventBudget(f.run.id)).toBe(true);
    expect(f.manager.admitEventAction(f.run.id, "request", "create")).toBe(false);
    expect(new RoutineManager(f.options).getEventBudget(f.run.id)?.closed).toBe(true);
    const disk = JSON.parse(readFileSync(f.options.file, "utf8")); delete disk.runs[0].eventBudget;
    writeFileSync(f.options.file, JSON.stringify(disk));
    const legacy = new RoutineManager(f.options);
    expect(legacy.getEventBudget(f.run.id)).toBeNull();
    expect(legacy.admitEventAction(f.run.id, "request", "create")).toBe(false);
    await f.manager.cancelRun(f.run.id);
    expect(f.manager.getEventBudget(f.run.id)?.closed).toBe(true);
  });
  it("allocates manual roots once and closes their budget in cancellation", async () => {
    const f = fixture();
    const routine = f.manager.create({ name: "Manual", botId: "bot", prompt: "Fixture", runOn: "ember", enabled: false, schedule: { type: "once", at: 1 }, durationMinutes: 5 });
    const run = f.manager.runNow(routine.id)!;
    expect(run.event?.budgetId).toBe(run.id);
    expect(f.manager.getEventBudget(run.id)).toEqual({ version: 1, limits: { create: 4, handoff: 4 }, admissions: [], closed: false });
    await f.manager.cancelRun(run.id);
    expect(new RoutineManager(f.options).getEventBudget(run.id)?.closed).toBe(true);
    expect(f.manager.admitEventAction(run.id, "cancelled", "handoff")).toBe(false);
  });
});
