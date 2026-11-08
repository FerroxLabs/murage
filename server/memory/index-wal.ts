// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW 1.0.18 Part A, WP1: the memory index's checked write path (PARTA-BUILD-SPEC 1.2-1.10 and 4; r3.2.2 D1 option A).
// Every write to the index file goes through IndexWal.write: an attempt marker (-walattempt) first, then one IMMEDIATE txn that carries its
// own wal_check row. write() is synchronous and runs no checkpoint: it leaves the check (I5) OWED, and nothing more is admitted until
// check() has run it: the charge goes to the controller and is acked (charge-first, over IPC), then a PASSIVE checkpoint, the log header and
// the base rule. A write whose log rise is over its reserve, or a log over C, is an OVERRUN: a durable stop (-walstop first, then index_meta
// wal_over_stop) and nothing more is written until a reset. The -walstop marker is presence-only (r3.2.8 point 1): written at most once
// per episode (a present marker is never rewritten, Ma), never moved or unlinked by the open path, removed only by removeStopMarker. The only TRUNCATE is in sealAndTruncate(). A refused or unanswered charge leaves
// the check owed (the start stall): no checkpoint runs, writes stay refused, records stay pending.
// No path here closes a connection through SQLite except the permitted closes (tests, in-process downgrade, quarantine): exits leave the
// guard and the writable connection open, so the log keeps every frame.
// Write revision (R2-06): every DatabaseSync here opens memory-index.db only, never messages.db, so no app_write_revision trigger or epoch
// applies (like memory/age-index.ts).
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { checkIndex, indexDamaged, LOG_SUFFIXES, prepareIndexOpen, quarantineIndex, stopMarkerPresent } from "./index-quarantine.ts";
import { walIndexReader } from "../io-written.ts";

// ---- constants (spec 1.1; index.ts re-exports them) ----
const MiB = 1024 * 1024;
export const MEMW_W_STEP_BYTES = 4 * MiB;
export const MEMW_W_MERGE_BYTES = 12 * MiB;
export const MEMW_C_BYTES = 28 * MiB;
export const MEMW_STEP_ADMIT_BYTES = 16 * MiB;
export const MEMW_TICK_TRUNCATE_BYTES = 8 * MiB;
export const MEMW_SEAL_FRAMES = 4;
export const MEMW_HDR_RETRIES = 3;
/** How long a charge waits for its charge-ack before the attempt is given up (r3.2.2 D1). */
export const CHARGE_ACK_MS = 2_000;
export const WAL_HEADER_BYTES = 32;
const INDEX_OPEN_BUSY_MS = 5_000;

export type WalKind = "group" | "fill" | "keys" | "stage_drop" | "delete" | "merge" | "tier" | "seal" | "open" | "stop";
/** Every write kind. A stop read back from a marker or index_meta with any other kind reports "unknown" (fail closed). */
export const ALL_WAL_KINDS: ReadonlySet<string> = new Set<WalKind>(["group", "fill", "keys", "stage_drop", "delete", "merge", "tier", "seal", "open", "stop"]);
/** A stop's kind: a write kind, or "unknown" when the stop was read back without a usable kind (r3.2.8 1.2). */
export type StopKind = WalKind | "unknown";
export interface WalCheckpointResult { ok: boolean; busy: number; log: number; checkpointed: number }
export interface WalHeader { valid: boolean; id: string | null; pageSize: number }
export type OpenVerdict = { state: "writable" } | { state: "stopped"; reason: string; fileId: bigint | null; seq: number | null } | { state: "unresolved"; reason: string };
/** One charge, sent before each checkpoint attempt; `attempt` counts per helper run, so the controller debits and acks by
 * (helperRunId, fileId, attempt): a helper-only restart reuses attempt numbers on the same fileId and each is a fresh debit (r3.2.4 A2). */
export interface WalCharge { helperRunId: string; fileId: string; attempt: number; bytes: number }
/** The charge transport: resolves true only on charge-ack{attempt, granted:true}. */
export type ChargeTransport = (charge: WalCharge) => Promise<boolean>;
/** The index file set (spec 1.10, r3.2.2 D1: six suffixes). */
export const INDEX_FILE_SUFFIXES = LOG_SUFFIXES;
/** Cause counters (value-free, spec 1.14). */
export interface WalCounters { live_breach: number; open_tail: number; restart_window: number; truncate_failed: number; false_bound_stops: number; charge_refused: number }

export class WalStop extends Error {
  readonly kind: StopKind; readonly seq: number;
  constructor(kind: StopKind, seq: number, reason: string) { super(`MEMORY_INDEX_WAL_OVER:${reason}:${kind}:${seq}`); this.kind = kind; this.seq = seq; }
}
/** A write refused because a check is owed or could not be read (no next write, no TRUNCATE until check() settles it). */
export class WalUnresolved extends Error {
  readonly reason: string;
  constructor(reason: string) { super(`MEMORY_INDEX_WAL_UNRESOLVED:${reason}`); this.reason = reason; }
}

// ---- test seams (never set in production) ----
export interface WalTestHooks {
  /** Replaces process.exit on the exit paths (no close). Must throw in tests. */
  exit?: (code: number) => never;
  /** Replaces the checkpoint pragma's answer, or throws, for a given mode. */
  checkpoint?: (db: DatabaseSync, mode: "PASSIVE" | "TRUNCATE") => { busy: unknown; log: unknown; checkpointed: unknown } | undefined;
  /** Fault injection on sidecar I/O: name = "-walattempt" | "-walstop" | "-walok" | "dir", op = "write" | "fsync". */
  fault?: (name: string, op: string) => void;
  /** Called at named points ("after-commit", "after-walok", "before-truncate"); a throw there simulates a kill. */
  point?: (name: string) => void;
  /** Overrides CHARGE_ACK_MS. */
  /** Replaces this process's helper run id (a helper restart inside one test process). */
  helperRunId?: string;
  chargeAckMs?: number;
  /** Replaces the -wal header read (S20: unreadable at Lb > 32 B). */
  walHeader?: (indexPath: string) => WalHeader | null;
  /** Extra writes inside the seal's txn (8n: a seal over its 4 frames). */
  /** Replaces the -wal stat (F-STAT: an error or a non-regular file). */
  walStat?: (path: string) => { isFile(): boolean; size: number };
  sealBody?: (db: DatabaseSync) => void;
  /** Called with the stopped writer just before trigger B closes it (TB-CLOSE: a read there opens the lazy -shm reader). */
  triggerB?: (wal: IndexWalWriter) => void;
}
export const walTestHooks: WalTestHooks = {};
const modeCounts = { PASSIVE: 0, TRUNCATE: 0 };
/** Random per helper start (per process): every charge carries it. */
const HELPER_RUN_ID = randomBytes(8).toString("hex");
export function helperRunId(): string { return walTestHooks.helperRunId ?? HELPER_RUN_ID; }
/** Checkpoint attempts by mode since the last reset (8d). */
export function walCheckpointModes(reset = false): { PASSIVE: number; TRUNCATE: number } { const out = { ...modeCounts }; if (reset) { modeCounts.PASSIVE = 0; modeCounts.TRUNCATE = 0; } return out; }

function exitNow(code: number): never {
  if (walTestHooks.exit) return walTestHooks.exit(code);
  process.exit(code);
}
const fault = (name: string, op: string) => walTestHooks.fault?.(name, op);
const point = (name: string) => walTestHooks.point?.(name);

// ---- checkpoint and header ----
/** `PRAGMA wal_checkpoint(mode)` at busy 0. ok=false: the call failed or its counts are unusable (not integers 0 <= checkpointed <= log). */
export function walCheckpoint(db: DatabaseSync, mode: "PASSIVE" | "TRUNCATE", busyMs: 0): WalCheckpointResult {
  void busyMs;
  modeCounts[mode]++;
  let row: { busy?: unknown; log?: unknown; checkpointed?: unknown } | undefined;
  try {
    db.exec("PRAGMA busy_timeout=0");
    row = walTestHooks.checkpoint ? walTestHooks.checkpoint(db, mode) : db.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as typeof row;
  } catch { return { ok: false, busy: 1, log: -1, checkpointed: -1 }; }
  const busy = Number(row?.busy), log = Number(row?.log), checkpointed = Number(row?.checkpointed);
  const ok = row !== undefined && Number.isInteger(busy) && Number.isInteger(log) && Number.isInteger(checkpointed) && checkpointed >= 0 && checkpointed <= log;
  return { ok, busy: Number.isInteger(busy) ? busy : 1, log: Number.isInteger(log) ? log : -1, checkpointed: Number.isInteger(checkpointed) ? checkpointed : -1 };
}

/** SQLite's WAL checksum over `data` (pairs of 32-bit words, big-endian when `big`). */
function walChecksum(data: Buffer, big: boolean): [number, number] {
  let s0 = 0, s1 = 0;
  for (let i = 0; i + 8 <= data.length; i += 8) {
    const x0 = big ? data.readUInt32BE(i) : data.readUInt32LE(i), x1 = big ? data.readUInt32BE(i + 4) : data.readUInt32LE(i + 4);
    s0 = (s0 + x0 + s1) >>> 0; s1 = (s1 + x1 + s0) >>> 0;
  }
  return [s0, s1];
}
/** Parses a 32-byte WAL header: VALID only when magic & ~1 = 0x377F0682, version 3007000, a power-of-two page size and the header
 * checksum (bytes 24-31 over 0-23) hold. id = hex of bytes 12-23 (checkpoint sequence, salt-1, salt-2). */
export function parseWalHeader(raw: Buffer): WalHeader {
  const magic = raw.readUInt32BE(0), big = (magic & 1) === 1;
  const version = raw.readUInt32BE(4), page = raw.readUInt32BE(8), pageSize = page === 1 ? 65536 : page;
  const [c0, c1] = walChecksum(raw.subarray(0, 24), big);
  const valid = ((magic & ~1) >>> 0) === 0x377f0682 && version === 3007000 && pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0
    && c0 === raw.readUInt32BE(24) && c1 === raw.readUInt32BE(28);
  return { valid, id: valid ? raw.subarray(12, 24).toString("hex") : null, pageSize: valid ? pageSize : 0 };
}
/** Reads bytes 0-31 of `<index>-wal`. null = unreadable (missing, shorter than 32 B, or a read fault). */
export function readWalHeader(indexPath: string): WalHeader | null {
  if (walTestHooks.walHeader) return walTestHooks.walHeader(indexPath);
  let fd: number | undefined;
  try {
    fd = openSync(`${indexPath}-wal`, "r");
    const raw = Buffer.alloc(WAL_HEADER_BYTES);
    if (readSync(fd, raw, 0, WAL_HEADER_BYTES, 0) < WAL_HEADER_BYTES) return null;
    return parseWalHeader(raw);
  } catch { return null; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* read only */ } } }
}
/** Same log generation: every byte of 12-23 equal (checkpoint sequence and both salts). Null on either side is never the same. */
export function sameGeneration(idb: string | null, idAfter: string | null): boolean { return idb !== null && idAfter !== null && idb === idAfter; }
/** Lw, fail closed (r3.2.6 A1'.3): null when the -wal cannot be read (any stat error, ENOENT included: a WAL-mode connection keeps
 * the file) or is not a regular file. */
export function walSize(indexPath: string): number | null {
  try { const st = walTestHooks.walStat ? walTestHooks.walStat(`${indexPath}-wal`) : lstatSync(`${indexPath}-wal`); return st.isFile() ? st.size : null; }
  catch { return null; }
}
/** Lw for sizing and diagnostics only (charge bytes, the truncate-failed note); every decision reads walSize. */
function walLength(indexPath: string): number { return walSize(indexPath) ?? 0; }

// ---- sidecars: fixed 256-byte JSON record + crc32 + magic, written whole at offset 0 and fsynced ----
const SIDECAR_BYTES = 256, SIDECAR_MAGIC = 0x4d57534b; // "MWSK"
function fsyncDir(dir: string): void {
  if (process.platform === "win32") return; // NTFS: a directory cannot be opened for fsync; its metadata is journaled
  fault("dir", "fsync");
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function encodeSidecar(value: object): Buffer {
  const json = Buffer.from(JSON.stringify(value), "utf8");
  if (json.length > SIDECAR_BYTES - 8) throw new Error("MEMW_SIDECAR_TOO_LARGE");
  const out = Buffer.alloc(SIDECAR_BYTES, 0x20);
  json.copy(out, 0);
  out.writeUInt32LE(crc32(out.subarray(0, SIDECAR_BYTES - 8)), SIDECAR_BYTES - 8);
  out.writeUInt32LE(SIDECAR_MAGIC, SIDECAR_BYTES - 4);
  return out;
}
/** Writes a sidecar whole and fsyncs it (and its directory when `dirSync` or when the file is new). Throws on any fault. */
export function writeSidecar(indexPath: string, suffix: string, value: object, dirSync: boolean): void {
  const path = `${indexPath}${suffix}`, created = !existsSync(path), data = encodeSidecar(value);
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
  try {
    fault(suffix, "write");
    if (writeSync(fd, data, 0, data.length, 0) !== data.length) throw new Error("MEMW_SHORT_WRITE");
    fault(suffix, "fsync");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  if (dirSync || created) fsyncDir(dirname(path));
}
export type SidecarRead = { state: "absent" } | { state: "torn" } | { state: "ok"; value: Record<string, unknown> };
export function readSidecar(indexPath: string, suffix: string): SidecarRead {
  let raw: Buffer;
  try { raw = readFileSync(`${indexPath}${suffix}`); } catch (error) { return (error as { code?: unknown })?.code === "ENOENT" ? { state: "absent" } : { state: "torn" }; }
  if (raw.length < SIDECAR_BYTES || raw.readUInt32LE(SIDECAR_BYTES - 4) !== SIDECAR_MAGIC || raw.readUInt32LE(SIDECAR_BYTES - 8) !== crc32(raw.subarray(0, SIDECAR_BYTES - 8))) return { state: "torn" };
  try { return { state: "ok", value: JSON.parse(raw.subarray(0, SIDECAR_BYTES - 8).toString("utf8").trimEnd()) as Record<string, unknown> }; } catch { return { state: "torn" }; }
}
export interface AttemptMarker { fileId: string; seq: number; kind: WalKind; reserve: number; state: "in_flight" | "resolved"; checkedEnd: number }

// ---- the writer ----
export interface IndexWal {
  readonly fileId: bigint; readonly pageSize: number; readonly stopped: boolean;
  L(): number;
  admit(kind: WalKind, reserve: number): boolean;
  write<T>(kind: WalKind, reserve: number, body: (meta: (key: string, value: string) => void) => T): T;
  /** Runs the owed check (charge, ack, PASSIVE, header, base rule). Throws WalStop on OVERRUN. Leaves it owed on a refused charge. */
  check(): Promise<void>;
  /** True while a check is owed (write and admit refuse). */
  checkOwed(): boolean;
  openCheck(): Promise<OpenVerdict>;
  sealAndTruncate(): Promise<{ truncated: boolean }>;
  stop(reason: string, kind: WalKind, seq: number): never;
  prepareExit(): Promise<void>;
}
interface Check { L: number; id: string | null; log: number }
interface WalCheckRow { seq: number; Lb: number; idb: string | null; reserve: number; kind: WalKind }
type Owed = { type: "commit"; Lb: number; idb: string | null; reserve: number; kind: WalKind; seq: number; tries: number }
  | { type: "live"; kind: WalKind; reserve: number; seq: number }
  | { type: "open"; tries: number };
type StopCause = "live_breach" | "open_tail" | "restart_window" | "truncate_failed";
const STEP_KINDS: ReadonlySet<WalKind> = new Set(["group", "fill", "keys", "stage_drop", "delete", "merge"]);
const grantAll: ChargeTransport = async () => true;

interface OpenState { storedId: bigint | null; newest: WalCheckRow | null; attemptSide: SidecarRead }

export class IndexWalWriter implements IndexWal {
  readonly fileId: bigint;
  readonly pageSize: number;
  private stoppedFlag = false;
  private stopRecord: { kind: StopKind; seq: number; reason: string } | null = null;
  /** Newest committed wal_check seq. */
  seq: number;
  private last: Check = { L: WAL_HEADER_BYTES, id: null, log: 0 };
  private owedCheck: Owed | null = { type: "open", tries: 0 };
  private checkedEnd = 0;
  private fileIdStored: boolean;
  private metaReady: boolean;
  private attemptNo = 0;
  /** A commit restarted the log and SQLite's journal_size_limit truncate did not shorten the file (walLimitSize ignores the failure). */
  private truncateFailed = false;
  private running: Promise<unknown> | null = null;
  private readonly shm: ReturnType<typeof walIndexReader>;
  private readonly charge: ChargeTransport;
  readonly counters: WalCounters = { live_breach: 0, open_tail: 0, restart_window: 0, truncate_failed: 0, false_bound_stops: 0, charge_refused: 0 };
  /** Charges sent this run (attempt numbers and bytes), for reports and tests. */
  readonly sent: WalCharge[] = [];
  readonly db: DatabaseSync;
  readonly guard: DatabaseSync;
  readonly indexPath: string;
  constructor(db: DatabaseSync, guard: DatabaseSync, indexPath: string,
    init: { fileId: bigint; fileIdStored: boolean; pageSize: number; seq: number; metaReady: boolean; charge?: ChargeTransport; open: OpenState | null }) {
    this.db = db; this.guard = guard; this.indexPath = indexPath;
    this.fileId = init.fileId; this.fileIdStored = init.fileIdStored; this.pageSize = init.pageSize; this.seq = init.seq; this.metaReady = init.metaReady;
    this.charge = init.charge ?? grantAll; this.shm = walIndexReader(indexPath); this.openState = init.open;
  }
  private readonly openState: OpenState | null;
  get stopped(): boolean { return this.stoppedFlag; }
  stopInfo(): { kind: StopKind; seq: number; reason: string } | null { return this.stopRecord; }
  markStopped(kind: StopKind, seq: number, reason: string): void { this.stoppedFlag = true; this.stopRecord = { kind, seq, reason }; this.owedCheck = null; }
  get frameBytes(): number { return this.pageSize + 24; }
  /** S = 4 x Fz: the seal's room. */
  get sealRoom(): number { return MEMW_SEAL_FRAMES * this.frameBytes; }
  L(): number { return this.last.L; }
  checkOwed(): boolean { return this.owedCheck !== null; }

  admit(kind: WalKind, reserve: number): boolean {
    if (this.stoppedFlag || this.owedCheck) return false;
    if (kind === "seal" || kind === "stop") return true;
    const L = this.last.L;
    if (L + reserve + this.sealRoom > MEMW_C_BYTES) return false;
    if (STEP_KINDS.has(kind) && L > MEMW_STEP_ADMIT_BYTES) return false;
    if (kind === "tier" && L !== WAL_HEADER_BYTES) return false;
    return true;
  }

  // -- charge-first --
  /** (log_p - confirmed) x page_size from the -shm header (mxFrame - nBackfill); the full (Lw - 32)/Fz bound when it cannot be read. */
  private chargeBytes(): number {
    const h = this.shm();
    if (h && h.mxFrame >= h.nBackfill) return (h.mxFrame - h.nBackfill) * this.pageSize;
    return Math.floor(Math.max(0, walLength(this.indexPath) - WAL_HEADER_BYTES) / this.frameBytes) * this.pageSize;
  }
  /** THE charge step (one swappable call): send the charge, wait for its ack (CHARGE_ACK_MS). false: no attempt, and no retry without a
   * new charge. A charge counts where it is received, so a lost ack over-counts, never loses. */
  async chargeBeforeAttempt(bytes: number): Promise<boolean> {
    const charge: WalCharge = { helperRunId: helperRunId(), fileId: this.fileId.toString(), attempt: ++this.attemptNo, bytes };
    this.sent.push(charge);
    if (this.sent.length > 64) this.sent.shift();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), walTestHooks.chargeAckMs ?? CHARGE_ACK_MS); });
    try {
      const granted = await Promise.race([this.charge(charge).then(v => v === true, () => false), timeout]);
      if (!granted) this.counters.charge_refused++;
      return granted;
    } finally { clearTimeout(timer); }
  }
  /** Charge, ack, then the attempt. null: refused / no ack (nothing ran). */
  private async chargedCheckpoint(mode: "PASSIVE" | "TRUNCATE"): Promise<WalCheckpointResult | null> {
    if (!(await this.chargeBeforeAttempt(this.chargeBytes()))) return null;
    if (this.stoppedFlag) return null;
    return walCheckpoint(this.db, mode, 0);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.running ?? Promise.resolve();
    const next = previous.then(work, work);
    this.running = next.catch(() => undefined);
    return next;
  }

  // -- marker --
  private marker(state: "in_flight" | "resolved", kind: WalKind, reserve: number, seq: number): void {
    const value: AttemptMarker = { fileId: this.fileId.toString(), seq, kind, reserve, state, checkedEnd: this.checkedEnd };
    writeSidecar(this.indexPath, "-walattempt", value, false);
  }

  write<T>(kind: WalKind, reserve: number, body: (meta: (key: string, value: string) => void) => T): T {
    if (this.stoppedFlag) throw new WalStop(this.stopRecord?.kind ?? kind, this.stopRecord?.seq ?? this.seq, "stopped");
    if (this.owedCheck) throw new WalUnresolved(this.owedCheck.type === "open" ? "open_check_owed" : "check_owed");
    const Lb = this.last.L, idb = this.last.id, s = this.seq + 1;
    if (Lb > WAL_HEADER_BYTES && idb === null) throw new WalUnresolved("no_base_header");
    try { this.marker("in_flight", kind, reserve, s); } catch { return exitNow(1); }
    const db = this.db;
    let result: T;
    try {
      db.exec("BEGIN IMMEDIATE");
      const sync = Number(db.prepare("PRAGMA synchronous").get()?.synchronous), secure = Number(db.prepare("PRAGMA secure_delete").get()?.secure_delete);
      if (sync !== 2 || secure !== 1) throw new Error("MEMW_TXN_PRAGMAS");
      if (!this.metaReady) db.exec("CREATE TABLE IF NOT EXISTS index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID");
      const put = db.prepare("INSERT OR REPLACE INTO index_meta VALUES(?,?)");
      result = body((key, value) => { put.run(key, value); });
      const row: WalCheckRow = { seq: s, Lb, idb, reserve, kind };
      put.run("wal_check", JSON.stringify(row));
      if (kind !== "seal") {
        put.run("verified_through", String(s - 1));
        if (!this.fileIdStored) put.run("file_id", this.fileId.toString());
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* the live check reads what is left */ } }
      this.owedCheck = { type: "live", kind, reserve, seq: s };
      throw error;
    }
    this.seq = s; this.metaReady = true;
    if (kind !== "seal") this.fileIdStored = true;
    this.owedCheck = { type: "commit", Lb, idb, reserve, kind, seq: s, tries: 0 };
    point("after-commit");
    return result;
  }

  check(): Promise<void> {
    // Step 0 runs now, outside the serial queue: a check stuck behind an unanswered charge never holds a breached log.
    try { this.stepZero(); } catch (error) { return Promise.reject(error); }
    // One charged check in flight: a tick that comes while it waits for its ack ran step 0 above and shares it (no queue growth).
    if (this.inflight) return this.inflight;
    const run = this.serial(() => this.checkUnserial()), clear = () => { if (this.inflight === run) this.inflight = null; };
    this.inflight = run; run.then(clear, clear);
    return run;
  }
  private inflight: Promise<void> | null = null;

  /** r3.2.6 A1' step 0, before any charge or IPC, at every check while one is owed (refused and timed-out charges included): Lw by stat
   * (no SQLite call, no checkpoint). ONE rule: Lw > C, or Lw unreadable, is a STOP IN PLACE. Below-C breaches cannot grow while the check
   * is owed and are caught by the exact post-ack checks (commitCheck, liveCheck) or at open. */
  private stepZero(): void {
    const owed = this.owedCheck;
    if (!owed || this.stoppedFlag) return;
    const Lw = walSize(this.indexPath);
    if (Lw !== null && Lw <= MEMW_C_BYTES) return;
    this.stopInPlace(Lw === null ? "wal_unreadable" : "log_over_c", owed);
  }

  /** Stop in place (A1'.4): the fsynced -walstop (file, then directory), then markStopped and WalStop. No SQLite statement (no
   * wal_over_stop row: it would add frames past C), no checkpoint, no close, no rename. The marker binds until the reset completes. A
   * marker already there (any content, or an lstat error) is never rewritten (Ma). A sidecar failure exits without a close. */
  private stopInPlace(cause: "log_over_c" | "wal_unreadable", owed: Owed): never {
    const kind: WalKind = owed.type === "open" ? (this.openState?.newest?.kind ?? "open") : owed.kind;
    const seq = owed.type === "open" ? this.seq : owed.seq;
    if (!stopMarkerPresent(this.indexPath)) {
      try { writeSidecar(this.indexPath, "-walstop", { fileId: this.fileId.toString(), seq, kind }, true); }
      catch { return exitNow(1); }
    }
    point("after-walstop");
    this.counters.live_breach++;
    this.markStopped(kind, seq, `stop_in_place:${cause}`);
    console.error(`MEMORY_INDEX_WAL_OVER kind=${kind} seq=${seq} reason=stop_in_place cause=${cause}`);
    throw new WalStop(kind, seq, "stop_in_place");
  }


  /** I5 after a commit: charged PASSIVE, header, base rule, rise and C. */
  private async commitCheck(owed: Extract<Owed, { type: "commit" }>): Promise<void> {
    const result = await this.chargedCheckpoint("PASSIVE");
    if (result === null) return; // refused or unanswered: still owed (the stall)
    const header = readWalHeader(this.indexPath);
    if (!result.ok || result.busy !== 0 || (result.log > 0 && (!header || !header.valid))) {
      owed.tries++;
      if (owed.tries >= MEMW_HDR_RETRIES) exitNow(1);
      return;
    }
    const log = result.log, L = WAL_HEADER_BYTES + log * this.frameBytes, idAfter = log > 0 ? header!.id : null;
    const restarted = !sameGeneration(owed.idb, idAfter);
    const base = restarted ? WAL_HEADER_BYTES : owed.Lb, rise = L - base;
    this.owedCheck = null;
    this.last = { L, id: idAfter, log };
    if (restarted && walLength(this.indexPath) > L) this.truncateFailed = true;
    else if (walLength(this.indexPath) <= L) this.truncateFailed = false;
    if (rise > owed.reserve) { this.counters.live_breach++; this.stop("rise_over_reserve", owed.kind, owed.seq); }
    // Step 0 stops in place before any check once Lw > C, so this is a backstop: it too writes nothing (presence-only marker), never an index_meta frame past C.
    if (L > MEMW_C_BYTES) this.stopInPlace("log_over_c", owed);
  }

  /** The live check after a failed attempt (spec 1.6): charged PASSIVE, Lw, E. Unusable or over -> OVERRUN; else the marker is resolved. */
  private async liveCheck(owed: Extract<Owed, { type: "live" }>): Promise<void> {
    const result = await this.chargedCheckpoint("PASSIVE");
    if (result === null) return; // still owed
    if (!result.ok || result.busy !== 0) { this.counters.live_breach++; this.stop("live_check_unusable", owed.kind, owed.seq); }
    const Lw = walSize(this.indexPath), E = WAL_HEADER_BYTES + result.log * this.frameBytes;
    if (Lw === null) { this.counters.live_breach++; this.stop("live_wal_unreadable", owed.kind, owed.seq); }
    if (Lw - E > owed.reserve || Lw > MEMW_C_BYTES) {
      // A tail past E that no frame of this log explains is a stale tail (restart window or a failed truncate): accepted fail-closed, counted.
      if (Lw - E > owed.reserve && E - WAL_HEADER_BYTES <= owed.reserve) { this.counters.false_bound_stops++; this.stopFor(this.truncateFailed ? "truncate_failed" : "restart_window", "live_bound_stale_tail", owed.kind, owed.seq); }
      this.counters.live_breach++;
      this.stop("live_bound", owed.kind, owed.seq);
    }
    this.checkedEnd = Math.max(this.checkedEnd, Lw);
    try { this.marker("resolved", owed.kind, owed.reserve, owed.seq); } catch { exitNow(1); }
    const header = readWalHeader(this.indexPath);
    if (result.log > 0 && !header?.valid) { this.owedCheck = { type: "commit", Lb: E, idb: null, reserve: 0, kind: owed.kind, seq: this.seq, tries: 1 }; return; }
    this.owedCheck = null;
    this.last = { L: E, id: result.log > 0 ? header!.id : null, log: result.log };
  }

  /** Seal (an in-place wal_check update, 4 frames), its check, -walok, charge, TRUNCATE busy 0. A reset counts only for busy 0 and log 0. */
  sealAndTruncate(): Promise<{ truncated: boolean }> {
    return this.serial(async () => {
      if (this.stoppedFlag) return { truncated: false };
      if (this.owedCheck) { await this.checkUnserial(); if (this.owedCheck || this.stoppedFlag) return { truncated: false }; }
      this.write("seal", this.sealRoom, () => { walTestHooks.sealBody?.(this.db); });
      await this.checkUnserial();
      if (this.owedCheck || this.stoppedFlag) return { truncated: false };
      try { writeSidecar(this.indexPath, "-walok", { fileId: this.fileId.toString(), seq: this.seq }, true); } catch { return { truncated: false }; }
      point("after-walok");
      const result = await this.chargedCheckpoint("TRUNCATE");
      point("before-truncate-result");
      if (result === null || !result.ok || result.busy !== 0 || result.log !== 0) return { truncated: false };
      this.last = { L: WAL_HEADER_BYTES, id: null, log: 0 };
      return { truncated: true };
    });
  }
  private async checkUnserial(): Promise<void> {
    this.stepZero();
    const owed = this.owedCheck;
    if (!owed || this.stoppedFlag) return;
    if (owed.type === "open") await this.runOpen();
    else if (owed.type === "live") await this.liveCheck(owed);
    else await this.commitCheck(owed);
  }

  /** The durable stop (spec 1.7): -walstop + fsync file + dir FIRST, then index_meta wal_over_stop as the only write. Sidecar fault:
   * exit(1) with no write, no TRUNCATE and no close. A marker already there is never rewritten (Ma); index_meta is still written. */
  stop(reason: string, kind: WalKind, seq: number): never {
    if (!stopMarkerPresent(this.indexPath)) {
      try { writeSidecar(this.indexPath, "-walstop", { fileId: this.fileId.toString(), seq, kind }, true); }
      catch { return exitNow(1); }
    }
    this.markStopped(kind, seq, reason);
    try {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      this.db.exec("BEGIN IMMEDIATE");
      this.db.exec("CREATE TABLE IF NOT EXISTS index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID");
      this.db.prepare("INSERT OR REPLACE INTO index_meta VALUES('wal_over_stop',?)").run(JSON.stringify({ reason, time: Date.now(), kind, seq, fileId: this.fileId.toString() }));
      this.db.exec("COMMIT");
    } catch { if (this.db.isTransaction) { try { this.db.exec("ROLLBACK"); } catch { /* the sidecar binds */ } } }
    console.error(`MEMORY_INDEX_WAL_OVER kind=${kind} seq=${seq} reason=${reason}`);
    throw new WalStop(kind, seq, reason);
  }
  /** Stop with a counted cause. */
  stopFor(cause: StopCause, reason: string, kind: WalKind, seq: number): never { this.counters[cause]++; return this.stop(reason, kind, seq); }

  /** Best-effort seal and TRUNCATE before an exit, bounded; never a close. */
  async prepareExit(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.sealAndTruncate(), new Promise(resolve => { timer = setTimeout(resolve, 2 * (walTestHooks.chargeAckMs ?? CHARGE_ACK_MS) + 500); })]); }
    catch { /* the log keeps every frame */ }
    finally { clearTimeout(timer); }
  }

  /** S18 only (runOpenRuleForDowngrade): the charged TRUNCATE after the downgrade's own txn. */
  async chargedTruncateForDowngrade(): Promise<boolean> {
    const result = await this.chargedCheckpoint("TRUNCATE");
    return result !== null && result.ok && result.busy === 0 && result.log === 0;
  }

  /** The permitted close before quarantine/downgrade/tests (r3.2.6 A1'c): the writable connection first (it cannot take EXCLUSIVE while
   * the guard holds SHARED, so no close checkpoint), the read-only guard LAST (its checkpoint returns SQLITE_READONLY, no -wal delete). */
  closeForQuarantine(): void {
    try { this.db.close(); } finally { try { this.guard.close(); } finally { this.shm.close(); } }
  }

  // -- open rule steps 3-10 --
  openCheck(): Promise<OpenVerdict> {
    try { this.stepZero(); } catch (error) { return Promise.reject(error); }
    return this.serial(async () => {
      if (this.stoppedFlag) return this.stoppedVerdict();
      this.stepZero();
      if (this.owedCheck?.type === "open") await this.runOpen();
      if (this.stoppedFlag) return this.stoppedVerdict();
      return this.owedCheck?.type === "open" ? { state: "unresolved", reason: "open_check_owed" } as const : { state: "writable" } as const;
    });
  }
  private stoppedVerdict(): OpenVerdict { return { state: "stopped", reason: this.stopRecord?.reason ?? "stopped", fileId: this.fileIdStored ? this.fileId : null, seq: this.stopRecord?.seq ?? null }; }
  private openStop(cause: StopCause, reason: string): void {
    const newest = this.openState?.newest ?? null;
    try { this.stopFor(cause, reason, newest?.kind ?? "open", this.seq); } catch (error) { if (!(error instanceof WalStop)) throw error; }
  }
  private async runOpen(): Promise<void> {
    const owed = this.owedCheck as Extract<Owed, { type: "open" }>, state = this.openState!;
    const { storedId, newest, attemptSide } = state;
    // 3. the charged PASSIVE, header, Lw, marker.
    const cp = await this.chargedCheckpoint("PASSIVE");
    if (cp === null) return; // refused: the verdict stays unresolved, retried next tick
    const H = readWalHeader(this.indexPath);
    if (!cp.ok || cp.busy !== 0 || (cp.log > 0 && (!H || !H.valid) && newest !== null)) {
      owed.tries++;
      console.error(`MEMORY_INDEX_WAL_UNRESOLVED reason=open_check_unusable tries=${owed.tries}`);
      if (owed.tries >= MEMW_HDR_RETRIES) exitNow(1);
      return;
    }
    const log = cp.log, Lw = walLength(this.indexPath), E = WAL_HEADER_BYTES + log * this.frameBytes;
    const marker = attemptSide.state === "ok" ? attemptSide.value as unknown as AttemptMarker : null;
    this.checkedEnd = marker && typeof marker.checkedEnd === "number" ? marker.checkedEnd : 0;
    const pass = (check: Check) => { this.owedCheck = null; this.last = check; };
    const id = log > 0 && H?.valid ? H.id : null;
    // 4. the tail (r3.2.2 D2: (R) or its complement), for a file whose MEMW checks have begun (a wal_check row or an attempt marker).
    if (Lw > E && (newest !== null || attemptSide.state !== "absent")) {
      const newestSeq = newest?.seq ?? 0;
      const resolved = marker !== null && storedId !== null && String(marker.fileId) === storedId.toString() && Lw <= marker.checkedEnd
        && ((marker.state === "resolved" && marker.seq === newestSeq + 1) || (marker.state === "in_flight" && marker.seq === newestSeq));
      if (!resolved) return this.openStop("open_tail", "open_tail");
    }
    // 5. (b) no wal_check row: nothing to check.
    if (newest === null) {
      if (log > 0 && !H?.valid) { owed.tries++; if (owed.tries >= MEMW_HDR_RETRIES) exitNow(1); return; }
      return pass({ L: E, id, log });
    }
    // 6. (c) log > 0: base rule against the newest row.
    if (log > 0) {
      const base = sameGeneration(newest.idb, H!.id) ? newest.Lb : WAL_HEADER_BYTES;
      if (E - base > newest.reserve || E > MEMW_C_BYTES) return this.openStop("open_tail", "open_rise");
      return pass({ L: E, id, log });
    }
    // 7. (d) log 0, H valid: pass. H readable but invalid: stop.
    if (H && H.valid) return pass({ L: WAL_HEADER_BYTES, id: null, log: 0 });
    if (H && !H.valid) return this.openStop("open_tail", "header_invalid_log0");
    // 8. (e) log 0, H unreadable: only a -walok of the newest seal.
    const ok = readSidecar(this.indexPath, "-walok");
    if (ok.state === "ok" && storedId !== null && String(ok.value.fileId) === storedId.toString() && Number(ok.value.seq) === newest.seq && newest.kind === "seal") return pass({ L: WAL_HEADER_BYTES, id: null, log: 0 });
    return this.openStop("open_tail", "no_walok");
  }
}

// ---- the open rule, steps 0-2 (spec 1.3) ----
function dbHeaderWal(path: string): "wal" | "other" | "empty" {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const raw = Buffer.alloc(100), n = readSync(fd, raw, 0, 100, 0);
    if (n < 100 || raw.every(b => b === 0)) return "empty";
    return raw[18] === 2 && raw[19] === 2 ? "wal" : "other";
  } catch { return "empty"; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* read only */ } } }
}
function readMeta(db: DatabaseSync, key: string): string | null {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='index_meta'").get()) return null;
  const v = db.prepare("SELECT value FROM index_meta WHERE key=?").get(key)?.value;
  return v === undefined || v === null ? null : String(v);
}
function parseFileId(text: string | null): bigint | null | "bad" {
  if (text === null) return null;
  if (!/^\d{1,20}$/.test(text)) return "bad";
  const v = BigInt(text);
  return v > 0n && v < (1n << 64n) ? v : "bad";
}
function parseWalCheck(text: string | null): WalCheckRow | null | "bad" {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as WalCheckRow;
    if (!Number.isInteger(v.seq) || v.seq < 1 || !Number.isInteger(v.Lb) || !Number.isFinite(v.reserve) || (v.idb !== null && typeof v.idb !== "string")) return "bad";
    return v;
  } catch { return "bad"; }
}
const randomFileId = (): bigint => { for (;;) { const v = randomBytes(8).readBigUInt64LE(0); if (v > 0n) return v; } };
function unresolvedExit(reason: string): never {
  // 9. no write, no TRUNCATE, no close: the helper exits and the controller starts it again.
  console.error(`MEMORY_INDEX_WAL_UNRESOLVED reason=${reason}`);
  return exitNow(1);
}

export interface OpenedIndexWal { writable: DatabaseSync; guard: DatabaseSync; verdict: OpenVerdict; wal: IndexWal; rebuilt: boolean }

/** Options of the open rule. `reset`: this start carries a reset R (r3.2.8 3.2): a file stopped by index_meta wal_over_stop with no
 * marker is set aside and rebuilt (trigger B). `ignoreMarker`: the reset's fresh open after trigger A moved the main file aside: the
 * marker at its live name does not stop the fresh file (r3.2.8 3.2.3); it stays until removeStopMarker. */
export interface OpenRuleOptions { charge?: ChargeTransport; reset?: boolean; ignoreMarker?: boolean }

/** Open rule steps 0-2, synchronous: the whole set checked, connections in I3 order, pragmas, file_id, the stop. The verdict is `stopped`,
 * or `unresolved` (open_check_owed) until `await wal.openCheck()` runs steps 3-10. Any failure before the rule passes exits without
 * closing a connection (walTestHooks.exit in tests). A damaged file is closed (writable, then the guard), quarantined as a set and rebuilt. */
export function openIndexWal(indexPath: string, opts: OpenRuleOptions & { charge: ChargeTransport }): OpenedIndexWal {
  return openRule(indexPath, opts, false);
}

/** r3.2.8 1.2: the marker read is PRESENCE. Present (any content: valid, torn, zero length, unreadable, or an lstat error other than
 * ENOENT) means stopped; the body is advisory: kind when it reads "ok" and names a write kind, else "unknown"; seq when an integer, else -1. */
function readStopMarker(indexPath: string): { kind: StopKind; seq: number; fileId: string } | null {
  if (!stopMarkerPresent(indexPath)) return null;
  const side = readSidecar(indexPath, "-walstop");
  if (side.state !== "ok" || side.value === null || typeof side.value !== "object") return { kind: "unknown", seq: -1, fileId: "unknown" };
  const { kind, seq, fileId } = side.value as { kind?: unknown; seq?: unknown; fileId?: unknown };
  return { kind: typeof kind === "string" && ALL_WAL_KINDS.has(kind) ? kind as WalKind : "unknown", seq: Number.isInteger(seq) ? Number(seq) : -1,
    fileId: typeof fileId === "string" ? fileId : "unknown" };
}

function openRule(indexPath: string, opts: OpenRuleOptions, rebuilt: boolean): OpenedIndexWal {
  // 0. the whole set; a stray member without its index file is removed.
  try { prepareIndexOpen(indexPath); } catch { return exitNow(1); }
  if (existsSync(indexPath) && (!lstatSync(indexPath).isFile() || lstatSync(indexPath).isSymbolicLink())) return exitNow(1);
  const header = dbHeaderWal(indexPath);
  if (header !== "wal" && walLength(indexPath) > 0) return unresolvedExit("db_header_not_wal_with_log");
  // 1. connections per I3.
  let writable: DatabaseSync, guard: DatabaseSync;
  try {
    if (header === "wal") {
      guard = new DatabaseSync(indexPath, { readOnly: true, timeout: INDEX_OPEN_BUSY_MS });
      guard.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get();
      writable = new DatabaseSync(indexPath, { timeout: INDEX_OPEN_BUSY_MS });
    } else {
      writable = new DatabaseSync(indexPath, { timeout: INDEX_OPEN_BUSY_MS });
      if (String(writable.prepare("PRAGMA journal_mode=WAL").get()?.journal_mode) !== "wal") throw new Error("MEMW_NOT_WAL");
      guard = new DatabaseSync(indexPath, { readOnly: true, timeout: INDEX_OPEN_BUSY_MS });
      guard.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get();
      if (String(guard.prepare("PRAGMA journal_mode").get()?.journal_mode) !== "wal") throw new Error("MEMW_GUARD_NOT_WAL");
    }
  } catch { return exitNow(1); }
  try { checkIndex(writable); }
  catch (error) {
    if (!indexDamaged(error)) return exitNow(1);
    // r3.2.6 A1'c: writable first, the read-only guard last (no close checkpoint), then the whole set aside (the stop marker stays at
    // its live name), then a fresh file.
    try { writable.close(); guard.close(); quarantineIndex(indexPath); } catch { return exitNow(1); }
    return openRule(indexPath, opts, true);
  }
  try {
    writable.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA synchronous=FULL; PRAGMA journal_size_limit=0; PRAGMA cache_spill=OFF; PRAGMA wal_autocheckpoint=0;");
  } catch { return exitNow(1); }
  const pageSize = Number(writable.prepare("PRAGMA page_size").get()?.page_size);
  // 2. file_id, wal_over_stop, wal_check, -walstop.
  let fileIdText: string | null, stopText: string | null, checkText: string | null, metaReady: boolean;
  try {
    fileIdText = readMeta(writable, "file_id"); stopText = readMeta(writable, "wal_over_stop"); checkText = readMeta(writable, "wal_check");
    metaReady = Boolean(writable.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='index_meta'").get());
  } catch { return unresolvedExit("meta_unreadable"); }
  const storedId = parseFileId(fileIdText), newest = parseWalCheck(checkText);
  if (storedId === "bad") return unresolvedExit("file_id_unreadable");
  if (newest === "bad") return unresolvedExit("wal_check_unreadable");
  const fileId = storedId ?? randomFileId();
  const wal = new IndexWalWriter(writable, guard, indexPath, { fileId, fileIdStored: storedId !== null, pageSize, seq: newest?.seq ?? 0, metaReady, charge: opts.charge,
    open: { storedId, newest, attemptSide: readSidecar(indexPath, "-walattempt") } });
  const out = (verdict: OpenVerdict): OpenedIndexWal => ({ writable, guard, verdict, wal, rebuilt });
  // The marker binds whoever wrote it (r3.2.8 point 1): no identity check, no unlink, no repair. Only the reset's fresh open ignores it.
  const marker = opts.ignoreMarker ? null : readStopMarker(indexPath);
  if (stopText !== null || marker !== null) {
    if (marker === null && opts.reset && !rebuilt && !stopMarkerPresent(indexPath)) { // a marker on disk (ignoreMarker read it as absent) is never trigger B
      // Trigger B (r3.2.8 3.2.4): a reset start, stopped by index_meta with no marker. The damaged-file branch: writable first, the
      // read-only guard last (no close checkpoint), then the writer's -shm reader (closeForQuarantine: every handle on the set is closed
      // before any rename), the whole set aside, a fresh file (which then records the reset).
      walTestHooks.triggerB?.(wal);
      try { wal.closeForQuarantine(); quarantineIndex(indexPath); } catch { return exitNow(1); }
      return openRule(indexPath, opts, true);
    }
    let kind: StopKind = "unknown", seq = -1;
    if (marker !== null) ({ kind, seq } = marker);
    else {
      try {
        const v = JSON.parse(stopText!) as { kind?: unknown; seq?: unknown };
        if (typeof v.kind === "string" && ALL_WAL_KINDS.has(v.kind)) kind = v.kind as WalKind;
        if (Number.isInteger(v.seq)) seq = Number(v.seq);
      } catch { /* unreadable: stopped, kind "unknown" */ }
    }
    wal.markStopped(kind, seq, "stopped");
    return out({ state: "stopped", reason: "stopped", fileId: storedId, seq });
  }
  return out({ state: "unresolved", reason: "open_check_owed" });
}

/** S18: the open rule before a downgrade. Stopped: nothing written. Pass: wal_check/verified_through deleted in their own txn, then the
 * TRUNCATE, then the permitted in-process close (writable first, then the guard and the -shm reader), then -walok and -walattempt unlinked. A pass never has a stop marker
 * (a present marker is a stopped verdict), and the downgrade never removes one. */
export async function runOpenRuleForDowngrade(indexPath: string, opts: { charge?: ChargeTransport } = {}): Promise<OpenVerdict> {
  // The downgrade runs with the app stopped: no controller budget to charge, so the charge is granted locally unless a transport is given.
  const opened = openIndexWal(indexPath, { charge: opts.charge ?? grantAll }), wal = opened.wal as IndexWalWriter;
  const verdict = opened.verdict.state === "stopped" ? opened.verdict : await wal.openCheck();
  if (verdict.state !== "writable") { wal.closeForQuarantine(); return verdict; }
  const db = opened.writable;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='index_meta'").get()) db.exec("DELETE FROM index_meta WHERE key IN ('wal_check','verified_through')");
    db.exec("COMMIT");
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); wal.closeForQuarantine(); throw error; }
  const truncated = await wal.chargedTruncateForDowngrade();
  wal.closeForQuarantine();
  if (truncated) for (const suffix of ["-walok", "-walattempt"]) { try { unlinkSync(`${indexPath}${suffix}`); } catch { /* absent */ } }
  return truncated ? verdict : { state: "unresolved", reason: "downgrade_truncate_busy" };
}
