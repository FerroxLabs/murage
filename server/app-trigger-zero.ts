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
import type { AppChildCard, AppChildRefusalReceipt, AppEventRun, AppOriginThread, AppTurnLineage } from "./app-trigger-store.ts";

export const APP_CHILD_NOT_ALLOWED = "app_child_not_allowed" as const;

/** The card's words (rule 4, rule 9): what happened and the way forward. */
export const APP_CHILD_CARD_TEXT =
  "This routine started from a connected-app event, so it can't start or hand work to other bots. Ask your bot to set up what you need as a scheduled routine, or do this step yourself.";
/** L5H (Fable r2 L3): the same refusal in an app automation's Results chat, which is not a run. */
export const APP_CHILD_RESULTS_CARD_TEXT =
  "This is a connected-app automation's results chat, so work here can't start or hand work to other bots. Ask your bot to set up what you need as a scheduled routine, or do this step yourself.";
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
  /** L5H C1/C2 (AppTriggerStore provides these; a lineage without them reads findByThread, as before L5H). */
  lineageOf?(threadId: string, generation?: string): AppTurnLineage;
  origin?(threadId: string): AppOriginThread | null;
  recordThreadRefusal?(threadId: string, kind: AppChildKind, now: number): { first: boolean };
  markThreadCardWritten?(threadId: string, card: AppChildCard): boolean;
  threadCardsOwed?(limit: number): AppOriginThread[];
}

export interface AppChildRefusal { code: typeof APP_CHILD_NOT_ALLOWED; runId: string; first: boolean }

/** Thrown at a seam that has no reply of its own (a queue write, a recovered start): the step never happens. */
export class AppChildNotAllowed extends Error {
  readonly code = APP_CHILD_NOT_ALLOWED;
  readonly status = 403;
  readonly runId: string;
  constructor(runId: string) { super(APP_CHILD_CARD_TEXT); this.runId = runId; this.name = "AppChildNotAllowed"; }
}

interface Wiring { noLimitsContext?: (threadId: string, generation?: string, botId?: string) => boolean; noLimits?: (run: AppEventRun) => boolean; lineage: AppChildLineage; now: () => number; stopConfirmed?: (generation: string) => boolean; onCard?: (card: AppChildCard, threadId: string) => void; defer: (work: () => void) => void }
let wiring: Wiring | null = null;

/** The host wires the store once at start-up (server/index.ts). Before that no app run can exist: the store is the only
 * place one is created. `onCard` shows a written card in the run thread; the persisted card is the record. */
export function wireAppChildGuard(options: { noLimitsContext?: Wiring["noLimitsContext"]; noLimits?: (run: AppEventRun) => boolean; lineage: AppChildLineage; now?: () => number; stopConfirmed?: Wiring["stopConfirmed"]; onCard?: Wiring["onCard"]; defer?: (work: () => void) => void } | null): void {
  wiring = options ? { noLimitsContext: options.noLimitsContext, noLimits: options.noLimits, lineage: options.lineage, now: options.now ?? Date.now, stopConfirmed: options.stopConfirmed, onCard: options.onCard, defer: options.defer ?? queueMicrotask } : null;
}

/** An app-origin turn below No limits: the run credited with it (C2), or none (the receipt then goes on the thread). */
interface AppTurn { run: AppEventRun | null; threadId: string; origin: AppOriginThread | null }

/** L5H C1 + C2 + C3: the app lineage behind a turn, from host lineage only. The origin row makes a thread app-origin whatever
 * run rows remain (C1); the credited run is the one owning exactly this (thread, generation), or for a thread-only seam the
 * thread's single open run turn, never the newest run (C2); No limits is read from that credited run only (C3). A turn no run
 * owns stays app-origin. A lookup that fails is treated as app context (fail closed). */
function appRunFor(threadId: string, generation?: string): AppTurn | null | "unknown" {
  if (!wiring || !threadId) return null;
  try {
    const lineage: AppTurnLineage = wiring.lineage.lineageOf
      ? wiring.lineage.lineageOf(threadId, generation)
      : (() => { const run = wiring!.lineage.findByThread(threadId); return { appOrigin: run !== null, run, origin: null }; })();
    if (!lineage.appOrigin) return null;
    if (lineage.run && wiring.noLimits?.(lineage.run)) return null;
    return { run: lineage.run, threadId, origin: lineage.origin };
  } catch { return "unknown"; }
}

function noLimitsContext(threadId: string, generation?: string, botId?: string): boolean {
  try { return wiring?.noLimitsContext?.(threadId, generation, botId) === true; }
  catch { return false; }
}

/**
 * THE check, at the top of every child entry (create-bot, ask-bot, delegate-bot) and before any card or ledger.
 * Returns null for a turn that is not app-origin; otherwise persists the refusal receipt and returns the refusal, and
 * the explanation card is written after the caller has returned it.
 */
export function refuseAppChild(context: { threadId: string; generation?: string }, kind: AppChildKind): AppChildRefusal | null {
  if (noLimitsContext(context.threadId, context.generation)) return null;
  const turn = appRunFor(context.threadId, context.generation);
  if (turn === null) return null;
  if (turn === "unknown") return { code: APP_CHILD_NOT_ALLOWED, runId: "", first: false };
  const run = turn.run;
  // Freeze at the refusal. An interrupt still waiting for its close leaves this receipt owed.
  if (context.generation && wiring!.stopConfirmed?.(context.generation)) {
    return { code: APP_CHILD_NOT_ALLOWED, runId: run?.runId ?? "", first: false };
  }
  let first = false;
  if (run) {
    try { first = wiring!.lineage.recordChildRefusal(run.runId, kind, wiring!.now()).first; }
    catch { /* the refusal stands without its receipt; nothing is dispatched either way */ }
    if (first) { const runId = run.runId; wiring!.defer(() => { writeOwedCard(runId); }); }
    return { code: APP_CHILD_NOT_ALLOWED, runId: run.runId, first };
  }
  // C2 credit field: a turn owned by no run puts its receipt on the origin row, once per thread
  if (turn.origin && wiring!.lineage.recordThreadRefusal) {
    try { first = wiring!.lineage.recordThreadRefusal(turn.threadId, kind, wiring!.now()).first; }
    catch { /* the refusal stands without its receipt */ }
    if (first) { const threadId = turn.threadId; wiring!.defer(() => { writeOwedThreadCard(threadId); }); }
  }
  return { code: APP_CHILD_NOT_ALLOWED, runId: "", first };
}

/** For seams with no reply: a queue write or a recovered start from an app thread throws before it changes anything. */
export function assertNotAppChild(threadId: string, kind: AppChildKind, generation?: string): void {
  const refusal = refuseAppChild({ threadId, ...(generation === undefined ? {} : { generation }) }, kind);
  if (refusal) throw new AppChildNotAllowed(refusal.runId);
}

/** Whether a turn is app-origin, with no side effect (the event-action wrapper's own check). */
export function isAppChildContext(threadId: string, generation?: string): boolean {
  if (noLimitsContext(threadId, generation)) return false;
  return appRunFor(threadId, generation) !== null;
}

/** The one explanation card of a run, from its receipt. Deterministic: the same receipt always gives the same card. */
export function explanationCard(run: Pick<AppEventRun, "runId" | "routineId">): AppChildCard {
  return { id: `app-child-refusal:${run.runId}`, runId: run.runId, routineId: run.routineId, text: APP_CHILD_CARD_TEXT, actions: APP_CHILD_CARD_ACTIONS };
}

/** Write the run's card if its receipt owes one. Idempotent: at most one card per run, however often it is called. */
export function writeOwedCard(runId: string): AppChildCard | null {
  if (!wiring) return null;
  const run = wiring.lineage.findById(runId);
  if (!run?.childRefusal || run.childCardWritten || wiring.noLimits?.(run) || run.threadId && noLimitsContext(run.threadId, undefined, run.botId)) return null;
  const card = explanationCard(run);
  // The host writes by stable id, so restart can retry if it crashed before the receipt was stamped.
  try { if (run.threadId) wiring.onCard?.(card, run.threadId); } catch { return null; }
  if (!wiring.lineage.markCardWritten(runId, card)) return null;
  return card;
}

/** L5H: the one card of a thread no run owns, from the origin row's receipt. */
export function threadExplanationCard(origin: Pick<AppOriginThread, "threadId" | "kind" | "routineId" | "firstRunId">): AppChildCard {
  return { id: `app-child-refusal:thread:${origin.threadId}`, runId: origin.firstRunId ?? "", routineId: origin.routineId, text: origin.kind === "results" ? APP_CHILD_RESULTS_CARD_TEXT : APP_CHILD_CARD_TEXT, actions: APP_CHILD_CARD_ACTIONS };
}

/** Write the thread card if its receipt owes one, once per thread. Suppressed under live owner No limits, as the run card is. */
export function writeOwedThreadCard(threadId: string): AppChildCard | null {
  if (!wiring?.lineage.origin || !wiring.lineage.markThreadCardWritten) return null;
  const origin = wiring.lineage.origin(threadId);
  if (!origin?.childRefusal || origin.childCardWritten || noLimitsContext(threadId)) return null;
  const card = threadExplanationCard(origin);
  try { wiring.onCard?.(card, threadId); } catch { return null; }
  if (!wiring.lineage.markThreadCardWritten(threadId, card)) return null;
  return card;
}

/** After a restart: every receipt whose card was not written yet gets it now, without running anything. Bounded, over
 * both owed sets (run receipts and thread receipts). */
export function rebuildOwedCards(limit = 100): number {
  if (!wiring) return 0;
  let written = 0;
  for (const run of wiring.lineage.cardsOwed(limit)) if (writeOwedCard(run.runId)) written++;
  for (const origin of wiring.lineage.threadCardsOwed?.(limit) ?? []) if (writeOwedThreadCard(origin.threadId)) written++;
  return written;
}
