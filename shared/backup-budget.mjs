// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How long one backup may run (1.0.13). A plain .mjs so the Electron main
// process, the worker and the TypeScript server share one number.
//
// Decided once, in the desktop host, before anything closes. It is never
// written down: the coordinator's state stays readable by older builds. The
// in-app paths carry it on the relaunch beside the backup-mode flag; the
// closed-app path has no relaunch and keeps it in memory. Anything wrong with
// an input or with the carried value falls back to the stored limit, which is
// the limit every earlier build used.

import { MAX_BACKUP_BYTES } from "./backup-max-bytes.mjs";

/** The most any backup gets. Every clock on the way down accepts up to this. */
export const MAX_BACKUP_DURATION_MS = 4 * 60 * 60_000;
/** The outer bound on a closed-app run: the budget's cap plus start and cleanup. */
export const CLOSED_BACKUP_PROCESS_LIMIT_MS = MAX_BACKUP_DURATION_MS + 5 * 60_000;
export const BACKUP_BUDGET_ARGUMENT = "--murage-backup-budget=";

const GIB = 1024 ** 3;
const MIN_STORED_MS = 1000, MAX_STORED_MS = 30 * 60_000;
const MINUTES_PER_GIB_MS = 8 * 60_000, MARGIN_MS = 10 * 60_000;

/** The stored limit's own range (shared/backup-schedule.ts). */
export const validStoredDuration = value => Number.isSafeInteger(value) && value >= MIN_STORED_MS && value <= MAX_STORED_MS;

const usable = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;

/** The budget for one run, always a whole number from storedMs to 4 hours. A
 * term that is missing is left out; a term that is wrong means the whole
 * answer is storedMs, not the sum of what is left. A bad storedMs throws: the
 * run is refused, as it always was. */
export function decideBackupBudget({ storedMs, lastBytes, liveBytes, lastRunMs }) {
  if (!validStoredDuration(storedMs)) throw new Error("INVALID_BACKUP_BUDGET");
  const terms = [storedMs], sizes = [];
  for (const bytes of [lastBytes, liveBytes]) {
    if (bytes === undefined) continue;
    if (!usable(bytes, MAX_BACKUP_BYTES)) return storedMs;
    sizes.push(bytes);
  }
  if (sizes.length) terms.push(MINUTES_PER_GIB_MS * (Math.max(...sizes) / GIB) + MARGIN_MS);
  if (lastRunMs !== undefined) {
    if (!usable(lastRunMs, MAX_BACKUP_DURATION_MS)) return storedMs;
    terms.push(2 * lastRunMs + MARGIN_MS);
  }
  return Math.min(MAX_BACKUP_DURATION_MS, Math.ceil(Math.max(...terms)));
}

export const backupBudgetArgument = (handoffId, budgetMs) => `${BACKUP_BUDGET_ARGUMENT}${handoffId}:${budgetMs}`;

export const withoutBackupBudgetArgument = args => args.filter(arg => !String(arg).startsWith(BACKUP_BUDGET_ARGUMENT));

/** The budget the relaunch carried for this handoff, or storedMs: exactly one
 * value, for this handoff, from storedMs to 4 hours. */
export function readBackupBudgetArgument(argv, handoffId, storedMs) {
  const found = argv.filter(arg => String(arg).startsWith(BACKUP_BUDGET_ARGUMENT));
  if (found.length !== 1 || !handoffId) return storedMs;
  const match = /^([0-9a-f-]{36}):([1-9][0-9]{0,9})$/.exec(found[0].slice(BACKUP_BUDGET_ARGUMENT.length));
  if (!match || match[1] !== handoffId) return storedMs;
  const budgetMs = Number(match[2]);
  return Number.isSafeInteger(budgetMs) && budgetMs >= storedMs && budgetMs <= MAX_BACKUP_DURATION_MS ? budgetMs : storedMs;
}
