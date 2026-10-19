// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The sentences of the Memory page's status lines and the learning history, in the language in use.
// They live apart from memory-learning.ts because that file is read by server tests, which cannot
// reach the renderer's language catalogue.
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { ceilingState, formatTokens, learningConnectionLabel, type LearningCeilingStatus, type MemoryLearning, type SemanticIndexStatus } from "@/lib/memory-learning";

export function learningStatusLine(mode: string, learning: MemoryLearning): string {
  const { settings, connection } = learning;
  if (mode === "off") return t("memoryLearning.status.memoryOff");
  if (mode === "paused") return t("memoryLearning.status.paused");
  if (!settings.automaticFacts && !settings.automaticProcedures) return t("memoryLearning.status.nothingOn");
  if (connection.source === "none") {
    if (connection.reason === "Add your Flux key or choose a connection.") return t("memoryLearning.status.addKey");
    if (connection.reason?.startsWith("Learning is paused:")) return connection.reason;
    return connection.reason ? t("memoryLearning.status.pausedReason", { reason: connection.reason }) : t("memoryLearning.status.addKey");
  }
  if (settings.reviewMode || connection.source === "default" && !learning.defaultOn) return t("memoryLearning.status.review");
  return t("memoryLearning.status.on", { connection: learningConnectionLabel(connection.label) });
}

const EVENT_LABELS: Record<string, LocaleKey> = {
  activated: "memoryLearning.event.learned", superseded: "memoryLearning.event.updated", merged: "memoryLearning.event.combined",
  "retired-stale": "memoryLearning.event.archived", "retired-time": "memoryLearning.event.archived", "archived-contradicted": "memoryLearning.event.archived",
  "procedure-proposed": "memoryLearning.event.procedureSuggested", "procedure-published": "memoryLearning.event.procedureUpdated",
  "pruned-batch": "memoryLearning.event.sourcesRemoved", "connection-defaulted": "memoryLearning.event.connectionSet", "settings-migrated": "memoryLearning.event.settingsUpdated",
  "owner-undo": "memoryLearning.event.undone", "owner-keep": "memoryLearning.event.kept", "feedback-detected": "memoryLearning.event.feedback",
  "outcome-marked": "memoryLearning.event.outcome", "lesson-learned": "memoryLearning.event.lessonLearned", "lesson-edited": "memoryLearning.event.lessonEdited",
  "lesson-undone": "memoryLearning.event.lessonUndone", "guide-suggested": "memoryLearning.event.guideSuggested", "guide-applied": "memoryLearning.event.guideApplied",
  "guide-undone": "memoryLearning.event.guideUndone", "run-completed": "memoryLearning.event.runFinished",
};
export function learningEventLabel(kind: string): string {
  return t(EVENT_LABELS[kind] ?? "memoryLearning.event.fallback");
}

export function learningRequestError(error: unknown): string {
  const text = error instanceof Error ? error.message : "";
  if (text.includes("MEMORY_LEARNING_REVISION_CONFLICT")) return t("memoryLearning.error.conflict");
  if (text.includes("MEMORY_EXTRACTOR_UNAVAILABLE")) return t("memoryLearning.error.connection");
  if (text.startsWith("This memory changed since it was learned.") || text === "This learning item cannot be changed.") return text;
  return t("memoryLearning.error.generic");
}

/** "Learning this month: 2.1M tokens read, 0.3M written." */
export const ceilingMonthLine = (ceiling: LearningCeilingStatus) => t("settings.l2.usage.month", { read: formatTokens(ceiling.inputUsed), written: formatTokens(ceiling.outputUsed) });

/** The second line under the switch: usage, the paused sentence or the off sentence. `raise`/`openAdvanced` tell the page which action follows. */
export function ceilingStatusLine(ceiling: LearningCeilingStatus): { text: string; follow: "none" | "raise" | "advanced" } {
  const state = ceilingState(ceiling);
  if (state === "off") return { text: t("memoryLearning.ceiling.off"), follow: "advanced" };
  if (state === "paused") return { text: t("memoryLearning.ceiling.paused"), follow: "raise" };
  return { text: ceilingMonthLine(ceiling), follow: "none" };
}

/** The smart-search phrase of the status line (the same words as the shared contract's, in the language in use). */
export function semanticPhrase(semantic: SemanticIndexStatus): string {
  if (semantic.state === "keyword-only") return t("memoryLearning.semantic.keywordOnly");
  if (semantic.state === "ready") return t("memoryLearning.semantic.ready");
  if (semantic.total <= 0) return t("memoryLearning.semantic.starting");
  return t("memoryLearning.semantic.indexing", { done: semantic.done.toLocaleString("en-US"), total: semantic.total.toLocaleString("en-US") });
}

/** The first line of the Memory page: how learning is going, what is saved and waiting, and how smart search is. */
export function memoryStatusLine(input: { mode: string; learning: MemoryLearning; memories: number; memoriesMore?: boolean; waiting: number; semantic?: SemanticIndexStatus | null }): string {
  const count = `${input.memories.toLocaleString("en-US")}${input.memoriesMore ? "+" : ""}`;
  const one = input.memories === 1 && !input.memoriesMore;
  const counts = input.waiting > 0
    ? t(one ? "memoryLearning.counts.oneWaiting" : "memoryLearning.counts.manyWaiting", { count, waiting: input.waiting.toLocaleString("en-US") })
    : t(one ? "memoryLearning.counts.one" : "memoryLearning.counts.many", { count });
  return [learningStatusLine(input.mode, input.learning), counts, input.semantic ? semanticPhrase(input.semantic) : ""].filter(Boolean).join(" ");
}

/** Said when part of a conversation could not be learned from. */
export const skippedSliceMessage = () => t("memoryLearning.skipped");
