// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Design 5.4 / 7.4: a channel run enqueued with notOwnerAudience carries the flag on the run and into the startTurn
// the manager actually calls, as defence beside the guest principal. A run without it carries nothing.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { linkHumanBinding, observeVerifiedHuman, resolveHumanBinding } from "./human-principals.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { RoutineManager } from "./routines.ts";

let dir: string;
beforeEach(() => {
  cachedPrincipal = undefined;
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  dir = mkdtempSync(join(tmpdir(), "murage-routines-audience-"));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

let cachedPrincipal: ReturnType<typeof resolveHumanBinding> | undefined;
function principal() {
  if (cachedPrincipal) return cachedPrincipal;
  const id = observeVerifiedHuman({ platform: "whatsapp", connectionId: "c", authorityId: "15551230000@s.whatsapp.net", userId: "15557654321@s.whatsapp.net" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: id, expectedRevision: 1, as: "person" });
  return (cachedPrincipal = resolveHumanBinding(id));
}
function build(startTurn: ReturnType<typeof vi.fn>) {
  return new RoutineManager({
    file: join(dir, "routines.json"), automaticPaused: () => false, botState: () => "ready",
    createTask: () => ({ threadId: "task-1" }), channelThread: () => ({ threadId: "channel-thread" }),
    startTurn, interruptTurn: async () => {}, isChannelCurrent: () => true, emit: () => {},
  } as unknown as ConstructorParameters<typeof RoutineManager>[0]);
}
function enqueue(manager: RoutineManager, deliveryId: string, extra: object) {
  return manager.enqueueWebhook({ webhookId: "whatsapp:c:k", webhookName: "WhatsApp message", prompt: "hello", botId: "bot", runOn: "ember", deliveryId, receivedAt: Date.now(),
    channelOrigin: { platform: "whatsapp", connectionId: "c" }, humanPrincipal: principal(), ...extra } as Parameters<RoutineManager["enqueueWebhook"]>[0]);
}

it("stores notOwnerAudience on the run and hands it to startTurn", async () => {
  const startTurn = vi.fn(async () => {});
  const manager = build(startTurn);
  const run = enqueue(manager, "g1", { notOwnerAudience: true });
  expect(run.notOwnerAudience).toBe(true);
  await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1));
  const call = startTurn.mock.calls[0] as unknown[];
  expect(call[1]).toBe("channel-thread");
  expect(call[7]).toBe(true);
});

it("a run without the flag reaches startTurn with it false", async () => {
  const startTurn = vi.fn(async () => {});
  const manager = build(startTurn);
  const run = enqueue(manager, "p1", {});
  expect(run.notOwnerAudience).toBeUndefined();
  await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1));
  expect((startTurn.mock.calls[0] as unknown[])[7]).toBe(false);
});

it("a channel run carries its image attachments into the executed prompt and clones them", async () => {
  const startTurn = vi.fn(async () => {});
  const manager = build(startTurn);
  const attachment = { id: "g2:0", kind: "image" as const, name: "IMG.jpg", path: "/data/whatsapp/media/c/k/IMG.jpg", size: 12 };
  const run = enqueue(manager, "img1", { attachments: [attachment] });
  expect(run.attachments).toEqual([attachment]);
  expect(run.attachments![0]).not.toBe(attachment);
  await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1));
  expect((startTurn.mock.calls[0] as unknown[])[2]).toContain('<attached-image path="/data/whatsapp/media/c/k/IMG.jpg" />');
});
it("refuses attachments on a run that is not a channel message, and malformed ones", () => {
  const manager = build(vi.fn(async () => {}));
  const attachment = { id: "a", kind: "image" as const, name: "x.jpg", path: "/x.jpg", size: 1 };
  expect(() => manager.enqueueWebhook({ webhookId: "hook", webhookName: "Hook", prompt: "p", botId: "bot", runOn: "ember", deliveryId: "w1", receivedAt: Date.now(), attachments: [attachment] }))
    .toThrow("Attachments can only run on this computer from a channel message");
  expect(() => enqueue(manager, "bad", { attachments: [{ id: "", kind: "image", name: "x", path: "", size: 1 }] })).toThrow("Choose a valid attachment");
  expect(() => enqueue(manager, "cloud", { runOn: "cloud", attachments: [attachment] })).toThrow("Attachments can only run on this computer");
});
