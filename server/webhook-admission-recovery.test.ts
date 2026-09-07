import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { RoutineManager, type RoutineManagerOptions } from "./routines.ts";
import { WebhookManager, type WebhookManagerOptions } from "./webhooks.ts";

const fault = vi.hoisted(() => ({ file: "" }));
vi.mock("./atomic.ts", async importOriginal => {
  const original = await importOriginal<typeof import("./atomic.ts")>();
  return { ...original, writeFileAtomic: (...args: Parameters<typeof original.writeFileAtomic>) => {
    if (args[0] === fault.file) throw new Error("injected webhook bookkeeping write failure");
    return original.writeFileAtomic(...args);
  } };
});

it("reconciles a scheduler commit after webhook save failure and restart without re-enqueueing into a full queue", async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-webhook-reconcile-"));
  const file = join(root, "webhooks.json");
  const startTurn = vi.fn(async () => {});
  const schedulerOptions: RoutineManagerOptions = {
    file: join(root, "routines.json"), botState: () => "busy", createTask: () => ({ threadId: "never-started" }), startTurn,
  };
  let scheduler = new RoutineManager(schedulerOptions);
  const enqueue = vi.fn((input: Parameters<RoutineManager["enqueueWebhook"]>[0]) => scheduler.enqueueWebhook(input));
  const findDelivery = vi.fn((hook: string, delivery: string) => scheduler.findWebhookDelivery(hook, delivery));
  const options: WebhookManagerOptions = {
    file, botState: () => "busy", enqueue, findDelivery,
    pendingRuns: hook => scheduler.activeWebhookRunCount(hook),
  };
  try {
    const manager = new WebhookManager(options);
    const { webhook, secret } = manager.create({ name: "Recovery", prompt: "Review event", botId: "fixture-bot" });
    const before = readFileSync(file);
    const event = { deliveryId: "delivery-one", payload: { task: "original event" } };
    fault.file = file;
    expect(() => manager.receive(webhook.endpointId, secret, event)).toThrow("injected webhook bookkeeping");
    expect(readFileSync(file)).toEqual(before);
    const committed = scheduler.findWebhookDelivery(webhook.id, event.deliveryId)!;
    expect(committed).toMatchObject({ status: "queued", triggerSource: "webhook" });
    expect(enqueue).toHaveBeenCalledTimes(1);
    fault.file = "";
    // Reload both independent durable stores, retaining the intentionally
    // interrupted cross-file state. The real scheduler receipt is authoritative.
    scheduler = new RoutineManager(schedulerOptions);
    for (const deliveryId of ["second", "third"]) scheduler.enqueueWebhook({ webhookId: webhook.id,
      webhookName: webhook.name, prompt: "Unrelated queued delivery", botId: webhook.botId, runOn: "ember", deliveryId, receivedAt: Date.now() });
    expect(scheduler.activeWebhookRunCount(webhook.id)).toBe(3);
    const recovered = new WebhookManager(options);
    findDelivery.mockClear();
    expect(() => recovered.receive(webhook.endpointId, "wrong-secret", event)).toThrow();
    expect(findDelivery).not.toHaveBeenCalled();
    const result = recovered.receive(webhook.endpointId, secret, { ...event, payload: { task: "different retry payload must not replace original work" } });
    expect(result).toEqual({ runId: committed.id, deliveryId: event.deliveryId, duplicate: true });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(scheduler.activeWebhookRunCount(webhook.id)).toBe(3);
    expect(scheduler.findWebhookDelivery(webhook.id, event.deliveryId)?.prompt).toBe(committed.prompt);
    expect(JSON.parse(readFileSync(file, "utf8")).deliveries).toContainEqual(expect.objectContaining({ runId: committed.id }));
    expect(() => recovered.receive(webhook.endpointId, secret, { ...event, deliveryId: "new-delivery" })).toThrow("too many unfinished");
    expect(startTurn).not.toHaveBeenCalled();
  } finally {
    fault.file = "";
    await Promise.resolve();
    rmSync(root, { recursive: true, force: true });
  }
});
