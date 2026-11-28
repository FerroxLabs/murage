// SPDX-License-Identifier: AGPL-3.0-or-later
// Who supplied a turn's words, as the decision layer reads it (server/decision/implementation.ts authority()).
// Moved out of server/index.ts unchanged except for the 'murage' kind (1.0.22 q1022-nolimits).
import type { Initiator } from './types.ts';

export type DecisionDispatchFacts = {
  kind?: 'webhook' | 'guest' | 'delegation' | 'other-human' | 'peer' | 'murage'; fromBotId?: string;
  ownerTyped?: boolean; ownerOrigin?: boolean; queuedDrain?: boolean; queuedOwnerProof?: boolean;
  memoryRedispatch?: boolean; cardContinuation?: boolean; continuation?: Initiator;
  channel?: string; channelOwner?: boolean; routine?: Initiator;
  /** A direct thread only the owner reads, resuming a card the owner's own typed turn raised: the resumed turn is the
   * owner's own unattended work, never another person's. A card any other turn raised never sets this. */
  ownerOnlyAutomation?: boolean;
};
export function decisionInitiator(facts: DecisionDispatchFacts): Initiator {
  if (facts.kind === 'webhook') return { k: 'webhook' };
  if (facts.queuedDrain) return facts.queuedOwnerProof ? { k: 'owner-typed' } : { k: 'other-human' };
  if (facts.continuation) return facts.continuation;
  if (facts.routine) return facts.routine;
  if (facts.channel) return facts.channelOwner ? { k: 'owner-channel-dm', channel: facts.channel } : { k: 'other-human' };
  if (facts.memoryRedispatch) return facts.ownerOrigin ? { k: 'owner-typed' } : { k: 'other-human' };
  // Sean 2026-11-25 (1.0.22 q1022-nolimits): after the owner answered a credential card their own typed turn raised, a
  // No limits bot asked for every command of the resumed turn, because that turn was filed as another person's. It is the
  // owner's own unattended work, at the bot's level like a delegation. Every other resumed turn keeps `other-human`.
  if (facts.cardContinuation) return facts.ownerOnlyAutomation === true ? { k: 'delegation' } : { k: 'other-human' };
  if (facts.kind === 'peer') return { k: 'peer', fromBotId: facts.fromBotId ?? '' };
  if (facts.kind) return { k: facts.kind };
  return facts.ownerTyped ? { k: 'owner-typed' } : { k: 'other-human' };
}
/** The dispatch kind startTurn's options give. A turn Murage started itself (a team-incident report: murageTurn,
 * unattended, nobody typed it) is 'murage', judged at the bot's own level, never as a guest's 'other-human'. */
export function decisionDispatchKind(opts: { automationSource?: string; delegationRun?: unknown; murageTurn?: true; unattended?: boolean; coordination?: { path: readonly string[] } } | undefined,
  ownerTyped: boolean, commsDepth: number | undefined): Pick<DecisionDispatchFacts, 'kind' | 'fromBotId'> {
  return opts?.automationSource === 'webhook' ? { kind: 'webhook' as const } : opts?.delegationRun ? { kind: 'delegation' as const } : commsDepth ? { kind: 'peer' as const, fromBotId: opts?.coordination?.path.at(-2) } : opts?.murageTurn && opts.unattended && !ownerTyped ? { kind: 'murage' as const } : {};
}
