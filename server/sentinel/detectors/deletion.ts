// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S05, deletion still pending (GAP-SENTINEL-109 section 5, class 5). Reads only persisted pending counts, the oldest
// pending time and holder clearance from obligation facts; it never reads what is being deleted. Logs alone never
// prove completion and a missing completion line never proves failure. Medium only: time alone never promotes it.
import type { EngineKind, ObligationFact } from "../../../shared/health-protocol.mjs";
import type { Coverage, Detector, DetectorInput, DetectorResult, EvidenceRef, Severity } from "../types.ts";
import { type HighWater, HOUR, MINUTE, evidenceFor, ingest, makeResult, tupleOf } from "./common.ts";
import { holdFingerprint } from "./engine-holds.ts";

export const DELETION_VERSION = 1;
/** Medium: a persisted pending deletion this old (elapsed UTC time, at or past). */
export const DELETION_PENDING_MS = 24 * HOUR;
/** Medium: still pending this many awake minutes after holder clearance, with at least DELETION_FAILED_ATTEMPTS failures. */
export const DELETION_AFTER_CLEAR_AWAKE_MS = 15 * MINUTE;
export const DELETION_FAILED_ATTEMPTS = 2;

export type DeletionEntry = {
  pending: number;
  oldest: number | null;
  holder: string;
  failedAfterClear: number;
  /** Awake clock when clearance with work still pending was first seen, or null. */
  clearSeenAwake: number | null;
  /** Oldest pending time when the issue last triggered: a later oldest proves that obligation ended. */
  triggeredOldest: number | null;
  counted: boolean;
};
export type DeletionState = { hw: HighWater | null; awake: number | null; entries: { readonly [engine: string]: DeletionEntry } };

export const deletionDetector: Detector<DeletionState> = {
  id: "deletion",
  version: DELETION_VERSION,
  evaluate(input: DetectorInput, prior: DeletionState | null) {
    const ingested = ingest(input, "deletion", ["obligation"], prior?.hw ?? null);
    const awakeNow = input.awake.awakeNowMs;
    const rebased = prior?.awake != null && awakeNow < prior.awake;
    const entries: Record<string, DeletionEntry> = {};
    for (const [key, entry] of Object.entries(prior?.entries ?? {})) entries[key] = { ...entry, clearSeenAwake: rebased && entry.clearSeenAwake !== null ? awakeNow : entry.clearSeenAwake };
    const evidence: Record<string, EvidenceRef[]> = {};

    for (const iw of ingested.windows) {
      if (iw.coverage === "unavailable") continue;
      iw.window.facts.forEach((fact, index) => {
        if (fact.kind !== "obligation" || fact.code !== "deletion") return;
        const f = fact as ObligationFact;
        const entry: DeletionEntry = entries[f.engineKind] ?? { pending: 0, oldest: null, holder: "unknown", failedAfterClear: 0, clearSeenAwake: null, triggeredOldest: null, counted: false };
        entry.pending = f.pendingCount;
        entry.oldest = f.oldestPendingAt;
        entry.holder = f.holderState;
        entry.failedAfterClear = f.failedAttemptsAfterClear;
        if (f.pendingCount > 0 && f.holderState === "clear") entry.clearSeenAwake ??= awakeNow;
        else entry.clearSeenAwake = null;
        (evidence[f.engineKind] ??= []).push(evidenceFor(iw, iw.window.counters.length + index));
        entries[f.engineKind] = entry;
      });
    }

    const results: DetectorResult[] = [];
    for (const [engine, entry] of Object.entries(entries)) {
      const aged = entry.pending > 0 && entry.oldest !== null && input.now - entry.oldest >= DELETION_PENDING_MS;
      const stuckAfterClear = entry.pending > 0 && entry.clearSeenAwake !== null && awakeNow - entry.clearSeenAwake >= DELETION_AFTER_CLEAR_AWAKE_MS && entry.failedAfterClear >= DELETION_FAILED_ATTEMPTS;
      const triggered: Severity | null = aged || stuckAfterClear ? "medium" : null;
      let occurrences = 0;
      if (triggered) {
        if (!entry.counted) occurrences = 1;
        entry.counted = true;
        entry.triggeredOldest = entry.oldest;
      }
      // Resolution needs a fresh persisted snapshot: nothing pending, or the affected (oldest) obligation has ended.
      const ended = !triggered && (entry.pending === 0 || (entry.triggeredOldest !== null && entry.oldest !== null && entry.oldest > entry.triggeredOldest));
      const coverage: Coverage = ingested.coverage;
      const metrics: Record<string, number> = { pending: entry.pending, failedAttemptsAfterClear: entry.failedAfterClear };
      if (entry.oldest !== null) metrics.oldestPendingHours = Math.max(0, Math.floor((input.now - entry.oldest) / HOUR));
      results.push(makeResult({
        tuple: tupleOf(input.installationId, "deletion", "deletion", engine as EngineKind, null, "pending-deletion"),
        triggered,
        occurrences,
        positive: ended,
        complete: ended,
        coverage,
        titleKey: "health.deletion.still-pending",
        window: { startAt: entry.oldest ?? input.now, endAt: input.now },
        metrics,
        evidence: evidence[engine] ?? [],
        relatedFingerprints: entry.holder === "held" || entry.clearSeenAwake !== null ? [holdFingerprint(input.installationId, engine as EngineKind, "deletion")] : [],
      }));
      if (ended) entry.counted = false;
      // Entries stay (bounded by the engine enum), so a recovery seen during a frozen scan is not lost.
    }
    return { results, nextState: { hw: ingested.hw, awake: awakeNow, entries } };
  },
};
