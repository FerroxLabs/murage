// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Scanner-side types for Sentinel (1.0.9, GAP-SENTINEL-109 sections 6 and 8.1). Producer shapes live in
// shared/health-protocol.mjs; this file adds what the scanner, its store and the owner surfaces share: the durable
// issue, the detector contract and the published view. Types only, plus fingerprint().
import { createHash } from "node:crypto";
import type {
  BackupStatus, CoverageValue, DbStatsManifest, DbStatsRow, DetectorName, EngineKind, EvidenceRef, EvidenceSourceRole, OperationalWindow,
} from "../../shared/health-protocol.mjs";

export type { EvidenceRef } from "../../shared/health-protocol.mjs";

/** The ten detectors (S01..S10) by name. `other` is a producer category, never a scanner detector. */
export type DetectorId = Exclude<DetectorName, "other">;
export type Severity = "low" | "medium" | "high";
export type Delivery = "page" | "digest";
export type IssueState = "open" | "recovering" | "resolved";
/** Only observed-recovery is ever shown as "Recovered". */
export type Resolution = "observed-recovery" | "policy-ended" | "source-retired";
export type Coverage = "complete" | "partial" | "unavailable" | "not-applicable";
export type Subsystem = "backup" | "storage" | "memory" | "engine" | "deletion" | "dispatch" | "monitoring";
/** The concrete next action a detail row offers (section 8.1). Fixed destinations, never an input-supplied URL or path. */
export type NextAction = "backups" | "memory-settings" | "manage-storage" | "diagnostics" | "none";

/** Coverage of one issue, with per-source status and the last time each source was complete. */
export interface IssueCoverage {
  overall: Coverage;
  sources: ReadonlyArray<{ role: EvidenceSourceRole; status: Coverage; lastCompleteAt: number | null }>;
}

/** The measured window an issue's counts describe (UTC ms, left-exclusive, right-inclusive). */
export interface MeasuredWindow { startAt: number; endAt: number }

/** Detector-defined numeric metrics: fixed keys per detector, at most ISSUE_METRICS_MAX entries, numbers only. */
export type IssueMetrics = Readonly<Record<string, number>>;
export const ISSUE_METRICS_MAX = 16;

/** The durable issue (section 6.1), exactly. */
export interface Issue {
  schemaVersion: 1;
  fingerprint: string;
  detectorVersion: number;
  detectorId: DetectorId;
  installationId: string;
  subsystem: Subsystem;
  engineKind?: EngineKind;
  sourceKey?: string;
  /** Closed error class from the detector's own list. */
  code: string;
  severity: Severity;
  state: IssueState;
  episode: number;
  /** Key into the fixed copy table; never free text from an input. */
  titleKey: string;
  /** Persists across episodes. */
  firstSeenAt: number;
  /** Advances only with new triggering evidence; viewing or rescanning never moves it. */
  lastSeenAt: number;
  /** Resets when an episode reopens. */
  openedAt: number;
  resolvedAt?: number;
  resolution?: Resolution;
  /** Detector-defined occurrence count, never a scan count. */
  count: number;
  affectedTurns?: number;
  window: MeasuredWindow;
  metrics: IssueMetrics;
  /** At most HEALTH_LIMITS.evidencePerIssue (3). */
  evidence: readonly EvidenceRef[];
  coverage: IssueCoverage;
  /** At most HEALTH_LIMITS.relatedPerIssue (4). */
  relatedFingerprints: readonly string[];
  /** Presentation group (section 6.1, additive): the fingerprint of the issue whose row shows this one (S04 under
   * S05, S06 under S07, a High S08 under S07). Absent when the issue has its own row. Never changes this fingerprint. */
  presentedBy?: string;
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

export const FINGERPRINT_VERSION = 1;

/** The fixed tuple a fingerprint covers (section 6.1). No text, timestamps, paths, record ids or thread names. */
export interface FingerprintTuple {
  installationId: string;
  detectorId: DetectorId;
  subsystem: Subsystem;
  engineKind: EngineKind | null;
  /** Opaque source key where the detector groups by source; null otherwise. */
  sourceKey: string | null;
  /** Closed error class. */
  errorClass: string;
}

/** SHA-256 over the versioned fixed tuple, as lowercase hex. Reads only the named tuple fields, in a fixed order, so
 * any other property a caller passes (a timestamp, a message) can never change or enter the fingerprint. */
export function fingerprint(tuple: FingerprintTuple): string {
  const fixed = ["murage-sentinel-fingerprint", FINGERPRINT_VERSION, tuple.installationId, tuple.detectorId, tuple.subsystem, tuple.engineKind ?? null, tuple.sourceKey ?? null, tuple.errorClass];
  return createHash("sha256").update(JSON.stringify(fixed)).digest("hex");
}

// ---------------------------------------------------------------------------
// Detector contract
// ---------------------------------------------------------------------------

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
/** A detector's own small, bounded JSON state, persisted by the store with the scan's single commit. */
export type DetectorState = { readonly [key: string]: JsonValue };
/** Serialised detector state above this many bytes is refused by the store. */
export const DETECTOR_STATE_MAX_BYTES = 64 * 1024;

/** Awake-time facts for runtime thresholds: sleep is never a failure duration. */
export interface AwakeInfo {
  /** Monotonic awake clock now (ms); excludes time the host was suspended. */
  awakeNowMs: number;
  /** Awake clock at the previous committed scan, or null on the first scan. */
  previousAwakeMs: number | null;
  /** A suspend, resume or wall-clock jump happened since the previous scan: freeze recovery accumulation. */
  discontinuity: boolean;
}

/** One sealed database statistics generation, already validated. */
export interface DbStatsSnapshot { manifest: DbStatsManifest; rows: readonly DbStatsRow[] }

/** What every detector sees in one scan. Only validated records reach it. */
export interface DetectorInput {
  installationId: string;
  /** UTC ms. */
  now: number;
  awake: AwakeInfo;
  /** Validated windows per producer, ordered by (epoch, seq), new since the detector's cursor or within the baseline window. */
  windows: Readonly<{ server: readonly OperationalWindow[]; desktop: readonly OperationalWindow[] }>;
  backupStatus: BackupStatus | null;
  dbStats: DbStatsSnapshot | null;
  /** Coverage of each input source this scan, from the readers. */
  sourceCoverage: Readonly<Partial<Record<EvidenceSourceRole, CoverageValue>>>;
  /** Additive: UTC ms of recent scan attempts that failed (newest last, at most 16), from the scanner core. S10 counts
   * them; absent means none known. */
  scanFailures?: readonly number[];
}

/** Recovery evidence for one fingerprint this scan. */
export interface RecoveryEvidence {
  /** At least one positive recovery observation (open becomes recovering). */
  positive: boolean;
  /** The detector-specific recovery rule is fully met (recovering becomes resolved with observed-recovery). */
  complete: boolean;
}

/** One detector's verdict for one fingerprint tuple this scan. The store applies the section 6.2 lifecycle. */
export interface DetectorResult {
  tuple: FingerprintTuple;
  /** The exact threshold met this scan, or null when no trigger holds. */
  triggered: Severity | null;
  /** New occurrences counted this scan (never re-counted on replay). */
  occurrences: number;
  recovery: RecoveryEvidence;
  coverage: Coverage;
  /** Only S01 and S02 can set this (section 8.2). */
  pageEligible: boolean;
  /** Explicit retirement: policy ended or the source went away. Never a claim that the problem was repaired. */
  retired?: Exclude<Resolution, "observed-recovery">;
  titleKey: string;
  window: MeasuredWindow;
  metrics: IssueMetrics;
  affectedTurns?: number;
  evidence: readonly EvidenceRef[];
  relatedFingerprints?: readonly string[];
  /** Additive: show this result under another issue's row (see Issue.presentedBy). */
  presentedBy?: string;
}

export interface DetectorOutput<S extends DetectorState = DetectorState> { results: readonly DetectorResult[]; nextState: S }

export interface Detector<S extends DetectorState = DetectorState> {
  readonly id: DetectorId;
  readonly version: number;
  /** Pure: no IO, no clock reads beyond `input.now` and `input.awake`. `prior` is null on the first scan. */
  evaluate(input: DetectorInput, prior: S | null): DetectorOutput<S>;
}

// ---------------------------------------------------------------------------
// Published view (view.json): summary plus at most 25 compact rows, within 16 KiB
// ---------------------------------------------------------------------------

export type ScannerStatus = "running" | "stopped" | "unavailable" | "upgrade-needed";

export interface ViewSummary {
  openCount: number;
  /** Highest severity among unresolved issues, or null when none. */
  highestSeverity: Severity | null;
  /** Copy key of the highest-impact unresolved issue, or null. */
  topTitleKey: string | null;
  /** Last scan that committed ("Checked 2 min ago"). */
  lastCheckedAt: number | null;
  /** Last scan with complete coverage ("Last complete check"). */
  lastCompleteCheckAt: number | null;
  coverage: Coverage;
  scanner: ScannerStatus;
  /** Issues resolved with observed-recovery since the last digest. */
  recoveredCount: number;
  /** Unresolved issues beyond the rows shown. */
  moreCount: number;
}

export interface ViewRow {
  fingerprint: string;
  detectorId: DetectorId;
  titleKey: string;
  severity: Severity;
  state: IssueState;
  delivery: Delivery;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  coverage: Coverage;
  resolution?: Resolution;
  resolvedAt?: number;
  nextAction: NextAction;
}

export interface SentinelView {
  schemaVersion: 1;
  /** Store revision the view was built from; detail cursors carry it and refresh when it changes. */
  storeRevision: number;
  publishedAt: number;
  summary: ViewSummary;
  /** At most HEALTH_LIMITS.viewRows (25). */
  rows: readonly ViewRow[];
}
