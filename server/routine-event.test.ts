import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRoutineEvent, parseRoutineEvent } from "../shared/routine-event.ts";
import { RoutineManager } from "./routines.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-event-envelope-")); roots.push(root);
  const options = { file: join(root, "routines.json"), now: () => 1000, botState: () => "busy" as const, createTask: () => ({ threadId: "unused" }), startTurn: async () => {} };
  return { options, manager: new RoutineManager(options) };
}
describe("normalized routine event provenance", () => {
  it("keeps Telegram channel origin and cumulative budget across duplicate intake", () => {
    const f = fixture();
    const input = { webhookId: "telegram:123", telegramConnectionId: "123", webhookName: "Telegram",
      prompt: "run it", botId: "bot", runOn: "ember" as const, deliveryId: "telegram:123:42", receivedAt: 900 };
    const run = f.manager.enqueueWebhook(input);
    expect(run.event).toMatchObject({ source: "channel", origin: { kind: "channel", channel: "telegram", connectionId: "123" }, budgetId: run.id });
    for (let i = 0; i < 4; i++) expect(f.manager.admitEventAction(run.id, "handoff-" + i, "handoff")).toBe(true);
    const restarted = new RoutineManager(f.options);
    expect(restarted.enqueueWebhook(input).id).toBe(run.id);
    expect(restarted.admitEventAction(run.id, "extra", "handoff")).toBe(false);
  });
  it("persists manual and scheduled classes and stable allocation identifiers", async () => {
    const f = fixture();
    const manual = f.manager.create({ name: "Manual", botId: "bot", prompt: "Fixture", runOn: "ember", enabled: false, schedule: { type: "once", at: 1000 }, durationMinutes: 5 });
    const run = f.manager.runNow(manual.id)!;
    expect(run.event).toMatchObject({ id: run.id, source: "manual", definitionId: manual.id, origin: { kind: "local-manual" }, budgetId: run.id });
    const scheduled = f.manager.create({ name: "Schedule", botId: "bot", prompt: "Fixture", runOn: "ember", enabled: true, schedule: { type: "once", at: 1000 }, durationMinutes: 5 });
    await f.manager.tick();
    const scheduleRun = f.manager.listRuns().find(item => item.routineId === scheduled.id)!;
    expect(scheduleRun.event).toMatchObject({ source: "schedule", origin: { kind: "local-schedule" }, budgetId: scheduleRun.id });
    const restarted = new RoutineManager(f.options);
    expect(restarted.listRuns().find(item => item.id === run.id)?.event).toEqual(run.event);
    expect(restarted.listRuns().find(item => item.id === scheduleRun.id)?.event).toEqual(scheduleRun.event);
  });
  it("retains external provenance across duplicate delivery, restart and malformed saved claims", () => {
    const f = fixture();
    const input = { webhookId: "hook", webhookName: "Hook", prompt: "Untrusted event", botId: "bot", runOn: "ember" as const, deliveryId: "delivery", receivedAt: 900 };
    const run = f.manager.enqueueWebhook(input);
    expect(run.event).toMatchObject({ source: "webhook", receivedAt: 900, origin: { kind: "external-webhook", webhookId: "hook" }, budgetId: run.id });
    const disk = JSON.parse(readFileSync(f.options.file, "utf8"));
    disk.runs[0].event = createRoutineEvent({ runId: run.id, definitionId: "hook", receivedAt: 1000, source: "manual" });
    writeFileSync(f.options.file, JSON.stringify(disk));
    const restarted = new RoutineManager(f.options);
    expect(restarted.enqueueWebhook({ ...input, prompt: "Changed external text" }).event).toEqual(run.event);
    const clone = restarted.findWebhookDelivery("hook", "delivery")!;
    if (clone.event?.source === "webhook") clone.event.origin.webhookId = "mutated";
    expect(restarted.findWebhookDelivery("hook", "delivery")?.event).toEqual(run.event);
    delete disk.runs[0].event; delete disk.runs[0].triggerSource;
    writeFileSync(f.options.file, JSON.stringify(disk));
    expect(new RoutineManager(f.options).listRuns()[0].event).toEqual(run.event);
  });
  it("strictly rejects mismatched sources, unknown fields and invalid allocation metadata", () => {
    const event = createRoutineEvent({ runId: "run", definitionId: "routine", source: "manual", receivedAt: 1 });
    expect(parseRoutineEvent({ ...event, origin: { kind: "external-webhook", webhookId: "hook" } })).toBeNull();
    expect(parseRoutineEvent({ ...event, claimedAuthority: "local" })).toBeNull();
    expect(parseRoutineEvent({ ...event, budgetId: "" })).toBeNull();
    expect(parseRoutineEvent(event)).toEqual(event);
    expect(parseRoutineEvent(event)).not.toBe(event);
  });
});
