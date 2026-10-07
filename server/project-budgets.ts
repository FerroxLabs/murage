// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import type { DatabaseSync } from "node:sqlite";
import { projectBudgetsForGroup, type ProjectBudget } from "./project-defaults.ts";
import { projectUsage } from "./usage-ledger.ts";
import { budgetPeriodStart } from "./project-budget-period.ts";
import { pauseProjectGoal } from "./project-goals.ts";
import { setProjectRunState } from "./project-settings.ts";
import { insertProjectActivity } from "./project-records.ts";
import type { BudgetGate } from "./work-admission.ts";
export { budgetPeriodStart } from "./project-budget-period.ts";
export interface RunningBudgetWork { groupId: string; goalId?: string | null; workMs: number; startedAt?: number }
export interface ProjectBudgetGate extends BudgetGate { checkLearning(input: { groupId: string; now: number }): ReturnType<BudgetGate["check"]>; evaluate(groupId: string, now: number): void; usage(budget: ProjectBudget, now: number): { workMs: number; tokens: number } }
const minutes = (ms: number) => { const m = Math.floor(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60}` : ""}` : `${m} min`; };
const tokens = (n: number) => n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
export function budgetReachedLine(budget: ProjectBudget, usage: { workMs: number; tokens: number }): string {
  return `Budget reached: ${minutes(usage.workMs)} of ${minutes(budget.maxWorkMinutes * 60000)}${budget.maxTokens === null ? "" : `, ${tokens(usage.tokens)} of ${tokens(budget.maxTokens)} tokens`}. Raise it or stop.`;
}
export function createProjectBudgetGate(db: DatabaseSync, hooks: { running?: () => RunningBudgetWork[]; line?: (groupId: string, line: string) => void; changed?: (groupId: string) => void; enabled?: () => boolean;
  /** The budget is used up: stop the card work running in its scope (a goal's, or the whole project's for a period budget). Called on every evaluation while over, so work that slipped in is stopped too. */
  stop?: (groupId: string, goalId: string | null) => void } = {}): ProjectBudgetGate {
  const usage = (budget: ProjectBudget, now: number) => {
    const settled = projectUsage(db, { groupId: budget.groupId, ...(budget.goalId ? { goalId: budget.goalId } : { since: budget.periodStart }) }).totals;
    let workMs = settled.workMs;
    for (const turn of hooks.running?.() ?? []) {
      if (turn.groupId !== budget.groupId || (budget.goalId && turn.goalId !== budget.goalId)) continue;
      const clip = budget.goalId ? turn.workMs : Math.min(turn.workMs, Math.max(0, now - Math.max(budget.periodStart, turn.startedAt ?? budget.periodStart)));
      workMs += Math.max(0, clip);
    }
    return { workMs, tokens: settled.input + settled.output };
  };
  const evaluate = (groupId: string, now: number) => {
    if (hooks.enabled?.() === false) return;
    for (let budget of projectBudgetsForGroup(db, groupId)) {
      if(budget.goalId && db.prepare("SELECT 1 FROM project_goals WHERE id=? AND state IN ('done','stopped','failed')").get(budget.goalId))continue;
      if (budget.period !== "goal") {
        const start = budgetPeriodStart(budget.period, budget.tz, now);
        if (start !== budget.periodStart) {
          db.prepare("UPDATE project_budgets SET period_start=?,state='ok',revision=revision+1 WHERE id=?").run(start, budget.id);
          budget = { ...budget, periodStart: start, state: "ok", revision: budget.revision + 1 };
        }
      }
      const used = usage(budget, now);
      const ratio = Math.max(used.workMs / (budget.maxWorkMinutes * 60000), budget.maxTokens === null ? 0 : used.tokens / budget.maxTokens);
      const state = ratio >= 1 ? "paused" : ratio >= budget.warnAt ? "warned" : "ok";
      // The budget, not a clock, is what ends long card work (SPEC-P 5.4, 2026-09-29).
      // Deferred: evaluate() also runs inside an admission check, which must not
      // stop turns (and settle their usage) in the middle of admitting another.
      if (state === "paused") { const goalId = budget.goalId ?? null; queueMicrotask(() => hooks.stop?.(groupId, goalId)); }
      // A raise explicitly recomputes downwards; normal evaluation only advances.
      if (state === "ok" || budget.state === "paused" || budget.state === state) continue;
      db.prepare("UPDATE project_budgets SET state=?,revision=revision+1 WHERE id=?").run(state, budget.id);
      const line = state === "paused" ? budgetReachedLine(budget, used) : `This ${budget.goalId ? "goal" : "project"} has used ${Math.floor(ratio * 100)}% of its budget: ${minutes(used.workMs)} of ${minutes(budget.maxWorkMinutes * 60000)}.`;
      if (state === "paused") {
        if (budget.goalId) pauseProjectGoal(db, { goalId: budget.goalId, reason: line, actor: { kind: "server" }, now });
        else setProjectRunState(db, { groupId, runState: "paused", reason: line, actor: { kind: "server" }, now });
      }
      insertProjectActivity(db, { groupId, goalId: budget.goalId, kind: state === "paused" ? "budget_paused" : "budget_warned", actor: "server", at: now, detail: { budgetId: budget.id, line } });
      hooks.line?.(groupId, line); hooks.changed?.(groupId);
    }
  };
  const checkLearning:ProjectBudgetGate["checkLearning"]=input=>{
    if(hooks.enabled?.()===false)return {ok:true};
    for(let budget of projectBudgetsForGroup(db,input.groupId)){
      if(budget.goalId&&!db.prepare("SELECT 1 FROM project_goals WHERE id=? AND state NOT IN ('done','stopped','failed')").get(budget.goalId))continue;
      if(budget.period!=="goal")budget={...budget,periodStart:budgetPeriodStart(budget.period,budget.tz,input.now)};
      const used=usage(budget,input.now);
      if(used.workMs>=budget.maxWorkMinutes*60000||budget.maxTokens!==null&&used.tokens>=budget.maxTokens)return {ok:false,budgetId:budget.id,line:budgetReachedLine(budget,used)};
    }
    return {ok:true};
  };
  return { usage, evaluate, checkLearning, check(input) {
    if (hooks.enabled?.() === false) return { ok: true };
    evaluate(input.groupId, input.now);
    for (const budget of projectBudgetsForGroup(db, input.groupId)) {
      if (budget.goalId && budget.goalId !== input.goalId) continue;
      const used = usage(budget, input.now);
      if (budget.state === "paused" || used.workMs >= budget.maxWorkMinutes * 60000 || (budget.maxTokens !== null && used.tokens >= budget.maxTokens)) return { ok: false, budgetId: budget.id, line: budgetReachedLine(budget, used) };
    }
    return { ok: true };
  } };
}
export function patchProjectBudget(db: DatabaseSync, input: { budgetId: string; expectedRevision: number; maxWorkMinutes?: number; maxTokens?: number; warnAt?: number; tz?: string; now: number }, gate: ProjectBudgetGate): { ok: true; budget: ProjectBudget } | { ok: false; budget?: ProjectBudget } {
  const row = db.prepare("SELECT group_id FROM project_budgets WHERE id=?").get(input.budgetId);
  if (!row) return { ok: false };
  const budget = projectBudgetsForGroup(db, String(row.group_id)).find(b => b.id === input.budgetId)!;
  if (budget.revision !== input.expectedRevision) return { ok: false, budget };
  const next = { ...budget, maxWorkMinutes: input.maxWorkMinutes ?? budget.maxWorkMinutes, maxTokens: input.maxTokens ?? budget.maxTokens, warnAt: input.warnAt ?? budget.warnAt, tz: input.tz ?? budget.tz };
  if (next.period !== "goal") next.periodStart = budgetPeriodStart(next.period, next.tz, input.now);
  const used = gate.usage(next, input.now);
  const ratio = Math.max(used.workMs / (next.maxWorkMinutes * 60000), next.maxTokens === null ? 0 : used.tokens / next.maxTokens);
  // Leave crossing to evaluate so it produces the pause effects exactly once.
  const state = ratio >= 1 ? (budget.state === "paused" ? "paused" : "ok") : ratio >= next.warnAt ? "warned" : "ok";
  db.prepare("UPDATE project_budgets SET max_work_minutes=?,max_tokens=?,warn_at=?,tz=?,period_start=?,state=?,revision=revision+1,raised_at=?,raised_by='owner' WHERE id=?").run(next.maxWorkMinutes,next.maxTokens,next.warnAt,next.tz,next.periodStart,state,input.now,budget.id);
  insertProjectActivity(db, { groupId: budget.groupId, goalId: budget.goalId, kind: "budget_raised", actor: "owner", at: input.now, detail: { budgetId: budget.id } });
  gate.evaluate(budget.groupId, input.now);
  return { ok: true, budget: projectBudgetsForGroup(db, budget.groupId).find(b => b.id === budget.id)! };
}
