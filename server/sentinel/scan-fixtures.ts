// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Disposable installations for the Sentinel scanner tests: a temp DATA_DIR with its health/ root, a separate output
// root and a written descriptor. Every input is synthetic and goes through the frozen contract's encoders/validators
// (encodeWindowLine, parseBackupStatus, the sealed stats schema). Never real data, never a real data directory.
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DB_STATS_TABLES, HEALTH_FILES, dbStatsFileName, encodeWindowLine, parseBackupStatus,
  type BackupStatus, type DbStatsRow, type OperationalWindow,
} from "../../shared/health-protocol.mjs";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { INST, T0, tok } from "./detectors/fixtures.ts";
import type { IssueRecord } from "./lifecycle.ts";
import { fingerprint, type Issue } from "./types.ts";
import { DESCRIPTOR_FILE, OUTPUT_PARENT, ensureOutputRoot, sourcePaths, writeDescriptor, type SentinelDescriptor } from "./paths.ts";

export { INST, T0 };
export const HOUR = 60 * 60_000;
export const DAY = 24 * HOUR;

export interface FixtureInstall {
  base: string;
  descriptor: SentinelDescriptor;
  descriptorPath: string;
  health: string;
  file(name: keyof typeof HEALTH_FILES): string;
  append(producer: "server" | "desktop", windows: OperationalWindow | OperationalWindow[]): void;
  appendRaw(producer: "server" | "desktop", text: string): void;
  rotate(producer: "server" | "desktop"): void;
  writeBackup(overrides?: Partial<BackupStatus>): BackupStatus;
  writeStats(options?: StatsOptions): { file: string; manifest: Record<string, unknown> };
  cleanup(): void;
}

export interface StatsOptions {
  generation?: number;
  at?: number;
  rows?: Partial<DbStatsRow>[];
  /** Extra SQL run after the fixed tables (a forbidden view, trigger or table). */
  extraSql?: string;
  /** Override manifest fields after computing them. */
  manifest?: Record<string, unknown>;
  installationId?: string;
}

const created: string[] = [];
/** Removes every fixture directory made so far (call from afterEach). */
export function cleanupFixtures(): void { for (const dir of created.splice(0)) removeTempDirSync(dir); }

export function backupStatus(overrides: Partial<BackupStatus> = {}): BackupStatus {
  const raw = {
    schemaVersion: 1, installationId: INST, revision: 1, at: T0, enabled: true, configuredAt: T0 - 7 * DAY, policyRevision: 1, dueAt: null,
    nextDueAt: T0 + DAY, phase: "idle", currentBindingMatches: true,
    lastVerified: { verifiedAt: T0 - HOUR, snapshotToken: "ab".repeat(16), bytes: 1_000_000, verification: "artifact-reread" }, coverage: "complete",
    ...overrides,
  };
  const parsed = parseBackupStatus(raw);
  if (!parsed.ok) throw new Error(`fixture backup status invalid: ${parsed.reason}`);
  return parsed.value;
}

/** Builds a sealed stats generation file at `path` with the producer's exact schema. */
export function buildStatsDb(path: string, options: StatsOptions & { generation: number }): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode=DELETE");
    db.exec("CREATE TABLE snapshot(version INTEGER NOT NULL, installation_id TEXT NOT NULL, generation INTEGER NOT NULL, at INTEGER NOT NULL, coverage TEXT NOT NULL)");
    db.exec("CREATE TABLE db_stats(role TEXT NOT NULL PRIMARY KEY, sampled_at INTEGER NOT NULL, page_size INTEGER, page_count INTEGER, freelist_pages INTEGER, db_bytes INTEGER, wal_bytes INTEGER, pending_revocations INTEGER, oldest_pending_at INTEGER) WITHOUT ROWID");
    db.prepare(`INSERT INTO snapshot(${DB_STATS_TABLES.snapshot.join(",")}) VALUES(?,?,?,?,?)`).run(1, options.installationId ?? INST, options.generation, options.at ?? T0, "complete");
    const insert = db.prepare(`INSERT INTO db_stats(${DB_STATS_TABLES.db_stats.join(",")}) VALUES(?,?,?,?,?,?,?,?,?)`);
    const rows = options.rows ?? [{ role: "messages", page_size: 4096, page_count: 2500, freelist_pages: 12, db_bytes: 10_240_000, wal_bytes: 0 }];
    for (const row of rows) insert.run(...DB_STATS_TABLES.db_stats.map(column => (row as Record<string, unknown>)[column] ?? (column === "sampled_at" ? options.at ?? T0 : null)) as never[]);
    if (options.extraSql) db.exec(options.extraSql);
  } finally { db.close(); }
}

export function makeInstall(prefix = "murage-sentinel-"): FixtureInstall {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  created.push(base);
  const installationRoot = join(base, "data");
  mkdirSync(installationRoot, { mode: 0o700 });
  const health = join(installationRoot, "health");
  mkdirSync(health, { mode: 0o700 });
  chmodSync(health, 0o700);
  mkdirSync(join(base, "state"), { mode: 0o700 });
  const outputRoot = join(base, "state", OUTPUT_PARENT, INST);
  const ensured = ensureOutputRoot(outputRoot);
  if (!ensured.ok) throw new Error(`fixture output root refused: ${ensured.reason}`);
  mkdirSync(join(base, "bin"), { mode: 0o700 });
  const descriptor: SentinelDescriptor = {
    version: 1, installationId: INST, installationRoot, inputRoot: health, outputRoot, sources: sourcePaths(health),
    executable: { path: process.execPath, entry: join(base, "bin", "cli.js"), sha256: null }, scheduleRevision: 1,
  };
  const written = writeDescriptor(descriptor);
  if (!written.ok) throw new Error(`fixture descriptor refused: ${written.reason}`);
  const file = (name: keyof typeof HEALTH_FILES) => join(health, HEALTH_FILES[name]);
  const segment = (producer: "server" | "desktop", which: "Current" | "Previous") => file(`${producer}${which}` as keyof typeof HEALTH_FILES);
  return {
    base, descriptor, descriptorPath: join(outputRoot, DESCRIPTOR_FILE), health, file,
    append(producer, windows) {
      for (const w of Array.isArray(windows) ? windows : [windows]) {
        const line = encodeWindowLine(w);
        if (!line.ok) throw new Error(`fixture window refused: ${line.reason}`);
        appendFileSync(segment(producer, "Current"), line.value, { mode: 0o600 });
      }
    },
    appendRaw(producer, text) { appendFileSync(segment(producer, "Current"), text, { mode: 0o600 }); },
    rotate(producer) { renameSync(segment(producer, "Current"), segment(producer, "Previous")); },
    writeBackup(overrides = {}) {
      const status = backupStatus(overrides);
      const temp = join(health, ".tmp-0000000000000001.json");
      writeFileSync(temp, JSON.stringify(status), { mode: 0o600 });
      renameSync(temp, file("backupStatus"));
      return status;
    },
    writeStats(options = {}) {
      const generation = options.generation ?? 1;
      const name = dbStatsFileName(generation);
      const temp = join(health, ".tmp-0000000000000002.sqlite");
      rmSync(temp, { force: true });
      buildStatsDb(temp, { ...options, generation });
      const target = join(health, name);
      renameSync(temp, target);
      const bytes = readFileSync(target);
      const manifest = {
        schemaVersion: 1, installationId: options.installationId ?? INST, generation, file: name, sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length, statsSchemaVersion: 1, at: options.at ?? T0, coverage: "complete", ...(options.manifest ?? {}),
      };
      writeFileSync(file("dbStatsManifest"), JSON.stringify(manifest), { mode: 0o600 });
      return { file: target, manifest };
    },
    cleanup() { removeTempDirSync(base); },
  };
}

/** A synthetic persisted issue record (an S03 extraction issue per source n). */
export function issueRecord(n: number, overrides: Partial<Issue> = {}): IssueRecord {
  const tuple = { installationId: INST, detectorId: "extraction" as const, subsystem: "memory" as const, engineKind: "claude" as const, sourceKey: tok(n), errorClass: "unusable" };
  const issue: Issue = {
    schemaVersion: 1, fingerprint: fingerprint(tuple), detectorVersion: 1, detectorId: "extraction", installationId: INST, subsystem: "memory", engineKind: "claude",
    sourceKey: tok(n), code: "unusable", severity: "medium", state: "open", episode: 1, titleKey: "extraction.unusable", firstSeenAt: T0, lastSeenAt: T0 + n, openedAt: T0,
    count: 3, window: { startAt: T0 - 60_000, endAt: T0 }, metrics: {}, evidence: [], coverage: { overall: "complete", sources: [] }, relatedFingerprints: [], ...overrides,
  };
  return { issue, recoveryStartedAt: null, pageDecidedEpisode: 0, lastPagedAt: null, delivery: "digest" };
}

