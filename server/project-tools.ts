import { partitionSourcesAllowed } from "./partition-sources.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The server-side semantics of the internal project tools (SPEC-P 11.3).
// Lane E1 serves them at /api/internal/project/* through the agents proxy;
// this module owns the row effects (accept, card-manage, criteria, done,
// blocked, brief-update). Every call is authorised from the caller's bound
// request: the request must be running, the project open and not paused, and
// the caller's role is read from current state (the lead is
// project_settings.lead_bot_id now, not at turn start).
import { createHash } from "node:crypto";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";

import { acceptProjectCard, changesRequestedCount, CHANGES_BEFORE_LEAD_DECIDES, editProjectCard, cancelProjectCard, reassignProjectCard, retryProjectCard, sendProjectCardBack, type CardFailure } from "./project-cards.ts";
import { applyGoalEnvelopeV2, projectRequestSourceMessages } from "./project-envelope.ts";
import { leadProjectBriefUpdate, type BriefFailure } from "./project-briefs.ts";
import { inheritedRequestLineage, activeProjectGoal, projectCardById, projectGoalById, projectSettingsFor, roomRequestById } from "./project-records.ts";

export interface ProjectToolContext {
  groupId: string;
  /** turnAudienceIsOwner(...) on the consuming turn (owner-audience.ts). */
  ownerAudience: boolean;
  /** The calling bot, and the turn's bound request (7.1). */
  botId: string;
  requestId: string;
  cardGeneration?: number;
  turnGeneration?: string;
  memberIds: string[];
  now: number;
  roomThreadId?: string;
  /** Server-supplied project room and current members' desk threads. */
  projectThreadIds?: readonly string[];
}

export type ProjectToolResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400 | 403 | 409; body: { error: string; reason?: string; blockers?: string[] } };

const AUDIENCE_REFUSAL: ProjectToolResult = { status: 403, body: { error: "Project tools are not available in this conversation." } };
const badRequest = (error: string): ProjectToolResult => ({ status: 400, body: { error } });
const forbidden = (error: string): ProjectToolResult => ({ status: 403, body: { error } });
const conflict = (reason: string, blockers?: string[]): ProjectToolResult => ({ status: 409, body: { error: "not_allowed", reason, ...(blockers ? { blockers } : {}) } });

function noUnknownFields(body: Record<string, unknown>, allowed: string[]): ProjectToolResult | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return badRequest("Expected an object.");
  const key = Object.keys(body).find(field => !allowed.includes(field));
  return key ? badRequest(`Unknown field: ${key}`) : null;
}

/** A turn the owner started: their own message, the lead's reply to it, the
 * owner's steering note to the lead (a redirect, lane cards review 2), or the
 * project's close. Such a turn may do what the owner asked even when the goal
 * is paused, and may cancel or edit an owner's card (lane cards). */
function ownerDirectedRequest(db: DatabaseSync, ctx: ProjectToolContext, settings: { leadBotId: string | null }): boolean {
  const request = roomRequestById(db, ctx.requestId);
  if (!request) return false;
  const parent = request.parent_id ? roomRequestById(db, String(request.parent_id)) : null;
  const ownerTurn = request.from_kind === "owner" && ["owner_send", "room_turn"].includes(String(request.verb));
  // a teammate's @mention of the lead is keyed on the owner's message too
  // (room_turn:<message>:<lead>), but it is the bot's turn (lane queuedhop)
  const ownerReply = request.verb === "room_turn" && request.from_kind !== "bot" && ctx.botId === settings.leadBotId
    && parent?.group_id === ctx.groupId && parent.verb === "owner_send" && parent.from_kind === "owner"
    && Boolean(request.source_message_id) && request.admission_key === `room_turn:${request.source_message_id}:${ctx.botId}`;
  const closeSummary = request.verb === "wake" && ctx.botId === settings.leadBotId
    && String(request.admission_key).startsWith(`close:${ctx.groupId}:`);
  // POST .../project/control/redirect: the owner's own words, woken to the lead
  const ownerRedirect = request.verb === "wake" && request.from_kind === "owner" && ctx.botId === settings.leadBotId
    && String(request.admission_key).startsWith(`wake:redirect:${ctx.groupId}:`);
  return ownerTurn || ownerReply || closeSummary || ownerRedirect;
}

/** The shared gate of 11.3: owner audience, project open and running, the
 * calling request running. Returns the lead's id on success. */
function gate(db: DatabaseSync, ctx: ProjectToolContext): { leadBotId: string | null } | ProjectToolResult {
  if (!ctx.ownerAudience) return AUDIENCE_REFUSAL;
  const settings = projectSettingsFor(db, ctx.groupId);
  if (!settings || settings.endedAt !== null) return conflict("This is a channel now.");
  if (settings.closedAt !== null) return conflict("This project is closed.");
  if (settings.runState === "paused") return conflict("This project is paused.");
  const request = roomRequestById(db, ctx.requestId);
  if (!request || request.group_id !== ctx.groupId || String(request.admission_key).startsWith("usage:")) return forbidden("This call is not bound to a request of this project.");
  if (!ctx.memberIds.includes(ctx.botId) || request.to_bot_id !== ctx.botId) return forbidden("You are no longer on this work.");
  if (request.work_item_id) {
    const card = projectCardById(db, String(request.work_item_id));
    if (!card || card.groupId !== ctx.groupId || card.generation !== request.card_generation || ctx.cardGeneration !== card.generation) return forbidden("You are no longer on this work.");
  }
  if (request.state !== "running") return forbidden("You are no longer on this work.");
  const goal = request.project_goal_id ? projectGoalById(db, String(request.project_goal_id)) : null;
  if (goal && ["paused", "stopped", "failed"].includes(goal.state)) {
    if (!ownerDirectedRequest(db, ctx, settings)) return conflict("This goal is paused.");
  }
  return { leadBotId: settings.leadBotId };
}

function leadOnly(db: DatabaseSync, ctx: ProjectToolContext): { leadBotId: string } | ProjectToolResult {
  const gated = gate(db, ctx);
  if (!("leadBotId" in gated)) return gated;
  if (gated.leadBotId !== ctx.botId) return forbidden("Only the project lead can do this.");
  return { leadBotId: gated.leadBotId };
}

const failureReason = (outcome: CardFailure | BriefFailure): string => outcome.reason;

/** project_accept: review -> done after a pass verdict for the card's
 * current generation (5.1a). */
function projectToolAcceptImpl(db: DatabaseSync, ctx: ProjectToolContext, body: Record<string, unknown>): ProjectToolResult {
  const bad = noUnknownFields(body, ["cardId"]);
  if (bad) return bad;
  if (typeof body.cardId !== "string") return badRequest("cardId is required.");
  const lead = leadOnly(db, ctx);
  if (!("leadBotId" in lead)) return lead;
  if (projectCardById(db, body.cardId)?.groupId !== ctx.groupId) return forbidden("This card is not in this project.");
  const accepted = acceptProjectCard(db, { cardId: body.cardId, actor: { kind: "lead", botId: ctx.botId }, now: ctx.now });
  if (!accepted.ok) return conflict(failureReason(accepted));
  return { status: 200, body: { ok: true, card: accepted.card } };
}

/** project_card_manage: the lead's 5.1 rows (cancel, reassign, retry,
 * send_back). Cancel/replace counts a replan inside the transitions. */
function projectToolCardManageImpl(
  db: DatabaseSync,
  ctx: ProjectToolContext,
  body: Record<string, unknown>,
): ProjectToolResult {
  const bad = noUnknownFields(body, ["cardId", "action", "assigneeBotId", "note", "writes", "workRoot"]);
  if (bad) return bad;
  if (typeof body.cardId !== "string") return badRequest("cardId is required.");
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 500)) return badRequest("note is at most 500 characters.");
  if (body.writes !== undefined && typeof body.writes !== "boolean") return badRequest("writes is a boolean.");
  if (body.workRoot !== undefined && (!Number.isInteger(body.workRoot) || (body.workRoot as number) < 0)) return badRequest("workRoot is a work folder index.");
  const action = body.action;
  if (!["cancel", "reassign", "retry", "send_back"].includes(String(action))) return badRequest("action is cancel, reassign, retry or send_back.");
  const lead = leadOnly(db, ctx);
  if (!("leadBotId" in lead)) return lead;
  const card = projectCardById(db, body.cardId);
  if (!card || card.groupId !== ctx.groupId) return forbidden("This card is not in this project.");
  if (action === "reassign" && typeof body.assigneeBotId !== "string") return badRequest("assigneeBotId is required.");
  // lane cards (b): after two changes verdicts a reassignment says why
  const note = typeof body.note === "string" ? body.note.trim() : "";
  const reasonRequired = action === "reassign" && card.state === "review" && changesRequestedCount(db, card.id) >= CHANGES_BEFORE_LEAD_DECIDES;
  const reason = reasonRequired ? note : "";
  if (reasonRequired && !reason) {
    return badRequest("Reviewers asked for changes twice on this card. Say why you are reassigning it: give a note.");
  }
  // Like brief-update, bind the receipt to this authorized request and a
  // normalized operation hash. Check before edits or run cancellation.
  const operation = action === "reassign" ? createHash("sha256").update(JSON.stringify({
    cardId: card.id, action, assigneeBotId: body.assigneeBotId,
    note: typeof body.note === "string" ? body.note.trim() : "",
    writes: body.writes ?? null, workRoot: body.workRoot ?? null,
  })).digest("hex") : null;
  if (operation) {
    const receipt = db.prepare("SELECT json_extract(detail,'$.resultRequestId') AS result_request_id FROM project_activity WHERE group_id=? AND request_id=? AND kind='card_reassigned' AND json_extract(detail,'$.operation')=?")
      .get(ctx.groupId, ctx.requestId, operation);
    if (receipt) return { status: 200, body: { ok: true, card, requestId: receipt.result_request_id } };
  }
  const ownerDirected = ownerDirectedRequest(db, ctx, { leadBotId: lead.leadBotId });
  if (body.writes !== undefined || body.workRoot !== undefined) {
    // lane cards: a card the owner made is not rewritten by the lead
    if (card.createdBy === "owner" && !ownerDirected) return forbidden(`Card ${card.number} is the owner's: ask the owner to change its write access or work folder.`);
    const edited = editProjectCard(db, { cardId: card.id, expectedRevision: card.revision, writes: body.writes as boolean | undefined, workRoot: body.workRoot as number | undefined, now: ctx.now });
    if (!edited.ok) return edited.error === "invalid" ? badRequest(edited.reason) : conflict(edited.reason);
  }
  const actor = { kind: "lead" as const, botId: ctx.botId, lineage: inheritedRequestLineage(roomRequestById(db, ctx.requestId)!) };
  if (action === "cancel") {
    const outcome = cancelProjectCard(db, { cardId: body.cardId, actor, now: ctx.now, ownerDirected });
    return outcome.ok ? { status: 200, body: { ok: true, card: outcome.card } } : conflict(failureReason(outcome));
  }
  if (action === "reassign") {
    const outcome = reassignProjectCard(db, { cardId: body.cardId, assigneeBotId: body.assigneeBotId as string, actor, memberIds: ctx.memberIds, now: ctx.now, ...(reason ? { reason } : {}) });
    if (!outcome.ok) return conflict(failureReason(outcome));
    db.prepare("UPDATE project_activity SET request_id=?, detail=json_set(detail,'$.operation',?,'$.resultRequestId',?) WHERE group_id=? AND work_item_id=? AND kind='card_reassigned' AND request_id=?")
      .run(ctx.requestId, operation, outcome.requestId ?? null, ctx.groupId, card.id, outcome.requestId ?? null);
    return { status: 200, body: { ok: true, card: outcome.card, requestId: outcome.requestId } };
  }
  if (action === "retry") {
    const outcome = retryProjectCard(db, { cardId: body.cardId, actor, memberIds: ctx.memberIds, now: ctx.now });
    return outcome.ok ? { status: 200, body: { ok: true, card: outcome.card } } : conflict(failureReason(outcome));
  }
  const outcome = sendProjectCardBack(db, { cardId: body.cardId, actor, note: typeof body.note === "string" ? body.note : undefined, now: ctx.now });
  return outcome.ok ? { status: 200, body: { ok: true, card: outcome.card } } : conflict(failureReason(outcome));
}

/** The goal of an envelope-shaped tool call: the caller's active goal. */
function activeGoalOr409(db: DatabaseSync, ctx: ProjectToolContext): { goalId: string } | ProjectToolResult {
  const goal = activeProjectGoal(db, ctx.groupId);
  if (!goal) return conflict("This project has no active goal.");
  if (!["planning", "working", "awaiting_signoff"].includes(goal.state)) return conflict("This goal is paused.");
  return { goalId: goal.id };
}

/** project_criteria: the envelope v2 criteria payload (9). */
function projectToolCriteriaImpl(db: DatabaseSync, ctx: ProjectToolContext, body: Record<string, unknown>): ProjectToolResult {
  const shape = z.object({
    propose: z.array(z.string().trim().min(1).max(300)).min(2).max(5).optional(),
    met: z.array(z.object({ id: z.string(), evidence: z.object({ kind: z.enum(["message", "file", "check"]), ref: z.string() }).strict() }).strict()).max(10).optional(),
  }).strict().safeParse(body);
  if (!shape.success || (body.propose === undefined) === (body.met === undefined)) return badRequest("Give proposed criteria or evidence marks.");
  const bad = noUnknownFields(body, ["propose", "met"]);
  if (bad) return bad;
  const lead = leadOnly(db, ctx);
  if (!("leadBotId" in lead)) return lead;
  const goal = activeGoalOr409(db, ctx);
  if (!("goalId" in goal)) return goal;
  const result = applyGoalEnvelopeV2(db, { groupId: ctx.groupId, goalId: goal.goalId, leadBotId: ctx.botId, leadRequestId: ctx.requestId, memberIds: ctx.memberIds, now: ctx.now, roomThreadId: ctx.roomThreadId }, { v: 2, status: "criteria", ...(body.propose !== undefined ? { propose: body.propose } : {}), ...(body.met !== undefined ? { met: body.met } : {}) });
  if (!result.ok) return conflict("reason" in result ? result.reason : "The plan was refused.", "blockers" in result ? result.blockers : undefined);
  return { status: 200, body: { ok: true, goal: activeProjectGoal(db, ctx.groupId) } };
}

/** project_done: working -> awaiting_signoff, or 409 with the unmet list. */
function projectToolDoneImpl(db: DatabaseSync, ctx: ProjectToolContext, body: Record<string, unknown>): ProjectToolResult {
  const bad = noUnknownFields(body, ["detail"]);
  if (bad) return bad;
  if (body.detail !== undefined && (typeof body.detail !== "string" || body.detail.length > 500)) return badRequest("detail is at most 500 characters.");
  const lead = leadOnly(db, ctx);
  if (!("leadBotId" in lead)) return lead;
  const goal = activeGoalOr409(db, ctx);
  if (!("goalId" in goal)) return goal;
  const result = applyGoalEnvelopeV2(db, { groupId: ctx.groupId, goalId: goal.goalId, leadBotId: ctx.botId, leadRequestId: ctx.requestId, memberIds: ctx.memberIds, now: ctx.now, roomThreadId: ctx.roomThreadId }, { v: 2, status: "done", ...(body.detail !== undefined ? { detail: body.detail } : {}) });
  if (!result.ok) return conflict("reason" in result ? result.reason : "The plan was refused.", "blockers" in result ? result.blockers : undefined);
  return { status: 200, body: { ok: true, goal: activeProjectGoal(db, ctx.groupId) } };
}

/** project_blocked: the goal pauses with the detail as its reason, and an
 * Inbox item is derived from the paused row (5.6). */
function projectToolBlockedImpl(db: DatabaseSync, ctx: ProjectToolContext, body: Record<string, unknown>): ProjectToolResult {
  const bad = noUnknownFields(body, ["detail"]);
  if (bad) return bad;
  if (typeof body.detail !== "string" || body.detail.trim().length < 1 || body.detail.length > 500) return badRequest("detail is 1 to 500 characters.");
  const lead = leadOnly(db, ctx);
  if (!("leadBotId" in lead)) return lead;
  const goal = activeGoalOr409(db, ctx);
  if (!("goalId" in goal)) return goal;
  const result = applyGoalEnvelopeV2(db, { groupId: ctx.groupId, goalId: goal.goalId, leadBotId: ctx.botId, leadRequestId: ctx.requestId, memberIds: ctx.memberIds, now: ctx.now }, { v: 2, status: "blocked", detail: body.detail });
  if (!result.ok) return conflict("reason" in result ? result.reason : "The plan was refused.");
  return { status: 200, body: { ok: true, goal: activeProjectGoal(db, ctx.groupId) } };
}

/** project_brief_update: the lead's append-only decision or note (11.3). */
function projectToolBriefUpdateImpl(db: DatabaseSync, ctx: ProjectToolContext, body: Record<string, unknown>): ProjectToolResult {
  const bad = noUnknownFields(body, ["decision", "note", "sourceMessageIds"]);
  if (bad) return bad;
  const lead = leadOnly(db, ctx);
  if (!("leadBotId" in lead)) return lead;
  if (!Array.isArray(body.sourceMessageIds) || body.sourceMessageIds.some(id => typeof id !== "string")) return badRequest("sourceMessageIds is a list of message ids.");
  if (body.decision !== undefined && typeof body.decision !== "string") return badRequest("decision is text.");
  const note = body.note === undefined ? undefined : body.note;
  if (note !== undefined && (typeof note !== "object" || note === null || Array.isArray(note) || typeof (note as { text?: unknown }).text !== "string")) {
    return badRequest("note is { text, path? }.");
  }
  if (note && typeof note === "object") {
    const invalidNote = noUnknownFields(note as Record<string, unknown>, ["text", "path"]);
    if (invalidNote) return invalidNote;
    if ("path" in note && (typeof note.path !== "string" || note.path.length > 512)) return badRequest("path is at most 512 characters.");
  }
  if (body.sourceMessageIds.length < 1 || body.sourceMessageIds.length > 20) return badRequest("A bot-written brief entry carries its source messages.");
  if (typeof body.decision === "string" && body.decision.length > 500) return badRequest("A decision is at most 500 characters.");
  if (note && (note as { text: string }).text.length > 500) return badRequest("A note is at most 500 characters.");
  const threads = JSON.stringify(ctx.projectThreadIds ?? []);
  for (const id of body.sourceMessageIds as string[]) {
    if (!db.prepare("SELECT 1 FROM messages WHERE id=? AND thread_id IN (SELECT value FROM json_each(?))").get(id, threads)) {
      return badRequest("These are not messages of this project.");
    }
  }
  const sourceMessageIds = [...new Set([...(body.sourceMessageIds as string[]), ...projectRequestSourceMessages(db, ctx.requestId)])];
  const sourceThread = db.prepare("SELECT target_thread_id,root_thread_id FROM room_requests WHERE id=?").get(ctx.requestId);
  if (sourceThread && !partitionSourcesAllowed(db, ctx.botId, String(sourceThread.target_thread_id ?? sourceThread.root_thread_id), sourceMessageIds)) return { status: 403, body: { error: "Those sources belong to another team." } };
  // Keep submitted citations first within the brief bound; the activity receipt
  // retains the full inherited provenance alongside the operation identity.
  const typedNote = note as { text: string; path?: string } | undefined;
  const operation = createHash("sha256").update(JSON.stringify({
    decision: typeof body.decision === "string" ? body.decision.trim() : null,
    note: typedNote ? { text: typedNote.text.trim(), path: typedNote.path ?? null } : null,
    sources: [...sourceMessageIds].sort(),
  })).digest("hex");
  const receipt = db.prepare("SELECT json_extract(detail,'$.version') AS version FROM project_activity WHERE group_id=? AND request_id=? AND kind='brief_version' AND json_extract(detail,'$.operation')=?").get(ctx.groupId, ctx.requestId, operation);
  if (receipt) return { status: 200, body: { ok: true, briefVersion: Number(receipt.version) } };
  const updated = leadProjectBriefUpdate(db, {
    groupId: ctx.groupId, leadBotId: ctx.botId,
    decision: typeof body.decision === "string" ? body.decision : undefined,
    note: note as { text: string; path?: string } | undefined,
    sourceMessageIds: sourceMessageIds.slice(0, 20),
    lineageSourceMessageIds: sourceMessageIds.slice(20),
    now: ctx.now,
  });
  if (!updated.ok) return updated.error === "changed" ? conflict(updated.reason) : badRequest(updated.reason);
  db.prepare("UPDATE project_activity SET request_id=?, detail=json_set(detail,'$.operation',?,'$.sourceMessageIds',json(?)) WHERE group_id=? AND kind='brief_version' AND json_extract(detail,'$.version')=?")
    .run(ctx.requestId, operation, JSON.stringify(sourceMessageIds), ctx.groupId, updated.brief.version);
  return { status: 200, body: { ok: true, briefVersion: updated.brief.version } };
}

function projectToolTransaction(db: DatabaseSync, ctx: ProjectToolContext, body: Record<string, unknown>, apply: (db: DatabaseSync, ctx: ProjectToolContext, body: Record<string, unknown>) => ProjectToolResult): ProjectToolResult {
  if (!ctx.ownerAudience) return AUDIENCE_REFUSAL;
  db.exec("SAVEPOINT project_tool");
  try {
    const result = apply(db, ctx, body);
    if (result.status !== 200) db.exec("ROLLBACK TO project_tool");
    db.exec("RELEASE project_tool");
    return result;
  } catch (error) {
    db.exec("ROLLBACK TO project_tool; RELEASE project_tool");
    throw error;
  }
}

export function projectToolAccept(db: DatabaseSync, ctx: ProjectToolContext, body: Record<string, unknown>): ProjectToolResult {
  return projectToolTransaction(db, ctx, body, projectToolAcceptImpl);
}

export function projectToolCardManage(db: DatabaseSync, ctx: ProjectToolContext, body: Record<string, unknown>): ProjectToolResult {
  return projectToolTransaction(db, ctx, body, projectToolCardManageImpl);
}

export function projectToolCriteria(db: DatabaseSync, ctx: ProjectToolContext, body: Record<string, unknown>): ProjectToolResult {
  return projectToolTransaction(db, ctx, body, projectToolCriteriaImpl);
}

export function projectToolDone(db: DatabaseSync, ctx: ProjectToolContext, body: Record<string, unknown>): ProjectToolResult {
  return projectToolTransaction(db, ctx, body, projectToolDoneImpl);
}

export function projectToolBlocked(db: DatabaseSync, ctx: ProjectToolContext, body: Record<string, unknown>): ProjectToolResult {
  return projectToolTransaction(db, ctx, body, projectToolBlockedImpl);
}

export function projectToolBriefUpdate(db: DatabaseSync, ctx: ProjectToolContext, body: Record<string, unknown>): ProjectToolResult {
  return projectToolTransaction(db, ctx, body, projectToolBriefUpdateImpl);
}
