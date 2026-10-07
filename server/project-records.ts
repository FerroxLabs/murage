import { issueWorkAudience, issueExecutionAudience, validExecutionAudience } from "./execution-audience.ts";
import type { ExecutionAudience } from "./work-admission.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Row shapes and shared row helpers for the project tables (lane R). The
// transitions live in project-cards.ts, project-goals.ts, project-briefs.ts
// and project-settings.ts; this module is the vocabulary they share:
// record types, row mapping, the append-only activity write and the brief
// version insert.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

// ── records ─────────────────────────────────────────────────────────────────

export type ProjectMode = "conversation" | "ongoing";
export type ProjectRunState = "running" | "paused";
export type ProjectLifecycle = "open" | "closed" | "ended";

export interface ProjectParts { board: boolean; review: boolean; digest: boolean }

export interface ProjectWorkRoot {
  path: string;
  dev: string;
  ino: string;
  label: string;
  addedAt: number;
}

export interface ProjectSettings {
  groupId: string;
  mode: ProjectMode;
  leadBotId: string | null;
  parts: ProjectParts;
  parallelCards: number;
  workRoots: ProjectWorkRoot[];
  workProfile: "ask" | "auto-in-roots";
  migratedFrom: "channelProject" | "bulletin" | "both" | null;
  ownerViewedAt: number | null;
  runState: ProjectRunState;
  runStateReason: string | null;
  closedAt: number | null;
  endedAt: number | null;
  revision: number;
  updatedAt: number;
}

export type ProjectCardState = "todo" | "doing" | "waiting" | "review" | "done" | "failed" | "cancelled";

export type ProjectWaitingKind =
  | "owner_approval" | "blocked" | "restart" | "restore" | "engine_problem"
  | "writer_root" | "dependency" | "owner" | "stopped" | "ask";

export interface ProjectWaitingOn {
  kind: ProjectWaitingKind;
  detail?: string;
  requestId?: string;
}

export interface ProjectCard {
  id: string;
  groupId: string;
  goalId: string | null;
  number: number;
  title: string;
  description: string;
  assigneeBotId: string | null;
  ownerTookOver: boolean;
  state: ProjectCardState;
  columnId: string | null;
  position: number;
  revision: number;
  generation: number;
  attempt: number;
  failures: number;
  waitingOn: ProjectWaitingOn | null;
  reason: string | null;
  needs: string[];
  touches: string[];
  dependsOn: string[];
  writes: boolean;
  workRootIndex: number | null;
  requestId: string | null;
  reviewRequestId: string | null;
  deskThreadId: string | null;
  resultMessageId: string | null;
  sourceMessageIds: string[];
  stale: boolean;
  createKey: string | null;
  dueAt: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  doneAt: number | null;
  archivedAt: number | null;
}

export type ProjectGoalState =
  | "draft" | "planning" | "awaiting_plan_ok" | "working" | "awaiting_signoff"
  | "done" | "paused" | "stopped" | "failed";

export interface ProjectGoalEvidence {
  kind: "message" | "file" | "check";
  ref: string;
  workItemId: string;
  attempt: number;
  at: number;
}

export interface ProjectGoalCriterion {
  id: string;
  text: string;
  setBy: "owner" | "lead";
  proposed: boolean;
  met: boolean;
  metBy?: string;
  evidence?: ProjectGoalEvidence;
}

export interface ProjectGoal {
  id: string;
  groupId: string;
  title: string;
  description: string;
  criteria: ProjectGoalCriterion[];
  state: ProjectGoalState;
  stateReason: string | null;
  planFirst: boolean;
  review: boolean;
  replans: number;
  noProgress: number;
  leadWakes: number;
  revision: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  summaryMessageId: string | null;
  deadlineAt: number | null;
}

export interface ProjectBriefEntry {
  text: string;
  path?: string;
  by: string;
  at: number;
  sourceMessageIds?: string[];
  /** Server-derived request lineage beyond the 20 stored citations: kept so
   * withdrawal (15.3) and citation tracking still see every inherited source. */
  lineageSourceMessageIds?: string[];
  stale?: true;
}

export interface ProjectBriefDecision {
  id: string;
  text: string;
  by: string;
  at: number;
  sourceMessageIds: string[];
  /** See ProjectBriefEntry.lineageSourceMessageIds. */
  lineageSourceMessageIds?: string[];
  stale?: true;
}

export type ProjectBriefChange =
  | "owner_edit" | "lead_decision" | "lead_note" | "restore_version" | "migration" | "member_proposal_accepted";

export interface ProjectBrief {
  groupId: string;
  version: number;
  summary: string;
  doneMeans: string;
  rules: string;
  whereWorkIs: ProjectBriefEntry[];
  decisions: ProjectBriefDecision[];
  updatedBy: string;
  change: ProjectBriefChange;
  updatedAt: number;
}

export interface ProjectBoardColumn {
  groupId: string;
  id: string;
  title: string;
  state: "todo" | "doing" | "waiting" | "review" | "done";
  position: number;
}

export type ProjectActivityKind =
  | "card_created" | "card_moved" | "card_reassigned" | "card_took_over" | "card_failed" | "card_result"
  | "brief_version" | "goal_state" | "criteria" | "decision_opened" | "decision_closed"
  | "budget_warned" | "budget_paused" | "budget_raised" | "member_error" | "routine_run"
  | "settings" | "work_roots" | "restore" | "close" | "reopen" | "deadline";

export interface ProjectActivity {
  id: string;
  groupId: string;
  at: number;
  kind: ProjectActivityKind;
  actor: string;
  workItemId: string | null;
  goalId: string | null;
  requestId: string | null;
  detail: Record<string, unknown>;
}

export type RoomRequestState =
  | "queued" | "running" | "waiting_owner" | "waiting_bot"
  | "done" | "failed" | "cancelled" | "expired" | "unknown";

// ── row mapping ─────────────────────────────────────────────────────────────

const parseJsonArray = <T>(json: string, fallback: T[]): T[] => {
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value as T[] : fallback;
  } catch { return fallback; }
};

export function projectSettingsFromRow(row: Record<string, unknown>): ProjectSettings {
  const parts = JSON.parse(String(row.parts)) as Partial<ProjectParts>;
  return {
    groupId: String(row.group_id),
    mode: row.mode as ProjectMode,
    leadBotId: row.lead_bot_id as string | null,
    parts: { board: parts.board !== false, review: parts.review !== false, digest: parts.digest === true },
    parallelCards: Number(row.parallel_cards),
    workRoots: parseJsonArray<ProjectWorkRoot>(String(row.work_roots), []),
    workProfile: row.work_profile as ProjectSettings["workProfile"],
    migratedFrom: row.migrated_from as ProjectSettings["migratedFrom"],
    ownerViewedAt: row.owner_viewed_at as number | null,
    runState: row.run_state as ProjectRunState,
    runStateReason: row.run_state_reason as string | null,
    closedAt: row.closed_at as number | null,
    endedAt: row.ended_at as number | null,
    revision: Number(row.revision),
    updatedAt: Number(row.updated_at),
  };
}

export function projectCardFromRow(row: Record<string, unknown>): ProjectCard {
  return {
    id: String(row.id),
    groupId: String(row.group_id),
    goalId: row.goal_id as string | null,
    number: Number(row.number),
    title: String(row.title),
    description: String(row.description),
    assigneeBotId: row.assignee_bot_id as string | null,
    ownerTookOver: row.owner_took_over === 1,
    state: row.state as ProjectCardState,
    columnId: row.column_id as string | null,
    position: Number(row.position),
    revision: Number(row.revision),
    generation: Number(row.generation),
    attempt: Number(row.attempt),
    failures: Number(row.failures),
    waitingOn: row.waiting_on === null ? null : JSON.parse(String(row.waiting_on)) as ProjectWaitingOn,
    reason: row.reason as string | null,
    needs: parseJsonArray<string>(String(row.needs), []),
    touches: parseJsonArray<string>(String(row.touches), []),
    dependsOn: parseJsonArray<string>(String(row.depends_on), []),
    writes: row.writes === 1,
    workRootIndex: row.work_root_index as number | null,
    requestId: row.request_id as string | null,
    reviewRequestId: row.review_request_id as string | null,
    deskThreadId: row.desk_thread_id as string | null,
    resultMessageId: row.result_message_id as string | null,
    sourceMessageIds: parseJsonArray<string>(String(row.source_message_ids), []),
    stale: row.stale === 1,
    createKey: row.create_key as string | null,
    dueAt: row.due_at as number | null,
    createdBy: String(row.created_by),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    doneAt: row.done_at as number | null,
    archivedAt: row.archived_at as number | null,
  };
}

export function projectGoalFromRow(row: Record<string, unknown>): ProjectGoal {
  return {
    id: String(row.id),
    groupId: String(row.group_id),
    title: String(row.title),
    description: String(row.description),
    criteria: parseJsonArray<ProjectGoalCriterion>(String(row.criteria), []),
    state: row.state as ProjectGoalState,
    stateReason: row.state_reason as string | null,
    planFirst: row.plan_first === 1,
    review: row.review === 1,
    replans: Number(row.replans),
    noProgress: Number(row.no_progress),
    leadWakes: Number(row.lead_wakes),
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    startedAt: row.started_at as number | null,
    finishedAt: row.finished_at as number | null,
    summaryMessageId: row.summary_message_id as string | null,
    deadlineAt: row.deadline_at as number | null,
  };
}

export function projectBriefFromRow(row: Record<string, unknown>): ProjectBrief {
  return {
    groupId: String(row.group_id),
    version: Number(row.version),
    summary: String(row.summary),
    doneMeans: String(row.done_means),
    rules: String(row.rules),
    whereWorkIs: parseJsonArray<ProjectBriefEntry>(String(row.where_work_is), []),
    decisions: parseJsonArray<ProjectBriefDecision>(String(row.decisions), []),
    updatedBy: String(row.updated_by),
    change: row.change as ProjectBriefChange,
    updatedAt: Number(row.updated_at),
  };
}

// ── reads ───────────────────────────────────────────────────────────────────

export function projectSettingsFor(db: DatabaseSync, groupId: string): ProjectSettings | null {
  const row = db.prepare("SELECT * FROM project_settings WHERE group_id=?").get(groupId);
  return row ? projectSettingsFromRow(row as Record<string, unknown>) : null;
}

/** Open = not ended and not closed; the lifecycle tri-state of SPEC-P 3.1. */
export function projectLifecycle(settings: ProjectSettings): ProjectLifecycle {
  if (settings.endedAt !== null) return "ended";
  if (settings.closedAt !== null) return "closed";
  return "open";
}

/** Goal mode is derived, never stored (AMB-1): a project is in goal mode
 * while a goal row is in an active state. */
export function activeProjectGoal(db: DatabaseSync, groupId: string): ProjectGoal | null {
  const row = db.prepare("SELECT * FROM project_goals WHERE group_id=? AND state IN ('planning','awaiting_plan_ok','working','awaiting_signoff','paused') ORDER BY created_at DESC LIMIT 1").get(groupId);
  return row ? projectGoalFromRow(row as Record<string, unknown>) : null;
}

export function projectGoalById(db: DatabaseSync, id: string): ProjectGoal | null {
  const row = db.prepare("SELECT * FROM project_goals WHERE id=?").get(id);
  return row ? projectGoalFromRow(row as Record<string, unknown>) : null;
}

export function projectCardById(db: DatabaseSync, id: string): ProjectCard | null {
  const row = db.prepare("SELECT * FROM project_work_items WHERE id=?").get(id);
  return row ? projectCardFromRow(row as Record<string, unknown>) : null;
}

export function projectCardsForGroup(db: DatabaseSync, groupId: string, includeArchived = false): ProjectCard[] {
  const rows = (includeArchived
    ? db.prepare("SELECT * FROM project_work_items WHERE group_id=? ORDER BY position, created_at, id").all(groupId)
    : db.prepare("SELECT * FROM project_work_items WHERE group_id=? AND archived_at IS NULL ORDER BY position, created_at, id").all(groupId)) as Array<Record<string, unknown>>;
  return rows.map(projectCardFromRow);
}

export function projectBoardColumnsForGroup(db: DatabaseSync, groupId: string): ProjectBoardColumn[] {
  const rows = db.prepare("SELECT * FROM project_board_columns WHERE group_id=? ORDER BY position, id").all(groupId) as Array<Record<string, unknown>>;
  return rows.map(row => ({
    groupId: String(row.group_id), id: String(row.id), title: String(row.title),
    state: row.state as ProjectBoardColumn["state"], position: Number(row.position),
  }));
}

/** The current brief is the highest version (SPEC-P 3.5). */
export function currentProjectBrief(db: DatabaseSync, groupId: string): ProjectBrief | null {
  const row = db.prepare("SELECT * FROM project_briefs WHERE group_id=? ORDER BY version DESC LIMIT 1").get(groupId);
  return row ? projectBriefFromRow(row as Record<string, unknown>) : null;
}

export function projectBriefVersion(db: DatabaseSync, groupId: string, version: number): ProjectBrief | null {
  const row = db.prepare("SELECT * FROM project_briefs WHERE group_id=? AND version=?").get(groupId, version);
  return row ? projectBriefFromRow(row as Record<string, unknown>) : null;
}

// ── writes ──────────────────────────────────────────────────────────────────

/** The append-only activity row, written in the same transaction as the
 * change it records (SPEC-P 3.10). `detail` holds no model-written text:
 * ids, enum codes, numbers, owner-written values and state names only. */
export function insertProjectActivity(
  db: DatabaseSync,
  input: {
    groupId: string;
    kind: ProjectActivityKind;
    actor: string;
    at: number;
    workItemId?: string | null;
    goalId?: string | null;
    requestId?: string | null;
    detail?: Record<string, unknown>;
  },
): ProjectActivity {
  const activity: ProjectActivity = {
    id: randomUUID(),
    groupId: input.groupId,
    at: input.at,
    kind: input.kind,
    actor: input.actor,
    workItemId: input.workItemId ?? null,
    goalId: input.goalId ?? null,
    requestId: input.requestId ?? null,
    detail: input.detail ?? {},
  };
  db.prepare("INSERT INTO project_activity (id, group_id, at, kind, actor, work_item_id, goal_id, request_id, detail) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(activity.id, activity.groupId, activity.at, activity.kind, activity.actor, activity.workItemId, activity.goalId, activity.requestId, JSON.stringify(activity.detail));
  return activity;
}

export function listProjectActivity(db: DatabaseSync, groupId: string, opts: { before?: number; limit?: number; cardId?: string } = {}): ProjectActivity[] {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 100);
  const where = ["group_id=?"];
  const values: (string | number)[] = [groupId];
  if (opts.cardId !== undefined) { where.push("work_item_id=?"); values.push(opts.cardId); }
  if (opts.before !== undefined) { where.push("at<?"); values.push(opts.before); }
  const rows = db.prepare(`SELECT * FROM project_activity WHERE ${where.join(" AND ")} ORDER BY at DESC, id DESC LIMIT ?`).all(...values, limit) as Array<Record<string, unknown>>;
  return rows.map(row => ({
    id: String(row.id), groupId: String(row.group_id), at: Number(row.at),
    kind: row.kind as ProjectActivityKind, actor: String(row.actor),
    workItemId: row.work_item_id as string | null, goalId: row.goal_id as string | null, requestId: row.request_id as string | null,
    detail: JSON.parse(String(row.detail)) as Record<string, unknown>,
  }));
}

/** At most 200 brief versions per group; older versions beyond 200 are
 * deleted oldest first, never version 1 (SPEC-P 3.5). */
export const PROJECT_BRIEF_MAX_VERSIONS = 200;

/** Copy-on-write: every change inserts version max+1. */
export function insertProjectBriefVersion(
  db: DatabaseSync,
  input: {
    groupId: string;
    summary: string;
    doneMeans: string;
    rules: string;
    whereWorkIs: ProjectBriefEntry[];
    decisions: ProjectBriefDecision[];
    updatedBy: string;
    change: ProjectBriefChange;
    now: number;
  },
): ProjectBrief {
  const current = currentProjectBrief(db, input.groupId);
  const version = (current?.version ?? 0) + 1;
  db.prepare(`INSERT INTO project_briefs (group_id, version, summary, done_means, rules, where_work_is, decisions, updated_by, change, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    input.groupId, version, input.summary, input.doneMeans, input.rules,
    JSON.stringify(input.whereWorkIs), JSON.stringify(input.decisions), input.updatedBy, input.change, input.now,
  );
  db.prepare(`DELETE FROM project_briefs WHERE group_id=? AND version>1 AND version <= ?`).run(input.groupId, version - PROJECT_BRIEF_MAX_VERSIONS + 1);
  return projectBriefVersion(db, input.groupId, version)!;
}

/** Insert a `room_requests` row (SPEC-P 3.2). Lane R inserts only the rows
 * its transitions need (`assign`, `review`, `routine`); dispatch and
 * completion are lane E1's. Returns null when the admission key already
 * exists, which is the idempotent retry answer (5.2). */
export function insertRoomRequest(
  db: DatabaseSync,
  input: {
    id?: string;
    groupId: string;
    verb: "owner_send" | "room_turn" | "ask" | "assign" | "message" | "review" | "wake" | "routine";
    fromKind: "owner" | "bot" | "murage" | "routine";
    admissionKey: string;
    now: number;
    rootId?: string;
    executionAudience?: ExecutionAudience | null;
    parentId?: string | null;
    cardGeneration?: number | null;
    attempt?: number;
    targetThreadId?: string | null;
    projectGoalId?: string | null;
    workItemId?: string | null;
    fromBotId?: string | null;
    toBotId?: string | null;
    payloadText?: string | null;
    origin?: "desktop" | "companion" | "unproven" | "server";
    rootThreadId?: string;
    audienceFingerprint?: string;
    notOwnerAudience?: boolean;
    unattended?: boolean;
    returnThreadId?: string | null;
    returnBotId?: string | null;
    priority?: "owner" | "coordinator" | "work";
    state?: RoomRequestState;
    sourceMessageId?: string | null;
  },
): string | null {
  if (input.fromKind === "owner" && (input.origin !== "desktop" && input.origin !== "companion" || !input.rootThreadId || !input.audienceFingerprint)) {
    throw new Error("Owner requests need their conversation and proven origin.");
  }
  const id = input.id ?? randomUUID();
  const parent = input.parentId ? roomRequestById(db, input.parentId) : null;
  if (input.parentId && !parent) throw new Error("Unknown request parent");
  let executionAudience = parent ? inheritedRequestLineage(parent).executionAudience : input.executionAudience ?? issueExecutionAudience(input.fromBotId ?? undefined, input.rootThreadId ?? "", id)
    ?? (db.prepare("SELECT 1 FROM project_settings WHERE group_id=?").get(input.groupId) ? { v: 1, kind: "project", human: "owner", projectId: input.groupId, rootRequestId: id } : null);
  if (executionAudience && !validExecutionAudience(executionAudience)) throw new Error("Invalid execution audience");
  executionAudience = issueWorkAudience(input.fromBotId ?? undefined, input.toBotId ?? undefined, input.returnThreadId ?? input.rootThreadId ?? "", validExecutionAudience(executionAudience) ? executionAudience : null, id, input.notOwnerAudience !== true);
  const inserted = db.prepare(`INSERT OR IGNORE INTO room_requests
    (id, root_id, parent_id, card_generation, attempt, group_id, target_thread_id, project_goal_id, work_item_id, verb,
     from_kind, from_bot_id, to_bot_id, payload_text, origin, root_thread_id, audience_fingerprint, not_owner_audience,
     unattended, return_thread_id, return_bot_id, admission_key, priority, state, created_at, source_message_id, execution_audience)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, parent ? String(parent.root_id) : input.rootId ?? id, input.parentId ?? null, input.cardGeneration ?? null, input.attempt ?? 1, input.groupId,
    input.targetThreadId ?? null, input.projectGoalId ?? null, input.workItemId ?? null, input.verb,
    input.fromKind, input.fromBotId ?? null, input.toBotId ?? null, input.payloadText ?? null,
    input.origin ?? "server", input.rootThreadId ?? "", input.audienceFingerprint ?? "",
    input.notOwnerAudience === true ? 1 : 0, input.unattended === true ? 1 : 0,
    input.returnThreadId ?? null, input.returnBotId ?? null, input.admissionKey, input.priority ?? "work",
    input.state ?? "queued", input.now, input.sourceMessageId ?? null, executionAudience ? JSON.stringify(executionAudience) : null,
  );
  return inserted.changes === 1 ? id : null;
}

export function roomRequestById(db: DatabaseSync, id: string): Record<string, unknown> | null {
  return (db.prepare("SELECT * FROM room_requests WHERE id=?").get(id) as Record<string, unknown> | undefined) ?? null;
}

/** Copy admission-issued lineage without recomputing or widening it. */
export function inheritedRequestLineage(request: Record<string, unknown>): { executionAudience?: ExecutionAudience | null; parentId: string; rootId: string; rootThreadId: string; origin: "desktop" | "companion" | "unproven" | "server"; audienceFingerprint: string; notOwnerAudience: boolean; unattended: boolean } {
  return {
    executionAudience: request.execution_audience ? JSON.parse(String(request.execution_audience)) as ExecutionAudience : null,
    parentId: String(request.id), rootId: String(request.root_id),
    rootThreadId: String(request.root_thread_id),
    origin: request.origin as "desktop" | "companion" | "unproven" | "server",
    audienceFingerprint: String(request.audience_fingerprint),
    notOwnerAudience: request.not_owner_audience === 1,
    unattended: request.unattended === 1,
  };
}

export function roomRequestByAdmissionKey(db: DatabaseSync, key: string): Record<string, unknown> | null {
  return (db.prepare("SELECT * FROM room_requests WHERE admission_key=?").get(key) as Record<string, unknown> | undefined) ?? null;
}

/** A retry, send back or reopen of a card (attempt + 1) unmarks the criteria
 * whose evidence points at that card (SPEC-P 5.3.1). Lives here so the card
 * transitions can call it without importing the goals module. */
export function unmarkCriteriaForCard(db: DatabaseSync, cardId: string, now: number): void {
  const goals = db.prepare("SELECT id, group_id, criteria FROM project_goals").all() as Array<Record<string, unknown>>;
  for (const row of goals) {
    const criteria = parseJsonArray<ProjectGoalCriterion>(String(row.criteria), []);
    if (!criteria.some(entry => entry.met && entry.evidence?.workItemId === cardId)) continue;
    const next = criteria.map(entry => entry.met && entry.evidence?.workItemId === cardId
      ? (() => { const { metBy: _metBy, evidence: _evidence, ...rest } = entry; return { ...rest, met: false }; })()
      : entry);
    db.prepare("UPDATE project_goals SET criteria=?, revision=revision+1 WHERE id=?").run(JSON.stringify(next), String(row.id));
    insertProjectActivity(db, { groupId: String(row.group_id), goalId: String(row.id), kind: "criteria", actor: "server", at: now, detail: { unmarked: cardId } });
  }
}

export interface ProjectCloseReceipt { closeSeq: number; step: number; summaryRequestId: string | null; stopGoal?: boolean; goalId?: string }
/** Row order fences an old close even when a later lifecycle action shares its timestamp. */
export function currentProjectClose(db: DatabaseSync, groupId: string): ProjectCloseReceipt | null {
  const row = db.prepare(`SELECT detail FROM project_activity WHERE group_id=? AND kind='close'
    AND json_type(detail,'$.closeSeq')='integer' AND json_type(detail,'$.step')='integer'
    AND rowid > COALESCE((SELECT MAX(rowid) FROM project_activity WHERE group_id=?
      AND (kind='reopen' OR (kind='settings' AND json_extract(detail,'$.project')=0))),0)
    ORDER BY rowid DESC LIMIT 1`).get(groupId,groupId);
  return row ? JSON.parse(String(row.detail)) as ProjectCloseReceipt : null;
}
export function projectIsClosing(db: DatabaseSync, groupId: string): boolean {
  const step = currentProjectClose(db,groupId);
  return !!step && step.step < 3;
}
