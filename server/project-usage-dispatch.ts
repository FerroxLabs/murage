import { isSharedWorkRow } from "./shared-work.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SendTurnInput, TurnStartResult } from "./contracts.ts";
import type { RoomRequest } from "./room-requests.ts";
import { BUDGET_STOPPED } from "./project-card-executor.ts";

/** Why the server (not the owner) stopped a run: the card's note and the line in its thread. */
export interface ServerStop { note: string; line: string }
export const BUDGET_STOP: ServerStop = { note: BUDGET_STOPPED, line: "its project budget was reached" };

export interface ProjectUsageRun { request: RoomRequest; generation: string; botId: string; engine: string; model?: string; providerTurnId?: string; settled?: boolean; asks?: Set<string>;
  /** Stops this run's own turn (never the next turn on the desk thread). */
  stop?: (reason?: ServerStop) => void; budgetStopped?: boolean }

/** Card work: an assignment, a review, or a lead wake that works a card. It
 * has no clock (SPEC-P 5.4 as revised 2026-09-29: the 30-minute active-work
 * cap is gone). It stops on silence (the stall watchdog), the owner's Stop,
 * or its project or goal budget; room replies stop on silence or Stop. */
export function budgetStopsRun(request: Pick<RoomRequest, "verb" | "workItemId">): boolean {
  return request.verb === "assign" || request.verb === "review" || (request.verb === "wake" && Boolean(request.workItemId));
}

/** A budget is used up: stop the card work running in its scope, once each.
 * A run parked on the owner's decision spends nothing and is left to finish
 * deciding; the next evaluation stops it once the decision is made. */
export function stopRunsOverBudget(runs: Iterable<ProjectUsageRun>, groupId: string, goalId: string | null): number {
  let stopped = 0;
  for (const run of new Set(runs)) {
    if (run.settled || run.budgetStopped || !run.stop || run.request.groupId !== groupId || !budgetStopsRun(run.request)) continue;
    if (goalId !== null && run.request.projectGoalId !== goalId) continue;
    if (run.asks?.size) continue;
    run.budgetStopped = true;
    stopped += 1;
    run.stop(BUDGET_STOP);
  }
  return stopped;
}

/** Register the request before an adapter can emit even a synchronous event. */
export async function dispatchProjectUsageTurn(turn: SendTurnInput, run: ProjectUsageRun, deps: {
  bindings: Map<string, string>; pending: Map<string, ProjectUsageRun>; turns: Map<string, ProjectUsageRun>;
  project: boolean; send(turn: SendTurnInput): Promise<TurnStartResult>; interrupt(reason?: ServerStop): void; failure(run: ProjectUsageRun): void;
}): Promise<TurnStartResult> {
  deps.bindings.set(run.generation, run.request.id);
  run.stop = deps.interrupt;
  deps.pending.set(turn.threadId, run);
  try {
    const result = await deps.send({ ...turn, ...(deps.project || isSharedWorkRow(run.request) ? { holdPermissionAsks: true, holdProjectAsks: true } : {}) });
    run.providerTurnId = result.turnId;
    if (!run.settled) deps.turns.set(JSON.stringify([turn.threadId, result.turnId]), run);
    return result;
  } catch (error) {
    if (!run.settled) deps.failure(run);
    run.settled = true;
    for (const [key, entry] of deps.turns) if (entry === run) deps.turns.delete(key);
    if (deps.bindings.get(run.generation) === run.request.id) deps.bindings.delete(run.generation);
    throw error;
  } finally {
    if (deps.pending.get(turn.threadId) === run) deps.pending.delete(turn.threadId);
  }
}

/** One owner wait spans all open asks, including permission and question asks. */
export function accountProjectOwnerWait(run: ProjectUsageRun, event: { type: string; requestId?: string }, enter: () => void, leave: () => void): void {
  if (!event.requestId) return;
  const asks = run.asks ??= new Set<string>();
  if (event.type === "request.opened" && !asks.has(event.requestId)) {
    const first = asks.size === 0;
    asks.add(event.requestId);
    if (first) enter();
  } else if (event.type === "request.resolved" && asks.delete(event.requestId)) {
    if (!asks.size) leave();
  }
}

/** A folder wait is work time. Only a presented approval starts owner wait. */
export function accountPresentedProjectEvent(event: { type: string }, hold: () => boolean, account: () => void): boolean {
  if (event.type === "request.opened" && hold()) return false;
  account();
  return true;
}
