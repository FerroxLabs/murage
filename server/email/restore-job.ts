// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The restore JOB (Cloud 1.0.19, r3.4d J1 -> product, part 1: arm, capture, abort). One durable journal file, restore-job.json, says where an owner
// restore stands: armed -> captured -> (swapped -> prepared, J2) -> cleared, or aborted. It survives a crash and boot reads it.
// While the job is open (armed, captured, swapped) the "window" is open: every owner email decision and every manual backup is refused
// with restore_finishing. An unreadable journal fails closed (window open). Reference: exec-spec/restore/restore-reducer.ts at d94e6adb8
// (W25 arm, W23 carry then W26 captured, W29 aborted).
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { open as openAsync, rename as renameAsync, unlink as unlinkAsync } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { workerPublish, type PublishRequest, type PublishHandle } from "./restore-job-effects.ts";
import { writeFileAtomic } from "../atomic.ts";

export const RESTORE_FINISHING_LINE = "A restore may still be in progress. Try again later.";
export const RESTORE_FAILED_LINE = "That restore did not finish. You can try again.";
/** What the owner sees while an aborted job still stands: the failed line and the one action that clears it (O2). */
/** J5: a restore whose state cannot be read or finish. Distinct from the finishing line (which reads as progress); the owner card maps the code `stuck_or_unreadable`. */
export const RESTORE_STUCK_LINE = "Something stopped this restore from finishing. Please contact Murage support.";
export const RESTORE_ABORTED_LINE = "The last restore did not finish. The app's data has not changed. The owner can select OK in Murage on their computer, or on their phone for a Cloud home, to clear this message and try again.";

export type RestorePhase = "armed" | "captured" | "swapped" | "prepared" | "aborted";
export interface RestoreJob { version: 1; id: string; archiveId: string; source: string; phase: RestorePhase; at: number }
export type RestoreRefusal = "restore_finishing" | "archive_not_local" | "no_armed_job" | "not_abortable" | "not_swappable" | "not_preparable" | "not_clearable" | "restore_aborted" | "not_dismissable" | "backup_running";
export const RESTORE_BACKUP_LINE = "A backup is running. Try the restore again when it has finished.";
export type RestoreState = "none" | "running" | "aborted" | "unreadable";
/** The marks the live database carries (W27 swapped, W28 prepared, and blind when the outgoing database was unreadable). Each holds a job id or null. */
export interface RestoreMarks { swapped: string | null; prepared: string | null; blind: string | null }
/** What the job does to the database file. Each step is idempotent so a crash at any point is finished by running it again. */
export interface RestoreJobEffects {
  liveDb?: string;
  bootWait?(): { row: Record<string, unknown> | null; prepared?: unknown; dev?: string; ino?: string };
  marks(): RestoreMarks;
  /** W27: stage the incoming database carrying the swapped mark; the live home is unchanged. */
  stage(job: RestoreJob): { blind: boolean };
  /** True while the incoming database is staged and not yet installed: the live database is still the outgoing one (H1). */
  staged?(job: RestoreJob): boolean;
  /** W3: put the staged database in place of the live one. */
  install(job: RestoreJob): void;
  /** W28 (a row of W4): the email preparation and the prepared mark in one transaction on the live database. */
  prepare(job: RestoreJob): void;
  /** J5: an aborted job's staged incoming database (and its temp) is dead weight; remove it. Never touches the live database. Best effort, idempotent. */
  discard?(job: RestoreJob): void;
}
export type RestoreAnswer = { ok: true; job: RestoreJob; line?: string } | { ok: false; code: RestoreRefusal; line?: string };

export interface RestoreJobOptions {
  dir: string;
  now?: () => number;
  uid?: (prefix: string) => string;
  /** Only an archive already on this computer can be restored (archive_not_local otherwise). */
  isLocalArchive: (archiveId: string) => boolean;
  /** What the outgoing install carries across the swap; stamped with the job id (W23). */
  captureCarry: (jobId: string) => Record<string, unknown>;
  /** Test seam for crash cuts between the two durable writes of a step. */
  write?: typeof writeFileAtomic;
  /** The database steps (J2). Absent = no marks, and swap or prepare are refused. */
  effects?: RestoreJobEffects;
  /** Test seam for the unlink of the carry and the journal (W24, W30). */
  remove?: (path: string) => void;
  /** O2: told once each time a job is aborted (route failure or boot recovery). The ops alert hangs here; it can never break the abort. */
  onAbort?: (job: RestoreJob) => void;
  /** H3: true while a backup is running. Arm refuses then, so no backup can capture between the swap and the preparation. */
  backupBusy?: () => boolean;
  /** J4c (Cloud): the shared data-ops lock, held exclusive from arm until the job is cleared or aborted (past the swap and the prepare), so a nightly backup or a reset that
   *  starts after arm WAITS on it instead of running over the swap. acquire() false = someone holds it (arm refuses backup_running). release() is idempotent. */
  dataOpsLock?: { acquire(): boolean; release(): void };
  /** J4d: the longest the hold may stand. No restore step takes minutes (the whole owner route is one request), so a job still holding the lock after this is stuck:
   *  an armed or captured job is aborted (swap never began; abort releases the lock), anything else just lets the lock go. Either way onHoldExpired fires (restore.stuck). Default 30 min. */
  holdDeadlineMs?: number;
  onHoldExpired?: (job: RestoreJob | null) => void;
  /** J4d: boot recovery takes the data-ops lock before preparing a swapped job; if someone holds it (a backup that started in the gap) it retries up to this long (default 120 s), then reports stuck. */
  recoverLockWaitMs?: number;
  /** Test seam for the blocking wait between lock tries in boot recovery. */
  sleepSync?: (ms: number) => void;
  /** J4d2: where the boot wait writes its lines (default console.warn). The clock it measures with is the existing now option. */
  log?: (line: string) => void;
  /** J4d3 (M2): a MONOTONIC clock in ms for the running boot wait (its duration and its ceiling). Default performance.now(). The wall clock `now` is used only for the persisted
   *  record's `at`, which has to survive a reboot; it can jump, so it never decides how long a wait lasts. */
  mono?: () => number;
  /** J4d3 (M4): how the optional boot wait record is written. Default: asynchronous temp, fsync, rename (writeRecordAtomic). It is started and NOT awaited, so a stalled disk
   *  can never hold up boot recovery or the restore.stuck spool. */
  writeRecord?: (path: string, data: string) => Promise<void>;
  /** Test seam for the default record writer's rename. */
  recordOps?: RecordWriteOps;
  bootId?: () => string;
  bootTime?: () => number;
  readProc?: (path: string) => string;
  publish?: (req: PublishRequest) => PublishHandle;
  publishCapMs?: number;
  publishTrace?: (event: "reserve" | "enter" | "superseded" | "call" | "terminate" | "idle") => void;
}

/** J4d3 (M4): asynchronous atomic write for the optional boot wait record: temp file (0600, exclusive), fsync, rename, directory sync. Runs on the libuv pool, never on the boot thread. */
export interface RecordWriteOps { rename?: (from: string, to: string) => Promise<void> }
export async function writeRecordAtomic(path: string, data: string, ops: RecordWriteOps = {}): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fh: Awaited<ReturnType<typeof openAsync>> | undefined;
  try {
    fh = await openAsync(tmp, "wx", 0o600);
    await fh.writeFile(data);
    await fh.sync();
    await fh.close(); fh = undefined;
    await (ops.rename ?? renameAsync)(tmp, path);
  } catch (error) {
    try { await fh?.close(); } catch { /* cleanup */ }
    try { await unlinkAsync(tmp); } catch { /* cleanup */ }
    throw error;
  }
  try { const d = await openAsync(dirname(path), "r"); try { await d.sync(); } finally { await d.close(); } } catch { /* the file is in place; a directory sync that is not supported never undoes it */ }
}

/** J4d3: the one line the owner sees after a boot that waited for a backup. {N} is the whole seconds waited. Plain words, care not breakage (copy check: no dashes, none of the banned words). */
export const RESTORE_BOOT_WAIT_LINE = "Murage waited {N} seconds for a backup to finish before starting, so your data stays consistent.";
/** J4d3: how long the line stands if no restore finishes first. */
export const RESTORE_BOOT_WAIT_TTL_MS = 24 * 60 * 60_000;
/** J4d3 (M2): a record stamped further ahead than this is from a clock that was ahead or is now behind: it is not shown (and not deleted, so it comes back if the clock is right again). */
export const RESTORE_BOOT_WAIT_SKEW_MS = 5 * 60_000;
/** J4d3 (L5): no real wait lasts longer than this; a bigger elapsedMs is a damaged record. */
const RESTORE_BOOT_WAIT_MAX_ELAPSED_MS = 7 * 24 * 60 * 60_000;
/** J4d3: what a boot that waited leaves behind (restore-boot-wait.json, next to the job journal). Written only when a wait happened. */
export interface RestoreBootWait { cause: string; jobId: string; elapsedMs: number; outcome: "freed" | "gave_up"; at: number; bootId: string; upMs: number }
type BootWait = Pick<RestoreBootWait, "cause" | "jobId" | "elapsedMs" | "outcome">;
export function restoreBootWaitLine(w: Pick<RestoreBootWait, "elapsedMs">): string {
  const n = Math.max(1, Math.round(w.elapsedMs / 1000));
  return RESTORE_BOOT_WAIT_LINE.replace("{N} seconds", n === 1 ? "1 second" : `${n} seconds`);
}

export const RESTORE_HOLD_DEADLINE_MS = 30 * 60_000;
export const RESTORE_RECOVER_LOCK_WAIT_MS = 120_000;
const defaultSleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

const OPEN: ReadonlySet<string> = new Set(["armed", "captured", "swapped"]);

export class RestoreJobStore {
  private readonly o: RestoreJobOptions;
  constructor(options: RestoreJobOptions) { this.o = options; }
  private file(): string { return join(this.o.dir, "restore-job.json"); }
  private carryFile(): string { return join(this.o.dir, "restore-carry.json"); }
  private recordFile(): string { return join(this.o.dir, "restore-boot-wait.json"); }
  private put(path: string, value: unknown): void { (this.o.write ?? writeFileAtomic)(path, JSON.stringify(value) + "\n", { mode: 0o600, syncDir: true }); }
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private unlock(): void {
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = undefined; }
    try { this.o.dataOpsLock?.release(); } catch { /* the lock goes with the process at the latest */ }
  }
  /** J4d: the hold is bounded. Fires once, deadline after a successful acquire at arm. */
  private startHoldTimer(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    const t = setTimeout(() => this.holdExpired(), this.o.holdDeadlineMs ?? RESTORE_HOLD_DEADLINE_MS);
    t.unref?.();
    this.holdTimer = t;
  }
  private holdExpired(): void {
    this.holdTimer = undefined;
    let job: RestoreJob | null = null;
    try {
      const e = this.effective();
      if (e && e !== "unreadable") { job = e.job; if (e.phase === "armed" || e.phase === "captured") this.abort(); }
    } catch { /* fall through: the lock is released below whatever happened */ }
    this.unlock();
    try { this.o.onHoldExpired?.(job); } catch { /* best effort alert */ }
  }
  private at(): number { return (this.o.now ?? Date.now)(); }
  private mono(): number { return (this.o.mono ?? (() => performance.now()))(); }

  /** The journal as boot sees it: null when none, throws RESTORE_JOB_UNREADABLE when it is there but cannot be trusted. */
  read(): RestoreJob | null {
    let text: string;
    try {
      const st = lstatSync(this.file());
      if (!st.isFile() || st.isSymbolicLink() || st.size > 64 * 1024) throw new Error("RESTORE_JOB_UNREADABLE");
      text = readFileSync(this.file(), "utf8");
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("RESTORE_JOB_UNREADABLE"); }
    try {
      const v = JSON.parse(text) as Partial<RestoreJob>;
      if (v.version !== 1 || typeof v.id !== "string" || typeof v.archiveId !== "string" || typeof v.source !== "string" || typeof v.at !== "number"
        || !["armed", "captured", "swapped", "prepared", "aborted"].includes(v.phase as string)) throw new Error("x");
      return v as RestoreJob;
    } catch { throw new Error("RESTORE_JOB_UNREADABLE"); }
  }
  private current(): RestoreJob | null | "unreadable" { try { return this.read(); } catch { return "unreadable"; } }
  /** The EFFECTIVE phase (jobPhaseOf in the reducer): the live database's marks override the journal. Throws when the marks cannot be read. */
  private phaseOf(j: RestoreJob): RestorePhase {
    let m: RestoreMarks | undefined;
    try { m = this.o.effects?.marks(); } catch (e) {
      // H1: marks that cannot be read are NOT empty marks. The journal governs only where the live database is provably still the outgoing one: a blind carry
      // (the outgoing database was already unreadable) or an incoming database still staged. Anywhere else the state is unknown, so it throws (fail closed).
      const before = j.phase === "armed" || j.phase === "captured";
      if (!(before && (this.blindCarry() || this.o.effects?.staged?.(j) === true || (this.allowUnreadableArmed && j.phase === "armed")))) throw e;
      return j.phase;
    }
    if (m?.prepared === j.id) return "prepared";
    if (m?.swapped === j.id) return "swapped";
    return j.phase;
  }
  private allowUnreadableArmed = false;
  private blindCarry(): boolean { try { return (JSON.parse(readFileSync(this.carryFile(), "utf8")) as { blind?: unknown }).blind === true; } catch { return false; } }
  private effective(): { job: RestoreJob; phase: RestorePhase } | null | "unreadable" {
    const j = this.current();
    if (!j || j === "unreadable") return j;
    try { return { job: j, phase: this.phaseOf(j) }; } catch { return "unreadable"; }
  }
  /** True while a restore may be changing the install. Fails closed on an unreadable journal. */
  windowOpen(): boolean {
    const e = this.effective();
    return e === "unreadable" || (!!e && OPEN.has(e.phase));
  }
  /** The one line the owner sees on the home row, or null. */
  homeLine(): string | null {
    const e = this.effective();
    if (e === "unreadable") return RESTORE_STUCK_LINE;
    if (!e) return this.bootWaitLine();
    return OPEN.has(e.phase) ? RESTORE_FINISHING_LINE : e.phase === "aborted" ? RESTORE_FAILED_LINE : this.bootWaitLine();
  }

  private publishing = false;
  private ops = new Set<Promise<void>>();
  private idleWaiters: Array<() => void> = [];
  private cachedBootId = "";
  private log(line: string): void { try { (this.o.log ?? console.warn)(line); } catch {} }
  private trace(event: Parameters<NonNullable<RestoreJobOptions["publishTrace"]>>[0]): void { try { this.o.publishTrace?.(event); } catch {} }
  private proc(path: string): string { return (this.o.readProc ?? (p => readFileSync(p, "utf8")))(path); }
  private bootId(): string {
    try { if (this.o.bootId) return this.o.bootId(); return this.cachedBootId || (this.cachedBootId = this.proc("/proc/sys/kernel/random/boot_id").trim()); } catch { return ""; }
  }
  private bootTime(): number {
    try { return this.o.bootTime ? this.o.bootTime() : Math.round(Number(this.proc("/proc/uptime").trim().split(/\s+/)[0]) * 1000); } catch { return NaN; }
  }
  private scheduleRecord(wait: BootWait): void {
    const tracked = new Promise<void>(resolve => {
      setImmediate(() => {
        void Promise.resolve().then(() => {
          const data = JSON.stringify({ version: 2, ...wait, at: this.at(), bootId: this.bootId(), upMs: this.bootTime() }) + "\n";
          return (this.o.writeRecord ?? ((path, text) => writeRecordAtomic(path, text, this.o.recordOps)))(this.recordFile(), data);
        }).catch(error => this.log(`[restore-job] boot wait record not written: ${error instanceof Error ? error.message : String(error)}`)).then(resolve);
      });
    });
    this.ops.add(tracked);
    void tracked.then(() => this.ops.delete(tracked));
  }
  publishReserved(): boolean { return this.publishing; }
  async opsSettled(): Promise<void> { while (this.ops.size) await Promise.all([...this.ops]); }
  publishIdle(): Promise<void> { return this.publishing ? new Promise(resolve => this.idleWaiters.push(resolve)) : Promise.resolve(); }
  async publishSettled(): Promise<void> { await Promise.all([this.opsSettled(), this.publishIdle()]); }
  private publicationExited(): void {
    this.publishing = false; this.trace("idle");
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
  private startPublish(jobId: string, wait: BootWait): void {
    this.trace("enter");
    if (this.current() !== null) { this.trace("superseded"); this.log("[restore-job] boot wait publication: superseded"); this.publicationExited(); return; }
    let h: PublishHandle;
    try {
      const req: PublishRequest = { dbPath: this.o.effects?.liveDb ?? "", ...wait, jobId, at: this.at(), bootId: this.bootId(), upMs: this.bootTime() };
      this.trace("call"); h = (this.o.publish ?? workerPublish)(req);
    } catch { this.log("[restore-job] boot wait publication: failed:exit"); this.publicationExited(); return; }
    let logged = false;
    const report = (result: string): void => { if (result !== "saved" && !logged) { logged = true; this.log(`[restore-job] boot wait publication: ${result}`); } };
    const timer = setTimeout(() => { this.trace("terminate"); report("timed out"); try { h.terminate(); } catch {} }, this.o.publishCapMs ?? 10_000);
    timer.unref?.();
    void h.result.then(report, () => report("failed:exit"));
    const clear = (): void => { clearTimeout(timer); this.publicationExited(); };
    void h.exited.then(clear, clear);
  }
  /** Read only. The operations record is never an owner notice. */
  bootWait(): RestoreBootWait | null {
    try {
      const read = this.o.effects?.bootWait?.();
      const row = read?.row;
      if (!read || !row) return null;
      const string = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256;
      const integer = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
      if (row.id !== 1 || !string(row.job_id) || !string(row.cause) || !string(row.boot_id) || !string(row.db_dev) || !string(row.db_ino)
        || !integer(row.elapsed_ms) || row.elapsed_ms > RESTORE_BOOT_WAIT_MAX_ELAPSED_MS || !integer(row.at) || !integer(row.up_ms) || row.outcome !== "freed") return null;
      if (read.prepared == null || row.job_id !== read.prepared) return null;
      if (row.db_dev !== read.dev || row.db_ino !== read.ino) return null;
      const cur = this.bootId();
      if (cur === "" || row.boot_id !== cur) return null;
      const bootAge = this.bootTime() - row.up_ms, wallAge = this.at() - row.at;
      if (!(0 <= bootAge && bootAge < RESTORE_BOOT_WAIT_TTL_MS)) return null;
      if (!(-RESTORE_BOOT_WAIT_SKEW_MS <= wallAge && wallAge < RESTORE_BOOT_WAIT_TTL_MS)) return null;
      return {jobId: row.job_id, cause: row.cause, elapsedMs: row.elapsed_ms, outcome: "freed", at: row.at, bootId: row.boot_id, upMs: row.up_ms};
    } catch { return null; }
  }
  bootWaitLine(): string | null { const w = this.bootWait(); return w ? restoreBootWaitLine(w) : null; }

  /** W25: owner restore arms the job. Refused restore_finishing while a job is open or finished-but-not-cleared (S20), archive_not_local otherwise. */
  arm(a: { archiveId: string; source: string }): RestoreAnswer {
    const existing = this.effective();
    if (existing === "unreadable") return { ok: false, code: "restore_finishing", line: RESTORE_FINISHING_LINE };
    // O2: an aborted job that nobody cleared gets its own plain refusal (never a hang, never the busy line): the owner clears it, then arms again.
    if (existing) return existing.phase === "aborted" ? { ok: false, code: "restore_aborted", line: RESTORE_ABORTED_LINE } : { ok: false, code: "restore_finishing", line: RESTORE_FINISHING_LINE };
    if (this.publishing || this.o.backupBusy?.()) return { ok: false, code: "backup_running", line: RESTORE_BACKUP_LINE };
    if (!this.o.isLocalArchive(a.archiveId)) return { ok: false, code: "archive_not_local" };
    if (this.o.dataOpsLock && !this.o.dataOpsLock.acquire()) return { ok: false, code: "backup_running", line: RESTORE_BACKUP_LINE };
    const job: RestoreJob = { version: 1, id: (this.o.uid ?? (() => randomUUID()))("job"), archiveId: a.archiveId, source: a.source, phase: "armed", at: this.at() };
    try { this.put(this.file(), job); } catch (e) { this.unlock(); throw e; }
    if (this.o.dataOpsLock) this.startHoldTimer();
    return { ok: true, job };
  }
  /** Capture is its own step: the carry first (W23, stamped with the job id), then phase captured (W26). A crash between them leaves armed + carry; capture again finishes. */
  capture(): RestoreAnswer {
    // an armed job has swapped nothing, so a live home that cannot be read is the blind case the carry records (captureCarry gives {blind:true})
    this.allowUnreadableArmed = true;
    let e: ReturnType<RestoreJobStore["effective"]>;
    try { e = this.effective(); } finally { this.allowUnreadableArmed = false; }
    if (!e || e === "unreadable" || e.phase !== "armed") return { ok: false, code: "no_armed_job" };
    const j = e.job;
    this.put(this.carryFile(), { ...this.o.captureCarry(j.id), jobId: j.id, capturedAt: this.at() });
    const next: RestoreJob = { ...j, phase: "captured", at: this.at() };
    this.put(this.file(), next);
    return { ok: true, job: next };
  }
  /** W29: abort only from armed or captured. */
  abort(): RestoreAnswer {
    const e = this.effective();
    if (!e || e === "unreadable" || (e.phase !== "armed" && e.phase !== "captured")) return { ok: false, code: "not_abortable" };
    const j = e.job;
    const next: RestoreJob = { ...j, phase: "aborted", at: this.at() };
    this.put(this.file(), next);
    try { this.o.effects?.discard?.(next); } catch { /* clearing tries again */ }
    this.unlock();
    try { this.o.onAbort?.(next); } catch { /* the alert is best effort: the abort already stands */ }
    return { ok: true, job: next, line: RESTORE_FAILED_LINE };
  }

  // ===================== J2: swap, prepare, clear, boot recovery =====================
  private checkFile(): string { return join(this.o.dir, "restore-check.json"); }
  private rm(path: string): void {
    (this.o.remove ?? ((q: string) => { try { unlinkSync(q); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }))(path);
    if (process.platform !== "win32") { const fd = openSync(dirname(path), "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
  }
  /** W27 then W3. Only the job's own archive, only from captured (armed too when blind), only a local archive. Staging leaves the live home alone; a crash
   *  before the install leaves the job captured (window open), and swapping again finishes it. The caller has closed the store (the swap closes it). */
  swap(a: { archiveId: string; source: string; blind?: boolean }): RestoreAnswer {
    this.allowUnreadableArmed = a.blind === true;
    let e: ReturnType<RestoreJobStore["effective"]>;
    try { e = this.effective(); } finally { this.allowUnreadableArmed = false; }
    const fx = this.o.effects;
    if (!e || e === "unreadable" || !fx || e.job.archiveId !== a.archiveId || e.job.source !== a.source || !(e.phase === "captured" || (e.phase === "armed" && a.blind === true)))
      return { ok: false, code: "not_swappable" };
    if (!this.o.isLocalArchive(e.job.archiveId)) return { ok: false, code: "archive_not_local" };
    const staged = fx.stage(e.job);
    // M5: an uncaptured (armed) swap is allowed only for a genuinely blind outgoing database; the stage decides, never the caller's flag. Nothing is installed otherwise.
    if (e.phase === "armed" && !staged.blind) return { ok: false, code: "not_swappable" };
    fx.install(e.job);
    return { ok: true, job: { ...e.job, phase: "swapped" } };
  }
  /** W28: only a swapped job. A blind swap makes the owner's inventory check durable FIRST (restore-check.json), then the preparation and the prepared mark land
   *  in one transaction. A crash anywhere leaves swapped (window open); preparing again finishes it, and an already prepared database is not prepared twice. */
  prepare(): RestoreAnswer {
    const e = this.effective(), fx = this.o.effects;
    if (!e || e === "unreadable" || !fx || e.phase !== "swapped") return { ok: false, code: "not_preparable" };
    if (fx.marks().blind === e.job.id) this.put(this.checkFile(), { jobId: e.job.id, at: this.at() });
    fx.prepare(e.job);
    return { ok: true, job: { ...e.job, phase: "prepared" } };
  }
  /** W24 then W30: only a finished (prepared or aborted) job. The carry goes first, then the journal; a crash between leaves the finished job and clearing again ends it. */
  clear(): RestoreAnswer {
    const e = this.effective();
    if (!e || e === "unreadable" || (e.phase !== "prepared" && e.phase !== "aborted")) return { ok: false, code: "not_clearable" };
    if (e.phase === "aborted") { try { this.o.effects?.discard?.(e.job); } catch { /* leftover bytes only; the data dir is not blocked */ } }
    this.rm(this.carryFile());
    this.rm(this.file());
    this.unlock();
    return { ok: true, job: e.job };
  }
  /** O2: where the job stands for the owner's status line. A job the journal or marks cannot vouch for reads as unreadable (fail closed). */
  state(): RestoreState {
    const e = this.effective();
    if (e === "unreadable") return "unreadable";
    if (!e) return "none";
    return e.phase === "aborted" ? "aborted" : "running";
  }
  /** O2: the owner pressed OK on the failed line. Clears ONLY an aborted job (carry first, then the journal, as clear does); any other job is not dismissable. */
  dismiss(): RestoreAnswer {
    const e = this.effective();
    if (!e || e === "unreadable" || e.phase !== "aborted") return { ok: false, code: "not_dismissable" };
    return this.clear();
  }
  /** Boot, before the store opens. armed or captured: the swap never happened, so the job is aborted (W29, the failed line). swapped: the swap is done and its prep
   *  owed, so prepare. prepared: nothing is owed, so clear. aborted stays until cleared (the owner sees the failed line). An unreadable journal stays closed. */
  recover(): { action: "none" | "aborted" | "prepared" | "cleared" | "unreadable" | "stuck" } {
    const e = this.effective();
    if (e === "unreadable") return { action: "unreadable" };
    if (!e) return { action: "none" };
    if (e.phase === "armed" || e.phase === "captured") { this.abort(); return { action: "aborted" }; }
    if (e.phase === "swapped") {
      // J4d: on Cloud the prepare runs under the same exclusive lock the route held, so a backup or reset cannot run over it (the route's own prepare or clear failed).
      const t = this.o.dataOpsLock ? this.takeLockForRecovery() : { got: true, wait: undefined };
      if (t.wait) this.scheduleRecord(t.wait);
      if (!t.got) return { action: "stuck" };
      try { const r = this.prepare(); if (!r.ok) return { action: "stuck" }; this.clear(); } catch { return { action: "stuck" }; } finally { this.unlock(); }
      if (t.wait?.outcome === "freed" && (this.o.publish !== undefined || this.o.effects?.liveDb !== undefined)) {
        this.publishing = true; this.trace("reserve");
        const wait = t.wait;
        setImmediate(() => this.startPublish(e.job.id, wait));
      }
      return { action: "prepared" };
    }
    if (e.phase === "prepared") { this.clear(); return { action: "cleared" }; }
    return { action: "none" };
  }
  private takeLockForRecovery(): { got: boolean; wait?: BootWait } {
    // M2: the wait is measured on the MONOTONIC clock; a wall clock jump (backward or forward) can neither stretch nor cut the 120 s ceiling. (This also fixes the pre-existing
    // deadline of J4d/J4d2, which was computed from Date.now.)
    const lock = this.o.dataOpsLock!, sleep = this.o.sleepSync ?? defaultSleepSync, now = () => this.mono();
    const log = this.o.log ?? ((line: string) => console.warn(line));
    const waitMs = this.o.recoverLockWaitMs ?? RESTORE_RECOVER_LOCK_WAIT_MS;
    const t0 = now(), until = t0 + waitMs;
    // The lock is a plain flock: the holder (the nightly backup or a reset) records no job id in it, so the cause is named by what holds it, not by id.
    const cause = "a backup or other data operation holds the data-ops lock (the lock records no holder job id)";
    const e = this.effective();
    const job = e && e !== "unreadable" ? ` for restore job ${e.job.id}` : "";
    let tries = 0, announced = false;
    for (;;) {
      let got = false;
      try { got = lock.acquire(); } catch { /* treat as held */ }
      const elapsed = Math.round(now() - t0);
      if (got) { if (announced) { log(`[restore-job] boot recovery${job}: lock available after ${elapsed} ms, going on`); return {got: true, wait: { cause, jobId: e && e !== "unreadable" ? e.job.id : "", elapsedMs: elapsed, outcome: "freed" }}; } return {got: true}; }
      if (!announced) { announced = true; log(`[restore-job] boot recovery${job}: finishing a backup before starting; waiting up to ${waitMs} ms, ${cause}`); }
      else if (tries % 40 === 0) log(`[restore-job] boot recovery${job}: still waiting, ${elapsed} ms of ${waitMs} ms, retry ${tries}`);
      if (now() >= until) { log(`[restore-job] boot recovery${job}: gave up after ${elapsed} ms, ${cause}; restore.stuck follows`); return {got: false, wait: { cause, jobId: e && e !== "unreadable" ? e.job.id : "", elapsedMs: elapsed, outcome: "gave_up" }}; }
      tries++;
      sleep(250);
    }
  }
  /** Is the owner's inventory check pending (a blind restore finished)? Only once the window is closed. */
  checkPending(): boolean { try { return !this.windowOpen() && lstatSync(this.checkFile()).isFile(); } catch { return false; } }
  /** The owner confirmed the inventory: the durable check is removed. False when there was none. */
  confirmCheck(): boolean { if (!this.checkPending()) return false; this.rm(this.checkFile()); return true; }
}

/** Read-only window check for the hot paths (owner routes, backup): no archive or carry source needed. */
export function restoreWindowOpen(dir: string): boolean {
  return new RestoreJobStore({ dir, isLocalArchive: () => false, captureCarry: () => ({}) }).windowOpen();
}

/** J4d3 (M4): boot recovery as index.ts runs it. restore.stuck is spooled the moment recover() returns stuck or unreadable (or throws), and nothing optional (the boot wait record) is
 *  awaited first: that write is asynchronous and bounded, so a stalled disk cannot keep the alert from going out. */
export function runRestoreBootRecovery(jobs: Pick<RestoreJobStore, "recover">, spoolStuck: () => void, warn: (...args: unknown[]) => void = console.warn): { stuck: boolean } {
  let stuck = false;
  try { const r = jobs.recover(); stuck = r.action === "unreadable" || r.action === "stuck"; }
  catch (error) { stuck = true; warn("[restore-job] boot recovery:", error instanceof Error ? error.message : String(error)); }
  if (stuck) spoolStuck();
  return { stuck };
}
