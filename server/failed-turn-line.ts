// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A direct turn that ends ok:false is never silent in the chat. Every engine path is meant to emit a runtime.error first;
// one that did not (an engine that closed before it was ready, a driver path that only settles) still leaves the owner a
// plain line, exactly once, so the chat never shows their message with nothing under it and an idle bot.

import { turnStopped, turnSucceeded } from "./turn-outcome.ts";

/** The owner-facing line for a failed direct turn that showed no error of its own. When the turn already wrote visible text
 *  (part of a reply, or a provider's own error text such as an overloaded API), the line says the reply did not finish rather
 *  than that there was none, so it never reads as a second error under the first. */
export function failedTurnLine(botName: string, wroteText = false): string {
  const name = botName.trim() || "This bot";
  return wroteText
    ? `${name} did not finish this reply. Murage ended the turn so you can send your message again.`
    : `${name} could not reply this time. Murage ended the turn so you can send your message again.`;
}

/** Which threads already showed a runtime.error for their current turn. One turn runs on a thread at a time. */
export class TurnErrorShown {
  private readonly shown = new Map<string, string | null>();
  /** A runtime.error reached the chat (turnId null: an error with no turn, which counts for whichever turn ends next). */
  noteError(threadId: string, turnId: string | undefined): void {
    this.shown.set(threadId, turnId ?? null);
  }
  /** A new turn started: an error noted for an earlier turn is not this one's. */
  noteStarted(threadId: string, turnId: string | undefined): void {
    const prior = this.shown.get(threadId);
    if (prior !== undefined && prior !== null && turnId !== undefined && prior !== turnId) this.shown.delete(threadId);
  }
  /** Read and forget: did this ending turn already show an error? */
  take(threadId: string, turnId: string | undefined): boolean {
    if (!this.shown.has(threadId)) return false;
    const prior = this.shown.get(threadId);
    this.shown.delete(threadId);
    return prior === null || turnId === undefined || prior === turnId;
  }
}

/** The server's one tracker: direct turns whose runtime.error reached the chat (index.ts fold). */
export const turnErrorShown = new TurnErrorShown();

export interface FailedTurnContext {
  /** a 1:1 owner turn on a bot's own thread (not a room, not shared with someone else) */
  directOwnerTurn: boolean;
  /** a newer run owns the thread: this is an earlier turn's late close */
  replacementOwnsThread: boolean;
  /** a delegated turn: its failure is the delegated_turn_failed chip in the A to B channel */
  delegated: boolean;
  /** a routine run: the routine records its own outcome */
  routine: boolean;
  /** a memory refusal re-run or carded by its own entry */
  lateRedispatch: boolean;
  /** a runtime.error was already shown for this turn */
  errorShown: boolean;
  /** this turn already has a failure line of Murage's own (a refusal, a memory echo notice) */
  failureRowShown: boolean;
}

/** True when the fold must add failedTurnLine for this terminal event. */
export function wantsFailedTurnLine(event: { ok: boolean; stopReason?: string | null }, ctx: FailedTurnContext): boolean {
  if (event.ok || turnStopped(event)) return false;
  // submission_refused already has its own plain line (the refusal note).
  if (event.stopReason === "submission_refused") return false;
  if (!ctx.directOwnerTurn || ctx.replacementOwnsThread || ctx.delegated || ctx.routine || ctx.lateRedispatch) return false;
  return !ctx.errorShown && !ctx.failureRowShown;
}

/** ACP's empty-turn line (acp/core.ts), for an engine that ended a turn as finished with nothing to show for it. */
export function emptyTurnLine(engine: string): string {
  return `${engine.trim() || "The engine"} finished without a reply, an image or a tool result, so nothing came back.`;
}

type TurnRow = { role: string; kind: string; actorKind?: string; murageLine?: boolean; text?: string; attachments?: unknown[] };

/** A row Murage wrote in its own voice, never the engine's: actorKind "murage", or the murageLine stamp the turn's fold puts on
 *  every line it writes without a provider reply (a retry, an error, a stop note, a notice; murage-line.ts). */
function murageOwnRow(row: TurnRow): boolean {
  return row.actorKind === "murage" || row.murageLine === true;
}

/** What a finished turn left in the chat, for the empty-turn rule: the engine's own rows (reply text, an image, a tool it ran,
 *  a card it asked) count; Murage's own lines (errors, retries, stop notes, notices) do not. */
export function turnProducedSomething(rows: ReadonlyArray<TurnRow>): boolean {
  return rows.some((row) => row.role !== "user" && !murageOwnRow(row)
    && (row.kind !== "text" || Boolean(row.text?.trim()) || Boolean(row.attachments?.length)));
}

/** Whether the bot itself wrote reply text in this turn (failedTurnLine's wroteText). Murage's own rows are not the bot's text. */
export function turnWroteText(rows: ReadonlyArray<TurnRow>): boolean {
  return rows.some((row) => row.role === "bot" && row.kind === "text" && !murageOwnRow(row) && Boolean(row.text?.trim()));
}

/** True when the fold must add emptyTurnLine: a direct turn the engine called finished (ok, not a stop) that produced no reply
 *  text, no image and no tool result. ACP reports these itself (ok:false "empty_turn" with the same line); this covers the rest. */
export function wantsEmptyTurnLine(event: { ok: boolean; stopReason?: string | null }, ctx: FailedTurnContext & { produced: boolean }): boolean {
  if (!turnSucceeded(event) || event.stopReason === "submission_refused") return false;
  if (!ctx.directOwnerTurn || ctx.replacementOwnsThread || ctx.delegated || ctx.routine || ctx.lateRedispatch) return false;
  return !ctx.produced && !ctx.errorShown && !ctx.failureRowShown;
}
