import { partitionSourcesAllowed } from "./partition-sources.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Internal project tools: routing and authorisation (SPEC-P 11.3 [AMB-3],
// lane E1). Every tool is `POST /api/internal/project/<name>` under the
// existing `agents` capability kind (no new token in the bot's MCP
// environment). What a call may do is decided at the call, from current
// server state, never from the turn's start or anything the model sent:
//  - the turn's request must be running (not terminal, not superseded), in a
//    project that is open and not paused (except `card-update` with
//    `blocked`, and `read-messages`, which a paused project still answers);
//  - the turn must be the owner's audience, recomputed now;
//  - the caller's role comes from the rows now: the lead is
//    `project_settings.lead_bot_id`, an assignee is the card's assignee with
//    the request's card generation still current, a reviewer is the bot the
//    card's current review request went to, a member is in the group now.
// So a lead change takes effect at once, and each role refuses the other.
// The tools' effects are lanes R and M's functions (R's in project-tools.ts),
// registered here by name.
import { createHash } from "node:crypto";
import { applyGoalEnvelopeAssign, projectRequestSourceMessages } from "./project-envelope.ts";
import { activeProjectGoal, projectCardById, projectSettingsFor } from "./project-records.ts";
import { applyProjectChangeWithInterrupt, type ProjectInterrupt } from "./project-routes.ts";
import { assignCardReview } from "./project-cards.ts";
import type { DatabaseSync } from "node:sqlite";
import { projectTableExists } from "./project-turn-engine.ts";
import { roomRequest, type RoomRequest } from "./room-requests.ts";
import {
  projectToolAccept, projectToolBlocked, projectToolBriefUpdate, projectToolCardManage, projectToolCriteria, projectToolDone,
  type ProjectToolContext, type ProjectToolResult,
} from "./project-tools.ts";

export type ProjectToolRole = "lead" | "assignee" | "reviewer" | "member";

/** SPEC-P 11.3: which role each tool needs. */
export const PROJECT_TOOL_ROLES: Readonly<Record<string, ProjectToolRole>> = Object.freeze({
  assign: "lead",
  "review-assign": "lead",
  accept: "lead",
  "card-manage": "lead",
  "brief-update": "lead",
  "summary-update": "lead",
  criteria: "lead",
  done: "lead",
  blocked: "lead",
  "card-update": "assignee",
  "bring-in": "member",
  suggest: "member",
  "review-result": "reviewer",
  "read-messages": "member",
});

export interface ProjectToolCall {
  name: string;
  botId: string;
  request: RoomRequest | null;
  body: Record<string, unknown>;
  /** The group's current members (groups.json). */
  memberIds: readonly string[];
  /** The turn is the owner's audience, recomputed now (6.1). */
  ownerAudience: boolean;
}

export type ProjectToolRefusal = { ok: false; status: 400 | 403 | 404 | 409; body: { error: string; reason?: string } };

const NOT_HERE = "Project tools are not available in this conversation.";

/** Who may make this call now, or the refusal. */
export function authorizeProjectTool(db: DatabaseSync, call: ProjectToolCall): { ok: true; groupId: string; role: ProjectToolRole } | ProjectToolRefusal {
  const role = PROJECT_TOOL_ROLES[call.name];
  if (!role) return { ok: false, status: 404, body: { error: "no such project tool" } };
  const request = call.request;
  if (!call.ownerAudience || !request || request.notOwnerAudience) return { ok: false, status: 403, body: { error: NOT_HERE } };
  const consuming = request.targetThreadId ?? request.rootThreadId;
  const inherited = projectRequestSourceMessages(db, request.id);
  if (!partitionSourcesAllowed(db, call.botId, consuming, inherited)) return { ok: false, status: 403, body: { error: "Those sources belong to another team." } };
  if (request.state !== "running" && request.state !== "waiting_owner") return { ok: false, status: 403, body: { error: "This turn has ended." } };
  if (!projectTableExists(db, "project_settings")) return { ok: false, status: 403, body: { error: NOT_HERE } };
  const settings = db.prepare("SELECT * FROM project_settings WHERE group_id=? AND ended_at IS NULL").get(request.groupId) as Record<string, unknown> | undefined;
  if (!settings) return { ok: false, status: 403, body: { error: NOT_HERE } };
  if (!call.memberIds.includes(call.botId)) return { ok: false, status: 403, body: { error: "You are not a member of this project." } };
  const pausedStillAnswers = call.name === "read-messages" || (call.name === "card-update" && call.body.blocked !== undefined);
  if (!pausedStillAnswers) {
    if (settings.closed_at !== null && settings.closed_at !== undefined) return { ok: false, status: 409, body: { error: "not_allowed", reason: "This project is closed." } };
    if (settings.run_state === "paused") return { ok: false, status: 409, body: { error: "not_allowed", reason: "The project is paused." } };
  }
  if (role === "lead" && settings.lead_bot_id !== call.botId) return { ok: false, status: 403, body: { error: "Only the project lead can do that." } };
  // any tool from a run its card has moved past is refused (SPEC-P 5.1 fencing)
  if (request.workItemId && request.cardGeneration !== null && projectTableExists(db, "project_work_items")) {
    const own = db.prepare("SELECT number, generation FROM project_work_items WHERE id=?").get(request.workItemId) as { number: number; generation: number } | undefined;
    if (own && Number(own.generation) !== request.cardGeneration) return { ok: false, status: 403, body: { error: `You are no longer on card ${own.number}.` } };
  }
  if (role === "assignee" || role === "reviewer") {
    const cardId = typeof call.body.cardId === "string" ? call.body.cardId : "";
    if (!cardId || !projectTableExists(db, "project_work_items")) return { ok: false, status: 400, body: { error: "cardId required" } };
    const card = db.prepare("SELECT id, number, group_id, assignee_bot_id, generation, review_request_id FROM project_work_items WHERE id=?").get(cardId) as
      { id: string; number: number; group_id: string; assignee_bot_id: string | null; generation: number; review_request_id: string | null } | undefined;
    if (!card || card.group_id !== request.groupId) return { ok: false, status: 404, body: { error: "no such card in this project" } };
    if (role === "assignee") {
      const current = card.assignee_bot_id === call.botId && request.workItemId === card.id && request.cardGeneration === Number(card.generation);
      if (!current) return { ok: false, status: 403, body: { error: `You are no longer on card ${card.number}.` } };
    } else {
      const review = card.review_request_id ? db.prepare("SELECT to_bot_id, card_generation FROM room_requests WHERE id=?").get(card.review_request_id) as { to_bot_id: string; card_generation: number } | undefined : undefined;
      let reviewRun = request;
      for (let depth = 0; reviewRun.verb === "wake" && reviewRun.parentId && depth < 20; depth++) {
        const parent = roomRequest(db, reviewRun.parentId);
        if (!parent || parent.workItemId !== request.workItemId || parent.cardGeneration !== request.cardGeneration) break;
        reviewRun = parent;
      }
      const current = review?.to_bot_id === call.botId && card.review_request_id === reviewRun.id && Number(review.card_generation) === Number(card.generation);
      if (!current) return { ok: false, status: 403, body: { error: `You are not reviewing card ${card.number} now.` } };
    }
  }
  return { ok: true, groupId: request.groupId, role };
}

export interface ProjectToolCallContext {
  db: DatabaseSync;
  groupId: string;
  botId: string;
  role: ProjectToolRole;
  request: RoomRequest;
  /** The group's current members and the owner-audience answer, both read at the call. */
  memberIds: readonly string[];
  /** Current members' display names by id, read at the call (a name is
   * taken where a member's bot id is expected, below). */
  memberNames?: ReadonlyMap<string, string>;
  /** Every known bot's id: a ref that is one is never read as a name. */
  botIds?: ReadonlySet<string>;
  ownerAudience: boolean;
  /** Is the turn's lineage root still the owner's audience, recomputed at
   * the call (project-envelope.ts projectRequestOwnerControl). */
  rootAudienceStillOwner?: (root: RoomRequest) => boolean;
  now: number;
  projectThreadIds?: readonly string[];
}

/** PF deviation (SPEC-P 9 and 11.3 say `assignee: botId`, `reviewer:
 * botId`): a member's exact display name, case-insensitive and unique among
 * the project's current members, is taken for that member's id. The
 * AFTER-PF lead passed "Reed" and every plan was refused. Only current
 * members with a bot record (a name) are matched, so a name reaches nobody
 * the id could not; a bot id (trimmed, in any case) always means that bot,
 * so a member named like another bot's id never takes work sent to that id; a blank
 * ref, or anything else, is left as sent and refused as before. */
export function projectMemberRef(call: Pick<ProjectToolCallContext, "memberIds" | "memberNames" | "botIds">, ref: unknown): unknown {
  const resolved = projectMemberRefResolved(call, ref);
  return resolved.ok ? resolved.ref : ref;
}

/** projectMemberRef, or the one line that refuses a name two members share. */
function projectMemberRefResolved(call: Pick<ProjectToolCallContext, "memberIds" | "memberNames" | "botIds">, ref: unknown): { ok: true; ref: unknown } | { ok: false; error: string } {
  if (typeof ref !== "string" || !ref.trim() || call.memberIds.includes(ref) || call.botIds?.has(ref) || !call.memberNames) return { ok: true, ref };
  const wanted = ref.trim().toLocaleLowerCase();
  // a bot id with stray spaces or in another case is that id, never a name:
  // a member's id is taken as it, any other bot's is left to be refused
  const member = call.memberIds.find(id => id.toLocaleLowerCase() === wanted);
  if (member) return { ok: true, ref: member };
  if ([...(call.botIds ?? [])].some(id => id.toLocaleLowerCase() === wanted)) return { ok: true, ref };
  const matches = call.memberIds.filter(id => {
    const name = call.memberNames!.get(id)?.trim().toLocaleLowerCase();
    return Boolean(name) && name === wanted;
  });
  if (matches.length > 1) return { ok: false, error: "That name belongs to more than one member. Use their bot id." };
  return { ok: true, ref: matches.length === 1 ? matches[0] : ref };
}

const ASSIGN_CARD_FIELDS = ["key", "assignee", "title", "description", "touches", "dependsOn", "needs", "writes", "workRoot"];
export const PROJECT_ASSIGN_USAGE = "project_assign takes cards: [{ key, assignee (a bot id from list_bots or a member's name), title, description }].";

/** project_assign's input as the envelope takes it, or the one line that
 * says what it takes. PF deviation (SPEC-P 11.3 body is the envelope's
 * `cards`): one card sent without the list is taken as a plan of that one
 * card, keyed by the whole card (every field, the assignee resolved), so a
 * retry of it stays one card and a different card is never taken for it. */
function projectAssignInput(call: Pick<ProjectToolCallContext, "memberIds" | "memberNames" | "botIds">, body: Record<string, unknown>): { ok: true; payload: { cards: unknown[] } } | { ok: false; error: string } {
  const unknown: string[] = [];
  const note = (keys: string[]) => { for (const key of keys) if (!unknown.includes(key)) unknown.push(key); };
  const refuse = (extra = "") => ({ ok: false as const, error: `${PROJECT_ASSIGN_USAGE}${unknown.length ? ` Unknown fields: ${unknown.join(", ")}.` : ""}${extra}` });
  let cards: unknown[];
  if ("cards" in body) {
    note(Object.keys(body).filter(key => key !== "cards"));
    if (!Array.isArray(body.cards)) return refuse();
    cards = body.cards;
  } else {
    note(Object.keys(body).filter(key => !ASSIGN_CARD_FIELDS.includes(key)));
    if (unknown.length) return refuse();
    const missing = ["assignee", "title"].filter(key => typeof body[key] !== "string" || !(body[key] as string).trim());
    if (missing.length) return refuse(` Missing: ${missing.join(", ")}.`);
    cards = [body];
  }
  for (const card of cards) if (card && typeof card === "object" && !Array.isArray(card)) note(Object.keys(card).filter(key => !ASSIGN_CARD_FIELDS.includes(key)));
  if (unknown.length) return refuse();
  const resolved: unknown[] = [];
  for (const card of cards) {
    if (!card || typeof card !== "object" || Array.isArray(card)) { resolved.push(card); continue; }
    const entry = card as Record<string, unknown>;
    const assignee = projectMemberRefResolved(call, entry.assignee);
    if (!assignee.ok) return { ok: false, error: assignee.error };
    const key = "cards" in body ? entry.key : entry.key ?? `card-${createHash("sha256").update(canonicalCard({ ...entry, assignee: assignee.ref })).digest("hex").slice(0, 12)}`;
    resolved.push({ ...entry, assignee: assignee.ref, ...(key !== undefined ? { key } : {}) });
  }
  return { ok: true, payload: { cards: resolved } };
}

/** One card's fields but its key, in a fixed order, for its shorthand key. */
function canonicalCard(card: Record<string, unknown>): string {
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])])) : value;
  const { key: _key, ...fields } = card;
  return JSON.stringify(sorted(fields));
}
export type ProjectToolHandler = (context: ProjectToolCallContext, body: Record<string, unknown>) => { status: number; body: unknown };

/** Lanes R and M register each tool's effect by name (SPEC-P 16). */
export const projectToolHandlers = new Map<string, ProjectToolHandler>();

/** Lane R's row effects (server/project-tools.ts), which gate the call again
 * on their own terms (the bound request running, the goal not paused). */
const laneR: Record<string, (db: DatabaseSync, ctx: ProjectToolContext, body: Record<string, unknown>) => ProjectToolResult> = {
  accept: projectToolAccept,
  "card-manage": projectToolCardManage,
  criteria: projectToolCriteria,
  done: projectToolDone,
  blocked: projectToolBlocked,
  "brief-update": projectToolBriefUpdate,
};
for (const [name, effect] of Object.entries(laneR)) {
  projectToolHandlers.set(name, (call, body) => effect(call.db, {
    groupId: call.groupId,
    ownerAudience: call.ownerAudience,
    botId: call.botId,
    requestId: call.request.id,
    ...(call.request.cardGeneration !== null ? { cardGeneration: call.request.cardGeneration } : {}),
    memberIds: [...call.memberIds],
    now: call.now,
    projectThreadIds: call.projectThreadIds,
    roomThreadId: call.request.targetThreadId ?? call.request.rootThreadId,
  }, body));
}

/** The request each turn's internal capability is bound to, by the turn's
 * generation (SPEC-P 6.1: `{ requestId, cardGeneration, turnGeneration }`).
 * Room turns register here; lane E2a registers card and review runs. */
export const turnRequestByGeneration = new Map<string, string>();

projectToolHandlers.set("assign", (call, body) => {
  const allowed = authorizeProjectTool(call.db, { name: "assign", ...call, body });
  if (!allowed.ok) return { status: allowed.status, body: allowed.body };
  const goal = activeProjectGoal(call.db, call.groupId);
  if (!goal) return { status: 409, body: { error: "There is no running goal." } };
  const input = projectAssignInput(call, body);
  if (!input.ok) return { status: 400, body: { error: input.error } };
  const result = applyGoalEnvelopeAssign(call.db, { groupId: call.groupId, goalId: goal.id, leadBotId: call.botId,
    leadRequestId: call.request.id, memberIds: [...call.memberIds], sourceMessageIds: projectRequestSourceMessages(call.db, call.request.id),
    now: call.now, roomThreadId: call.request.rootThreadId, ...(call.memberNames ? { memberNames: call.memberNames } : {}),
    ...(call.rootAudienceStillOwner ? { rootAudienceStillOwner: call.rootAudienceStillOwner } : {}) }, input.payload);
  return { status: result.ok ? 200 : 409, body: result };
});
projectToolHandlers.set("review-assign", (call, sent) => {
  const allowed = authorizeProjectTool(call.db, { name: "review-assign", ...call, body: sent });
  if (!allowed.ok) return { status: allowed.status, body: allowed.body };
  const reviewer = "reviewer" in sent ? projectMemberRefResolved(call, sent.reviewer) : null;
  if (reviewer && !reviewer.ok) return { status: 400, body: { error: reviewer.error } };
  const body = reviewer ? { ...sent, reviewer: reviewer.ref } : sent;
  if (Object.keys(body).some(key => !["cardId", "reviewer"].includes(key)) || typeof body.cardId !== "string" || typeof body.reviewer !== "string") {
    return { status: 400, body: { error: "cardId and reviewer are required." } };
  }
  if (projectCardById(call.db, body.cardId)?.groupId !== call.groupId) return { status: 404, body: { error: "No such card in this project." } };
  call.db.exec("SAVEPOINT project_review_assign");
  try {
    const result = assignCardReview(call.db, { cardId: body.cardId, reviewerBotId: body.reviewer, leadBotId: call.botId, memberIds: [...call.memberIds], now: call.now });
    call.db.exec("RELEASE project_review_assign");
    return { status: result.ok ? 200 : 409, body: result };
  } catch (error) {
    call.db.exec("ROLLBACK TO project_review_assign; RELEASE project_review_assign");
    throw error;
  }
});

export function projectToolRoleForTurn(db: DatabaseSync, group: { id: string; channelProject?: unknown; dm?: unknown; memberIds: readonly string[] }, botId: string, ownerAudience: boolean): "lead" | "member" | undefined {
  if (!ownerAudience || !group.channelProject || group.dm || !group.memberIds.includes(botId)) return undefined;
  const settings = projectTableExists(db, "project_settings") ? projectSettingsFor(db, group.id) : null;
  if (!settings || settings.endedAt !== null) return undefined;
  return settings.leadBotId === botId ? "lead" : "member";
}

/** Use the same preview/interrupt/apply boundary as owner card actions. */
export async function handleProjectToolWithInterrupt(name: string, call: ProjectToolCallContext, sent: Record<string, unknown>,
  interrupt: ProjectInterrupt): Promise<{ status: number; body: unknown }> {
  // a member's name where a new assignee or a suggested member is expected
  const field = name === "card-manage" && "assigneeBotId" in sent ? "assigneeBotId" : name === "suggest" && "botId" in sent ? "botId" : null;
  const member = field ? projectMemberRefResolved(call, sent[field]) : null;
  const authorize = (body: Record<string, unknown>) => authorizeProjectTool(call.db, { name, ...call, request: roomRequest(call.db, call.request.id), body });
  // a caller who may not use the tool hears that, not that its name is shared
  if (member && !member.ok) {
    const allowed = authorize(sent);
    return allowed.ok ? { status: 400, body: { error: member.error } } : { status: allowed.status, body: allowed.body };
  }
  const body = field && member ? { ...sent, [field]: member.ref } : sent;
  const apply = () => {
    const allowed = authorize(body);
    if (!allowed.ok) return { status: allowed.status, body: allowed.body };
    const handler = projectToolHandlers.get(name);
    return handler ? handler(call, body) : { status: 404, body: { error: "This project tool is not available yet." } };
  };
  const stopping = name === "card-manage" && ["cancel", "reassign", "send_back"].includes(String(body.action));
  if (!stopping) return apply();
  const card = typeof body.cardId === "string" ? projectCardById(call.db, body.cardId) : null;
  const review = card?.state === "review" && card.reviewRequestId ? roomRequest(call.db, card.reviewRequestId) : null;
  const liveReview = review && ["running", "waiting_owner"].includes(review.state)
    ? { id: card!.id, requestId: review.id, assigneeBotId: review.toBotId, deskThreadId: review.targetThreadId } : null;
  return applyProjectChangeWithInterrupt(call.db, apply, interrupt, {
    stopping, liveCard: liveReview ?? (card?.groupId === call.groupId && card.requestId && ["doing", "waiting"].includes(card.state) ? card : null),
    roomThreadId: call.request.rootThreadId,
  });
}
