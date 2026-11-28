// Connected-app relay authorization (owner: lane access). Extracted by core's Settings v10 SEAT from the
// /api/internal/connectors/mcp handler in index.ts, behaviour unchanged: a missing bot is a 403, then the
// bot's own access check for the call (assertRelayBot) or for the stored result it would reuse (assertRelayStored).
import { assertConnectedAppCall, assertStoredConnectedAppAccess } from "./bot-access.ts";
import type { InventoryServices } from "./connected-inventory.ts";
import type { BotRecord } from "./store.ts";

function unavailable(): Error { return Object.assign(new Error("Bot unavailable."), { status: 403 }); }

export function assertRelayBot(bot: BotRecord | null | undefined, body: unknown, noLimits: boolean, inventory?: InventoryServices | null): asserts bot is BotRecord {
  if (!bot) throw unavailable();
  assertConnectedAppCall(bot, body, { noLimits, ...(inventory !== undefined ? { inventory } : {}) });
}

export function assertRelayStored(bot: BotRecord | null | undefined, used: Parameters<typeof assertStoredConnectedAppAccess>[1], noLimits: boolean, inventory?: InventoryServices | null): void {
  if (!bot) throw unavailable();
  assertStoredConnectedAppAccess(bot, used, { noLimits, ...(inventory !== undefined ? { inventory } : {}) });
}
