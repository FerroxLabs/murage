// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The turn engine's reading of project rows (lane E1). Lane R owns the
// project tables and every row transition (one function per transition);
// E1 owns WHEN they are triggered. This module is E1's side only:
//  - the arbiter's ProjectContext for a room request (SPEC-P 7.1), resolved
//    from the rows and the feature flags, never from anything a model wrote;
//  - generation fencing (5.1): is a run's card generation still current;
//  - the stop rules after each lead wake in goal mode (plan 3.2, SPEC-P 5.3):
//    progress, three wakes without it, loop checks, the replan limit. These
//    are server checks, not model judgement; the counters live in the rows
//    so they survive a restart.
// Every read first checks the table exists: an install (or an archive) from
// before the projects release has none of them, and then every room is a
// channel.
import type { DatabaseSync } from "node:sqlite";
import { groupGoalAssignmentKey } from "./group-goal-run.ts";
import { partitionSourcesAllowed } from "./partition-sources.ts";
import { acceptProjectCard, changesRequestedCount, changesRequestedNotes, CHANGES_BEFORE_LEAD_DECIDES, applyCardRunFailed, applyCardRunFinished, applyCardWaiting, assignCardReview, NO_VERDICT, pickCardReviewer } from "./project-cards.ts";
import { projectCardById, projectGoalById, projectSettingsFor } from "./project-records.ts";
import { roomCardName, type LeadNextStep } from "./project-prompt.ts";
import { isTerminalRoomRequestState, queueReviewWake, roomRequest, roomRequestByKey, type RoomRequest } from "./room-requests.ts";
import type { ProjectContext, ProjectGoalState } from "./work-admission.ts";
import type { GoalOpenCard, GoalOpenCards } from "./project-prompt.ts";

/** Stall counting is suspended while a card works with activity this recent. */
export const STALL_SUSPEND_MS = 15 * 60_000;
/** Lead wakes in a row without progress before the goal pauses. */
export const NO_PROGRESS_LIMIT = 3;
/** The same assignment given this many times is a loop. */
export const SAME_ASSIGNMENT_LIMIT = 3;
/** The same card failing this many times is a loop. */
export const SAME_CARD_FAILURES_LIMIT = 3;
/** Replans allowed per goal; the next one needs the owner. */
export const REPLAN_LIMIT = 2;
/** How the owner goes on after a pause: nothing resumes a goal by itself.
 * The goal's own Resume (its sheet on the board, or Overview) is the one
 * that works for a paused goal; the strip's Resume is the project's. */
const RESUME_LINE = "Open the goal and press Resume.";
/** The goal keeps this much of a pause reason (project_goals.state_reason). */
const PAUSE_LINE_MAX = 200;
/** How many open cards the lead's wakes list. */
const OPEN_CARDS_LISTED = 30;

/** A pause line within what the goal keeps: its variable parts (titles,
 * names) are cut shorter until the whole line fits, so the way to go on at
 * its end always survives. `cut(text, most)` gives at most `most` chars. */
function fitPauseLine(build: (cut: (text: string, most: number) => string) => string): string {
  for (let max = 80; ; max -= 1) {
    const line = build((text, most) => text.slice(0, Math.min(most, max)).trim());
    if (line.length <= PAUSE_LINE_MAX || max <= 0) return line;
  }
}

const ACTIVE_GOAL_STATES = ["planning", "awaiting_plan_ok", "working", "awaiting_signoff", "paused"];

export function projectTableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
}

/** The bot and thread a lead's wake runs in: a card's title reaches it
 * only when the card's sources belong to that thread's partition (a lead
 * that is a shared specialist, round 13), as on the board layer. */
export interface LeadViewer { botId: string; threadId: string }

/** May this lead's turn read a card's title? Not a stale card's (it cites a
 * message the owner forgot), nor one citing another team's thread. */
export function cardTitleVisible(db: DatabaseSync, card: { stale: boolean; sourceMessageIds: readonly string[] }, viewer: LeadViewer): boolean {
  // no bot to read as: closed, never open (an unknown bot has no partition, round 14)
  if (!viewer.botId) return false;
  return !card.stale && partitionSourcesAllowed(db, viewer.botId, viewer.threadId, card.sourceMessageIds);
}

const sourceIds = (json: string | null): string[] => {
  try { const ids = JSON.parse(json ?? "[]") as unknown; return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []; } catch { return []; }
};

/** The goal's open cards, by number, for the lead's wakes (round 11: the
 * lead planned new cards that repeated the owner's running ones), with the
 * card id the tools take. A card whose title the lead may not read
 * (cardTitleVisible) keeps its number, id, assignee and state, never its
 * title, as on the board layer. The first 30, and how many more there are. */
export function goalOpenCards(db: DatabaseSync, goalId: string, botName: (botId: string) => string, viewer: LeadViewer): GoalOpenCards {
  if (!projectTableExists(db, "project_work_items")) return { cards: [], more: 0 };
  // lane cards: the OWNER's cards on the project board with no goal of their
  // own are the project's work too (not routine or other server cards) (AFTER-PF: the lead duplicated them)
  const open = "FROM project_work_items WHERE (goal_id=? OR (goal_id IS NULL AND created_by='owner' AND group_id=(SELECT group_id FROM project_goals WHERE id=?))) AND archived_at IS NULL AND state NOT IN ('done','cancelled')";
  const rows = db.prepare(`SELECT id, number, title, assignee_bot_id, state, stale, source_message_ids ${open} ORDER BY number LIMIT ?`).all(goalId, goalId, OPEN_CARDS_LISTED) as Array<{ id: string; number: number; title: string; assignee_bot_id: string | null; state: GoalOpenCard["state"]; stale: number; source_message_ids: string | null }>;
  const total = rows.length < OPEN_CARDS_LISTED ? rows.length : Number((db.prepare(`SELECT count(*) AS n ${open}`).get(goalId, goalId) as { n: number }).n);
  return {
    cards: rows.map((row) => {
      const shown = cardTitleVisible(db, { stale: Boolean(row.stale), sourceMessageIds: sourceIds(row.source_message_ids) }, viewer);
      return { id: row.id, number: Number(row.number), title: shown ? row.title : null, assignee: row.assignee_bot_id ? botName(row.assignee_bot_id) : null, state: row.state, ...(row.stale ? { stale: true as const } : {}) };
    }),
    more: total - rows.length,
  };
}

export interface ProjectFlagsForContext {
  lead: boolean;
  board: boolean;
  goals: boolean;
  parallelCards: boolean;
}

/** SPEC-P 7.1: the arbiter's view of a room. A group with no open settings
 * row is a channel. Flags fold in here and write no row (SPEC-P 14): lead
 * off reads as no lead, board off as no board, goals off as a paused goal. */
export function projectContextFor(
  db: DatabaseSync,
  input: { groupId: string; goalId?: string | null; flags: ProjectFlagsForContext; deskArchived?: boolean },
): ProjectContext {
  const channel: ProjectContext = { groupId: input.groupId, isProject: false, closed: false, runState: "running", mode: "conversation", boardOn: false, parallelCards: 1 };
  if (!projectTableExists(db, "project_settings")) return channel;
  const settings = db.prepare("SELECT * FROM project_settings WHERE group_id=? AND ended_at IS NULL").get(input.groupId) as Record<string, unknown> | undefined;
  if (!settings) return channel;
  let parts: Record<string, unknown> = {};
  try { parts = JSON.parse(String(settings.parts ?? "{}")) as Record<string, unknown>; } catch { parts = {}; }
  const context: ProjectContext = {
    groupId: input.groupId,
    isProject: true,
    closed: settings.closed_at !== null && settings.closed_at !== undefined,
    runState: settings.run_state === "paused" ? "paused" : "running",
    mode: settings.mode === "ongoing" ? "ongoing" : "conversation",
    leadBotId: input.flags.lead ? (settings.lead_bot_id as string | null) ?? null : null,
    boardOn: input.flags.board && parts.board !== false,
    parallelCards: input.flags.parallelCards ? Math.max(1, Math.min(5, Number(settings.parallel_cards ?? 1))) : 1,
    ...(input.deskArchived ? { deskArchived: true } : {}),
  };
  if (!projectTableExists(db, "project_goals")) return context;
  const goal = (input.goalId
    ? db.prepare("SELECT id, state FROM project_goals WHERE id=? AND group_id=?").get(input.goalId, input.groupId)
    : db.prepare(`SELECT id, state FROM project_goals WHERE group_id=? AND state IN (${ACTIVE_GOAL_STATES.map(() => "?").join(",")}) LIMIT 1`).get(input.groupId, ...ACTIVE_GOAL_STATES)) as { id: string; state: ProjectGoalState } | undefined;
  if (!goal) return context;
  const active = ACTIVE_GOAL_STATES.includes(goal.state);
  return { ...context, goalId: goal.id, goalState: active && !input.flags.goals ? "paused" : goal.state };
}

/** Generation fencing (SPEC-P 5.1): a run's completion moves its card and
 * wakes anyone only while its card generation is still the card's. Without
 * the card table (or the card) nothing is fenced. */
export function cardGenerationCurrent(db: DatabaseSync, request: RoomRequest): boolean {
  if (!request.workItemId || request.cardGeneration === null) return true;
  if (!projectTableExists(db, "project_work_items")) return true;
  const card = db.prepare("SELECT generation FROM project_work_items WHERE id=?").get(request.workItemId) as { generation: number } | undefined;
  return !card || Number(card.generation) === request.cardGeneration;
}

/** Lane R's 5.1 card effect of a finished card run (SPEC-P 5.2: the one
 * completion primitive triggers it, generation-fenced, in its transaction).
 * A review's verdict is its own tool call (5.1a); a review's completion only
 * wakes the lead. */
export function applyCardRunEffect(db: DatabaseSync, request: RoomRequest, input: { memberIds: readonly string[]; now: number }): void {
  if (request.workItemId && request.verb === "review" && request.state !== "unknown") { applyReviewRunEffect(db, request, input.memberIds, input.now); return; }
  if (!request.workItemId || (request.verb !== "assign" && request.state !== "unknown")) return;
  const card = projectCardById(db, request.workItemId);
  if (!card) return;
  const actor = { kind: "server" as const };
  if (request.state === "done") {
    const goal = card.goalId ? projectGoalById(db, card.goalId) : null;
    // goal mode with the goal's review on, someone other than the assignee to
    // review it, and not a card the owner took over (5.1 doing -> review)
    const reviewApplies = Boolean(goal?.review) && !card.ownerTookOver && input.memberIds.some((id) => id !== card.assigneeBotId);
    const finished = applyCardRunFinished(db, { cardId: card.id, requestId: request.id, ...(request.resultMessageId ? { resultMessageId: request.resultMessageId } : {}), reviewApplies, now: input.now, actor });
    // Lane review: the server names the reviewer as the card enters review
    // (AFTER-PF F1: the lead never called project_review_assign, and every
    // goal run ended with its cards in review). The lead still hears the
    // result and who reviews it; the verdict comes back to the lead.
    if (finished.ok && !finished.superseded && finished.card.state === "review" && !finished.card.reviewRequestId) {
      const picked = pickCardReviewer(db, finished.card, input.memberIds);
      if (picked) assignCardReview(db, { cardId: card.id, reviewerBotId: picked.reviewerBotId, leadBotId: picked.leadBotId, memberIds: [...input.memberIds], now: input.now });
    }
    return;
  }
  // a run a restart cut off waits for the owner's Retry step or Skip (5.6)
  if (request.state === "unknown") {
    applyCardWaiting(db, { cardId: card.id, requestId: request.id, actor, waiting: { kind: "restart" }, reason: "This step stopped at a restart", now: input.now });
    return;
  }
  applyCardRunFailed(db, { cardId: card.id, requestId: request.id, reason: request.outcomeNote ?? "the run did not finish", interrupted: request.state !== "failed", now: input.now, actor });
}

/** A review run's end (lane review). A `pass` for the card's current
 * generation moves it to done (the lead is still woken with the verdict, to
 * record the criteria). Anything else leaves the card in review for the
 * lead: `changes` to send back, a run that finished with no verdict at all
 * ("No verdict given", completeRequest) to decide on, and a run that did not
 * finish to have reviewed again. The result goes to whoever leads now, when
 * the lead changed during the review and the new one is a member. Called
 * generation-fenced from the completion primitive, once per review. */
function applyReviewRunEffect(db: DatabaseSync, request: RoomRequest, memberIds: readonly string[], now: number): void {
  const card = projectCardById(db, request.workItemId!);
  if (!card || card.state !== "review" || card.reviewRequestId !== request.id || card.generation !== request.cardGeneration) return;
  const lead = projectSettingsFor(db, card.groupId)?.leadBotId;
  if (lead && lead !== request.returnBotId && request.returnBotId && memberIds.includes(lead)) {
    db.prepare("UPDATE room_requests SET return_bot_id=? WHERE id=?").run(lead, request.id);
  }
  if (request.state === "done" && request.outcomeNote === "pass") acceptProjectCard(db, { cardId: card.id, actor: { kind: "server" }, now });
}

/** Goal states in which the lead moves cards on (its wakes are admitted). */
const LEAD_STEP_GOAL_STATES = ["working", "awaiting_signoff"];

/** The card this request ran or reviewed, when it waits in review for the
 * lead: current generation, of a goal the lead is running (or, for a wake
 * queued now, of a paused goal: the arbiter holds that wake until resume). */
function cardInReview(db: DatabaseSync, request: RoomRequest, goalStates: readonly string[] = LEAD_STEP_GOAL_STATES) {
  if (!request.workItemId || !projectTableExists(db, "project_work_items")) return null;
  const card = projectCardById(db, request.workItemId);
  if (!card || card.state !== "review" || card.generation !== request.cardGeneration || !card.goalId) return null;
  const goal = projectGoalById(db, card.goalId);
  return goal && goalStates.includes(goal.state) ? { card, goal } : null;
}

/** An owner card's run (nobody handed it over, so nobody is returned to)
 * that put its card in review in goal mode wakes the current lead in the
 * room: the lead assigns the review and records the criteria. A paused goal
 * still gets the wake; it waits (project_paused) and runs on resume. With no
 * lead nobody is woken here; queueHeldReviewWakes queues it once there is. */
export function reviewWakeTarget(db: DatabaseSync, request: RoomRequest, input: { memberIds: readonly string[]; roomThreadId: string | null }): { botId: string; threadId: string } | null {
  if (request.verb !== "assign" || request.state !== "done" || request.returnBotId || !input.roomThreadId) return null;
  if (!cardInReview(db, request, [...LEAD_STEP_GOAL_STATES, "paused"])) return null;
  const lead = projectSettingsFor(db, request.groupId)?.leadBotId;
  return lead && input.memberIds.includes(lead) ? { botId: lead, threadId: input.roomThreadId } : null;
}

/** An owner card whose run put it in review while the room had no lead
 * (the lead removed, so the goal paused) woke nobody, and neither does
 * setting a lead or resuming by itself: the card would sit in review. When a
 * lead is set or the goal resumes, each such run of the project whose card
 * still waits in review at its generation, with no review assigned for it at
 * that generation and never told to a lead, queues its review wake for the
 * current lead (held by the arbiter while the goal is paused). A lead was
 * told of a run by any wake that carried it (by key or among the results it
 * took in) and is still open or was delivered; a wake that ended before it
 * was delivered (cancelled while its lead was away) told nobody, so the run
 * is queued again under a fresh key (`wake:review:<run>:held:<n>`), the base
 * key being taken. Returns the wakes queued. */
export function queueHeldReviewWakes(db: DatabaseSync, input: { groupId: string; memberIds: readonly string[]; roomThreadId: string | null; now: number }): RoomRequest[] {
  if (!input.roomThreadId || !projectTableExists(db, "project_work_items") || !projectTableExists(db, "room_requests")) return [];
  const runs = db.prepare(`SELECT r.id FROM room_requests r JOIN project_work_items w ON w.id=r.work_item_id
    WHERE r.group_id=? AND r.verb='assign' AND r.state='done' AND r.return_bot_id IS NULL AND w.state='review' AND w.generation=r.card_generation
      AND w.review_request_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM room_requests v WHERE v.verb='review' AND v.work_item_id=w.id AND v.card_generation=w.generation)
    ORDER BY r.finished_at, r.id`).all(input.groupId) as Array<{ id: string }>;
  // lane review: every card that reached review with no reviewer (no lead
  // then) gets one now, whoever assigned it; only owner cards also wake the lead
  const unreviewed = db.prepare(`SELECT DISTINCT w.id FROM room_requests r JOIN project_work_items w ON w.id=r.work_item_id
    WHERE r.group_id=? AND r.verb='assign' AND r.state='done' AND w.state='review' AND w.generation=r.card_generation AND w.review_request_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM room_requests v WHERE v.verb='review' AND v.work_item_id=w.id AND v.card_generation=w.generation)`).all(input.groupId) as Array<{ id: string }>;
  for (const { id } of unreviewed) {
    const card = projectCardById(db, id);
    const picked = card?.goalId && [...LEAD_STEP_GOAL_STATES, "paused"].includes(projectGoalById(db, card.goalId)?.state ?? "") ? pickCardReviewer(db, card, input.memberIds) : null;
    if (card && picked) assignCardReview(db, { cardId: card.id, reviewerBotId: picked.reviewerBotId, leadBotId: picked.leadBotId, memberIds: [...input.memberIds], now: input.now });
  }
  const wakes: RoomRequest[] = [];
  for (const { id } of runs) {
    const run = roomRequest(db, id);
    const target = run ? reviewWakeTarget(db, run, input) : null;
    if (!run || !target) continue;
    const carried = `(admission_key=? OR admission_key LIKE ? OR payload_text LIKE ?)`;
    const carriedBy = [`wake:review:${run.id}`, `wake:review:${run.id}:%`, `%"requestId":${JSON.stringify(run.id)}%`];
    const told = db.prepare(`SELECT 1 FROM room_requests WHERE group_id=? AND verb='wake' AND ${carried}
      AND (state NOT IN ('done','failed','cancelled','expired','unknown') OR dispatched_at IS NOT NULL) LIMIT 1`).get(input.groupId, ...carriedBy);
    if (told) continue;
    const held = Number((db.prepare("SELECT count(*) AS n FROM room_requests WHERE admission_key LIKE ?").get(`wake:review:${run.id}:held:%`) as { n: number }).n);
    const key = roomRequestByKey(db, `wake:review:${run.id}`) ? `wake:review:${run.id}:held:${held + 1}` : undefined;
    const wake = queueReviewWake(db, run, { toBotId: target.botId, threadId: target.threadId, now: input.now, ...(key ? { key } : {}) });
    if (wake) wakes.push(wake);
  }
  return wakes;
}

/** What the lead does next with the card a result came from: have it
 * reviewed after its run, accept it after a pass, send it back after
 * changes, and have it reviewed again after a review run that ended without
 * a verdict (failed, cancelled, expired, stopped). Nothing once the card has
 * moved on, or for a review that is no longer the card's current one. */
export function leadNextStep(db: DatabaseSync, source: RoomRequest, input: { memberIds: readonly string[]; name: (botId: string) => string; viewer: LeadViewer }): LeadNextStep | undefined {
  if (source.verb !== "assign" && source.verb !== "review") return undefined;
  // lane review: a pass the server accepted, for the card's current review
  const passed = source.verb === "review" && source.outcomeNote === "pass" && source.workItemId ? projectCardById(db, source.workItemId) : null;
  const found = passed?.state === "done" && passed.reviewRequestId === source.id && passed.generation === source.cardGeneration && passed.goalId
    ? (() => { const goal = projectGoalById(db, passed.goalId!); return goal && LEAD_STEP_GOAL_STATES.includes(goal.state) ? { card: passed, goal } : null; })()
    : cardInReview(db, source);
  if (!found) return undefined;
  const { card, goal } = found;
  if (source.verb === "review" && card.reviewRequestId !== source.id) return undefined;
  const base = {
    // a card whose title the lead may not read is named by number and id
    card: { id: card.id, number: card.number, title: cardTitleVisible(db, card, input.viewer) ? card.title : null, ...(card.stale ? { stale: true as const } : {}) },
    ...(card.resultMessageId ? { resultMessageId: card.resultMessageId } : {}),
    criteria: goal.criteria.filter(criterion => !criterion.met).map(criterion => ({ id: criterion.id, text: criterion.text })),
  };
  const reviewers = () => input.memberIds.filter(id => id !== card.assigneeBotId).map(id => ({ id, name: input.name(id) }));
  if (source.verb === "review") {
    if (card.state === "done") return { step: "accepted", ...base };
    if (source.outcomeNote === "pass") return { step: "accept", ...base };
    if (source.outcomeNote === "changes") {
      // lane cards (b): asked twice already, so the lead decides: accept, or reassign with a reason
      const reviewNotes = changesRequestedNotes(db, card.id);
      return { step: changesRequestedCount(db, card.id) >= CHANGES_BEFORE_LEAD_DECIDES ? "decide_changes" : "send_back", ...base, ...(reviewNotes ? { reviewNotes } : {}), reviewers: reviewers() };
    }
    // lane review: it finished without giving a verdict, and the lead decides
    if (source.state === "done" && source.outcomeNote === NO_VERDICT) return { step: "decide", ...base, ...(source.toBotId ? { reviewer: input.name(source.toBotId) } : {}), reviewers: reviewers() };
    // it did not finish (failed, stopped, cancelled, expired): review it again
    return { step: "review", ...base, reviewers: reviewers() };
  }
  // the card's run: its review, when one is assigned, says what comes next
  const review = card.reviewRequestId ? roomRequest(db, card.reviewRequestId) : null;
  if (review && review.cardGeneration === card.generation) {
    if (isTerminalRoomRequestState(review.state)) return undefined;
    return { step: "reviewing", ...base, ...(review.toBotId ? { reviewer: input.name(review.toBotId) } : {}) };
  }
  return { step: "review", ...base, reviewers: reviewers() };
}

interface Hop { id: string; verb: string; key: string; workItemId: string | null; text: string | null }
interface HopWork { workItemId: string | null; texts: string[]; question: boolean }
/** Text shorter than this names no work of its own ("ok", "done"). */
const SAME_WORK_MIN_CHARS = 8;
/** Lowercased words only, so punctuation and spacing do not make work differ. */
function sameWorkText(text: string | null | undefined): string {
  return (text ?? "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
/**
 * Two hops carry the same work (SPEC-P 5.3 loop checks, "the same
 * assignment") when they run the same card, or when one's text is the
 * other's: equal, or one holding the other where the held text is at least
 * two thirds of it ("Write LAUNCH-PLAN.md please" hands back the card
 * "Write LAUNCH-PLAN.md"). A hop asking a question ("Has Cole finished?",
 * "Want me to write the FAQ?") is asking, not handing work back, so only
 * equal text counts for it. Rewordings are missed on purpose: a paused goal
 * is the costly mistake, and three wakes without progress, the same
 * assignment three times and the same card failing three times still stop
 * real loops.
 */
export function sameWork(x: HopWork, y: HopWork): boolean {
  if (x.workItemId && x.workItemId === y.workItemId) return true;
  const asking = x.question || y.question;
  return x.texts.some((one) => y.texts.some((other) => {
    const [short, long] = one.length <= other.length ? [one, other] : [other, one];
    return short === long || (!asking && ` ${long} `.includes(` ${short} `) && short.length * 3 >= long.length * 2);
  }));
}

export interface LeadWakeVerdict {
  progressed: boolean;
  /** When set, the goal pauses with this line (the caller applies R's
   * pauseProjectGoal and posts it). */
  pause?: string;
  noProgress: number;
}

interface GoalRow { id: string; group_id: string; state: string; criteria: string; no_progress: number; replans: number; lead_wakes: number }

/**
 * After each lead wake in goal mode (plan 3.2, SPEC-P 5.3). Progress is
 * advancement toward unmet done criteria since the previous lead wake: a card
 * of the goal reaching review or done, a criterion marked met, an owner
 * reply. Anything else (cards moved back and forth, reassignments, new cards
 * without results, notes) is not. Three wakes in a row without progress pause
 * the goal, unless a card is working with recent activity. The loop checks and
 * the replan limit pause it too. Counters are rows: a restart keeps them.
 */
export function recordLeadWake(
  db: DatabaseSync,
  input: {
    goalId: string;
    since: number;
    now: number;
    /** The lead's envelope could not be read: a wake without progress. */
    unreadable?: boolean;
    /** Activity (milestone, tool use, a registered file) on a working card since then. */
    cardActive?: (card: { id: string; desk_thread_id: string | null }, since: number) => boolean;
    botName?: (botId: string) => string;
  },
): LeadWakeVerdict {
  const goal = db.prepare("SELECT id, group_id, state, criteria, no_progress, replans, lead_wakes FROM project_goals WHERE id=?").get(input.goalId) as GoalRow | undefined;
  if (!goal) return { progressed: false, noProgress: 0 };
  const name = (id: string) => input.botName?.(id) ?? "A teammate";
  // the line reaches the room and the goal strip: a stale card by its number only (round 14)
  const titled = (card: { number: number; title: string; stale: number }, cut: (text: string, most: number) => string, most: number) =>
    card.stale ? roomCardName({ number: Number(card.number), title: card.title, stale: true }) : `"${cut(card.title, most)}"`;
  const cards = projectTableExists(db, "project_work_items")
    ? db.prepare("SELECT id, number, title, stale, state, assignee_bot_id, failures, created_at, updated_at, done_at, desk_thread_id FROM project_work_items WHERE goal_id=? ORDER BY number").all(goal.id) as Array<{ id: string; number: number; title: string; stale: number; state: string; assignee_bot_id: string | null; failures: number; created_at: number; updated_at: number; done_at: number | null; desk_thread_id: string | null }>
    : [];
  let criteria: Array<{ met?: boolean; evidence?: { at?: number } }> = [];
  try { criteria = JSON.parse(goal.criteria) as typeof criteria; } catch { criteria = []; }
  // A card advanced when it MOVED into review or done in this window (the
  // activity log, lane R: an owner or lead move is `card_moved`, a finished
  // run is `card_result`), not when a card already there was edited. Without
  // the log, only a card finished in the window counts.
  // Only the FIRST such move in the card's current attempt counts: bouncing
  // between review and done, or back into review, is not new progress. An
  // attempt starts at the card's latest move back to To do.
  const goalCards = new Set(cards.map((card) => card.id));
  const cardAdvanced = projectTableExists(db, "project_activity")
    ? (db.prepare(`SELECT a.work_item_id AS id FROM project_activity a WHERE a.group_id=? AND a.at > ? AND a.kind IN ('card_moved','card_result')
        AND json_extract(a.detail,'$.to') IN ('review','done') AND a.work_item_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM project_activity b WHERE b.work_item_id=a.work_item_id AND b.kind IN ('card_moved','card_result')
          AND json_extract(b.detail,'$.to') IN ('review','done') AND b.at < a.at
          AND b.at > COALESCE((SELECT MAX(c.at) FROM project_activity c WHERE c.work_item_id=a.work_item_id AND c.kind='card_moved'
            AND json_extract(c.detail,'$.to')='todo' AND c.at < a.at), 0))`).all(goal.group_id, input.since) as Array<{ id: string }>)
      .some((row) => goalCards.has(row.id))
    : cards.some((card) => card.state === "done" && Number(card.done_at ?? 0) > input.since);
  const criterionMet = criteria.some((criterion) => criterion.met === true && Number(criterion.evidence?.at ?? 0) > input.since);
  const ownerReplied = Boolean(db.prepare("SELECT 1 FROM room_requests WHERE group_id=? AND verb='owner_send' AND state='done' AND finished_at > ? LIMIT 1").get(goal.group_id, input.since));
  const progressed = !input.unreadable && (cardAdvanced || criterionMet || ownerReplied);
  // a working card with real activity (milestone, tool use, a file) lately
  const suspended = !progressed && cards.some((card) => card.state === "doing" && Boolean(input.cardActive?.(card, input.now - STALL_SUSPEND_MS)));
  const noProgress = progressed ? 0 : suspended ? Number(goal.no_progress) : Number(goal.no_progress) + 1;
  db.prepare("UPDATE project_goals SET lead_wakes=lead_wakes+1, no_progress=? WHERE id=?").run(noProgress, goal.id);

  // Loop checks (SPEC-P 5.3), each caught in the wake window it happens in,
  // so a goal the owner resumes is not paused again for the same thing: the
  // same assignment a third time, the same card failing a third time, a
  // request cycle A to B to A in one root, a third replan.
  // A threshold counts when it is reached in this window (before it, the
  // count was under the limit), however far past the limit it went.
  const assignments = new Map<string, { count: number; before: number; card: (typeof cards)[number] }>();
  for (const card of cards) {
    if (!card.assignee_bot_id) continue;
    const key = groupGoalAssignmentKey(card.assignee_bot_id, card.title);
    const seen = assignments.get(key) ?? { count: 0, before: 0, card };
    seen.count += 1;
    if (Number(card.created_at) <= input.since) seen.before += 1;
    // named by the latest card, or by a stale one when any is stale
    if (!seen.card.stale || card.stale) seen.card = card;
    assignments.set(key, seen);
  }
  const repeated = [...assignments.values()].find((entry) => entry.count >= SAME_ASSIGNMENT_LIMIT && entry.before < SAME_ASSIGNMENT_LIMIT);
  if (repeated) return { progressed, noProgress, pause: fitPauseLine((cut) => `Paused: ${titled(repeated.card, cut, 80)} was assigned ${SAME_ASSIGNMENT_LIMIT} times without finishing. ${RESUME_LINE}`) };
  // a card that FAILED in this window (the activity log), not one edited later
  const failedNow = (id: string) => projectTableExists(db, "project_activity")
    ? Boolean(db.prepare("SELECT 1 FROM project_activity WHERE work_item_id=? AND kind='card_failed' AND at > ? LIMIT 1").get(id, input.since))
    : cards.some((card) => card.id === id && Number(card.updated_at) > input.since);
  const failing = cards.find((card) => Number(card.failures) >= SAME_CARD_FAILURES_LIMIT && failedNow(card.id));
  if (failing) return { progressed, noProgress, pause: fitPauseLine((cut) => `Paused: ${titled(failing, cut, 80)} failed ${SAME_CARD_FAILURES_LIMIT} times. ${RESUME_LINE}`) };
  // A cycle is the SAME work handed back (SPEC-P 5.3 "the same
  // assignment"): B, holding what A gave it, gives that work back to A,
  // with an assign or with delegate_bot (an ask with a delegation key).
  // Asking for inputs is not handing back, whatever tool carries it
  // (AFTER-REVIEW: Wren, on the card Nova gave her, used delegate_bot to
  // ask Nova for a brief, and both goals paused). See sameWork. Nor is the lead making a
  // different card in the turn that answers a member (round 13). Asks
  // count only when the same request bounces A to B to A to B. Each hop
  // must come from the one before (its parent chain reaches it), not merely
  // share the root: a lead's second card to the same member, or unrelated
  // questions over a long goal, are not a loop (round 12).
  const parentOf = db.prepare("SELECT parent_id FROM room_requests WHERE id=?");
  const descends = (childId: string, ancestorId: string): boolean => {
    const seen = new Set<string>();
    let id: string | null = childId;
    while (id && !seen.has(id) && seen.size < 200) {
      seen.add(id);
      id = ((parentOf.get(id) as { parent_id: string | null } | undefined)?.parent_id) ?? null;
      if (id === ancestorId) return true;
    }
    return false;
  };
  const cardText = projectTableExists(db, "project_work_items") ? db.prepare("SELECT title, description FROM project_work_items WHERE id=?") : null;
  const works = new Map<string, HopWork>();
  const workOf = (hop: Hop): HopWork => {
    const known = works.get(hop.id);
    if (known) return known;
    const card = hop.workItemId ? cardText?.get(hop.workItemId) as { title: string | null; description: string | null } | undefined : undefined;
    // only an ask (ask_bot or delegate_bot) is a question; an assign's text is the work
    const work = { workItemId: hop.workItemId, question: hop.verb === "ask" && /[?\uFF1F]/.test(hop.text ?? ""),
      texts: [hop.text, card?.title, card?.description].map(sameWorkText).filter((text) => text.length >= SAME_WORK_MIN_CHARS) };
    works.set(hop.id, work);
    return work;
  };
  // lane cards (c): a member delegating to its LEAD is asking the one who
  // planned the work (inputs, a hand-off note), never handing it back to the
  // owner; only an assign, or a delegation to someone else, hands work over.
  const leadId = (projectTableExists(db, "project_settings") ? (db.prepare("SELECT lead_bot_id FROM project_settings WHERE group_id=?").get(goal.group_id) as { lead_bot_id: string | null } | undefined)?.lead_bot_id : null) ?? null;
  const handsOverHop = (hop: Hop, to: string) => hop.verb === "assign" || (hop.verb === "ask" && hop.key.startsWith("ask:delegation:") && to !== leadId);
  const hopColumns = (t: string) => `${t}.id AS ${t}Id, ${t}.verb AS ${t}Verb, ${t}.admission_key AS ${t}Key, ${t}.work_item_id AS ${t}Work, ${t}.payload_text AS ${t}Text`;
  const hopOf = (row: Record<string, unknown>, t: string): Hop => ({ id: String(row[`${t}Id`]), verb: String(row[`${t}Verb`]), key: String(row[`${t}Key`] ?? ""), workItemId: (row[`${t}Work`] as string | null) ?? null, text: (row[`${t}Text`] as string | null) ?? null });
  const handedBack = (db.prepare(`SELECT ${hopColumns("a")}, ${hopColumns("b")}, a.from_bot_id AS a, a.to_bot_id AS b FROM room_requests a JOIN room_requests b
      ON a.root_id=b.root_id AND a.from_bot_id=b.to_bot_id AND a.to_bot_id=b.from_bot_id AND b.created_at > a.created_at
    WHERE a.project_goal_id=? AND a.verb IN ('ask','assign') AND (b.verb='assign' OR (b.verb='ask' AND b.admission_key LIKE 'ask:delegation:%' AND b.to_bot_id IS NOT ?))
      AND a.from_bot_id IS NOT NULL AND b.created_at > ? ORDER BY b.created_at`).all(goal.id, leadId, input.since) as Array<Record<string, unknown>>)
    .map((row) => ({ a: String(row.a), b: String(row.b), first: hopOf(row, "a"), back: hopOf(row, "b") }))
    .find((pair) => handsOverHop(pair.back, pair.a) && descends(pair.back.id, pair.first.id) && sameWork(workOf(pair.first), workOf(pair.back)));
  const bounced = handedBack ? undefined : (db.prepare(`SELECT ${hopColumns("a")}, ${hopColumns("b")}, ${hopColumns("c")}, a.from_bot_id AS a, a.to_bot_id AS b FROM room_requests a
      JOIN room_requests b ON a.root_id=b.root_id AND a.from_bot_id=b.to_bot_id AND a.to_bot_id=b.from_bot_id AND b.created_at > a.created_at
      JOIN room_requests c ON a.root_id=c.root_id AND c.from_bot_id=a.from_bot_id AND c.to_bot_id=a.to_bot_id AND c.created_at > b.created_at
    WHERE a.project_goal_id=? AND a.verb IN ('ask','assign') AND b.verb='ask' AND c.verb='ask' AND a.from_bot_id IS NOT NULL
      AND c.created_at > ? ORDER BY c.created_at`).all(goal.id, input.since) as Array<Record<string, unknown>>)
    .map((row) => ({ a: String(row.a), b: String(row.b), hops: [hopOf(row, "a"), hopOf(row, "b"), hopOf(row, "c")] }))
    .find(({ hops: [first, back, again] }) => descends(back!.id, first!.id) && descends(again!.id, back!.id)
      && sameWork(workOf(first!), workOf(back!)) && sameWork(workOf(back!), workOf(again!)));
  const cycle = handedBack ?? bounced;
  if (cycle) return { progressed, noProgress, pause: fitPauseLine((cut) => `Paused: ${cut(name(cycle.a), 80)} and ${cut(name(cycle.b), 80)} keep handing the same work back to each other. ${RESUME_LINE}`) };
  // a replan is the lead cancelling open cards: caught in the window it happened in
  const replannedNow = !projectTableExists(db, "project_activity") || Boolean(db.prepare(`SELECT 1 FROM project_activity WHERE group_id=? AND at > ?
      AND actor NOT IN ('owner','server') AND kind='card_moved' AND json_extract(detail,'$.to')='cancelled' LIMIT 1`).get(goal.group_id, input.since));
  if (Number(goal.replans) > REPLAN_LIMIT && replannedNow) return { progressed, noProgress, pause: "Paused: the lead wants to replan a third time. Look at the plan, then open the goal and press Resume." };
  if (noProgress >= NO_PROGRESS_LIMIT) {
    const stalled = cards.filter((card) => card.state !== "done" && card.state !== "cancelled").slice(0, 3);
    return { progressed, noProgress, pause: fitPauseLine((cut) => `Paused: ${NO_PROGRESS_LIMIT} team steps without progress${stalled.length ? ` on ${stalled.map((card) => titled(card, cut, 60)).join(", ")}` : ""}. ${RESUME_LINE}`) };
  }
  return { progressed, noProgress };
}
