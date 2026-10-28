// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S04, engine home held (GAP-SENTINEL-109 section 5, class 4). Expected holders only produce a count. Runtime stalls
// use awake elapsed time, so sleep never counts. An unchecked holder state is unavailable coverage, never clear.
// When the pending work is deletion, the issue is presented under S05 (presentedBy) so one condition never makes
// two cards; both fingerprints stay distinct and point at each other.
import type { EngineKind, ObligationFact } from "../../../shared/health-protocol.mjs";
import { fingerprint, type Coverage, type Detector, type DetectorInput, type DetectorResult, type EvidenceRef, type Severity } from "../types.ts";
import { type HighWater, HOUR, MINUTE, evidenceFor, ingest, makeResult, tupleOf } from "./common.ts";

export const HOLDS_VERSION = 1;
/** Low: the same held condition with work still owed for this many awake hours. */
export const HOLDS_LOW_AWAKE_MS = 24 * HOUR;
/** Medium: work still pending this many awake minutes after two clear observations at least HOLDS_CLEAR_GAP_MS apart. */
export const HOLDS_MEDIUM_AWAKE_MS = 15 * MINUTE;
export const HOLDS_CLEAR_GAP_MS = 2 * MINUTE;

export type HoldEntry = {
  engine: string;
  code: string;
  pending: number;
  holder: string;
  /** Awake clock when the held condition was first seen, or null. */
  heldSinceAwake: number | null;
  /** observedAt of the first clear observation in the current clear stretch, or null. */
  clearFirstAt: number | null;
  /** Awake clock when two clear observations at least 2 min apart were confirmed, or null. */
  clearConfirmedAwake: number | null;
  /** Severity already counted as an occurrence in this stretch (0 none, 1 low, 2 medium). */
  counted: number;
  /** A completed operation or a no-work-pending observation since the last trigger. */
  recovered: boolean;
};
export type HoldsState = { hw: HighWater | null; awake: number | null; entries: { readonly [key: string]: HoldEntry } };

/** The S05 fingerprint a deletion hold is presented under. */
export const deletionFingerprint = (installationId: string, engine: EngineKind) =>
  fingerprint(tupleOf(installationId, "deletion", "deletion", engine, null, "pending-deletion"));
export const holdFingerprint = (installationId: string, engine: EngineKind, code: string) =>
  fingerprint(tupleOf(installationId, "engine-holds", "engine", engine, null, code));

export const engineHoldsDetector: Detector<HoldsState> = {
  id: "engine-holds",
  version: HOLDS_VERSION,
  evaluate(input: DetectorInput, prior: HoldsState | null) {
    const ingested = ingest(input, "engine-holds", ["obligation"], prior?.hw ?? null);
    const awakeNow = input.awake.awakeNowMs;
    // A host restart resets the awake clock: anchors from before it cannot be compared, so they restart now.
    const rebased = prior?.awake != null && awakeNow < prior.awake;
    const entries: Record<string, HoldEntry> = {};
    for (const [key, entry] of Object.entries(prior?.entries ?? {})) {
      entries[key] = rebased ? { ...entry, heldSinceAwake: entry.heldSinceAwake === null ? null : awakeNow, clearConfirmedAwake: entry.clearConfirmedAwake === null ? null : awakeNow } : { ...entry };
    }
    const evidence: Record<string, EvidenceRef[]> = {};

    for (const iw of ingested.windows) {
      if (iw.coverage === "unavailable") continue;
      iw.window.facts.forEach((fact, index) => {
        if (fact.kind !== "obligation") return;
        const f = fact as ObligationFact;
        const key = `${f.engineKind}:${f.code}`;
        const entry: HoldEntry = entries[key] ?? { engine: f.engineKind, code: f.code, pending: 0, holder: "unknown", heldSinceAwake: null, clearFirstAt: null, clearConfirmedAwake: null, counted: 0, recovered: false };
        entry.pending = f.pendingCount;
        entry.holder = f.holderState;
        if (f.completedDelta > 0 || f.pendingCount === 0) {
          // A completed operation or a fresh no-work-pending observation ends the stretch.
          Object.assign(entry, { heldSinceAwake: null, clearFirstAt: null, clearConfirmedAwake: null, counted: 0, recovered: true });
          if (f.pendingCount === 0) { entries[key] = entry; return; }
        }
        if (f.holderState === "held") {
          entry.heldSinceAwake ??= awakeNow;
          entry.clearFirstAt = null; entry.clearConfirmedAwake = null;
        } else if (f.holderState === "clear") {
          entry.heldSinceAwake = null;
          if (entry.clearFirstAt === null) entry.clearFirstAt = f.observedAt;
          else if (f.observedAt - entry.clearFirstAt >= HOLDS_CLEAR_GAP_MS) entry.clearConfirmedAwake ??= awakeNow;
        }
        (evidence[key] ??= []).push(evidenceFor(iw, iw.window.counters.length + index));
        entries[key] = entry;
      });
    }

    const results: DetectorResult[] = [];
    for (const [key, entry] of Object.entries(entries)) {
      const engine = entry.engine as EngineKind;
      // An unchecked (or unnamed) holder state is unavailable coverage, never clear.
      const unchecked = entry.holder !== "held" && entry.holder !== "clear";
      let triggered: Severity | null = null;
      if (entry.pending > 0 && !unchecked) {
        if (entry.holder === "held" && entry.heldSinceAwake !== null && awakeNow - entry.heldSinceAwake >= HOLDS_LOW_AWAKE_MS) triggered = "low";
        if (entry.holder === "clear" && entry.clearConfirmedAwake !== null && awakeNow - entry.clearConfirmedAwake >= HOLDS_MEDIUM_AWAKE_MS) triggered = "medium";
      }
      const rank = triggered === "medium" ? 2 : triggered === "low" ? 1 : 0;
      const occurrences = rank > entry.counted ? 1 : 0;
      if (rank > entry.counted) entry.counted = rank;
      if (triggered !== null) entry.recovered = false;
      const coverage: Coverage = unchecked && entry.pending > 0 ? "unavailable" : ingested.coverage;
      const metrics: Record<string, number> = { pending: entry.pending };
      if (entry.heldSinceAwake !== null) metrics.heldAwakeMin = Math.floor((awakeNow - entry.heldSinceAwake) / MINUTE);
      if (entry.clearConfirmedAwake !== null) metrics.pendingAfterClearAwakeMin = Math.floor((awakeNow - entry.clearConfirmedAwake) / MINUTE);
      const deletion = entry.code === "deletion";
      results.push(makeResult({
        tuple: tupleOf(input.installationId, "engine-holds", "engine", engine, null, entry.code),
        triggered,
        occurrences,
        positive: entry.recovered,
        complete: entry.recovered,
        coverage,
        titleKey: "health.engine-holds.home-held",
        window: { startAt: input.now - (triggered === "low" ? HOLDS_LOW_AWAKE_MS : HOLDS_MEDIUM_AWAKE_MS), endAt: input.now },
        metrics,
        evidence: evidence[key] ?? [],
        ...(deletion ? { presentedBy: deletionFingerprint(input.installationId, engine), relatedFingerprints: [deletionFingerprint(input.installationId, engine)] } : {}),
      }));
      // Entries stay (bounded by the engine and obligation enums), so a recovery seen during a frozen scan is not lost.
    }
    return { results, nextState: { hw: ingested.hw, awake: awakeNow, entries } };
  },
};
