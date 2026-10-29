// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The hard zero for child automation (design GAP-APP-TRIGGERS-109 section 7.1, R3-H2; never-list entry (a)):
// "A routine started by a connected-app event never starts or hands work to other bots, because someone outside your
// control chose when it runs."
//
// App-origin create, ask-bot and delegate attempts return `app_child_not_allowed` BEFORE any approval card, budget
// admission, bot creation, queue write or child submission. This guard is independent of the legacy EventActionBudget:
// an app run never has one, and runEventAction (server/event-limit.ts) must never be reached for app context, because
// with no event id it runs the step directly. App context is resolved from host lineage (the app run that owns the
// thread and generation), never from a caller's label. There is no transition from zero to positive capacity: Full
// access, a stale Allow-more reply, an approval or a restart cannot widen it.
//
// The first refusal in a run leaves exactly one explanation card, built from the persisted refusal receipt after the
// refusal has returned, with ordinary navigation only (Open routine, Ask my bot): no Allow, Approve, Retry or Allow
// more, no pending call, nothing that can enqueue, extend or resume the refused step. A restart rebuilds an owed card
// from the receipt without running anything.
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

interface Wiring { lineage: AppChildLineage; now: () => number; onCard?: (card: AppChildCard) => void; defer: (work: () => void) => void }
let wiring: Wiring | null = null;

/** The host wires the store once at start-up (server/index.ts). Before that no app run can exist: the store is the only
 * place one is created. `onCard` shows a written card in the run thread; the persisted card is the record. */
export function wireAppChildGuard(options: { lineage: AppChildLineage; now?: () => number; onCard?: (card: AppChildCard) => void; defer?: (work: () => void) => void } | null): void {
  wiring = options ? { lineage: options.lineage, now: options.now ?? Date.now, onCard: options.onCard, defer: options.defer ?? queueMicrotask } : null;
}

/** The app run behind a turn, from host lineage. A lookup that fails is treated as app context (fail closed). */
function appRunFor(threadId: string, generation?: string): AppEventRun | null | "unknown" {
  if (!wiring || !threadId) return null;
  try { return wiring.lineage.findByThread(threadId, generation); }
  catch { return "unknown"; }
}

/**
 * THE check, at the top of every child entry (create-bot, ask-bot, delegate-bot) and before any card or ledger.
 * Returns null for a turn that is not app-origin; otherwise persists the refusal receipt and returns the refusal, and
 * the explanation card is written after the caller has returned it.
 */
export function refuseAppChild(context: { threadId: string; generation?: string }, kind: AppChildKind): AppChildRefusal | null {
  const run = appRunFor(context.threadId, context.generation);
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
export function isAppChildContext(threadId: string, generation?: string): boolean {
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
  if (!run?.childRefusal || run.childCardWritten) return null;
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
