import { commandCwdFromToolInput } from "../shared/exact-command.ts";
import { botFolderOrThrow } from "./bot-folder.ts";
import { finalizeNoLimits, type AutoApprover, type AutoContext, type AutoVerdict } from "./auto-approve.ts";

/** Preserve explicit evidence. A lost or malformed explicit cwd is never defaulted. */
export function commandFolderExplicitInvalid(input: unknown): boolean {
  if (input !== null && typeof input === "object" && "cwdInvalid" in input && input.cwdInvalid === true) return true;
  const named = commandCwdFromToolInput(input);
  const explicit = input !== null && typeof input === "object" && "cwdExplicit" in input && input.cwdExplicit === true;
  return named === null || (explicit && named === undefined);
}

/** The folder verdict for a command tool whose command text could not be read: explicit invalid evidence, or a supplied cwd that is not a usable bot folder. */
export function commandFolderInvalidWithoutText(input: unknown, turnCwd: string | undefined): boolean {
  if (commandFolderExplicitInvalid(input)) return true;
  return commandCwdFromToolInput(input) !== undefined && commandFolderContext(input, turnCwd).invalid;
}

export function commandFolderContext(input: unknown, turnCwd: string | undefined): { cwd?: string; invalid: boolean } {
  if (commandFolderExplicitInvalid(input)) return { invalid: true };
  const named = commandCwdFromToolInput(input);
  try { return { cwd: botFolderOrThrow({ cwd: named === undefined ? turnCwd : named }), invalid: false }; }
  catch { return { invalid: true }; }
}

/** Applied before level, routine, and remembered-grant relief. */
export function commandFolderRefusal(input: unknown, turnCwd: string | undefined): AutoVerdict | null {
  return commandFolderContext(input, turnCwd).invalid
    ? { approve: null, source: "always-ask", classification: "deny", rule: "D3-command-cwd", note: "The command's folder is unknown or conflicting." }
    : null;
}

/** NOLIM 1.0.19 R1. The refusal above never reaches autoVerdict, so it passes through the same one finalizer here: under No limits
 * the owner's own turn runs it (one auto log line, no card), while a wipe-list command, work another person started and every other
 * level keep the typed deny card. A finalizer fault keeps the card. */
export function commandFolderVerdict(
  bot: AutoApprover | null | undefined, tool: string, summary: string, refusal: AutoVerdict | null, context: AutoContext,
): AutoVerdict | null {
  if (refusal === null || !bot) return refusal;
  return finalizeNoLimits(bot, tool, summary, context, refusal);
}
