// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S02, database write pressure (GAP-SENTINEL-109 section 5, class 2). Reuses the watchdog's charged bytes after the
// bounded planned-work deduction: rate = max(0, max(os, app) - planned) * 60000 / intervalMs, from valid 45-90 s
// samples only. Grouped by database/source class. The watchdog stays the only throttling authority; this only reports.
//
// The watchdog's sample is one process-wide charged rate per minute, labelled with the source class that wrote the most.
// Thresholds, the page and recovery are therefore measured on that process-wide rate, in one fixed ring of the last
// IO_RING_MINUTES minute buckets (the work per evaluation never grows with history); the source class is an annotation
// (metrics.topSourceClass), never a separate series. A minute with no valid sample is a gap: it breaks every
// consecutive run and every recovery window and makes coverage partial; it is never a calm minute.
import { IO_SOURCE_CLASSES, chargedRatePerMin, isValidIoSample, type IoMinuteFact } from "../../../shared/health-protocol.mjs";
import type { Coverage, Detector, DetectorInput, DetectorResult, EvidenceRef, Severity } from "../types.ts";
import { type BucketRow, type HighWater, type Ring, completeRun, evidenceFor, ingest, maxSeverity, makeResult, minutesWindow, runLength, tupleOf, upsertBucket, worseCoverage } from "./common.ts";

export const IO_VERSION = 2;
const MiB = 1024 * 1024;
/** An idle minute breaches above this charged rate (bytes/min). */
export const IO_IDLE_LIMIT = 1 * MiB;
/** An active minute breaches above this charged rate (bytes/min). */
export const IO_ACTIVE_LIMIT = 50 * MiB;
/** Idle charged writes at or above this rate for IO_IDLE_HEAVY_MINUTES consecutive minutes: High, page. */
export const IO_IDLE_HEAVY_RATE = 50 * MiB;
export const IO_IDLE_HEAVY_MINUTES = 5;
/** Medium: breaches in at least IO_MEDIUM_BREACHES of IO_MEDIUM_SPAN complete consecutive minutes. */
export const IO_MEDIUM_SPAN = 5;
export const IO_MEDIUM_BREACHES = 3;
/** High: the Medium condition holds for this many consecutive minutes. */
export const IO_HIGH_MINUTES = 10;
/** Recovery: this many consecutive complete minutes at or below the applicable budget. */
export const IO_RECOVERY_MINUTES = 10;
/** Revocation-repeat annotation: prior-deleted observations at or above this per minute, in 3 of the 5 minutes. */
export const IO_PRIOR_DELETED_PER_MIN = 1_000;
export const IO_RING_MINUTES = 16;
/** The one fingerprint class: the process-wide charged write rate. */
export const IO_ERROR_CLASS = "charged-writes";

// Ring columns after [minute, ok].
const BREACH = 2, IDLE_HEAVY = 3, MEDIUM = 4, PRIOR_DELETED = 5, RATE_KIB = 6, TOP_CLASS = 7;

export type IoState = {
  hw: HighWater | null;
  /** Rows [minute, ok, breach, idleHeavy, mediumHeld, priorDeleted, rateKiB, topClass], only for minutes with a sample. */
  ring: Ring;
  /** Newest breach minute already counted, so a replayed minute never counts twice. */
  lastCounted: number | null;
};

const classIndex = (value: string): number => (IO_SOURCE_CLASSES as readonly string[]).indexOf(value) + 1;

export const ioPressureDetector: Detector<IoState> = {
  id: "io-pressure",
  version: IO_VERSION,
  evaluate(input: DetectorInput, prior: IoState | null) {
    const ingested = ingest(input, "io-pressure", ["io-minute"], prior?.hw ?? null);
    let coverage: Coverage = ingested.coverage;
    let ring: BucketRow[] = [...(prior?.ring ?? [])];
    let lastCounted = prior?.lastCounted ?? null;
    let triggered: Severity | null = null;
    let page = false;
    let occurrences = 0;
    const evidence: EvidenceRef[] = [];
    let annotate = false;

    for (const iw of ingested.windows) {
      // The window's samples, oldest first, land on its last minutes (one sample a minute); extra ones share the first.
      const facts: { fact: IoMinuteFact; row: number }[] = [];
      iw.window.facts.forEach((fact, index) => { if (fact.kind === "io-minute") facts.push({ fact, row: iw.window.counters.length + index }); });
      const byMinute = new Map<number, { fact: IoMinuteFact; row: number }[]>();
      facts.forEach((sample, k) => {
        const m = Math.max(iw.firstMinute, iw.lastMinute - (facts.length - 1 - k));
        byMinute.set(m, [...(byMinute.get(m) ?? []), sample]);
      });
      let priorDeleted = 0;
      for (const row of iw.window.counters) if (row.detector === "io-pressure" && row.code === "prior-deleted") priorDeleted += row.value;

      for (let m = iw.firstMinute; m <= iw.lastMinute; m++) {
        const samples = byMinute.get(m);
        if (!samples) { coverage = worseCoverage(coverage, "partial"); continue; } // a gap, never calm
        let ok = iw.ok;
        let breach = 0, idleHeavy = 0, rateKiB = 0, top = 0;
        let worst: { fact: IoMinuteFact; row: number; rate: number } | null = null;
        for (const sample of samples) {
          const rate = chargedRatePerMin(sample.fact);
          if (!isValidIoSample(sample.fact) || rate === null) { ok = false; continue; }
          if (!worst || rate > worst.rate) worst = { ...sample, rate };
        }
        if (worst === null) ok = false;
        else {
          const limit = worst.fact.idle ? IO_IDLE_LIMIT : IO_ACTIVE_LIMIT;
          breach = worst.rate > limit ? 1 : 0;
          idleHeavy = worst.fact.idle && worst.rate >= IO_IDLE_HEAVY_RATE ? 1 : 0;
          rateKiB = Math.round(worst.rate / 1024);
          top = classIndex(worst.fact.sourceClass);
        }
        if (!ok) coverage = worseCoverage(coverage, "partial");
        ring = upsertBucket(ring, m, ok, [breach, idleHeavy, 0, m === iw.lastMinute ? priorDeleted : 0, rateKiB, top], IO_RING_MINUTES);
        // Medium at m: 3 of the 5 complete consecutive minutes (m-5, m] breach.
        const span = completeRun(ring, m, IO_MEDIUM_SPAN);
        const medium = span !== null && span.filter(row => row[BREACH] === 1).length >= IO_MEDIUM_BREACHES;
        if (medium) ring = ring.map(row => (row[0] === m ? Object.assign([...row], { [MEDIUM]: 1 }) : row));
        let severity: Severity | null = medium ? "medium" : null;
        if (runLength(ring, m, IO_HIGH_MINUTES, row => row[MEDIUM] === 1) >= IO_HIGH_MINUTES) severity = "high";
        if (runLength(ring, m, IO_IDLE_HEAVY_MINUTES, row => row[IDLE_HEAVY] === 1) >= IO_IDLE_HEAVY_MINUTES) { severity = "high"; page = true; }
        if (severity !== null) {
          triggered = maxSeverity(triggered, severity);
          if (span !== null && span.filter(row => (row[PRIOR_DELETED] ?? 0) >= IO_PRIOR_DELETED_PER_MIN).length >= IO_MEDIUM_BREACHES) annotate = true;
        }
        if (breach === 1 && ok && m > (lastCounted ?? -Infinity)) {
          occurrences++;
          lastCounted = m;
          if (worst) evidence.push(evidenceFor(iw, worst.row));
        }
      }
    }

    const results: DetectorResult[] = [];
    if (ring.length > 0) {
      const end = ring[ring.length - 1]![0]!;
      const calm = (row: BucketRow) => row[BREACH] === 0;
      const recoveryRun = runLength(ring, end, IO_RECOVERY_MINUTES, calm);
      const span = completeRun(ring, end, IO_MEDIUM_SPAN);
      const newestBreach = [...ring].reverse().find(row => row[BREACH] === 1 && (row[TOP_CLASS] ?? 0) > 0);
      const metrics: Record<string, number> = {
        breachMinutes: span ? span.filter(row => row[BREACH] === 1).length : 0,
        peakKiBPerMin: Math.max(0, ...ring.map(row => row[RATE_KIB] ?? 0)),
        calmMinutes: recoveryRun,
      };
      if (newestBreach) metrics.topSourceClass = newestBreach[TOP_CLASS]!;
      if (annotate) metrics.revocationRepeat = 1;
      results.push(makeResult({
        tuple: tupleOf(input.installationId, "io-pressure", "storage", null, null, IO_ERROR_CLASS),
        triggered,
        occurrences,
        positive: recoveryRun >= 1 && coverage === "complete",
        complete: recoveryRun >= IO_RECOVERY_MINUTES && coverage === "complete",
        coverage,
        pageEligible: page,
        titleKey: "health.io-pressure.sustained-writes",
        window: minutesWindow(end, IO_RECOVERY_MINUTES),
        metrics,
        evidence,
      }));
    }
    return { results, nextState: { hw: ingested.hw, ring, lastCounted } };
  },
};
