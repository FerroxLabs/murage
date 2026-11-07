// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The monthly learning limit as the Usage page and Needs you read it (Settings
// L6). Tokens only: a money figure waits for the Flux price list.
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { formatTokens } from "@/lib/usage";
import type { LearningCeilingStatus } from "../../shared/memory-learning-contract.ts";

import { ceilingAtMaximum, doubledCeiling } from "./learning-limit-request.ts";
export { doubledCeiling, doubleLimitRequest, ceilingAtMaximum } from "./learning-limit-request.ts";

/** The DOM id of the Memory page's limit card (L2 renders it; Usage's "Change the limit" opens there). */
export const LEARNING_LIMIT_ANCHOR = "memory-limit-heading";

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

/** Offer doubling only when it puts every exhausted side strictly below its capped new limit. */
export function canRaiseCeiling(ceiling: Pick<LearningCeilingStatus, "input" | "output" | "inputUsed" | "outputUsed">): boolean {
  const next = doubledCeiling(ceiling);
  return !ceilingAtMaximum(ceiling)
    && (ceiling.inputUsed < ceiling.input || ceiling.inputUsed < next.input)
    && (ceiling.outputUsed < ceiling.output || ceiling.outputUsed < next.output);
}

/** Configure returns the current status, including usage that moved since the card was read. */
export function learningStillPaused(result: unknown): boolean {
  return (result as { learning?: { ceiling?: { paused?: boolean } } } | null)?.learning?.ceiling?.paused === true;
}
