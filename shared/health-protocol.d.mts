// SPDX-License-Identifier: AGPL-3.0-or-later
// Declarations for shared/health-protocol.mjs: the frozen Sentinel producer contract (1.0.9).

type Other = "other";

export const HEALTH_SCHEMA_VERSION: 1;
export const HEALTH_LIMITS: Readonly<{
  recordBytes: number; countersPerRecord: number; factsPerRecord: number; producerBytesPerMinute: number; producerBytesPerDay: number;
  windowMs: number; quietCombineWindows: number; maxWindowSpanMs: number; ioSampleMinMs: number; ioSampleMaxMs: number;
  scanCadenceMs: number; scanJitterMaxMs: number; inputFilesPerScan: number; statOpsPerScan: number;
  readBytesPerScan: number; readChunkBytes: number; recordsPerScan: number; statsSnapshotBytes: number; baselineTailBytes: number; baselineWindowMs: number;
  statsQueriesPerScan: number; statsRowsPerScan: number; dbStatsRoles: number;
  scanCpuMs: number; scanRssBytes: number; scanWallMs: number;
  outputIdleBytesPerDay: number; outputHardBytesPerDay: number; outputReserveBytes: number; commitsPerScan: number; commitBytes: number;
  changedIssuesPerScan: number; heartbeatMinIntervalMs: number;
  stateBytes: number; issueRows: number; correlationEntries: number; resolvedRetentionMs: number; evidencePerIssue: number; relatedPerIssue: number;
  viewRows: number; viewBytes: number; apiLimitDefault: number; apiLimitMax: number; apiResponseBytes: number;
  producerSegmentBytes: number; producerSegments: number; scannerLogBytes: number; repeatedFaultLogIntervalMs: number;
}>;
export const HEALTH_BOUNDS: Readonly<{ count: number; bytes: number; durationMs: number; timestampMs: number; epoch: number; seq: number; revision: number; generation: number; pollScale: number }>;
export const HEALTH_TOKEN_PATTERN: RegExp;

export type Producer = "server" | "desktop" | Other;
export type Lifecycle = "running" | "suspending" | "resumed" | "stopping" | "stopped" | "crashed" | Other;
export type DetectorName = "backup" | "io-pressure" | "extraction" | "engine-holds" | "deletion" | "send-fence" | "dispatch-exhausted" | "resets" | "isolation-noise" | "coverage" | Other;
export type DetectorClass = "S01" | "S02" | "S03" | "S04" | "S05" | "S06" | "S07" | "S08" | "S09" | "S10";
export type EngineKind = "claude" | "codex" | "pi" | "acp" | "antigravity" | "gateway" | "opencode-go" | "openai-chat" | "none" | Other;
export type CoverageValue = "complete" | "partial" | "unavailable" | "not-applicable" | Other;
export type ExtractionUnusableCode = "not-json" | "schema" | "length" | "tool-call" | "empty" | "response-limit" | "transport" | Other;
export type ExtractionOutcome = "admitted" | "complete" | "unusable" | "cancelled" | "interrupted" | "deferred-busy" | "deferred-unconfigured" | "deferred-budget" | Other;
export type BackupPhase = "off" | "idle" | "due" | "capturing" | "verifying" | "waiting-owner" | "failed" | Other;
export type BackupResult = "verified" | "failed" | "waiting" | "off" | Other;
export type BackupFailureCode = "capture-failed" | "verification-failed" | "destination-unavailable" | "key-unavailable" | "source-changed" | "unclassified-component" | "deadline-passed" | "disk-full" | "permission-denied" | "binding-changed" | Other;
export type IoSourceClass = "messages-db" | "memory" | "memory-index-db" | "skill-index-db" | "connected-app-ledger-db" | "engine-history" | "backup-work" | Other;
export type HolderState = "held" | "clear" | "unknown" | Other;
export type ObligationCode = "deletion" | "engine-history" | "memory-revocation" | Other;
export type TurnFinal = "completed" | "exhausted" | "cancelled" | Other;
export type ResetReason = "context-overflow" | "session-expired" | "resume-failed" | "engine-error" | "history-rebuild" | "send-fence" | "owner-new-session" | "engine-change" | Other;
export type FrontMatterFallbackCode = "no-front-matter" | "parse-error" | "missing-name" | "too-large" | "unreadable" | Other;
export type RevocationOperation = "affect" | "tombstone" | "state-update" | "index-update" | "lineage-walk" | "purge" | Other;
export type RevocationCounterCode = "affect-attempts" | "prior-deleted" | "state-changed" | "bytes-attributed" | Other;
export type SendFenceCode = "refusal" | "rebuild" | "recovered" | "exhausted" | "cancelled" | "lookup-error" | Other;
export type DeletionCode = "pending" | "held" | "retry" | "completed" | Other;
export type ProducerLifecycleCode = "boot" | "shutdown" | "suspend" | "resume" | "registration" | "schedule-ok" | "schedule-failed" | "gap" | Other;
export type FactKind = "turn-window" | "obligation" | "isolation" | "io-minute" | "extraction-streak";
export type DbStatsRole = "messages" | "memory" | "memory-index" | "skill-index" | "connected-app-ledger" | "engine-history" | "backup-work" | Other;
export type EvidenceSourceRole = "server" | "desktop" | "backup" | "db-stats" | Other;

export const PRODUCERS: readonly Producer[];
export const LIFECYCLES: readonly Lifecycle[];
export const DETECTOR_IDS: readonly DetectorName[];
export const DETECTOR_CLASS: Readonly<Record<Exclude<DetectorName, Other>, DetectorClass>>;
export const ENGINE_KINDS: readonly EngineKind[];
export const COVERAGE_VALUES: readonly CoverageValue[];
export const EXTRACTION_UNUSABLE_CODES: readonly ExtractionUnusableCode[];
export const EXTRACTION_OUTCOMES: readonly ExtractionOutcome[];
export const BACKUP_PHASES: readonly BackupPhase[];
export const BACKUP_RESULTS: readonly BackupResult[];
export const BACKUP_FAILURE_CODES: readonly BackupFailureCode[];
export const IO_SOURCE_CLASSES: readonly IoSourceClass[];
export const HOLDER_STATES: readonly HolderState[];
export const OBLIGATION_CODES: readonly ObligationCode[];
export const TURN_FINALS: readonly TurnFinal[];
export const RESET_REASONS: readonly ResetReason[];
export const RESET_REASONS_NOT_AUTOMATIC: readonly ResetReason[];
export const FRONT_MATTER_FALLBACK_CODES: readonly FrontMatterFallbackCode[];
export const REVOCATION_OPERATIONS: readonly RevocationOperation[];
export const REVOCATION_COUNTER_CODES: readonly RevocationCounterCode[];
export const SEND_FENCE_CODES: readonly SendFenceCode[];
export const DELETION_CODES: readonly DeletionCode[];
export const PRODUCER_LIFECYCLE_CODES: readonly ProducerLifecycleCode[];
export const FACT_KINDS: readonly FactKind[];
export const DB_STATS_ROLES: readonly DbStatsRole[];
export const EVIDENCE_SOURCE_ROLES: readonly EvidenceSourceRole[];
export const COUNTER_CODES_BY_DETECTOR: Readonly<Record<DetectorName, readonly string[]>>;
export const FACT_DETECTORS: Readonly<Record<FactKind, readonly DetectorName[]>>;

export const DB_STATS_TABLES: Readonly<{ snapshot: readonly ["version", "installation_id", "generation", "at", "coverage"]; db_stats: readonly ["role", "sampled_at", "page_size", "page_count", "freelist_pages", "db_bytes", "wal_bytes", "pending_revocations", "oldest_pending_at"] }>;
export const DB_STATS_SCHEMA_VERSION: 1;
export function dbStatsFileName(generation: number): string;
export const HEALTH_DIR: "health";
export const HEALTH_FILES: Readonly<{ serverCurrent: string; serverPrevious: string; desktopCurrent: string; desktopPrevious: string; dbStatsManifest: string; backupStatus: string }>;
export function toEngineKind(value: unknown): EngineKind;

export interface CounterRow {
  detector: DetectorName;
  engineKind: EngineKind;
  /** One of COUNTER_CODES_BY_DETECTOR[detector]. */
  code: string;
  value: number;
  sourceKey?: string;
  denominator?: number;
  maxDurationMs?: number;
}
export interface TurnWindowFact { kind: "turn-window"; scopeToken: string; turnToken: string; engineKind: EngineKind; at: number; refusalDelta: number; rebuildMsDelta: number; resetDelta: number; final: TurnFinal | null }
export interface ObligationFact { kind: "obligation"; engineKind: EngineKind; code: ObligationCode; pendingCount: number; oldestPendingAt: number | null; holderState: HolderState; holderClearAt?: number; failedAttemptsAfterClear: number; completedDelta: number; observedAt: number }
export interface IsolationFact { kind: "isolation"; engineKind: EngineKind; launchToken: string; completedScan: boolean; fallbackDelta: number }
export interface IoSample {
  idle: boolean; intervalMs: number;
  /** null where the OS write counter is not available. */
  osBytes: number | null;
  applicationBytes: number; plannedBytesAllowed: number; chargedBytes: number; budgetBytes: number;
  /** 0..1 */
  cpuFraction: number;
  pollScale: number; sourceClass: IoSourceClass;
  /** true when a suspend, resume or clock jump fell inside the interval. */
  discontinuity: boolean;
}
export interface IoMinuteFact extends IoSample { kind: "io-minute" }
export interface ExtractionStreakFact { kind: "extraction-streak"; sourceKey: string; engineKind: EngineKind; leadingUnusable: number; trailingUnusable: number; maxConsecutiveUnusable: number; settledCount: number; orderComplete: boolean }
export type Fact = TurnWindowFact | ObligationFact | IsolationFact | IoMinuteFact | ExtractionStreakFact;

export interface OperationalWindow {
  schemaVersion: 1;
  installationId: string;
  producer: Producer;
  epoch: number;
  seq: number;
  startAt: number;
  endAt: number;
  activeMs: number;
  complete: boolean;
  /** Rows dropped to fit the record caps; a window with omitted > 0 is never complete. */
  omitted: number;
  coverageByDetector: Partial<Record<DetectorName, CoverageValue>>;
  counters: CounterRow[];
  facts: Fact[];
  lifecycle: Lifecycle;
}

export interface LastVerified { verifiedAt: number; snapshotToken: string; bytes: number; verification: "artifact-reread" }
export interface BackupStatus {
  schemaVersion: 1;
  installationId: string;
  revision: number;
  at: number;
  enabled: boolean;
  configuredAt: number | null;
  policyRevision: number;
  /** Earliest scheduled obligation without a matching verification; fixed until it completes or its policy ends. */
  dueAt: number | null;
  nextDueAt: number | null;
  phase: BackupPhase;
  failureCode?: BackupFailureCode;
  failureAt?: number;
  lastAttemptAt?: number;
  captureDeadlineAt?: number;
  pendingOwnerSince?: number;
  /** null when the current folder/key binding could not be checked: unknown, never a match. */
  currentBindingMatches: boolean | null;
  lastVerified: LastVerified | null;
  coverage: CoverageValue;
}

export interface DbStatsManifest { schemaVersion: 1; installationId: string; generation: number; file: string; sha256: string; bytes: number; statsSchemaVersion: 1; at: number; coverage: CoverageValue }
export interface DbStatsRow { role: DbStatsRole; sampled_at: number; page_size: number | null; page_count: number | null; freelist_pages: number | null; db_bytes: number | null; wal_bytes: number | null; pending_revocations: number | null; oldest_pending_at: number | null }

export type EvidenceRef =
  | { sourceRole: "server" | "desktop"; epoch: number; seq: number; bucket: number; observedAt: number }
  | { sourceRole: "backup" | "db-stats"; generation: number; observedAt: number };

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export function parseOperationalWindow(obj: unknown): ParseResult<OperationalWindow>;
export function parseWindowLine(line: unknown): ParseResult<OperationalWindow>;
/** The encoded NDJSON line, newline included, at most HEALTH_LIMITS.recordBytes bytes. */
export function encodeWindowLine(window: unknown): ParseResult<string>;
export function parseIoSample(obj: unknown): ParseResult<IoSample>;
export function chargedRatePerMin(sample: Pick<IoSample, "intervalMs" | "osBytes" | "applicationBytes" | "plannedBytesAllowed">): number | null;
export function isValidIoSample(sample: unknown): boolean;
export function parseBackupStatus(obj: unknown): ParseResult<BackupStatus>;
export function parseDbStatsManifest(obj: unknown): ParseResult<DbStatsManifest>;
export function parseDbStatsRow(obj: unknown): ParseResult<DbStatsRow>;
export function parseEvidenceRef(obj: unknown): ParseResult<EvidenceRef>;
