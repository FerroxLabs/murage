import type { Bot } from "@/state/store";

/** The approval level a conversation runs at: Ask, Auto, or Full access
 * (which only counts on top of Auto, as the server reads it). */
export type PermissionMode = "ask" | "auto" | "full";

export function permissionModeOf(bot: Pick<Bot, "autoApprove" | "fullAccess">): PermissionMode {
  return bot.autoApprove ? (bot.fullAccess ? "full" : "auto") : "ask";
}
