// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-MEANS-IT section 2: whether a turn is one the owner started himself, at the app or his paired phone, in a
// direct chat. It is judged fresh at every start, never inherited, and is never an opt, a message field or a disk
// value: the answer lives only in the run's own record, by generation, and is read back at each ask.

import type { FullAccessOrigin } from "./auto-approve.ts";
import { isOwnerOrigin, type MessageOrigin } from "./store.ts";

/** Each of these on a start means something other than the owner's own new line began this turn. */
const NOT_THE_OWNERS_START = [
  "automationSource", "unattended", "via", "commsDepth", "delegationRun", "cardContinuation", "askerWake",
  "routineRunId", "routineAuthority", "projectCardRun", "sharedWorkRun",
] as const;
export type StartMarks = { [K in (typeof NOT_THE_OWNERS_START)[number]]?: unknown };

export interface OwnerStartFacts {
  /** Set after every level has been applied to the turn. */
  directOwnerAudience: boolean;
  directThread: boolean;
  sharedWork: boolean;
  ownerOrigin: boolean;
  queuedOwnerProof: boolean;
  fullAccessOrigin: FullAccessOrigin;
  routineLevel: boolean;
  inheritedRoutine: boolean;
  termsAccepted: boolean;
  marks: StartMarks | undefined;
}

export function ownerStartedTurn(facts: OwnerStartFacts): boolean {
  return facts.directOwnerAudience && facts.directThread && !facts.sharedWork
    && (facts.ownerOrigin || facts.queuedOwnerProof)
    && facts.fullAccessOrigin === "owner"
    && !facts.routineLevel && !facts.inheritedRoutine
    && facts.termsAccepted
    && NOT_THE_OWNERS_START.every((mark) => facts.marks?.[mark] === undefined);
}

/** Held for each turn that passed, by generation. A generation is one admission and is never reused. */
export const OWNER_STARTED_RUNS_MAX = 1_000;
export function recordOwnerStarted(runs: Map<string, string>, generation: string, botId: string): void {
  if (runs.size >= OWNER_STARTED_RUNS_MAX) runs.delete(runs.keys().next().value!);
  runs.set(generation, botId);
}

/** At an ask: true only for the turn the run has bound, by the engine's own turn id. An ask before the bind, a late ask
 * from an older turn, a rebuild and a missing record all read false, so they get the card they get today. */
export function ownerStartedAsk(
  runs: ReadonlyMap<string, string>,
  run: { generation: string; phase: string; providerTurnId?: string } | undefined,
  botId: string,
  turnId: string | undefined,
): boolean {
  if (!run || run.phase === "rebuilding" || run.providerTurnId === undefined) return false;
  return turnId === run.providerTurnId && runs.get(run.generation) === botId;
}

/** A limit failover resends a stored line and has no request of its own to prove who sent it, so a line with no stored
 * owner origin stays not proven, on every route it can take: a start, a steer, the queue. */
export function failoverSendProof(origin: MessageOrigin | undefined): { origin: MessageOrigin; unprovenSend: boolean } {
  return { origin: origin ?? "unproven", unprovenSend: !isOwnerOrigin(origin) };
}
