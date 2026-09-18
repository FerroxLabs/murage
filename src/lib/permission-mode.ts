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
