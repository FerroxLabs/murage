// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The apply side of the goal control envelope v2 (SPEC-P 9). Lane E1 parses
// `<murage-goal>{...}</murage-goal>` out of the lead's own current turn and
// calls `applyGoalEnvelopeV2` with the parsed object; this module validates
// the shape strictly (unknown fields are refused) and applies the effect on
// rows through the card and goal transitions. The same functions back the
// internal tools (11.3).
import type { DatabaseSync } from "node:sqlite";

import {
  acceptProjectCard,
  assignCardReview,
  createProjectCard,
  type CardFailure,
  type ProjectActor,
} from "./project-cards.ts";
import {
  applyGoalPlanAccepted,
  markCriterionMet,
  pauseProjectGoal,
  proposeProjectCriteria,
  requestGoalSignoff,
} from "./project-goals.ts";
import { projectCardById, projectCardsForGroup, projectGoalById, projectSettingsFor, insertRoomRequest, roomRequestById, inheritedRequestLineage } from "./project-records.ts";
import { isProjectCapabilityTag } from "./project-capabilities.ts";
import { partitionSourcesAllowed } from "./partition-sources.ts";
import { shownName } from "./project-prompt.ts";
import { roomRequest, type RoomRequest } from "./room-requests.ts";

export interface GoalEnvelopeContext {
  groupId: string;
  goalId: string;
  /** The lead's bot id, proven by the caller from the turn's request. */
  leadBotId: string;
  /** The lead turn's request id: idempotency keys ride on it (5.1). */
  leadRequestId: string;
  memberIds: string[];
  /** Current members' names by id, for refusals the lead and the room read
   * (never a raw bot id there). */
  memberNames?: ReadonlyMap<string, string>;
  /** Server-bound source messages of the current request/turn, not envelope fields. */
  sourceMessageIds?: string[];
  /** Current capabilities supplied by the server roster (lane M). Missing means none. */
  memberCapabilities?: ReadonlyMap<string, ReadonlySet<string>>;
  now: number;
  /** The group's room thread id, for `check` and `file` evidence bounds. */
  roomThreadId?: string;
  /** Is the lineage root still the owner's audience, recomputed now like the
   * dispatcher does (index.ts roomRequestStillOwnerAudience)? Absent, the
   * root's stored audience is taken. */
  rootAudienceStillOwner?: (root: RoomRequest) => boolean;
}

export type EnvelopeOutcome =
  | { ok: true; status: "assign"; cards: Array<{ key: string; cardId: string; requestId: string | null }> }
  | { ok: true; status: "review" | "accept" | "criteria" | "done" | "blocked" }
  | { ok: false; status: "assign"; refused: Array<{ key: string; reason: string; ownerCardNumber?: number }> }
  | { ok: false; status: string; reason: string; blockers?: string[] };

const fail = (status: string, reason: string, blockers?: string[]): EnvelopeOutcome => ({ ok: false, status, reason, ...(blockers ? { blockers } : {}) });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,160}$/.test(value);

function unknownKeys(value: Record<string, unknown>, allowed: string[]): string | null {
  return Object.keys(value).find(key => !allowed.includes(key)) ?? null;
}

interface EnvelopeCard {
  key: string;
  assignee: string;
  title: string;
  description?: string;
  touches?: string[];
  dependsOn?: string[];
  needs?: string[];
  writes?: boolean;
  workRoot?: number;
}

function checkEnvelopeCard(raw: unknown, index: number): { ok: true; card: EnvelopeCard } | { ok: false; reason: string } {
  if (!isObject(raw)) return { ok: false, reason: `card ${index + 1} is not an object` };
  const badKey = unknownKeys(raw, ["key", "assignee", "title", "description", "touches", "dependsOn", "needs", "writes", "workRoot"]);
  if (badKey) return { ok: false, reason: `unknown field ${badKey}` };
  if (typeof raw.key !== "string" || raw.key.length < 1 || raw.key.length > 40) return { ok: false, reason: "key is 1 to 40 characters" };
  if (typeof raw.assignee !== "string" || raw.assignee.length < 1) return { ok: false, reason: "assignee is required" };
  if (typeof raw.title !== "string" || raw.title.trim().length < 1 || raw.title.length > 120) return { ok: false, reason: "title is 1 to 120 characters" };
  if (raw.description !== undefined && (typeof raw.description !== "string" || raw.description.length > 2000)) return { ok: false, reason: "description is at most 2000 characters" };
  if (raw.touches !== undefined && (!Array.isArray(raw.touches) || raw.touches.length > 10 || raw.touches.some(item => typeof item !== "string" || item.length > 512))) return { ok: false, reason: "touches is at most 10 short strings" };
  if (raw.dependsOn !== undefined && (!Array.isArray(raw.dependsOn) || raw.dependsOn.length > 10 || raw.dependsOn.some(item => typeof item !== "string"))) return { ok: false, reason: "dependsOn is at most 10 keys or card ids" };
  if (raw.needs !== undefined && (!Array.isArray(raw.needs) || raw.needs.length > 8 || raw.needs.some(item => typeof item !== "string" || !isProjectCapabilityTag(item)))) return { ok: false, reason: "needs is at most 8 capability tags the roster knows" };
  if (raw.writes !== undefined && typeof raw.writes !== "boolean") return { ok: false, reason: "writes is a boolean" };
  if (raw.workRoot !== undefined && (!Number.isInteger(raw.workRoot) || (raw.workRoot as number) < 0)) return { ok: false, reason: "workRoot is a work folder index" };
  return { ok: true, card: raw as unknown as EnvelopeCard };
}

/** Joining words: they never tell one card's work from another's. */
const TITLE_JOINERS = new Set(["a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "with"]);
/** The verbs and nouns a lead wraps the same work in ("research and define
 * ...", "gather exact ... details", "... document"): fillers only where they
 * wrap it, at the start of the title or after "and" (round 13); at the end
 * only TITLE_END_FILLER ("Competitor pricing research" is research, round
 * 14); elsewhere they are part of the work. */
const TITLE_FILLER = new Set(["document", "doc", "research", "define", "gather", "exact", "details"]);
const TITLE_END_FILLER = new Set(["details", "document"]);
const titleTokens = (title: string) => title.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
function titleWords(title: string): Set<string> {
  const tokens = titleTokens(title);
  let start = 0, end = tokens.length;
  while (start < end && (TITLE_FILLER.has(tokens[start]!) || TITLE_JOINERS.has(tokens[start]!))) start += 1;
  while (end > start && (TITLE_END_FILLER.has(tokens[end - 1]!) || TITLE_JOINERS.has(tokens[end - 1]!))) end -= 1;
  return new Set(tokens.filter((word, index) => !TITLE_JOINERS.has(word)
    && !(TITLE_FILLER.has(word) && (index < start || index >= end || tokens[index - 1] === "and"))));
}

/** Two card titles name the same work: their words (fillers out, case and
 * punctuation ignored) are nearly the same set, Jaccard 0.8 or more. A
 * follow-on card ("Write the FAQ intro" after "Write the FAQ") adds work,
 * so it is new (round 12: containment refused it). With fewer than 2 words
 * left on either side only the same title matches (round 13: "Research
 * pricing" and "Pricing document" are not the same work). */
export function sameCardTitle(a: string, b: string): boolean {
  const [left, right] = [titleWords(a), titleWords(b)];
  if (left.size < 2 || right.size < 2) return titleTokens(a).length > 0 && titleTokens(a).join(" ") === titleTokens(b).join(" ");
  const shared = [...left].filter(word => right.has(word)).length;
  return shared / (left.size + right.size - shared) >= 0.8;
}

/** assign: validate every card first; any failure refuses the whole
 * envelope. On success the cards and their `assign` requests are created in
 * the caller's transaction, with dependsOn keys mapped to the new ids. */
function applyAssign(db: DatabaseSync, ctx: GoalEnvelopeContext, envelope: Record<string, unknown>): EnvelopeOutcome {
  if (!Array.isArray(envelope.cards) || envelope.cards.length < 1 || envelope.cards.length > 12) {
    return fail("assign", "an assign plan is 1 to 12 cards");
  }
  const settings = projectSettingsFor(db, ctx.groupId);
  if (!settings) return fail("assign", "not a project");
  const parent = roomRequestById(db, ctx.leadRequestId);
  if (!parent || parent.group_id !== ctx.groupId || parent.to_bot_id !== ctx.leadBotId || parent.state !== "running") {
    return fail("assign", "This assignment is not bound to the current lead request.");
  }
  const parsed: EnvelopeCard[] = [];
  const refused: Array<{ key: string; reason: string; ownerCardNumber?: number }> = [];
  const keys = new Set<string>();
  const openCards = projectCardsForGroup(db, ctx.groupId);
  const openById = new Map(openCards.filter(card => card.archivedAt === null).map(card => [card.id, card]));
  for (const [index, raw] of envelope.cards.entries()) {
    const checked = checkEnvelopeCard(raw, index);
    const label = isObject(raw) && typeof raw.key === "string" ? raw.key : `card ${index + 1}`;
    if (!checked.ok) { refused.push({ key: label, reason: checked.reason }); continue; }
    const card = checked.card;
    if (keys.has(card.key)) { refused.push({ key: card.key, reason: "a duplicate key" }); continue; }
    keys.add(card.key);
    if (!ctx.memberIds.includes(card.assignee)) { refused.push({ key: card.key, reason: `${card.assignee} is not a member of this project` }); continue; }
    const missing = (card.needs ?? []).filter(tag => !ctx.memberCapabilities?.get(card.assignee)?.has(tag));
    if (missing.length) { refused.push({ key: card.key, reason: `${card.assignee} lacks needed capabilities: ${missing.join(", ")}` }); continue; }
    if (card.workRoot !== undefined && card.workRoot >= settings.workRoots.length) {
      refused.push({ key: card.key, reason: "workRoot does not name a work folder of this project" });
      continue;
    }
    parsed.push(card);
  }
  // Resolve replay keys to stored identities before constructing the graph.
  // Their supplied dependencies are ignored: a repeated key is a no-op.
  const replay = new Map<string, { cardId: string; requestId: string }>();
  const identities = new Map<string, string>();
  for (const card of parsed) {
    const row = db.prepare("SELECT work_item_id, id FROM room_requests WHERE admission_key=?").get(`assign:${ctx.leadRequestId}:${card.key}`);
    const existing = row?.work_item_id ? projectCardById(db, String(row.work_item_id)) : null;
    if (existing && existing.groupId === ctx.groupId) replay.set(card.key, { cardId: existing.id, requestId: String(row!.id) });
    identities.set(card.key, existing?.id ?? `new:${card.key}`);
  }
  const resolve = (key: string): string => identities.get(key) ?? key;
  const edges = new Map<string, string[]>();
  for (const card of openCards) edges.set(card.id, card.dependsOn);
  for (const card of parsed) {
    if (replay.has(card.key)) continue;
    edges.set(resolve(card.key), (card.dependsOn ?? []).map(resolve));
    for (const dependency of card.dependsOn ?? []) {
      if (!keys.has(dependency) && !openById.has(dependency)) {
        refused.push({ key: card.key, reason: `depends on ${dependency}, which is neither in this plan nor an open card` });
      }
    }
  }
  // Cycle walk over key/id space.
  const cyclic = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (edges.get(from) ?? []).some(next => cyclic(next, target, seen));
  };
  for (const card of parsed) {
    if (replay.has(card.key)) continue;
    for (const dependency of card.dependsOn ?? []) {
      if (cyclic(resolve(dependency), resolve(card.key))) {
        refused.push({ key: card.key, reason: `depends on ${dependency} in a cycle` });
        break;
      }
    }
  }
  // A new card that repeats an open card of the same assignee on this goal
  // is refused, naming that card by number and id and its assignee by name
  // (AFTER-PF finiteCards: the lead's plan repeated the owner's three
  // running cards, one per member). A card whose title the lead may not
  // read is never matched, so its title cannot be probed: a stale one (it
  // cites something the owner removed) or one citing another team's thread
  // (the lead's partition, as on the board layer; round 13). Archived cards
  // are not open work (projectCardsForGroup leaves them out).
  const leadThread = String(parent.target_thread_id ?? ctx.roomThreadId ?? "");
  const goalOpen = openCards.filter(card => card.goalId === ctx.goalId && card.archivedAt === null && card.assigneeBotId && card.state !== "done" && card.state !== "cancelled"
    && !card.stale && partitionSourcesAllowed(db, ctx.leadBotId, leadThread, card.sourceMessageIds));
  // Lane cards (a): the owner's open cards are the work to assign. A new
  // card with the title of one is refused whoever it is for (the owner's card
  // may be unassigned, have no goal, or be another member's), naming the
  // card so the lead assigns that one. Archived, stale and unreadable cards
  // are not matched, as above.
  const ownerOpen = openCards.filter(card => card.createdBy === "owner" && card.archivedAt === null && card.state !== "done" && card.state !== "cancelled"
    && (card.goalId === ctx.goalId || card.goalId === null) && !card.stale && partitionSourcesAllowed(db, ctx.leadBotId, leadThread, card.sourceMessageIds));
  for (const card of parsed) {
    if (replay.has(card.key)) continue;
    if (goalOpen.some(open => open.assigneeBotId === card.assignee && sameCardTitle(open.title, card.title))) continue; // the same-assignee refusal below
    const owner = ownerOpen.find(open => sameCardTitle(open.title, card.title));
    if (!owner) continue;
    // one short plain line for the lead (it reaches the owner's room too, cut
    // at 300 characters, so it carries no tool name): the card, its id, the action
    const which = `Owner card ${owner.number} (card_id ${JSON.stringify(owner.id)}) already covers this.`;
    const heldByMember = owner.assigneeBotId && owner.assigneeBotId !== ctx.leadBotId;
    refused.push({ key: card.key, ownerCardNumber: owner.number, reason: heldByMember
      ? `${which} It is with ${ctx.memberNames?.get(owner.assigneeBotId!) ? shownName(ctx.memberNames.get(owner.assigneeBotId!)!) : "a member"}: leave it, make no new card.`
      : `${which} Reassign it to ${card.assignee === ctx.leadBotId ? "yourself" : `assignee_bot_id ${JSON.stringify(card.assignee)}`}, make no new card.` });
  }
  for (const card of parsed) {
    if (replay.has(card.key) || refused.some(entry => entry.key === card.key)) continue;
    const same = goalOpen.find(open => open.assigneeBotId === card.assignee && sameCardTitle(open.title, card.title));
    if (!same) continue;
    const name = ctx.memberNames?.get(card.assignee);
    refused.push({ key: card.key, reason: `${name ? shownName(name) : "That member"} already has card ${same.number} ${JSON.stringify(same.title)} (card_id ${JSON.stringify(same.id)}) on this goal. Use that card instead of making a new one.` });
  }
  if (refused.length > 0) return { ok: false, status: "assign", refused };

  const keyToCardId = new Map<string, string>();
  const created: Array<{ key: string; cardId: string; requestId: string | null }> = [];
  const ownerControl = projectRequestOwnerControl(db, ctx.leadRequestId, ctx.rootAudienceStillOwner);
  // Idempotency (5.1): a request row keyed `assign:<leadRequestId>:<key>`
  // already exists means this envelope (or a retry of it) made the card.
  for (const card of parsed) {
    const admissionKey = `assign:${ctx.leadRequestId}:${card.key}`;
    const existing = replay.get(card.key);
    if (existing) {
      keyToCardId.set(card.key, existing.cardId);
      created.push({ key: card.key, ...existing });
      continue;
    }
    const made = createProjectCard(db, {
      groupId: ctx.groupId, title: card.title, description: card.description, assigneeBotId: card.assignee,
      goalId: ctx.goalId, writes: card.writes, workRoot: card.workRoot ?? null,
      needs: card.needs, touches: card.touches, createdBy: ctx.leadBotId, sourceMessageIds: ctx.sourceMessageIds,
      ownerControlLineage: ownerControl, actor: { kind: "lead", botId: ctx.leadBotId }, memberIds: ctx.memberIds, now: ctx.now,
    });
    if (!made.ok) {
      refused.push({ key: card.key, reason: made.ok === false ? made.reason : "refused" });
      continue;
    }
    keyToCardId.set(card.key, made.card.id);
    const requestId = insertRoomRequest(db, {
      ...inheritedRequestLineage(parent), returnBotId: ctx.leadBotId,
      groupId: ctx.groupId, verb: "assign", fromKind: "bot", fromBotId: ctx.leadBotId,
      toBotId: card.assignee, workItemId: made.card.id, projectGoalId: ctx.goalId,
      cardGeneration: made.card.generation + 1, attempt: made.card.attempt, admissionKey, now: ctx.now,
    });
    created.push({ key: card.key, cardId: made.card.id, requestId });
  }
  if (refused.length > 0) return { ok: false, status: "assign", refused };
  // Map dependsOn keys to the new card ids, in the same transaction.
  for (const card of parsed) {
    if (replay.has(card.key) || !card.dependsOn?.length) continue;
    const ids = card.dependsOn.map(dependency => keyToCardId.get(dependency) ?? dependency);
    db.prepare("UPDATE project_work_items SET depends_on=? WHERE id=?").run(JSON.stringify(ids), keyToCardId.get(card.key) ?? null);
  }
  // The first accepted plan in planning moves the goal (5.3).
  const goal = projectGoalById(db, ctx.goalId);
  if (goal?.state === "planning") applyGoalPlanAccepted(db, { goalId: goal.id, now: ctx.now });
  return { ok: true, status: "assign", cards: created };
}

/** Apply an already-parsed envelope v2 object to the rows. The shape is
 * validated strictly; `v` must be 2 and unknown top-level or card fields are
 * refused. */
function applyGoalEnvelopeV2Rows(db: DatabaseSync, ctx: GoalEnvelopeContext, envelope: unknown): EnvelopeOutcome {
  if (!isObject(envelope)) return fail("unknown", "the envelope is not an object");
  if (envelope.v !== 2) return fail("unknown", "v must be 2");
  const status = envelope.status;
  if (typeof status !== "string" || !["assign", "review", "accept", "criteria", "done", "blocked"].includes(status)) {
    return fail("unknown", "unknown status");
  }
  const goal = projectGoalById(db, ctx.goalId);
  if (!goal || goal.groupId !== ctx.groupId) return fail(status, "no such goal in this project");
  const settings = projectSettingsFor(db, ctx.groupId);
  if (!settings || settings.endedAt !== null || settings.closedAt !== null || settings.runState === "paused") return fail(status, "This project is paused or closed.");
  if (settings.leadBotId !== ctx.leadBotId || !ctx.memberIds.includes(ctx.leadBotId)) return fail(status, "Only the current lead can do this.");
  if (!["planning", "working", "awaiting_signoff"].includes(goal.state)) return fail(status, "This goal is not running.");
  const actor: ProjectActor = { kind: "lead", botId: ctx.leadBotId };

  switch (status) {
    case "assign": {
      const badKey = unknownKeys(envelope, ["v", "status", "cards"]);
      if (badKey) return fail(status, `unknown field ${badKey}`);
      return applyAssign(db, ctx, envelope);
    }
    case "review": {
      const badKey = unknownKeys(envelope, ["v", "status", "card", "reviewer"]);
      if (badKey) return fail(status, `unknown field ${badKey}`);
      if (!isId(envelope.card) || typeof envelope.reviewer !== "string") return fail(status, "card and reviewer are required");
      if (projectCardById(db, envelope.card)?.groupId !== ctx.groupId) return fail(status, "No such card in this project.");
      const assigned = assignCardReview(db, { cardId: envelope.card, reviewerBotId: envelope.reviewer, leadBotId: ctx.leadBotId, memberIds: ctx.memberIds, now: ctx.now });
      return assigned.ok ? { ok: true, status } : fail(status, (assigned as CardFailure).reason);
    }
    case "accept": {
      const badKey = unknownKeys(envelope, ["v", "status", "card"]);
      if (badKey) return fail(status, `unknown field ${badKey}`);
      if (!isId(envelope.card)) return fail(status, "card is required");
      if (projectCardById(db, envelope.card)?.groupId !== ctx.groupId) return fail(status, "No such card in this project.");
      const accepted = acceptProjectCard(db, { cardId: envelope.card, actor, now: ctx.now });
      return accepted.ok ? { ok: true, status } : fail(status, accepted.reason);
    }
    case "criteria": {
      const badKey = unknownKeys(envelope, ["v", "status", "propose", "met"]);
      if (badKey) return fail(status, `unknown field ${badKey}`);
      if (envelope.propose !== undefined && envelope.met !== undefined) return fail(status, "Give propose or met, not both.");
      if (envelope.propose !== undefined) {
        if (!Array.isArray(envelope.propose) || envelope.propose.some(text => typeof text !== "string")) return fail(status, "propose is a list of criterion texts");
        const proposed = proposeProjectCriteria(db, { goalId: ctx.goalId, texts: envelope.propose, now: ctx.now });
        return proposed.ok ? { ok: true, status } : fail(status, proposed.ok === false ? proposed.reason : "refused");
      }
      if (envelope.met !== undefined) {
        if (!Array.isArray(envelope.met)) return fail(status, "met is a list");
        for (const entry of envelope.met) {
          if (!isObject(entry) || unknownKeys(entry, ["id", "evidence"]) || typeof entry.id !== "string" || !isObject(entry.evidence)
            || unknownKeys(entry.evidence as Record<string, unknown>, ["kind", "ref"])
            || !["message", "file", "check"].includes(String((entry.evidence as Record<string, unknown>).kind))
            || typeof (entry.evidence as Record<string, unknown>).ref !== "string") {
            return fail(status, "a met entry is { id, evidence: { kind, ref } }");
          }
          const evidence = entry.evidence as { kind: "message" | "file" | "check"; ref: string };
          const marked = markCriterionMet(db, { goalId: ctx.goalId, criterionId: entry.id, evidence, actor, now: ctx.now, roomThreadId: ctx.roomThreadId });
          if (!marked.ok) return fail(status, marked.ok === false ? marked.reason : "refused");
        }
        return { ok: true, status };
      }
      return fail(status, "propose or met is required");
    }
    case "done": {
      const badKey = unknownKeys(envelope, ["v", "status", "detail"]);
      if (badKey) return fail(status, `unknown field ${badKey}`);
      if (envelope.detail !== undefined && (typeof envelope.detail !== "string" || envelope.detail.length > 500)) return fail(status, "detail is at most 500 characters");
      const signoff = requestGoalSignoff(db, { goalId: ctx.goalId, actor, roomThreadId: ctx.roomThreadId, detail: typeof envelope.detail === "string" ? envelope.detail : undefined, now: ctx.now });
      return signoff.ok ? { ok: true, status } : fail(status, signoff.ok === false ? signoff.reason : "refused", "blockers" in signoff ? signoff.blockers : undefined);
    }
    case "blocked": {
      const badKey = unknownKeys(envelope, ["v", "status", "detail"]);
      if (badKey) return fail(status, `unknown field ${badKey}`);
      if (typeof envelope.detail !== "string" || envelope.detail.trim().length < 1 || envelope.detail.length > 500) return fail(status, "detail is 1 to 500 characters");
      const paused = pauseProjectGoal(db, { goalId: ctx.goalId, reason: envelope.detail.trim(), actor: { kind: "server" }, now: ctx.now });
      return paused.ok ? { ok: true, status } : fail(status, paused.ok === false ? paused.reason : "refused");
    }
    default:
      return fail(status, "unknown status");
  }
}

/** Atomic even when called directly or inside an existing transaction. */
export function applyGoalEnvelopeV2(db: DatabaseSync, ctx: GoalEnvelopeContext, envelope: unknown): EnvelopeOutcome {
  db.exec("SAVEPOINT project_envelope");
  try {
    const result = applyGoalEnvelopeV2Rows(db, ctx, envelope);
    if (!result.ok) db.exec("ROLLBACK TO project_envelope");
    db.exec("RELEASE project_envelope");
    return result;
  } catch (error) {
    db.exec("ROLLBACK TO project_envelope; RELEASE project_envelope");
    throw error;
  }
}

export function applyGoalEnvelopeAssign(db: DatabaseSync, ctx: GoalEnvelopeContext, payload: Record<string, unknown>): EnvelopeOutcome {
  return applyGoalEnvelopeV2(db, ctx, { ...payload, v: 2, status: "assign" });
}

export function applyGoalEnvelopeReview(db: DatabaseSync, ctx: GoalEnvelopeContext, payload: Record<string, unknown>): EnvelopeOutcome {
  return applyGoalEnvelopeV2(db, ctx, { ...payload, v: 2, status: "review" });
}

export function applyGoalEnvelopeAccept(db: DatabaseSync, ctx: GoalEnvelopeContext, payload: Record<string, unknown>): EnvelopeOutcome {
  return applyGoalEnvelopeV2(db, ctx, { ...payload, v: 2, status: "accept" });
}

export function applyGoalEnvelopeCriteria(db: DatabaseSync, ctx: GoalEnvelopeContext, payload: Record<string, unknown>): EnvelopeOutcome {
  return applyGoalEnvelopeV2(db, ctx, { ...payload, v: 2, status: "criteria" });
}

export function applyGoalEnvelopeDone(db: DatabaseSync, ctx: GoalEnvelopeContext, payload: Record<string, unknown>): EnvelopeOutcome {
  return applyGoalEnvelopeV2(db, ctx, { ...payload, v: 2, status: "done" });
}

export function applyGoalEnvelopeBlocked(db: DatabaseSync, ctx: GoalEnvelopeContext, payload: Record<string, unknown>): EnvelopeOutcome {
  return applyGoalEnvelopeV2(db, ctx, { ...payload, v: 2, status: "blocked" });
}

/** PF deviation (SPEC-P 3.3, 15.3): a lead card needs source messages, and
 * a lineage the owner started with a control rather than a message has none.
 * The r7 real-engine run: the goal Start wake carries no message, so every
 * card of the lead's first plan was refused and no goal started from the
 * goal controls could ever be planned. Such a lineage is its own authority:
 * its root is the owner's goal Start or Change wake, or the owner's own
 * redirect wake, from the app or the paired phone, attended, still the
 * owner's audience now (`rootStillOwner`), and every hop on it is the
 * owner's audience and the owner's, Murage's, or the lead's own (its
 * handovers and asks and the wakes that bring their results back); another
 * member's ask or handover to the lead is not. A card made on it keeps the
 * lineage's sources when there are any, else none: nothing it came from is
 * a message, so there is nothing to forget (a forgotten room message marks
 * such a card stale instead, project-tables.ts markProjectDerivedStale). An
 * owner card's run binds what the lead read of it: the card's sources and
 * its result (projectRequestSourceMessages). Only a bare owner card (the
 * owner made it on the board, no sources, and a run that wrote no answer,
 * returned to nobody or to the current lead) has none at all: the owner's
 * own card is then the authority, like a goal Start wake. */
export function projectRequestOwnerControl(db: DatabaseSync, requestId: string, rootStillOwner?: (root: RoomRequest) => boolean): boolean {
  const seen = new Set<string>();
  let id: string | null = requestId;
  let root: Record<string, unknown> | null = null;
  let lead: unknown = null;
  while (id && !seen.has(id) && seen.size < 100) {
    seen.add(id);
    const request = roomRequestById(db, id);
    if (!request || request.not_owner_audience) return false;
    // the lead turn's own request names the lead; a bot hop must be its own
    if (seen.size === 1) lead = request.to_bot_id;
    if (request.from_kind === "bot" ? !lead || request.from_bot_id !== lead : request.from_kind !== "owner" && request.from_kind !== "murage") return false;
    root = request;
    id = typeof request.parent_id === "string" ? request.parent_id : null;
  }
  if (!root || id) return false;
  if (!["desktop", "companion"].includes(String(root.origin)) || root.unattended) return false;
  const goalControl = root.verb === "wake" && root.from_kind === "murage" && /^wake:goal-(?:start|change):/.test(String(root.admission_key));
  const ownerControl = root.from_kind === "owner" && root.verb === "wake";
  // an owner card run while the room has a lead is returned to that lead
  // (project-card-executor.ts); a card a routine or Murage made is not the
  // owner's own control
  const bareOwnerCard = root.from_kind === "owner" && root.verb === "assign" && typeof root.work_item_id === "string"
    && (!root.return_bot_id || root.return_bot_id === lead) && projectCardById(db, root.work_item_id)?.createdBy === "owner"
    && projectRequestSourceMessages(db, requestId).length === 0;
  if (!goalControl && !ownerControl && !bareOwnerCard) return false;
  const current = rootStillOwner ? roomRequest(db, String(root.id)) : null;
  return !rootStillOwner || (current !== null && rootStillOwner(current));
}

/** Source provenance comes from the bound request lineage, never tool arguments. */
export function projectRequestSourceMessages(db: DatabaseSync, requestId: string): string[] {
  const sources = new Set<string>(), results = new Set<string>(), seen = new Set<string>();
  let id: string | null = requestId;
  while (id && !seen.has(id) && seen.size < 100) {
    seen.add(id);
    const request = roomRequestById(db, id);
    if (!request || request.not_owner_audience) break;
    if (typeof request.source_message_id === "string") sources.add(request.source_message_id);
    const card = request.work_item_id ? projectCardById(db, String(request.work_item_id)) : null;
    for (const source of card?.sourceMessageIds ?? []) sources.add(source);
    // an owner card's run: what the lead reads is that card's result
    if (card && request.verb === "assign" && request.from_kind === "owner") {
      for (const result of [request.result_message_id, card.resultMessageId]) if (typeof result === "string" && result) { sources.add(result); results.add(result); }
    }
    id = typeof request.parent_id === "string" ? request.parent_id : null;
  }
  // at most 50, and the results always among them: room is kept for them
  let room = 50 - [...sources].filter(source => results.has(source)).length;
  return [...sources].filter(source => results.has(source) || room-- > 0).slice(0, 50);
}
