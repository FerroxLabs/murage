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
import { redactSecretsInText } from "./redact.ts";
import { REDIRECT_TOOL, type CarvedTarget } from "./always-ask.ts";
import { parseExactCommandKey } from "../shared/exact-command.ts";
import { APP_ACTION_PREFIX, APP_LOOKUPS, isCurrentAppGrant } from "../shared/app-action-words.ts";
import { CONNECTED_APPS_SERVER, exposedToolName } from "../shared/connected-app-names.ts";

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
  // a draft-only bot (server/draft-only.ts) is at Ask whatever its flags say
  if ((bot as { draftOnly?: true } | null | undefined)?.draftOnly === true) return "ask";
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
  // no level lifts a draft-only bot past Ask (server/draft-only.ts)
  if ((bot as { draftOnly?: true }).draftOnly === true) mode = "ask";
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

/** Every turn reaches the broker, without changing other instance modes. An Ask turn also says so (askLevel), so an
 *  engine that cannot ask before every change runs it read-only (server/drivers/ask-stop.ts). */
export function turnPermissionEnforcement(bot: AutoApprover): Pick<SendTurnInput, "routeAsks" | "stopLine" | "askLevel"> {
  const mode = botPermissionMode(bot);
  return mode === "ask" ? { routeAsks: true, askLevel: true } : mode === "auto" ? { routeAsks: true } : { stopLine: true };
}

/** AMEND-13 Rule 76b: a routine's remembered keys reach only the bot the
 * server proves is executing that same active run (the run's own bot, the
 * lead coordinator for a room goal). Another member speaking in the same
 * room shares the run's thread and ceiling, never its keys. The asker is
 * the server's own record of who raised the request, never a client claim.
 * Astra a13 r1 item 2: the CURRENT turn must be that run's own turn, by the
 * run id the server bound to the turn where it started it (`turnRunId`). A
 * waiting run outlives its turn, so an ordinary turn on the same thread, a
 * webhook or peer turn, or another run's turn, gets none of its keys. */
export function routineRunGrants(run: { runId: string; botId: string; alwaysAllow: readonly string[] }, askerId: string, turnRunId: string | undefined): { executing: boolean; alwaysAllow: string[] } {
  const executing = askerId !== "" && askerId === run.botId && turnRunId !== undefined && turnRunId === run.runId;
  return { executing, alwaysAllow: executing ? [...run.alwaysAllow] : [] };
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

/** Rule 76a (AMEND-13): the four connector lookups, each by its own
 * canonical key. Finding or describing a tool never permits running it. */
const ROUTINE_LOOKUP_KEYS: ReadonlySet<string> = new Set(Object.keys(APP_LOOKUPS).map((app) => `mcp__${CONNECTED_APPS_SERVER}__${exposedToolName(app)}`));

/** Is this a grant "Always allow for this routine" may hold? Rule 45 as
 * AMEND-13 Rule 76 reads it: an exact command in one folder on one engine
 * (shared/exact-command.ts), a permitted stop-line place (server/stop-line.ts,
 * never `stop:browser:`), one exact connected-app action
 * (`app-action:SLUG`), or one of the four connector lookups. Never a bare
 * tool or execute tool, an app-wide grant, a wildcard, a generic kind, a
 * per-program key or a custom/external tool: a routine runs with nobody
 * watching, so what it is allowed must name exactly what the owner saw.
 * Load, the grant route and the manager share this one validator. */
export function isRoutineGrantKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length > 6_000) return false;
  if (key.startsWith("stop:browser:")) return false;
  if (isStopLineKey(key) || parseExactCommandKey(key) !== undefined) return true;
  if (key.startsWith(APP_ACTION_PREFIX)) return isCurrentAppGrant(key);
  return ROUTINE_LOOKUP_KEYS.has(key);
}

/** A routine's stored grants, cleaned: scoped keys only, no repeats, capped.
 * Invalid stored entries are discarded, never translated (Rule 76d). */
export function routineGrantKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isRoutineGrantKey))].slice(0, ROUTINE_GRANTS_MAX);
}

/** How many carved targets one history line names; the rest are counted. */
const LINE_TARGETS_MAX = 4;
/** The longest one recorded field may be in the line. */
const LINE_FIELD_MAX = 60;

/** One recorded field: masked for secrets first (a second layer: the field
 * is a tool name or a target expression, never another argument), then
 * shortened, so a cut can only show more of that same field. */
function lineField(text: string): string {
  const flat = redactSecretsInText(text).replace(/\s+/g, " ").trim();
  return flat.length > LINE_FIELD_MAX ? `${flat.slice(0, LINE_FIELD_MAX - 3)}...` : flat;
}

/** The routine carve-out's one line in a run's history: a command whose
 * write or delete target was held in a value ran without a card. It names
 * only the tool and the target expression the carve-out matched
 * (`rm on "$TMP"`, `a redirect to "$OUT"`): never the command's other
 * arguments, a literal string or a redirect's source, so a password the
 * command carries never reaches it. The routine and its run are the run
 * record the line is kept on. */
export function routineValueTargetLine(targets: readonly CarvedTarget[]): string {
  const shown = targets.slice(0, LINE_TARGETS_MAX).map(({ tool, target }) =>
    tool === REDIRECT_TOOL ? `${REDIRECT_TOOL} to ${lineField(target)}` : `${lineField(tool)} on ${lineField(target)}`);
  const more = targets.length - shown.length;
  return `Ran without asking, target held in a value: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
}

/** The card the routine carve-out raises instead when that history line
 * could not be written: the command waits for the owner, as any command the
 * carve-out cannot record does. */
export function routineRecordUnwrittenVerdict(): AutoVerdict {
  return {
    approve: null,
    source: "always-ask",
    rule: "run-record-unwritten",
    note: "Murage could not write this command into the routine's run record, so it asks before running it.",
  };
}

/** A13-FIX-DESIGN C4 (Rules 76, 81, 83): whether a thread is one this
 * routine's cards are raised on. A bot routine's are on that bot's own task
 * threads; a room goal's are on its own room's threads, resolved through the
 * room's real members (the routine's bot must be one of them), never through
 * a bot's task list, where a room's threads never are. */
export function routineCardThreadOf(
  routine: { botId: string; target?: string; groupId?: string | null },
  threadId: string,
  lookup: {
    taskByThread: (botId: string, threadId: string) => unknown;
    groupByThread: (threadId: string) => { id: string; memberIds: readonly string[] } | undefined;
  },
): boolean {
  if (routine.target === "room-goal") {
    const group = lookup.groupByThread(threadId);
    return Boolean(group && routine.groupId && group.id === routine.groupId && group.memberIds.includes(routine.botId));
  }
  return Boolean(lookup.taskByThread(routine.botId, threadId));
}
