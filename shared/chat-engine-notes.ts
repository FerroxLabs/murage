// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The words and small decisions behind the engine notes in the chat: the
// divider where the answering engine changes, the hover label, and the
// excerpts the reply check underlines. Pure, so the copy is tested directly.

import type { MessageEngine } from "./engine-switch.ts";
import type { ActionCheck, CheckedClaim } from "./reply-action-claims.ts";

/** The server's stamp on a bot row (MessageEngine), as far as the notes read it. */
export type RowEngine = Pick<MessageEngine, "instanceId"> & Partial<Pick<MessageEngine, "driverKind" | "model" | "connectionId" | "capabilityHash">>;
export interface EngineRow { id: string; role: "bot" | "user"; engine?: RowEngine; murage?: unknown }

export const ENGINE_LABEL_NOTICE = "Replies will be labelled with the engine that wrote them.";

export const engineChangedLine = (label: string): string =>
  `Engine changed: ${label}. The record carries over. Engines differ in tools, context size and what they will do, so the voice and the answers may differ.`;

export const engineHoverLabel = (engine: RowEngine, labelFor: (engine: RowEngine) => string = (e) => e.instanceId): string =>
  engine.model ? `${labelFor(engine)}, ${engine.model}` : labelFor(engine);

export const HELD_QUEUE_OPEN = "Open now";

/** Divider text keyed by the id of the bot row that starts a new engine run:
 * between two labelled bot rows whose instances differ, and before the first
 * labelled row that follows unlabelled ones. */
export function engineDividers(
  rows: readonly EngineRow[],
  labelFor: (engine: RowEngine) => string,
): Map<string, string> {
  const out = new Map<string, string>();
  let prev: RowEngine | undefined;
  let sawBotRow = false;
  for (const row of rows) {
    if (row.role !== "bot" || row.murage) continue;
    if (row.engine) {
      if (!prev ? sawBotRow : prev.instanceId !== row.engine.instanceId) out.set(row.id, engineChangedLine(labelFor(row.engine)));
      prev = row.engine;
    }
    sawBotRow = true;
  }
  return out;
}

export interface ClaimExcerpt { text: string; state: CheckedClaim["state"]; rowId?: string }

/** The sentence a claim sits in, trimmed to a readable length, for the sidebar row. */
export function claimSentence(text: string, span: readonly [number, number], max = 140): string {
  const before = text.slice(0, span[0]).search(/[^.!?\n]*$/);
  const afterMatch = /[.!?\n]/.exec(text.slice(span[1]));
  const end = afterMatch ? span[1] + afterMatch.index + (afterMatch[0] === "\n" ? 0 : 1) : text.length;
  const sentence = text.slice(Math.max(0, before), end).replace(/\s+/g, " ").trim();
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}\u2026` : sentence;
}

export interface UnmatchedClaim { key: string; sentence: string; words: string; messageId: string; turnId?: string }

/** Claims with no matching record, as the sidebar lists them. A claim's span
 * is relative to the authored piece that holds it, so the piece is looked up. */
export function unmatchedClaims(
  messages: readonly { id: string; text?: string; turnId?: string; actionCheck?: ActionCheck }[] | undefined,
): UnmatchedClaim[] {
  const out: UnmatchedClaim[] = [];
  if (!messages) return out; // a bot that has not loaded its messages yet has no claims
  for (const reply of messages) {
    const check = reply.actionCheck;
    if (!check) continue;
    check.claims.forEach((claim, index) => {
      if (claim.state !== "flagged") return;
      const piece = messages.find((m) => m.id === claim.pieceId) ?? reply;
      const text = piece.text ?? "";
      const words = (claim.text ?? text.slice(claim.span[0], claim.span[1])).trim();
      if (!words) return;
      out.push({ key: `${reply.id}:${index}`, sentence: claimSentence(text, claim.span) || words, words, messageId: piece.id, turnId: reply.turnId });
    });
  }
  return out;
}

/** The words of each claim worth marking: flagged ones underlined, earlier ones linked. */
export function claimExcerpts(text: string, check: ActionCheck | undefined): ClaimExcerpt[] {
  if (!check) return [];
  return check.claims
    .filter((claim) => claim.state === "flagged" || claim.state === "earlier")
    .map((claim) => ({ text: (claim.text ?? text.slice(claim.span[0], claim.span[1])).trim(), state: claim.state, ...(claim.rowId ? { rowId: claim.rowId } : {}) }))
    .filter((excerpt) => excerpt.text.length > 0);
}
