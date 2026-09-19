import type { Bot } from "@/state/store";

/** The approval level a conversation runs at: Ask, Auto, or Full access
 * (which only counts on top of Auto, as the server reads it). */
export type PermissionMode = "ask" | "auto" | "full";

export function permissionModeOf(bot: Pick<Bot, "autoApprove" | "fullAccess">): PermissionMode {
  return bot.autoApprove ? (bot.fullAccess ? "full" : "auto") : "ask";
}

/** What choosing an approval level as a bot's default does next: save it, or
 * first show the one-time Full access warning (which also covers this
 * computer when the bot drives it) or the Auto-on-this-computer warning.
 * The same order as the composer's switch; the server refuses a save that
 * skipped a warning either way. `needsLocalWarning` is
 * `autoNeedsLocalComputerWarning` for the bot as it stands. */
export type DefaultModeStep =
  | { kind: "patch"; patch: { autoApprove: boolean; fullAccess: boolean } }
  | { kind: "full-warning"; onThisComputer: boolean }
  | { kind: "local-warning"; mode: "auto" | "full" };

export function defaultModeStep(
  bot: Pick<Bot, "autoApprove" | "fullAccess" | "fullAccessAcknowledgedAt">,
  mode: PermissionMode,
  needsLocalWarning: boolean,
): DefaultModeStep {
  const needsLocal = mode !== "ask" && needsLocalWarning;
  if (mode === "full") {
    if (bot.fullAccessAcknowledgedAt === undefined) return { kind: "full-warning", onThisComputer: needsLocal };
    if (needsLocal) return { kind: "local-warning", mode: "full" };
    return { kind: "patch", patch: { autoApprove: true, fullAccess: true } };
  }
  if (needsLocal) return { kind: "local-warning", mode: "auto" };
  return { kind: "patch", patch: { autoApprove: mode === "auto", fullAccess: false } };
}

/** Full access is the desktop app's decision alone (server/full-access.ts).
 * Anywhere else the server refuses it with the bare 404 every desktop-only
 * setting gives, so the owner is told this instead. */
export const FULL_ACCESS_DESKTOP_ONLY = "Full access can only be turned on in the Murage desktop app.";
export const FULL_ACCESS_OPTIONS_DESKTOP_ONLY = "Full access options can only be changed in the Murage desktop app.";

/** The plain-words reason for a refused save that asked for Full access (or
 * changed one of its options) from a surface that is not the desktop app;
 * null for every other failure, which keeps the server's own message. */
export function fullAccessRefusalMessage(patch: object, error: unknown): string | null {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (status !== 403 && status !== 404) return null;
  const fields = patch as { fullAccess?: unknown };
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
export function peerContactHint(bot: Pick<Bot, "autoApprove" | "fullAccess" | "approvePeerComms">): string {
  if (!bot.approvePeerComms) return "Off: this bot contacts other bots without asking you first.";
  if (permissionModeOf(bot) === "full") {
    return "On, but Full access skips this in conversations you start; webhook and routine turns still stop and ask. Switch to Auto to be asked every time.";
  }
  return "On: this bot stops and asks you before it contacts another bot.";
}
