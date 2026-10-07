// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Card (work item) transitions, SPEC-P 5.1 and 5.1a. One exported function
// per transition, state-checked and revision-bumping, writing its
// project_activity row in the same transaction as the change. Lane E1 calls
// the apply* functions from dispatch and completion; the owner-facing routes
// call the rest. Every function here must run inside a messages.db
// transaction owned by its caller.
import { projectIsClosing } from "./project-records.ts";
import { assignmentCapabilityRefusal } from "./project-roster.ts";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { DEFAULT_PROJECT_PARALLEL_CARDS } from "./project-defaults.ts";
import {
  insertProjectActivity,
  insertRoomRequest,
  inheritedRequestLineage,
  projectCardById,
  projectSettingsFor,
  roomRequestById,
  unmarkCriteriaForCard,
  type ProjectCard,
  type ProjectWaitingOn,
} from "./project-records.ts";

/** Who acts. L operations carry the lead's bot id; A operations the acting
 * member's. The routes and the internal tools prove the role before they
 * call; these functions still check it against the rows. */
export type OwnerCardLineage = { origin: "desktop" | "companion"; rootThreadId: string; audienceFingerprint: string; notOwnerAudience?: boolean };

export type ProjectActor =
  | { kind: "owner"; lineage?: OwnerCardLineage }
  | { kind: "lead"; botId: string; lineage?: ReturnType<typeof inheritedRequestLineage> }
  | { kind: "assignee"; botId: string }
  | { kind: "member"; botId: string }
  | { kind: "server" };

export type CardFailure =
  | { ok: false; error: "not_allowed"; reason: string }
  | { ok: false; error: "invalid"; reason: string }
  | { ok: false; error: "not_found"; reason: string }
  | { ok: false; error: "changed"; reason: string; card: ProjectCard };

export type CardOutcome = ({ ok: true; card: ProjectCard; requestId?: string; superseded?: boolean }) | CardFailure;

const notAllowed = (reason: string): CardFailure => ({ ok: false, error: "not_allowed", reason });
const invalid = (reason: string): CardFailure => ({ ok: false, error: "invalid", reason });
const notFound = (reason: string): CardFailure => ({ ok: false, error: "not_found", reason });

function cardOr404(db: DatabaseSync, cardId: string): ProjectCard | CardFailure {
  const card = projectCardById(db, cardId);
  return card ?? notFound("No such card.");
}

/** The live-wait kinds (5.1): the run is still alive behind them. */
const LIVE_WAITS = new Set(["owner_approval", "writer_root", "ask", "blocked"]);
const isLiveWait = (card: ProjectCard): boolean =>
  card.state === "waiting" && card.waitingOn !== null && LIVE_WAITS.has(card.waitingOn.kind)
  && !(card.waitingOn.kind === "blocked" && card.requestId === null);
// A `blocked` wait is live while its run is still waiting on the owner; once
// the run is terminal the server clears request_id, which marks it dead.

const OPEN_STATES = new Set(["todo", "doing", "waiting", "review", "failed"]);

function checkRevision(card: ProjectCard, expectedRevision: number | undefined): CardFailure | null {
  if (expectedRevision === undefined) return invalid("expectedRevision is required.");
  if (expectedRevision !== card.revision) return { ok: false, error: "changed", reason: "The card changed since you read it.", card };
  return null;
}

/** Every card write goes through here: revision bump, updated_at, and the
 * state-change rules of 5.1 (column cleared unless the move names a column of
 * the new state; waiting_on/reason only on waiting/failed). */
function writeCard(db: DatabaseSync, cardId: string, fields: Record<string, unknown>, now: number): void {
  const sets: string[] = ["revision=revision+1", "updated_at=?"];
  const values: unknown[] = [now];
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key}=?`);
    values.push(value === undefined ? null : value);
  }
  values.push(cardId);
  db.prepare(`UPDATE project_work_items SET ${sets.join(", ")} WHERE id=?`).run(...values as never[]);
}

function stateFields(state: ProjectCard["state"], extras: Record<string, unknown> = {}, namedColumn?: string | null): Record<string, unknown> {
  const fields: Record<string, unknown> = { state, ...extras };
  if (namedColumn !== undefined) fields.column_id = namedColumn;
  else fields.column_id = null;
  if (state !== "waiting" && state !== "failed") {
    fields.waiting_on = null;
    if (state !== "done") fields.reason = null;
  }
  return fields;
}

function activity(db: DatabaseSync, card: ProjectCard, kind: Parameters<typeof insertProjectActivity>[1]["kind"], actor: string, now: number, detail: Record<string, unknown> = {}, requestId?: string | null): void {
  insertProjectActivity(db, { groupId: card.groupId, kind, actor, at: now, workItemId: card.id, goalId: card.goalId, requestId: requestId ?? card.requestId, detail });
}

const actorName = (actor: ProjectActor): string =>
  actor.kind === "owner" ? "owner" : actor.kind === "server" ? "server" : actor.botId;

function projectOpen(db: DatabaseSync, groupId: string): CardFailure | null {
  const settings = projectSettingsFor(db, groupId);
  if (!settings) return notFound("Not a project.");
  if (settings.endedAt !== null) return notAllowed("This is a channel now.");
  if (settings.closedAt !== null) return notAllowed("This project is closed.");
  if (projectIsClosing(db,groupId)) return notAllowed("This project is closing.");
  return null;
}

function nextNumber(db: DatabaseSync, groupId: string): number {
  const row = db.prepare("SELECT MAX(number) AS n FROM project_work_items WHERE group_id=?").get(groupId) as { n: number | null };
  return (row.n ?? 0) + 1;
}

function endPosition(db: DatabaseSync, groupId: string, state: string, columnId: string | null): number {
  const row = columnId === null
    ? db.prepare("SELECT MAX(position) AS p FROM project_work_items WHERE group_id=? AND state=? AND column_id IS NULL").get(groupId, state) as { p: number | null }
    : db.prepare("SELECT MAX(position) AS p FROM project_work_items WHERE group_id=? AND column_id=?").get(groupId, columnId) as { p: number | null };
  return (row.p ?? 0) + 1024;
}

/** Cancelled or missing dependencies are released permanently, with a receipt. */
function hasOpenDependencies(db: DatabaseSync, card: ProjectCard, now: number): boolean {
  const kept: string[] = [];
  let open = false;
  for (const id of card.dependsOn) {
    const target = projectCardById(db, id);
    if (!target || target.state === "cancelled") {
      activity(db, card, "card_moved", "server", now, { dependencyReleased: id, state: target?.state ?? "missing" });
    } else {
      kept.push(id);
      if (target.state !== "done") open = true;
    }
  }
  if (kept.length !== card.dependsOn.length) writeCard(db, card.id, { depends_on: JSON.stringify(kept) }, now);
  return open;
}

/** A terminal dependency releases queued waits of its group (5.1). */
function releaseDependencies(db: DatabaseSync, groupId: string, now: number): void {
  const waiting = db.prepare(`SELECT id FROM project_work_items WHERE group_id=? AND state='todo' AND json_extract(waiting_on,'$.kind')='dependency'`).all(groupId);
  for (const row of waiting) {
    if (!hasOpenDependencies(db, projectCardById(db, String(row.id))!, now)) {
      db.prepare("UPDATE project_work_items SET waiting_on=NULL, revision=revision+1, updated_at=? WHERE id=?").run(now, row.id);
      db.prepare("UPDATE room_requests SET refusal=NULL WHERE work_item_id=? AND state='queued' AND refusal='dependency'").run(row.id);
    }
  }
}

/** Same bounds used by restore validation, so sources cannot be repaired away. */
function validCardSources(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 50
    && value.every(id => typeof id === "string" && id.length > 0 && id.length <= 512);
}

function cancelCardRequests(db: DatabaseSync, card: ProjectCard, now: number, reason: string): void {
  db.prepare(`WITH RECURSIVE affected(id) AS (
    SELECT id FROM room_requests WHERE group_id=? AND (work_item_id=? OR id=? OR id=?)
    UNION SELECT r.id FROM room_requests r JOIN affected a ON r.parent_id=a.id
  ) UPDATE room_requests SET state='cancelled', finished_at=?, waiting_since=NULL,
      outcome_note=CASE WHEN verb='review' AND outcome_note IN ('pass','changes') THEN outcome_note ELSE ? END
    WHERE id IN (SELECT id FROM affected) AND state IN ('queued','running','waiting_owner','waiting_bot')`)
    .run(card.groupId, card.id, card.requestId, card.reviewRequestId, now, reason);
}

// ── creation ────────────────────────────────────────────────────────────────

/** (new) -> todo. O: board create (idempotent on create_key). L: envelope or
 * tool assign (the caller adds the assign request in the same transaction).
 * S: a routine in ongoing mode. Members never create. */
export function createProjectCard(
  db: DatabaseSync,
  input: {
    groupId: string;
    title: string;
    description?: string;
    assigneeBotId?: string | null;
    goalId?: string | null;
    columnId?: string | null;
    dueAt?: number | null;
    writes?: boolean;
    workRoot?: number | null;
    needs?: string[];
    touches?: string[];
    dependsOn?: string[];
    createKey?: string;
    createdBy?: string;
    /** Bound by the server from the creating request/turn, never model fields. */
    sourceMessageIds?: string[];
    /** The creating lead request's lineage is the owner's own control, which
     * binds no message (project-envelope.ts projectRequestOwnerControl). */
    ownerControlLineage?: boolean;
    actor: ProjectActor;
    memberIds: string[];
    now: number;
  },
): CardOutcome {
  if (input.actor.kind === "member" || input.actor.kind === "assignee") return notAllowed("Only the owner, the lead or Murage can add a card.");
  const blocked = projectOpen(db, input.groupId);
  if (blocked) return blocked;
  const settings = projectSettingsFor(db, input.groupId)!;
  if (input.actor.kind === "lead" && settings.leadBotId !== input.actor.botId) return notAllowed("Only the current lead can do this.");
  const sources = input.sourceMessageIds ?? [];
  if (!validCardSources(sources) || (input.actor.kind === "lead" && sources.length === 0 && !input.ownerControlLineage)) return invalid("Bind the card to its source messages first.");
  const title = input.title.trim();
  if (title.length < 1 || title.length > 120) return invalid("A card title is 1 to 120 characters.");
  const description = input.description ?? "";
  if (description.length > 2000) return invalid("A card description is at most 2000 characters.");
  if (input.assigneeBotId != null && !input.memberIds.includes(input.assigneeBotId)) return invalid("The assignee is not a member of this project.");
  if (input.goalId != null) {
    const goal = db.prepare("SELECT 1 FROM project_goals WHERE id=? AND group_id=?").get(input.goalId, input.groupId);
    if (!goal) return invalid("The goal is not part of this project.");
  }
  let columnId: string | null = null;
  if (input.columnId != null) {
    const column = db.prepare("SELECT state FROM project_board_columns WHERE group_id=? AND id=?").get(input.groupId, input.columnId) as { state: string } | undefined;
    if (!column) return invalid("No such column.");
    if (column.state !== "todo") return invalid("A new card starts in a To do column.");
    columnId = input.columnId;
  }
  if (input.workRoot != null) {
    if (!Number.isInteger(input.workRoot) || input.workRoot < 0 || input.workRoot >= settings.workRoots.length) {
      return invalid("The work folder index does not name a work folder of this project.");
    }
  }
  const needs = input.needs ?? [];
  const touches = input.touches ?? [];
  const dependsOn = input.dependsOn ?? [];
  if (needs.length > 8 || touches.length > 10 || dependsOn.length > 10) return invalid("Too many tags, touches or dependencies.");
  // a card is never handed to a bot that lacks what it needs (plan 3.10, F9)
  const lacks = input.assigneeBotId != null ? assignmentCapabilityRefusal(input.assigneeBotId, needs) : null;
  if (lacks) return notAllowed(lacks);
  if (input.createKey) {
    const existing = db.prepare("SELECT * FROM project_work_items WHERE create_key=?").get(input.createKey);
    if (existing) return { ok: true, card: projectCardById(db, String((existing as { id: string }).id))! };
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO project_work_items
    (id, group_id, goal_id, number, title, description, assignee_bot_id, owner_took_over, state, column_id, position, revision, generation, attempt, failures,
     waiting_on, reason, needs, touches, depends_on, writes, work_root_index, request_id, review_request_id, desk_thread_id, result_message_id,
     source_message_ids, stale, create_key, due_at, created_by, created_at, updated_at, done_at, archived_at)
    VALUES (?,?,?,?,?,?,?,0,'todo',?,?,0,0,1,0,NULL,NULL,?,?,?,?,?,NULL,NULL,NULL,NULL,?,0,?,?,?,?,?,NULL,NULL)`).run(
    id, input.groupId, input.goalId ?? null, nextNumber(db, input.groupId), title, description, input.assigneeBotId ?? null,
    columnId, endPosition(db, input.groupId, "todo", columnId),
    JSON.stringify(needs), JSON.stringify(touches), JSON.stringify(dependsOn),
    input.writes === false ? 0 : 1, input.workRoot ?? null,
    JSON.stringify(sources), input.createKey ?? null, input.dueAt ?? null,
    input.createdBy ?? actorName(input.actor), input.now, input.now,
  );
  const card = projectCardById(db, id)!;
  activity(db, card, "card_created", actorName(input.actor), input.now, { state: "todo" });
  return { ok: true, card };
}

// ── queueing and dispatch ───────────────────────────────────────────────────

/** The admission key every non-envelope run of a card uses (5.2). */
export const cardRunAdmissionKey = (card: ProjectCard, attempt = card.attempt, generation = card.generation + 1): string =>
  `assign:card:${card.id}:${attempt}:${generation}`;

/** Queue the card's assign request; the card stays `todo` until the arbiter
 * admits and the dispatcher runs it (O Start, a drop into In progress,
 * retries). While a depends_on card is not done the request stays queued
 * with refusal `dependency` and the card shows a waiting chip in To do. */
export function enqueueCardRun(
  db: DatabaseSync,
  input: { cardId: string; actor: ProjectActor; now: number },
): { ok: true; requestId: string } | CardFailure {
  if (input.actor.kind === "member" || input.actor.kind === "assignee") return notAllowed("Only the owner or the lead can start a card.");
  if (input.actor.kind === "owner" && !input.actor.lineage) return notAllowed("Open this card in the Murage app or on your paired phone to start it.");
  const card = cardOr404(db, input.cardId);
  if (!("state" in card)) return card;
  if (input.actor.kind !== "owner" && card.waitingOn?.kind === "restart") return notAllowed(`Card ${card.number} stopped at a restart. The owner picks Retry step or Skip.`);
  if (input.actor.kind === "lead" && projectSettingsFor(db, card.groupId)?.leadBotId !== input.actor.botId) return notAllowed("Only the current lead can do this.");
  if (card.state !== "todo") return notAllowed(`Card ${card.number} is not in To do.`);
  if (!card.assigneeBotId) return notAllowed(`Card ${card.number} has no one assigned.`);
  const settings = projectSettingsFor(db, card.groupId);
  if (!settings) return notFound("Not a project.");
  releaseDependencies(db, card.groupId, input.now);
  const openDependency = hasOpenDependencies(db, projectCardById(db, card.id)!, input.now);
  const generation = card.generation + 1;
  let attempt = card.attempt;
  let key = cardRunAdmissionKey(card, attempt, generation);
  // Restore expires requests but preserves To-do cards. Only a live request
  // deduplicates Start; a terminal request needs a new attempt and key.
  while (true) {
    const existing = db.prepare("SELECT id, state FROM room_requests WHERE admission_key=?").get(key);
    if (!existing) break;
    if (["queued", "running", "waiting_owner", "waiting_bot"].includes(String(existing.state))) {
      return { ok: true, requestId: String(existing.id) };
    }
    key = cardRunAdmissionKey(card, ++attempt, generation);
  }
  if (attempt !== card.attempt) {
    writeCard(db, card.id, { attempt }, input.now);
    unmarkCriteriaForCard(db, card.id, input.now);
    activity(db, projectCardById(db, card.id)!, "card_moved", actorName(input.actor), input.now, { from: "todo", to: "todo", attempt });
  }
  const requestId = insertRoomRequest(db, {
    ...(input.actor.kind === "owner" || input.actor.kind === "lead" ? input.actor.lineage : {}),
    returnBotId: input.actor.kind === "lead" ? input.actor.botId : null,
    groupId: card.groupId, verb: "assign", fromKind: input.actor.kind === "server" ? "murage" : input.actor.kind === "owner" ? "owner" : "bot",
    fromBotId: input.actor.kind === "lead" ? input.actor.botId : null,
    toBotId: card.assigneeBotId, workItemId: card.id, projectGoalId: card.goalId,
    cardGeneration: generation, attempt, admissionKey: key, now: input.now,
    state: "queued",
  });
  if (requestId === null) {
    const existing = roomRequestById(db, (db.prepare("SELECT id FROM room_requests WHERE admission_key=?").get(key) as { id: string } | undefined)?.id ?? "");
    return { ok: true, requestId: existing ? String(existing.id) : "" };
  }
  // PF deviation from SPEC-P 5.3: the owner's own start is plan approval
  // for this work. Actor and lineage come from the authenticated request.
  // With plan_first on the goal stays put: the lead's plan still waits for
  // its OK, and this card is admitted on its own owner approval.
  if (input.actor.kind === "owner" && card.goalId && !input.actor.lineage?.notOwnerAudience
    && ["desktop", "companion"].includes(input.actor.lineage?.origin ?? "")) {
    const changed = db.prepare("UPDATE project_goals SET state='working', state_reason=NULL, revision=revision+1 WHERE id=? AND state='planning' AND plan_first=0").run(card.goalId);
    if (changed.changes) insertProjectActivity(db, { groupId: card.groupId, goalId: card.goalId, requestId, kind: "goal_state", actor: "owner", at: input.now, detail: { from: "planning", to: "working", ownerCard: card.id } });
  }
  if (openDependency) {
    db.prepare("UPDATE room_requests SET refusal='dependency' WHERE id=?").run(requestId);
    db.prepare("UPDATE project_work_items SET waiting_on=?, revision=revision+1, updated_at=? WHERE id=?").run(JSON.stringify({ kind: "dependency" }), input.now, card.id);
  } else {
    db.prepare("UPDATE project_work_items SET revision=revision+1, updated_at=? WHERE id=?").run(input.now, card.id);
  }
  return { ok: true, requestId };
}

/** S, dispatch: todo -> doing. The card generation is bumped and written onto
 * the request in the same transaction (5.1 fencing). Refused when the card
 * has no assignee or is not queued. */
export function applyCardRunDispatched(
  db: DatabaseSync,
  input: { cardId: string; requestId: string; deskThreadId: string; now: number; actor?: ProjectActor },
): CardOutcome {
  if (input.actor && input.actor.kind !== "server") return notAllowed("Only the dispatcher starts a card run.");
  const card = cardOr404(db, input.cardId);
  if (!("state" in card)) return card;
  if (card.state !== "todo") return notAllowed(`Card ${card.number} is ${card.state}, not queued.`);
  if (!card.assigneeBotId) return notAllowed(`Card ${card.number} has no one assigned.`);
  const request = roomRequestById(db, input.requestId);
  if (!request || request.work_item_id !== card.id || request.group_id !== card.groupId || request.verb !== "assign" || request.state !== "queued"
    || request.card_generation !== card.generation + 1 || request.attempt !== card.attempt || request.to_bot_id !== card.assigneeBotId) return notAllowed("The run request is not queued for this card.");
  const generation = card.generation + 1;
  writeCard(db, card.id, stateFields("doing", {
    generation, request_id: input.requestId, desk_thread_id: input.deskThreadId,
  }), input.now);
  db.prepare("UPDATE room_requests SET card_generation=?, state='running', dispatched_at=?, target_thread_id=? WHERE id=?").run(generation, input.now, input.deskThreadId, input.requestId);
  const after = projectCardById(db, card.id)!;
  activity(db, after, "card_moved", "server", input.now, { from: "todo", to: "doing" }, input.requestId);
  return { ok: true, card: after };
}

// ── waits ───────────────────────────────────────────────────────────────────

/** S or A: doing -> waiting. A live wait (owner_approval, writer_root, ask,
 * blocked while its run lives) keeps the run; a dead wait (restart, restore,
 * engine_problem, stopped, owner) does not. */
export function applyCardWaiting(
  db: DatabaseSync,
  input: { cardId: string; requestId?: string; actor: ProjectActor; waiting: ProjectWaitingOn; reason?: string; sourceMessageIds?: string[]; now: number },
): CardOutcome {
  const card = cardOr404(db, input.cardId);
  if (!("state" in card)) return card;
  if (input.actor.kind === "assignee") {
    if (input.actor.botId !== card.assigneeBotId || input.waiting.kind !== "blocked" || card.requestId !== input.requestId) {
      return notAllowed("Only the card's assignee, on its own run, can mark it blocked.");
    }
  } else if (input.actor.kind !== "server") {
    return notAllowed("Only Murage can park a card.");
  }
  if (card.state !== "doing" && card.state !== "waiting" && !(card.state === "review" && input.waiting.kind === "restart")) return notAllowed(`Card ${card.number} is ${card.state}, not running.`);
  const incomingSources = input.sourceMessageIds ?? [];
  if (!validCardSources(incomingSources) || (input.waiting.kind === "blocked" && incomingSources.length === 0)) return invalid("Bind the blocked reason to its source messages first.");
  const sources = [...new Set([...card.sourceMessageIds, ...incomingSources])];
  if (!validCardSources(sources)) return invalid("The card has too many source messages.");
  const dead = !LIVE_WAITS.has(input.waiting.kind);
  writeCard(db, card.id, stateFields("waiting", {
    waiting_on: JSON.stringify(input.waiting),
    reason: input.reason ?? input.waiting.detail ?? null,
    source_message_ids: JSON.stringify(sources),
    ...(dead ? { request_id: null } : {}),
  }), input.now);
  const after = projectCardById(db, card.id)!;
  activity(db, after, "card_moved", actorName(input.actor), input.now, { from: "doing", to: "waiting", waitingKind: input.waiting.kind }, input.requestId);
  return { ok: true, card: after };
}

/** S: a live wait's run resumes (approval answered, root freed). */
export function applyCardRunResumed(db: DatabaseSync, input: { actor?: ProjectActor; cardId: string; now: number }): CardOutcome {
  if (input.actor && input.actor.kind !== "server") return notAllowed("Only the server can do this.");
  const card = cardOr404(db, input.cardId);
  if (!("state" in card)) return card;
  if (!isLiveWait(card)) return notAllowed(`Card ${card.number} is not waiting on a live answer.`);
  writeCard(db, card.id, stateFields("doing"), input.now);
  const after = projectCardById(db, card.id)!;
  activity(db, after, "card_moved", "server", input.now, { from: "waiting", to: "doing" });
  return { ok: true, card: after };
}

// ── run completion (E1 calls these from completeRequest) ────────────────────

/** The generation fence (5.1): a completion affects the card only when its
 * request carries the card's current generation. */
function fenced(db: DatabaseSync, card: ProjectCard, requestId: string): boolean {
  const request = roomRequestById(db, requestId);
  return request !== null && request.card_generation === card.generation;
}

/** S: the run finished ok. Fenced. Goes to review when review applies (goal
 * mode, review on, at least one other member), else done. */
export function applyCardRunFinished(
  db: DatabaseSync,
  input: { cardId: string; requestId: string; resultMessageId?: string; reviewApplies: boolean; now: number; actor?: ProjectActor },
): CardOutcome {
  if (input.actor && input.actor.kind !== "server") return notAllowed("Only the dispatcher completes a card run.");
  const card = cardOr404(db, input.cardId);
  if (!("state" in card)) return card;
  if (card.state !== "doing" && !isLiveWait(card)) return notAllowed(`Card ${card.number} is not running.`);
  if (!fenced(db, card, input.requestId)) return { ok: true, card, superseded: true };
  const next = input.reviewApplies ? "review" : "done";
  writeCard(db, card.id, stateFields(next, {
    result_message_id: input.resultMessageId ?? null,
    ...(next === "done" ? { done_at: input.now, failures: 0 } : {}),
  }), input.now);
  const after = projectCardById(db, card.id)!;
  activity(db, after, "card_result", "server", input.now, { from: "doing", to: next }, input.requestId);
  if (next === "done") releaseDependencies(db, card.groupId, input.now);
  return { ok: true, card: after };
}

/** S: the run failed or was interrupted. Fenced. The third consecutive
 * failure parks the card in Waiting with `engine_problem`. */
export function applyCardRunFailed(
  db: DatabaseSync,
  input: { cardId: string; requestId: string; reason: string; interrupted?: boolean; now: number; actor?: ProjectActor },
): CardOutcome {
  if (input.actor && input.actor.kind !== "server") return notAllowed("Only the dispatcher fails a card run.");
  const card = cardOr404(db, input.cardId);
  if (!("state" in card)) return card;
  if (card.state !== "doing" && !isLiveWait(card)) return notAllowed(`Card ${card.number} is not running.`);
  if (!fenced(db, card, input.requestId)) return { ok: true, card, superseded: true };
  const failures = card.failures + 1;
  if (failures >= 3) {
    writeCard(db, card.id, stateFields("waiting", {
      failures, request_id: null,
      waiting_on: JSON.stringify({ kind: "engine_problem" } satisfies ProjectWaitingOn),
      reason: input.reason.slice(0, 200),
    }), input.now);
  } else {
    writeCard(db, card.id, stateFields("failed", { failures, reason: input.reason.slice(0, 200) }), input.now);
  }
  const after = projectCardById(db, card.id)!;
  activity(db, after, "card_failed", "server", input.now, { code: input.interrupted ? "interrupted" : "engine_problem", failures }, input.requestId);
  return { ok: true, card: after };
}

// ── the review run (5.1a) ───────────────────────────────────────────────────

/** L: assign a review of a card in `review` to another member. Inserts the
 * `review` request bound to the card's current generation. */
export function assignCardReview(
  db: DatabaseSync,
  input: { cardId: string; reviewerBotId: string; leadBotId: string; memberIds: string[]; now: number },
): { ok: true; requestId: string; card: ProjectCard } | CardFailure {
  const card = cardOr404(db, input.cardId);
  if (!("state" in card)) return card;
  if (projectSettingsFor(db, card.groupId)?.leadBotId !== input.leadBotId || !input.memberIds.includes(input.leadBotId)) return notAllowed("Only the current lead can assign a review.");
  if (card.state !== "review") return notAllowed(`Card ${card.number} is not waiting for review.`);
  if (card.ownerTookOver) return notAllowed("A card the owner took over does not get a review run.");
  if (!input.memberIds.includes(input.reviewerBotId)) return invalid("The reviewer is not a member of this project.");
  if (input.reviewerBotId === card.assigneeBotId) return notAllowed("The reviewer must be someone other than the assignee.");
  const baseKey = `review:${card.id}:${card.generation}`;
  let key = baseKey;
  let parent = card.requestId ? roomRequestById(db, card.requestId) : null;
  for (let seq = 0; ; seq++) {
    key = seq === 0 ? baseKey : `${baseKey}:${seq}`;
    const existing = db.prepare("SELECT * FROM room_requests WHERE admission_key=?").get(key);
    if (!existing) break;
    if (["queued", "running", "waiting_owner", "waiting_bot"].includes(String(existing.state))) {
      if (existing.to_bot_id !== input.reviewerBotId) return notAllowed("A review is already in progress with another member.");
      return { ok: true, requestId: String(existing.id), card };
    }
    parent = existing;
  }
  const requestId = insertRoomRequest(db, {
    ...(parent ? inheritedRequestLineage(parent) : {}),
    groupId: card.groupId, verb: "review", fromKind: "bot", fromBotId: input.leadBotId,
    toBotId: input.reviewerBotId, returnBotId: input.leadBotId,
    workItemId: card.id, projectGoalId: card.goalId,
    cardGeneration: card.generation, attempt: card.attempt, admissionKey: key, now: input.now,
  });
  if (requestId === null) return notAllowed("A review for this card already exists.");
  writeCard(db, card.id, { review_request_id: requestId }, input.now);
  return { ok: true, requestId, card: projectCardById(db, card.id)! };
}

/** Lane review: who reviews a card that just reached review in goal mode.
 * Another member than the assignee and the lead (SPEC-P 5.1a); the lead
 * only when no one else is in the project. Among them, the one with the
 * least review and card work open in this project, then member order. Null
 * without a lead in the room (nobody to return the verdict to) or anyone
 * but the assignee. */
export function pickCardReviewer(db: DatabaseSync, card: ProjectCard, memberIds: readonly string[]): { reviewerBotId: string; leadBotId: string } | null {
  const leadBotId = projectSettingsFor(db, card.groupId)?.leadBotId;
  if (!leadBotId || !memberIds.includes(leadBotId) || card.ownerTookOver) return null;
  const others = memberIds.filter(id => id !== card.assigneeBotId);
  const pool = others.some(id => id !== leadBotId) ? others.filter(id => id !== leadBotId) : others;
  if (!pool.length) return null;
  const load = db.prepare(`SELECT to_bot_id AS bot, count(*) AS n FROM room_requests WHERE group_id=? AND verb IN ('review','assign')
    AND state IN ('queued','running','waiting_owner','waiting_bot') GROUP BY to_bot_id`).all(card.groupId) as Array<{ bot: string; n: number }>;
  const open = new Map(load.map(row => [row.bot, Number(row.n)]));
  const reviewerBotId = [...pool].sort((a, b) => (open.get(a) ?? 0) - (open.get(b) ?? 0) || pool.indexOf(a) - pool.indexOf(b))[0]!;
  return { reviewerBotId, leadBotId };
}

/** The reviewer's verdict, recorded on the review request row (the verdict
 * is the request's result; its completion wakes the lead). A verdict from
 * another bot or for another generation is refused (5.1a). */
export function applyReviewVerdict(
  db: DatabaseSync,
  input: { cardId: string; requestId: string; verdict: "pass" | "changes"; notes?: string; reviewerBotId: string; now: number },
): { ok: true } | CardFailure {
  const card = cardOr404(db, input.cardId);
  if (!("state" in card)) return card;
  const request = roomRequestById(db, input.requestId);
  if (!request || request.verb !== "review" || request.work_item_id !== card.id) return notFound("No such review run.");
  if (["done", "failed", "cancelled", "expired", "unknown"].includes(String(request.state))) return notAllowed(`The review of card ${card.number} has ended.`);
  if (request.to_bot_id !== input.reviewerBotId) return notAllowed("This review belongs to someone else.");
  if (card.reviewRequestId !== input.requestId || request.card_generation !== card.generation) {
    return notAllowed(`You are no longer reviewing card ${card.number}.`);
  }
  if (input.verdict !== "pass" && input.verdict !== "changes") return invalid("The verdict is pass or changes.");
  db.prepare("UPDATE room_requests SET outcome_note=? WHERE id=?").run(input.verdict, input.requestId);
  const notes = input.notes?.trim().slice(0, 500);
  activity(db, card, "card_result", input.reviewerBotId, input.now, { review: input.verdict, ...(notes ? { notes } : {}) }, input.requestId);
  return { ok: true };
}

/** When the changes count starts over (lane cards): the card's latest move to
 * a NEW assignee, or the owner's own move back to To do from review, done or
 * cancelled (send back, reopen, restore). Reassigning to the same member is
 * not a fresh start, nor is the owner's Retry of a failed run or Resume of a
 * waiting one (review 2 N5): that is the same attempt carried on. */
function changesCountSince(db: DatabaseSync, cardId: string): number {
  return Number((db.prepare(`SELECT COALESCE(MAX(at),0) AS at FROM project_activity WHERE work_item_id=?
    AND ((kind='card_reassigned' AND COALESCE(json_extract(detail,'$.same'),0)=0)
      OR (kind='card_moved' AND actor='owner' AND json_extract(detail,'$.to')='todo'
        AND json_extract(detail,'$.from') IN ('review','done','cancelled')))`).get(cardId) as { at: number }).at);
}
/** Lane cards (b): how many reviews of this card asked for changes since that
 * point. Each redo bumps the card's generation, so the count runs on time. */
export function changesRequestedCount(db: DatabaseSync, cardId: string): number {
  return Number((db.prepare("SELECT count(*) AS n FROM room_requests WHERE work_item_id=? AND verb='review' AND outcome_note='changes' AND created_at>?").get(cardId, changesCountSince(db, cardId)) as { n: number }).n);
}
/** After this many changes verdicts the lead decides instead of sending back. */
export const CHANGES_BEFORE_LEAD_DECIDES = 2;

/** What the latest changes-requested review since the last reassignment
 * said, or null. */
export function changesRequestedNotes(db: DatabaseSync, cardId: string, since = changesCountSince(db, cardId)): string | null {
  const row = db.prepare(`SELECT json_extract(detail,'$.notes') AS notes FROM project_activity
    WHERE work_item_id=? AND kind='card_result' AND json_extract(detail,'$.review')='changes' AND at>?
    ORDER BY at DESC, rowid DESC LIMIT 1`).get(cardId, since) as { notes: string | null } | undefined;
  return row?.notes ?? null;
}

/** The latest recorded verdict for the card's current generation, or null. */
export function latestReviewVerdict(db: DatabaseSync, cardId: string, generation: number): "pass" | "changes" | null {
  const row = db.prepare(`SELECT outcome_note FROM room_requests
    WHERE work_item_id=? AND verb='review' AND card_generation=? AND outcome_note IN ('pass','changes')
    ORDER BY created_at DESC, id DESC LIMIT 1`).get(cardId, generation) as { outcome_note: string } | undefined;
  return row ? (row.outcome_note as "pass" | "changes") : null;
}

/** A review run that finished without a verdict (lane review). */
export const NO_VERDICT = "No verdict given";

/** The card's latest review run for its current generation, if any. */
function latestReviewRun(db: DatabaseSync, card: ProjectCard): { state: string; outcome_note: string | null } | null {
  return (db.prepare(`SELECT state, outcome_note FROM room_requests WHERE work_item_id=? AND verb='review' AND card_generation=?
    ORDER BY created_at DESC, id DESC LIMIT 1`).get(card.id, card.generation) as { state: string; outcome_note: string | null } | undefined) ?? null;
}

/** review -> done. O always; S after a `pass` verdict for the current
 * generation (lane review: a pass ends the review, the lead is told); L after
 * a pass, or when the latest review ended without any verdict (lane review:
 * the lead decides then), never after `changes` (5.1a lead-accept rule). */
export function acceptProjectCard(
  db: DatabaseSync,
  input: { cardId: string; actor: ProjectActor; now: number },
): CardOutcome {
  const card = cardOr404(db, input.cardId);
  if (!("state" in card)) return card;
  if (input.actor.kind !== "owner" && card.waitingOn?.kind === "restart") return notAllowed(`Card ${card.number} stopped at a restart. The owner picks Retry step or Skip.`);
  if (input.actor.kind === "lead" && projectSettingsFor(db, card.groupId)?.leadBotId !== input.actor.botId) return notAllowed("Only the current lead can do this.");
  if (input.actor.kind !== "owner" && input.actor.kind !== "lead" && input.actor.kind !== "server") return notAllowed("Only the lead or the owner can accept a card.");
  if (card.state !== "review") return notAllowed(`Card ${card.number} is not in review.`);
  if (input.actor.kind === "server" && latestReviewVerdict(db, card.id, card.generation) !== "pass") return notAllowed(`The latest review of card ${card.number} did not pass.`);
  if (input.actor.kind === "lead") {
    // a pass for this generation; or its latest review run finished without
    // giving a verdict (lane review: the lead decides then), unless a review
    // of this generation asked for changes. One that failed, was stopped,
    // cancelled or expired reviewed nothing: another review or the owner.
    const verdict = latestReviewVerdict(db, card.id, card.generation);
    const latest = latestReviewRun(db, card);
    const noVerdict = latest !== null && latest.state === "done" && latest.outcome_note === NO_VERDICT;
    // lane cards (b): after two changes verdicts the lead may accept the card as it stands
    const decides = verdict === "changes" && changesRequestedCount(db, card.id) >= CHANGES_BEFORE_LEAD_DECIDES;
    if (!(verdict === "pass" || (noVerdict && verdict === null) || decides)) return notAllowed(`The latest review of card ${card.number} did not pass.`);
  }
  writeCard(db, card.id, stateFields("done", { done_at: input.now, failures: 0 }), input.now);
  const after = projectCardById(db, card.id)!;
  activity(db, after, "card_moved", actorName(input.actor), input.now, { from: "review", to: "done" });
  releaseDependencies(db, card.groupId, input.now);
  return { ok: true, card: after };
}

/** review -> todo. Send back: attempt + 1 and a fresh assign request (5.1).
 * Counts as a reassignment, not progress. */
export function sendProjectCardBack(
  db: DatabaseSync,
  input: { cardId: string; actor: ProjectActor; note?: string; now: number },
): CardOutcome {
  if (input.actor.kind === "owner" && !input.actor.lineage) return notAllowed("Open this card in the Murage app or on your paired phone to start it.");
  const card = cardOr404(db, input.cardId);
  if (!("state" in card)) return card;
  if (input.actor.kind !== "owner" && card.waitingOn?.kind === "restart") return notAllowed(`Card ${card.number} stopped at a restart. The owner picks Retry step or Skip.`);
  if (input.actor.kind === "lead" && projectSettingsFor(db, card.groupId)?.leadBotId !== input.actor.botId) return notAllowed("Only the current lead can do this.");
  if (input.actor.kind !== "owner" && input.actor.kind !== "lead") return notAllowed("Only the lead or the owner can send a card back.");
  if (card.state !== "review") return notAllowed(`Card ${card.number} is not in review.`);
  if (!card.assigneeBotId) return notAllowed(`Card ${card.number} has no one assigned.`);
  // lane cards (b): reviewers have asked twice; the lead accepts it or reassigns it with a reason
  if (input.actor.kind === "lead" && changesRequestedCount(db, card.id) >= CHANGES_BEFORE_LEAD_DECIDES) {
    return notAllowed(`Card ${card.number} has been sent back for changes twice. Accept it, or reassign it and say why.`);
  }
  const attempt = card.attempt + 1;
  writeCard(db, card.id, stateFields("todo", {
    attempt, review_request_id: null, request_id: null,
    reason: input.note?.slice(0, 200) ?? null,
  }), input.now);
  const requestId = insertRoomRequest(db, {
    ...(input.actor.kind === "owner" || input.actor.kind === "lead" ? input.actor.lineage : {}),
    returnBotId: input.actor.kind === "lead" ? input.actor.botId : null,
    groupId: card.groupId, verb: "assign",
    fromKind: input.actor.kind === "owner" ? "owner" : "bot",
    fromBotId: input.actor.kind === "lead" ? input.actor.botId : null,
    toBotId: card.assigneeBotId, workItemId: card.id, projectGoalId: card.goalId,
    cardGeneration: card.generation + 1, attempt, admissionKey: cardRunAdmissionKey(card, attempt, card.generation + 1), now: input.now,
  });
  unmarkCriteriaForCard(db, card.id, input.now);
  const after = projectCardById(db, card.id)!;
  const sentBackNote = input.note?.trim().slice(0, 500);
  activity(db, after, "card_moved", actorName(input.actor), input.now, { from: "review", to: "todo", ...(sentBackNote ? { note: sentBackNote } : {}) }, requestId);
  return { ok: true, card: after, requestId: requestId ?? undefined };
}

// ── retries and ownership changes ───────────────────────────────────────────

/** failed or dead-wait -> todo. Retry: attempt + 1, new assign request.
 * Refused from a live wait: answer the decision or interrupt first. */
export function retryProjectCard(
  db: DatabaseSync,
  input: { cardId: string; actor: ProjectActor; memberIds: string[]; now: number },
): CardOutcome {
  if (input.actor.kind === "owner" && !input.actor.lineage) return notAllowed("Open this card in the Murage app or on your paired phone to start it.");
  const card = cardOr404(db, input.cardId);
  if (!("state" in card)) return card;
  if (input.actor.kind !== "owner" && card.waitingOn?.kind === "restart") return notAllowed(`Card ${card.number} stopped at a restart. The owner picks Retry step or Skip.`);
  if (input.actor.kind === "lead" && projectSettingsFor(db, card.groupId)?.leadBotId !== input.actor.botId) return notAllowed("Only the current lead can do this.");
  if (input.actor.kind !== "owner" && input.actor.kind !== "lead") return notAllowed("Only the owner or the lead can retry a card.");
  if (card.state === "waiting" && isLiveWait(card)) return notAllowed("This card is waiting on you: answer it or interrupt it first.");
  if (card.state !== "failed" && card.state !== "waiting") return notAllowed(`Card ${card.number} is ${card.state}, not failed or waiting.`);
  if (!card.assigneeBotId) return notAllowed(`Card ${card.number} has no one assigned.`);
  const previous = card.requestId ? roomRequestById(db, card.requestId) : db.prepare(
    "SELECT * FROM room_requests WHERE work_item_id=? AND verb='assign' AND state IN ('done','failed','cancelled','expired','unknown') ORDER BY created_at DESC, id DESC LIMIT 1",
  ).get(card.id);
  const attempt = card.attempt + 1;
  writeCard(db, card.id, stateFields("todo", { attempt, request_id: null, review_request_id: null }), input.now);
  const requestId = insertRoomRequest(db, {
    ...(input.actor.kind === "owner" || input.actor.kind === "lead" ? input.actor.lineage : {}),
    ...(input.actor.kind === "lead" && previous ? { parentId: String(previous.id) } : {}),
    returnBotId: input.actor.kind === "lead" ? input.actor.botId : null,
    groupId: card.groupId, verb: "assign",
    fromKind: input.actor.kind === "owner" ? "owner" : "bot",
    fromBotId: input.actor.kind === "lead" ? input.actor.botId : null,
    toBotId: card.assigneeBotId, workItemId: card.id, projectGoalId: card.goalId,
    cardGeneration: card.generation + 1, attempt, admissionKey: cardRunAdmissionKey(card, attempt, card.generation + 1), now: input.now,
  });
  unmarkCriteriaForCard(db, card.id, input.now);
  const after = projectCardById(db, card.id)!;
  activity(db, after, "card_moved", actorName(input.actor), input.now, { from: card.state, to: "todo", attempt }, requestId);
  return { ok: true, card: after, requestId: requestId ?? undefined };
}

/** any open -> todo with a new assignee. A live run is interrupted (its
 * request is cancelled here; the engine interrupt is lane E2a's) and the
 * generation bumps, fencing late results. L reassigns only in goal or
 * ongoing mode and only to project members. */
export function reassignProjectCard(
  db: DatabaseSync,
  input: { cardId: string; assigneeBotId: string; actor: ProjectActor; memberIds: string[]; now: number; reason?: string },
): CardOutcome {
  if (input.actor.kind === "owner" && !input.actor.lineage) return notAllowed("Open this card in the Murage app or on your paired phone to start it.");
  const card = cardOr404(db, input.cardId);
  if (!("state" in card)) return card;
  if (input.actor.kind !== "owner" && card.waitingOn?.kind === "restart") return notAllowed(`Card ${card.number} stopped at a restart. The owner picks Retry step or Skip.`);
  if (input.actor.kind === "lead" && projectSettingsFor(db, card.groupId)?.leadBotId !== input.actor.botId) return notAllowed("Only the current lead can do this.");
  if (input.actor.kind !== "owner" && input.actor.kind !== "lead") return notAllowed("Only the owner or the lead can reassign a card.");
  if (!input.memberIds.includes(input.assigneeBotId)) return invalid("The new assignee is not a member of this project.");
  if (!OPEN_STATES.has(card.state) || card.state === "done") return notAllowed(`Card ${card.number} is ${card.state}.`);
  const lacks = assignmentCapabilityRefusal(input.assigneeBotId, card.needs);
  if (lacks) return notAllowed(lacks);
  if (input.actor.kind === "lead") {
    const settings = projectSettingsFor(db, card.groupId)!;
    const goalActive = db.prepare("SELECT 1 FROM project_goals WHERE group_id=? AND state IN ('planning','awaiting_plan_ok','working','awaiting_signoff','paused')").get(card.groupId);
    if (settings?.mode !== "ongoing" && !goalActive) return notAllowed("The lead can reassign only while a goal runs or the project is ongoing.");
  }
  cancelCardRequests(db, card, input.now, "reassigned");
  const generation = card.generation + 1;
  writeCard(db, card.id, stateFields("todo", {
    assignee_bot_id: input.assigneeBotId, generation,
    request_id: null, review_request_id: null, owner_took_over: 0,
  }), input.now);
  const requestId = insertRoomRequest(db, {
    ...(input.actor.kind === "owner" || input.actor.kind === "lead" ? input.actor.lineage : {}),
    returnBotId: input.actor.kind === "lead" ? input.actor.botId : null,
    groupId: card.groupId, verb: "assign",
    fromKind: input.actor.kind === "owner" ? "owner" : "bot",
    fromBotId: input.actor.kind === "lead" ? input.actor.botId : null,
    toBotId: input.assigneeBotId, workItemId: card.id, projectGoalId: card.goalId,
    cardGeneration: generation + 1, attempt: card.attempt, admissionKey: cardRunAdmissionKey(card, card.attempt, generation + 1), now: input.now,
  });
  const after = projectCardById(db, card.id)!;
  activity(db, after, "card_reassigned", actorName(input.actor), input.now, { from: card.state, to: "todo", ...(card.assigneeBotId === input.assigneeBotId ? { same: true } : {}), ...(input.reason ? { reason: input.reason.slice(0, 500) } : {}) }, requestId);
  return { ok: true, card: after, requestId: requestId ?? undefined };
}

/** any open -> doing with the owner driving. The live request is cancelled
 * and the generation bumps. */
export function takeOverProjectCard(
  db: DatabaseSync,
  input: { cardId: string; actor: ProjectActor; now: number },
): CardOutcome {
  const card = cardOr404(db, input.cardId);
  if (!("state" in card)) return card;
  if (input.actor.kind !== "owner") return notAllowed("Only the owner can take over a card.");
  if (!OPEN_STATES.has(card.state)) return notAllowed(`Card ${card.number} is ${card.state}.`);
  cancelCardRequests(db, card, input.now, "took over");
  writeCard(db, card.id, stateFields("doing", {
    owner_took_over: 1, assignee_bot_id: null, generation: card.generation + 1,
    request_id: null, review_request_id: null,
  }), input.now);
  const after = projectCardById(db, card.id)!;
  activity(db, after, "card_took_over", "owner", input.now, { from: card.state });
  return { ok: true, card: after };
}

/** O: finish a card. On a taken-over card ("Done") needs no confirm; from
 * todo, waiting or failed "Done without review" needs `confirm: true`. From
 * a live wait the run is interrupted first. */
export function finishProjectCardByOwner(
  db: DatabaseSync,
  input: { cardId: string; actor?: ProjectActor; confirm?: boolean; reason?: string; now: number },
): CardOutcome {
  if (input.actor && input.actor.kind !== "owner") return notAllowed("Only the owner can finish a card this way.");
  const card = cardOr404(db, input.cardId);
  if (!("state" in card)) return card;
  if (card.state === "doing" && card.ownerTookOver) {
    writeCard(db, card.id, stateFields("done", { done_at: input.now, failures: 0 }), input.now);
  } else if (card.state === "todo" || card.state === "failed" || card.state === "waiting") {
    if (input.confirm !== true) return notAllowed("Finishing this card without review needs your confirmation.");
    writeCard(db, card.id, stateFields("done", {
      done_at: input.now, failures: 0, request_id: null,
      reason: input.reason?.slice(0, 200) ?? null,
    }), input.now);
  } else {
    return notAllowed(`Card ${card.number} is ${card.state}.`);
  }
  cancelCardRequests(db, card, input.now, "done by owner");
  const after = projectCardById(db, card.id)!;
  activity(db, after, "card_moved", "owner", input.now, { from: card.state, to: "done" });
  releaseDependencies(db, card.groupId, input.now);
  return { ok: true, card: after };
}

/** any open -> cancelled (archived). O and L cancel (a lead cancel of a goal
 * card counts one replan, 5.3); S cancels for End project and Close. Stop
 * all does NOT cancel: it moves doing to waiting `stopped`. */
export function cancelProjectCard(
  db: DatabaseSync,
  /** ownerDirected: the lead acts in a turn the owner started (asked in chat, or a close). */
  input: { cardId: string; actor: ProjectActor; now: number; ownerDirected?: boolean },
): CardOutcome {
  const card = cardOr404(db, input.cardId);
  if (!("state" in card)) return card;
  if (input.actor.kind !== "owner" && card.waitingOn?.kind === "restart") return notAllowed(`Card ${card.number} stopped at a restart. The owner picks Retry step or Skip.`);
  if (input.actor.kind === "lead" && projectSettingsFor(db, card.groupId)?.leadBotId !== input.actor.botId) return notAllowed("Only the current lead can do this.");
  if (input.actor.kind === "member" || input.actor.kind === "assignee") return notAllowed("Only the owner, the lead or Murage can cancel a card.");
  // lane cards: a card the owner made is the owner's to cancel; the lead reassigns it instead
  if (input.actor.kind === "lead" && card.createdBy === "owner" && !input.ownerDirected) return notAllowed(`Card ${card.number} is the owner's. If it is obsolete, ask the owner to cancel it.`);
  if (!OPEN_STATES.has(card.state)) return notAllowed(`Card ${card.number} is ${card.state}.`);
  cancelCardRequests(db, card, input.now, "cancelled");
  if (input.actor.kind === "lead" && card.goalId) {
    db.prepare("UPDATE project_goals SET replans=replans+1, revision=revision+1 WHERE id=? AND state NOT IN ('done','stopped','failed')").run(card.goalId);
  }
  writeCard(db, card.id, stateFields("cancelled", {
    archived_at: input.now, request_id: null, review_request_id: null,
  }), input.now);
  const after = projectCardById(db, card.id)!;
  activity(db, after, "card_moved", actorName(input.actor), input.now, { from: card.state, to: "cancelled" });
  releaseDependencies(db, card.groupId, input.now);
  return { ok: true, card: after };
}

/** cancelled -> todo. Restore from the archive: clears archived_at,
 * owner_took_over and the request; nothing runs until Start. */
export function restoreProjectCard(
  db: DatabaseSync,
  input: { cardId: string; actor: ProjectActor; now: number },
): CardOutcome {
  const card = cardOr404(db, input.cardId);
  if (!("state" in card)) return card;
  if (input.actor.kind !== "owner") return notAllowed("Only the owner can restore an archived card.");
  if (card.state !== "cancelled") return notAllowed(`Card ${card.number} is not archived.`);
  writeCard(db, card.id, stateFields("todo", {
    archived_at: null, owner_took_over: 0, request_id: null, review_request_id: null,
  }), input.now);
  const after = projectCardById(db, card.id)!;
  activity(db, after, "card_moved", "owner", input.now, { from: "cancelled", to: "todo" });
  return { ok: true, card: after };
}

/** done -> todo. Reopen: attempt + 1, done_at cleared, failures reset; no
 * request until Start. The lead cannot reopen a done card; it writes a new
 * one. */
export function reopenProjectCard(
  db: DatabaseSync,
  input: { cardId: string; actor: ProjectActor; now: number },
): CardOutcome {
  const card = cardOr404(db, input.cardId);
  if (!("state" in card)) return card;
  if (input.actor.kind !== "owner") return notAllowed("Only the owner can reopen a done card.");
  if (card.state !== "done") return notAllowed(`Card ${card.number} is not done.`);
  writeCard(db, card.id, stateFields("todo", {
    attempt: card.attempt + 1, done_at: null, owner_took_over: 0,
    request_id: null, review_request_id: null, failures: 0, result_message_id: null,
  }), input.now);
  unmarkCriteriaForCard(db, card.id, input.now);
  const after = projectCardById(db, card.id)!;
  activity(db, after, "card_moved", "owner", input.now, { from: "done", to: "todo", attempt: after.attempt });
  return { ok: true, card: after };
}

// ── owner board writes ──────────────────────────────────────────────────────

/** O: reorder within a column, or move to a custom column of the same state
 * (any state -> same state, new position or column). Cross-state drags map to
 * the matching transition: todo (retry/restore/reopen rules), doing
 * (enqueue), done (finish rules), cancelled (cancel). */
export function moveProjectCard(
  db: DatabaseSync,
  input: { actor?: ProjectActor;
    cardId: string;
    expectedRevision: number;
    toState?: ProjectCard["state"];
    columnId?: string | null;
    beforeCardId?: string;
    afterCardId?: string;
    confirm?: boolean;
    now: number;
  },
): CardOutcome {
  if (input.actor && input.actor.kind !== "owner") return notAllowed("Only the owner can do this.");
  const card = cardOr404(db, input.cardId);
  if (!("state" in card)) return card;
  const conflict = checkRevision(card, input.expectedRevision);
  if (conflict) return conflict;
  const destination = input.toState ?? card.state;
  const fields: Record<string, unknown> = {};
  if (input.columnId !== undefined) {
    if (input.columnId === null) fields.column_id = null;
    else {
      const column = db.prepare("SELECT state FROM project_board_columns WHERE group_id=? AND id=?").get(card.groupId, input.columnId) as { state: string } | undefined;
      if (!column) return invalid("No such column.");
      if (column.state !== destination) return notAllowed(`That column does not hold ${destination} cards.`);
      fields.column_id = input.columnId;
    }
  }
  const before = input.beforeCardId ? projectCardById(db, input.beforeCardId) : null;
  const after = input.afterCardId ? projectCardById(db, input.afterCardId) : null;
  if (before || after) {
    fields.position = before && after ? (before.position + after.position) / 2
      : before ? before.position - 1024
      : after ? after.position + 1024
      : card.position;
  }
  if (input.toState !== undefined && input.toState !== card.state) {
    const transition = (): CardOutcome => {
      switch (input.toState) {
        case "doing":
          return enqueueThenReport(db, card, input.now, input.actor ?? { kind: "owner" });
        case "done":
          if (card.state === "review") return acceptProjectCard(db, { cardId: card.id, actor: input.actor ?? { kind: "owner" }, now: input.now });
          return finishProjectCardByOwner(db, { cardId: card.id, confirm: input.confirm, now: input.now });
        case "cancelled":
          return cancelProjectCard(db, { cardId: card.id, actor: input.actor ?? { kind: "owner" }, now: input.now });
        case "todo":
          if (card.state === "review") return sendProjectCardBack(db, { cardId: card.id, actor: input.actor ?? { kind: "owner" }, now: input.now });
          if (card.state === "failed" || (card.state === "waiting" && !isLiveWait(card))) {
            return retryProjectCard(db, { cardId: card.id, actor: input.actor ?? { kind: "owner" }, memberIds: [], now: input.now });
          }
          if (card.state === "cancelled") return restoreProjectCard(db, { cardId: card.id, actor: input.actor ?? { kind: "owner" }, now: input.now });
          if (card.state === "done") return reopenProjectCard(db, { cardId: card.id, actor: input.actor ?? { kind: "owner" }, now: input.now });
          return notAllowed(`Card ${card.number} cannot move from ${card.state} to To do.`);
        default:
          return notAllowed(`Card ${card.number} cannot move to ${input.toState}.`);
      }
    };
    const result = transition();
    if (!result.ok) return result;
    if (result.card.state !== destination) { delete fields.column_id; delete fields.position; }
    if (Object.keys(fields).length) writeCard(db, card.id, fields, input.now);
    return { ...result, card: projectCardById(db, card.id)! };
  }
  if (Object.keys(fields).length === 0) return { ok: true, card };
  writeCard(db, card.id, fields, input.now);
  const updated = projectCardById(db, card.id)!;
  activity(db, updated, "card_moved", "owner", input.now, { reorder: true });
  return { ok: true, card: updated };
}

function enqueueThenReport(db: DatabaseSync, card: ProjectCard, now: number, actor: ProjectActor): CardOutcome {
  // A drop into In progress only enqueues (5.1): the card stays in To do
  // with its run queued until the arbiter admits it.
  const queued = enqueueCardRun(db, { cardId: card.id, actor, now });
  if (!queued.ok) return queued;
  return { ok: true, card: projectCardById(db, card.id)!, requestId: queued.requestId };
}

/** O: edit title, description, due date; writes/workRoot only while the card
 * is in To do or a dead wait, and workRoot must index a current work root. */
export function editProjectCard(
  db: DatabaseSync,
  input: { actor?: ProjectActor;
    cardId: string;
    expectedRevision: number;
    title?: string;
    description?: string;
    dueAt?: number | null;
    writes?: boolean;
    workRoot?: number | null;
    now: number;
  },
): CardOutcome {
  if (input.actor && input.actor.kind !== "owner") return notAllowed("Only the owner can do this.");
  const card = cardOr404(db, input.cardId);
  if (!("state" in card)) return card;
  const conflict = checkRevision(card, input.expectedRevision);
  if (conflict) return conflict;
  const fields: Record<string, unknown> = {};
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (title.length < 1 || title.length > 120) return invalid("A card title is 1 to 120 characters.");
    fields.title = title;
  }
  if (input.description !== undefined) {
    if (input.description.length > 2000) return invalid("A card description is at most 2000 characters.");
    fields.description = input.description;
  }
  if (input.dueAt !== undefined) fields.due_at = input.dueAt;
  if (input.writes !== undefined || input.workRoot !== undefined) {
    const editable = card.state === "todo" || (card.state === "waiting" && !isLiveWait(card)) || card.state === "failed";
    if (!editable) return notAllowed("The write settings of a running card cannot change.");
    if (input.writes !== undefined) fields.writes = input.writes ? 1 : 0;
    if (input.workRoot !== undefined) {
      if (input.workRoot === null) fields.work_root_index = null;
      else {
        const settings = projectSettingsFor(db, card.groupId)!;
        if (!Number.isInteger(input.workRoot) || input.workRoot < 0 || input.workRoot >= settings.workRoots.length) {
          return invalid("The work folder index does not name a work folder of this project.");
        }
        fields.work_root_index = input.workRoot;
      }
    }
  }
  if (Object.keys(fields).length === 0) return { ok: true, card };
  writeCard(db, card.id, fields, input.now);
  return { ok: true, card: projectCardById(db, card.id)! };
}

export { DEFAULT_PROJECT_PARALLEL_CARDS };

/** What a redo run is told (lane cards): see changesRequestedBlock. */
export interface RedoContext { reviewerNotes?: string; leadNote?: string; reassigned?: true; noteByOwner?: true }

/** What a card's redo quotes (lane cards). Looking back from now, past any
 * failure retries: a send back from review gives the lead's own note and the
 * reviewer's notes (when the latest review asked for changes); a reassignment
 * gives the new assignee the lead's reason and the same reviewer notes. A
 * card that was never sent back or reassigned quotes nothing. */
export function redoContext(db: DatabaseSync, cardId: string): RedoContext {
  const events = db.prepare(`SELECT kind, actor, json_extract(detail,'$.from') AS from_state, json_extract(detail,'$.note') AS note, json_extract(detail,'$.reason') AS reason
    FROM project_activity WHERE work_item_id=? AND ((kind='card_moved' AND json_extract(detail,'$.to')='todo' AND json_extract(detail,'$.from') IN ('review','failed','waiting','done','cancelled')) OR kind='card_reassigned')
    ORDER BY at DESC, rowid DESC`).all(cardId) as Array<{ kind: string; actor: string; from_state: string | null; note: string | null; reason: string | null }>;
  const last = events.find(event => !(event.kind === "card_moved" && (event.from_state === "failed" || event.from_state === "waiting")));
  if (!last) return {};
  const sentBack = last.kind === "card_moved" && last.from_state === "review";
  const reassigned = last.kind === "card_reassigned";
  if (!sentBack && !reassigned) return {};
  const latestReview = db.prepare("SELECT outcome_note FROM room_requests WHERE work_item_id=? AND verb='review' ORDER BY created_at DESC, id DESC LIMIT 1").get(cardId) as { outcome_note: string | null } | undefined;
  const reviewerNotes = (sentBack || last.from_state === "review") && latestReview?.outcome_note === "changes" ? changesRequestedNotes(db, cardId, 0) : null;
  const leadNote = sentBack ? last.note : last.reason;
  // review 2 N4: a reassigned card's result was someone's earlier attempt, and
  // the note is whoever moved it (the owner or the lead)
  return { ...(reviewerNotes ? { reviewerNotes } : {}), ...(leadNote ? { leadNote } : {}),
    ...(reassigned ? { reassigned: true as const } : {}), ...(leadNote && last.actor === "owner" ? { noteByOwner: true as const } : {}) };
}
