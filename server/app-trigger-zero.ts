import { serviceNoLimits, serviceThreadNoLimits } from './service-no-limits.ts';
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Below No limits, never-list entry (a) still applies: a routine started by a
// connected-app event never starts or hands work to other bots. MAIN ruling
// 2026-11-12: Sean's wipe-only No limits rule explicitly includes app events.
// Below No limits, app-origin child work retains the 1.0.18 hard zero and its
// persisted refusal card. Authenticated No limits turns and recovered runs use
// live owner policy at every entry, queue and card-recovery seam. Tool bodies
// cannot choose that policy or their app lineage.
import type { AppChildCard, AppChildRefusalReceipt, AppEventRun } from "./app-trigger-store.ts";

export const APP_CHILD_NOT_ALLOWED = "app_child_not_allowed" as const;

/** The card's words (rule 4, rule 9): what happened and the way forward. */
export const APP_CHILD_CARD_TEXT =
  "This routine started from a connected-app event, so it can't start or hand work to other bots. Ask your bot to set up what you need as a scheduled routine, or do this step yourself.";
/** Navigation only. */
export const APP_CHILD_CARD_ACTIONS = Object.freeze(["open_routine", "ask_my_bot"] as const);

export type AppChildKind = AppChildRefusalReceipt["kind"];

/** The store calls this guard needs; AppTriggerStore provides all of them. */
export interface AppChildLineage {
  findByThread(threadId: string, generation?: string): AppEventRun | null;
  findById(runId: string): AppEventRun | null;
  recordChildRefusal(runId: string, kind: AppChildKind, now: number): { first: boolean };
  markCardWritten(runId: string, card: AppChildCard): boolean;
  cardsOwed(limit: number): AppEventRun[];
}

export interface AppChildRefusal { code: typeof APP_CHILD_NOT_ALLOWED; runId: string; first: boolean }

/** Thrown at a seam that has no reply of its own (a queue write, a recovered start): the step never happens. */
export class AppChildNotAllowed extends Error {
  readonly code = APP_CHILD_NOT_ALLOWED;
  readonly status = 403;
  readonly runId: string;
  constructor(runId: string) { super(APP_CHILD_CARD_TEXT); this.runId = runId; this.name = "AppChildNotAllowed"; }
}

interface Wiring { noLimits?: (run: AppEventRun) => boolean; lineage: AppChildLineage; now: () => number; onCard?: (card: AppChildCard) => void; defer: (work: () => void) => void }
let wiring: Wiring | null = null;

/** The host wires the store once at start-up (server/index.ts). Before that no app run can exist: the store is the only
 * place one is created. `onCard` shows a written card in the run thread; the persisted card is the record. */
export function wireAppChildGuard(options: { noLimits?: (run: AppEventRun) => boolean; lineage: AppChildLineage; now?: () => number; onCard?: (card: AppChildCard) => void; defer?: (work: () => void) => void } | null): void {
  wiring = options ? { noLimits: options.noLimits, lineage: options.lineage, now: options.now ?? Date.now, onCard: options.onCard, defer: options.defer ?? queueMicrotask } : null;
}

/** The app run behind a turn, from host lineage. A lookup that fails is treated as app context (fail closed).
 * Any app run on the thread counts, whatever the turn's generation: every turn in an app run's thread gets a new
 * generation, so matching on it would let a later turn of the same run through (GrokBuild r1 H1). The run thread is
 * recorded before its first turn starts (AppTriggerDelivery.start), so no turn of the run precedes its lineage. */
function appRunFor(threadId: string): AppEventRun | null | "unknown" {
  if (!wiring || !threadId) return null;
  try { const run = wiring.lineage.findByThread(threadId); return run && wiring.noLimits?.(run) ? null : run; }
  catch { return "unknown"; }
}

/**
 * THE check, at the top of every child entry (create-bot, ask-bot, delegate-bot) and before any card or ledger.
 * Returns null for a turn that is not app-origin; otherwise persists the refusal receipt and returns the refusal, and
 * the explanation card is written after the caller has returned it.
 */
export function refuseAppChild(context: { threadId: string; generation?: string }, kind: AppChildKind): AppChildRefusal | null {
  if (context.generation ? serviceNoLimits(context.generation, context.threadId) : serviceThreadNoLimits(context.threadId)) return null;
  const run = appRunFor(context.threadId);
  if (run === null) return null;
  if (run === "unknown") return { code: APP_CHILD_NOT_ALLOWED, runId: "", first: false };
  let first = false;
  try { first = wiring!.lineage.recordChildRefusal(run.runId, kind, wiring!.now()).first; }
  catch { /* the refusal stands without its receipt; nothing is dispatched either way */ }
  if (first) { const runId = run.runId; wiring!.defer(() => { writeOwedCard(runId); }); }
  return { code: APP_CHILD_NOT_ALLOWED, runId: run.runId, first };
}

/** For seams with no reply: a queue write or a recovered start from an app thread throws before it changes anything. */
export function assertNotAppChild(threadId: string, kind: AppChildKind, generation?: string): void {
  const refusal = refuseAppChild({ threadId, ...(generation === undefined ? {} : { generation }) }, kind);
  if (refusal) throw new AppChildNotAllowed(refusal.runId);
}

/** Whether a turn is app-origin, with no side effect (the event-action wrapper's own check). */
export function isAppChildContext(threadId: string, _generation?: string): boolean {
  if (_generation ? serviceNoLimits(_generation, threadId) : serviceThreadNoLimits(threadId)) return false;
  return appRunFor(threadId) !== null;
}

/** The one explanation card of a run, from its receipt. Deterministic: the same receipt always gives the same card. */
export function explanationCard(run: Pick<AppEventRun, "runId" | "routineId">): AppChildCard {
  return { id: `app-child-refusal:${run.runId}`, runId: run.runId, routineId: run.routineId, text: APP_CHILD_CARD_TEXT, actions: APP_CHILD_CARD_ACTIONS };
}

/** Write the run's card if its receipt owes one. Idempotent: at most one card per run, however often it is called. */
export function writeOwedCard(runId: string): AppChildCard | null {
  if (!wiring) return null;
  const run = wiring.lineage.findById(runId);
  if (!run?.childRefusal || run.childCardWritten || wiring.noLimits?.(run) || run.threadId && serviceThreadNoLimits(run.threadId, run.botId)) return null;
  const card = explanationCard(run);
  if (!wiring.lineage.markCardWritten(runId, card)) return null;
  try { wiring.onCard?.(card); } catch { /* the card is recorded; showing it again is the thread's job */ }
  return card;
}

/** After a restart: every receipt whose card was not written yet gets it now, without running anything. Bounded. */
export function rebuildOwedCards(limit = 100): number {
  if (!wiring) return 0;
  let written = 0;
  for (const run of wiring.lineage.cardsOwed(limit)) if (writeOwedCard(run.runId)) written++;
  return written;
}
