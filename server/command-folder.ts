import { commandCwdFromToolInput } from "../shared/exact-command.ts";
import { botFolderOrThrow } from "./bot-folder.ts";
import type { AutoVerdict } from "./auto-approve.ts";

/** Preserve explicit evidence. A lost or malformed explicit cwd is never defaulted. */
export function commandFolderContext(input: unknown, turnCwd: string | undefined): { cwd?: string; invalid: boolean } {
  if (input !== null && typeof input === "object" && "cwdInvalid" in input && input.cwdInvalid === true) return { invalid: true };
  const named = commandCwdFromToolInput(input);
  const explicit = input !== null && typeof input === "object" && "cwdExplicit" in input && input.cwdExplicit === true;
  if (named === null || (explicit && named === undefined)) return { invalid: true };
  try { return { cwd: botFolderOrThrow({ cwd: named === undefined ? turnCwd : named }), invalid: false }; }
  catch { return { invalid: true }; }
}

/** Applied before level, routine, and remembered-grant relief. */
export function commandFolderRefusal(input: unknown, turnCwd: string | undefined): AutoVerdict | null {
  return commandFolderContext(input, turnCwd).invalid
    ? { approve: null, source: "always-ask", rule: "D3-command-cwd", note: "The command's folder is unknown or conflicting." }
    : null;
}
