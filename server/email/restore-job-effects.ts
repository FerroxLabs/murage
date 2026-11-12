// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The restore JOB's real effects on messages.db (Cloud 1.0.19, r3.4d J2): stage (W27), install (W3), prepare (W28, a row of W4), the carry, and the
// archive check. The marks live INSIDE the database file (table restore_job_marks), so they travel with the rename: the effective phase of a job is the
// journal overridden by the live database's marks (jobPhaseOf in exec-spec/restore/model.ts). prepareRestoredEmail is the one email preparation
// (restore.ts; the shared restore-prep core and the Cloud marker consumer call it too); it is never copied here.
import { closeSync, copyFileSync, fsyncSync, lstatSync, openSync, realpathSync, renameSync, rmSync, statSync, type BigIntStats } from "node:fs";
import { dirname, join, sep } from "node:path";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { prepareRestoredEmail } from "./restore.ts";
import { bumpWriteEpoch } from "../app-write-revision.ts";
import type { RestoreJob, RestoreJobEffects, RestoreMarks } from "./restore-job.ts";
import { RESTORE_JOB_MARKS_DDL, RESTORE_BOOT_WAIT_DDL } from "./restore-job-marks-ddl.ts";

export { RESTORE_BOOT_WAIT_DDL };
const MARKS_DDL = RESTORE_JOB_MARKS_DDL;
/** The one archive id shape (no "." or ".." segment); the owner route and the effects both use it. */
export const ARCHIVE_ID_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;
const syncDir = (path: string): void => { if (process.platform === "win32") return; const fd = openSync(dirname(path), "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };
const regular = (path: string): boolean => { try { const st = lstatSync(path); return st.isFile() && !st.isSymbolicLink(); } catch { return false; } };
const hasTable = (db: DatabaseSync, name: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

export interface SqliteEffectsOptions {
  /** The live messages.db. */
  liveDb: string;
  /** Archives already on this computer: <archivesDir>/<archiveId>/messages.db. */
  archivesDir: string;
  now?: () => number;
  openLive?: (path: string, opts?: { readOnly?: boolean; timeout?: number }) => DatabaseSync;
  statLive?: (path: string, opts: { bigint: true }) => BigIntStats;
}

function readMarks(path: string): RestoreMarks {
  const out: RestoreMarks = { swapped: null, prepared: null, blind: null };
  if (!regular(path)) return out;
  // H1: a database that cannot be opened or read is an UNREADABLE marks state, never empty marks. The job decides what that means (restore-job.ts phaseOf).
  let db: DatabaseSync;
  try { db = new DatabaseSync(path, { readOnly: true }); db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get(); } catch { throw new Error("RESTORE_MARKS_UNREADABLE"); }
  try {
    if (!hasTable(db, "restore_job_marks")) return out;
    for (const r of db.prepare("SELECT kind, job_id FROM restore_job_marks").all() as Array<{ kind: string; job_id: string }>) if (r.kind === "swapped" || r.kind === "prepared" || r.kind === "blind") out[r.kind] = r.job_id;
    return out;
  } catch { throw new Error("RESTORE_MARKS_UNREADABLE"); } finally { db.close(); }
}

/** True when the outgoing database cannot be read: the swap is then BLIND (STUB-R3-5). */
function outgoingUnreadable(path: string): boolean {
  if (!regular(path)) return true;
  try { const db = new DatabaseSync(path, { readOnly: true }); try { db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get(); return false; } finally { db.close(); } } catch { return true; }
}

/** The real isLocalArchive: only an archive already on this computer (a regular file, no link) can be restored. */
export function archiveIsLocal(archivesDir: string, archiveId: string): boolean {
  if (!ARCHIVE_ID_RE.test(archiveId)) return false; // M4: no "." or ".." segment
  const dirPath = join(archivesDir, archiveId), file = join(dirPath, "messages.db");
  try {
    // M4: the archive folder itself is a real folder (not a link), and the file really lives under the archives root.
    if (!lstatSync(dirPath).isDirectory() || lstatSync(dirPath).isSymbolicLink()) return false;
    const root = realpathSync(archivesDir);
    if (!realpathSync(file).startsWith(root + sep)) return false;
  } catch { return false; }
  return regular(file);
}

/** The real captureCarry (W23): the email rows a restore must not lose track of. An unreadable database gives an empty carry marked blind. */
export function captureEmailCarry(liveDb: string): Record<string, unknown> {
  if (outgoingUnreadable(liveDb)) return { blind: true };
  const db = new DatabaseSync(liveDb, { readOnly: true });
  try {
    const all = (t: string, cols: string): Array<Record<string, unknown>> => (hasTable(db, t) ? db.prepare(`SELECT ${cols} FROM ${t}`).all() as Array<Record<string, unknown>> : []);
    const bindings = all("email_bindings", "bot_id AS botId, inbox_id AS inboxId, email_key_ref AS keyId, op_id AS opId, state");
    return {
      blind: false, bindings, parks: all("email_parks", "bot_id AS botId, inbox_id AS inboxId, key_id AS keyId, state"),
      tombstones: all("email_tombstones", "bot_id AS botId, inbox_id AS inboxId, state"),
      removals: bindings.filter(b => b.state === "removing" || b.state === "remove_requested" || b.state === "removal_parked").map(b => b.botId),
    };
  } finally { db.close(); }
}

export function sqliteRestoreEffects(o: SqliteEffectsOptions): RestoreJobEffects {
  const staged = (j: RestoreJob): string => `${o.liveDb}.restore-${j.id}`;
  const openLive = o.openLive ?? ((p: string, opts?: { readOnly?: boolean; timeout?: number }) => new DatabaseSync(p, opts ?? {}));
  const statLive = o.statLive ?? statSync;
  return {
    liveDb: o.liveDb,
    bootWait() {
      const s0 = statLive(o.liveDb, {bigint: true});
      const db = openLive(o.liveDb, {readOnly: true, timeout: 0});
      try {
        if (!hasTable(db, "restore_boot_wait") || !hasTable(db, "restore_job_marks")) return {row: null};
        const row = db.prepare("SELECT w.*, m.job_id AS prepared FROM restore_boot_wait w LEFT JOIN restore_job_marks m ON m.kind = 'prepared' WHERE w.id = 1").get();
        const s1 = statLive(o.liveDb, {bigint: true});
        if (s0.dev !== s1.dev || s0.ino !== s1.ino) return {row: null};
        return {row: row ?? null, prepared: row?.prepared, dev: String(s1.dev), ino: String(s1.ino)};
      } finally {db.close();}
    },
    marks: () => readMarks(o.liveDb),
    staged: j => regular(staged(j)),
    /** W27: copy the archive's database, mark it swapped (and blind when the outgoing one is unreadable), publish by rename. The live home is unchanged. */
    stage(j) {
      try { if (regular(staged(j)) && readMarks(staged(j)).swapped === j.id) return { blind: readMarks(staged(j)).blind === j.id }; } catch { /* a bad staged copy is rebuilt below */ }
      if (!archiveIsLocal(o.archivesDir, j.archiveId)) throw new Error("archive_not_local");
      const blind = outgoingUnreadable(o.liveDb);
      const tmp = `${staged(j)}.tmp`;
      rmSync(tmp, { force: true });
      copyFileSync(join(o.archivesDir, j.archiveId, "messages.db"), tmp);
      const db = new DatabaseSync(tmp);
      try {
        db.exec("BEGIN IMMEDIATE");
        db.exec(MARKS_DDL);
        db.exec("DROP TABLE IF EXISTS restore_boot_wait");
        db.exec("DELETE FROM restore_job_marks"); // an archive's old marks are inert
        db.prepare("INSERT INTO restore_job_marks (kind, job_id) VALUES ('swapped', ?)").run(j.id);
        if (blind) db.prepare("INSERT INTO restore_job_marks (kind, job_id) VALUES ('blind', ?)").run(j.id);
        db.exec("COMMIT");
      } catch (e) { try { db.exec("ROLLBACK"); } catch { /* already out */ } throw e; } finally { db.close(); }
      const fd = openSync(tmp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, staged(j)); syncDir(staged(j));
      return { blind };
    },
    discard(j) { rmSync(`${staged(j)}.tmp`, { force: true }); rmSync(staged(j), { force: true }); },
    /** W3: the staged database takes the live place (the caller closed the store, so the WAL is checkpointed). Idempotent: already in place is done. */
    install(j) {
      if (!regular(staged(j))) {
        const m = readMarks(o.liveDb);
        if (m.swapped === j.id || m.prepared === j.id) return;
        throw new Error("RESTORE_STAGED_MISSING");
      }
      rmSync(`${o.liveDb}-wal`, { force: true }); rmSync(`${o.liveDb}-shm`, { force: true });
      renameSync(staged(j), o.liveDb); syncDir(o.liveDb);
    },
    /** W28, a row of W4: ONE transaction on the live database holds the email preparation and the prepared mark. Idempotent: a second preparation would re-key the parks. */
    prepare(j) {
      const db = openLive(o.liveDb);
      try {
        db.exec(MARKS_DDL);
        const row = db.prepare("SELECT job_id FROM restore_job_marks WHERE kind='prepared'").get() as { job_id: string } | undefined;
        if (row?.job_id === j.id) return;
        db.exec("BEGIN IMMEDIATE");
        try {
          prepareRestoredEmail(db, (o.now ?? Date.now)());
          bumpWriteEpoch(db); // the restored file is not the file any cached figure was counted from (same transaction as the prepared mark)
          db.prepare("INSERT OR REPLACE INTO restore_job_marks (kind, job_id) VALUES ('prepared', ?)").run(j.id);
          db.exec("COMMIT");
        } catch (e) { try { db.exec("ROLLBACK"); } catch { /* already out */ } throw e; }
      } finally { db.close(); }
    },
  };
}

export interface PublishRequest { dbPath: string; jobId: string; cause: string; elapsedMs: number; outcome: "freed" | "gave_up"; at: number; bootId: string; upMs: number }
export interface PublishHandle { result: Promise<string>; terminate(): void; exited: Promise<void> }
/** Serialized into a worker. All runtime dependencies are parameters or local literals. */
export function publishBootWaitRow(open: (path: string, opts?: { timeout?: number }) => DatabaseSync, stat: (path: string, opts: { bigint: true }) => Pick<BigIntStats, "dev" | "ino">, req: PublishRequest): string {
  const DDL = "CREATE TABLE IF NOT EXISTS restore_boot_wait (id INTEGER PRIMARY KEY CHECK (id = 1), job_id TEXT NOT NULL, cause TEXT NOT NULL, elapsed_ms INTEGER NOT NULL, outcome TEXT NOT NULL, at INTEGER NOT NULL, boot_id TEXT NOT NULL, up_ms INTEGER NOT NULL, db_dev TEXT NOT NULL, db_ino TEXT NOT NULL)";
  const NAMES: Record<number, string> = {1:"SQLITE_ERROR",4:"SQLITE_ABORT",5:"SQLITE_BUSY",6:"SQLITE_LOCKED",13:"SQLITE_FULL",19:"SQLITE_CONSTRAINT"};
  let db: DatabaseSync | undefined;
  try {
    const s0 = stat(req.dbPath, {bigint:true});
    db = open(req.dbPath, {timeout:1000});
    db.exec("BEGIN IMMEDIATE");
    const hasMarks = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='restore_job_marks'").get();
    const m = hasMarks ? db.prepare("SELECT job_id FROM restore_job_marks WHERE kind='prepared'").get() : undefined;
    if (!m || m.job_id !== req.jobId) {db.exec("ROLLBACK");return "superseded";}
    const s1 = stat(req.dbPath, {bigint:true});
    if (s0.dev !== s1.dev || s0.ino !== s1.ino) {db.exec("ROLLBACK");return "superseded";}
    db.exec(DDL);db.exec("DELETE FROM restore_boot_wait");
    db.prepare("INSERT INTO restore_boot_wait VALUES (1,?,?,?,?,?,?,?,?,?)").run(req.jobId,req.cause,req.elapsedMs,req.outcome,req.at,req.bootId,req.upMs,String(s1.dev),String(s1.ino));
    db.exec("COMMIT");return "saved";
  } catch(error) {
    try {if(db && db.isTransaction) db.exec("ROLLBACK");}catch{}
    const e = error as {errcode?:unknown} | null;
    const n = e && typeof e.errcode === "number" ? (e.errcode & 0xff) : -1;
    return "failed:" + (NAMES[n] || (n >= 0 ? "SQLITE_" + n : "OTHER"));
  } finally {try{db?.close();}catch{}}
}
export function workerPublish(req: PublishRequest): PublishHandle {
  try {
    const w = new Worker("const { DatabaseSync } = require('node:sqlite'); const { statSync } = require('node:fs'); const { parentPort, workerData } = require('node:worker_threads'); parentPort.postMessage((" + publishBootWaitRow.toString() + ")((p, o) => new DatabaseSync(p, o), statSync, workerData));", {eval:true,workerData:req});
    w.unref();
    const result = new Promise<string>(resolve => {w.once("message",resolve);w.once("error",()=>resolve("failed:exit"));w.once("exit",()=>resolve("failed:exit"));});
    const exited = new Promise<void>(resolve => {w.once("exit",()=>resolve());});
    return {result,terminate:()=>{void w.terminate();},exited};
  } catch {return {result:Promise.resolve("failed:exit"),terminate:()=>{},exited:Promise.resolve()};}
}
