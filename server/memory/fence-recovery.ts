// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Recovery decisions carry no authority: every rebuilt prompt is fenced again.
import { buildPrompt, noneRef, promptPart } from "./prompt-parts.ts";
import type { DatabaseSync } from "node:sqlite";
import type { EgressOrigin, SourceRange } from "../released-text.ts";
import { rangeHolds } from "../turn-source-holds.ts";
import type { BuiltPrompt, LineageRef, PromptPart, TurnLineage } from "./lineage-types.ts";

export type FenceTier = 0 | 1 | 2;
export const FENCE_REBUILDS = 2;
export function nextFenceTier(done: number): { tier: 1 | 2 } | undefined {
  if (!Number.isInteger(done) || done < 0 || done >= FENCE_REBUILDS) return undefined;
  return { tier: done === 0 ? 1 : 2 };
}
export type RecoveryCounts = { omitted: number; cause: "checking" | "changed" | "unknown" };
// Cause is deliberately retained even though the calm, factual copy works for
// all three: permanent revocation and lookup failure promise no future update.
export const LEFT_OUT_NOTE = "Murage left remembered details out of this reply.";
export const MESSAGE_ONLY_NOTE = "Murage prepared this reply from your message, with remembered context left out.";
export const NO_HUMAN_NOTE = "Murage left stored context out of this turn.";
export function recoveryNote(tier: FenceTier, counts: RecoveryCounts): { line: string; kind: "left-out" | "message-only" } | null {
  if (tier === 0 && !counts.omitted) return null;
  return tier === 2 ? { line: MESSAGE_ONLY_NOTE, kind: "message-only" } : { line: LEFT_OUT_NOTE, kind: "left-out" };
}
/** Source ranges keep their original hold-log stamp; a fresh rendering must never freshen a withdrawn source. */
export function recoveryFramePart(db: DatabaseSync, shown: { value: string; origins: readonly EgressOrigin[]; ranges: readonly SourceRange[] }, refs: readonly LineageRef[]): PromptPart | null {
  if (!shown.value || shown.ranges.some(range => !rangeHolds(range, db))) return null;
  return promptPart(shown.value, [noneRef("murage"), ...refs,
    ...shown.origins.flatMap(origin => origin.messageIds.map((messageId): LineageRef => ({ kind: "line", threadId: origin.threadId, messageId }))),
    ...shown.ranges.map((range): LineageRef => ({ kind: "prefix", threadId: range.threadId })),
  ]);
}
/** A delegated turn has no fresh human words, yet its recovery must still carry its task: the hand-off's own stored prompt line, read again
 * from the thread and named as that line (never none), so the send fence asks it again like any shown line. Null when the line is gone or empty. */
export function handoffFramePart(threadId: string, line: { readonly id: string; readonly text?: string | null } | null | undefined): PromptPart | null {
  const text = line?.text;
  if (!line || typeof text !== "string" || !text.trim()) return null;
  return promptPart(text, [{ kind: "line", threadId, messageId: line.id }]);
}
/** The same rule for every turn that has a task but no fresh human words (a hand-off, a routine run, a card continuation).
 * A delegated recovery that cannot carry its task does not run: the engine would answer the static instruction and the hand-off would read
 * as done. It is refused like any other revoked input, so the turn ends with its card and the hand-off fails. */
export function assertHandoffRecoveryCarriesTask(delegated: boolean, frame: PromptPart | null | undefined): void {
  if (delegated && !frame?.text.trim()) throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { continuationReason: "handoff-line-unavailable" });
}
/** Only the unexpanded, freshly typed human input may be owner-turn. Automated
 * triggers without fresh human words receive a static instruction; generated
 * deliveries and stored transcripts can never be relabelled none. The caller
 * must also empty the driver's separate transcript and stored payloads. */
export function messageOnlyPrompt(turn: TurnLineage | undefined, input: { rawHumanText: string | undefined; frame: string; now: string; serverFrame?: PromptPart | null }): BuiltPrompt {
  return buildPrompt(turn, [
    promptPart(input.frame, [noneRef("static")]),
    input.rawHumanText === undefined
      // Server authorship does not remove the sources of quoted results or card details.
      ? input.serverFrame ?? promptPart("Stored context is unavailable for this turn. Ask for a fresh message before continuing.", [noneRef("murage")])
      : promptPart(input.rawHumanText, [noneRef("owner-turn")]),
    promptPart(input.now, [noneRef("murage")]),
  ]);
}
