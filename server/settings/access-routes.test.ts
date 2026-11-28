import { mkdirSync } from "node:fs";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { Store } from "../store.ts";
import { botAccessPolicy } from "../bot-access-role.ts";
import { levelsOf, seedLevels } from "../bot-access-levels.ts";
import { assertRelayBot } from "../connector-relay.ts";
import type { InventoryServices } from "../connected-inventory.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { handleBotAccessRoute } from "./access-routes.ts";

// Route-level witnesses for the per-app levels PUT (AG0 7) and the relay inventory hookup (5.3):
// the shipped route handler on a real Store, the shipped relay check; only the engine-side seams are fakes.
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

const inventory: InventoryServices = { gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "ca_mail_a", status: "ACTIVE" }, { id: "ca_mail_b", status: "ACTIVE" }] } } as never;

function harness(options: { complete?: boolean } = {}) {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot({ name: "Pepper", section: "Studio" });
  const sent: Array<{ status: number; body: any }> = [];
  const revoked: string[] = [];
  const put = async (body: unknown) => {
    const req = Object.assign(Readable.from([]), { headers: { "content-type": "application/json" } }) as never;
    await handleBotAccessRoute("PUT", `/api/bots/${bot.id}/access`, req, {} as never, {
      store, json: (_res, status, payload) => { sent.push({ status, body: payload }); }, readBody: async () => body,
      currentConnectedAccessAccounts: async () => [{ toolkit: "gmail", accountId: "ca_mail_a" }, { toolkit: "gmail", accountId: "ca_mail_b" }],
      internalTurnOwners: () => [], revokeInternalThread: () => {}, revokeInternalBot: (id) => { revoked.push(id); }, pendingPermissionStatus: () => [],
      levelsInventory: { readSettled: async () => ({ services: inventory, settled: true, complete: options.complete ?? true }), remembered: async () => inventory },
    });
    return sent[sent.length - 1]!;
  };
  return { store, bot, put, revoked, fresh: () => store.bot(bot.id)! };
}

describe("PUT /api/bots/:id/access with a levels action", () => {
  it("saves through the route, ends turns only on a lowering, and reports what the gate pauses", async () => {
    const { bot, put, revoked, fresh } = harness();
    const current = fresh();
    const levels = levelsOf(current) ?? seedLevels(current);
    const lower = await put({ action: "set-account", revision: botAccessPolicy(current).revision, base: { entry: null, newAccounts: levels.newAccounts, allowWrites: levels.allowWrites }, toolkit: "gmail", accountId: "ca_mail_a", level: "none" });
    expect(lower.status).toBe(200);
    expect(lower.body.levels).toMatchObject({ rule: "levels" });
    expect(lower.body.levels.pausedBySave).toContainEqual({ toolkit: "gmail", accountId: null });
    expect(levelsOf(fresh())!.accounts).toEqual([{ toolkit: "gmail", accountId: "ca_mail_a", level: "none" }]);
    expect(revoked).toEqual([bot.id]);
  });

  it("refuses a Keep current apps save with 503 and writes nothing when the broker's sweep may have omitted accounts", async () => {
    const { bot, put, revoked, fresh } = harness({ complete: false });
    const current = fresh();
    const levels = levelsOf(current) ?? seedLevels(current);
    const before = JSON.stringify(fresh());
    const save = await put({ action: "set-switches", revision: botAccessPolicy(current).revision, base: { newAccounts: levels.newAccounts, allowWrites: levels.allowWrites }, newAccounts: "none", keepCurrent: true });
    expect(save.status).toBe(503);
    expect(JSON.stringify(fresh())).toBe(before);
    expect(revoked).toEqual([]);
    expect(bot.id).toBeTruthy();
  });

  it("maps a stale save to its status and code and writes nothing", async () => {
    const { put, revoked, fresh } = harness();
    const before = JSON.stringify(fresh());
    const stale = await put({ action: "clear-floor", revision: 99, toolkit: "gmail" });
    expect(stale).toMatchObject({ status: 409, body: { code: "revision" } });
    expect(JSON.stringify(fresh())).toBe(before);
    expect(revoked).toEqual([]);
  });
});

describe("relay inventory hookup", () => {
  it("admits a call only when the inventory handed to the relay lists the account", async () => {
    const { store, bot, put, fresh } = harness();
    const current = fresh();
    const levels = levelsOf(current) ?? seedLevels(current);
    await put({ action: "set-account", revision: botAccessPolicy(current).revision, base: { entry: null, newAccounts: levels.newAccounts, allowWrites: levels.allowWrites }, toolkit: "gmail", accountId: "ca_mail_a", level: "none" });
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "SLACK_SEND_MESSAGE", account: "ca_chat_a", arguments: {} }] } } };
    const withSlack = { ...inventory, slack: { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "ca_chat_a", status: "ACTIVE" }] } } as never;
    expect(() => assertRelayBot(store.bot(bot.id), call, false, withSlack)).not.toThrow();
    expect(() => assertRelayBot(store.bot(bot.id), call, false, inventory)).toThrow();
  });
});
