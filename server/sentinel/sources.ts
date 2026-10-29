// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The fixed input inventory reader (1.0.9, GAP-SENTINEL-109 sections 3.2, 3.3, 6.3 and 9).
//
// Inputs are exactly the descriptor's six source paths under <DATA_DIR>/health; nothing is discovered. Every reader
// distinguishes `unavailable` (missing, refused or unreadable) from an observed value, and never turns a failure into
// an empty "all clear".
//
// Operational segments (<producer>.current/.previous.ndjson) are read incrementally from a cursor: producer epoch, the
// segment's file identity and byte offset, the last committed sequence and an intra-record bucket. Only complete lines
// advance the cursor; a line above 4 KiB is skipped and counted. A rotation (current renamed to previous) finishes the
// old segment by identity, then reads the new current from byte 0. A truncated or rewritten segment, a missed rotation or
// a new epoch is a discontinuity: coverage becomes partial and the reader takes the bounded baseline (the last 64 KiB of
// each segment, previous then current, windows from the last 60 min) instead of rereading history from byte 0. (epoch,
// seq) deduplicates; wall-clock equality never does. The first scan takes the same baseline.
//
// The sealed stats generation is validated (manifest, containment, identity, size, digest, no -wal/-shm/-journal
// sidecar) and opened with the immutable read-only URI, extension loading off, query_only and trusted_schema=0, fixed
// SELECTs on the two allowlisted tables, no views, triggers or virtual tables, at most 8 queries and 256 rows, closed
// before the scan ends. Any refusal is `unavailable`, never a fallback to a live database.
import { createHash } from "node:crypto";
import { closeSync, lstatSync, readSync } from "node:fs";
import { posix, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DB_STATS_SCHEMA_VERSION, DB_STATS_TABLES, HEALTH_LIMITS, parseBackupStatus, parseDbStatsManifest, parseDbStatsRow, parseWindowLine,
  type BackupStatus, type CoverageValue, type DbStatsManifest, type DbStatsRow, type OperationalWindow,
} from "../../shared/health-protocol.mjs";
import type { ScanBudget } from "./budget.ts";
import { checkInputFile, openVerified, readSmallVerified, sameFile, sameIdentity, type FileIdentity, type PlatformOptions } from "./paths.ts";
import type { Coverage, DbStatsSnapshot } from "./types.ts";

export const BACKUP_STATUS_MAX_BYTES = 16 * 1024;
export const DB_MANIFEST_MAX_BYTES = 4 * 1024;
const NEWLINE = 0x0a;

export type ProducerKey = "server" | "desktop";

/** Where the next unread byte of a producer's stream is. */
export interface SegmentPos {
  dev: number; ino: number; offset: number;
  /** Digest of the segment's first `headLen` consumed bytes (at most 128): an inode number reused by a new file after a
   * missed rotation cannot pass for the segment we were reading. */
  head: string; headLen: number;
}
export const HEAD_BYTES = 128;

/** The persisted cursor for one producer (section 6.3). */
export interface ProducerCursor {
  epoch: number;
  lastSeq: number;
  segment: SegmentPos | null;
  /** Identities seen at the last read, for the no-op check. */
  current: FileIdentity | null;
  previous: FileIdentity | null;
  /** Intra-record bucket position: always 0 here, since a window is evaluated whole; kept for the contract. */
  bucket: number;
}

export interface ProducerRead {
  windows: OperationalWindow[];
  cursor: ProducerCursor | null;
  coverage: Coverage;
  /** Truncation, rewrite, missed rotation or a new epoch: freeze recovery accumulation this scan. */
  discontinuity: boolean;
  /** False when identities were unchanged and nothing was read. */
  changed: boolean;
  invalidLines: number;
  reason: string | null;
}

export interface ReadContext extends PlatformOptions {
  budget: ScanBudget;
  installationId: string;
  inputRoot: string;
  now: number;
}

const pathFor = (platform: NodeJS.Platform | undefined) => ((platform ?? process.platform) === "win32" ? win32 : posix);

interface SegmentPlanItem { path: string; identity: FileIdentity; from: number; baseline: boolean; verifyBoundary: boolean }

interface SegmentOutcome { offset: number; completed: boolean; rewritten: boolean; stopped: boolean }

/** Reads complete lines of one segment from `from` up to its inspected size, within the scan budget. */
function readSegment(item: SegmentPlanItem, budget: ScanBudget, onLine: (line: string | null) => boolean): SegmentOutcome {
  const opened = openVerified(item.path, item.identity);
  if (!opened.ok) return { offset: item.from, completed: false, rewritten: false, stopped: true };
  const fd = opened.value;
  try {
    let pos = item.from;
    let committed = item.from;
    if (item.verifyBoundary && item.from > 0) {
      const one = Buffer.alloc(1);
      if (readSync(fd, one, 0, 1, item.from - 1) !== 1 || one[0] !== NEWLINE) return { offset: item.from, completed: false, rewritten: true, stopped: false };
      budget.chargeBytes(1);
    }
    let skipToNewline = false;
    if (item.baseline && item.from > 0) {
      // Align to the first full line after the cut point.
      skipToNewline = true;
      const one = Buffer.alloc(1);
      if (readSync(fd, one, 0, 1, item.from - 1) === 1 && one[0] === NEWLINE) skipToNewline = false;
    }
    let carry: Buffer = Buffer.alloc(0);
    let carryStart = pos;
    while (pos < item.identity.size) {
      const allowance = Math.min(budget.chunkAllowance(), item.identity.size - pos);
      if (allowance <= 0 || !budget.withinRuntime()) return { offset: committed, completed: false, rewritten: false, stopped: true };
      const chunk = Buffer.alloc(allowance);
      const n = readSync(fd, chunk, 0, allowance, pos);
      if (n <= 0) break;
      budget.chargeBytes(n);
      const data: Buffer = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      const dataStart = carry.length ? carryStart : pos;
      pos += n;
      let lineStart = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== NEWLINE) continue;
        const lineEnd = i + 1;
        if (skipToNewline) { skipToNewline = false; committed = dataStart + lineEnd; lineStart = lineEnd; continue; }
        const length = lineEnd - lineStart;
        const accepted = length > HEALTH_LIMITS.recordBytes ? onLine(null) : onLine(data.toString("utf8", lineStart, lineEnd));
        if (!accepted) return { offset: committed, completed: false, rewritten: false, stopped: true };
        committed = dataStart + lineEnd;
        lineStart = lineEnd;
      }
      carry = data.subarray(lineStart);
      carryStart = dataStart + lineStart;
      if (carry.length > HEALTH_LIMITS.recordBytes) {
        // An oversize line: drop what we hold and skip to its end without buffering it.
        if (!skipToNewline) { if (!onLine(null)) return { offset: committed, completed: false, rewritten: false, stopped: true }; }
        skipToNewline = true;
        carry = Buffer.alloc(0);
        carryStart = pos;
      }
    }
    // A trailing partial line stays unread: the cursor waits at its start.
    return { offset: committed, completed: committed === item.identity.size || pos >= item.identity.size, rewritten: false, stopped: false };
  } finally { closeSync(fd); }
}

/** Digest of a segment's first `length` bytes through a verified handle (null when unreadable or shorter). */
function prefixDigest(path: string, identity: FileIdentity, length: number, budget: ScanBudget): string | null {
  if (length === 0) return "";
  const opened = openVerified(path, identity);
  if (!opened.ok) return null;
  try {
    const buffer = Buffer.alloc(length);
    const n = readSync(opened.value, buffer, 0, length, 0);
    budget.chargeBytes(n);
    return n === length ? createHash("sha256").update(buffer).digest("hex").slice(0, 32) : null;
  } finally { closeSync(opened.value); }
}

const baselineFrom = (size: number) => Math.max(0, size - HEALTH_LIMITS.baselineTailBytes);

/** Reads one producer's new windows. Never throws. */
export function readProducer(producer: ProducerKey, paths: { current: string; previous: string }, prior: ProducerCursor | null, ctx: ReadContext): ProducerRead {
  const unavailable = (reason: string): ProducerRead => ({ windows: [], cursor: prior, coverage: "unavailable", discontinuity: false, changed: false, invalidLines: 0, reason });
  try {
    if (!ctx.budget.takeStat(2)) return unavailable("budget");
    const cur = checkInputFile(paths.current, ctx.inputRoot, ctx);
    const prev = checkInputFile(paths.previous, ctx.inputRoot, ctx);
    if (!cur.ok) return unavailable(cur.reason);
    if (!prev.ok) return unavailable(prev.reason);
    const current = cur.value;
    const previous = prev.value;
    if (!current && !previous) return unavailable("missing");
    const unchanged = (a: FileIdentity | null, b: FileIdentity | null) => (a === null && b === null) || sameIdentity(a, b);
    if (prior && prior.segment && unchanged(current, prior.current) && unchanged(previous, prior.previous)
      && current && sameFile(current, prior.segment) && prior.segment.offset === current.size) {
      return { windows: [], cursor: prior, coverage: "complete", discontinuity: false, changed: false, invalidLines: 0, reason: null };
    }

    let discontinuity = false;
    let partial = false;
    const plan: SegmentPlanItem[] = [];
    // The bounded baseline (first scan, missing cursor, discontinuity): the last 64 KiB of each declared segment, previous
    // first, keeping windows from the last 60 minutes. A tail that had to be cut makes coverage partial.
    const baseline = () => {
      for (const [path, file] of [[paths.previous, previous], [paths.current, current]] as const) {
        if (!file) continue;
        plan.push({ path, identity: file, from: baselineFrom(file.size), baseline: true, verifyBoundary: false });
        if (baselineFrom(file.size) > 0) partial = true;
      }
    };
    const seg = prior?.segment ?? null;
    const matches = (file: FileIdentity | null, path: string): file is FileIdentity =>
      !!file && !!seg && sameFile(file, seg) && (seg.headLen === 0 || (file.size >= seg.headLen && prefixDigest(path, file, seg.headLen, ctx.budget) === seg.head));
    if (!prior || !seg) baseline();
    else if (matches(current, paths.current)) {
      if (current.size < seg.offset) { discontinuity = true; baseline(); }
      else plan.push({ path: paths.current, identity: current, from: seg.offset, baseline: false, verifyBoundary: true });
    } else if (matches(previous, paths.previous)) {
      if (previous.size < seg.offset) { discontinuity = true; baseline(); }
      else {
        plan.push({ path: paths.previous, identity: previous, from: seg.offset, baseline: false, verifyBoundary: true });
        if (current) plan.push({ path: paths.current, identity: current, from: 0, baseline: false, verifyBoundary: false });
      }
    } else { discontinuity = true; baseline(); }

    let epoch = prior?.epoch ?? 0;
    let lastSeq = prior?.lastSeq ?? -1;
    const windows: OperationalWindow[] = [];
    let invalidLines = 0;
    let segment: { dev: number; ino: number; offset: number } | null = seg;
    let segmentFile: { path: string; identity: FileIdentity } | null = null;
    const run = (item: SegmentPlanItem): SegmentOutcome => {
      const horizon = ctx.now - HEALTH_LIMITS.baselineWindowMs;
      return readSegment(item, ctx.budget, line => {
        if (!ctx.budget.takeRecord()) return false;
        if (line === null) { invalidLines++; return true; }
        const parsed = parseWindowLine(line);
        if (!parsed.ok || parsed.value.installationId !== ctx.installationId || parsed.value.producer !== producer) { invalidLines++; return true; }
        const w = parsed.value;
        if (w.epoch < epoch) { if (!item.baseline) discontinuity = true; return true; }
        if (w.epoch === epoch && w.seq <= lastSeq) { if (!item.baseline) discontinuity = true; return true; }
        if (w.epoch > epoch) { if (epoch !== 0) discontinuity = true; epoch = w.epoch; }
        lastSeq = w.seq;
        if (item.baseline && w.endAt < horizon) return true;
        windows.push(w);
        return true;
      });
    };
    let stopped = false;
    for (let i = 0; i < plan.length; i++) {
      const item = plan[i]!;
      const out = run(item);
      if (out.rewritten) {
        // The byte before our offset is no longer a line end: the segment was rewritten in place. Take the baseline of
        // both segments instead ((epoch, seq) drops anything already counted).
        discontinuity = true;
        plan.splice(i + 1);
        const redo = [[paths.previous, previous], [paths.current, current]] as const;
        for (const [path, file] of redo) {
          if (!file) continue;
          const item: SegmentPlanItem = { path, identity: file, from: baselineFrom(file.size), baseline: true, verifyBoundary: false };
          if (item.from > 0) partial = true;
          const again = run(item);
          segment = { dev: file.dev, ino: file.ino, offset: again.offset };
          segmentFile = { path, identity: file };
          if (again.stopped) { stopped = true; break; }
        }
        break;
      }
      segment = { dev: item.identity.dev, ino: item.identity.ino, offset: out.offset };
      segmentFile = { path: item.path, identity: item.identity };
      if (out.stopped) { stopped = true; break; }
    }
    // Only a previous segment exists (no current yet): nothing new was readable in order, so say so.
    if (plan.length === 0) partial = true;
    windows.sort((a, b) => a.epoch - b.epoch || a.seq - b.seq);
    let position: SegmentPos | null = seg;
    if (segment && segmentFile) {
      if (seg && sameFile(segment, seg) && seg.headLen === HEAD_BYTES) position = { ...segment, head: seg.head, headLen: seg.headLen };
      else {
        const headLen = Math.min(HEAD_BYTES, segment.offset);
        const head = prefixDigest(segmentFile.path, segmentFile.identity, headLen, ctx.budget);
        position = head === null ? { ...segment, head: "", headLen: 0 } : { ...segment, head, headLen };
      }
    }
    const coverage: Coverage = stopped || discontinuity || partial || invalidLines > 0 ? "partial" : "complete";
    return {
      windows,
      cursor: { epoch, lastSeq, segment: position, current, previous, bucket: 0 },
      coverage, discontinuity, changed: true, invalidLines, reason: stopped ? (ctx.budget.stopReason ?? "read") : null,
    };
  } catch {
    return unavailable("error");
  }
}

// ---------------------------------------------------------------------------
// Backup status manifest
// ---------------------------------------------------------------------------

export interface CachedBackup { identity: FileIdentity; status: BackupStatus }
export interface BackupRead { status: BackupStatus | null; coverage: Coverage; cache: CachedBackup | null; changed: boolean; reason: string | null }

const coverageOf = (value: CoverageValue): Coverage => (value === "complete" || value === "partial" || value === "not-applicable" ? value : "unavailable");

function parseJson(buffer: Buffer): unknown {
  try { return JSON.parse(buffer.toString("utf8")); } catch { return undefined; }
}

/** Reads health/backup-status.json, reusing the cached value when the file identity is unchanged. */
export function readBackupStatus(path: string, cached: CachedBackup | null, ctx: ReadContext): BackupRead {
  const none = (reason: string): BackupRead => ({ status: null, coverage: "unavailable", cache: null, changed: cached !== null, reason });
  try {
    if (!ctx.budget.takeStat() || !ctx.budget.takeFile()) return { status: cached?.status ?? null, coverage: cached ? "partial" : "unavailable", cache: cached, changed: false, reason: "budget" };
    const checked = checkInputFile(path, ctx.inputRoot, ctx);
    if (!checked.ok) return none(checked.reason);
    if (!checked.value) return none("missing");
    if (cached && sameIdentity(cached.identity, checked.value)) return { status: cached.status, coverage: coverageOf(cached.status.coverage), cache: cached, changed: false, reason: null };
    if (checked.value.size > Math.min(BACKUP_STATUS_MAX_BYTES, ctx.budget.bytesLeft)) return none("too-large");
    const bytes = readSmallVerified(path, checked.value, BACKUP_STATUS_MAX_BYTES);
    if (!bytes.ok) return none(bytes.reason);
    ctx.budget.chargeBytes(bytes.value.length);
    const parsed = parseBackupStatus(parseJson(bytes.value));
    if (!parsed.ok) return none("invalid");
    if (parsed.value.installationId !== ctx.installationId) return none("installation");
    return { status: parsed.value, coverage: coverageOf(parsed.value.coverage), cache: { identity: checked.value, status: parsed.value }, changed: true, reason: null };
  } catch { return none("error"); }
}

// ---------------------------------------------------------------------------
// Sealed database statistics
// ---------------------------------------------------------------------------

export interface CachedDbStats { manifest: FileIdentity; generation: FileIdentity; snapshot: DbStatsSnapshot }
export interface DbStatsRead { snapshot: DbStatsSnapshot | null; coverage: Coverage; cache: CachedDbStats | null; changed: boolean; reason: string | null }

/** `file:` URI for an absolute path: every byte outside the unreserved set and "/" is percent-encoded (UTF-8), Windows
 * drive paths become `file:/C:/...`, then `?mode=ro&immutable=1`. */
export function sealedUri(path: string, platform: NodeJS.Platform = process.platform): string {
  let p = path;
  if (platform === "win32") { p = p.replace(/\\/g, "/"); if (/^[A-Za-z]:\//.test(p)) p = `/${p}`; }
  if (!p.startsWith("/") || p.startsWith("//")) throw new Error("SENTINEL_URI_PATH");
  let out = "";
  for (const byte of Buffer.from(p, "utf8")) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-._~/]/.test(ch) || (platform === "win32" && ch === ":" && out.length === 2) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return `file:${out}?mode=ro&immutable=1`;
}

const SIDECARS = ["-wal", "-shm", "-journal"];
const ALLOWED_TABLES = new Set(Object.keys(DB_STATS_TABLES));

/** Fixed queries over one sealed generation. Answers its rows or a refusal reason. Always closes the handle. */
export function querySealedStats(path: string, expect: { installationId: string; generation: number }, budget: ScanBudget, platform: NodeJS.Platform = process.platform): { ok: true; rows: DbStatsRow[]; coverage: CoverageValue } | { ok: false; reason: string } {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(sealedUri(path, platform), { open: true, readOnly: true, timeout: 0, allowExtension: false, enableForeignKeyConstraints: false });
  } catch { return { ok: false, reason: "open" }; }
  const query = <T>(run: () => T): T => { if (!budget.takeQuery()) throw new Error("budget"); return run(); };
  try {
    query(() => db.exec("PRAGMA query_only=1"));
    query(() => db.exec("PRAGMA trusted_schema=0"));
    const master = query(() => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master LIMIT 17").all()) as Array<{ type: unknown; name: unknown; tbl_name: unknown; sql: unknown }>;
    if (!budget.takeRows(master.length) || master.length > 16) return { ok: false, reason: "schema" };
    const tables = new Set<string>();
    for (const row of master) {
      const name = String(row.name);
      if (row.type === "table") {
        if (!ALLOWED_TABLES.has(name) || /^\s*CREATE\s+VIRTUAL/i.test(String(row.sql ?? ""))) return { ok: false, reason: "schema" };
        tables.add(name);
      } else if (row.type === "index") {
        if (!name.startsWith("sqlite_autoindex_") || !ALLOWED_TABLES.has(String(row.tbl_name))) return { ok: false, reason: "schema" };
      } else return { ok: false, reason: "schema" }; // views, triggers, anything else
    }
    if (tables.size !== ALLOWED_TABLES.size) return { ok: false, reason: "schema" };
    const snapshot = query(() => db.prepare(`SELECT ${DB_STATS_TABLES.snapshot.join(", ")} FROM snapshot LIMIT 2`).all()) as Array<Record<string, unknown>>;
    if (!budget.takeRows(snapshot.length) || snapshot.length !== 1) return { ok: false, reason: "snapshot" };
    const snap = snapshot[0]!;
    if (snap.version !== DB_STATS_SCHEMA_VERSION || snap.installation_id !== expect.installationId || snap.generation !== expect.generation) return { ok: false, reason: "snapshot" };
    const limit = HEALTH_LIMITS.dbStatsRoles;
    const raw = query(() => db.prepare(`SELECT ${DB_STATS_TABLES.db_stats.join(", ")} FROM db_stats LIMIT ${limit + 1}`).all()) as Array<Record<string, unknown>>;
    if (!budget.takeRows(raw.length) || raw.length > limit) return { ok: false, reason: "rows" };
    const rows: DbStatsRow[] = [];
    for (const row of raw) {
      const parsed = parseDbStatsRow({ ...row });
      if (!parsed.ok) return { ok: false, reason: "row" };
      rows.push(parsed.value);
    }
    const coverage = typeof snap.coverage === "string" ? (snap.coverage as CoverageValue) : "unavailable";
    return { ok: true, rows, coverage };
  } catch { return { ok: false, reason: "query" }; }
  finally { try { db.close(); } catch { /* already closed */ } }
}

/** Reads the current sealed stats generation named by health/db-stats-current.json. */
export function readDbStats(manifestPath: string, cached: CachedDbStats | null, ctx: ReadContext): DbStatsRead {
  const none = (reason: string): DbStatsRead => ({ snapshot: null, coverage: "unavailable", cache: null, changed: cached !== null, reason });
  const p = pathFor(ctx.platform);
  try {
    if (!ctx.budget.takeStat() || !ctx.budget.takeFile()) return { snapshot: cached?.snapshot ?? null, coverage: cached ? "partial" : "unavailable", cache: cached, changed: false, reason: "budget" };
    const mf = checkInputFile(manifestPath, ctx.inputRoot, ctx);
    if (!mf.ok) return none(mf.reason);
    if (!mf.value) return none("missing");
    if (cached && sameIdentity(cached.manifest, mf.value)) {
      if (!ctx.budget.takeStat()) return { snapshot: cached.snapshot, coverage: "partial", cache: cached, changed: false, reason: "budget" };
      const gen = checkInputFile(p.join(ctx.inputRoot, cached.snapshot.manifest.file), ctx.inputRoot, ctx);
      if (gen.ok && sameIdentity(gen.value, cached.generation)) return { snapshot: cached.snapshot, coverage: coverageOf(cached.snapshot.manifest.coverage), cache: cached, changed: false, reason: null };
    }
    const mbytes = readSmallVerified(manifestPath, mf.value, DB_MANIFEST_MAX_BYTES);
    if (!mbytes.ok) return none(mbytes.reason);
    ctx.budget.chargeBytes(mbytes.value.length);
    const parsed = parseDbStatsManifest(parseJson(mbytes.value));
    if (!parsed.ok) return none("manifest");
    const manifest: DbStatsManifest = parsed.value;
    if (manifest.installationId !== ctx.installationId) return none("installation");
    const file = p.join(ctx.inputRoot, manifest.file);
    if (!ctx.budget.takeStat(1 + SIDECARS.length) || !ctx.budget.takeFile()) return none("budget");
    const gen = checkInputFile(file, ctx.inputRoot, ctx);
    if (!gen.ok) return none(gen.reason);
    if (!gen.value) return none("missing-generation");
    if (gen.value.size !== manifest.bytes || gen.value.size > HEALTH_LIMITS.statsSnapshotBytes) return none("size");
    for (const suffix of SIDECARS) { try { lstatSync(file + suffix); return none("sidecar"); } catch { /* absent, as required */ } }
    if (gen.value.size > ctx.budget.bytesLeft) return none("budget");
    const bytes = readSmallVerified(file, gen.value, HEALTH_LIMITS.statsSnapshotBytes);
    if (!bytes.ok) return none(bytes.reason);
    ctx.budget.chargeBytes(bytes.value.length);
    if (createHash("sha256").update(bytes.value).digest("hex") !== manifest.sha256) return none("digest");
    const result = querySealedStats(file, { installationId: ctx.installationId, generation: manifest.generation }, ctx.budget, ctx.platform);
    if (!result.ok) return none(result.reason);
    // The generation must be the one we hashed, before and after the open, with no sidecar left behind.
    if (!ctx.budget.takeStat(1 + SIDECARS.length)) return none("budget");
    const after = checkInputFile(file, ctx.inputRoot, ctx);
    if (!after.ok || !sameIdentity(after.value, gen.value)) return none("changed");
    for (const suffix of SIDECARS) { try { lstatSync(file + suffix); return none("sidecar"); } catch { /* absent */ } }
    const snapshot: DbStatsSnapshot = { manifest, rows: result.rows };
    return { snapshot, coverage: coverageOf(manifest.coverage), cache: { manifest: mf.value, generation: gen.value, snapshot }, changed: true, reason: null };
  } catch { return none("error"); }
}
