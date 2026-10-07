// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A routine keeps the approval ceiling chosen at creation or by an owner
// edit. Runs use the lower of that ceiling and the bot's current level.
// Older routines receive a ceiling when the manager loads them.
//
// This only says WHICH level a routine run is judged at. What each level
// lets through is still decided in one place, server/auto-approve.ts, where
// the key guard and stop line hold at every level for routine runs.

import { autoVerdict, type AutoApprover, type AutoContext, type AutoVerdict, type FullAccessOrigin } from "./auto-approve.ts";
import type { SendTurnInput } from "./contracts.ts";
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

/** The lower of the stored ceiling and the bot's current level. A routine
 * awaiting migration still uses the bot's current level. */
export function effectiveRoutinePermissionMode(
  routine: { permissionMode?: RoutinePermissionMode },
  bot: AutoApprover | null | undefined,
): RoutinePermissionMode {
  const current = botPermissionMode(bot);
  const ceiling = loadRoutinePermissionMode(routine.permissionMode) ?? current;
  return ROUTINE_PERMISSION_MODES[Math.min(ROUTINE_PERMISSION_MODES.indexOf(ceiling), ROUTINE_PERMISSION_MODES.indexOf(current))]!;
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

/** Server-owned ancestry carried across an immediate or queued peer contact. */
export interface RoutinePeerSource {
  permissionMode: RoutinePermissionMode;
  triggerSource: "manual" | "schedule";
}

/** A queued handoff keeps no more than the routine's level right now. */
export function capQueuedPeerSource(queued: RoutinePeerSource, live: RoutinePermissionMode | null | undefined): RoutinePeerSource {
  if (!live) return queued;
  const i = Math.min(ROUTINE_PERMISSION_MODES.indexOf(queued.permissionMode), ROUTINE_PERMISSION_MODES.indexOf(live));
  return { ...queued, permissionMode: ROUTINE_PERMISSION_MODES[i]! };
}

export function peerTurnAuthority(peer: AutoApprover, parentRun: RoutinePeerSource): {
  mode: RoutinePermissionMode; origin: FullAccessOrigin; unattended: boolean;
} {
  return {
    mode: effectiveRoutinePermissionMode(parentRun, peer),
    origin: "routine",
    unattended: parentRun.triggerSource === "schedule",
  };
}

/** Every turn reaches the broker, without changing other instance modes. */
export function turnPermissionEnforcement(bot: AutoApprover): Pick<SendTurnInput, "routeAsks" | "stopLine"> {
  const mode = botPermissionMode(bot);
  return mode === "ask" || mode === "auto" ? { routeAsks: true } : { stopLine: true };
}

/** Direct tasks and room speakers use the same routine permission decision. */
export function routineTurnApproval(input: {
  bot?: AutoApprover;
  speaker?: AutoApprover;
  run?: { permissionMode?: RoutinePermissionMode; alwaysAllow?: readonly string[] } | null;
  tool: string;
  summary: string;
  context?: AutoContext;
}): { mode: RoutinePermissionMode; verdict: AutoVerdict } {
  const actor = input.bot ?? input.speaker ?? {};
  const mode = input.run ? effectiveRoutinePermissionMode(input.run, actor) : botPermissionMode(actor);
  return {
    mode,
    verdict: autoVerdict(input.run ? applyRoutinePermissionMode(actor, mode) : actor, input.tool, input.summary, {
      ...input.context,
      ...(input.run ? { automated: true, routineLevel: true, routineAllow: input.run.alwaysAllow } : {}),
    }),
  };
}

/** Missing levels are pinned by the manager. Invalid stored values use Ask. */
export function loadRoutinePermissionMode(value: unknown): RoutinePermissionMode | undefined {
  return value === undefined ? undefined : isMode(value) ? value : "ask";
}

/** From the editor: a level, or `inherit` / null to pin the bot's level now. */
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
