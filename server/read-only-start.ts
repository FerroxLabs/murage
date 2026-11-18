// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Boot tolerance (docs/designs/boot-tolerance/ACCEPTANCE.md): a start on a nearly full disk opens READ-ONLY instead of dying. The mode is decided once
// per process from statfs of the data dir (or its nearest existing ancestor; nothing is created), and a low-disk failure inside a boot step turns a normal
// start read-only. Nothing turns it back: writes return only through a fresh start, which runs every recovery in its own window.
import { closeSync, existsSync, fsyncSync, openSync, statfsSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DiskFloorRefusal, isLowDisk } from "./db-busy.ts";
import { readOnly, setReadOnly, type ReadOnlyState } from "./read-only-state.ts";
export { isReadOnly } from "./read-only-state.ts";

/** The worker's runtime floor: below it every guarded write is refused. The worker program (wal-maintenance.ts, owned by scperf-p1) carries the
 * same 64 MiB as a literal, because its source text is evaluated on its own; read-only-start.test.ts pins the two together. */
export const FLOOR_BYTES = 64 * 1024 * 1024;
/** A start below this opens read-only: twice the runtime floor, so a start that passes it is not refused by the floor at once. */
export const START_FLOOR_BYTES = 2 * FLOOR_BYTES;

export type StartMode = "normal" | "read-only";
export interface StartDecision { mode: StartMode; freeBytes: number; statPath: string }
export type { ReadOnlyState } from "./read-only-state.ts";

/** The nearest directory that exists, from `dir` up. */
function nearestExisting(dir: string): string {
  let at = dir;
  while (!existsSync(at)) { const up = dirname(at); if (up === at) break; at = up; }
  return at;
}
/** One statfs reading of `dir`'s volume. An unreadable volume counts as no free space. */
export function decideStartMode(dir: string): StartDecision {
  const statPath = nearestExisting(dir);
  let freeBytes = 0;
  try { const disk = statfsSync(statPath); freeBytes = disk.bavail * disk.bsize; } catch { freeBytes = 0; }
  return { mode: freeBytes < START_FLOOR_BYTES ? "read-only" : "normal", freeBytes, statPath };
}

/** A start at almost no free space (R0b, 0 bytes) still needs room to hold the data-dir lock and to open the database in WAL mode (its -shm file).
 * A normal start keeps this much written beside the data dir (not inside it, so snapshots and backups do not carry it); a read-only start that finds
 * less than this free gives it back before it takes the lock. Space the owner frees later is theirs; the next normal start writes the reserve again. */
export const RESERVE_BYTES = 4 * 1024 * 1024;
export function reservePath(dataDir: string): string { return join(dirname(dataDir), `.${basename(dataDir)}-low-disk-reserve`); }
/** Normal start only: keep the reserve written when there is room for it above the start floor. Never fails the start. */
export function ensureReserve(dataDir: string): void {
  const file = reservePath(dataDir);
  if (existsSync(file) || freeBytesAt(dataDir) < START_FLOOR_BYTES + RESERVE_BYTES) return;
  let fd: number | undefined;
  try {
    fd = openSync(file, "wx", 0o600);
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    for (let written = 0; written < RESERVE_BYTES; written += chunk.length) writeSync(fd, chunk);
    fsyncSync(fd);
  } catch { try { unlinkSync(file); } catch { /* no reserve is the old behavior */ } }
  finally { if (fd !== undefined) closeSync(fd); }
}
function freeBytesAt(dir: string): number { return decideStartMode(dir).freeBytes; }
function releaseReserve(dataDir: string, freeBytes: number): void {
  if (freeBytes >= RESERVE_BYTES) return;
  try { unlinkSync(reservePath(dataDir)); console.warn("[startup] low disk reserve released so the lock and the database can open"); } catch { /* none to release */ }
}

/** Every boot step by name: the one list (design I4). A step is a recovery or start-up writer that a read-only start does not run and names in
 * `skippedAtStart`. server/boot-steps-declared.test.ts reads the source: a `bootStep`/`bootStepAsync`/`bootCaught`/`lowDiskStep` call whose name is
 * not here fails it, and so does a name here that no call uses (a guard that was removed). "routines.start" is the scheduler, named at its own line. */
export const BOOT_STEPS = [
  "restore-marker", "store.seedIfEmpty", "tts.replyState", "memory.openTurnsBoot", "memory.freshStartRecover", "folderTrust.seed", "folderTrust.rebase",
  "attachments.rebasePaths", "artifacts.rebaseSourceRoots", "browser.recoverClosedEntries", "browser.abandonedChecks", "browser.activityPrune",
  "browser.clearCommittedProfile", "conversations.deletionTriage", "delegations.settleThenDrain", "groups.interruptedGoals", "routines.watchRunSync", "routines.commitBaseline", "routines.restartRecovery",
  "projects.linkLegacyRuns", "projects.migrateChannel", "projects.prune", "projects.reconcileRecords", "sends.importLegacyQueue", "sends.recoverOwner",
  "sends.purge", "sends.recover", "venue.recoverPosts", "task.heldContinuations", "teams.finishSharingBoot", "teams.tidyImported",
  "teams.reconcileIdentities", "channels.slack.resume", "channels.discord.resume", "channels.whatsapp.resume", "channels.signal.start", "approvals.staleCardPage", "decisions.recover", "flux.memoryForget", "rooms.boot", "writer.ownWriteHolds", "routines.start",
] as const;
export type BootStepName = typeof BOOT_STEPS[number];

let decided: StartDecision | undefined;

/** The data dir the mode was decided for: the root the file gate below protects. */
let dataRoot: string | undefined;
/** Write authority (design I1): what must happen the moment the process is read-only, whoever made it so (the start check or a boot step). The database
 * registers its connection here, so the engine itself refuses a write no caller guarded. A hook registered after the switch runs at once. */
const readOnlyHooks: Array<() => void> = [];
export function onReadOnly(hook: () => void): void { readOnlyHooks.push(hook); if (readOnly) hook(); }
function becameReadOnly(): void { for (const hook of readOnlyHooks) hook(); }
/** The file half of the write authority: in a read-only process no file inside the data dir is written through the atomic writer (server/atomic.ts calls
 * this first, before it creates its temp file). A path outside the data dir is not this gate's. With no decided data dir (the mode was entered without
 * a start check) every path is refused: the gate does not guess. */
export function assertFileWriteAdmission(path: string): void {
  if (!readOnly) return;
  if (dataRoot !== undefined) {
    const root = resolve(dataRoot), target = resolve(path);
    if (target !== root && !target.startsWith(root + sep)) return;
  }
  throw new DiskFloorRefusal("read-only-start");
}
/** Step names that did not run in this process because it was read-only. */
export const skippedAtStart: string[] = [];

/** The process's start mode: decided on the first call (the explicit call at the top of index.ts), then fixed. */
export function startMode(dataDir: string): StartMode {
  if (!decided) {
    decided = decideStartMode(dataDir);
    dataRoot = dataDir;
    if (decided.mode === "read-only") {
      setReadOnly({ since: Date.now(), reason: "start-check", freeBytes: decided.freeBytes, needBytes: START_FLOOR_BYTES - decided.freeBytes });
      console.warn(`[startup] read-only start: free=${decided.freeBytes} below ${START_FLOOR_BYTES} at ${decided.statPath}`);
      releaseReserve(dataDir, decided.freeBytes);
      becameReadOnly();
    }
  }
  return readOnly ? "read-only" : decided.mode;
}
export function readOnlyState(): ReadOnlyState | undefined { return readOnly; }
/** A read-only start runs no schema statement between its open and listen (A2): an idempotent initializer whose `table` is already in the file is
 * not run. One whose table is missing (a file last opened by a build before that table) changes nothing either (MAIN 2026-11-17 Q4): the table READS
 * AS EMPTY. `init` runs on a scratch in-memory database only, to learn the shape; each table it makes that this file lacks is made on this connection
 * as an empty TEMP table (the connection's own temporary schema, never the data file), so a read finds no rows and a write is still refused. The
 * connection is closed to writes again whatever happened. The next normal start runs `init` on the file and creates the table. A normal start just
 * runs `init`. */
/** `seed` fills rows a reader needs on the table it made (in RAM or as a temp table), never on a table the file has. */
export function schemaStep(db: DatabaseSync, table: string, init: (db: DatabaseSync) => void, seed?: (db: DatabaseSync) => void): void {
  // A first-ever read-only start builds its empty primary store in RAM, before closing that connection to writes.
  if (readOnly === undefined || (db.prepare("PRAGMA database_list").get()?.file === "" && Number(db.prepare("PRAGMA query_only").get()?.query_only) === 0)) { init(db); seed?.(db); return; }
  const inFile = (name: string) => db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?").get(name) !== undefined;
  if (inFile(table)) return;
  const shape = new DatabaseSync(":memory:");
  try {
    // An initializer that builds on a table the file already has (a trigger's subject, an added column) finds that table's own shape on the scratch.
    for (let needed = 0; ; needed++) {
      try { init(shape); break; }
      catch (error) {
        const name = /no such table: (?:main\.)?([A-Za-z_][A-Za-z0-9_]*)/.exec(error instanceof Error ? error.message : "")?.[1];
        const sql = name && needed < 16 ? (db.prepare("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name=?").get(name) as { sql?: string } | undefined)?.sql : undefined;
        if (!sql) throw error;
        shape.exec(sql);
      }
    }
    const missing = (shape.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; sql: string }>)
      .filter(({ name }) => !inFile(name));
    const before = Number((db.prepare("PRAGMA query_only").get() as { query_only?: number } | undefined)?.query_only ?? 0);
    db.exec("PRAGMA query_only=OFF");
    try { for (const { sql } of missing) db.exec(sql.replace(/^CREATE TABLE (IF NOT EXISTS )?/i, "CREATE TEMP TABLE IF NOT EXISTS ")); if (!inFile(table)) seed?.(db); }
    finally { db.exec(`PRAGMA query_only=${before ? "ON" : "OFF"}`); }
    console.warn(`[startup] read-only start: table ${table} is not in this file; it reads as empty and the next normal start creates it`);
  } finally { shape.close(); }
}
/** What /api/health says about the disk once the start is read-only: the mode and when it began. It is sticky for the life of the process, so it does
 * not clear when space comes back (writes return only through a fresh start). */
export function diskLowStatus(): { mode: "read-only"; since: number; reason: string } | undefined {
  return readOnly ? { mode: "read-only", since: readOnly.since, reason: readOnly.reason } : undefined;
}
/** Turns this process read-only for good (a boot step met low disk). */
export function enterReadOnly(reason: string, freeBytes = 0): void {
  if (readOnly) return;
  setReadOnly({ since: Date.now(), reason, freeBytes, needBytes: Math.max(0, START_FLOOR_BYTES - freeBytes) });
  console.warn(`[startup] low disk during start at ${reason}: read-only for this run`);
  becameReadOnly();
}

/** Free bytes on the decided volume now (0 when unknown). */
function freeNow(): number { return decided ? decideStartMode(decided.statPath).freeBytes : 0; }
/** For a boot step's own catch: low disk turns the start read-only and names the step in skippedAtStart (true: handled, the step is skipped);
 * any other error is not this helper's (false: the catch keeps its own handling). */
export function lowDiskStep(name: string, error: unknown): boolean {
  if (!isLowDisk(error)) return false;
  enterReadOnly(name, freeNow());
  skippedAtStart.push(name);
  return true;
}
/** A boot recovery. Read-only: not run, named in skippedAtStart, `fallback` returned. Normal: run; a low-disk failure turns the start read-only and
 * returns `fallback`; any other failure is rethrown. */
export function bootStep<T>(name: string, run: () => T, fallback: T): T {
  if (readOnly) { skippedAtStart.push(name); return fallback; }
  try { return run(); } catch (error) {
    if (!lowDiskStep(name, error)) throw error;
    return fallback;
  }
}
/** The after-listen work (memory worker, sweeps, recoveries, prewarms): all of it writes, so a read-only start runs none of it, names every step in
 * skippedAtStart, and leaves it to the next normal start. A normal start gets the list back unchanged. */
export function afterListenSteps<T extends { name: string }>(steps: readonly T[]): readonly T[] {
  if (!readOnly) return steps;
  for (const step of steps) skippedAtStart.push(step.name);
  return [];
}
/** bootStep for an async recovery. */
export async function bootStepAsync<T>(name: string, run: () => Promise<T>, fallback: T): Promise<T> {
  if (readOnly) { skippedAtStart.push(name); return fallback; }
  try { return await run(); } catch (error) {
    if (!lowDiskStep(name, error)) throw error;
    return fallback;
  }
}

/** For a boot step's own swallowing catch: a low-disk failure it caught turns the start read-only and names the step (through bootStep, so the skip list
 * is the one place that says so). Any other failure is the caller's to log as before. */
export function bootCaught(name: string, error: unknown): void {
  try { bootStep(name, () => { throw error; }, undefined); } catch { /* not a low-disk failure: the caller's own log line stands */ }
}
