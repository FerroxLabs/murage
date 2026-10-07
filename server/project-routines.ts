// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from "node:sqlite";
import { createProjectCard } from "./project-cards.ts";
import { activeProjectGoal, insertProjectActivity, insertRoomRequest, projectSettingsFor, roomRequestByAdmissionKey } from "./project-records.ts";

/** Caller owns the transaction; E1 dispatches the queued request. */
export function recordProjectRoutine(db: DatabaseSync, input: { groupId: string; threadId: string; memberIds: string[]; runId: string; botId: string; name: string; prompt: string; now: number }): { requestId: string; created: boolean } {
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
