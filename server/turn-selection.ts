// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 SL-K K2: the ONE source of a turn's model selection, asked at every
// dispatch entry (direct turns, and through them routines, webhooks, channels
// and hand-offs; room member turns). Order:
//   1. a routine run: the BOT's own selection, never a pin on the reused
//      thread; only exception, the owner's limit backup "also for routines"
//      on an engine they already pay for while the bot's engine is at its limit;
//   2. a limit failover whose reset passed (none known: at + 60 min) ends and
//      the chat returns to what it was (following, or its own earlier pick);
//   3. the chat's own pick: when it is refused for a reason the owner fixes in
//      Settings (signed out, connection off, model not listed, disabled, not a
//      chat model, wrong protocol) while the bot's selection runs, the bot's
//      selection runs instead, with one line; the pick is never cleared;
//   4. the bot's selection.

import type { ModelSelection } from "./contracts.ts";

/** The refusals the base already turns into a 409 that the owner fixes in Settings (selectedProviderRoute). */
export const HEALABLE_ROUTE_CODES = ["needs-sign-in", "disabled", "model", "protocol"] as const;
export type RouteRefusalCode = typeof HEALABLE_ROUTE_CODES[number] | "plan-limit" | "unavailable" | "other";

export type RouteVerdict = { ok: true } | { ok: false; code: RouteRefusalCode };

export interface FailoverRowView {
  rowId: string;
  state: "pending" | "applied" | "restored" | "cancelled";
  was: "following" | ModelSelection;
  resetsAt: number | null;
  at: number;
}

export interface TurnSelectionTask { modelSelection?: ModelSelection; limitFailover?: string }
export interface TurnSelectionBot {
  name: string;
  modelSelection: ModelSelection;
  limitBackup?: { selection: ModelSelection; routines: boolean; at: number };
}

export interface TurnSelectionDeps {
  /** Would this selection route now (a check only: no key is issued). */
  routes(selection: ModelSelection): RouteVerdict;
  /** The failover row a chat carries, if it is still known. */
  failoverRow(rowId: string): FailoverRowView | undefined;
  /** Is the engine this selection bills to at its limit now (limit-state.json). */
  atLimit(selection: ModelSelection, now: number): boolean;
  /** May a routine continue on this backup (owner said so for routines, own plan or own key, allowed pair). */
  routineBackupAllowed(bot: TurnSelectionBot): boolean;
}

export interface TurnSelectionResult {
  selection: ModelSelection;
  /** one activity line for the chat */
  line?: string;
  /** step 2: the failover ended; the caller writes this onto the chat and marks the row restored */
  restore?: { rowId: string; to: "following" | ModelSelection };
  /** step 1: a routine continues on the owner's backup */
  routineBackup?: true;
}

export const FAILOVER_NO_RESET_MS = 60 * 60_000;

export function failoverResetAt(row: Pick<FailoverRowView, "resetsAt" | "at">): number {
  return row.resetsAt ?? row.at + FAILOVER_NO_RESET_MS;
}

export function healedLine(botName: string): string {
  return `Ran on ${botName}'s model because this chat's own model is not available`;
}

const clone = (selection: ModelSelection): ModelSelection => structuredClone(selection);

export function resolveTurnSelection(
  task: TurnSelectionTask | null,
  bot: TurnSelectionBot,
  origin: { routine: boolean },
  now: number,
  deps: TurnSelectionDeps,
): TurnSelectionResult {
  // 1. a routine run resolves from the bot, never from its thread's pin
  if (origin.routine) {
    const backup = bot.limitBackup;
    if (backup && deps.atLimit(bot.modelSelection, now) && deps.routineBackupAllowed(bot) && deps.routes(backup.selection).ok) {
      return { selection: clone(backup.selection), routineBackup: true };
    }
    return { selection: clone(bot.modelSelection) };
  }
  let own = task?.modelSelection;
  let restore: TurnSelectionResult["restore"];
  // 2. a failover whose reset passed returns the chat to what it was
  if (task?.limitFailover) {
    const row = deps.failoverRow(task.limitFailover);
    if (row && row.state === "applied" && failoverResetAt(row) <= now) {
      restore = { rowId: row.rowId, to: row.was === "following" ? "following" : clone(row.was) };
      own = row.was === "following" ? undefined : row.was;
    }
  }
  // 3. the chat's own pick, healed onto the bot's selection only for a Settings-fixable refusal
  if (own) {
    const verdict = deps.routes(own);
    if (!verdict.ok && (HEALABLE_ROUTE_CODES as readonly string[]).includes(verdict.code) && deps.routes(bot.modelSelection).ok) {
      return { selection: clone(bot.modelSelection), line: healedLine(bot.name), ...(restore ? { restore } : {}) };
    }
    return { selection: clone(own), ...(restore ? { restore } : {}) };
  }
  // 4. the bot's selection
  return { selection: clone(bot.modelSelection), ...(restore ? { restore } : {}) };
}
