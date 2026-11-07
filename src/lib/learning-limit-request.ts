// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { LEARNING_CEILING_MAX } from "../../server/memory/learning-policy.ts";
import type { LearningCeiling } from "../../shared/memory-learning-contract.ts";

/** "Double the limit": both sides doubled, never past what a limit may be. */
export function doubledCeiling(ceiling: LearningCeiling): LearningCeiling {
  return { input: Math.min(LEARNING_CEILING_MAX, ceiling.input * 2), output: Math.min(LEARNING_CEILING_MAX, ceiling.output * 2) };
}

/** The request behind "Double the limit and resume". It carries the settings revision, so a change made elsewhere is not overwritten. */
export function doubleLimitRequest(ceiling: LearningCeiling, learningRevision: number) {
  return { action: "configure" as const, ceiling: doubledCeiling(ceiling), learningRevision };
}


/** At both maxima a press can accept unseen usage, but cannot raise a limit. */
export function ceilingAtMaximum(ceiling: LearningCeiling): boolean {
  return ceiling.input === LEARNING_CEILING_MAX && ceiling.output === LEARNING_CEILING_MAX;
}
