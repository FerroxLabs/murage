// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The frozen producer contract between Murage and Sentinel (1.0.9, GAP-SENTINEL-109 sections 4.1 and 9).
// Murage publishes bounded metadata under DATA_DIR/health; the out-of-process scanner reads it. Both sides
// import this one file, so the shapes, enums and caps cannot drift apart.
//
// Rules the validators enforce at the process boundary:
//  - every object carries schemaVersion 1 and no key the schema does not name;
//  - integers are nonnegative, finite and bounded; timestamps are UTC milliseconds;
//  - every enumeration is closed and has an `other` member; free text is never a valid value;
//  - opaque tokens (installation, source, scope, turn, launch, snapshot) are lowercase hex only.
// A validator never throws: it answers {ok:true,value} with a fresh copy, or {ok:false,reason}. A reason is
// `<code>:<schema path>`, built only from this file's own field names, never from input text.

export const HEALTH_SCHEMA_VERSION = 1;

const KiB = 1024;
const MiB = 1024 * KiB;
const MINUTE = 60_000;
const ENCODER = new TextEncoder();
const utf8Bytes = text => ENCODER.encode(text).length;

/** Every cap from section 9 plus the record limits from section 4.1. Per installation. */
export const HEALTH_LIMITS = Object.freeze({
  // Producer records (4.1)
  recordBytes: 4 * KiB,
  countersPerRecord: 32,
  factsPerRecord: 16,
  producerBytesPerMinute: 8 * KiB,
  producerBytesPerDay: 16 * MiB,
  windowMs: MINUTE,
  quietCombineWindows: 5,
  maxWindowSpanMs: 5 * MINUTE + 30_000,
  ioSampleMinMs: 45_000,
  ioSampleMaxMs: 90_000,
  // Cadence and discovery
  scanCadenceMs: 120_000,
  scanJitterMaxMs: 15_000,
  inputFilesPerScan: 16,
  statOpsPerScan: 32,
  // Reads
  readBytesPerScan: 2 * MiB,
  readChunkBytes: 256 * KiB,
  recordsPerScan: 4_096,
  statsSnapshotBytes: 32 * KiB,
  baselineTailBytes: 64 * KiB,
  baselineWindowMs: 60 * MINUTE,
  // Queries over the sealed stats database (never a live product database)
  statsQueriesPerScan: 8,
  statsRowsPerScan: 256,
  dbStatsRoles: 8,
  // Runtime
  scanCpuMs: 250,
  scanRssBytes: 128 * MiB,
  scanWallMs: 5_000,
  // Output writes
  outputIdleBytesPerDay: 4 * MiB,
  outputHardBytesPerDay: 32 * MiB,
  outputReserveBytes: 64 * KiB,
  commitsPerScan: 1,
  commitBytes: 128 * KiB,
  changedIssuesPerScan: 32,
  heartbeatMinIntervalMs: 15 * MINUTE,
  // State
  stateBytes: 16 * MiB,
  issueRows: 256,
  correlationEntries: 1_024,
  resolvedRetentionMs: 30 * 24 * 60 * MINUTE,
  evidencePerIssue: 3,
  relatedPerIssue: 4,
  // Publication and owner reads
  viewRows: 25,
  viewBytes: 16 * KiB,
  apiLimitDefault: 25,
  apiLimitMax: 50,
  apiResponseBytes: 64 * KiB,
  // Input retention
  producerSegmentBytes: 1 * MiB,
  producerSegments: 2,
  // Scanner's own log
  scannerLogBytes: 512 * KiB,
  repeatedFaultLogIntervalMs: 60 * MINUTE,
});

/** Numeric ceilings for single values. Anything above is rejected as unbounded. */
export const HEALTH_BOUNDS = Object.freeze({
  count: 2 ** 32 - 1,
  bytes: 2 ** 50,
  durationMs: 31 * 24 * 60 * MINUTE,
  timestampMs: 4_102_444_800_000, // 2100-01-01T00:00:00Z
  epoch: 2 ** 40,
  seq: 2 ** 40,
  revision: 2 ** 40,
  generation: 2 ** 40,
  pollScale: 1_000,
});

/** Opaque, installation-local tokens: lowercase hex, 16 to 64 characters. Never a name, path or message id. */
export const HEALTH_TOKEN_PATTERN = /^[0-9a-f]{16,64}$/;

const closed = (...values) => Object.freeze([...values, "other"]);

export const PRODUCERS = closed("server", "desktop");
export const LIFECYCLES = closed("running", "suspending", "resumed", "stopping", "stopped", "crashed");
/** Detector names for Sean's classes S01..S10, in order. */
export const DETECTOR_IDS = closed("backup", "io-pressure", "extraction", "engine-holds", "deletion", "send-fence", "dispatch-exhausted", "resets", "isolation-noise", "coverage");
/** The class label each detector reports as (S01..S10). `other` has none. */
export const DETECTOR_CLASS = Object.freeze({
  backup: "S01", "io-pressure": "S02", extraction: "S03", "engine-holds": "S04", deletion: "S05",
  "send-fence": "S06", "dispatch-exhausted": "S07", resets: "S08", "isolation-noise": "S09", coverage: "S10",
});
/** Engine categories. A new engine reports `other` until named, so a default-engine change never disables health. */
export const ENGINE_KINDS = closed("claude", "codex", "pi", "acp", "antigravity", "gateway", "opencode-go", "openai-chat", "none");
export const COVERAGE_VALUES = closed("complete", "partial", "unavailable", "not-applicable");
export const EXTRACTION_UNUSABLE_CODES = closed("not-json", "schema", "length", "tool-call", "empty", "response-limit", "transport");
/** Admitted attempts settle as complete, unusable, cancelled or interrupted; deferrals happen before any call. */
export const EXTRACTION_OUTCOMES = closed("admitted", "complete", "unusable", "cancelled", "interrupted", "deferred-busy", "deferred-unconfigured", "deferred-budget");
export const BACKUP_PHASES = closed("off", "idle", "due", "capturing", "verifying", "waiting-owner", "failed");
export const BACKUP_RESULTS = closed("verified", "failed", "waiting", "off");
export const BACKUP_FAILURE_CODES = closed("capture-failed", "verification-failed", "destination-unavailable", "key-unavailable", "source-changed", "unclassified-component", "deadline-passed", "disk-full", "permission-denied", "binding-changed");
export const IO_SOURCE_CLASSES = closed("messages-db", "memory", "memory-index-db", "skill-index-db", "connected-app-ledger-db", "engine-history", "backup-work");
export const HOLDER_STATES = closed("held", "clear", "unknown");
export const OBLIGATION_CODES = closed("deletion", "engine-history", "memory-revocation");
export const TURN_FINALS = closed("completed", "exhausted", "cancelled");
/** Owner-requested new sessions and engine changes are listed so a producer can name them; S08 never counts them. */
export const RESET_REASONS = closed("context-overflow", "session-expired", "resume-failed", "engine-error", "history-rebuild", "send-fence", "owner-new-session", "engine-change");
export const RESET_REASONS_NOT_AUTOMATIC = Object.freeze(["owner-new-session", "engine-change"]);
export const FRONT_MATTER_FALLBACK_CODES = closed("no-front-matter", "parse-error", "missing-name", "too-large", "unreadable");
export const REVOCATION_OPERATIONS = closed("affect", "tombstone", "state-update", "index-update", "lineage-walk", "purge");
export const REVOCATION_COUNTER_CODES = closed("affect-attempts", "prior-deleted", "state-changed", "bytes-attributed");
export const SEND_FENCE_CODES = closed("refusal", "rebuild", "recovered", "exhausted", "cancelled", "lookup-error");
export const DELETION_CODES = closed("pending", "held", "retry", "completed");
export const PRODUCER_LIFECYCLE_CODES = closed("boot", "shutdown", "suspend", "resume", "registration", "schedule-ok", "schedule-failed", "gap");
export const FACT_KINDS = Object.freeze(["turn-window", "obligation", "isolation", "io-minute", "extraction-streak"]);
/** The fixed eight database roles a stats snapshot may describe. */
export const DB_STATS_ROLES = closed("messages", "memory", "memory-index", "skill-index", "connected-app-ledger", "engine-history", "backup-work");
export const EVIDENCE_SOURCE_ROLES = closed("server", "desktop", "backup", "db-stats");

const union = (...lists) => Object.freeze([...new Set(lists.flat())]);
/** Which counter codes each detector accepts. A code outside its detector's list is rejected. */
export const COUNTER_CODES_BY_DETECTOR = Object.freeze({
  backup: union(BACKUP_RESULTS, BACKUP_FAILURE_CODES),
  "io-pressure": union(REVOCATION_COUNTER_CODES, REVOCATION_OPERATIONS),
  extraction: union(EXTRACTION_OUTCOMES, EXTRACTION_UNUSABLE_CODES),
  "engine-holds": union(HOLDER_STATES, ["pending", "completed", "failed-attempt"]),
  deletion: DELETION_CODES,
  "send-fence": SEND_FENCE_CODES,
  "dispatch-exhausted": TURN_FINALS,
  resets: RESET_REASONS,
  "isolation-noise": union(FRONT_MATTER_FALLBACK_CODES, ["scan-completed"]),
  coverage: PRODUCER_LIFECYCLE_CODES,
  other: Object.freeze(["other"]),
});
/** Which detectors lose evidence when a fact of this kind is dropped. */
export const FACT_DETECTORS = Object.freeze({
  "turn-window": Object.freeze(["send-fence", "dispatch-exhausted", "resets"]),
  obligation: Object.freeze(["engine-holds", "deletion"]),
  isolation: Object.freeze(["isolation-noise"]),
  "io-minute": Object.freeze(["io-pressure"]),
  "extraction-streak": Object.freeze(["extraction"]),
});

/** Sealed stats database tables. Column order is the CREATE order; unknown values are NULL, never zero. */
export const DB_STATS_TABLES = Object.freeze({
  snapshot: Object.freeze(["version", "installation_id", "generation", "at", "coverage"]),
  db_stats: Object.freeze(["role", "sampled_at", "page_size", "page_count", "freelist_pages", "db_bytes", "wal_bytes", "pending_revocations", "oldest_pending_at"]),
});
export const DB_STATS_SCHEMA_VERSION = 1;
/** The sealed SQLite generation's file name inside DATA_DIR/health. */
export const dbStatsFileName = generation => `db-stats-${generation}.sqlite`;

/** Fixed names inside DATA_DIR/health (section 3.3). */
export const HEALTH_DIR = "health";
export const HEALTH_FILES = Object.freeze({
  serverCurrent: "server.current.ndjson",
  serverPrevious: "server.previous.ndjson",
  desktopCurrent: "desktop.current.ndjson",
  desktopPrevious: "desktop.previous.ndjson",
  dbStatsManifest: "db-stats-current.json",
  backupStatus: "backup-status.json",
});

/** Producer-side normalisation: an engine name this contract does not know reports as `other`. */
export const toEngineKind = value => (typeof value === "string" && ENGINE_KINDS.includes(value) ? value : "other");

// ---------------------------------------------------------------------------
// Validation core. Internal throws stop at the exported boundary.
// ---------------------------------------------------------------------------

class Reject { constructor(reason) { this.reason = reason; } }
const reject = (code, path) => { throw new Reject(`${code}:${path}`); };
const boundary = run => {
  try { return { ok: true, value: run() }; }
  catch (error) { return { ok: false, reason: error instanceof Reject ? error.reason : "internal:boundary" }; }
};

function record(value, path, required, optional = []) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject("not-object", path);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) reject("not-object", path);
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) reject("unknown-key", path);
  for (const key of required) if (!Object.hasOwn(value, key)) reject("missing-key", `${path}.${key}`);
  return value;
}
function integer(value, path, max, min = 0) {
  if (typeof value !== "number" || !Number.isInteger(value)) reject("bad-integer", path);
  if (value < min || value > max) reject("out-of-range", path);
  return value;
}
const count = (value, path) => integer(value, path, HEALTH_BOUNDS.count);
const bytes = (value, path) => integer(value, path, HEALTH_BOUNDS.bytes);
const duration = (value, path) => integer(value, path, HEALTH_BOUNDS.durationMs);
const timestamp = (value, path) => integer(value, path, HEALTH_BOUNDS.timestampMs, 1);
function fraction(value, path, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) reject("bad-number", path);
  if (value < 0 || value > max) reject("out-of-range", path);
  return value;
}
function flag(value, path) { if (typeof value !== "boolean") reject("bad-type", path); return value; }
function oneOf(value, list, path) { if (typeof value !== "string" || !list.includes(value)) reject("bad-enum", path); return value; }
function token(value, path) { if (typeof value !== "string" || !HEALTH_TOKEN_PATTERN.test(value)) reject("bad-token", path); return value; }
function schemaVersion(value, path) { if (value !== HEALTH_SCHEMA_VERSION) reject("schema-version", path); }
function list(value, path, max) {
  if (!Array.isArray(value)) reject("bad-type", path);
  if (value.length > max) reject("too-many-rows", path);
  return value;
}
const optional = (source, key, read, path) => (Object.hasOwn(source, key) ? read(source[key], `${path}.${key}`) : undefined);
const assign = (target, key, value) => { if (value !== undefined) target[key] = value; };

function counterRow(row, path) {
  record(row, path, ["detector", "engineKind", "code", "value"], ["sourceKey", "denominator", "maxDurationMs"]);
  const detector = oneOf(row.detector, DETECTOR_IDS, `${path}.detector`);
  const out = {
    detector,
    engineKind: oneOf(row.engineKind, ENGINE_KINDS, `${path}.engineKind`),
    code: oneOf(row.code, COUNTER_CODES_BY_DETECTOR[detector], `${path}.code`),
    value: count(row.value, `${path}.value`),
  };
  assign(out, "sourceKey", optional(row, "sourceKey", token, path));
  assign(out, "denominator", optional(row, "denominator", count, path));
  assign(out, "maxDurationMs", optional(row, "maxDurationMs", duration, path));
  if (out.denominator !== undefined && out.value > out.denominator) reject("inconsistent", `${path}.value`);
  return out;
}

const FACT_READERS = {
  "turn-window"(fact, path) {
    record(fact, path, ["kind", "scopeToken", "turnToken", "engineKind", "at", "refusalDelta", "rebuildMsDelta", "resetDelta", "final"]);
    return {
      kind: "turn-window", scopeToken: token(fact.scopeToken, `${path}.scopeToken`), turnToken: token(fact.turnToken, `${path}.turnToken`),
      engineKind: oneOf(fact.engineKind, ENGINE_KINDS, `${path}.engineKind`), at: timestamp(fact.at, `${path}.at`),
      refusalDelta: count(fact.refusalDelta, `${path}.refusalDelta`), rebuildMsDelta: duration(fact.rebuildMsDelta, `${path}.rebuildMsDelta`),
      resetDelta: count(fact.resetDelta, `${path}.resetDelta`), final: fact.final === null ? null : oneOf(fact.final, TURN_FINALS, `${path}.final`),
    };
  },
  obligation(fact, path) {
    record(fact, path, ["kind", "engineKind", "code", "pendingCount", "oldestPendingAt", "holderState", "failedAttemptsAfterClear", "completedDelta", "observedAt"], ["holderClearAt"]);
    const out = {
      kind: "obligation", engineKind: oneOf(fact.engineKind, ENGINE_KINDS, `${path}.engineKind`), code: oneOf(fact.code, OBLIGATION_CODES, `${path}.code`),
      pendingCount: count(fact.pendingCount, `${path}.pendingCount`),
      oldestPendingAt: fact.oldestPendingAt === null ? null : timestamp(fact.oldestPendingAt, `${path}.oldestPendingAt`),
      holderState: oneOf(fact.holderState, HOLDER_STATES, `${path}.holderState`),
      failedAttemptsAfterClear: count(fact.failedAttemptsAfterClear, `${path}.failedAttemptsAfterClear`),
      completedDelta: count(fact.completedDelta, `${path}.completedDelta`), observedAt: timestamp(fact.observedAt, `${path}.observedAt`),
    };
    assign(out, "holderClearAt", optional(fact, "holderClearAt", timestamp, path));
    if (out.pendingCount > 0 && out.oldestPendingAt === null) reject("inconsistent", `${path}.oldestPendingAt`);
    return out;
  },
  isolation(fact, path) {
    record(fact, path, ["kind", "engineKind", "launchToken", "completedScan", "fallbackDelta"]);
    return {
      kind: "isolation", engineKind: oneOf(fact.engineKind, ENGINE_KINDS, `${path}.engineKind`), launchToken: token(fact.launchToken, `${path}.launchToken`),
      completedScan: flag(fact.completedScan, `${path}.completedScan`), fallbackDelta: count(fact.fallbackDelta, `${path}.fallbackDelta`),
    };
  },
  "io-minute"(fact, path) { return { kind: "io-minute", ...ioSample(fact, path, true) }; },
  "extraction-streak"(fact, path) {
    record(fact, path, ["kind", "sourceKey", "engineKind", "leadingUnusable", "trailingUnusable", "maxConsecutiveUnusable", "settledCount", "orderComplete"]);
    const out = {
      kind: "extraction-streak", sourceKey: token(fact.sourceKey, `${path}.sourceKey`), engineKind: oneOf(fact.engineKind, ENGINE_KINDS, `${path}.engineKind`),
      leadingUnusable: count(fact.leadingUnusable, `${path}.leadingUnusable`), trailingUnusable: count(fact.trailingUnusable, `${path}.trailingUnusable`),
      maxConsecutiveUnusable: count(fact.maxConsecutiveUnusable, `${path}.maxConsecutiveUnusable`), settledCount: count(fact.settledCount, `${path}.settledCount`),
      orderComplete: flag(fact.orderComplete, `${path}.orderComplete`),
    };
    const { leadingUnusable, trailingUnusable, maxConsecutiveUnusable, settledCount } = out;
    if (maxConsecutiveUnusable > settledCount || leadingUnusable > maxConsecutiveUnusable || trailingUnusable > maxConsecutiveUnusable) reject("inconsistent", `${path}.maxConsecutiveUnusable`);
    return out;
  },
};
function factRow(fact, path) {
  if (typeof fact !== "object" || fact === null || Array.isArray(fact)) reject("not-object", path);
  const kind = oneOf(fact.kind, FACT_KINDS, `${path}.kind`);
  return FACT_READERS[kind](fact, path);
}

const IO_FIELDS = ["idle", "intervalMs", "osBytes", "applicationBytes", "plannedBytesAllowed", "chargedBytes", "budgetBytes", "cpuFraction", "pollScale", "sourceClass", "discontinuity"];
function ioSample(sample, path, asFact) {
  record(sample, path, asFact ? ["kind", ...IO_FIELDS] : IO_FIELDS);
  return {
    idle: flag(sample.idle, `${path}.idle`), intervalMs: duration(sample.intervalMs, `${path}.intervalMs`),
    osBytes: sample.osBytes === null ? null : bytes(sample.osBytes, `${path}.osBytes`), applicationBytes: bytes(sample.applicationBytes, `${path}.applicationBytes`),
    plannedBytesAllowed: bytes(sample.plannedBytesAllowed, `${path}.plannedBytesAllowed`), chargedBytes: bytes(sample.chargedBytes, `${path}.chargedBytes`),
    budgetBytes: bytes(sample.budgetBytes, `${path}.budgetBytes`), cpuFraction: fraction(sample.cpuFraction, `${path}.cpuFraction`, 1),
    pollScale: fraction(sample.pollScale, `${path}.pollScale`, HEALTH_BOUNDS.pollScale), sourceClass: oneOf(sample.sourceClass, IO_SOURCE_CLASSES, `${path}.sourceClass`),
    discontinuity: flag(sample.discontinuity, `${path}.discontinuity`),
  };
}

function coverageMap(value, path) {
  record(value, path, [], DETECTOR_IDS);
  const out = {};
  for (const detector of DETECTOR_IDS) if (Object.hasOwn(value, detector)) out[detector] = oneOf(value[detector], COVERAGE_VALUES, `${path}.${detector}`);
  return out;
}

const WINDOW_KEYS = ["schemaVersion", "installationId", "producer", "epoch", "seq", "startAt", "endAt", "activeMs", "complete", "omitted", "coverageByDetector", "counters", "facts", "lifecycle"];
function readWindow(obj) {
  const p = "window";
  record(obj, p, WINDOW_KEYS);
  schemaVersion(obj.schemaVersion, `${p}.schemaVersion`);
  const out = {
    schemaVersion: HEALTH_SCHEMA_VERSION,
    installationId: token(obj.installationId, `${p}.installationId`),
    producer: oneOf(obj.producer, PRODUCERS, `${p}.producer`),
    epoch: integer(obj.epoch, `${p}.epoch`, HEALTH_BOUNDS.epoch),
    seq: integer(obj.seq, `${p}.seq`, HEALTH_BOUNDS.seq),
    startAt: timestamp(obj.startAt, `${p}.startAt`),
    endAt: timestamp(obj.endAt, `${p}.endAt`),
    activeMs: duration(obj.activeMs, `${p}.activeMs`),
    complete: flag(obj.complete, `${p}.complete`),
    omitted: count(obj.omitted, `${p}.omitted`),
    coverageByDetector: coverageMap(obj.coverageByDetector, `${p}.coverageByDetector`),
    counters: list(obj.counters, `${p}.counters`, HEALTH_LIMITS.countersPerRecord).map((row, index) => counterRow(row, `${p}.counters[${index}]`)),
    facts: list(obj.facts, `${p}.facts`, HEALTH_LIMITS.factsPerRecord).map((row, index) => factRow(row, `${p}.facts[${index}]`)),
    lifecycle: oneOf(obj.lifecycle, LIFECYCLES, `${p}.lifecycle`),
  };
  const span = out.endAt - out.startAt;
  if (span <= 0) reject("inconsistent", `${p}.endAt`);
  if (span > HEALTH_LIMITS.maxWindowSpanMs) reject("out-of-range", `${p}.endAt`);
  if (out.activeMs > span) reject("inconsistent", `${p}.activeMs`);
  if (out.omitted > 0 && out.complete) reject("inconsistent", `${p}.complete`);
  return out;
}

/** Validates one operational window (a parsed NDJSON record). Never throws. */
export const parseOperationalWindow = obj => boundary(() => readWindow(obj));

/** Validates one NDJSON line: byte ceiling first, then JSON, then the window schema. Never throws. */
export function parseWindowLine(line) {
  return boundary(() => {
    if (typeof line !== "string") reject("bad-type", "line");
    const text = line.endsWith("\n") ? line.slice(0, -1) : line;
    if (utf8Bytes(text) + 1 > HEALTH_LIMITS.recordBytes) reject("too-large", "line");
    let parsed;
    try { parsed = JSON.parse(text); } catch { reject("not-json", "line"); }
    return readWindow(parsed);
  });
}

/** Encodes a window as one NDJSON line (with its newline) of at most 4 KiB. Rows beyond the per-record caps, then
 * trailing facts and counters, are dropped until the line fits; each dropped row increments `omitted`, the window is
 * marked incomplete, and every detector that lost a row is marked `partial` (unless already worse). Never throws. */
export function encodeWindowLine(window) {
  return boundary(() => {
    const value = readWindow(capRows(window));
    const lose = detectors => { for (const detector of detectors) if (value.coverageByDetector[detector] !== "unavailable") value.coverageByDetector[detector] = "partial"; };
    const dropFact = () => { const fact = value.facts.pop(); value.omitted++; value.complete = false; lose(FACT_DETECTORS[fact.kind]); };
    const dropCounter = () => { const row = value.counters.pop(); value.omitted++; value.complete = false; lose([row.detector]); };
    for (const { kind, detector } of overflowRows(window)) { value.omitted++; value.complete = false; lose(kind ? FACT_DETECTORS[kind] ?? [] : [detector]); }
    let text = JSON.stringify(value);
    while (utf8Bytes(text) + 1 > HEALTH_LIMITS.recordBytes) {
      if (value.facts.length) dropFact();
      else if (value.counters.length) dropCounter();
      else reject("too-large", "window");
      text = JSON.stringify(value);
    }
    return `${text}\n`;
  });
}
/** Rows beyond the per-record caps, described only by their detector or fact kind (validated enums or nothing). */
function overflowRows(window) {
  const rows = [];
  const counters = Array.isArray(window?.counters) ? window.counters : [];
  const facts = Array.isArray(window?.facts) ? window.facts : [];
  for (const row of counters.slice(HEALTH_LIMITS.countersPerRecord)) rows.push({ detector: DETECTOR_IDS.includes(row?.detector) ? row.detector : "other" });
  for (const fact of facts.slice(HEALTH_LIMITS.factsPerRecord)) rows.push({ kind: FACT_KINDS.includes(fact?.kind) ? fact.kind : null, detector: "other" });
  return rows;
}
/** A shallow copy of the window with its row lists cut to the per-record caps (the cut rows are counted by overflowRows). */
function capRows(window) {
  if (typeof window !== "object" || window === null || Array.isArray(window)) return window;
  const copy = { ...window };
  if (Array.isArray(copy.counters)) copy.counters = copy.counters.slice(0, HEALTH_LIMITS.countersPerRecord);
  if (Array.isArray(copy.facts)) copy.facts = copy.facts.slice(0, HEALTH_LIMITS.factsPerRecord);
  return copy;
}

// ---------------------------------------------------------------------------
// IO minute samples (section 4.1)
// ---------------------------------------------------------------------------

/** Validates a standalone IO minute sample. Never throws. */
export const parseIoSample = obj => boundary(() => ioSample(obj, "io", false));

/** Charged write rate in bytes per minute: max(0, max(os, app) - planned) * 60000 / intervalMs. A missing OS figure
 * uses the application figure. Answers null for a sample with no usable interval. */
export function chargedRatePerMin(sample) {
  const interval = sample?.intervalMs;
  if (typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0) return null;
  const os = typeof sample.osBytes === "number" ? sample.osBytes : 0;
  const app = typeof sample.applicationBytes === "number" ? sample.applicationBytes : 0;
  const planned = typeof sample.plannedBytesAllowed === "number" ? sample.plannedBytesAllowed : 0;
  return Math.max(0, Math.max(os, app) - planned) * MINUTE / interval;
}

/** A sample counts toward a rate only when it spans 45 to 90 s inclusive with no suspend, resume or clock discontinuity. */
export function isValidIoSample(sample) {
  if (!parseIoSample(stripKind(sample)).ok) return false;
  return sample.discontinuity === false && sample.intervalMs >= HEALTH_LIMITS.ioSampleMinMs && sample.intervalMs <= HEALTH_LIMITS.ioSampleMaxMs;
}
const stripKind = sample => {
  if (typeof sample !== "object" || sample === null || sample.kind !== "io-minute") return sample;
  const { kind: _kind, ...rest } = sample;
  return rest;
};

// ---------------------------------------------------------------------------
// Backup status manifest and database statistics manifest
// ---------------------------------------------------------------------------

const BACKUP_KEYS = ["schemaVersion", "installationId", "revision", "at", "enabled", "configuredAt", "policyRevision", "dueAt", "nextDueAt", "phase", "currentBindingMatches", "lastVerified", "coverage"];
const BACKUP_OPTIONAL = ["failureCode", "failureAt", "lastAttemptAt", "captureDeadlineAt", "pendingOwnerSince"];
const nullableTimestamp = (value, path) => (value === null ? null : timestamp(value, path));

/** Validates DATA_DIR/health/backup-status.json. `dueAt` and `nextDueAt` may be null when no obligation exists;
 * `currentBindingMatches` is null when the current folder/key binding could not be checked (unknown, never a match). Never throws. */
export const parseBackupStatus = obj => boundary(() => {
  const p = "backup";
  record(obj, p, BACKUP_KEYS, BACKUP_OPTIONAL);
  schemaVersion(obj.schemaVersion, `${p}.schemaVersion`);
  const out = {
    schemaVersion: HEALTH_SCHEMA_VERSION,
    installationId: token(obj.installationId, `${p}.installationId`),
    revision: integer(obj.revision, `${p}.revision`, HEALTH_BOUNDS.revision),
    at: timestamp(obj.at, `${p}.at`),
    enabled: flag(obj.enabled, `${p}.enabled`),
    configuredAt: nullableTimestamp(obj.configuredAt, `${p}.configuredAt`),
    policyRevision: integer(obj.policyRevision, `${p}.policyRevision`, HEALTH_BOUNDS.revision),
    dueAt: nullableTimestamp(obj.dueAt, `${p}.dueAt`),
    nextDueAt: nullableTimestamp(obj.nextDueAt, `${p}.nextDueAt`),
    phase: oneOf(obj.phase, BACKUP_PHASES, `${p}.phase`),
    currentBindingMatches: obj.currentBindingMatches === null ? null : flag(obj.currentBindingMatches, `${p}.currentBindingMatches`),
    lastVerified: obj.lastVerified === null ? null : lastVerified(obj.lastVerified, `${p}.lastVerified`),
    coverage: oneOf(obj.coverage, COVERAGE_VALUES, `${p}.coverage`),
  };
  assign(out, "failureCode", optional(obj, "failureCode", (v, path) => oneOf(v, BACKUP_FAILURE_CODES, path), p));
  for (const key of ["failureAt", "lastAttemptAt", "captureDeadlineAt", "pendingOwnerSince"]) assign(out, key, optional(obj, key, timestamp, p));
  if ((out.failureCode === undefined) !== (out.failureAt === undefined)) reject("inconsistent", `${p}.failureCode`);
  if (out.enabled && out.configuredAt === null) reject("inconsistent", `${p}.configuredAt`);
  return out;
});
function lastVerified(value, path) {
  record(value, path, ["verifiedAt", "snapshotToken", "bytes", "verification"]);
  return {
    verifiedAt: timestamp(value.verifiedAt, `${path}.verifiedAt`), snapshotToken: token(value.snapshotToken, `${path}.snapshotToken`),
    bytes: bytes(value.bytes, `${path}.bytes`), verification: oneOf(value.verification, ["artifact-reread"], `${path}.verification`),
  };
}

const DB_MANIFEST_KEYS = ["schemaVersion", "installationId", "generation", "file", "sha256", "bytes", "statsSchemaVersion", "at", "coverage"];
/** Validates DATA_DIR/health/db-stats-current.json, which names the current sealed generation. Never throws. */
export const parseDbStatsManifest = obj => boundary(() => {
  const p = "dbStats";
  record(obj, p, DB_MANIFEST_KEYS);
  schemaVersion(obj.schemaVersion, `${p}.schemaVersion`);
  const generation = integer(obj.generation, `${p}.generation`, HEALTH_BOUNDS.generation);
  if (obj.file !== dbStatsFileName(generation)) reject("inconsistent", `${p}.file`);
  if (typeof obj.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(obj.sha256)) reject("bad-token", `${p}.sha256`);
  if (obj.statsSchemaVersion !== DB_STATS_SCHEMA_VERSION) reject("schema-version", `${p}.statsSchemaVersion`);
  return {
    schemaVersion: HEALTH_SCHEMA_VERSION,
    installationId: token(obj.installationId, `${p}.installationId`),
    generation,
    file: dbStatsFileName(generation),
    sha256: obj.sha256,
    bytes: integer(obj.bytes, `${p}.bytes`, HEALTH_LIMITS.statsSnapshotBytes, 1),
    statsSchemaVersion: DB_STATS_SCHEMA_VERSION,
    at: timestamp(obj.at, `${p}.at`),
    coverage: oneOf(obj.coverage, COVERAGE_VALUES, `${p}.coverage`),
  };
});

/** Validates one db_stats row read from the sealed snapshot (SQLite NULL stays null, never zero). Never throws. */
export const parseDbStatsRow = obj => boundary(() => {
  const p = "dbStatsRow";
  record(obj, p, DB_STATS_TABLES.db_stats);
  const nullable = (read, key) => (obj[key] === null ? null : read(obj[key], `${p}.${key}`));
  return {
    role: oneOf(obj.role, DB_STATS_ROLES, `${p}.role`),
    sampled_at: timestamp(obj.sampled_at, `${p}.sampled_at`),
    page_size: nullable(bytes, "page_size"), page_count: nullable(count, "page_count"), freelist_pages: nullable(count, "freelist_pages"),
    db_bytes: nullable(bytes, "db_bytes"), wal_bytes: nullable(bytes, "wal_bytes"),
    pending_revocations: nullable(count, "pending_revocations"), oldest_pending_at: nullable(timestamp, "oldest_pending_at"),
  };
});

// ---------------------------------------------------------------------------
// Evidence references (at most three per issue)
// ---------------------------------------------------------------------------

/** Validates one evidence reference: a log bucket ({sourceRole: server|desktop, epoch, seq, bucket, observedAt}) or a
 * manifest generation ({sourceRole: backup|db-stats, generation, observedAt}). Never a URL or path. Never throws. */
export const parseEvidenceRef = obj => boundary(() => {
  const p = "evidence";
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) reject("not-object", p);
  const sourceRole = oneOf(obj.sourceRole, ["server", "desktop", "backup", "db-stats"], `${p}.sourceRole`);
  if (sourceRole === "server" || sourceRole === "desktop") {
    record(obj, p, ["sourceRole", "epoch", "seq", "bucket", "observedAt"]);
    return {
      sourceRole, epoch: integer(obj.epoch, `${p}.epoch`, HEALTH_BOUNDS.epoch), seq: integer(obj.seq, `${p}.seq`, HEALTH_BOUNDS.seq),
      bucket: integer(obj.bucket, `${p}.bucket`, HEALTH_LIMITS.countersPerRecord + HEALTH_LIMITS.factsPerRecord), observedAt: timestamp(obj.observedAt, `${p}.observedAt`),
    };
  }
  record(obj, p, ["sourceRole", "generation", "observedAt"]);
  return { sourceRole, generation: integer(obj.generation, `${p}.generation`, HEALTH_BOUNDS.generation), observedAt: timestamp(obj.observedAt, `${p}.observedAt`) };
});
