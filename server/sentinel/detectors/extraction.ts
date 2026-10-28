// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S03, learning extraction (GAP-SENTINEL-109 section 5, class 3). Counts only the transport-independent outcome
// counters (complete, unusable, cancelled, interrupted); deferrals happen before any call and never count. An
// interrupted attempt or an incomplete minute makes the rate unknown, never a calculated failure rate, and the
// absence of success lines is never read as failure. Consecutive failures are proven only from the per-window streak
// facts of adjacent complete windows; a cancelled, interrupted, missing or out-of-order window breaks the proof.
import type { EngineKind, ExtractionStreakFact } from "../../../shared/health-protocol.mjs";
import type { Coverage, Detector, DetectorInput, DetectorResult, EvidenceRef, Severity } from "../types.ts";
import { type BucketRow, type HighWater, type Ring, completeRun, evidenceFor, foldWindow, ingest, maxSeverity, makeResult, minutesWindow, tupleOf, worseCoverage } from "./common.ts";

export const EXTRACTION_VERSION = 1;
/** Medium: this many consecutive unusable admitted attempts within EXTRACTION_STREAK_MINUTES. */
export const EXTRACTION_STREAK = 3;
export const EXTRACTION_STREAK_MINUTES = 15;
/** High A: in 30 complete minutes, at least 10 settled, zero complete and at least 10 unusable. */
export const EXTRACTION_A_MINUTES = 30;
export const EXTRACTION_A_SETTLED = 10;
export const EXTRACTION_A_UNUSABLE = 10;
/** High B: in 60 complete minutes, at least 20 settled with an unusable fraction of at least 80% (cancellations excluded). */
export const EXTRACTION_B_MINUTES = 60;
export const EXTRACTION_B_SETTLED = 20;
export const EXTRACTION_B_FRACTION = 0.8;
/** Recovery: over a later 30 complete minutes, at least 5 complete with an unusable fraction of at most 20%. */
export const EXTRACTION_RECOVERY_MINUTES = 30;
export const EXTRACTION_RECOVERY_COMPLETE = 5;
export const EXTRACTION_RECOVERY_FRACTION = 0.2;
/** At most this many extractor/engine sources are tracked; an evicted source starts over with partial coverage. */
export const EXTRACTION_SOURCES_MAX = 8;
const RING = EXTRACTION_B_MINUTES;

// Ring columns after [minute, ok].
const COMPLETE = 2, UNUSABLE = 3, CANCELLED = 4, INTERRUPTED = 5;

export type ExtractionSource = {
  ring: Ring;
  /** Tail of the current unusable run: [minute, attempts] entries inside the streak window. */
  run: readonly (readonly [number, number])[];
  /** Last minute whose order was proven, or null; a gap after it breaks the streak. */
  streakMinute: number | null;
  /** Last minute any trigger held: recovery needs a window that starts at or after it. */
  triggeredMinute: number | null;
  /** Last minute the source was touched, for eviction. */
  touched: number;
};
/** `minutes`: every observed minute as [minute, ok]; it seeds a source seen for the first time, so the complete minutes
 * before its first attempt count as zero attempts instead of missing. */
export type ExtractionState = { hw: HighWater | null; sources: { readonly [key: string]: ExtractionSource }; minutes: Ring };

const keyOf = (engine: string, sourceKey: string | undefined) => `${engine}:${sourceKey ?? "-"}`;
const sum = (rows: readonly BucketRow[], column: number) => rows.reduce((total, row) => total + (row[column] ?? 0), 0);
const settled = (rows: readonly BucketRow[]) => sum(rows, COMPLETE) + sum(rows, UNUSABLE) + sum(rows, CANCELLED) + sum(rows, INTERRUPTED);
/** Unusable fraction with cancellations excluded, or null when unknown (an interrupted attempt) or nothing settled. */
function unusableFraction(rows: readonly BucketRow[]): number | null {
  if (sum(rows, INTERRUPTED) > 0) return null;
  const denominator = sum(rows, COMPLETE) + sum(rows, UNUSABLE);
  return denominator > 0 ? sum(rows, UNUSABLE) / denominator : null;
}

export const extractionDetector: Detector<ExtractionState> = {
  id: "extraction",
  version: EXTRACTION_VERSION,
  evaluate(input: DetectorInput, prior: ExtractionState | null) {
    const ingested = ingest(input, "extraction", ["extraction-streak"], prior?.hw ?? null);
    let coverage: Coverage = ingested.coverage;
    const sources: Record<string, ExtractionSource> = { ...(prior?.sources ?? {}) };
    const triggered: Record<string, Severity | null> = {};
    const occurrences: Record<string, number> = {};
    const evidence: Record<string, EvidenceRef[]> = {};
    const engines: Record<string, string> = {};
    const sourceKeys: Record<string, string | null> = {};
    for (const key of Object.keys(sources)) { const [engine, sk] = key.split(":"); engines[key] = engine!; sourceKeys[key] = sk === "-" ? null : sk!; }
    let minutes: BucketRow[] = [...(prior?.minutes ?? [])];
    const blank = (m: number): ExtractionSource => ({ ring: minutes.map(row => [row[0]!, row[1]!, 0, 0, 0, 0]), run: [], streakMinute: null, triggeredMinute: null, touched: m });
    const raise = (key: string, severity: Severity, m: number) => {
      triggered[key] = maxSeverity(triggered[key] ?? null, severity);
      sources[key] = { ...sources[key]!, triggeredMinute: m };
    };

    for (const iw of ingested.windows) {
      const m = iw.lastMinute;
      const values = new Map<string, number[]>();
      const rows = new Map<string, number>();
      iw.window.counters.forEach((row, index) => {
        if (row.detector !== "extraction") return;
        const column = row.code === "complete" ? COMPLETE : row.code === "unusable" ? UNUSABLE : row.code === "cancelled" ? CANCELLED : row.code === "interrupted" ? INTERRUPTED : -1;
        if (column < 0) return;
        const key = keyOf(row.engineKind, row.sourceKey);
        engines[key] = row.engineKind; sourceKeys[key] = row.sourceKey ?? null;
        const v = values.get(key) ?? [0, 0, 0, 0];
        v[column - COMPLETE]! += row.value;
        values.set(key, v);
        if (column === UNUSABLE && row.value > 0) rows.set(key, index);
      });
      const streaks = new Map<string, ExtractionStreakFact>();
      for (const fact of iw.window.facts) {
        if (fact.kind !== "extraction-streak") continue;
        const key = keyOf(fact.engineKind, fact.sourceKey);
        engines[key] = fact.engineKind; sourceKeys[key] = fact.sourceKey;
        streaks.set(key, fact);
      }
      const keys = new Set([...Object.keys(sources), ...values.keys(), ...streaks.keys()]);
      for (const key of keys) sources[key] ??= blank(m);
      minutes = foldWindow(minutes, iw, [], RING);
      for (const key of keys) {
        let source = sources[key] ?? blank(m);
        const v = values.get(key) ?? [0, 0, 0, 0];
        // Recency comes only from the source's own activity, so eviction is least recently active first.
        const active = values.has(key) || streaks.has(key);
        source = { ...source, ring: foldWindow(source.ring, iw, v, RING), touched: active ? m : source.touched };
        sources[key] = source;
        if (iw.ok && v[1]! > 0 && rows.has(key)) (evidence[key] ??= []).push(evidenceFor(iw, rows.get(key)!));
        if (iw.ok) occurrences[key] = (occurrences[key] ?? 0) + v[1]!;

        // Consecutive-unusable proof.
        const fact = streaks.get(key);
        const attempts = v[0]! + v[1]! + v[2]! + v[3]!;
        const contiguous = source.streakMinute === null || iw.firstMinute === source.streakMinute + 1;
        const broken = !iw.ok || v[2]! > 0 || v[3]! > 0 || (attempts > 0 && (fact === undefined || !fact.orderComplete)) || (fact !== undefined && !fact.orderComplete);
        if (broken) { sources[key] = { ...source, run: [], streakMinute: iw.ok ? m : null }; continue; }
        let run = contiguous ? [...source.run] : [];
        if (fact !== undefined && fact.settledCount > 0) {
          if (fact.maxConsecutiveUnusable >= EXTRACTION_STREAK) raise(key, "medium", m);
          const allUnusable = fact.trailingUnusable === fact.settledCount;
          const added = allUnusable ? fact.settledCount : fact.leadingUnusable;
          run = run.filter(([minute]) => minute > m - EXTRACTION_STREAK_MINUTES);
          if (added > 0) {
            run.push([m, added]);
            if (run.reduce((total, [, n]) => total + n, 0) >= EXTRACTION_STREAK) raise(key, "medium", m);
          }
          if (!allUnusable) run = fact.trailingUnusable > 0 ? [[m, fact.trailingUnusable]] : [];
        } else {
          run = run.filter(([minute]) => minute > m - EXTRACTION_STREAK_MINUTES);
        }
        sources[key] = { ...sources[key]!, run, streakMinute: m };
      }

      // Rate thresholds at this minute, per source.
      for (const [key, source] of Object.entries(sources)) {
        const a = completeRun(source.ring, m, EXTRACTION_A_MINUTES);
        if (a !== null && sum(a, INTERRUPTED) === 0 && settled(a) >= EXTRACTION_A_SETTLED && sum(a, COMPLETE) === 0 && sum(a, UNUSABLE) >= EXTRACTION_A_UNUSABLE) raise(key, "high", m);
        const b = completeRun(source.ring, m, EXTRACTION_B_MINUTES);
        const fraction = b === null ? null : unusableFraction(b);
        if (b !== null && fraction !== null && settled(b) >= EXTRACTION_B_SETTLED && fraction >= EXTRACTION_B_FRACTION) raise(key, "high", m);
      }
    }

    // Bounded map: evict the least recently active sources beyond the cap (a source active now always fits). Coverage
    // becomes partial, and an evicted source says it is no longer followed (source-retired), so an issue of an extractor
    // that went quiet is never left open with nothing reporting on it.
    const keys = Object.keys(sources).sort((x, y) => sources[y]!.touched - sources[x]!.touched);
    const results: DetectorResult[] = [];
    for (const key of keys.slice(EXTRACTION_SOURCES_MAX)) {
      delete sources[key];
      coverage = worseCoverage(coverage, "partial");
      results.push(makeResult({
        tuple: tupleOf(input.installationId, "extraction", "memory", (engines[key] ?? "other") as EngineKind, sourceKeys[key] ?? null, "unusable-replies"),
        triggered: null, occurrences: occurrences[key] ?? 0, positive: false, complete: false, coverage: "partial", retired: "source-retired",
        titleKey: "health.extraction.unusable-replies", window: { startAt: input.now, endAt: input.now }, metrics: {}, evidence: [],
      }));
    }

    for (const [key, source] of Object.entries(sources)) {
      const end = source.ring.length ? source.ring[source.ring.length - 1]![0]! : null;
      const recent = end === null ? null : completeRun(source.ring, end, EXTRACTION_RECOVERY_MINUTES);
      const fraction = recent === null ? null : unusableFraction(recent);
      const afterTrigger = end !== null && (source.triggeredMinute === null || end - EXTRACTION_RECOVERY_MINUTES >= source.triggeredMinute);
      const recovered = recent !== null && fraction !== null && afterTrigger && sum(recent, COMPLETE) >= EXTRACTION_RECOVERY_COMPLETE && fraction <= EXTRACTION_RECOVERY_FRACTION;
      const lastRow = end === null ? null : source.ring[source.ring.length - 1]!;
      const hour = end === null ? null : completeRun(source.ring, end, EXTRACTION_B_MINUTES);
      const metrics: Record<string, number> = { consecutiveUnusable: source.run.reduce((total, [, n]) => total + n, 0) };
      if (hour !== null) {
        metrics.settled = settled(hour); metrics.complete = sum(hour, COMPLETE); metrics.unusable = sum(hour, UNUSABLE);
        const f = unusableFraction(hour);
        if (f !== null) metrics.unusablePercent = Math.round(f * 100);
      }
      results.push(makeResult({
        tuple: tupleOf(input.installationId, "extraction", "memory", (engines[key] ?? "other") as EngineKind, sourceKeys[key] ?? null, "unusable-replies"),
        triggered: triggered[key] ?? null,
        occurrences: occurrences[key] ?? 0,
        positive: lastRow !== null && lastRow[1] === 1 && (lastRow[COMPLETE] ?? 0) > 0,
        complete: recovered,
        coverage: recent === null && hour === null ? worseCoverage(coverage, "partial") : coverage,
        titleKey: "health.extraction.unusable-replies",
        window: end === null ? { startAt: input.now, endAt: input.now } : minutesWindow(end, triggered[key] === "high" ? EXTRACTION_B_MINUTES : EXTRACTION_STREAK_MINUTES),
        metrics,
        evidence: evidence[key] ?? [],
      }));
    }
    return { results, nextState: { hw: ingested.hw, sources, minutes } };
  },
};
