// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// No holds on hand-offs (lanes/release103/NOHOLD-DELEGATION.md). A delegation result the gate reads as checking is never held: the asking bot's
// final answer is the no-answer line. Earlier 1.0.3 builds held such replies (the words in the source conversation flagged "checking", the
// receipt keeping them with a `held` mark). Those holds are retired once, at start, fail-closed, in an order that can be repeated after a crash
// and never writes words:
//
//   1. the held row is rewritten in place as the no-answer row (words, copy link and flag gone); a missing row is written under its stable id;
//   2. the request it answers completes at that row, or a direct asker is woken once (index.ts complete port; AskerWakes dedupes by task and row);
//   3. the receipt drops its hold, its owed reply and its originals, and keeps the no-answer line.
//
// The owner still reads the worker's reply in the worker's own conversation.
import { heldReceipts, settleHeldReceipt } from "./delegations.ts";
import { HANDOFF_REPLY_PREFIX } from "./handoff-reply.ts";
import { murageLine } from "./murage-line.ts";
import { outboundWords, status, statusRecordOf, type MurageStatus } from "./murage-status.ts";
import type { Message, Store } from "./store.ts";

/** THE held-reply rule (1.0.20, one rule for every site that used to emit `no_answer_checking`): a delegated reply the gate holds because
 * memory is still being checked is never posted, read or kept as an internal placeholder. A site that writes the reply into the asker's
 * conversation WAITS for the check to clear (bounded, `HeldWait`, the finalizer's DelegatedReplyChecks) and delivers it then; only a reply
 * still held past the bound, or one a site cannot wait for (a read, an earlier build's hold whose words are gone), gets this plain notice.
 * The held content itself never leaves the worker's conversation (no revoked memory exposed). */
export const noAnswerLine = (): MurageStatus => status("reply_not_ready");
/** Every kept line that marks a delegation final as "not delivered because it was held" (earlier builds kept the internal one). */
export const HELD_LINE_KEYS: ReadonlySet<string> = new Set(["no_answer_checking", "reply_not_ready", "no_answer_check_timed_out"]);
export const isHeldLineKey = (key: string | undefined): boolean => key !== undefined && HELD_LINE_KEYS.has(key);

/** The bounded wait a writing site uses (server/delegated-reply-check.ts DelegatedReplyChecks). */
export type HeldWait = { defer(key: string, threadId: string, run: () => void, since?: number): number; expired(since: number): boolean; readonly stopped?: boolean };
/** The rule at a writing site whose reply reads checking: "wait" (the retry is armed; write nothing now) while the bound lasts, else "notice"
 * (write `noAnswerLine()`). `since` is kept by the caller across retries (returned in `since`). */
export function heldReplyRule(wait: HeldWait | undefined, key: string, threadId: string, retry: (since: number) => void, since?: number): { kind: "wait"; since: number } | { kind: "notice" } {
  if (!wait || wait.stopped || (since !== undefined && wait.expired(since))) return { kind: "notice" };
  let began = since;
  began = wait.defer(key, threadId, () => retry(began!), since);
  return { kind: "wait", since: began };
}

/** A hold an earlier build left, as much of it as the retirement needs. */
export interface RetiredHold { id: string; sourceThreadId: string; toBotId: string; toBotName: string; requestId?: string }

export interface HeldRetirePorts {
  store: Pick<Store, "patchMessage" | "messageById" | "botByThread" | "groupByThread" | "appendMessage" | "bot">;
  /** The request the hold answers (when it has one) completes at `messageId`; a direct hand-off's asker is woken once there (index.ts). */
  complete: (hold: RetiredHold, messageId: string | undefined) => void;
}

/** The no-answer row's fields: Murage's kept status (a bot reads exactly the line), the worker named as its speaker, no copy link, no flag. */
function noAnswerRow(ports: HeldRetirePorts, hold: RetiredHold): Partial<Message> {
  const line = noAnswerLine();
  const worker = ports.store.bot(hold.toBotId);
  return {
    text: outboundWords(line), copyOf: undefined, withheldFromBots: undefined, murageLine: true, murage: { kind: "status", status: statusRecordOf(line)! },
    from: worker ? { botId: worker.id, name: worker.name, color: worker.color } : { botId: hold.toBotId, name: hold.toBotName, color: "" },
  };
}

/** Step 1: the held row (by id) becomes the no-answer row; with no row and a conversation still there, the row is written under `fallbackId`.
 * Returns the row's id, or undefined when the source conversation is gone. */
export function retireHeldRow(ports: HeldRetirePorts, hold: RetiredHold, messageId: string, fallbackId = messageId): string | undefined {
  const { store } = ports;
  if (!store.botByThread(hold.sourceThreadId) && !store.groupByThread(hold.sourceThreadId)) return undefined;
  const fields = noAnswerRow(ports, hold);
  if (store.messageById(hold.sourceThreadId, messageId)) { store.patchMessage(hold.sourceThreadId, messageId, fields); return messageId; }
  if (!fallbackId.startsWith(HANDOFF_REPLY_PREFIX)) return undefined;
  const written = store.appendMessage(hold.sourceThreadId, murageLine({ role: "bot", kind: "text", inboundKind: "action",
    ...(hold.requestId ? { requestId: hold.requestId, actorKind: "bot" as const } : {}), ...fields } as Omit<Message, "id" | "at">), fallbackId);
  return written.id;
}

/** Retires every hold the receipts still carry. Never throws: a hold whose retirement fails stays for the next start. Returns how many ended. */
export function retireHeldReplies(ports: HeldRetirePorts): number {
  let retired = 0;
  for (const receipt of heldReceipts()) {
    const held = receipt.held;
    if (!held) continue;
    const hold: RetiredHold = { id: receipt.id, sourceThreadId: receipt.sourceThreadId, toBotId: receipt.toBotId, toBotName: receipt.toBotName, ...(receipt.requestId ? { requestId: receipt.requestId } : {}) };
    try {
      const rowId = retireHeldRow(ports, hold, held.messageId, `${HANDOFF_REPLY_PREFIX}${receipt.id}`);
      ports.complete(hold, rowId);
      settleHeldReceipt(receipt.id, { held: null, reply: null, copyOf: null, result: noAnswerLine() });
      retired++;
    } catch (error) {
      console.error("held-replies: an earlier build's held reply could not be retired; the next start tries again", error);
    }
  }
  return retired;
}
