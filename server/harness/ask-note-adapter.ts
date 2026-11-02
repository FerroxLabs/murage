// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one place a turn is marked as nobody being at it (contracts: unattendedAskNote). The registry wraps every live instance
// with this decorator, so every engine call the server makes reaches it, and no caller can forget the mark or set it for itself.
// The default is no mark and no clock: a question waits for the owner's answer or Stop.

import type { ProviderAdapter, ProviderInstance, SendTurnInput } from "../contracts.ts";

/** Whether nobody is at this thread: a routine run or an unattended turn. Installed by index.ts; with none installed, nobody counts. */
export type AskNoteResolver = (threadId: string) => boolean;
let resolver: AskNoteResolver = () => false;
export function setAskNoteResolver(next: AskNoteResolver): void { resolver = next; }

/** The turn as the engine receives it. Whatever the caller passed, the mark follows the resolver alone. */
export function askNoteTurnInput(turn: SendTurnInput): SendTurnInput {
  const { unattendedAskNote: _ignored, ...rest } = turn;
  return resolver(turn.threadId) ? { ...rest, unattendedAskNote: true } : rest;
}

export function decorateAskNoteInstance(live: ProviderInstance): ProviderInstance {
  const original = live.adapter;
  const sendTurn: ProviderAdapter["sendTurn"] = (input) => original.sendTurn(askNoteTurnInput(input));
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
