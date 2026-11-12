import * as messageSearch from "./message-search-index.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copies of messages.db settle themselves (SMOOTH-FTS-MERGE R6 section 3). A deleted conversation leaves tombstones in the
// search index (messages_fts, contentless_delete=1): the postings stay in the segment until a merge rewrites it. A copy taken
// off the live file carries those segments as they are, so every copy that leaves the live file (a staged backup, a damaged
// export, the pre-prune and pre-memory copies, a restored candidate) runs `settleFtsCopy` on its own private file before it
// gets a final name: orphans out, optimize until the index proves clean, one VACUUM INTO a private sibling file renamed over the
// copy (R6.1: never an in-place VACUUM, whose MEMORY journal and temp store held about twice the copy in RAM), the proof again on
// the result, rollback-journal mode. The free disk is checked before the first write; a settle that runs out of disk anyway removes
// what it wrote (R6.2). The original is never written: a settle opens only the private copy and its own -settle file.
// The live file's own merge marker is never read here: the copy proves itself.
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { noteWrittenFile } from "./io-written.ts";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The side files SQLite can write beside a database file. */
export const SQLITE_SIDECARS = ["-journal", "-wal", "-shm"] as const;

/** Frozen upgrade slots. Only private copies and stopped offline downgrades may drop them. */
export const RETIRED_SEARCH_TABLES: readonly string[] = Object.freeze(Array.from({ length: 8 }, (_, i) => `messages_fts_retired${i ? `_${i + 1}` : ""}`));
export const RETIRED_SEARCH_OBJECTS: readonly string[] = Object.freeze(RETIRED_SEARCH_TABLES.flatMap(name => [name, ...["_data", "_idx", "_docsize", "_config"].map(suffix => name + suffix)]));

/** Caller must hold the stopped installation's exclusive lease (or have joined every writer).
 * Sidecars go first so retry after interruption cannot replay a stale WAL onto a fresh file. */
export function removeMessageSearchFiles(dataDir: string): void {
  // B1 supplies SEARCH_FILES. The fallback keeps this disjoint lifecycle commit verifiable on b4dc27ea9.
  const files = "SEARCH_FILES" in messageSearch ? messageSearch.SEARCH_FILES as readonly string[] : ["search.db", "search.db-wal", "search.db-shm"];
  for (const name of [...files.slice(1), files[0]]) rmSync(join(dataDir, name), { force: true });
}

/** Offline cleanup route for inert retired indexes. Never call on the serving connection. */
export function dropRetiredSearchTables(db: DatabaseSync): number {
  let dropped = 0;
  for (const name of RETIRED_SEARCH_TABLES) {
    if (hasTable(db, name)) { db.exec(`DROP TABLE "${name}"`); dropped++; }
    // A killed/older retirement can leave only shadows. These fixed names never come from archive SQL.
    for (const suffix of ["_data", "_idx", "_docsize", "_config"]) {
      if (hasTable(db, name + suffix)) { db.exec(`DROP TABLE "${name + suffix}"`); dropped++; }
    }
  }
  return dropped;
}

/** The settled file VACUUM INTO writes beside a copy before it is renamed over it (R6.1). Private like the copy; every sweep of a
 * copy's leftovers covers it and its side files. */
export const SETTLE_INTO_SUFFIX = "-settle";

/** `settled`: the index holds no deleted posting and no orphan (or there is no index at all). `owed`: a tombstone or an orphan
 * is still there. `unknown`: the question could not be answered (an error, or shadow tables without their virtual table);
 * it withholds exactly as `owed` does. */
export type FtsSettledState = "settled" | "owed" | "unknown";

const FTS_SHADOWS = ["messages_fts_data", "messages_fts_docsize", "messages_fts_idx", "messages_fts_config"] as const;
/** Index rows whose message is gone (a swallowed drop leaves them; the tombstone probe cannot see them, this can). */
const ORPHAN_IDS = "SELECT id FROM messages_fts_docsize d WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.rowid=d.id)";
/** FTS5 tombstone pages have ids ((segid + 65536) << 37) + ipg, all at or above 2^53. The id is never selected: node:sqlite
 * throws ERR_OUT_OF_RANGE reading one as a number. */
const TOMBSTONE_PROBE = "SELECT 1 AS x FROM messages_fts_data WHERE id >= 9007199254740992 LIMIT 1";

export class SettleCopyError extends Error {
  readonly code: string = "FTS_COPY_NOT_SETTLED";
  constructor(reason: string) { super(`FTS_COPY_NOT_SETTLED: ${reason}`); }
}

/** Free disk a settle needs before its first write: the copy's pages again (the .db plus its -wal frames, what VACUUM INTO writes at
 * most), plus headroom. One observation, not a reservation (R6.2): a disk that fills during the settle anyway makes SQLite fail, and the
 * settle then removes everything it wrote. */
export const settleNeedBytes = (copyBytes: number) => copyBytes + Math.max(64 * 1048576, Math.ceil(copyBytes * 0.1));

/** The disk is too short for the settle's second copy: nothing was written, the caller leaves its copy unpublished and tries later.
 * Its message reads as a full disk ("no space left"), so callers that already tell the owner about a full disk do so here too. */
export class SettleCopySpaceError extends SettleCopyError {
  override readonly code: string = "FTS_COPY_DISK_SPACE";
  readonly needBytes: number;
  readonly freeBytes: number;
  constructor(needBytes: number, freeBytes: number) {
    super(`no space left to settle the copy (needs ${needBytes} bytes free, ${freeBytes} free)`);
    this.needBytes = needBytes; this.freeBytes = freeBytes;
  }
}

/** Free bytes on the volume holding `path`, or null when the volume does not report a usable size (unknown, not full). */
export function freeBytesAt(path: string): number | null {
  const stats = statfsSync(dirname(path));
  const blocks = Number(stats.blocks), bavail = Number(stats.bavail), bsize = Number(stats.bsize);
  if (!Number.isFinite(blocks) || !Number.isFinite(bavail) || !Number.isFinite(bsize) || blocks <= 0 || bsize <= 0 || bavail < 0) return null;
  return bavail * bsize;
}

/** Throws SettleCopySpaceError when the volume holding `path` has less than `needBytes` free. An unreadable volume does not block. */
export function requireFreeBytes(path: string, needBytes: number): void {
  let free: number | null = null;
  try { free = settleCopyIo.freeBytes(path); } catch { free = null; }
  if (free !== null && free < needBytes) throw new SettleCopySpaceError(needBytes, free);
}

const hasTable = (db: DatabaseSync, name: string) => db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;

export function ftsSettled(db: DatabaseSync): FtsSettledState {
  try {
    if (!hasTable(db, "messages_fts")) return FTS_SHADOWS.some(name => hasTable(db, name)) ? "unknown" : "settled";
    if (db.prepare(TOMBSTONE_PROBE).get() !== undefined) return "owed";
    if (db.prepare(`${ORPHAN_IDS} LIMIT 1`).get() !== undefined) return "owed";
    return "settled";
  } catch { return "unknown"; }
}

/** The read-only preflight's question: BOTH probes (tombstone pages and orphan rows) always run, so a tombstone never hides an orphan question that
 * cannot be answered. Any throw: `unknown`; else `owed` when either finds something. */
export function ftsProbeBoth(db: DatabaseSync): FtsSettledState {
  try {
    if (!hasTable(db, "messages_fts")) return FTS_SHADOWS.some(name => hasTable(db, name)) ? "unknown" : "settled";
    const tombstones = db.prepare(TOMBSTONE_PROBE).get() !== undefined;
    const orphans = db.prepare(`${ORPHAN_IDS} LIMIT 1`).get() !== undefined;
    return tombstones || orphans ? "owed" : "settled";
  } catch { return "unknown"; }
}

/** Removes orphan rows from messages_fts (step 2). Only when messages_fts exists. */
export function deleteFtsOrphans(db: DatabaseSync): void {
  db.exec(`DELETE FROM messages_fts WHERE rowid IN (${ORPHAN_IDS})`);
}

/** Up to 3 rounds of ('optimize'), stopping at `settled`; throws when still not settled. Round 2 exists for an optimize that
 * continued an in-progress merge and left tombstones in its one output; round 3 is the no-op check. */
export function optimizeUntilSettled(db: DatabaseSync): void {
  let state: FtsSettledState = "unknown";
  for (let round = 0; round < 3 && state !== "settled"; round++) {
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('optimize')");
    state = ftsSettled(db);
  }
  if (state !== "settled") throw new SettleCopyError(`search index ${state} after 3 optimize rounds`);
}

/** Reads a one-row pragma answer and requires the exact value. */
export function expectPragma(db: DatabaseSync, sql: string, expected: string | number): void {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  const got = typeof value === "string" ? value.toLowerCase() : typeof value === "bigint" ? Number(value) : value;
  if (got !== expected) throw new SettleCopyError(`${sql} returned ${String(value)}, expected ${String(expected)}`);
}

/** Removes a copy and its three side files, and a settle's VACUUM INTO file beside it with its side files. Missing names are fine. */
export function removeCopy(path: string): void {
  for (const base of [path, `${path}${SETTLE_INTO_SUFFIX}`]) for (const suffix of ["", ...SQLITE_SIDECARS]) rmSync(`${base}${suffix}`, { force: true });
}

export const hasSidecar = (path: string) => SQLITE_SIDECARS.some(suffix => existsSync(`${path}${suffix}`));

export interface SettleCopyOptions {
  /** `PRAGMA quick_check` must answer `ok` (a damaged export's copy). */
  check: boolean;
  /** Caller-specific deletes (the staged backup's email rows), run before the one VACUUM. */
  beforeVacuum?: (db: DatabaseSync) => void;
}

/** The points of a settle a crash test stops at (a real SIGKILL in a child process); a no-op otherwise. */
export type SettleStep = "opened" | "optimized" | "vacuumed" | "renamed";
export const settleCopyIo: { step: (step: SettleStep, partial: string) => void; freeBytes: (path: string) => number | null } = { step: () => {}, freeBytes: freeBytesAt };

/** Settles a PRIVATE copy that nothing else has open. On any throw the copy and its three side files are removed and the error
 * is rethrown: an unsettled copy is never left to be published. The caller publishes (its own no-replace rule) after it. */
export function settleFtsCopy(partial: string, options: SettleCopyOptions): void {
  let db: DatabaseSync | undefined;
  const into = `${partial}${SETTLE_INTO_SUFFIX}`;
  try {
    for (const suffix of ["", ...SQLITE_SIDECARS]) rmSync(`${into}${suffix}`, { force: true }); // a killed earlier settle's file
    // R6.2: the free disk is checked before the first write (the read-write open, the journal switch that folds a -wal in, the orphan
    // delete, optimize), for the copy's pages again: the .db plus its -wal (a damaged export's raw copy has one). Short: nothing written.
    const walPath = `${partial}-wal`;
    requireFreeBytes(partial, settleNeedBytes(statSync(partial).size + (existsSync(walPath) ? statSync(walPath).size : 0)));
    db = new DatabaseSync(partial);
    // 1. every pragma read back: the journal stays in memory, temp pages too, freed pages are zeroed
    expectPragma(db, "PRAGMA journal_mode=MEMORY", "memory");
    db.exec("PRAGMA temp_store=MEMORY");
    expectPragma(db, "PRAGMA temp_store", 2);
    expectPragma(db, "PRAGMA secure_delete=ON", 1);
    if (options.check) expectPragma(db, "PRAGMA quick_check", "ok");
    settleCopyIo.step("opened", partial);
    dropRetiredSearchTables(db);
    if (hasTable(db, "search_intents")) db.exec("DELETE FROM search_intents");
    if (hasTable(db, "messages_fts")) {
      // 2. orphans out; 3. optimize until the probe proves the index clean
      deleteFtsOrphans(db);
      optimizeUntilSettled(db);
    }
    settleCopyIo.step("optimized", partial);
    // 4. caller deletes, then one VACUUM INTO always (also with no index and no email tables). R6.1: into a private sibling file
    // (made empty with mode 0600 first, so it is never readable by others); then renamed over.
    options.beforeVacuum?.(db);
    closeSync(openSync(into, "wx", 0o600));
    db.prepare("VACUUM INTO ?").run(into);
    db.close();
    db = undefined;
    noteWrittenFile("database-copy", into); // its logical size: the only count of it on win32 (io-written.ts)
    settleCopyIo.step("vacuumed", partial);
    renameSync(into, partial);
    settleCopyIo.step("renamed", partial);
    // 5. the proof again, on the result; the published file is never WAL, so a read-only open creates no side files
    db = new DatabaseSync(partial);
    const after = ftsSettled(db);
    if (after !== "settled") throw new SettleCopyError(`search index ${after} after VACUUM`);
    expectPragma(db, "PRAGMA journal_mode=DELETE", "delete");
    db.close();
    db = undefined;
    for (const suffix of SQLITE_SIDECARS) if (existsSync(`${partial}${suffix}`)) throw new SettleCopyError(`${suffix} left beside the copy`);
    if (existsSync(into)) throw new SettleCopyError(`${SETTLE_INTO_SUFFIX} left beside the copy`);
    // 6. durable before the caller publishes it (Windows FlushFileBuffers needs a writable handle)
    const fd = openSync(partial, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch (error) {
    try { db?.close(); } catch { /* already closed */ }
    try { removeCopy(partial); } catch { /* the caller's own cleanup removes the folder */ }
    throw error;
  }
}

/** The keep rule for a copy already under its final name: open read-only, probe, close; then no side file may sit beside it
 * (a read-only open of a WAL file creates them). Retired objects and queued intents require sanitization too. */
export function settledCopyKept(path: string): boolean {
  let state: FtsSettledState = "unknown";
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const needsSanitization = RETIRED_SEARCH_OBJECTS.some(name => hasTable(db, name)) ||
        (hasTable(db, "search_intents") && db.prepare("SELECT 1 FROM search_intents LIMIT 1").get() !== undefined);
      state = needsSanitization ? "owed" : ftsSettled(db);
    } finally { db.close(); }
  } catch { state = "unknown"; }
  if (hasSidecar(path)) return false;
  return state === "settled";
}

/** Scratch folders a killed earlier state snapshot, database snapshot, damaged export or archive write left in a destination's parent.
 * They can hold raw, unsettled copies of messages.db and its -wal (a state snapshot's stage holds a database snapshot's scratch inside it).
 * The offline lease serialises runs of ONE installation only: two installations can back up into the same folder, so a folder is removed
 * only when its owner is proven gone (scratchIsStale), never on its name alone. */
const STALE_SCRATCH = /^\.murage-(?:state-snapshot|database-snapshot|damaged-export|archive-write)-[A-Za-z0-9]{6}$/;
/** The owner record at the root of every scratch folder this build makes: who made it, so a later sweep can tell a live run from a dead one. */
export const SCRATCH_OWNER_FILE = ".murage-scratch-owner";
/** Folders made by this process that are still in use (claimCopyScratch); a sweep in this process never removes them. */
const liveScratch = new Set<string>();
/** An owner-less folder (made by a build before owner records, or killed between mkdtemp and the record) is removed only past this age:
 * no run of any installation lasts a day, so it cannot be live. */
export const UNOWNED_SCRATCH_STALE_MS = 24 * 60 * 60 * 1000;
export const scratchTestHooks: { host: () => string; alive: (pid: number) => boolean } = {
  host: () => hostname(),
  alive: pid => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } },
};

/** Call right after mkdtemp: writes the owner record (this process, this host) and marks the folder live for this process's sweeps.
 * A failed write is not fatal: the folder is then owner-less, which a sweep leaves alone for a day. */
export function claimCopyScratch(dir: string): void {
  liveScratch.add(resolve(dir));
  try { writeFileSync(join(dir, SCRATCH_OWNER_FILE), JSON.stringify({ pid: process.pid, host: scratchTestHooks.host(), at: Date.now() }), { flag: "wx", mode: 0o600 }); }
  catch { /* owner-less: left alone by sweeps until it is a day old */ }
}

/** True only when no run can still be using the folder: its owner process is gone (same host), or it is this process's own and no longer
 * live here, or it has no owner record and is over a day old. Anything that cannot be decided is kept. */
function scratchIsStale(path: string): boolean {
  if (liveScratch.has(resolve(path))) return false;
  let owner: { pid?: unknown; host?: unknown } | null = null;
  try { owner = JSON.parse(readFileSync(join(path, SCRATCH_OWNER_FILE), "utf8")) as { pid?: unknown; host?: unknown }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
  if (!owner) {
    try { return Date.now() - lstatSync(path).mtimeMs > UNOWNED_SCRATCH_STALE_MS; } catch { return false; }
  }
  if (typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.host !== "string") return false;
  // another machine's run (a shared folder): its liveness cannot be checked from here
  if (owner.host !== scratchTestHooks.host()) return false;
  if (owner.pid === process.pid) return true;
  return !scratchTestHooks.alive(owner.pid);
}

export function sweepStaleCopyScratch(parent: string): void {
  for (const path of liveScratch) if (!existsSync(path)) liveScratch.delete(path);
  let names: string[];
  try { names = readdirSync(parent); } catch { return; }
  for (const name of names) {
    if (!STALE_SCRATCH.test(name)) continue;
    const path = join(parent, name);
    try { if (lstatSync(path).isDirectory() && scratchIsStale(path)) rmSync(path, { recursive: true, force: true }); } catch { /* gone, or not ours to remove */ }
  }
}
