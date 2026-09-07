import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutineManager } from "./routines.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-event-admission-")); roots.push(root);
  const file = join(root, "routines.json");
  const emit = vi.fn(), startTurn = vi.fn(async () => {}), createTask = vi.fn(() => ({ threadId: "event-thread" }));
  const botState = vi.fn((): "busy" | "missing" => "busy");
  const options = { file, emit, startTurn, createTask, botState };
  return { file, options, emit, startTurn, createTask, botState, manager: new RoutineManager(options) };
}
const delivery = { webhookId: "hook-a", webhookName: "Fixture hook", prompt: "Original event", botId: "bot-a", runOn: "ember" as const, deliveryId: "delivery-a", receivedAt: 1 };
describe("durable webhook run admission", () => {
  it("rolls back failed saves and admits a clean retry without emission or scheduling on failure", async () => {
    const f = fixture();
    mkdirSync(f.file); // A real atomic-rename failure in a task-owned directory.
    expect(() => f.manager.enqueueWebhook(delivery)).toThrow();
    expect(f.manager.listRuns()).toEqual([]);
    expect(f.manager.findWebhookDelivery(delivery.webhookId, delivery.deliveryId)).toBeNull();
    await Promise.resolve();
    expect(f.emit).not.toHaveBeenCalled(); expect(f.createTask).not.toHaveBeenCalled(); expect(f.startTurn).not.toHaveBeenCalled();
    rmdirSync(f.file);
    const admitted = f.manager.enqueueWebhook(delivery);
    expect(JSON.parse(readFileSync(f.file, "utf8")).runs.map((run: { id: string }) => run.id)).toEqual([admitted.id]);
    expect(f.manager.listRuns()).toHaveLength(1);
    expect(f.emit).toHaveBeenCalledTimes(1);
  });
  it("returns the retained receipt after restart even when payload or bot availability changed", async () => {
    const f = fixture(); const first = f.manager.enqueueWebhook(delivery);
    await Promise.resolve();
    const restarted = new RoutineManager(f.options);
    f.botState.mockReturnValue("missing"); f.botState.mockClear(); f.emit.mockClear();
    const before = readFileSync(f.file);
    const repeated = restarted.enqueueWebhook({ ...delivery, prompt: "Changed payload must not run", botId: "different-bot" });
    expect(repeated.id).toBe(first.id); expect(repeated.prompt).toBe(delivery.prompt);
    expect(f.botState).not.toHaveBeenCalled(); expect(f.emit).not.toHaveBeenCalled();
    expect(f.startTurn).not.toHaveBeenCalled(); expect(restarted.listRuns()).toHaveLength(1);
    expect(readFileSync(f.file)).toEqual(before);
    repeated.prompt = "Do not mutate stored receipt";
    expect(restarted.findWebhookDelivery(delivery.webhookId, delivery.deliveryId)?.prompt).toBe(delivery.prompt);
  });
  it("keys delivery identity by exact webhook and excludes non-webhook receipts", () => {
    const f = fixture(); const first = f.manager.enqueueWebhook(delivery);
    const second = f.manager.enqueueWebhook({ ...delivery, webhookId: "hook-b" });
    expect(second.id).not.toBe(first.id); expect(f.manager.listRuns()).toHaveLength(2);
    const disk = JSON.parse(readFileSync(f.file, "utf8"));
    disk.runs[0].triggerSource = "schedule";
    writeFileSync(f.file, JSON.stringify(disk));
    const restarted = new RoutineManager(f.options);
    expect(restarted.findWebhookDelivery("hook-a", "delivery-a")).toBeNull();
    expect(restarted.findWebhookDelivery("hook-b", "delivery-a")?.id).toBe(second.id);
  });
});
