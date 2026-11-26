// GET/PUT /api/bots/:id/access (owner: lane access). Extracted by core's Settings v10 SEAT from index.ts, behaviour
// unchanged. index.ts supplies the turn and revocation state it does not own through AccessRouteDeps.
import type { IncomingMessage, ServerResponse } from "node:http";
import { accessOwnerView, reviewBotAccess } from "../bot-access.ts";
import { applyLevelsAction, isLevelsAction, levelsOwnerView, type SettledRead } from "../bot-access-levels.ts";
import type { InventoryServices } from "../connected-inventory.ts";
import { permissionStatus, type PendingPermissionInput } from "../permission-status.ts";
import { serviceNoLimits } from "../service-no-limits.ts";
import type { BotRecord, Store } from "../store.ts";

export const BOT_ACCESS_ROUTE = /^\/api\/bots\/([\w-]+)\/access$/;

export interface AccessRouteDeps {
  store: Store;
  json: (res: ServerResponse, status: number, body: unknown) => unknown;
  readBody: (req: IncomingMessage) => Promise<any>;
  currentConnectedAccessAccounts: (options?: { remembered?: boolean }) => Promise<Array<{ toolkit: string; accountId: string } & Record<string, unknown>>>;
  internalTurnOwners: () => Iterable<[string, { botId: string; generation: string }]>;
  revokeInternalThread: (threadId: string) => void;
  revokeInternalBot: (botId: string) => void;
  pendingPermissionStatus: (bot: BotRecord) => PendingPermissionInput[];
  /** Per-app level saves: a settled read for raises and keep-current, and what is remembered (null when nothing is). */
  levelsInventory?: { readSettled: SettledRead; remembered: () => Promise<InventoryServices | null> };
}

/** Answers the bot access route; returns false when the path or method is not this route's. */
export async function handleBotAccessRoute(method: string, path: string, req: IncomingMessage, res: ServerResponse, deps: AccessRouteDeps): Promise<boolean> {
  const accessRoute = BOT_ACCESS_ROUTE.exec(path);
  // one guard, in this form, so route discovery (server/testing/route-discovery.ts) reads the methods it answers
  if (accessRoute && (method === "GET" || method === "PUT")) {
    const { store, json } = deps;
    const bot = store.bot(accessRoute[1]);
    if (!bot) { json(res, 404, { error: "Bot not found." }); return true; }
    if (method === "PUT" && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) { json(res, 415, { error: "content-type must be application/json" }); return true; }
    const body = method === "PUT" ? await deps.readBody(req) : undefined;
    // A levels save reads its own inventory; a failed account list only thins the answer's display list.
    const levelsPut = method === "PUT" && isLevelsAction(body);
    const accounts = levelsPut ? await deps.currentConnectedAccessAccounts({ remembered: true }).catch(() => []) : await deps.currentConnectedAccessAccounts({ remembered: method === "GET" });
    let levelsOwner: (ReturnType<typeof levelsOwnerView> & { pausedBySave: unknown }) | undefined;
    if (levelsPut) {
      const remembered = await deps.levelsInventory?.remembered().catch(() => null) ?? null;
      let answer;
      try { answer = await applyLevelsAction(store, bot.id, body, { ...(deps.levelsInventory ? { readSettled: deps.levelsInventory.readSettled } : {}), remembered, rememberedComplete: false }); }
      catch (error) {
        const failure = error as Error & { status?: number; code?: string; theirs?: unknown };
        if (typeof failure.status !== "number") throw error;
        json(res, failure.status, { error: failure.message, ...(failure.code ? { code: failure.code } : {}), ...(failure.theirs ? { theirs: failure.theirs } : {}) });
        return true;
      }
      if (answer.postCommitError) console.error("Access saved; the roster follow-up failed:", answer.postCommitError);
      // Only a lowering ends running turns; a raise or a no-op leaves them alone (shipped No limits split kept).
      if (answer.lowered) {
        const turns = [...deps.internalTurnOwners()].filter(([, owner]) => owner.botId === bot.id);
        if (turns.some(([threadId, owner]) => serviceNoLimits(owner.generation, threadId, bot.id))) {
          for (const [threadId, owner] of turns) if (!serviceNoLimits(owner.generation, threadId, bot.id)) deps.revokeInternalThread(threadId);
        } else deps.revokeInternalBot(bot.id);
      }
      const saved = store.bot(bot.id);
      if (saved) levelsOwner = { ...levelsOwnerView(saved, remembered), pausedBySave: answer.pausedBySave };
    } else if (method === "PUT") {
      reviewBotAccess(store, bot.id, body, accounts);
      const turns = [...deps.internalTurnOwners()].filter(([, owner]) => owner.botId === bot.id);
      if (turns.some(([threadId, owner]) => serviceNoLimits(owner.generation, threadId, bot.id))) {
        for (const [threadId, owner] of turns) if (!serviceNoLimits(owner.generation, threadId, bot.id)) deps.revokeInternalThread(threadId);
      } else deps.revokeInternalBot(bot.id);
    }
    const current = store.bot(bot.id);
    if (!current) { json(res, 404, { error: "Bot not found." }); return true; }
    json(res, 200, { ...accessOwnerView(current), ...(levelsOwner ? { levels: levelsOwner } : {}), accounts,
      pending: current.hidden ? [] : permissionStatus(store, current, current.id, deps.pendingPermissionStatus(current)).pending });
    return true;
  }
  return false;
}
