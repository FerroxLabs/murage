// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Kinds a memory_learning_events row may carry. The list is frozen per schema
// version: schema.ts builds the table's CHECK from it, and the exact SQL text
// of every released version is what validateMemorySchema compares against, so
// never reorder or edit a published list; append a new one for a new version.

/** Kinds written since memory schema v4 (0.1.62 development). */
export const LEARNING_EVENT_KINDS_V4 = Object.freeze([
  "activated", "superseded", "merged", "retired-stale", "retired-time", "archived-contradicted",
  "procedure-proposed", "procedure-published", "pruned-batch", "connection-defaulted", "settings-migrated",
  "owner-undo", "owner-keep",
] as const);

/** Bot learning (schema v5): every step the owner may need to see or undo. */
export const LEARNING_EVENT_KINDS_V5 = Object.freeze([
  ...LEARNING_EVENT_KINDS_V4,
  "feedback-detected", "outcome-marked", "lesson-learned", "lesson-edited", "lesson-undone",
  "guide-suggested", "guide-applied", "guide-undone", "run-completed",
] as const);

export type LearningEventKindV5 = (typeof LEARNING_EVENT_KINDS_V5)[number];
