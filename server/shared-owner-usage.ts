// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createProjectRunMatcher } from "./project-run-events.ts";

/** An owner turn in a work thread (no request row), settled once by its own turn (V7). */
export interface SharedOwnerRun { generation: string; botId: string; teamId: string; messageId: string; engine: string; model?: string; startedAt: number; waitingSince?: number; ownerWaitMs: number; asks: Set<string> }
export interface SharedOwnerEvent { type: string; threadId: string; turnId?: string; requestId?: string; ok?: boolean; usage?: unknown; cost?: number | null; charge?: number | null }
export type SharedOwnerOutcome = { ok: boolean; turnId?: string; usage?: unknown; cost?: number | null; charge?: number | null };

/** A late or duplicate completion of an earlier turn never settles, or ends, the thread's current owner turn (Astra r3 #3). */
export function createSharedOwnerUsage<E extends SharedOwnerEvent>(settle: (threadId: string, run: SharedOwnerRun, outcome: SharedOwnerOutcome) => void) {
  // `providerTurnId` is set once the provider names this generation's turn: from then on a completion without an id is not its own.
  const runs = new Map<string, SharedOwnerRun & { matcher: ReturnType<typeof createProjectRunMatcher<E>>; providerTurnId?: string }>();
  const finish = (threadId: string, outcome: SharedOwnerOutcome) => {
    const run = runs.get(threadId); if (!run) return;
    runs.delete(threadId);
    const { matcher: _matcher, providerTurnId: _providerTurnId, ...owned } = run;
    settle(threadId, owned, outcome);
  };
  const outcomeOf = (event: E): SharedOwnerOutcome => ({ ok: event.ok === true, turnId: event.turnId, usage: event.usage, cost: event.cost, charge: event.charge });
  return {
    has: (threadId: string) => runs.has(threadId),
    begin(threadId: string, run: SharedOwnerRun): void {
      const matcher = createProjectRunMatcher<E>(threadId);
      matcher.dispatch(run.generation);
      runs.set(threadId, { ...run, matcher });
    },
    /** The provider accepted this generation's turn under `turnId`. */
    accepted(threadId: string, generation: string, turnId: string): void {
      const run = runs.get(threadId); if (run?.generation !== generation) return;
      if (turnId) run.providerTurnId ??= turnId;
      const terminal = run.matcher.accept(generation, turnId);
      if (terminal) finish(threadId, outcomeOf(terminal));
    },
    /** `currentGeneration` is the generation the thread's live turn has now. */
    observe(event: E, currentGeneration: string | undefined): void {
      const run = runs.get(event.threadId); if (!run) return;
      const current = currentGeneration === undefined || currentGeneration === run.generation;
      if (current && event.type === "request.opened" && event.requestId) { if (!run.asks.size) run.waitingSince = Date.now(); run.asks.add(event.requestId); }
      if (current && event.type === "request.resolved" && event.requestId && run.asks.delete(event.requestId) && !run.asks.size) { run.ownerWaitMs += Date.now() - (run.waitingSince ?? Date.now()); delete run.waitingSince; }
      if (current && event.type === "turn.started" && event.turnId && currentGeneration === run.generation) run.providerTurnId ??= event.turnId;
      if (event.type !== "turn.completed") { run.matcher.observe(event, currentGeneration, false); return; }
      // An id-less completion is this generation's only while its provider turn is still unnamed (a late one from an earlier turn is not).
      const mine = run.matcher.observe(event, currentGeneration, false) || !event.turnId && currentGeneration === run.generation && !run.providerTurnId;
      if (mine) finish(event.threadId, outcomeOf(event));
    },
    /** This generation ended without a completion of its own (failed dispatch, stop, abandon). */
    end(threadId: string, generation: string): void {
      if (runs.get(threadId)?.generation === generation) finish(threadId, { ok: false });
    },
  };
}
