// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The frozen Sentinel producer contract (GAP-SENTINEL-109 sections 4.1 and 9): every rejection and every bound.
import { describe, expect, it } from "vitest";
import {
  BACKUP_FAILURE_CODES, BACKUP_PHASES, BACKUP_RESULTS, COUNTER_CODES_BY_DETECTOR, COVERAGE_VALUES, DB_STATS_ROLES, DB_STATS_TABLES, DETECTOR_CLASS, DETECTOR_IDS,
  ENGINE_KINDS, EXTRACTION_OUTCOMES, EXTRACTION_UNUSABLE_CODES, FACT_DETECTORS, FACT_KINDS, FRONT_MATTER_FALLBACK_CODES, HEALTH_BOUNDS, HEALTH_FILES, HEALTH_LIMITS,
  HEALTH_SCHEMA_VERSION, HOLDER_STATES, IO_SOURCE_CLASSES, LIFECYCLES, OBLIGATION_CODES, PRODUCERS, RESET_REASONS, RESET_REASONS_NOT_AUTOMATIC, REVOCATION_OPERATIONS,
  TURN_FINALS, chargedRatePerMin, dbStatsFileName, encodeWindowLine, isValidIoSample, parseBackupStatus, parseDbStatsManifest, parseDbStatsRow, parseEvidenceRef,
  parseIoSample, parseOperationalWindow, parseWindowLine, toEngineKind,
} from "./health-protocol.mjs";

const ID = "0123456789abcdef0123456789abcdef";
const TOK = "fedcba9876543210";
const T0 = 1_790_000_000_000;

const io = (over: Record<string, unknown> = {}) => ({
  idle: true, intervalMs: 60_000, osBytes: 2_000_000, applicationBytes: 1_500_000, plannedBytesAllowed: 500_000, chargedBytes: 1_500_000,
  budgetBytes: 1_048_576, cpuFraction: 0.02, pollScale: 1, sourceClass: "messages-db", discontinuity: false, ...over,
});
const facts = () => [
  { kind: "turn-window", scopeToken: TOK, turnToken: "aaaaaaaaaaaaaaaa", engineKind: "claude", at: T0 + 30_000, refusalDelta: 2, rebuildMsDelta: 6_000, resetDelta: 1, final: null },
  { kind: "obligation", engineKind: "codex", code: "deletion", pendingCount: 1, oldestPendingAt: T0 - 1, holderState: "clear", holderClearAt: T0, failedAttemptsAfterClear: 2, completedDelta: 0, observedAt: T0 + 1 },
  { kind: "isolation", engineKind: "claude", launchToken: TOK, completedScan: true, fallbackDelta: 3 },
  { kind: "io-minute", ...io() },
  { kind: "extraction-streak", sourceKey: TOK, engineKind: "openai-chat", leadingUnusable: 1, trailingUnusable: 2, maxConsecutiveUnusable: 2, settledCount: 5, orderComplete: true },
];
const win = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, installationId: ID, producer: "server", epoch: 3, seq: 17, startAt: T0, endAt: T0 + 60_000, activeMs: 60_000, complete: true, omitted: 0,
  coverageByDetector: { extraction: "complete", backup: "not-applicable" },
  counters: [
    { detector: "extraction", engineKind: "claude", sourceKey: TOK, code: "unusable", value: 3, denominator: 5 },
    { detector: "extraction", engineKind: "claude", code: "not-json", value: 2 },
    { detector: "send-fence", engineKind: "codex", code: "rebuild", value: 1, maxDurationMs: 6_000 },
  ],
  facts: facts(), lifecycle: "running", ...over,
});
const reasonOf = (result: { ok: boolean; reason?: string }) => (result.ok ? "ok" : result.reason);

describe("enums", () => {
  it("every closed enum has an `other` member and no duplicates", () => {
    for (const list of [PRODUCERS, LIFECYCLES, DETECTOR_IDS, ENGINE_KINDS, COVERAGE_VALUES, EXTRACTION_UNUSABLE_CODES, EXTRACTION_OUTCOMES, BACKUP_PHASES, BACKUP_RESULTS,
      BACKUP_FAILURE_CODES, IO_SOURCE_CLASSES, HOLDER_STATES, OBLIGATION_CODES, TURN_FINALS, RESET_REASONS, FRONT_MATTER_FALLBACK_CODES, REVOCATION_OPERATIONS, DB_STATS_ROLES]) {
      expect(list).toContain("other");
      expect(new Set(list).size).toBe(list.length);
      expect(Object.isFrozen(list)).toBe(true);
    }
  });
  it("matches the design's exact members", () => {
    expect(EXTRACTION_UNUSABLE_CODES).toEqual(["not-json", "schema", "length", "tool-call", "empty", "response-limit", "transport", "other"]);
    expect(LIFECYCLES).toEqual(["running", "suspending", "resumed", "stopping", "stopped", "crashed", "other"]);
    expect(HOLDER_STATES).toEqual(["held", "clear", "unknown", "other"]);
    expect(TURN_FINALS).toEqual(["completed", "exhausted", "cancelled", "other"]);
    expect(COVERAGE_VALUES).toEqual(["complete", "partial", "unavailable", "not-applicable", "other"]);
    expect(BACKUP_RESULTS).toEqual(["verified", "failed", "waiting", "off", "other"]);
    expect(DB_STATS_ROLES).toHaveLength(HEALTH_LIMITS.dbStatsRoles);
    expect(RESET_REASONS_NOT_AUTOMATIC.every(reason => RESET_REASONS.includes(reason))).toBe(true);
  });
  it("names ten detectors S01..S10, each with counter codes", () => {
    expect(Object.values(DETECTOR_CLASS)).toEqual(["S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S09", "S10"]);
    expect(DETECTOR_IDS.filter(id => id !== "other")).toEqual(Object.keys(DETECTOR_CLASS));
    for (const id of DETECTOR_IDS) expect(COUNTER_CODES_BY_DETECTOR[id]?.length, id).toBeGreaterThan(0);
    for (const kind of FACT_KINDS) for (const id of FACT_DETECTORS[kind]) expect(DETECTOR_IDS).toContain(id);
  });
  it("toEngineKind maps an unknown engine to other", () => {
    expect(toEngineKind("claude")).toBe("claude");
    expect(toEngineKind("brand-new-engine")).toBe("other");
    expect(toEngineKind(undefined)).toBe("other");
  });
  it("fixed file names and stats tables", () => {
    expect(HEALTH_FILES.backupStatus).toBe("backup-status.json");
    expect(HEALTH_FILES.dbStatsManifest).toBe("db-stats-current.json");
    expect(dbStatsFileName(7)).toBe("db-stats-7.sqlite");
    expect(DB_STATS_TABLES.snapshot).toEqual(["version", "installation_id", "generation", "at", "coverage"]);
    expect(DB_STATS_TABLES.db_stats).toEqual(["role", "sampled_at", "page_size", "page_count", "freelist_pages", "db_bytes", "wal_bytes", "pending_revocations", "oldest_pending_at"]);
  });
});

describe("caps (section 9 and 4.1)", () => {
  it("are the design's exact numbers", () => {
    expect(HEALTH_SCHEMA_VERSION).toBe(1);
    expect(HEALTH_LIMITS).toMatchObject({
      recordBytes: 4096, countersPerRecord: 32, factsPerRecord: 16, producerBytesPerMinute: 8192, producerBytesPerDay: 16 * 1024 * 1024,
      scanCadenceMs: 120_000, scanJitterMaxMs: 15_000, inputFilesPerScan: 16, statOpsPerScan: 32, readBytesPerScan: 2 * 1024 * 1024, readChunkBytes: 256 * 1024,
      recordsPerScan: 4096, statsSnapshotBytes: 32 * 1024, statsQueriesPerScan: 8, statsRowsPerScan: 256, scanCpuMs: 250, scanRssBytes: 128 * 1024 * 1024, scanWallMs: 5000,
      outputIdleBytesPerDay: 4 * 1024 * 1024, outputHardBytesPerDay: 32 * 1024 * 1024, outputReserveBytes: 64 * 1024, commitsPerScan: 1, commitBytes: 128 * 1024,
      stateBytes: 16 * 1024 * 1024, issueRows: 256, correlationEntries: 1024, resolvedRetentionMs: 30 * 86_400_000, producerSegmentBytes: 1024 * 1024, producerSegments: 2,
      scannerLogBytes: 512 * 1024, repeatedFaultLogIntervalMs: 3_600_000, heartbeatMinIntervalMs: 900_000, viewRows: 25, viewBytes: 16 * 1024, apiLimitMax: 50,
      apiResponseBytes: 64 * 1024, evidencePerIssue: 3, relatedPerIssue: 4, changedIssuesPerScan: 32, baselineTailBytes: 64 * 1024, baselineWindowMs: 3_600_000,
      ioSampleMinMs: 45_000, ioSampleMaxMs: 90_000,
    });
    expect(Object.isFrozen(HEALTH_LIMITS)).toBe(true);
  });
});

describe("parseOperationalWindow", () => {
  it("accepts a full valid window and returns a fresh copy", () => {
    const input = win();
    const result = parseOperationalWindow(input);
    expect(result).toEqual({ ok: true, value: input });
    if (result.ok) { expect(result.value).not.toBe(input); expect(result.value.counters[0]).not.toBe(input.counters[0]); }
  });

  it("rejects non-objects, arrays, class instances and wrong schema versions", () => {
    for (const value of [null, undefined, 3, "x", [], new Date(), new Map()]) expect(reasonOf(parseOperationalWindow(value))).toBe("not-object:window");
    expect(reasonOf(parseOperationalWindow(win({ schemaVersion: 2 })))).toBe("schema-version:window.schemaVersion");
    expect(reasonOf(parseOperationalWindow(win({ schemaVersion: "1" })))).toBe("schema-version:window.schemaVersion");
  });

  it("rejects unknown keys anywhere, without echoing the key", () => {
    expect(reasonOf(parseOperationalWindow({ ...win(), message: "hello owner" }))).toBe("unknown-key:window");
    expect(reasonOf(parseOperationalWindow(JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(win()).slice(1)}`)))).toBe("unknown-key:window");
    const counters = [{ ...win().counters[0], text: "x" }];
    expect(reasonOf(parseOperationalWindow(win({ counters })))).toBe("unknown-key:window.counters[0]");
    const f = facts(); (f[2] as Record<string, unknown>).file = "/Users/sam/agent.md";
    expect(reasonOf(parseOperationalWindow(win({ facts: f })))).toBe("unknown-key:window.facts[2]");
    expect(reasonOf(parseOperationalWindow(win({ coverageByDetector: { madeUp: "complete" } })))).toBe("unknown-key:window.coverageByDetector");
  });

  it("rejects missing keys", () => {
    const { lifecycle: _drop, ...rest } = win();
    expect(reasonOf(parseOperationalWindow(rest))).toBe("missing-key:window.lifecycle");
    const { value: _v, ...row } = win().counters[0];
    expect(reasonOf(parseOperationalWindow(win({ counters: [row] })))).toBe("missing-key:window.counters[0].value");
  });

  it("rejects non-integer, negative, non-finite and unbounded numbers", () => {
    expect(reasonOf(parseOperationalWindow(win({ seq: 1.5 })))).toBe("bad-integer:window.seq");
    expect(reasonOf(parseOperationalWindow(win({ seq: -1 })))).toBe("out-of-range:window.seq");
    expect(reasonOf(parseOperationalWindow(win({ seq: "1" })))).toBe("bad-integer:window.seq");
    expect(reasonOf(parseOperationalWindow(win({ epoch: Number.POSITIVE_INFINITY })))).toBe("bad-integer:window.epoch");
    expect(reasonOf(parseOperationalWindow(win({ epoch: HEALTH_BOUNDS.epoch })))).toBe("ok");
    expect(reasonOf(parseOperationalWindow(win({ epoch: HEALTH_BOUNDS.epoch + 1 })))).toBe("out-of-range:window.epoch");
    const big = [{ ...win().counters[1], value: HEALTH_BOUNDS.count + 1 }];
    expect(reasonOf(parseOperationalWindow(win({ counters: big })))).toBe("out-of-range:window.counters[0].value");
    expect(reasonOf(parseOperationalWindow(win({ counters: [{ ...win().counters[1], value: HEALTH_BOUNDS.count }] })))).toBe("ok");
    expect(reasonOf(parseOperationalWindow(win({ counters: [{ ...win().counters[1], value: Number.NaN }] })))).toBe("bad-integer:window.counters[0].value");
  });

  it("rejects timestamps of zero or past 2100, and windows of no length, reversed or too long", () => {
    expect(reasonOf(parseOperationalWindow(win({ startAt: 0 })))).toBe("out-of-range:window.startAt");
    expect(reasonOf(parseOperationalWindow(win({ endAt: HEALTH_BOUNDS.timestampMs + 1 })))).toBe("out-of-range:window.endAt");
    expect(reasonOf(parseOperationalWindow(win({ endAt: T0 })))).toBe("inconsistent:window.endAt");
    expect(reasonOf(parseOperationalWindow(win({ endAt: T0 - 1 })))).toBe("inconsistent:window.endAt");
    expect(reasonOf(parseOperationalWindow(win({ endAt: T0 + HEALTH_LIMITS.maxWindowSpanMs, activeMs: 0 })))).toBe("ok");
    expect(reasonOf(parseOperationalWindow(win({ endAt: T0 + HEALTH_LIMITS.maxWindowSpanMs + 1, activeMs: 0 })))).toBe("out-of-range:window.endAt");
    expect(reasonOf(parseOperationalWindow(win({ activeMs: 60_001 })))).toBe("inconsistent:window.activeMs");
    expect(reasonOf(parseOperationalWindow(win({ activeMs: 60_000 })))).toBe("ok");
  });

  it("rejects unknown enum values with an explicit result, never a throw", () => {
    expect(reasonOf(parseOperationalWindow(win({ producer: "cli" })))).toBe("bad-enum:window.producer");
    expect(reasonOf(parseOperationalWindow(win({ lifecycle: "sleeping" })))).toBe("bad-enum:window.lifecycle");
    expect(reasonOf(parseOperationalWindow(win({ coverageByDetector: { backup: "fine" } })))).toBe("bad-enum:window.coverageByDetector.backup");
    expect(reasonOf(parseOperationalWindow(win({ counters: [{ ...win().counters[1], engineKind: "gpt-6-sol" }] })))).toBe("bad-enum:window.counters[0].engineKind");
    expect(reasonOf(parseOperationalWindow(win({ counters: [{ ...win().counters[1], detector: "S03" }] })))).toBe("bad-enum:window.counters[0].detector");
    // a code from another detector's list is not accepted
    expect(reasonOf(parseOperationalWindow(win({ counters: [{ detector: "backup", engineKind: "none", code: "not-json", value: 1 }] })))).toBe("bad-enum:window.counters[0].code");
    expect(reasonOf(parseOperationalWindow(win({ counters: [{ detector: "backup", engineKind: "none", code: "verified", value: 1 }] })))).toBe("ok");
    const f = facts(); (f[0] as Record<string, unknown>).final = "done";
    expect(reasonOf(parseOperationalWindow(win({ facts: f })))).toBe("bad-enum:window.facts[0].final");
    expect(reasonOf(parseOperationalWindow(win({ facts: [{ kind: "chat-line" }] })))).toBe("bad-enum:window.facts[0].kind");
    // `other` is always a valid member
    expect(reasonOf(parseOperationalWindow(win({ producer: "other", lifecycle: "other", counters: [{ detector: "other", engineKind: "other", code: "other", value: 0 }] })))).toBe("ok");
  });

  it("rejects free text where an opaque token belongs", () => {
    for (const bad of ["sam@example.com", "Sam's laptop", "0123456789ABCDEF", "abc", "/Users/sam/x", "f".repeat(65)]) {
      expect(reasonOf(parseOperationalWindow(win({ installationId: bad }))), bad).toBe("bad-token:window.installationId");
    }
    expect(reasonOf(parseOperationalWindow(win({ counters: [{ ...win().counters[0], sourceKey: "work account" }] })))).toBe("bad-token:window.counters[0].sourceKey");
    expect(reasonOf(parseOperationalWindow(win({ installationId: "f".repeat(16) })))).toBe("ok");
    expect(reasonOf(parseOperationalWindow(win({ installationId: "f".repeat(64) })))).toBe("ok");
  });

  it("caps rows at 32 counters and 16 facts", () => {
    const row = win().counters[1];
    expect(reasonOf(parseOperationalWindow(win({ counters: Array(32).fill(row) })))).toBe("ok");
    expect(reasonOf(parseOperationalWindow(win({ counters: Array(33).fill(row) })))).toBe("too-many-rows:window.counters");
    const fact = facts()[2];
    expect(reasonOf(parseOperationalWindow(win({ facts: Array(16).fill(fact) })))).toBe("ok");
    expect(reasonOf(parseOperationalWindow(win({ facts: Array(17).fill(fact) })))).toBe("too-many-rows:window.facts");
    expect(reasonOf(parseOperationalWindow(win({ counters: {} })))).toBe("bad-type:window.counters");
  });

  it("rejects internally inconsistent rows", () => {
    expect(reasonOf(parseOperationalWindow(win({ counters: [{ ...win().counters[0], value: 6 }] })))).toBe("inconsistent:window.counters[0].value");
    expect(reasonOf(parseOperationalWindow(win({ omitted: 1 })))).toBe("inconsistent:window.complete");
    expect(reasonOf(parseOperationalWindow(win({ omitted: 1, complete: false })))).toBe("ok");
    const f = facts(); (f[1] as Record<string, unknown>).oldestPendingAt = null;
    expect(reasonOf(parseOperationalWindow(win({ facts: f })))).toBe("inconsistent:window.facts[1].oldestPendingAt");
    const s = facts(); (s[4] as Record<string, unknown>).maxConsecutiveUnusable = 6;
    expect(reasonOf(parseOperationalWindow(win({ facts: s })))).toBe("inconsistent:window.facts[4].maxConsecutiveUnusable");
    const t = facts(); (t[4] as Record<string, unknown>).trailingUnusable = 3;
    expect(reasonOf(parseOperationalWindow(win({ facts: t })))).toBe("inconsistent:window.facts[4].maxConsecutiveUnusable");
  });

  it("validates every fact kind's fields", () => {
    const f = facts(); (f[3] as Record<string, unknown>).cpuFraction = 1.01;
    expect(reasonOf(parseOperationalWindow(win({ facts: f })))).toBe("out-of-range:window.facts[3].cpuFraction");
    const g = facts(); (g[3] as Record<string, unknown>).sourceClass = "SELECT * FROM messages";
    expect(reasonOf(parseOperationalWindow(win({ facts: g })))).toBe("bad-enum:window.facts[3].sourceClass");
    const h = facts(); (h[2] as Record<string, unknown>).completedScan = "yes";
    expect(reasonOf(parseOperationalWindow(win({ facts: h })))).toBe("bad-type:window.facts[2].completedScan");
    const i = facts(); (i[1] as Record<string, unknown>).holderState = "maybe";
    expect(reasonOf(parseOperationalWindow(win({ facts: i })))).toBe("bad-enum:window.facts[1].holderState");
    const j = facts(); (j[0] as Record<string, unknown>).turnToken = "msg_01HXYZ";
    expect(reasonOf(parseOperationalWindow(win({ facts: j })))).toBe("bad-token:window.facts[0].turnToken");
  });

  it("never throws, even on hostile input", () => {
    const hostile = new Proxy({}, { ownKeys() { throw new Error("boom"); } });
    expect(() => parseOperationalWindow(hostile)).not.toThrow();
    expect(parseOperationalWindow(hostile).ok).toBe(false);
    const getter = { ...win() };
    Object.defineProperty(getter, "seq", { enumerable: true, get() { throw new Error("boom"); } });
    expect(parseOperationalWindow(getter)).toEqual({ ok: false, reason: "internal:boundary" });
  });
});

describe("window lines", () => {
  it("encodes with a newline and round-trips", () => {
    const encoded = encodeWindowLine(win());
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.value.endsWith("\n")).toBe(true);
    expect(new TextEncoder().encode(encoded.value).length).toBeLessThanOrEqual(HEALTH_LIMITS.recordBytes);
    expect(parseWindowLine(encoded.value)).toEqual({ ok: true, value: win() });
  });

  it("drops trailing facts, then counters, to fit 4 KiB; counts them, marks the window incomplete and the losing detectors partial", () => {
    const fact = facts()[0];
    const counter = { detector: "resets", engineKind: "claude", sourceKey: "a".repeat(64), code: "context-overflow", value: 1, denominator: 1, maxDurationMs: 1 };
    const encoded = encodeWindowLine(win({ facts: Array(16).fill(fact), counters: Array(32).fill(counter), coverageByDetector: { resets: "complete", "send-fence": "unavailable" } }));
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(new TextEncoder().encode(encoded.value).length).toBeLessThanOrEqual(4096);
    const parsed = parseWindowLine(encoded.value);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const kept = parsed.value.facts.length + parsed.value.counters.length;
    expect(kept).toBeLessThan(48);
    expect(parsed.value.omitted).toBe(48 - kept);
    expect(parsed.value.complete).toBe(false);
    expect(parsed.value.coverageByDetector.resets).toBe("partial");
    expect(parsed.value.coverageByDetector["dispatch-exhausted"]).toBe("partial");
    expect(parsed.value.coverageByDetector["send-fence"]).toBe("unavailable"); // never upgraded
  });

  it("cuts rows beyond the per-record caps and counts them", () => {
    const row = win().counters[1];
    const encoded = encodeWindowLine(win({ counters: Array(40).fill(row), facts: [] }));
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const parsed = parseWindowLine(encoded.value);
    expect(parsed.ok && parsed.value.counters.length).toBe(32);
    expect(parsed.ok && parsed.value.omitted).toBe(8);
    expect(parsed.ok && parsed.value.coverageByDetector.extraction).toBe("partial");
    expect(parsed.ok && parsed.value.complete).toBe(false);
  });

  it("a window that fits is unchanged", () => {
    const encoded = encodeWindowLine(win());
    expect(encoded.ok && JSON.parse(encoded.value)).toEqual(win());
  });

  it("refuses to encode an invalid window", () => {
    expect(reasonOf(encodeWindowLine(win({ producer: "cli" })))).toBe("bad-enum:window.producer");
    expect(encodeWindowLine(null).ok).toBe(false);
  });

  it("parseWindowLine rejects a line over 4 KiB, bad JSON and non-strings", () => {
    const pad = "0".repeat(4096);
    expect(reasonOf(parseWindowLine(`{"x":"${pad}"}`))).toBe("too-large:line");
    expect(reasonOf(parseWindowLine("{not json"))).toBe("not-json:line");
    expect(reasonOf(parseWindowLine(42))).toBe("bad-type:line");
    // exactly at the ceiling (4095 bytes + newline) passes the size check
    const exact = "x".repeat(4095);
    expect(reasonOf(parseWindowLine(exact))).toBe("not-json:line");
    expect(reasonOf(parseWindowLine("x".repeat(4096)))).toBe("too-large:line");
  });
});

describe("IO samples", () => {
  it("charged rate = max(0, max(os, app) - planned) * 60000 / intervalMs", () => {
    expect(chargedRatePerMin(io())).toBe(1_500_000);
    expect(chargedRatePerMin(io({ intervalMs: 30_000 }))).toBe(3_000_000);
    expect(chargedRatePerMin(io({ osBytes: 100, applicationBytes: 200, plannedBytesAllowed: 500 }))).toBe(0);
    expect(chargedRatePerMin(io({ osBytes: null, applicationBytes: 1_000_000, plannedBytesAllowed: 0, intervalMs: 90_000 }))).toBeCloseTo(666_666.67, 1);
    expect(chargedRatePerMin(io({ applicationBytes: 3_000_000 }))).toBe(2_500_000);
    expect(chargedRatePerMin(io({ intervalMs: 0 }))).toBeNull();
  });

  it("idle 50 MiB/min boundary is computed exactly", () => {
    const fifty = 50 * 1024 * 1024;
    expect(chargedRatePerMin(io({ osBytes: fifty, applicationBytes: 0, plannedBytesAllowed: 0 }))).toBe(fifty);
    expect(chargedRatePerMin(io({ osBytes: fifty - 1, applicationBytes: 0, plannedBytesAllowed: 0 }))).toBe(fifty - 1);
  });

  it("a valid sample spans 45 to 90 s inclusive with no discontinuity", () => {
    expect(isValidIoSample(io({ intervalMs: 45_000 }))).toBe(true);
    expect(isValidIoSample(io({ intervalMs: 90_000 }))).toBe(true);
    expect(isValidIoSample(io({ intervalMs: 44_999 }))).toBe(false);
    expect(isValidIoSample(io({ intervalMs: 90_001 }))).toBe(false);
    expect(isValidIoSample(io({ discontinuity: true }))).toBe(false);
    expect(isValidIoSample({ kind: "io-minute", ...io() })).toBe(true);
    expect(isValidIoSample(io({ cpuFraction: -0.1 }))).toBe(false);
    expect(isValidIoSample(null)).toBe(false);
  });

  it("parseIoSample enforces the field list and ranges", () => {
    expect(parseIoSample(io()).ok).toBe(true);
    expect(reasonOf(parseIoSample({ ...io(), sql: "UPDATE" }))).toBe("unknown-key:io");
    expect(reasonOf(parseIoSample(io({ pollScale: HEALTH_BOUNDS.pollScale + 1 })))).toBe("out-of-range:io.pollScale");
    expect(reasonOf(parseIoSample(io({ pollScale: Number.NaN })))).toBe("bad-number:io.pollScale");
    expect(reasonOf(parseIoSample(io({ chargedBytes: HEALTH_BOUNDS.bytes + 1 })))).toBe("out-of-range:io.chargedBytes");
    expect(reasonOf(parseIoSample(io({ idle: 1 })))).toBe("bad-type:io.idle");
  });
});

describe("parseBackupStatus", () => {
  const status = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1, installationId: ID, revision: 4, at: T0, enabled: true, configuredAt: T0 - 86_400_000, policyRevision: 2, dueAt: T0 - 3_600_000, nextDueAt: T0 + 3_600_000,
    phase: "failed", failureCode: "capture-failed", failureAt: T0 - 60_000, lastAttemptAt: T0 - 60_000, captureDeadlineAt: T0, currentBindingMatches: true,
    lastVerified: { verifiedAt: T0 - 172_800_000, snapshotToken: TOK, bytes: 12_345, verification: "artifact-reread" }, coverage: "complete", ...over,
  });
  it("accepts a valid manifest and the never-verified, off states", () => {
    expect(parseBackupStatus(status())).toEqual({ ok: true, value: status() });
    const { failureCode: _a, failureAt: _b, lastAttemptAt: _c, captureDeadlineAt: _d, ...plain } = status({ lastVerified: null, phase: "idle" });
    expect(parseBackupStatus(plain).ok).toBe(true);
    expect(parseBackupStatus({ ...plain, enabled: false, configuredAt: null, dueAt: null, nextDueAt: null, phase: "off" }).ok).toBe(true);
    expect(parseBackupStatus({ ...plain, pendingOwnerSince: T0, phase: "waiting-owner" }).ok).toBe(true);
  });
  it("rejects every malformed field", () => {
    expect(reasonOf(parseBackupStatus({ ...status(), destination: "/Volumes/Backup" }))).toBe("unknown-key:backup");
    expect(reasonOf(parseBackupStatus(status({ schemaVersion: 0 })))).toBe("schema-version:backup.schemaVersion");
    expect(reasonOf(parseBackupStatus(status({ phase: "uploading" })))).toBe("bad-enum:backup.phase");
    expect(reasonOf(parseBackupStatus(status({ failureCode: "ENOSPC: /Users/sam" })))).toBe("bad-enum:backup.failureCode");
    expect(reasonOf(parseBackupStatus(status({ lastVerified: { verifiedAt: T0, snapshotToken: TOK, bytes: 1, verification: "offsite" } })))).toBe("bad-enum:backup.lastVerified.verification");
    expect(reasonOf(parseBackupStatus(status({ lastVerified: { verifiedAt: T0, snapshotToken: "snap-1.age", bytes: 1, verification: "artifact-reread" } })))).toBe("bad-token:backup.lastVerified.snapshotToken");
    expect(reasonOf(parseBackupStatus(status({ lastVerified: { verifiedAt: T0, snapshotToken: TOK, bytes: 1, verification: "artifact-reread", path: "x" } })))).toBe("unknown-key:backup.lastVerified");
    expect(reasonOf(parseBackupStatus(status({ revision: -1 })))).toBe("out-of-range:backup.revision");
    expect(reasonOf(parseBackupStatus(status({ dueAt: 1.5 })))).toBe("bad-integer:backup.dueAt");
    expect(reasonOf(parseBackupStatus(status({ enabled: "true" })))).toBe("bad-type:backup.enabled");
    expect(reasonOf(parseBackupStatus(status({ failureCode: undefined })))).toBe("bad-enum:backup.failureCode");
    const { failureCode: _fc, ...noCode } = status();
    expect(reasonOf(parseBackupStatus(noCode))).toBe("inconsistent:backup.failureCode");
    expect(reasonOf(parseBackupStatus(status({ configuredAt: null })))).toBe("inconsistent:backup.configuredAt");
    const { coverage: _cov, ...noCoverage } = status();
    expect(reasonOf(parseBackupStatus(noCoverage))).toBe("missing-key:backup.coverage");
  });
});

describe("parseDbStatsManifest and rows", () => {
  const manifest = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1, installationId: ID, generation: 12, file: "db-stats-12.sqlite", sha256: "a".repeat(64), bytes: 8192, statsSchemaVersion: 1, at: T0, coverage: "complete", ...over,
  });
  it("accepts a valid manifest", () => { expect(parseDbStatsManifest(manifest())).toEqual({ ok: true, value: manifest() }); });
  it("rejects a mismatched file, a bad digest, an oversize or empty snapshot and unknown versions", () => {
    expect(reasonOf(parseDbStatsManifest(manifest({ file: "../messages.db" })))).toBe("inconsistent:dbStats.file");
    expect(reasonOf(parseDbStatsManifest(manifest({ file: "db-stats-11.sqlite" })))).toBe("inconsistent:dbStats.file");
    expect(reasonOf(parseDbStatsManifest(manifest({ sha256: "A".repeat(64) })))).toBe("bad-token:dbStats.sha256");
    expect(reasonOf(parseDbStatsManifest(manifest({ bytes: HEALTH_LIMITS.statsSnapshotBytes })))).toBe("ok");
    expect(reasonOf(parseDbStatsManifest(manifest({ bytes: HEALTH_LIMITS.statsSnapshotBytes + 1 })))).toBe("out-of-range:dbStats.bytes");
    expect(reasonOf(parseDbStatsManifest(manifest({ bytes: 0 })))).toBe("out-of-range:dbStats.bytes");
    expect(reasonOf(parseDbStatsManifest(manifest({ statsSchemaVersion: 2 })))).toBe("schema-version:dbStats.statsSchemaVersion");
    expect(reasonOf(parseDbStatsManifest({ ...manifest(), path: "/x" }))).toBe("unknown-key:dbStats");
    expect(reasonOf(parseDbStatsManifest(manifest({ coverage: "ok" })))).toBe("bad-enum:dbStats.coverage");
  });
  it("db_stats rows keep NULL as null and only allowlisted roles", () => {
    const row = { role: "messages", sampled_at: T0, page_size: 4096, page_count: null, freelist_pages: 0, db_bytes: null, wal_bytes: 0, pending_revocations: null, oldest_pending_at: null };
    expect(parseDbStatsRow(row)).toEqual({ ok: true, value: row });
    expect(reasonOf(parseDbStatsRow({ ...row, role: "sqlite_master" }))).toBe("bad-enum:dbStatsRow.role");
    expect(reasonOf(parseDbStatsRow({ ...row, message_id: 1 }))).toBe("unknown-key:dbStatsRow");
    expect(reasonOf(parseDbStatsRow({ ...row, page_count: -1 }))).toBe("out-of-range:dbStatsRow.page_count");
  });
});

describe("parseEvidenceRef", () => {
  it("accepts the two shapes and nothing else", () => {
    expect(parseEvidenceRef({ sourceRole: "server", epoch: 1, seq: 2, bucket: 3, observedAt: T0 }).ok).toBe(true);
    expect(parseEvidenceRef({ sourceRole: "backup", generation: 4, observedAt: T0 }).ok).toBe(true);
    expect(reasonOf(parseEvidenceRef({ sourceRole: "backup", epoch: 1, seq: 2, bucket: 3, observedAt: T0 }))).toBe("unknown-key:evidence");
    expect(reasonOf(parseEvidenceRef({ sourceRole: "server", generation: 4, observedAt: T0 }))).toBe("unknown-key:evidence");
    expect(reasonOf(parseEvidenceRef({ sourceRole: "url", generation: 4, observedAt: T0 }))).toBe("bad-enum:evidence.sourceRole");
    expect(reasonOf(parseEvidenceRef({ sourceRole: "desktop", epoch: 1, seq: 2, bucket: 49, observedAt: T0 }))).toBe("out-of-range:evidence.bucket");
    expect(reasonOf(parseEvidenceRef({ sourceRole: "db-stats", generation: 1, observedAt: T0, href: "https://x" }))).toBe("unknown-key:evidence");
  });
});
