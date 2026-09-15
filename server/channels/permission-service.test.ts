import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { safeWipeSync } from "../testing/safe-wipe.mjs";
import { DiscordService } from "./discord/service.ts";
import { SlackService } from "./slack/service.ts";
import type { PermissionAction } from "./permission-approvals.ts";

const services: Array<DiscordService | SlackService> = [], roots: string[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.stop(); for (const root of roots.splice(0)) safeWipeSync(root); });
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
function fixture(platform: "discord" | "slack") {
  const dataDir = mkdtempSync(join(tmpdir(), "murage-permission-service-")); roots.push(dataDir);
  let current = true, pending = true, sequence = 100;
  let receive!: (raw: unknown, ack: () => Promise<void>) => void;
  let action!: (event: PermissionAction) => void;
  const discord = platform === "discord", app = discord ? "11" : "A1", owner = discord ? "13" : "U3", dm = discord ? "14" : "D1";
  const sendPermission = vi.fn(async (_input: { dmId: string; text: string; approveId: string; denyId: string; signal: AbortSignal }) => ({ channel: dm, messageId: "99", ts: "99.1" }));
  const settlePermission = vi.fn(async () => {});
  const resolve = vi.fn(async () => { pending = false; return true; });
  const enqueue = vi.fn(() => ({ id: "run" }));
  const common = { dataDir, isCurrentChief: () => current,
    approvals: { pending: () => pending ? [{ id: "card", fingerprint: "original", summary: "Write fixture.txt" }] : [], resolve },
    runs: () => ({ enqueue, result: () => ({ status: "completed", output: "hello" }) }), revokeRuns: async () => {} };
  const baseTransport = { sendPermission, settlePermission, onPermissionAction: (cb: (event: PermissionAction) => void) => { action = cb; },
    sendText: async () => ({ channel: dm, messageId: "98", ts: "98.1" }), stop: async () => {} };
  const service = discord ? new DiscordService({ ...common, chosen: { applicationId: app, ownerUserId: owner, chiefBotId: "chief" },
    transport: () => ({ ...baseTransport, verifyBot: async () => ({ applicationId: app, botUserId: "12" }),
      start: async (cb, health) => { receive = cb; health("connected"); } }) })
    : new SlackService({ ...common, chosen: { teamId: "T1", appId: app, ownerUserId: owner, chiefBotId: "chief" },
      transport: () => ({ ...baseTransport, verifyBot: async () => ({ teamId: "T1", userId: "U2", botId: "B1" }),
        start: async (cb, health) => { receive = cb; health("connected"); } }) });
  services.push(service);
  const emit = async (text: string) => {
    const id = String(++sequence);
    const raw = discord ? { applicationId: app, botUserId: "12", id, dmId: dm, channelType: 1, authorId: owner, authorBot: false,
      guildId: null, webhookId: null, type: 0, content: text, occurredAt: Date.now(), attachments: 0, components: 0, forwarded: false }
      : { type: "events_api", body: { type: "event_callback", team_id: "T1", api_app_id: app, event_id: "Ev" + id, event_time: Date.now() / 1000,
        authorizations: [{ team_id: "T1", user_id: "U2", is_bot: true }], event: { type: "message", channel_type: "im", channel: dm, user: owner, text } } };
    receive(raw, async () => {}); await flush(); await service.tick();
  };
  const event = (deny = false): PermissionAction => ({ provider: platform, applicationId: app, ...(discord ? {} : { teamId: "T1" }),
    userId: owner, channelId: dm, messageId: discord ? "99" : "99.1", actionId: sendPermission.mock.calls.at(-1)![0][deny ? "denyId" : "approveId"], ack: async () => {} });
  return { service, emit, event, sendPermission, settlePermission, resolve, enqueue, action: (e: PermissionAction) => action(e), invalidate: () => { current = false; } };
}
it.each(["discord", "slack"] as const)("%s pairs, publishes a permission, rejects chat approval and resolves only the owner button", async platform => {
  const f = fixture(platform); const pairing = await f.service.pair(); await f.emit("/pair " + pairing.code);
  expect(f.service.status().paired).toBe(true); expect(f.sendPermission).toHaveBeenCalledTimes(1);
  await f.emit("yes"); expect(f.resolve).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
  f.action({ ...f.event(), userId: "wrong" }); await flush(); expect(f.resolve).not.toHaveBeenCalled();
  f.action(f.event()); f.action(f.event()); await flush();
  expect(f.resolve).toHaveBeenCalledExactlyOnceWith({ id: "card", fingerprint: "original", summary: "Write fixture.txt" }, "allow");
  expect(f.settlePermission).toHaveBeenCalledTimes(1); expect(f.enqueue).not.toHaveBeenCalled();
});
it.each(["discord", "slack"] as const)("%s fences permission callbacks on Chief change and revoke", async platform => {
  const f = fixture(platform); const pairing = await f.service.pair(); await f.emit("/pair " + pairing.code);
  f.invalidate(); f.action(f.event()); await flush(); expect(f.resolve).not.toHaveBeenCalled();
  await f.service.revoke(); f.action(f.event()); await flush(); expect(f.resolve).not.toHaveBeenCalled();
});
