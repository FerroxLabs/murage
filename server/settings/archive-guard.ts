// C6 archive guard. Owner: lane roster (Settings v10 BUILD-PLAN §3). core's bot PATCH calls it once, before any write,
// whenever the body carries `hidden`.
// Archiving a bot with saved app choices resets them (its role binding changes), so the request must name the
// `accessRevision` the owner reviewed. A stale or missing one answers 409 with nothing archived and nothing reset.
import { botAccessPolicy, type AccessRole } from "../bot-access-role.ts";
import type { ArchiveGuardResult } from "../../shared/settings-v10/archive-guard.ts";

export function checkArchiveRevision(bot: AccessRole & { connectedAppAccess?: unknown }, body: Record<string, unknown>): ArchiveGuardResult {
  if (body.hidden !== true || bot.hidden === true || bot.connectedAppAccess === undefined) return { ok: true };
  if (body.accessRevision === botAccessPolicy(bot).revision) return { ok: true };
  return {
    ok: false,
    status: 409,
    body: { error: "This bot's app choices changed, or were not reviewed. Look again before archiving it.", code: "ACCESS_CHANGED", botId: bot.id },
  };
}
