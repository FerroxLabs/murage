// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The frozen contract between the server and the Settings pages for the 1.0.3
// learning ceiling and smart search (SETTINGS-REDESIGN.md r2.2, r3.1 to r3.4,
// r4.1, r4.2; SETTINGS-LANES.md I0). Lanes L2, L3 and L6 build against these
// names; only I0's owner changes them. No imports: the server reads it as
// `../../shared/memory-learning-contract.ts`, the app without the extension.

/** Why a learning call was refused before dispatch. `spend-ceiling` is new in
 *  1.0.3 and distinct from `budget-exhausted`, which is pacing only. */
export const LEARNING_REFUSAL_REASONS = [
  "learning-disabled",
  "budget-exhausted",
  "spend-ceiling",
  "continuity-context-missing",
  "continuity-disabled",
] as const;
export type LearningRefusalReason = (typeof LEARNING_REFUSAL_REASONS)[number];

/** A grounding candidate left unjudged because its slice reached SLICE_CALL_GUARD
 *  calls: recorded as `{supported:false, reason:"slice-call-limit"}`. */
export const SLICE_CALL_LIMIT_REASON = "slice-call-limit" as const;

/** Tokens added to every input reservation for what the provider adds (r4.1). */
export const CALL_OVERHEAD_ALLOWANCE = 2048;
/** Extraction attempts per slice, across retries and restarts, before it is skipped (r3.2). */
export const SLICE_ATTEMPT_LIMIT = 3;
/** The consolidation intent fields 1.0.3 added (per-slice counters, the retry queue and its revision); the v11 -> v10 downgrade strips
 * exactly these, so a field added here can never be left behind for 1.0.2. */
export const CONSOLIDATION_V11_FIELDS = ["extractionAttempts", "sliceCalls", "skipped", "retries", "retried", "parked", "queueRevision"] as const;
/** Calls per slice: 1 extraction + 20 merged grounding calls = 21; the guard is 24 (r3.2). */
export const SLICE_CALL_GUARD = 24;

/** The stored ceiling (schema v3 `ceiling`), tokens per server-local calendar month. */
export interface LearningCeiling { input: number; output: number }
/** Interim default until the L3 measurement on Sean's data copy replaces it (r3.1). */
export const DEFAULT_LEARNING_CEILING: Readonly<LearningCeiling> = Object.freeze({ input: 100_000_000, output: 15_000_000 });

/** `status.learning.ceiling`, replacing `status.learning.allowance` (r3.4).
 *  `paused` is derived from the ledger against the ceiling on every read, never cached. */
export interface LearningCeilingStatus {
  /** Server-local month, "YYYY-MM". */
  month: string;
  input: number;
  output: number;
  inputUsed: number;
  outputUsed: number;
  paused: boolean;
}

export type SemanticIndexState = "ready" | "indexing" | "keyword-only";
/** `status.semantic`: smart search over memories. `indexing` while the records
 *  indexed before the bundled model was adopted get their embeddings. */
export interface SemanticIndexStatus { state: SemanticIndexState; done: number; total: number }

/** One slice a consolidation gave up on after SLICE_ATTEMPT_LIMIT attempts (r3.2). */
export interface SkippedSlice { cursor: number; length: number; reason: string; at: number }

/** `{action:"configure", ceiling, learningRevision}`: the raise and resume request (r3.4).
 *  A raise applies now and onward; the paused source's retryAfter becomes now. */
export interface ConfigureCeilingRequest { action: "configure"; ceiling: LearningCeiling; learningRevision: number }
/** `{action:"retry-skipped", sourceId, cursor}`: one more run of SLICE_ATTEMPT_LIMIT attempts for one skipped slice (r3.2). */
export interface RetrySkippedRequest { action: "retry-skipped"; sourceId: string; cursor: number }

/** Server-local calendar month of `at`, "YYYY-MM" (the clock of `continuityDay`). */
export function learningSpendMonth(at: number = Date.now()): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
export const learningSpendLedgerId = (month: string) => `learning-spend:${month}`;

/** True when the ledger has met the ceiling on either side. A zero ceiling is always met. */
export function ceilingReached(ceiling: LearningCeiling, used: { input: number; output: number }): boolean {
  return used.input >= ceiling.input || used.output >= ceiling.output;
}

/** The one admission rule (r4.1): refused with `spend-ceiling` when the reserve would pass either side. */
export function ceilingAdmits(ceiling: LearningCeiling, used: { input: number; output: number }, reserve: { input: number; output: number }): boolean {
  return used.input + reserve.input <= ceiling.input && used.output + reserve.output <= ceiling.output;
}

/** The smart search phrase of the Memory status line (copy rules: no em dashes). */
export function semanticStatusPhrase(semantic: SemanticIndexStatus): string {
  if (semantic.state === "keyword-only") return "Keyword memory until smart search is ready.";
  if (semantic.state === "ready") return "Smart search ready.";
  if (semantic.total <= 0) return "Getting smart search ready.";
  return `Indexing for smart search, ${semantic.done.toLocaleString("en-US")} of ${semantic.total.toLocaleString("en-US")}.`;
}
