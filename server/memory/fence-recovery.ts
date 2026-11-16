// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Recovery decisions carry no authority: every rebuilt prompt is fenced again.
import { buildPrompt, noneRef, promptPart } from "./prompt-parts.ts";
import type { BuiltPrompt, TurnLineage } from "./lineage-types.ts";

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
/** Only the unexpanded, freshly typed human input may be owner-turn. Automated
 * triggers without fresh human words receive a static instruction; generated
 * deliveries and stored transcripts can never be relabelled none. The caller
 * must also empty the driver's separate transcript and stored payloads. */
export function messageOnlyPrompt(turn: TurnLineage | undefined, input: { rawHumanText: string | undefined; frame: string; now: string }): BuiltPrompt {
  return buildPrompt(turn, [
    promptPart(input.frame, [noneRef("static")]),
    input.rawHumanText === undefined
      ? promptPart("Stored context is unavailable for this turn. Ask for a fresh message before continuing.", [noneRef("murage")])
      : promptPart(input.rawHumanText, [noneRef("owner-turn")]),
    promptPart(input.now, [noneRef("murage")]),
  ]);
}
