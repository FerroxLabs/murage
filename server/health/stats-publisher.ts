// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sealed database statistics for Sentinel (1.0.9, GAP-SENTINEL-109 sections 3.2 and 4.1).
//
// publishStatsGeneration(observation) writes DATA_DIR/health/db-stats-<generation>.sqlite, a NEW metadata-only database
// of the two fixed tables in shared/health-protocol.mjs (DB_STATS_TABLES), then replaces db-stats-current.json.
// Protocol: the generation is built in a temporary child inside health/ by a worker thread (never on the serving
// thread), with journal_mode=DELETE so no WAL or journal survives the commit; the worker closes it, fsyncs it and
// digests it; the publisher checks size and sidecars, renames it to its unique generation name, and only then
// atomically publishes the manifest. A named generation is never edited. Current and previous are kept; older
// publisher-owned generations are removed (a Windows sharing refusal is retried at the next publication).
//
// Values come only from the caller's observation (database.ts storageObservation(): page size/count, freelist, file
// and WAL sizes from the already-open connection). This file opens no product database, scans no rows and requests no
// checkpoint. Cadence (every 15 min while the database owner runs) belongs to the caller. The `messages` row's
// pending_revocations / oldest_pending_at come from maintained counters (pending-revocations.ts) when the caller has none:
// NULL until known, never zero for unknown.
import { Worker } from "node:worker_threads";
import { lstatSync } from "node:fs";
import { basename, join } from "node:path";
import {
  DB_STATS_ROLES, DB_STATS_SCHEMA_VERSION, DB_STATS_TABLES, HEALTH_BOUNDS, HEALTH_FILES, HEALTH_LIMITS, HEALTH_SCHEMA_VERSION, HEALTH_TOKEN_PATTERN,
  dbStatsFileName, parseDbStatsManifest, parseDbStatsRow,
  type CoverageValue, type DbStatsManifest, type DbStatsRole, type DbStatsRow,
} from "../../shared/health-protocol.mjs";
import { renameWithRetry } from "../atomic.ts";
import type { HealthPublisher } from "./publisher.ts";
import { pendingRevocationFigures, withPendingRevocations, type PendingRevocationFigures } from "./pending-revocations.ts";

export const STATS_BUILD_TIMEOUT_MS = 10_000;
export const STATS_GENERATION_PATTERN = /^db-stats-(\d{1,13})\.sqlite$/;

/** One role's figures as observed; anything not known is omitted or null (stored as NULL, never zero). */
export type DbStatsObservationRow = { role: DbStatsRole } & Partial<Omit<DbStatsRow, "role">>;
export interface DbStatsObservation { at: number; rows: DbStatsObservationRow[]; coverage?: CoverageValue }
export interface BuiltGeneration { ok: true; sha256: string; bytes: number; sidecar: boolean }
export type BuildResult = BuiltGeneration | { ok: false; code: string };
export interface StatsBuildInput { file: string; snapshot: { version: number; installation_id: string; generation: number; at: number; coverage: CoverageValue }; rows: DbStatsRow[]; tables: typeof DB_STATS_TABLES }
export type StatsBuilder = (input: StatsBuildInput) => Promise<BuildResult>;

// Plain CommonJS for an eval worker: no bundler entry is needed. It only creates the temporary file it is given.
const BUILD_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { closeSync, existsSync, fsyncSync, openSync, readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { file, snapshot, rows, tables } = workerData;
try {
  if (existsSync(file)) throw Object.assign(new Error("exists"), { code: "exists" });
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=DELETE");
    db.exec("CREATE TABLE snapshot(version INTEGER NOT NULL, installation_id TEXT NOT NULL, generation INTEGER NOT NULL, at INTEGER NOT NULL, coverage TEXT NOT NULL)");
    db.exec("CREATE TABLE db_stats(role TEXT NOT NULL PRIMARY KEY, sampled_at INTEGER NOT NULL, page_size INTEGER, page_count INTEGER, freelist_pages INTEGER, db_bytes INTEGER, wal_bytes INTEGER, pending_revocations INTEGER, oldest_pending_at INTEGER) WITHOUT ROWID");
    db.exec("BEGIN");
    db.prepare("INSERT INTO snapshot(" + tables.snapshot.join(",") + ") VALUES(?,?,?,?,?)").run(...tables.snapshot.map(column => snapshot[column]));
    const insert = db.prepare("INSERT INTO db_stats(" + tables.db_stats.join(",") + ") VALUES(?,?,?,?,?,?,?,?,?)");
    for (const row of rows) insert.run(...tables.db_stats.map(column => row[column]));
    db.exec("COMMIT");
  } finally { db.close(); }
  const fd = openSync(file, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  const bytes = readFileSync(file);
  const sidecar = ["-journal", "-wal", "-shm"].some(suffix => existsSync(file + suffix));
  parentPort.postMessage({ ok: true, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, sidecar });
} catch (error) {
  parentPort.postMessage({ ok: false, code: (error && typeof error.code === "string" && /^[a-z-]{1,40}$/i.test(error.code)) ? error.code : "build-failed" });
}
`;

/** Builds one generation in a worker thread. Times out (and terminates the worker) after STATS_BUILD_TIMEOUT_MS. */
export const buildInWorker: StatsBuilder = input => new Promise(resolve => {
  let settled = false;
  const finish = (result: BuildResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
  const worker = new Worker(BUILD_WORKER_SOURCE, { eval: true, workerData: input });
  const timer = setTimeout(() => { finish({ ok: false, code: "timeout" }); void worker.terminate(); }, STATS_BUILD_TIMEOUT_MS);
  timer.unref?.();
  worker.once("message", (message: BuildResult) => { finish(message); void worker.terminate(); });
  worker.once("error", () => finish({ ok: false, code: "worker-error" }));
  worker.once("exit", () => finish({ ok: false, code: "worker-exit" }));
});

/** Normalizes the caller's observation into at most eight valid rows (one per allowlisted role). */
export function observationRows(observation: DbStatsObservation): { rows: DbStatsRow[]; dropped: number } {
  const rows: DbStatsRow[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const input of Array.isArray(observation.rows) ? observation.rows : []) {
    if (rows.length >= HEALTH_LIMITS.dbStatsRoles || seen.has(input?.role)) { dropped++; continue; }
    const value = (key: keyof Omit<DbStatsRow, "role" | "sampled_at">) => {
      const raw = input[key];
      return typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : null;
    };
    const parsed = parseDbStatsRow({
      role: (DB_STATS_ROLES as readonly string[]).includes(input?.role) ? input.role : "other",
      sampled_at: typeof input.sampled_at === "number" ? input.sampled_at : observation.at,
      page_size: value("page_size"), page_count: value("page_count"), freelist_pages: value("freelist_pages"), db_bytes: value("db_bytes"),
      wal_bytes: value("wal_bytes"), pending_revocations: value("pending_revocations"), oldest_pending_at: value("oldest_pending_at"),
    });
    if (!parsed.ok) { dropped++; continue; }
    seen.add(parsed.value.role);
    rows.push(parsed.value);
  }
  return { rows, dropped };
}

export interface StatsPublisherOptions {
  publisher: HealthPublisher; installationId: string; build?: StatsBuilder; now?: () => number;
  /** Pending revocation figures for the `messages` row. Default: the maintained counters. */
  pendingRevocations?: () => PendingRevocationFigures;
}

export class StatsPublisher {
  private readonly options: StatsPublisherOptions;
  private lastGeneration: number | null = null;
  private inFlight: Promise<DbStatsManifest | null> | null = null;

  constructor(options: StatsPublisherOptions) {
    if (!HEALTH_TOKEN_PATTERN.test(options.installationId)) throw new Error("HEALTH_INSTALLATION_ID_INVALID");
    this.options = options;
  }

  /** Publishes one sealed generation from `observation`. One at a time: a call while one runs shares its result.
   *  Answers the committed manifest, or null when nothing was published (deferred root, build or size failure). */
  publishStatsGeneration(observation: DbStatsObservation): Promise<DbStatsManifest | null> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.publish(observation).catch(() => null).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private current(): DbStatsManifest | null {
    const parsed = parseDbStatsManifest(this.options.publisher.readManifest(HEALTH_FILES.dbStatsManifest));
    return parsed.ok && parsed.value.installationId === this.options.installationId ? parsed.value : null;
  }

  private async publish(observation: DbStatsObservation): Promise<DbStatsManifest | null> {
    const { publisher, installationId } = this.options;
    if (!publisher.ensureReady()) return null;
    const previous = this.current();
    const at = Math.floor(typeof observation?.at === "number" && Number.isFinite(observation.at) ? observation.at : (this.options.now ?? Date.now)());
    const floor = Math.max(this.lastGeneration ?? 0, previous?.generation ?? 0);
    const generation = Math.min(HEALTH_BOUNDS.generation, Math.max(Math.floor(at / 1000), floor + 1));
    const { rows, dropped } = observationRows(withPendingRevocations(observation, (this.options.pendingRevocations ?? pendingRevocationFigures)()));
    const coverage: CoverageValue = observation.coverage ?? (dropped > 0 || rows.length === 0 ? "partial" : "complete");
    const temp = publisher.tempPath("sqlite");
    const result = await (this.options.build ?? buildInWorker)({
      file: temp, tables: DB_STATS_TABLES, rows,
      snapshot: { version: DB_STATS_SCHEMA_VERSION, installation_id: installationId, generation, at, coverage },
    });
    const discard = () => { for (const suffix of ["", "-journal", "-wal", "-shm"]) publisher.removeOwned(basename(temp) + suffix); return null; };
    if (!result.ok || result.sidecar || result.bytes < 1 || result.bytes > HEALTH_LIMITS.statsSnapshotBytes) return discard();
    if (!publisher.ensureReady() || !publisher.chargeDay(result.bytes)) return discard();
    const name = dbStatsFileName(generation);
    try {
      const target = join(publisher.root!, name);
      try { lstatSync(target); return discard(); } catch { /* a generation name is never reused */ }
      renameWithRetry(temp, target);
    } catch { return discard(); }
    const manifest = parseDbStatsManifest({
      schemaVersion: HEALTH_SCHEMA_VERSION, installationId, generation, file: name, sha256: result.sha256, bytes: result.bytes,
      statsSchemaVersion: DB_STATS_SCHEMA_VERSION, at, coverage,
    });
    if (!manifest.ok || !publisher.replaceManifest(HEALTH_FILES.dbStatsManifest, JSON.stringify(manifest.value))) {
      publisher.removeOwned(name); // unreferenced; the previous manifest stays authoritative
      return null;
    }
    this.lastGeneration = generation;
    this.prune(generation, previous?.generation ?? null);
    return manifest.value;
  }

  /** Removes publisher-owned generations other than current and previous. */
  private prune(current: number, previous: number | null): void {
    for (const name of this.options.publisher.listChildren()) {
      const match = STATS_GENERATION_PATTERN.exec(name);
      if (!match) continue;
      const generation = Number(match[1]);
      if (generation === current || generation === previous) continue;
      this.options.publisher.removeOwned(name);
    }
  }
}
