import type { Bot } from "@/state/store";

/** The approval level a conversation runs at: Ask, Auto, Full access, or No
 * limits (Full access without the stop line). Each only counts on top of the
 * one below it, as the server reads it. */
export type PermissionMode = "ask" | "auto" | "full" | "unlimited";

export function permissionModeOf(bot: Pick<Bot, "autoApprove" | "fullAccess"> & { noLimits?: boolean }): PermissionMode {
  if (!bot.autoApprove) return "ask";
  if (!bot.fullAccess) return "auto";
  return bot.noLimits ? "unlimited" : "full";
}

/** Full access and No limits are the desktop app's decision alone. */
export function isDesktopOnlyMode(mode: PermissionMode): boolean {
  return mode === "full" || mode === "unlimited";
}

/** What choosing an approval level as a bot's default does next: save it, or
 * first show the one-time Full access or No limits warning (which also covers
 * this computer when the bot drives it) or the Auto-on-this-computer warning.
 * The same order as the composer's switch; the server refuses a save that
 * skipped a warning either way. `needsLocalWarning` is
 * `autoNeedsLocalComputerWarning` for the bot as it stands. */
export type DefaultModeStep =
  | { kind: "patch"; patch: { autoApprove: boolean; fullAccess: boolean; noLimits?: boolean } }
  | { kind: "full-warning"; onThisComputer: boolean }
  | { kind: "no-limits-warning"; onThisComputer: boolean }
  | { kind: "local-warning"; mode: "auto" | "full" | "unlimited" };

export function defaultModeStep(
  bot: Pick<Bot, "autoApprove" | "fullAccess" | "fullAccessAcknowledgedAt"> & { noLimitsAcknowledgedAt?: number },
  mode: PermissionMode,
  needsLocalWarning: boolean,
): DefaultModeStep {
  const needsLocal = mode !== "ask" && needsLocalWarning;
  if (mode === "unlimited") {
    if (bot.noLimitsAcknowledgedAt === undefined) return { kind: "no-limits-warning", onThisComputer: needsLocal };
    if (needsLocal) return { kind: "local-warning", mode: "unlimited" };
    return { kind: "patch", patch: { autoApprove: true, fullAccess: true, noLimits: true } };
  }
  if (mode === "full") {
    if (bot.fullAccessAcknowledgedAt === undefined) return { kind: "full-warning", onThisComputer: needsLocal };
    if (needsLocal) return { kind: "local-warning", mode: "full" };
    return { kind: "patch", patch: { autoApprove: true, fullAccess: true, noLimits: false } };
  }
  if (needsLocal) return { kind: "local-warning", mode: "auto" };
  return { kind: "patch", patch: { autoApprove: mode === "auto", fullAccess: false } };
}

/** The patch the server takes for a level, warnings aside. */
export function modePatch(mode: PermissionMode): { autoApprove?: boolean; fullAccess?: boolean; noLimits?: boolean } {
  if (mode === "unlimited") return { noLimits: true };
  if (mode === "full") return { fullAccess: true };
  return { autoApprove: mode === "auto", fullAccess: false };
}

/** Full access is the desktop app's decision alone (server/full-access.ts).
 * Anywhere else the server refuses it with the bare 404 every desktop-only
 * setting gives, so the owner is told this instead. */
export const FULL_ACCESS_DESKTOP_ONLY = "Full access can only be turned on in the Murage desktop app.";
export const NO_LIMITS_DESKTOP_ONLY = "No limits can only be turned on in the Murage desktop app.";
export const FULL_ACCESS_OPTIONS_DESKTOP_ONLY = "Full access options can only be changed in the Murage desktop app.";

/** The plain-words reason for a refused save that asked for Full access (or
 * changed one of its options) from a surface that is not the desktop app;
 * null for every other failure, which keeps the server's own message. */
export function fullAccessRefusalMessage(patch: object, error: unknown): string | null {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (status !== 403 && status !== 404) return null;
  const fields = patch as { fullAccess?: unknown; noLimits?: unknown };
  if (fields.noLimits === true) return NO_LIMITS_DESKTOP_ONLY;
  if (fields.fullAccess === true) return FULL_ACCESS_DESKTOP_ONLY;
  if (Object.hasOwn(patch, "fullAccessChannelMessages") || Object.hasOwn(patch, "fullAccessSetupRequests")) return FULL_ACCESS_OPTIONS_DESKTOP_ONLY;
  return null;
}

/** Bot Settings' switch for the bot-to-bot contact card, and the line under
 * it. The line says what the switch's CURRENT position means in the label's
 * own terms: it used to describe the off position as "Let this bot talk to
 * teammates on its own", which read as the opposite of the label beside it.
 * Full access skips the card in a turn the owner started (server/index.ts,
 * fullAccessSkipsPeerCard) while webhook and routine turns still ask, so with
 * Full access as the default the switch cannot promise to always stop. */
export const PEER_CONTACT_LABEL = "Ask me before contacting other bots";
export function peerContactHint(bot: Pick<Bot, "autoApprove" | "fullAccess" | "approvePeerComms"> & { noLimits?: boolean }): string {
  if (!bot.approvePeerComms) return "Off: this bot contacts other bots without asking you first.";
  const mode = permissionModeOf(bot);
  if (mode === "full" || mode === "unlimited") {
    return `On, but ${mode === "full" ? "Full access" : "No limits"} skips this in conversations you start; webhook and routine turns still stop and ask. Switch to Auto to be asked every time.`;
  }
  return "On: this bot stops and asks you before it contacts another bot.";
}

/** The routine whose own conversation this is, if any: every run of that
 * routine works here, so this conversation's approval level is the routine's
 * (server/routines.ts routineForConversation). */
export function routineOfConversation<T extends { botId: string; threadId?: string; target?: string }>(
  routines: readonly T[],
  botId: string,
  threadId: string | undefined,
): T | undefined {
  if (!threadId) return undefined;
  return routines.find((routine) => routine.botId === botId && routine.threadId === threadId && (routine.target ?? "bot") === "bot");
}

/** The level a routine's runs are judged at: its own, or its bot's level
 * (the bot's own setting, not any one conversation's). */
export function routineEffectiveMode(
  routine: { permissionMode?: PermissionMode },
  profile: Pick<Bot, "autoApprove" | "fullAccess"> & { noLimits?: boolean },
): PermissionMode {
  return routine.permissionMode ?? permissionModeOf(profile);
}
