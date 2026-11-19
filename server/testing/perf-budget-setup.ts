// SPDX-License-Identifier: AGPL-3.0-or-later
import { loadavg } from "node:os";
import { afterEach, beforeEach } from "vitest";
import { guardPerfBudget, perfBudgetDecision } from "../../scripts/gate/perf-budget.mjs";

declare module "vitest" {
  interface TaskMeta { perfQuietHost?: boolean }
}

// Snapshot the invocation's opt-in before any test can mutate its environment.
const env = { MURAGE_PERF_QUIET_HOST: process.env.MURAGE_PERF_QUIET_HOST };
beforeEach(context => {
  if (!context.task.tags?.includes("perf-budget")) return;
  guardPerfBudget(`${context.task.file.name} > ${context.task.name}`, message => context.skip(message), env, loadavg()[0]);
  context.task.meta.perfQuietHost = true;
});
afterEach(context => {
  if (context.task.meta.perfQuietHost !== true) return;
  // A run that became busy during a bound cannot produce a green C6 receipt.
  const decision = perfBudgetDecision(env, loadavg()[0]);
  if (decision.mode !== "enforced") throw new Error(decision.message);
});
