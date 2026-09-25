// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A routine's approval level. A routine run used to be judged as Auto
// whatever the bot was on, because nobody starts it at the desktop: a No
// limits bot's 30-minute sweep hit a card nobody was there to answer and died
// at its run limit. The level now lives on the routine. Absent means the
// routine inherits the bot's level at the moment the run starts; the owner
// can pick a level for one routine in its editor.
//
// This only says WHICH level a routine run is judged at. What each level
// lets through is still decided in one place, server/auto-approve.ts, where
// the key guard holds at every level and the stop line holds below No limits.

import type { AutoApprover } from "./auto-approve.ts";
import { isStopLineKey } from "./stop-line.ts";
import { parseExactCommandKey } from "../shared/exact-command.ts";

/** How many "Always allow for this routine" grants one routine keeps, the
 * same cap a bot's own list has. */
export const ROUTINE_GRANTS_MAX = 200;

export type RoutinePermissionMode = "ask" | "auto" | "full" | "unlimited";

export const ROUTINE_PERMISSION_MODES: readonly RoutinePermissionMode[] = ["ask", "auto", "full", "unlimited"];

function isMode(value: unknown): value is RoutinePermissionMode {
  return typeof value === "string" && (ROUTINE_PERMISSION_MODES as readonly string[]).includes(value);
}

/** A bot's (or task's) level from its flags. Each level counts only on top of
 * the one below it, the same rule hasFullAccess and hasNoLimits apply. */
export function botPermissionMode(bot: AutoApprover | null | undefined): RoutinePermissionMode {
  if (bot?.autoApprove !== true) return "ask";
  if (bot.fullAccess !== true) return "auto";
  return bot.noLimits === true ? "unlimited" : "full";
}

/** The level a routine run is judged at: its own, or the bot's current one. */
export function effectiveRoutinePermissionMode(
  routine: { permissionMode?: RoutinePermissionMode },
  bot: AutoApprover | null | undefined,
): RoutinePermissionMode {
  return routine.permissionMode ?? botPermissionMode(bot);
}

/** The same record judged at `mode`. Grants and every other field are kept. */
export function applyRoutinePermissionMode<T extends AutoApprover>(bot: T, mode: RoutinePermissionMode): T {
  return {
    ...bot,
    autoApprove: mode !== "ask",
    fullAccess: mode === "full" || mode === "unlimited",
    noLimits: mode === "unlimited",
  };
}

/** From routines.json: an older file has no level (inherit), and an unknown
 * value is treated the same way rather than dropping the routine. */
export function loadRoutinePermissionMode(value: unknown): RoutinePermissionMode | undefined {
  return isMode(value) ? value : undefined;
}

/** From the editor: a level, or `inherit` / null to follow the bot. */
export function routinePermissionModeInput(value: unknown): RoutinePermissionMode | null {
  if (value === null || value === "inherit") return null;
  if (isMode(value)) return value;
  throw new Error("Choose an approval level for this routine");
}

/** Is this a grant "Always allow for this routine" may hold? Only the two
 * scoped kinds: an exact command in one folder on one engine
 * (shared/exact-command.ts), or a stop-line place (server/stop-line.ts).
 * Never a bare tool name or a per-program key: a routine runs with nobody
 * watching, so what it is allowed must name exactly what the owner saw. */
export function isRoutineGrantKey(key: unknown): key is string {
  return typeof key === "string" && key.length <= 6_000 && (isStopLineKey(key) || parseExactCommandKey(key) !== undefined);
}

/** A routine's stored grants, cleaned: scoped keys only, no repeats, capped. */
export function routineGrantKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isRoutineGrantKey))].slice(0, ROUTINE_GRANTS_MAX);
}
