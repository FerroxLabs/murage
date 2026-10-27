// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from "node:sqlite";
import { createProjectCard } from "./project-cards.ts";
import { activeProjectGoal, insertProjectActivity, insertRoomRequest, projectSettingsFor, roomRequestByAdmissionKey } from "./project-records.ts";
import type { RoomRequest } from "./room-requests.ts";
import type { AutoApprover } from "./auto-approve.ts";
import { effectiveRoutinePermissionMode, ROUTINE_PERMISSION_MODES, type RoutinePeerSource, type RoutinePermissionMode } from "./routine-permissions.ts";

/** Caller owns the transaction; E1 dispatches the queued request. */
export function recordProjectRoutine(db: DatabaseSync, input: { groupId: string; threadId: string; memberIds: string[]; runId: string; botId: string; name: string; prompt: string; now: number; authority?: { routineId: string; ceiling: RoutinePeerSource; ownerBinding: string; audienceBinding: string } }): { requestId: string; created: boolean } {
  if (input.authority && !db.isTransaction) throw new Error("Routine authority requires the request transaction");
  const admissionKey = `routine:${input.runId}`;
  const existing = roomRequestByAdmissionKey(db, admissionKey);
  if (existing) return { requestId: String(existing.id), created: false };
  const settings = projectSettingsFor(db, input.groupId);
  if (!settings || settings.endedAt !== null || settings.closedAt !== null) throw new Error("This project is not open.");
  const goal = activeProjectGoal(db, input.groupId);
  let cardId: string | null = null;
  if (!goal && settings.mode === "ongoing") {
    const made = createProjectCard(db, { groupId: input.groupId, title: input.name.slice(0, 120), description: input.prompt.slice(0, 2000), assigneeBotId: input.botId, actor: { kind: "server" }, createdBy: "server", createKey: admissionKey, memberIds: input.memberIds, now: input.now });
    if (!made.ok) throw new Error(made.reason);
    cardId = made.card.id;
  }
  const requestId = insertRoomRequest(db, { groupId: input.groupId, verb: "routine", fromKind: "routine", origin: "server", admissionKey, payloadText: input.prompt, projectGoalId: goal?.id, workItemId: cardId, toBotId: goal ? settings.leadBotId : input.botId, rootThreadId: input.threadId, targetThreadId: input.threadId, unattended: true, now: input.now });
  if (!requestId) throw new Error("The routine could not be queued.");
  if (input.authority) {
    const a = input.authority;
    if (!["manual", "schedule"].includes(a.ceiling.triggerSource ?? "") || !ROUTINE_PERMISSION_MODES.includes(a.ceiling.permissionMode)) throw new Error("Invalid routine authority");
    db.prepare(`INSERT INTO project_routine_authority VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?)`).run(
      requestId, input.runId, a.routineId, input.botId, input.groupId, input.threadId,
      goal ? settings.leadBotId! : input.botId, admissionKey, a.ownerBinding, a.audienceBinding,
      a.ceiling.triggerSource!, a.ceiling.permissionMode);
  }
  insertProjectActivity(db, { groupId: input.groupId, kind: "routine_run", actor: "server", workItemId: cardId, goalId: goal?.id, requestId, at: input.now, detail: { runId: input.runId, threadId: input.threadId } });
  return { requestId, created: true };
}

/** Preserve pre-upgrade routine threads as Activity links, without moving them. */
export function linkLegacyProjectRoutineRuns(db: DatabaseSync, runs: ReadonlyArray<{ id: string; groupId?: string; threadId?: string; target: string; createdAt: number }>): void {
  for (const run of runs) {
    if (run.target !== "room-goal" || !run.groupId || !run.threadId || !projectSettingsFor(db, run.groupId)) continue;
    if (db.prepare("SELECT 1 FROM project_activity WHERE group_id=? AND kind='routine_run' AND json_extract(detail,'$.runId')=?").get(run.groupId, run.id)) continue;
    insertProjectActivity(db, { groupId: run.groupId, kind: "routine_run", actor: "server", at: run.createdAt, detail: { runId: run.id, threadId: run.threadId } });
  }
}

export function projectMainThread(group: { threadId: string; tasks?: Array<{ threadId: string; createdAt: number }> }): string {
  return group.threadId;
}

// ── NOLIMITS-PROJECT-ROUTINE-107: the owner's own routine in a project room is judged as that routine's turn ──────────────────────
// A routine that posts into a project room is queued as a room request marked unattended, so every turn it runs read as started from
// outside the desktop and a No limits or Full access bot raised a card for every command (the same as the asker wake before
// NOLIMITS-ROUTINE-WAKE-107). The mark stays, and everything it drives (the browser, peer contact, hand-offs, the decision log) is
// unchanged; only the turn's tool approvals are judged as the routine's own turn, at the lowest of the routine's level, the routine
// bot's level when the run was delivered, and (at admission) the level of the bot that runs it now. A webhook or channel run, a run
// for an audience that is not the owner, and any request without a matching durable delivery row keep the unattended judge.

/** The routine run as the room delivery sees it. */
export interface ProjectRoutineRunFacts { id: string; routineId: string; manual: boolean; triggerSource?: string; notOwnerAudience?: true; humanPrincipal?: unknown }

const lowerOf = (a: RoutinePermissionMode, b: RoutinePermissionMode): RoutinePermissionMode =>
  ROUTINE_PERMISSION_MODES[Math.min(ROUTINE_PERMISSION_MODES.indexOf(a), ROUTINE_PERMISSION_MODES.indexOf(b))]!;

/** The ceiling of an owner's own scheduled or manual run, or undefined (any other trigger, another audience, no routine, no bot). */
export function projectRoutineCeiling(run: ProjectRoutineRunFacts, routine: { permissionMode?: RoutinePermissionMode } | undefined, bot: AutoApprover | null | undefined): RoutinePeerSource | undefined {
  const trigger = run.triggerSource ?? (run.manual ? "manual" : "schedule");
  if (trigger !== "schedule" && trigger !== "manual") return undefined;
  if (run.notOwnerAudience || run.humanPrincipal !== undefined || !routine || !bot) return undefined;
  return { permissionMode: effectiveRoutinePermissionMode(routine, bot), triggerSource: trigger };
}

/** Server-only facts revalidated at admission and on each command ask. */
export interface ProjectRoutineAuthorityCurrent {
  sourceBotId: string;
  ownerBinding: string;
  audienceBinding: string;
  permissionMode: RoutinePermissionMode;
  triggerSource: "manual" | "schedule";
}
export function persistedProjectRoutineOptions(db: DatabaseSync, request: RoomRequest,
  current: (routineId: string, groupId: string, threadId: string, targetBotId: string, runId: string) => ProjectRoutineAuthorityCurrent | undefined,
): { routineAuthority?: RoutinePeerSource; projectRoutine?: true } {
  if (request.verb !== "routine" || request.fromKind !== "routine" || request.origin !== "server" || !request.unattended || request.notOwnerAudience
      || !["queued", "running"].includes(request.state) || !request.toBotId || !request.targetThreadId) return {};
  // Old archives may not have this optional table until initialization completes.
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='project_routine_authority'").get()) return {};
  const row = db.prepare("SELECT * FROM project_routine_authority WHERE request_id=?").get(request.id);
  if (!row || row.version !== 1 || typeof row.run_id !== "string" || row.admission_key !== `routine:${row.run_id}`
      || row.admission_key !== request.admissionKey || row.group_id !== request.groupId || row.thread_id !== request.targetThreadId
      || row.thread_id !== request.rootThreadId || row.target_bot_id !== request.toBotId
      || !["manual", "schedule"].includes(String(row.trigger)) || !ROUTINE_PERMISSION_MODES.includes(row.ceiling as RoutinePermissionMode)) return {};
  let now: ProjectRoutineAuthorityCurrent | undefined;
  try { now = current(String(row.routine_id), request.groupId, request.targetThreadId, request.toBotId, String(row.run_id)); }
  catch { return {}; }
  if (!now || now.sourceBotId !== row.source_bot_id || now.ownerBinding !== row.owner_binding || now.audienceBinding !== row.audience_binding || now.triggerSource !== row.trigger
      || !ROUTINE_PERMISSION_MODES.includes(now.permissionMode)) return {};
  return { projectRoutine: true, routineAuthority: { permissionMode: lowerOf(row.ceiling as RoutinePermissionMode, now.permissionMode), triggerSource: row.trigger as "manual" | "schedule" } };
}
