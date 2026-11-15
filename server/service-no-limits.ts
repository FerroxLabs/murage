// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { noLimitsAppliesTo, type NoLimitsOrigin } from './no-limits-origin.ts';
import { producerAuthorityFor, readTurnPolicy } from './decision/index.ts';
import type { SendTurnInput } from './contracts.ts';
/** Server-owned provenance only. Never populate these facts from a tool body. */
export interface ServiceTurnFacts {
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
    // Recovery uses the same host-owned audience proof as the engine policy.
    // An unavailable snapshot cannot turn an owner-only No limits thread into
    // a service-specific permission hold.
    if(facts.origin==='unproven')return turn.active()&&readTurnPolicy({generation,threadId:turn.threadId})?.permission.noLimits===true;
    const automated=facts.origin==='webhook'||facts.origin==='unattended'||facts.origin==='routine'||facts.origin==='owner-routine';
    const origin = automated || facts.ownerAudience ? facts.origin : 'guest';
    return turn.active() && noLimitsAppliesTo(origin, { autoApprove: facts.noLimits, fullAccess: facts.noLimits, noLimits: facts.noLimits, draftOnly: facts.draftOnly, // Owner flags already include the live task/routine ceiling.
    permissionExplicit: facts.ownerAudience ? true : facts.explicitNoLimits, fullAccessChannelMessages: facts.channelMessages }); } catch { return false; }
}
export function serviceThreadNoLimits(threadId: string, botId?: string): boolean {
  const generation = threads.get(threadId);
  if (generation !== undefined) return serviceNoLimits(generation, threadId, botId);
  // Room turns use the registry rather than the direct-turn adapter. The
  // producer binding supplies this identity; tool bodies cannot choose it.
  const authority = botId ? producerAuthorityFor(threadId, botId) : undefined;
  const identity = (authority as typeof authority & { identity?: { threadId: string; generation: string } })?.identity;
  return identity?.threadId === threadId && serviceNoLimits(identity.generation, threadId, botId);
}

/** A turn-only trust grant. It never changes the owner's saved folder records. */
export function serviceFolderTrust(generation: string, threadId: string, botId: string, gate: SendTurnInput['folderTrust']): SendTurnInput['folderTrust'] {
  if (!gate || !serviceNoLimits(generation, threadId, botId)) return gate;
  // Saved folder trust denials are permission rules. Waive them for this turn;
  // the stored records remain intact for lower levels.
  return { ...gate, rejects: [], decision: 'trust', fromRecord: undefined, managedDesk: undefined,
    storedNoPick: undefined, trustKeys: [...new Set([...(gate.trustKeys ?? []), gate.key])] };
}
