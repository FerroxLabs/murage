import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RoutineManager } from "../../routines.ts";
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "murage-slack-runtime-")); roots.push(dir);
  let valid = true, busy = true;
  const startTurn = vi.fn(async () => {}), createTask = vi.fn(() => ({ threadId: "detached" }));
  const options = { file: join(dir, "routines.json"), automaticPaused: () => true,
    isChannelCurrent: (origin: { platform: "slack" | "discord"; connectionId: string }, botId: string) => valid && origin.platform === "slack" && origin.connectionId === "binding" && botId === "chief",
    botState: (): "busy" | "ready" => busy ? "busy" : "ready", startTurn, createTask, channelThread: () => ({ threadId: "chief-thread" }) };
  const input = { webhookId: "slack:binding", webhookName: "Slack", deliveryId: "EvONE", prompt: "hello", botId: "chief", runOn: "ember" as const, receivedAt: 1,
    channelOrigin: { platform: "slack" as const, connectionId: "binding" } };
  return { options, manager: new RoutineManager(options), input, startTurn, createTask, ready: () => { busy = false; }, invalidate: () => { valid = false; } };
}
it("only a current bound Slack owner event obtains channel provenance and pause exemption", () => {
  const f = fixture(), run = f.manager.enqueueWebhook(f.input);
  expect(run.event?.origin).toEqual({ kind: "channel", channel: "slack", connectionId: "binding" });
  expect(run.telegramConnectionId).toBeUndefined();
  expect(() => f.manager.enqueueWebhook({ ...f.input, deliveryId: "wrong", botId: "other" })).toThrow();
  expect(() => f.manager.enqueueWebhook({ ...f.input, deliveryId: "conflict", telegramConnectionId: "legacy" })).toThrow();
  expect(() => f.manager.enqueueWebhook({ ...f.input, deliveryId: "ordinary", channelOrigin: undefined })).toThrow("Automatic work is paused");
  const noGuard = new RoutineManager({ ...f.options, file: join(roots.at(-1)!, "other.json"), isChannelCurrent: undefined });
  expect(() => noGuard.enqueueWebhook(f.input)).toThrow();
});
it("reuses retained Slack identity after restart and checks Chief again before dispatch", async () => {
  const f = fixture(), run = f.manager.enqueueWebhook(f.input); await Promise.resolve();
  const restarted = new RoutineManager(f.options);
  expect(restarted.enqueueWebhook({ ...f.input, prompt: "replacement" }).id).toBe(run.id);
  expect(restarted.listRuns()[0].prompt).toBe("hello");
  f.invalidate(); f.ready(); await restarted.tick();
  expect(f.startTurn).not.toHaveBeenCalled(); expect(restarted.listRuns()[0].status).toBe("failed");
});
it("Slack reuses the Chief conversation and fences late provider turns", async () => {
  const f = fixture(), run = f.manager.enqueueWebhook(f.input); await Promise.resolve(); f.ready(); await f.manager.tick();
  expect(f.startTurn.mock.calls[0]).toEqual(expect.arrayContaining(["chief", "chief-thread", "hello", "channel"]));
  expect(f.createTask).not.toHaveBeenCalled();
  f.manager.handleRuntimeEvent({ eventId: "start", type: "turn.started", threadId: "chief-thread", turnId: "current", provider: "codex", createdAt: new Date().toISOString() });
  f.manager.handleRuntimeEvent({ eventId: "late", type: "turn.completed", threadId: "chief-thread", turnId: "old", provider: "codex", createdAt: new Date().toISOString(), ok: true });
  expect(f.manager.listRuns().find(x => x.id === run.id)?.status).toBe("running");
  f.manager.handleRuntimeEvent({ eventId: "done", type: "turn.completed", threadId: "chief-thread", turnId: "current", provider: "codex", createdAt: new Date().toISOString(), ok: true });
  expect(f.manager.listRuns().find(x => x.id === run.id)?.status).toBe("completed");
});
