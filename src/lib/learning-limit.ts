// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The monthly learning limit as the Usage page and Needs you read it (Settings
// L6). Tokens only: a money figure waits for the Flux price list.
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { formatTokens } from "@/lib/usage";
import type { LearningCeiling, LearningCeilingStatus } from "../../shared/memory-learning-contract.ts";

/** The DOM id of the Memory page's limit card (L2 renders it; Usage's "Change the limit" opens there). */
export const LEARNING_LIMIT_ANCHOR = "memory-limit-heading";

/** What the schema accepts at most (learningCeilingSchema). */
const CEILING_MAX = 1_000_000_000_000;

/** "Double the limit": both sides doubled, never past what a limit may be. */
export function doubledCeiling(ceiling: LearningCeiling): LearningCeiling {
  return { input: Math.min(CEILING_MAX, ceiling.input * 2), output: Math.min(CEILING_MAX, ceiling.output * 2) };
}

/** Whole percent used, 0 to 100. A limit of 0 reads as fully used. */
export function ceilingPercent(used: number, limit: number): number {
  if (!(limit > 0)) return 100;
  return Math.max(0, Math.min(100, Math.round((100 * used) / limit)));
}

/** "Read: 2.1M of 100M tokens" */
export function readLine(status: Pick<LearningCeilingStatus, "input" | "inputUsed">): string {
  return t("learningText.limit.read" as LocaleKey, { used: formatTokens(status.inputUsed), limit: formatTokens(status.input) });
}

/** "Written: 300k of 15M tokens" */
export function writtenLine(status: Pick<LearningCeilingStatus, "output" | "outputUsed">): string {
  return t("learningText.limit.written" as LocaleKey, { used: formatTokens(status.outputUsed), limit: formatTokens(status.output) });
}

/** The request behind "Double the limit and resume". It carries the settings revision, so a change made elsewhere is not overwritten. */
export function doubleLimitRequest(ceiling: LearningCeiling, learningRevision: number) {
  return { action: "configure" as const, ceiling: doubledCeiling(ceiling), learningRevision };
}
