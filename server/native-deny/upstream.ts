// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The only bridge to 1.0.19-owned modules. Work-ahead does not change their exports.
import { ALWAYS_ASK_NO_LIMITS, alwaysAskCommand, protectedClass } from "../always-ask.ts";
import { ownerMarks } from "../shell/marks.ts";
import { HOME, normalizePath, resolveFrom } from "../shell/walk.ts";
import { noLimitsCode, readCode } from "../no-limits-code.ts";
export { ALWAYS_ASK_NO_LIMITS, HOME, normalizePath, resolveFrom };
export type { AlwaysAskRule, AlwaysAskHit, ProtectedClass } from "../always-ask.ts";
export { GATE_MESSAGE_BYTES } from "../../shared/scan-limits.ts";
export { hookSocketPath, newHookToken, parseApplyPatch, placeEditPaths } from "../drivers/codex-hook.ts";
export { noLimitsInitiator } from "../auto-approve.ts";
export const protectedPathClass = (path: string) => ownerMarks(() => protectedClass(path));
export const readNativeCommand = (text: string, cwd: string, home: string, pwsh = false) =>
  ownerMarks(() => alwaysAskCommand(text, cwd, "command", pwsh ? "pwsh" : undefined, undefined, home));
function readSource(identity: "execute_code" | "terminal", source: string) {
  const result = noLimitsCode(identity, source);
  // The final class can prefer the waivable word proxy over a cut. Preserve
  // completeness even then; only that ambiguous class needs a second read.
  const incomplete = result.cls === "truncated" || result.cls === "plainWipe" && readCode(identity, source).reads.some(read => read.state === "cut");
  return { ...result, incomplete };
}
// These identities are trusted adapter facts, never chosen by payload fields.
export const readNativeCode = (code: string) => readSource("execute_code", code);
export const readNativeShell = (command: string) => readSource("terminal", command);
