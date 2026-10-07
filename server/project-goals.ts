// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Goal transitions (SPEC-P 5.3), evidence rules (5.3.1) and the grouped
// decisions derivation (5.6). Same conventions as project-cards.ts: one
// exported function per transition, state-checked, revision-bumping on owner
// writes, the activity row in the caller's transaction. Lane E1 triggers the
// server (S) rows; the routes call the owner (O) rows; the envelope and the
// internal tools call the lead (L) rows.
import { projectIsClosing } from "./project-records.ts";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { cancelProjectCard, createProjectCard, enqueueCardRun, type ProjectActor } from "./project-cards.ts";
import { createDefaultGoalBudget, DEFAULT_GOAL_REVIEW, projectsAutonomyEnabled, projectsGoalsEnabled, projectsLeadEnabled, type ProjectFeatureFlags } from "./project-defaults.ts";
import {
  activeProjectGoal,
  inheritedRequestLineage,
  insertProjectActivity,
  projectCardsForGroup,
  projectGoalById,
  projectSettingsFor,
  type ProjectCard,
  type ProjectGoal,
  type ProjectGoalCriterion,
} from "./project-records.ts";

export type { ProjectActor };

export type GoalFailure =
  | { ok: false; error: "not_allowed"; reason: string }
  | { ok: false; error: "invalid"; reason: string }
  | { ok: false; error: "not_found"; reason: string }
  | { ok: false; error: "changed"; reason: string; goal: ProjectGoal };

export type GoalOutcome = ({ ok: true; goal: ProjectGoal }) | GoalFailure;

const notAllowed = (reason: string): GoalFailure => ({ ok: false, error: "not_allowed", reason });
const invalid = (reason: string): GoalFailure => ({ ok: false, error: "invalid", reason });
const notFound = (reason: string): GoalFailure => ({ ok: false, error: "not_found", reason });

/** The tool names whose recorded result counts as `check` evidence (5.3.1).
 * Named here so the list is auditable and the report can quote it. */
export const PROJECT_CHECK_TOOLS = ["run_tests", "typecheck", "lint", "build"] as const;

const NON_TERMINAL = ["draft", "planning", "awaiting_plan_ok", "working", "awaiting_signoff", "paused"];

function goalOr404(db: DatabaseSync, goalId: string): ProjectGoal | GoalFailure {
  const goal = projectGoalById(db, goalId);
  if (goal && projectIsClosing(db,goal.groupId)) return notAllowed("This project is closing.");
  return goal ?? notFound("No such goal.");
}

function goalActivity(db: DatabaseSync, goal: ProjectGoal, kind: "goal_state" | "criteria", actor: string, now: number, detail: Record<string, unknown>): void {
  insertProjectActivity(db, { groupId: goal.groupId, goalId: goal.id, kind, actor, at: now, detail });
}

function writeGoal(db: DatabaseSync, goalId: string, fields: Record<string, unknown>): void {
  const sets: string[] = ["revision=revision+1"];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key}=?`);
    values.push(value === undefined ? null : value);
  }
  values.push(goalId);
  db.prepare(`UPDATE project_goals SET ${sets.join(", ")} WHERE id=?`).run(...values as never[]);
}

// ── create and edit (O) ─────────────────────────────────────────────────────

/** POST goal: a draft (starting it is a separate action). */
export function createProjectGoal(
  db: DatabaseSync,
  input: { actor?: ProjectActor;
    groupId: string;
    title: string;
    description?: string;
    criteria?: string[];
    planFirst?: boolean;
    review?: boolean;
    deadlineAt?: number | null;
    now: number;
  },
): GoalOutcome {
  if (input.actor && input.actor.kind !== "owner") return notAllowed("Only the owner can do this.");
  const allowed = ["actor", "groupId", "title", "description", "criteria", "planFirst", "review", "deadlineAt", "now"];
  if (Object.keys(input).some(key => !allowed.includes(key))) return invalid("Unknown field.");
  const settings = projectSettingsFor(db, input.groupId);
  if (!settings) return notFound("Not a project.");
  if (settings.endedAt !== null) return notAllowed("This is a channel now.");
  if (settings.closedAt !== null) return notAllowed("This project is closed.");
  if (projectIsClosing(db,input.groupId)) return notAllowed("This project is closing.");
  const title = input.title.trim();
  if (title.length < 1 || title.length > 200) return invalid("A goal title is 1 to 200 characters.");
  const description = (input.description ?? "").trim();
  if (description.length > 2000) return invalid("A goal description is at most 2000 characters.");
  const texts = input.criteria ?? [];
  if (texts.length > 10) return invalid("A goal has at most 10 criteria.");
  if (texts.some(text => typeof text !== "string" || text.trim().length < 1 || text.trim().length > 300)) return invalid("A criterion is 1 to 300 characters.");
  const criteria: ProjectGoalCriterion[] = texts.map(text => {
    const trimmed = text.trim();
    if (trimmed.length < 1 || trimmed.length > 300) throw invalid("A criterion is 1 to 300 characters.");
    return { id: randomUUID(), text: trimmed, setBy: "owner" as const, proposed: false, met: false };
  });
  const id = randomUUID();
  db.prepare(`INSERT INTO project_goals
    (id, group_id, title, description, criteria, state, state_reason, plan_first, review, replans, no_progress, lead_wakes, revision, created_at, started_at, finished_at, summary_message_id, deadline_at)
    VALUES (?,?,?,?,?,'draft',NULL,?,?,0,0,0,0,?,NULL,NULL,NULL,?)`).run(
    id, input.groupId, title, description, JSON.stringify(criteria),
    input.planFirst === true ? 1 : 0, input.review === undefined ? (DEFAULT_GOAL_REVIEW ? 1 : 0) : input.review ? 1 : 0,
    input.now, input.deadlineAt ?? null,
  );
  const goal = projectGoalById(db, id)!;
  goalActivity(db, goal, "goal_state", "owner", input.now, { to: "draft" });
  return { ok: true, goal };
}

/** O: edit title, description and criteria. Editing a proposed criterion
 * makes it owner-set (11.1); owner wording is immutable to bots. */
export function patchProjectGoal(
  db: DatabaseSync,
  input: { actor?: ProjectActor;
    goalId: string;
    expectedRevision: number;
    title?: string;
    description?: string;
    criteria?: Array<{ id?: string; text: string }>;
    now: number;
  },
): GoalOutcome {
  if (input.actor && input.actor.kind !== "owner") return notAllowed("Only the owner can do this.");
  const goal = goalOr404(db, input.goalId);
  if (!("state" in goal)) return goal;
  if (input.expectedRevision !== goal.revision) return { ok: false, error: "changed", reason: "The goal changed since you read it.", goal };
  const fields: Record<string, unknown> = {};
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (title.length < 1 || title.length > 200) return invalid("A goal title is 1 to 200 characters.");
    fields.title = title;
  }
  if (input.description !== undefined) {
    if (input.description.length > 2000) return invalid("A goal description is at most 2000 characters.");
    fields.description = input.description;
  }
  if (input.criteria !== undefined) {
    if (input.criteria.length > 10) return invalid("A goal has at most 10 criteria.");
    if (input.criteria.some(entry => typeof entry.text !== "string" || entry.text.trim().length < 1 || entry.text.trim().length > 300)) return invalid("A criterion is 1 to 300 characters.");
    const current = new Map(goal.criteria.map(criterion => [criterion.id, criterion]));
    const next: ProjectGoalCriterion[] = input.criteria.map(entry => {
      const text = entry.text.trim();
      if (text.length < 1 || text.length > 300) throw invalid("A criterion is 1 to 300 characters.");
      const existing = entry.id ? current.get(entry.id) : undefined;
      if (existing && existing.setBy === "owner" && existing.text === text) return existing;
      if (existing && existing.setBy === "owner") return { ...existing, text };
      // A proposed criterion the owner edits becomes the owner's.
      return {
        id: existing?.id ?? randomUUID(), text, setBy: "owner" as const, proposed: false,
        met: existing?.met ?? false, ...(existing?.metBy ? { metBy: existing.metBy } : {}), ...(existing?.evidence ? { evidence: existing.evidence } : {}),
      };
    });
    fields.criteria = JSON.stringify(next);
  }
  if (Object.keys(fields).length === 0) return { ok: true, goal };
  writeGoal(db, goal.id, fields);
  const after = projectGoalById(db, goal.id)!;
  goalActivity(db, after, "criteria", "owner", input.now, { edit: true });
  return { ok: true, goal: after };
}

// ── start (draft -> planning) ───────────────────────────────────────────────

/** O: Start. Requires a lead, the board part, an open project, autonomy, and
 * budget headroom; creates the goal budget with the approved defaults. The
 * lead's wake is lane E1's dispatch; this writes the rows. */
export function startProjectGoal(
  db: DatabaseSync,
  input: { actor?: ProjectActor; goalId: string; now: number; tz: string; flags?: ProjectFeatureFlags },
): GoalOutcome {
  if (input.actor && input.actor.kind !== "owner") return notAllowed("Only the owner can do this.");
  const goal = goalOr404(db, input.goalId);
  if (!("state" in goal)) return goal;
  if (goal.state !== "draft") return notAllowed(`This goal is ${goal.state}, not a draft.`);
  const settings = projectSettingsFor(db, goal.groupId)!;
  if (settings.endedAt !== null) return notAllowed("This is a channel now.");
  if (settings.closedAt !== null) return notAllowed("This project is closed.");
  if (!projectsGoalsEnabled(input.flags)) return notAllowed("Goals are off for this workspace.");
  if (!projectsAutonomyEnabled(input.flags)) return notAllowed("Projects work on their own is off.");
  const leadOn = projectsLeadEnabled(input.flags);
  if (!leadOn || !settings.leadBotId) return notAllowed("Pick a lead first.");
  if (!settings.parts.board) return notAllowed("Turn the board on first.");
  if (activeProjectGoal(db, goal.groupId)) return notAllowed("Another goal is already active in this project.");
  // Budget headroom (lane B extends): a paused period budget refuses Start.
  const pausedPeriod = db.prepare("SELECT 1 FROM project_budgets WHERE group_id=? AND period <> 'goal' AND state='paused'").get(goal.groupId);
  if (pausedPeriod) return notAllowed("The project's budget is paused. Raise it or resume first.");
  createDefaultGoalBudget(db, { groupId: goal.groupId, goalId: goal.id, tz: input.tz, now: input.now });
  writeGoal(db, goal.id, { state: "planning", started_at: input.now, state_reason: null });
  const after = projectGoalById(db, goal.id)!;
  goalActivity(db, after, "goal_state", "owner", input.now, { from: "draft", to: "planning" });
  return { ok: true, goal: after };
}

/** S (envelope apply, section 9): the lead's first accepted plan moves the
 * goal out of planning. Exported for the envelope module. */
export function applyGoalPlanAccepted(db: DatabaseSync, input: { actor?: ProjectActor; goalId: string; now: number }): GoalOutcome {
  if (input.actor && input.actor.kind !== "server") return notAllowed("Only the server can do this.");
  const goal = goalOr404(db, input.goalId);
  if (!("state" in goal)) return goal;
  if (goal.state !== "planning") return notAllowed(`This goal is ${goal.state}, not planning.`);
  const next = goal.planFirst ? "awaiting_plan_ok" : "working";
  writeGoal(db, goal.id, { state: next });
  const after = projectGoalById(db, goal.id)!;
  goalActivity(db, after, "goal_state", "server", input.now, { from: "planning", to: next });
  return { ok: true, goal: after };
}

/** O: approve the plan. The plan's queued assign requests become admissible;
 * any that are terminal (expired by a restore) are re-created for the goal's
 * todo cards with `assign:card:` keys. */
export function approveProjectPlan(db: DatabaseSync, input: { actor?: ProjectActor; goalId: string; now: number; memberIds: readonly string[] }): GoalOutcome {
  if (input.actor && input.actor.kind !== "owner") return notAllowed("Only the owner can do this.");
  const goal = goalOr404(db, input.goalId);
  if (!("state" in goal)) return goal;
  if (goal.state !== "awaiting_plan_ok") return notAllowed(`This goal is ${goal.state}; there is no plan waiting for your OK.`);
  const cards = projectCardsForGroup(db, goal.groupId).filter(card => card.goalId === goal.id && card.state === "todo");
  const requeue = cards.flatMap((card) => {
    const live = db.prepare("SELECT 1 FROM room_requests WHERE work_item_id=? AND verb='assign' AND state IN ('queued','running','waiting_owner','waiting_bot')").get(card.id);
    if (live) return [];
    const previous = db.prepare("SELECT * FROM room_requests WHERE group_id=? AND work_item_id=? AND verb='assign' AND state IN ('done','failed','cancelled','expired','unknown') ORDER BY created_at DESC, attempt DESC, id DESC LIMIT 1")
      .get(goal.groupId, card.id);
    // Owner-created cards without an assignment still wait for Start.
    return previous ? [{ card, previous }] : [];
  });
  // the re-queued runs return to the lead: never queue one under a blank
  // lead or one that is not a member (round 19), and refuse before any write
  const leadBotId = projectSettingsFor(db, goal.groupId)?.leadBotId;
  if (requeue.length && (!leadBotId || !input.memberIds.includes(leadBotId))) return notAllowed("Pick a lead first.");
  for (const { card, previous } of requeue) {
    const queued = enqueueCardRun(db, {
      cardId: card.id, actor: { kind: "lead", botId: leadBotId!, lineage: inheritedRequestLineage(previous) }, now: input.now,
    });
    if (!queued.ok) return notAllowed(queued.reason);
    const replacement = db.prepare("SELECT 1 FROM room_requests WHERE id=? AND state IN ('queued','running','waiting_owner','waiting_bot')").get(queued.requestId);
    if (!replacement) return notAllowed("This card could not be queued. Try approving the plan again.");
  }
  writeGoal(db, goal.id, { state: "working" });
  const after = projectGoalById(db, goal.id)!;
  goalActivity(db, after, "goal_state", "owner", input.now, { from: "awaiting_plan_ok", to: "working" });
  return { ok: true, goal: after };
}

/** O: change the plan (with a note). The plan's queued requests are
 * cancelled and its todo cards cancelled; not a replan count. */
export function changeProjectPlan(db: DatabaseSync, input: { actor?: ProjectActor; goalId: string; note: string; now: number }): GoalOutcome {
  if (input.actor && input.actor.kind !== "owner") return notAllowed("Only the owner can do this.");
  const goal = goalOr404(db, input.goalId);
  if (!("state" in goal)) return goal;
  if (goal.state !== "awaiting_plan_ok") return notAllowed(`This goal is ${goal.state}; there is no plan waiting for your OK.`);
  const note = input.note.trim();
  if (note.length < 1 || note.length > 500) return invalid("Say what should change, in at most 500 characters.");
  const cards = projectCardsForGroup(db, goal.groupId).filter(card => card.goalId === goal.id && card.state === "todo");
  for (const card of cards) cancelProjectCard(db, { cardId: card.id, actor: { kind: "owner" }, now: input.now });
  db.prepare("UPDATE room_requests SET state='cancelled', finished_at=?, waiting_since=NULL, outcome_note='plan changed' WHERE project_goal_id=? AND state='queued'").run(input.now, goal.id);
  writeGoal(db, goal.id, { state: "planning", state_reason: note.slice(0, 200) });
  const after = projectGoalById(db, goal.id)!;
  goalActivity(db, after, "goal_state", "owner", input.now, { from: "awaiting_plan_ok", to: "planning" });
  return { ok: true, goal: after };
}

// ── sign-off ────────────────────────────────────────────────────────────────

/** What still blocks sign-off, in plain sentences (returned with the 409). */
export function goalSignoffBlockers(db: DatabaseSync, goal: ProjectGoal, roomThreadId?: string): string[] {
  const blockers: string[] = [];
  if (goal.criteria.length === 0) blockers.push("This goal has no done criteria yet.");
  for (const criterion of goal.criteria) {
    if (!criterion.met) blockers.push(`Not met: ${criterion.text}`);
    else {
      const evidence = criterion.evidence;
      const resolved = evidence && resolveGoalEvidence(db, goal, evidence, roomThreadId);
      if (!resolved || resolved.workItemId !== evidence?.workItemId || resolved.attempt !== evidence.attempt) blockers.push(`Evidence needed: ${criterion.text}`);
    }
  }
  const open = projectCardsForGroup(db, goal.groupId).filter(card =>
    card.goalId === goal.id && ["todo", "doing", "waiting", "review", "failed"].includes(card.state));
  for (const card of open) blockers.push(`Card ${card.number} is ${card.state}.`);
  return blockers;
}

/** S or L: working -> awaiting_signoff, only when every condition of 5.3
 * holds; refused with the unmet list otherwise. */
export function requestGoalSignoff(
  db: DatabaseSync,
  input: { goalId: string; actor: ProjectActor; detail?: string; now: number; roomThreadId?: string },
): GoalOutcome & { blockers?: string[] } {
  const goal = goalOr404(db, input.goalId);
  if (!("state" in goal)) return goal;
  if (input.actor.kind !== "lead" && input.actor.kind !== "server") return notAllowed("Only the lead asks for sign-off.");
  if (goal.state !== "working") return notAllowed(`This goal is ${goal.state}, not working.`);
  const blockers = goalSignoffBlockers(db, goal, input.roomThreadId);
  if (blockers.length > 0) return { ok: false, error: "not_allowed", reason: blockers.join(" "), blockers };
  writeGoal(db, goal.id, { state: "awaiting_signoff" });
  const after = projectGoalById(db, goal.id)!;
  goalActivity(db, after, "goal_state", input.actor.kind === "lead" ? input.actor.botId : "server", input.now, { from: "working", to: "awaiting_signoff" });
  return { ok: true, goal: after };
}

/** O: sign off. The close summary, deliverables and lessons are lane N. */
export function signOffProjectGoal(db: DatabaseSync, input: { goalId: string; actor: ProjectActor; now: number }): GoalOutcome {
  const goal = goalOr404(db, input.goalId);
  if (!("state" in goal)) return goal;
  if (input.actor.kind !== "owner") return notAllowed("Only the owner signs off a goal.");
  if (goal.state !== "awaiting_signoff") return notAllowed(`This goal is ${goal.state}, not waiting for sign-off.`);
  writeGoal(db, goal.id, { state: "done", finished_at: input.now, state_reason: null });
  const after = projectGoalById(db, goal.id)!;
  goalActivity(db, after, "goal_state", "owner", input.now, { from: "awaiting_signoff", to: "done" });
  return { ok: true, goal: after };
}

/** O: send back. Creates a card for the lead with the owner's note. */
export function sendProjectGoalBack(
  db: DatabaseSync,
  input: { actor?: ProjectActor; goalId: string; note: string; memberIds: string[]; now: number },
): GoalOutcome {
  if (input.actor && input.actor.kind !== "owner") return notAllowed("Only the owner can do this.");
  if (!input.actor || input.actor.kind !== "owner" || !input.actor.lineage) return notAllowed("Open this goal in the Murage app or on your paired phone to send it back.");
  const goal = goalOr404(db, input.goalId);
  if (!("state" in goal)) return goal;
  if (goal.state !== "awaiting_signoff") return notAllowed(`This goal is ${goal.state}, not waiting for sign-off.`);
  const note = input.note.trim();
  if (note.length < 1 || note.length > 500) return invalid("Say what to change, in at most 500 characters.");
  const settings = projectSettingsFor(db, goal.groupId)!;
  const lead = settings.leadBotId;
  if (!lead) return notAllowed("Pick a lead first.");
  writeGoal(db, goal.id, { state: "working" });
  const card = createProjectCard(db, {
    groupId: goal.groupId, title: note.slice(0, 120), description: note, goalId: goal.id,
    assigneeBotId: lead, actor: input.actor, memberIds: input.memberIds, createdBy: "owner", now: input.now,
  });
  if (!card.ok) return notAllowed(card.ok === false ? card.reason : "Could not create the follow-up card.");
  const queued = enqueueCardRun(db, { cardId: card.card.id, actor: input.actor, now: input.now });
  if (!queued.ok) return notAllowed(queued.reason);
  const after = projectGoalById(db, goal.id)!;
  goalActivity(db, after, "goal_state", "owner", input.now, { from: "awaiting_signoff", to: "working" });
  return { ok: true, goal: after };
}

// ── pause, resume, stop, fail ───────────────────────────────────────────────

/** O or S: pause from any working-shaped state, with the reason. */
export function pauseProjectGoal(
  db: DatabaseSync,
  input: { goalId: string; reason: string; actor: ProjectActor; now: number },
): GoalOutcome {
  const goal = goalOr404(db, input.goalId);
  if (!("state" in goal)) return goal;
  if (input.actor.kind !== "owner" && input.actor.kind !== "server") return notAllowed("Only the owner or Murage can pause a goal.");
  if (!["planning", "working", "awaiting_plan_ok", "awaiting_signoff"].includes(goal.state)) {
    return notAllowed(`This goal is ${goal.state}.`);
  }
  writeGoal(db, goal.id, { state: "paused", state_reason: input.reason.slice(0, 200) });
  const after = projectGoalById(db, goal.id)!;
  goalActivity(db, after, "goal_state", input.actor.kind === "owner" ? "owner" : "server", input.now, { from: goal.state, to: "paused" });
  return { ok: true, goal: after };
}

/** O: resume. working again, or planning when the goal has no cards. Refused
 * while a budget is paused, the project's run_state is paused, the lead is
 * off, not set or not one of `memberIds` (round 15, required round 16), or
 * the board is off.
 * Resets no_progress. */
export function resumeProjectGoal(db: DatabaseSync, input: { actor?: ProjectActor; goalId: string; now: number; flags?: ProjectFeatureFlags; memberIds: readonly string[] }): GoalOutcome {
  if (input.actor && input.actor.kind !== "owner") return notAllowed("Only the owner can do this.");
  const goal = goalOr404(db, input.goalId);
  if (!("state" in goal)) return goal;
  if (goal.state !== "paused") return notAllowed(`This goal is ${goal.state}, not paused.`);
  if (!projectsGoalsEnabled(input.flags)) return notAllowed("Paused: goals are off");
  const settings = projectSettingsFor(db, goal.groupId)!;
  const pausedBudget = db.prepare("SELECT 1 FROM project_budgets WHERE group_id=? AND state='paused' AND (goal_id IS NULL OR goal_id=?)").get(goal.groupId, goal.id);
  if (pausedBudget) return notAllowed("A budget is paused. Raise it or resume it first.");
  if (settings.runState === "paused") return notAllowed("The project is paused. Resume it first.");
  if (!projectsLeadEnabled(input.flags) || !settings.leadBotId || !input.memberIds.includes(settings.leadBotId)) return notAllowed("Pick a lead to resume.");
  if (!settings.parts.board) return notAllowed("Turn the board on to resume.");
  const hasCards = db.prepare("SELECT 1 FROM project_work_items WHERE goal_id=? AND archived_at IS NULL LIMIT 1").get(goal.id);
  const next = hasCards ? "working" : "planning";
  writeGoal(db, goal.id, { state: next, state_reason: null, no_progress: 0 });
  const after = projectGoalById(db, goal.id)!;
  goalActivity(db, after, "goal_state", "owner", input.now, { from: "paused", to: next });
  return { ok: true, goal: after };
}

/** O or S: stop. Open cards are cancelled. */
export function stopProjectGoal(
  db: DatabaseSync,
  input: { goalId: string; actor: ProjectActor; reason?: string; now: number },
): GoalOutcome {
  const goal = goalOr404(db, input.goalId);
  if (!("state" in goal)) return goal;
  if (input.actor.kind !== "owner" && input.actor.kind !== "server") return notAllowed("Only the owner or Murage can stop a goal.");
  if (!NON_TERMINAL.includes(goal.state)) return notAllowed(`This goal is already ${goal.state}.`);
  const cards = projectCardsForGroup(db, goal.groupId).filter(card => card.goalId === goal.id);
  for (const card of cards) {
    if (["todo", "doing", "waiting", "review", "failed"].includes(card.state)) {
      cancelProjectCard(db, { cardId: card.id, actor: { kind: "server" }, now: input.now });
    }
  }
  db.prepare(`WITH RECURSIVE affected(id) AS (
    SELECT id FROM room_requests WHERE group_id=? AND project_goal_id=?
    UNION SELECT r.id FROM room_requests r JOIN affected a ON r.parent_id=a.id
  ) UPDATE room_requests SET state='cancelled', finished_at=?, waiting_since=NULL
    WHERE id IN (SELECT id FROM affected) AND state IN ('queued','running','waiting_owner','waiting_bot')`)
    .run(goal.groupId, goal.id, input.now);
  writeGoal(db, goal.id, { state: "stopped", finished_at: input.now, state_reason: input.reason?.slice(0, 200) ?? null });
  const after = projectGoalById(db, goal.id)!;
  goalActivity(db, after, "goal_state", input.actor.kind === "owner" ? "owner" : "server", input.now, { from: goal.state, to: "stopped" });
  return { ok: true, goal: after };
}

/** S only: fail (unrecoverable: the lead or every member deleted, the group
 * deleted). A lead's blocked is a pause, never a failure (AMB-12). */
export function failProjectGoal(db: DatabaseSync, input: { actor?: ProjectActor; goalId: string; reason: string; now: number }): GoalOutcome {
  if (input.actor && input.actor.kind !== "server") return notAllowed("Only the server can do this.");
  const goal = goalOr404(db, input.goalId);
  if (!("state" in goal)) return goal;
  if (!NON_TERMINAL.includes(goal.state)) return notAllowed(`This goal is already ${goal.state}.`);
  writeGoal(db, goal.id, { state: "failed", finished_at: input.now, state_reason: input.reason.slice(0, 200) });
  const after = projectGoalById(db, goal.id)!;
  goalActivity(db, after, "goal_state", "server", input.now, { from: goal.state, to: "failed" });
  return { ok: true, goal: after };
}

// ── criteria and evidence (5.3.1) ───────────────────────────────────────────

/** L: propose criteria on the first reply after Start, only while the goal
 * has none at all (owner-set criteria are untouchable). 2 to 5 entries. */
export function proposeProjectCriteria(
  db: DatabaseSync,
  input: { goalId: string; texts: string[]; now: number },
): GoalOutcome {
  const goal = goalOr404(db, input.goalId);
  if (!("state" in goal)) return goal;
  if (!["planning", "working"].includes(goal.state) || goal.leadWakes > 0) return notAllowed(`This goal is ${goal.state}.`);
  if (goal.criteria.length > 0) return notAllowed("This goal already has its criteria.");
  if (input.texts.length < 2 || input.texts.length > 5) return invalid("Propose 2 to 5 criteria.");
  if (input.texts.some(text => typeof text !== "string" || text.trim().length < 1 || text.trim().length > 300)) return invalid("A criterion is 1 to 300 characters.");
  const criteria: ProjectGoalCriterion[] = input.texts.map(text => {
    const trimmed = text.trim();
    if (trimmed.length < 1 || trimmed.length > 300) throw invalid("A criterion is 1 to 300 characters.");
    return { id: randomUUID(), text: trimmed, setBy: "lead" as const, proposed: true, met: false };
  });
  writeGoal(db, goal.id, { criteria: JSON.stringify(criteria) });
  const after = projectGoalById(db, goal.id)!;
  goalActivity(db, after, "criteria", projectSettingsFor(db, goal.groupId)?.leadBotId ?? "server", input.now, { proposed: criteria.length });
  return { ok: true, goal: after };
}

/** The first dispatch of the card's current attempt, for evidence bounds. */
function attemptStart(db: DatabaseSync, cardId: string, attempt: number): number | null {
  const row = db.prepare(`SELECT MIN(dispatched_at) AS at FROM room_requests WHERE work_item_id=? AND attempt=? AND dispatched_at IS NOT NULL`).get(cardId, attempt) as { at: number | null };
  return row.at;
}

/** The latest assign run of the card's current attempt. A reassign after a
 * failure starts a new run in the same attempt; that run is the work. */
function latestAssignRun(db: DatabaseSync, card: ProjectCard): { state: string; dispatchedAt: number | null } | null {
  const row = db.prepare(`SELECT state, dispatched_at FROM room_requests WHERE work_item_id=? AND attempt=? AND verb='assign'
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(card.id, card.attempt) as { state: string; dispatched_at: number | null } | undefined;
  return row ? { state: row.state, dispatchedAt: row.dispatched_at } : null;
}

/** Evidence from a card's current attempt counts once that work stands: the
 * card is in review or done, or its latest run is live or finished. Files
 * and checks count from that run's dispatch, so an earlier failed run's
 * output never does. Returns the evidence bound, or null. */
function standingSince(db: DatabaseSync, card: ProjectCard): number | null {
  const run = latestAssignRun(db, card);
  if (card.state === "review" || card.state === "done") return run?.dispatchedAt ?? attemptStart(db, card.id, card.attempt);
  if (card.state !== "doing" && card.state !== "waiting") return null;
  if (!run || !["queued", "running", "waiting_owner", "waiting_bot", "done"].includes(run.state)) return null;
  return run.dispatchedAt;
}


function goalEvidenceCards(db: DatabaseSync, goal: ProjectGoal): ProjectCard[] {
  return projectCardsForGroup(db, goal.groupId, true).filter(card => card.goalId === goal.id && card.state !== "cancelled" && card.state !== "failed");
}

/** The evidence a refused `met` could have used: each standing card's
 * result, and its files, as the exact entries to pass. A stale card is named
 * by its number only (round 14). Model-facing: it rides the tool's refusal. */
export function goalEvidenceHint(db: DatabaseSync, goal: ProjectGoal, roomThreadId?: string): string {
  const table = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='artifacts'").get());
  const parts: string[] = [];
  let listed = 0;
  for (const card of goalEvidenceCards(db, goal).filter(entry => entry.state === "review" || entry.state === "done")) {
    const since = standingSince(db, card);
    if (since === null) continue;
    if (++listed > 6) break;
    const named = card.stale ? `card ${card.number}` : `card ${card.number} ${JSON.stringify(card.title.slice(0, 80))}`;
    const result = db.prepare(`SELECT result_message_id FROM room_requests WHERE work_item_id=? AND attempt=? AND verb='assign' AND state='done'
      AND result_message_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`).get(card.id, card.attempt) as { result_message_id: string } | undefined;
    if (result) parts.push(`${named} result { "kind": "message", "ref": ${JSON.stringify(result.result_message_id)} }`);
    if (!table) continue;
    const files = db.prepare(`SELECT id, name FROM artifacts WHERE created_at >= ? AND (thread_id=? OR (thread_id=? AND bot_id=?)) ORDER BY created_at DESC LIMIT 20`)
      .all(since, card.deskThreadId ?? "", roomThreadId ?? "", card.assigneeBotId ?? "") as Array<{ id: string; name: string }>;
    const seen = new Set<string>();
    for (const file of files) {
      if (seen.has(file.name) || seen.size >= 3) continue;
      seen.add(file.name);
      parts.push(`${result ? "its" : `${named}'s`} file ${card.stale ? "(name left out)" : JSON.stringify(file.name.slice(0, 80))} { "kind": "file", "ref": ${JSON.stringify(file.id)} }`);
    }
  }
  return parts.length ? ` Evidence you can use: ${parts.join("; ")}.` : " No card of this goal has a result to cite yet.";
}

/** A registered file that is a card's work (5.3.1 `file`): made in the card's
 * desk thread, or in the room by the card's assignee, after the standing
 * run's dispatch. `ref` is the file's id or, newest first, its name
 * (AFTER-LOOP run2: the lead named LAUNCH-PLAN.md and was refused). */
function resolveFileEvidence(db: DatabaseSync, cards: ProjectCard[], ref: string, roomThreadId?: string, preferCardId?: string): { workItemId: string; attempt: number; at: number; artifactId: string } | null {
  // re-resolving recorded evidence tries the card it was recorded for first,
  // so a room file shared by two cards of one assignee keeps its card
  if (preferCardId) cards = [...cards].sort((a, b) => Number(b.id === preferCardId) - Number(a.id === preferCardId));
  const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='artifacts'").get();
  if (!table) return null;
  // by id: the one file; by name: only files in these cards' desks or the
  // room, so same-named files elsewhere never crowd the real one out
  const threads = [...new Set([...cards.map(card => card.deskThreadId).filter((id): id is string => Boolean(id)), ...(roomThreadId ? [roomThreadId] : [])])];
  const byId = db.prepare("SELECT id, bot_id, thread_id, created_at FROM artifacts WHERE id=?").all(ref) as Array<{ id: string; bot_id: string; thread_id: string; created_at: number }>;
  const byName = byId.length || !threads.length ? [] : db.prepare(`SELECT id, bot_id, thread_id, created_at FROM artifacts WHERE name=? AND thread_id IN (${threads.map(() => "?").join(",")})
    ORDER BY created_at DESC LIMIT 50`).all(ref, ...threads) as Array<{ id: string; bot_id: string; thread_id: string; created_at: number }>;
  for (const artifact of byId.length ? byId : byName) {
    // a name counts only for a card whose work stands in review or done
    for (const card of byId.length ? cards : cards.filter(entry => entry.state === "review" || entry.state === "done")) {
      const inDesk = card.deskThreadId !== null && artifact.thread_id === card.deskThreadId;
      const inRoom = roomThreadId !== undefined && artifact.thread_id === roomThreadId && artifact.bot_id === card.assigneeBotId;
      if (!inDesk && !inRoom) continue;
      const since = standingSince(db, card);
      if (since !== null && artifact.created_at >= since) return { workItemId: card.id, attempt: card.attempt, at: artifact.created_at, artifactId: artifact.id };
    }
  }
  return null;
}

/** Resolve `met` evidence to a card of this goal in its current attempt
 * (5.3.1). Returns the resolved card id, the dispatch bound and the evidence
 * as recorded (a file named by its name, or given as a message, is recorded
 * as that file by id), or null. */
export function resolveGoalEvidence(
  db: DatabaseSync,
  goal: ProjectGoal,
  evidence: { kind: "message" | "file" | "check"; ref: string; workItemId?: string },
  roomThreadId?: string,
): { workItemId: string; attempt: number; at: number; evidence: { kind: "message" | "file" | "check"; ref: string } } | null {
  const cards = goalEvidenceCards(db, goal);
  const byId = new Map(cards.map(card => [card.id, card]));
  const asFile = () => {
    const file = resolveFileEvidence(db, cards, evidence.ref, roomThreadId, evidence.workItemId);
    return file ? { workItemId: file.workItemId, attempt: file.attempt, at: file.at, evidence: { kind: "file" as const, ref: file.artifactId } } : null;
  };
  if (evidence.kind === "message") {
    const row = db.prepare(`SELECT work_item_id, attempt FROM room_requests
      WHERE result_message_id=? AND verb IN ('assign','review') AND state='done' ORDER BY created_at DESC LIMIT 1`).get(evidence.ref) as { work_item_id: string; attempt: number } | undefined;
    // a registered file's id given as a message is that file
    if (!row) return asFile();
    const card = byId.get(row.work_item_id);
    if (!card || row.attempt !== card.attempt) return null;
    return { workItemId: card.id, attempt: card.attempt, at: attemptStart(db, card.id, card.attempt) ?? 0, evidence };
  }
  if (evidence.kind === "file") return asFile();
  // check: a message in the card's desk thread (or the room thread) after the
  // standing run's dispatch, that is a review result of the card or a
  // recorded check-tool result.
  const message = db.prepare("SELECT thread_id, at, json FROM messages WHERE id=?").get(evidence.ref) as { thread_id: string; at: number; json: string } | undefined;
  if (!message) return null;
  for (const card of cards) {
    const inDesk = card.deskThreadId !== null && message.thread_id === card.deskThreadId;
    const inRoom = roomThreadId !== undefined && message.thread_id === roomThreadId;
    if (!inDesk && !inRoom) continue;
    const since = standingSince(db, card);
    if (since === null || message.at < since) continue;
    const reviewResult = db.prepare(`SELECT 1 FROM room_requests WHERE result_message_id=? AND verb='review' AND work_item_id=?`).get(evidence.ref, card.id);
    if (reviewResult) return { workItemId: card.id, attempt: card.attempt, at: message.at, evidence };
    try {
      const parsed = JSON.parse(message.json) as { role?: string; kind?: string; tool?: { name?: string; ok?: boolean } };
      if (parsed.role === "bot" && parsed.tool?.name && (PROJECT_CHECK_TOOLS as readonly string[]).includes(parsed.tool.name) && parsed.tool.ok === true) {
        return { workItemId: card.id, attempt: card.attempt, at: message.at, evidence };
      }
    } catch { /* not a check */ }
  }
  return null;
}

/** L or O: mark a criterion met with evidence that resolves under 5.3.1.
 * Owner-set wording is immutable; this only touches met/evidence. */
export function markCriterionMet(
  db: DatabaseSync,
  input: {
    goalId: string;
    criterionId: string;
    evidence: { kind: "message" | "file" | "check"; ref: string };
    actor: ProjectActor;
    now: number;
    roomThreadId?: string;
  },
): GoalOutcome {
  const goal = goalOr404(db, input.goalId);
  if (!("state" in goal)) return goal;
  if (input.actor.kind !== "lead" && input.actor.kind !== "owner") return notAllowed("Only the lead or the owner marks a criterion met.");
  if (goal.state !== "working" && goal.state !== "awaiting_signoff") return notAllowed(`This goal is ${goal.state}.`);
  const criterion = goal.criteria.find(entry => entry.id === input.criterionId);
  if (!criterion) return invalid("No such criterion.");
  const resolved = resolveGoalEvidence(db, goal, input.evidence, input.roomThreadId);
  // the lead's tool refusal names what it can cite; the owner's stays plain
  if (!resolved) return notAllowed(`That evidence is not from this goal's current work.${input.actor.kind === "lead" ? goalEvidenceHint(db, goal, input.roomThreadId) : ""}`);
  const actorName = input.actor.kind === "owner" ? "owner" : "botId" in input.actor ? input.actor.botId : "server";
  const criteria = goal.criteria.map(entry => entry.id === input.criterionId
    ? { ...entry, met: true, metBy: actorName, evidence: { kind: resolved.evidence.kind, ref: resolved.evidence.ref, workItemId: resolved.workItemId, attempt: resolved.attempt, at: resolved.at } }
    : entry);
  writeGoal(db, goal.id, { criteria: JSON.stringify(criteria) });
  const after = projectGoalById(db, goal.id)!;
  goalActivity(db, after, "criteria", actorName, input.now, { criterion: input.criterionId, met: true });
  return { ok: true, goal: after };
}

// ── grouped decisions (5.6) ─────────────────────────────────────────────────

export interface GroupedDecisions {
  /** In-memory approval cards in this project's threads, passed in by the
   * caller (they do not survive a restart; after one, the dead-wait entries
   * below carry the "Retry step or Skip" decision). */
  approvals: Array<{ requestId: string; cardId?: string; summary: string }>;
  goals: Array<{ goalId: string; state: "awaiting_plan_ok" | "awaiting_signoff" }>;
  deadWaitCards: Array<{ cardId: string; waitingKind: string; requestId: string | null }>;
  count: number;
}

/** The Inbox project row, recomputed at read (no table): open approval cards
 * (input), goal rows awaiting the owner, and cards in a dead wait the owner
 * must retry or skip. */
export function deriveGroupedDecisions(
  db: DatabaseSync,
  input: { groupId: string; openApprovals: Array<{ requestId: string; cardId?: string; summary: string }>; now: number },
): GroupedDecisions {
  const goals = (db.prepare("SELECT id, state FROM project_goals WHERE group_id=? AND state IN ('awaiting_plan_ok','awaiting_signoff')").all(input.groupId) as Array<{ id: string; state: string }>)
    .map(row => ({ goalId: row.id, state: row.state as "awaiting_plan_ok" | "awaiting_signoff" }));
  const deadWaitCards = (db.prepare(`SELECT id, waiting_on, request_id FROM project_work_items WHERE group_id=? AND state='waiting' AND archived_at IS NULL`).all(input.groupId) as Array<{ id: string; waiting_on: string | null; request_id: string | null }>)
    .filter(row => {
      if (!row.waiting_on) return false;
      try {
        const parsed = JSON.parse(row.waiting_on) as { kind?: string };
        return ["restart", "stopped", "owner"].includes(String(parsed.kind));
      } catch { return false; }
    })
    .map(row => {
      let kind = "restart";
      try { kind = String((JSON.parse(row.waiting_on!) as { kind: string }).kind); } catch { /* filtered above */ }
      return { cardId: row.id, waitingKind: kind, requestId: row.request_id };
    });
  return {
    approvals: input.openApprovals,
    goals,
    deadWaitCards,
    count: input.openApprovals.length + goals.length + deadWaitCards.length,
  };
}
