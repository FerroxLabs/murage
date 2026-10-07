// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Design 10: a real group message through the real service, the real WhatsApp people, the real human-principal tables and a
// real RoutineManager, down to the `startTurn` the manager actually calls (a spy). It asserts what the memory layer relies
// on: the turn is flagged not-owner (eighth argument), the run is bound to the group's guest person and never the owner, and
// an image in the same group reaches the turn as an attached file. The runs factory mirrors makeWhatsApp in server/index.ts.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../../config.ts";
import { closeDatabase } from "../../database.ts";
import { WORKSPACE_OWNER, resolveHumanBinding, resolveHumanDelivery } from "../../human-principals.ts";
import { RoutineManager } from "../../routines.ts";
import type { ChannelRuns } from "../durable-delivery.ts";
import type { InboundEnvelope } from "./core/protocol.ts";
import { createWhatsAppPeople, ensureGroupGuest, ensureOwnerLinked, whatsappOrigin } from "./people.ts";
import { WhatsAppService, chatKeyOf } from "./service.ts";
import type { HealthEvent, TransportHandlers, WhatsAppTransport } from "./transport.ts";

const OWNER = "15550001111@s.whatsapp.net", BOB = "15550002222@s.whatsapp.net", GROUP = "120363000000000001@g.us";
const roots: string[] = [], services: WhatsAppService[] = [];
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(async () => { for (const s of services.splice(0)) await s.stop().catch(() => undefined); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

async function stack() {
  const dir = mkdtempSync(join(tmpdir(), "murage-wa-e2e-")); roots.push(dir);
  const startTurn = vi.fn(async () => {});
  const routines = new RoutineManager({
    file: join(dir, "routines.json"), automaticPaused: () => false, botState: () => "ready", createTask: () => ({ threadId: "task-1" }),
    channelThread: () => ({ threadId: "group-thread" }), startTurn, interruptTurn: async () => {}, isChannelCurrent: () => true, emit: () => {},
  } as unknown as ConstructorParameters<typeof RoutineManager>[0]);
  let handlers: TransportHandlers | undefined, n = 0;
  const sendText = vi.fn(async (i: { ids: string[] }) => ({ ids: i.ids }));
  const transport: WhatsAppTransport = {
    capabilities: { linking: "qr-or-code", groups: true, presence: true, readReceipts: true, lidResolution: true, ownSendEcho: true },
    start: async h => { handlers = h; }, onLink: () => {}, link: async () => {}, stop: async () => {}, unlink: async () => {},
    self: () => ({ pn: OWNER }), resolve: { pnForLid: async () => undefined, lidForPn: async () => undefined },
    reserve: async () => ({ ids: [`WA${++n}`] }), sendText: sendText as WhatsAppTransport["sendText"],
  };
  const service = new WhatsAppService({
    dataDir: dir, chosen: { chiefBotId: "chief" }, authKey: { get: async () => "ef".repeat(32) }, isCurrentChief: () => true, transport: () => transport,
    settings: () => ({ mode: "self-chat", allowFrom: [], readReceipts: false, quoteReplies: "groups",
      groups: { policy: "allowlist", allow: [{ jid: GROUP, name: "Team", activation: "mention" }], senders: "members" } }),
    people: createWhatsAppPeople(), wipeData: async () => {}, revokeRuns: async () => {}, addAllowFrom: () => {},
    runs: (context): ChannelRuns => {
      const { binding } = context, webhookId = `whatsapp:${binding.connectionId}:${context.chatKey}`;
      const humanBindingId = context.role === "owner" ? ensureOwnerLinked(binding) : ensureGroupGuest(binding, context.chatJid, context.name);
      return {
        enqueue: input => {
          const humanPrincipal = resolveHumanDelivery(humanBindingId, input.deliveryId);
          const { media, ...rest } = input;
          const attachments = (media ?? []).filter(m => m.mime.startsWith("image/")).map((m, index) => ({ id: `${input.deliveryId}:${index}`, kind: "image" as const, name: "g.jpg", path: m.path, size: m.bytes }));
          return routines.enqueueWebhook({ webhookId, webhookName: "WhatsApp message", channelOrigin: { platform: "whatsapp", connectionId: binding.connectionId },
            botId: binding.chiefBotId, runOn: "ember", receivedAt: Date.now(), ...rest, ...(attachments.length ? { attachments } : {}), humanPrincipal,
            ...(context.notOwnerAudience ? { notOwnerAudience: true as const } : {}) });
        },
        result: id => { const run = routines.listRuns().find(item => item.id === id); return run ? { status: "completed", output: "group answer" } : null; },
      };
    },
  });
  services.push(service);
  await service.link({ method: "qr" });
  handlers!.onHealth({ state: "connected", self: { pn: OWNER } } as HealthEvent);
  await vi.waitFor(() => expect(service.status().linked).toBe(true));
  const connectionId = (JSON.parse(readFileSync(join(dir, "channels", "whatsapp", "connection.json"), "utf8")) as { connectionId: string }).connectionId;
  mkdirSync(join(dir, "whatsapp", "outbound"), { recursive: true });
  writeFileSync(join(dir, "whatsapp", "outbound", `${connectionId}.json`), JSON.stringify({ records: [] }));
  const deliver = (e: Partial<InboundEnvelope> & { messageId: string }) => handlers!.onEnvelope({ chatJid: GROUP, participant: BOB, fromMe: false, timestampMs: Date.now(), upsertType: "notify",
    mentionedJids: [OWNER], pushName: "Bob", ...e } as InboundEnvelope, async () => {});

  return { dir, startTurn, routines, deliver, connectionId, sendText };
}

const binding = (connectionId: string) => ({ connectionId, linkedPn: OWNER, chiefBotId: "chief" }) as never;

it("a group message reaches startTurn as a not-owner turn on the group's guest person, and the reply quotes the trigger", async () => {
  const { startTurn, routines, deliver, connectionId, sendText } = await stack();
  deliver({ messageId: "GM1", text: "@bot what is the plan?" });
  await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1));
  const first = startTurn.mock.calls[0] as unknown[];
  expect(first[1]).toBe("group-thread");
  expect(first[7]).toBe(true);
  expect(String(first[2])).toContain("Group: Team");
  const run = routines.listRuns().find(item => item.deliveryId?.endsWith(":GM1"))!;
  const guest = resolveHumanBinding(ensureGroupGuest(binding(connectionId), GROUP, "Team"));
  expect(run.notOwnerAudience).toBe(true);
  expect(run.humanPrincipal).toMatchObject({ personId: guest.personId, bindingId: guest.bindingId });
  expect(run.humanPrincipal!.personId).not.toBe(WORKSPACE_OWNER);
  expect(run.humanPrincipal!.bindingId).not.toBe(resolveHumanBinding(ensureOwnerLinked(binding(connectionId))).bindingId);
  expect(whatsappOrigin(binding(connectionId), GROUP).userId).toBe(GROUP);
  await vi.waitFor(() => expect(sendText).toHaveBeenCalled());
  expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ chatId: GROUP, quote: expect.objectContaining({ id: "GM1", participant: BOB }) }));
});

it("a photo in a group is a stored attachment on the not-owner turn", async () => {
  const { dir, startTurn, deliver, connectionId } = await stack();
  const folder = join(dir, "whatsapp", "media", connectionId, chatKeyOf(GROUP));
  mkdirSync(folder, { recursive: true });
  const photo = join(folder, "GM2.jpg"); writeFileSync(photo, "JPEG");
  deliver({ messageId: "GM2", text: "@bot who is this?", media: { kind: "image", mime: "image/jpeg", bytes: 4, path: photo } });
  await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1));
  const call = startTurn.mock.calls[0] as unknown[];
  expect(String(call[2])).toContain(`<attached-image path="${photo}" />`);
  expect(call[7]).toBe(true);
});
