// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HL-RO allow gate (1.0.17, designs/HL-RO-ALLOW-GATE-1104.md): native HighLevel opens only on a turn PROVEN to be a message the
// owner sent directly in the bot's own chat. One ALLOW proof, judged once at turn start (index.ts startAdmittedTurn), replaces the
// old deny list. Every fact must hold; anything unknown, new or missing reads as false.

/** The only startTurn opts a proven owner line may carry. Any other key set to anything but undefined fails the proof, so an opt
 *  added later (a new kind of start) is closed until someone decides otherwise here. */
export const HIGHLEVEL_OWNER_OPTS: readonly string[] = Object.freeze([
  "threadId", "replyTo", "sendId", "origin", "phoneTicket", "hlTicket", "userMessage", "excludeMessageIds", "memoryRedispatch", "rebuildOf",
]);

export interface HighLevelOwnerFacts {
  /** opts.hlTicket as presented: only admitDirectSend.runIt can name the real one. */
  readonly ticket: unknown;
  /** The module-private ticket the turn must present (index.ts HL_OWNER_TICKET). */
  readonly ownerTicket: symbol;
  /** The startTurn opts, read by key. */
  readonly opts: Readonly<Record<string, unknown>> | undefined;
  /** isOwnerOrigin(opts.origin): desktop or companion. */
  readonly ownerOrigin: boolean;
  readonly directOwnerAudience: boolean;
  /** The thread is the bot's own direct thread (phoneDirectThread). */
  readonly directThread: boolean;
  /** The task is shared or project work. */
  readonly sharedWork: boolean;
  readonly fullAccessOrigin: string | undefined;
  /** A scheduled or manual routine level applied to this turn. */
  readonly routineLevel: boolean;
  /** A routine ceiling inherited (ask, hand-off, wake, continuation). */
  readonly inheritedRoutine: boolean;
  /** The turn runs in a routine's own conversation. */
  readonly conversationMode: boolean;
  /** isUnattended(threadId). */
  readonly unattended: boolean;
  /** A routine is live on this thread: its peer source captured before admission cleared it, or a live run bound to the thread.
   *  True as well when the run registry could not be read. */
  readonly routineLive: boolean;
}

export function highlevelOwnerTurn(facts: HighLevelOwnerFacts): boolean {
  if (typeof facts.ownerTicket !== "symbol" || facts.ticket !== facts.ownerTicket) return false;
  const opts = facts.opts;
  if (!opts || typeof opts !== "object") return false;
  for (const key of Reflect.ownKeys(opts)) {
    if (typeof key !== "string" || !HIGHLEVEL_OWNER_OPTS.includes(key)) {
      if ((opts as Record<PropertyKey, unknown>)[key] !== undefined) return false;
    }
  }
  return facts.ownerOrigin === true
    && facts.directOwnerAudience === true
    && facts.directThread === true
    && facts.sharedWork === false
    && facts.fullAccessOrigin === "owner"
    && facts.routineLevel === false
    && facts.inheritedRoutine === false
    && facts.conversationMode === false
    && facts.unattended === false
    && facts.routineLive === false;
}

/** Bot-facing only (capabilities primer): the bot holds a HighLevel grant but this turn is not a proven owner line. */
export const HIGHLEVEL_CLOSED_LINE = "HighLevel isn't open on this turn. It opens only for a message the owner sends you directly in this chat. If they ask for something from HighLevel, ask them to send that request again here.";
