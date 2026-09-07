import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RoutineManager, type RoutineManagerOptions } from "./routines.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "murage-telegram-thread-"));
  dirs.push(dir);
  let busy = true;
  let turn = 0;
  let startedTurn = "";
  const startTurn = vi.fn<RoutineManagerOptions["startTurn"]>(async (_botId, threadId) => {
    startedTurn = `turn-${++turn}`;
    manager.handleRuntimeEvent({ eventId: startedTurn, provider: "codex", createdAt: new Date().toISOString(),
      type: "turn.started", threadId, turnId: startedTurn });
  });
  const createTask = vi.fn(() => ({ threadId: "detached" }));
  const channelThread = vi.fn((): { threadId: string } | null => ({ threadId: "sable-primary" }));
  const interruptTurn = vi.fn(async () => {});
  const manager = new RoutineManager({
    file: join(dir, "routines.json"), botState: () => busy ? "busy" : "ready",
    createTask, channelThread, startTurn, interruptTurn,
  });
  const enqueue = (id: string, channel = true) => manager.enqueueWebhook({
    webhookId: "telegram-hook", webhookName: "Sable", botId: "sable", prompt: id,
    runOn: "ember", deliveryId: id, receivedAt: Date.now(),
    ...(channel ? { telegramConnectionId: "telegram-connection" } : {}),
  });
  const tick = async () => {
    // Drain enqueue/completion microtasks before explicitly ticking.
    await new Promise<void>(resolve => setImmediate(resolve));
    await manager.tick();
  };
  const finish = () => manager.handleRuntimeEvent({
    eventId: "completed", provider: "codex", createdAt: new Date().toISOString(),
    turnId: startedTurn,
    type: "turn.completed", threadId: "sable-primary", ok: true, cost: null, denials: [],
  });
  return { manager, enqueue, tick, finish, startTurn, createTask, channelThread, interruptTurn,
    ready: () => { busy = false; } };
}

it("keeps Telegram messages in the primary thread, ordered and serialized while waiting", async () => {
  const h = harness();
  const first = h.enqueue("first");
  const second = h.enqueue("second");
  await h.tick();
  expect(h.startTurn).not.toHaveBeenCalled();
  h.ready();
  await h.tick();
  expect(h.startTurn).toHaveBeenCalledTimes(1);
  expect(h.startTurn.mock.calls[0]!.slice(0, 5)).toEqual(["sable", "sable-primary", "first", "ember", "channel"]);
  h.manager.handleRuntimeEvent({ eventId: "request", provider: "codex", createdAt: new Date().toISOString(),
    type: "request.opened", threadId: "sable-primary", turnId: "turn-1", requestId: "approval", requestType: "permission", tool: "shell", summary: "Confirm" });
  await h.tick();
  expect(h.startTurn).toHaveBeenCalledTimes(1);
  expect(h.manager.findWebhookDelivery("telegram-hook", "second")?.status).toBe("queued");
  h.finish();
  await h.tick();
  expect(h.startTurn).toHaveBeenCalledTimes(2);
  expect(h.startTurn.mock.calls[1]![2]).toBe("second");
  expect(h.startTurn.mock.calls.map(call => call[1])).toEqual(["sable-primary", "sable-primary"]);
  expect(h.startTurn.mock.calls.map(call => call[6])).toEqual([first.event!.budgetId, second.event!.budgetId]);
  expect(h.createTask).not.toHaveBeenCalled();
  h.startTurn.mock.calls[0]![5]("stale dispatch error");
  expect(h.manager.findWebhookDelivery("telegram-hook", "second")?.status).toBe("running");
});

it("preserves deduplication, per-message action budgets and cancellation on the shared thread", async () => {
  const h = harness();
  const run = h.enqueue("message");
  expect(h.enqueue("message").id).toBe(run.id);
  h.ready();
  await h.tick();
  for (let index = 0; index < 4; index++) expect(h.manager.admitEventAction(run.id, `create-${index}`, "create")).toBe(true);
  expect(h.manager.admitEventAction(run.id, "overflow", "create")).toBe(false);
  await h.manager.cancelRun(run.id);
  expect(h.interruptTurn).toHaveBeenCalledWith("sable", "sable-primary", "ember");
  expect(h.manager.getEventBudget(run.id)?.closed).toBe(true);
  expect(h.manager.admitEventAction(run.id, "handoff", "handoff")).toBe(false);
  await h.tick();
});

it("fails closed when the current channel conversation is unavailable", async () => {
  const h = harness();
  h.channelThread.mockReturnValue(null);
  h.enqueue("message");
  h.ready();
  await h.tick();
  expect(h.manager.findWebhookDelivery("telegram-hook", "message")?.status).toBe("failed");
  expect(h.createTask).not.toHaveBeenCalled();
  expect(h.startTurn).not.toHaveBeenCalled();
});

it("retains ordinary webhook task creation", async () => {
  const h = harness();
  h.enqueue("webhook", false);
  h.ready();
  await h.tick();
  expect(h.createTask).toHaveBeenCalledWith("sable", "Sable", true);
  expect(h.channelThread).not.toHaveBeenCalled();
  expect(h.startTurn.mock.calls[0]![1]).toBe("detached");
});

it("ignores old turn events before and after the next channel message binds", async () => {
  const h = harness();
  const first = h.enqueue("first");
  h.enqueue("second");
  h.ready();
  await h.tick();
  h.startTurn.mockImplementationOnce(async () => {});
  await h.manager.cancelRun(first.id);
  await h.tick();
  const eventBase = { eventId: "late", provider: "codex", createdAt: new Date().toISOString(), threadId: "sable-primary" };
  h.manager.handleRuntimeEvent({ ...eventBase, type: "turn.started", turnId: "turn-1" });
  h.manager.handleRuntimeEvent({ ...eventBase, type: "turn.completed", turnId: "turn-1", ok: true });
  expect(h.manager.findWebhookDelivery("telegram-hook", "second")?.channelTurnId).toBeUndefined();
  expect(h.manager.findWebhookDelivery("telegram-hook", "second")?.status).toBe("running");
  h.manager.handleRuntimeEvent({ ...eventBase, type: "turn.started", turnId: "turn-2" });
  h.manager.handleRuntimeEvent({ ...eventBase, type: "turn.completed", turnId: "turn-1", ok: true });
  h.manager.handleRuntimeEvent({ ...eventBase, type: "turn.completed", ok: true });
  expect(h.manager.findWebhookDelivery("telegram-hook", "second")?.status).toBe("running");
  h.manager.handleRuntimeEvent({ ...eventBase, type: "turn.completed", turnId: "turn-2", ok: true });
  expect(h.manager.findWebhookDelivery("telegram-hook", "second")?.status).toBe("completed");
  await h.tick();
});
