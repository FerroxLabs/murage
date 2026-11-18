// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { noLimitsAppliesTo, type NoLimitsOrigin } from './no-limits-origin.ts';
import { producerNoLimitsPolicyFor, readTurnPolicy } from './decision/index.ts';
import type { SendTurnInput } from './contracts.ts';
/** Server-owned provenance only. Never populate these facts from a tool body. */
export interface ServiceTurnFacts {
  /** Live proof for both the current principal and the turn's lineage root. */
  ownerAudience: boolean;
  origin: NoLimitsOrigin;
  explicitNoLimits?: boolean;
  channelMessages?: boolean;
  noLimits: boolean;
  draftOnly?: boolean;
}
const turns = new Map<string, { threadId: string; botId: string; active: () => boolean; read: () => ServiceTurnFacts }>();
const threads = new Map<string, string>();
/** Installed at dispatch, after task/routine/delegation ceilings and audience checks. */
export function bindServiceTurn(generation: string, threadId: string, botId: string, active: () => boolean, read: () => ServiceTurnFacts): void {
  const previous = threads.get(threadId);
  if (previous) turns.delete(previous);
  for (const [key, turn] of turns) if (!turn.active()) { turns.delete(key); if (threads.get(turn.threadId) === key) threads.delete(turn.threadId); }
  turns.set(generation, { threadId, botId, active, read }); threads.set(threadId, generation);
}
export function serviceNoLimits(generation: string, threadId?: string, botId?: string): boolean {
  const turn = turns.get(generation);
  if (!turn && threadId !== undefined) {
    try { return readTurnPolicy({ generation, threadId })?.permission.noLimits === true; } catch { return false; }
  }
  if (!turn || threadId !== undefined && turn.threadId !== threadId || botId !== undefined && turn.botId !== botId) return false;
  try { const facts = turn.read();
    if (facts.ownerAudience !== true) return false;
    // Recovery uses the same host-owned audience proof as the engine policy.
    // An unavailable snapshot cannot turn an owner-only No limits thread into
    // a service-specific permission hold.
    if(facts.origin==='unproven')return turn.active()&&readTurnPolicy({generation,threadId:turn.threadId})?.permission.noLimits===true;
    // Automation does not prove the live owner audience (root and principal).
    // Keep the recorded origin intact and refuse relief on contradictory facts.
    return turn.active() && noLimitsAppliesTo(facts.origin, { autoApprove: facts.noLimits, fullAccess: facts.noLimits, noLimits: facts.noLimits, draftOnly: facts.draftOnly, // Owner flags already include the live task/routine ceiling.
    permissionExplicit: facts.ownerAudience ? true : facts.explicitNoLimits, fullAccessChannelMessages: facts.channelMessages }); } catch { return false; }
}
export function serviceThreadNoLimits(threadId: string, botId?: string): boolean {
  return serviceThreadNoLimitsPolicy(threadId, botId) ?? false;
}
/** Undefined means no live turn, so a durable admission reader may use its
 * stored policy. False is a live refusal and must never fall back to bot flags. */
export function serviceThreadNoLimitsPolicy(threadId: string, botId?: string): boolean | undefined {
  const generation = threads.get(threadId);
  if (generation !== undefined) return serviceNoLimits(generation, threadId, botId);
  // Room turns use registry-owned identity. Rejected bindings remain false;
  // an execution-authority lookup would hide them as if the turn were absent.
  return botId ? producerNoLimitsPolicyFor(threadId, botId) : undefined;
}

/** A turn-only trust grant. It never changes the owner's saved folder records. */
export function serviceFolderTrust(generation: string, threadId: string, botId: string, gate: SendTurnInput['folderTrust']): SendTurnInput['folderTrust'] {
  if (!gate || !serviceNoLimits(generation, threadId, botId)) return gate;
  // Saved folder trust denials are permission rules. Waive them for this turn;
  // the stored records remain intact for lower levels.
  return { ...gate, rejects: [], decision: 'trust', fromRecord: undefined, managedDesk: undefined,
    storedNoPick: undefined, trustKeys: [...new Set([...(gate.trustKeys ?? []), gate.key])] };
}
