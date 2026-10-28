// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared, pure helpers for the Sentinel detectors (GAP-SENTINEL-109 sections 4.1, 5 and 9). No IO and no clock
// reads: every time comes from the DetectorInput.
//
// Minute buckets. Bucket m covers the minute ((m - 1) * 60 s, m * 60 s]: left-exclusive, right-inclusive, like every
// detector window. A window's rows land in the bucket holding its right endpoint; a quiet combined window marks every
// minute it spans. A bucket counts toward a threshold only when every relevant window that fed it was complete for
// the detector ("ok"). A minute nobody reported is a gap: it is never complete, so it breaks every consecutive run,
// every rate and every recovery window.
import { HEALTH_LIMITS, type CoverageValue, type EngineKind, type EvidenceRef, type OperationalWindow } from "../../../shared/health-protocol.mjs";
import type { Coverage, DetectorId, DetectorInput, DetectorResult, FingerprintTuple, IssueMetrics, MeasuredWindow, Severity, Subsystem } from "../types.ts";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/** Bucket index holding time t (UTC ms). */
export const minuteOf = (t: number): number => Math.ceil(t / MINUTE);
/** Right endpoint (UTC ms) of bucket m. */
export const minuteEnd = (m: number): number => m * MINUTE;

/** Per-detector share of the global 1,024 correlation slots (section 9). The sum is exactly the global cap. */
export const CORRELATION_SLOTS = Object.freeze({ "send-fence": 352, "dispatch-exhausted": 224, resets: 352, "isolation-noise": 96 } as const);

/** Correlation tokens are kept as their first 16 hex characters: enough to tell turns apart, small enough to fit. */
export const shortToken = (token: string): string => token.slice(0, 16);

const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };
export function maxSeverity(a: Severity | null, b: Severity | null): Severity | null {
  if (a === null) return b;
  if (b === null) return a;
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

const COVERAGE_RANK: Record<Coverage, number> = { complete: 0, "not-applicable": 0, partial: 1, unavailable: 2 };
/** The worse of two coverage values. */
export function worseCoverage(a: Coverage, b: Coverage): Coverage {
  return COVERAGE_RANK[a] >= COVERAGE_RANK[b] ? a : b;
}
/** A producer coverage value as a scanner coverage value; `other` is never complete. */
export function toCoverage(value: CoverageValue | undefined): Coverage {
  if (value === "complete" || value === "partial" || value === "unavailable" || value === "not-applicable") return value;
  return value === undefined ? "unavailable" : "partial";
}

// ---------------------------------------------------------------------------
// Window ingestion: replay protection, baseline limit, per-detector coverage
// ---------------------------------------------------------------------------

/** Highest (epoch, seq) folded in per producer. Windows at or below it are never counted again. */
export type HighWater = { readonly [producer: string]: readonly [number, number] };

export interface IngestedWindow {
  window: OperationalWindow;
  /** Coverage of this window for the detector. */
  coverage: Coverage;
  /** True when coverage is complete: its rows may count toward exact thresholds. */
  ok: boolean;
  firstMinute: number;
  lastMinute: number;
}

export interface Ingest {
  windows: IngestedWindow[];
  hw: HighWater;
  /** Coverage of this detector's inputs this scan. */
  coverage: Coverage;
}

const DISCONTINUOUS = new Set(["suspending", "resumed", "crashed", "other"]);

/** Does this window report on the detector? Server windows always do (every runtime producer lives in the server);
 * a desktop window does when it names the detector's coverage or carries one of its rows. */
function relevant(window: OperationalWindow, detector: DetectorId, factKinds: readonly string[]): boolean {
  if (window.producer === "server") return true;
  if (Object.hasOwn(window.coverageByDetector, detector)) return true;
  if (window.counters.some(row => row.detector === detector)) return true;
  return window.facts.some(fact => factKinds.includes(fact.kind));
}

/** Coverage of one window for one detector: its own entry when the producer named it, otherwise the window's
 * completeness. A suspend, resume or crash inside the window makes it partial at best. */
export function windowCoverage(window: OperationalWindow, detector: DetectorId): Coverage {
  const named = window.coverageByDetector[detector];
  let coverage: Coverage = named !== undefined ? toCoverage(named) : window.complete ? "complete" : "partial";
  if (coverage === "not-applicable") coverage = "complete";
  if (DISCONTINUOUS.has(window.lifecycle)) coverage = worseCoverage(coverage, "partial");
  return coverage;
}

const before = (a: readonly [number, number], b: readonly [number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);

/** Selects the new, relevant windows for a detector. Work is linear in the windows of this scan only (at most
 * HEALTH_LIMITS.recordsPerScan), never in the history already folded in. */
export function ingest(input: DetectorInput, detector: DetectorId, factKinds: readonly string[], hw: HighWater | null): Ingest {
  const next: Record<string, readonly [number, number]> = { ...(hw ?? {}) };
  const out: IngestedWindow[] = [];
  const baselineFloor = input.now - HEALTH_LIMITS.baselineWindowMs;
  let coverage: Coverage = "complete";
  let sawProducer = false;
  for (const producer of ["server", "desktop"] as const) {
    const role = input.sourceCoverage[producer];
    const list = input.windows[producer];
    if (role !== undefined && producer === "server") coverage = worseCoverage(coverage, toCoverage(role));
    for (const window of list) {
      if (window.installationId !== input.installationId) continue;
      if (!relevant(window, detector, factKinds)) continue;
      const key = window.producer;
      const id = [window.epoch, window.seq] as const;
      const mark = next[key];
      if (mark !== undefined && before(id, mark)) continue;
      // First scan: accept only the most recent 60 minutes (section 5 baseline).
      if (hw === null && window.endAt <= baselineFloor) continue;
      if (window.endAt > input.now) continue; // a window from the future is never evidence
      next[key] = id;
      const wc = windowCoverage(window, detector);
      const lastMinute = minuteOf(window.endAt);
      const span = Math.max(1, Math.round((window.endAt - window.startAt) / MINUTE));
      out.push({ window, coverage: wc, ok: wc === "complete", firstMinute: lastMinute - span + 1, lastMinute });
      coverage = worseCoverage(coverage, wc);
      if (producer === "server") sawProducer = true;
    }
  }
  if (!sawProducer && input.sourceCoverage.server === undefined) coverage = worseCoverage(coverage, "unavailable");
  return { windows: out, hw: next, coverage };
}

// ---------------------------------------------------------------------------
// Fixed ring of minute buckets: [minute, ok (1|0), ...values]
// ---------------------------------------------------------------------------

export type BucketRow = readonly number[];
export type Ring = readonly BucketRow[];

/** Folds one minute into a ring kept sorted by minute and cut to `cap` entries. A second report for the same minute
 * (the other producer) adds its values; the minute stays complete only when both reports were. */
export function upsertBucket(ring: Ring, minute: number, ok: boolean, values: readonly number[], cap: number): BucketRow[] {
  const rows = ring.map(row => [...row]);
  let index = rows.length - 1;
  while (index >= 0 && rows[index]![0]! > minute) index--;
  if (index >= 0 && rows[index]![0] === minute) {
    const row = rows[index]!;
    row[1] = row[1]! && ok ? 1 : 0;
    for (let i = 0; i < values.length; i++) row[2 + i] = (row[2 + i] ?? 0) + values[i]!;
  } else {
    rows.splice(index + 1, 0, [minute, ok ? 1 : 0, ...values]);
  }
  return rows.length > cap ? rows.slice(rows.length - cap) : rows;
}

/** Folds an ingested window into a ring: zero rows for the earlier minutes of a combined window, its values on the last. */
export function foldWindow(ring: Ring, iw: IngestedWindow, values: readonly number[], cap: number): BucketRow[] {
  let rows: BucketRow[] = [...ring];
  const zeros = values.map(() => 0);
  for (let m = iw.firstMinute; m < iw.lastMinute; m++) rows = upsertBucket(rows, m, iw.ok, zeros, cap);
  return upsertBucket(rows, iw.lastMinute, iw.ok, values, cap);
}

/** The n buckets of the window (endMinute - n, endMinute], oldest first, or null when any minute is missing or
 * incomplete. Work is bounded by the ring cap. */
export function completeRun(ring: Ring, endMinute: number, n: number): BucketRow[] | null {
  const out: BucketRow[] = [];
  let index = ring.length - 1;
  while (index >= 0 && ring[index]![0]! > endMinute) index--;
  for (let m = endMinute; m > endMinute - n; m--) {
    const row = ring[index];
    if (row === undefined || row[0] !== m || row[1] !== 1) return null;
    out.push(row);
    index--;
  }
  return out.reverse();
}

/** Length of the run of complete minutes ending at endMinute that satisfy `test`, capped at `limit`. */
export function runLength(ring: Ring, endMinute: number, limit: number, test: (row: BucketRow) => boolean): number {
  let index = ring.length - 1;
  while (index >= 0 && ring[index]![0]! > endMinute) index--;
  let length = 0;
  for (let m = endMinute; length < limit; m--) {
    const row = ring[index];
    if (row === undefined || row[0] !== m || row[1] !== 1 || !test(row)) break;
    length++;
    index--;
  }
  return length;
}

/** The newest minute in a ring, or null. */
export const lastMinute = (ring: Ring): number | null => (ring.length ? ring[ring.length - 1]![0]! : null);

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export function evidenceFor(iw: IngestedWindow, row: number): EvidenceRef {
  const cap = HEALTH_LIMITS.countersPerRecord + HEALTH_LIMITS.factsPerRecord;
  const producer = iw.window.producer === "desktop" ? "desktop" : "server";
  return { sourceRole: producer, epoch: iw.window.epoch, seq: iw.window.seq, bucket: Math.min(cap, Math.max(0, row)), observedAt: iw.window.endAt };
}

/** Keeps the newest HEALTH_LIMITS.evidencePerIssue references. */
export function capEvidence(list: readonly EvidenceRef[]): EvidenceRef[] {
  return list.slice(Math.max(0, list.length - HEALTH_LIMITS.evidencePerIssue));
}

export interface ResultParts {
  tuple: FingerprintTuple;
  triggered: Severity | null;
  occurrences: number;
  positive: boolean;
  complete: boolean;
  coverage: Coverage;
  pageEligible?: boolean;
  retired?: "policy-ended" | "source-retired";
  titleKey: string;
  window: MeasuredWindow;
  metrics: IssueMetrics;
  affectedTurns?: number;
  evidence?: readonly EvidenceRef[];
  relatedFingerprints?: readonly string[];
  presentedBy?: string;
}

/** Builds a DetectorResult. Recovery evidence never coexists with a trigger, and `complete` implies `positive`. */
export function makeResult(parts: ResultParts): DetectorResult {
  const triggered = parts.triggered;
  const complete = triggered === null && parts.complete;
  const positive = triggered === null && (parts.positive || complete);
  const out: DetectorResult = {
    tuple: parts.tuple,
    triggered,
    occurrences: Math.max(0, Math.floor(parts.occurrences)),
    recovery: { positive, complete },
    coverage: parts.coverage,
    pageEligible: triggered !== null && parts.pageEligible === true,
    titleKey: parts.titleKey,
    window: parts.window,
    metrics: parts.metrics,
    evidence: capEvidence(parts.evidence ?? []),
  };
  if (parts.retired !== undefined) out.retired = parts.retired;
  if (parts.affectedTurns !== undefined) out.affectedTurns = parts.affectedTurns;
  if (parts.relatedFingerprints?.length) out.relatedFingerprints = parts.relatedFingerprints.slice(0, HEALTH_LIMITS.relatedPerIssue);
  if (parts.presentedBy !== undefined) out.presentedBy = parts.presentedBy;
  return out;
}

export function tupleOf(installationId: string, detectorId: DetectorId, subsystem: Subsystem, engineKind: EngineKind | null, sourceKey: string | null, errorClass: string): FingerprintTuple {
  return { installationId, detectorId, subsystem, engineKind, sourceKey, errorClass };
}

/** A window measured in whole minutes ending at bucket `endMinute` (left-exclusive, right-inclusive). */
export const minutesWindow = (endMinute: number, minutes: number): MeasuredWindow => ({ startAt: minuteEnd(endMinute - minutes), endAt: minuteEnd(endMinute) });
