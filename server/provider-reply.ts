// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The proof that the provider itself replied. A hand-off is shown to have run only by a message the ENGINE's turn produced; a line Murage wrote into the
// same stream (an error, a retry, a stop line, a cap note, a wait chip) carries a turn id too and must never count.
//
// So the proof is not a property of the stored message that any code could also produce. It is a value only this module can make: `providerReplyOf(event)`
// is the one minter, it is called once, in the server's fold of a runtime event, and it returns a marker only for the two kinds of item an engine's turn
// produces (its reply text and the start of a tool it ran) whose `origin` is "engine" and that belong to a turn. The marker is bound to the thread, turn
// and event it was minted for and is remembered in a module-private WeakSet; `isProviderReply` is the only question anyone can ask of it, so an object
// that merely looks like one (a cast, a copy, a spread) is not one. A leaf module: it imports nothing but types.
import type { RuntimeEvent } from "./contracts.ts";

declare const BRAND: unique symbol;
/** A provider reply: only `providerReplyOf` makes one. Holding one is the proof; there is no other constructor. */
export interface ProviderReply {
  readonly [BRAND]: true;
  readonly threadId: string;
  readonly turnId: string;
  readonly eventId: string;
}

const minted = new WeakSet<object>();
class Reply {
  readonly threadId: string;
  readonly turnId: string;
  readonly eventId: string;
  private constructor(threadId: string, turnId: string, eventId: string) { this.threadId = threadId; this.turnId = turnId; this.eventId = eventId; Object.freeze(this); }
  static mint(threadId: string, turnId: string, eventId: string): ProviderReply {
    const reply = new Reply(threadId, turnId, eventId);
    minted.add(reply);
    return reply as unknown as ProviderReply;
  }
}

/** The marker for an event the engine's own turn produced, or undefined. Everything else (an error, a retry, a stop line, a memory echo, a copy, a line with
 * origin "murage", an event with no turn) mints nothing. Called once per event, in the fold (index.ts foldRuntimeEvent). */
export function providerReplyOf(event: RuntimeEvent): ProviderReply | undefined {
  if (!event.turnId) return undefined;
  const engine = (event.type === "item.completed" && event.itemType === "assistant_text") || (event.type === "item.started" && event.itemType === "tool");
  if (!engine || event.origin !== "engine") return undefined;
  return Reply.mint(event.threadId, event.turnId, event.eventId);
}

/** Whether the value is a marker this module minted (not a cast, not a lookalike). */
export function isProviderReply(candidate: unknown): candidate is ProviderReply {
  return typeof candidate === "object" && candidate !== null && minted.has(candidate);
}
