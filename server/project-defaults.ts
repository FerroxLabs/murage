// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The owner-decision defaults of the projects overhaul, approved by Sean on
// 2026-09-28 (.lane-brief.md section 2, decisions 2, 6 and 10). Every value a
// code path needs is written explicitly from here; no path may rely on a DDL
// default, because the DDL freezes at merge while these answers came after.
import { budgetPeriodStart } from "./project-budget-period.ts";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** Per-project default written into `project_settings.parallel_cards` on
 * every create path (owner setting, PATCH settings, 1 to 5). Decision 10. */
export const DEFAULT_PROJECT_PARALLEL_CARDS = 3;

/** Install-wide cap on running card runs; exported for lane E2b's arbiter.
 * Not a schema constant. Decision 10. */
export const PROJECT_CARD_RUNS_INSTALL_CAP = 4;

/** The budget a goal's Start creates (decision 2). */
export const DEFAULT_GOAL_WORK_MINUTES = 120;
export const DEFAULT_GOAL_TOKENS = 3_000_000;

/** Review by another member is on by default in goal mode (decision 6);
 * `POST goals` without `review` writes 1. */
export const DEFAULT_GOAL_REVIEW = true;

/** The default parts block of a new project (SPEC-P 3.1). */
export const DEFAULT_PROJECT_PARTS = Object.freeze({ board: true, review: true, digest: false });

/** The feature flags this lane reads. `projectsAutonomy` does not exist in
 * config.json yet (lane E1 adds the key); this reader defaults to true so E1
 * only adds the key. */
export interface ProjectFeatureFlags {
  projectsParallelCards?: boolean;
  projectsAutonomy?: boolean;
  projectsLead?: boolean;
  projectsGoals?: boolean;
  projectsBudgets?: boolean;
  projectsWorkProfile?: boolean;
}

export const projectsAutonomyEnabled = (features: ProjectFeatureFlags | undefined): boolean =>
  features?.projectsAutonomy !== false;
export const projectsLeadEnabled = (features: ProjectFeatureFlags | undefined): boolean =>
  features?.projectsLead !== false;
export const projectsGoalsEnabled = (features: ProjectFeatureFlags | undefined): boolean =>
  features?.projectsGoals !== false;

export interface ProjectBudget {
  id: string;
  groupId: string;
  goalId: string | null;
  period: "goal" | "day" | "week" | "month";
  tz: string;
  periodStart: number;
  maxWorkMinutes: number;
  maxTokens: number | null;
  maxCharge: number | null;
  warnAt: number;
  state: "ok" | "warned" | "paused";
  revision: number;
  raisedAt: number | null;
  raisedBy: "owner" | null;
  createdAt: number;
}

interface BudgetRow {
  id: string; group_id: string; goal_id: string | null; period: string; tz: string;
  period_start: number; max_work_minutes: number; max_tokens: number | null; max_charge: number | null;
  warn_at: number; state: string; revision: number; raised_at: number | null; raised_by: string | null; created_at: number;
}

export function projectBudgetFromRow(row: BudgetRow): ProjectBudget {
  return {
    id: row.id, groupId: row.group_id, goalId: row.goal_id, period: row.period as ProjectBudget["period"], tz: row.tz,
    periodStart: row.period_start, maxWorkMinutes: row.max_work_minutes, maxTokens: row.max_tokens, maxCharge: row.max_charge,
    warnAt: row.warn_at, state: row.state as ProjectBudget["state"], revision: row.revision,
    raisedAt: row.raised_at, raisedBy: row.raised_by as ProjectBudget["raisedBy"], createdAt: row.created_at,
  };
}

export function projectBudgetsForGroup(db: DatabaseSync, groupId: string): ProjectBudget[] {
  const rows = db.prepare("SELECT * FROM project_budgets WHERE group_id=? ORDER BY created_at, id").all(groupId) as unknown as BudgetRow[];
  return rows.map(projectBudgetFromRow);
}

/** Goal Start creates the goal budget with the approved defaults (SPEC-P
 * 5.3). Idempotent: the unique index on goal_id makes a repeated Start a
 * no-op returning the existing row. Lane B extends this. */
export function createDefaultGoalBudget(db: DatabaseSync, input: { groupId: string; goalId: string; tz: string; now: number }): ProjectBudget {
  const existing = db.prepare("SELECT * FROM project_budgets WHERE goal_id=?").get(input.goalId) as unknown as BudgetRow | undefined;
  if (existing) return projectBudgetFromRow(existing);
  const id = randomUUID();
  db.prepare(`INSERT INTO project_budgets
    (id, group_id, goal_id, period, tz, period_start, max_work_minutes, max_tokens, max_charge, warn_at, state, revision, raised_at, raised_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,NULL,0.8,'ok',0,NULL,NULL,?)`).run(
    id, input.groupId, input.goalId, "goal", input.tz, input.now, DEFAULT_GOAL_WORK_MINUTES, DEFAULT_GOAL_TOKENS, input.now,
  );
  return projectBudgetFromRow(db.prepare("SELECT * FROM project_budgets WHERE id=?").get(id) as unknown as BudgetRow);
}

/** Switching a project to ongoing creates its period budget (SPEC-P 5.7).
 * Idempotent per project: one non-goal budget per group (SQL unique index). */
export function createDefaultPeriodBudget(db: DatabaseSync, input: { groupId: string; period: "day" | "week" | "month"; tz: string; now: number }): ProjectBudget {
  const existing = db.prepare("SELECT * FROM project_budgets WHERE group_id=? AND period <> 'goal'").get(input.groupId) as unknown as BudgetRow | undefined;
  if (existing) return projectBudgetFromRow(existing);
  const id = randomUUID();
  db.prepare(`INSERT INTO project_budgets
    (id, group_id, goal_id, period, tz, period_start, max_work_minutes, max_tokens, max_charge, warn_at, state, revision, raised_at, raised_by, created_at)
    VALUES (?,?,NULL,?,?,?,?,?,NULL,0.8,'ok',0,NULL,NULL,?)`).run(
    id, input.groupId, input.period, input.tz, budgetPeriodStart(input.period, input.tz, input.now), DEFAULT_GOAL_WORK_MINUTES, DEFAULT_GOAL_TOKENS, input.now,
  );
  return projectBudgetFromRow(db.prepare("SELECT * FROM project_budgets WHERE id=?").get(id) as unknown as BudgetRow);
}
