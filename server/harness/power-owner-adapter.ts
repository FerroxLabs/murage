// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one place a turn is marked as the owner's own (contracts: hostPowerOwnerTurn). The power block (host-power.ts) wraps a guest
// or unattended turn, where what the engine does can reach other people or the machine without the owner there; the owner's own
// turn runs as the owner does (OVERREACH #5). The registry wraps every live instance with this decorator, so no caller can set the
// mark for itself. The default is no mark: an engine whose turn is not known to be the owner's is wrapped as before.

import type { ProviderAdapter, ProviderInstance, SendTurnInput } from "../contracts.ts";

/** Whether this thread's running turn is the owner's own: started by the owner, to the owner's audience, with nobody away.
 *  Installed by index.ts; with none installed, no turn counts. */
export type OwnerTurnResolver = (threadId: string) => boolean;
let resolver: OwnerTurnResolver = () => false;
export function setOwnerTurnResolver(next: OwnerTurnResolver): void { resolver = next; }

/** The one rule, over the server's own records: the dispatch recorded the turn as the owner's audience (`ownerAudience`, not
 *  `notOwnerAudience`), nobody is away (no webhook, channel, routine run or unproven origin, and no automation earlier in the chain), and the room is not one the owner
 *  does not see. A thread with no record is not the owner's. */
export function isOwnerTurn(facts: { turn: { ownerAudience?: boolean; notOwnerAudience?: boolean } | undefined; unattendedOrRoutine: boolean; ownerSurface: boolean | undefined; ancestry: boolean | undefined }): boolean {
  // ancestry: the admitted turn's recorded automation ancestry (automation-ancestry.ts). Only a recorded false proves nothing automated is behind it;
  // a routine, wake or webhook hop earlier in the chain (true), or no record, leaves the turn wrapped.
  return facts.turn?.ownerAudience === true && facts.turn.notOwnerAudience !== true && !facts.unattendedOrRoutine && facts.ownerSurface !== false && facts.ancestry === false;
}

/** The server's one installation of the rule: index.ts hands over its own records and nothing else decides (a thread with no record, no
 *  recorded ancestry or any automation fact stays wrapped). */
export function installOwnerTurnResolver(sources: {
  turn(threadId: string): { ownerAudience?: boolean; notOwnerAudience?: boolean } | undefined;
  unattendedOrRoutine(threadId: string): boolean;
  ownerSurface(threadId: string): boolean | undefined;
  ancestry(threadId: string): boolean | undefined;
}): void {
  setOwnerTurnResolver((threadId) => isOwnerTurn({ turn: sources.turn(threadId), unattendedOrRoutine: sources.unattendedOrRoutine(threadId), ownerSurface: sources.ownerSurface(threadId), ancestry: sources.ancestry(threadId) }));
}

/** The turn as the engine receives it. Whatever the caller passed, the mark follows the resolver alone. */
export function ownerTurnInput(turn: SendTurnInput): SendTurnInput {
  const { hostPowerOwnerTurn: _ignored, ...rest } = turn;
  return resolver(turn.threadId) ? { ...rest, hostPowerOwnerTurn: true } : rest;
}

export function decorateOwnerTurnInstance(live: ProviderInstance): ProviderInstance {
  const original = live.adapter;
  const sendTurn: ProviderAdapter["sendTurn"] = (input) => original.sendTurn(ownerTurnInput(input));
  const adapter = new Proxy(original, {
    get(target, property) {
      if (property === "sendTurn") return sendTurn;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ProviderAdapter;
  return new Proxy(live, {
    get(target, property) {
      if (property === "adapter") return adapter;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
