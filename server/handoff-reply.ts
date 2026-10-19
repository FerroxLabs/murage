// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The line a finished hand-off leaves in its source conversation (the target's reply, or what became of the hand-off), written by the finalizer and, if the
// process died between the receipt reaching disk and the final commit, by the settle that recovers it from the receipt.
//
// Exactly once, by construction: the line has a stable id per hand-off (`dres-<id>`), so a second write of it returns the first; and the recovery writes it in
// the same transaction that ends the request and removes the hand-off's row (delegations.ts settleReceipted), so it is written with the settle or not at all.
import type { DelegationReceipt } from "./delegations.ts";
import type { Message, Store } from "./store.ts";
import { murageLine } from "./murage-line.ts";

/** What the source conversation is owed, kept on the receipt until the final commit has landed (delegations.ts finishHandoff). */
export type OwedReply = { text: string } | { line: string; ok: boolean };

export const HANDOFF_REPLY_PREFIX = "dres-";
export function handoffReplyId(handoffId: string): string { return `${HANDOFF_REPLY_PREFIX}${handoffId}`; }

/** The line a finished hand-off owes: the target's words when it replied, else its activity line. */
export function owedReplyOf(input: { ok: boolean; reply: string; targetName: string; failureName: string; stopped: boolean }): OwedReply {
  if (input.ok && input.reply.trim()) return { text: input.reply.trim() };
  const line = input.ok
    ? `Delegation to @${input.targetName} completed without a text reply`
    : input.stopped
      ? `Delegation to @${input.targetName} was stopped before it finished`
      : `Delegation to @${input.targetName} failed: ${input.failureName}`;
  return { line, ok: input.ok };
}

type ReplyStore = Pick<Store, "appendMessage" | "bot">;
/** Writes the owed line into the source conversation under its stable id (a second write returns the first). */
export function appendHandoffReply(store: ReplyStore, input: { handoffId?: string; sourceThreadId: string; owed: OwedReply; targetBotId: string; targetName: string; askRequestId?: string; copyOf?: Message["copyOf"] }): Message {
  const id = input.handoffId ? handoffReplyId(input.handoffId) : undefined;
  if ("text" in input.owed) {
    const target = store.bot(input.targetBotId);
    const message: Omit<Message, "id" | "at"> = {
      role: "bot",
      kind: "text",
      inboundKind: "action",
      text: `@${input.targetName} replied to the delegated task:\n\n${input.owed.text}`,
      // the result carries its request from the moment it is written, so a restart before the request completes can still find it (SPEC-P 6.3)
      ...(input.askRequestId ? { requestId: input.askRequestId, actorKind: "bot" as const } : {}),
      ...(input.copyOf ? { copyOf: input.copyOf } : {}),
    };
    if (target) message.from = { botId: target.id, name: target.name, color: target.color };
    return store.appendMessage(input.sourceThreadId, message, id);
  }
  return store.appendMessage(input.sourceThreadId, murageLine({
    role: "bot",
    kind: "activity",
    ...(input.askRequestId ? { requestId: input.askRequestId, actorKind: "murage" as const } : {}),
    tool: { name: input.owed.line, ok: input.owed.ok },
  }), id);
}

/** The recovery: a receipt that still carries an owed line (its final commit never landed) writes it now, inside the settle's transaction. Returns the line, or
 * null when nothing is owed (an older receipt, a receipt from any other path, or a source conversation that is gone). */
export function replayOwedReply(store: ReplyStore & Pick<Store, "botByThread" | "groupByThread">, receipt: DelegationReceipt): Message | null {
  if (!receipt.reply) return null;
  if (!store.botByThread(receipt.sourceThreadId) && !store.groupByThread(receipt.sourceThreadId)) return null;
  return appendHandoffReply(store, {
    handoffId: receipt.id, sourceThreadId: receipt.sourceThreadId, owed: receipt.reply, targetBotId: receipt.toBotId, targetName: receipt.toBotName,
    ...(receipt.requestId ? { askRequestId: receipt.requestId } : {}), ...(receipt.copyOf ? { copyOf: receipt.copyOf } : {}),
  });
}
