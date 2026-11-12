// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The home's ops alert path (Cloud): one small spool file {type, at} in the events folder; murage-control carries it on the heartbeat and the control plane raises the
// alert (cloud_alerts). No free text, ever. A desktop install has no events folder, so this does nothing there.
//
// Where the folder is (J5): the server runs as the murage uid, and /var/lib/murage-home is root 0700 (murage-enroll) with a root-owned events/ below it
// (the miner watcher, a root service), so the server could never reach that one. The server's folder is /data/.murage-events, made by the home supervisor
// before it drops privileges (cloud-home/supervisor.ts prepareHomeEventsDir: root owned, murage group, 01770, so the server can add files and cannot
// swap the folder); murage-control (root) reads both folders. A failed write is never silent: one log line and a counter the health answer carries.
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";
import { readHomePublicMetadata } from "./cloud-home/b1b-identity.ts";

export type HomeEventType = "restore.aborted" | "restore.stuck" | "restore.finished";

export const HOME_EVENTS_DIR_NAME = ".murage-events";
export const CLOUD_HOME_EVENTS_DIR = "/data/" + HOME_EVENTS_DIR_NAME;

/** The folder this process spools to: an explicit override, else the Cloud home's folder, else none (a desktop install). */
export function homeEventsDir(env: NodeJS.ProcessEnv): string | undefined {
  return env.MURAGE_HOME_EVENTS_DIR ?? (env.MURAGE_TRUSTED_PROXY ? CLOUD_HOME_EVENTS_DIR : undefined);
}

/** The spool holds at most this many restore alerts (the same bound as the heartbeat's events list). A full spool drops its OLDEST file for the new one,
 *  and every dropped alert is counted in spoolFailures (health.eventSpoolFailures), so nothing is lost without a trace. A control plane that does not
 *  accept these alert types yet leaves them here until it does (murage-control holds them), so the cap is what keeps that wait bounded. */
export const HOME_EVENT_SPOOL_CAP = 5;
const SPOOL_NAME = /^(restore\.aborted|restore\.stuck)-(\d{1,16})\.json$/;

/** How many restore alerts are waiting in the spool to be sent (0 when there is no folder). Murage-control removes a file once the control plane accepted it. */
export function heldHomeEvents(dir: string | undefined): number {
  if (!dir) return 0;
  try { return readdirSync(dir).filter(name => SPOOL_NAME.test(name)).length; } catch { return 0; }
}

/** A temp file (".<name>.tmp") left by a write that was cut short is removed once it is this old. A younger one may be a write in progress and stays. */
export const HOME_EVENT_STALE_TEMP_MS = 10 * 60 * 1000;
export function homeEventTempName(name: string): string { return `.${name}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`; }
/** Temp names are never reused (pid plus a random suffix) and the identity is looked at again right before the unlink (same device and inode, still old),
 *  so a file opened after the first look is never removed. `between` is a test hook that runs between the two looks. */
export function sweepStaleHomeEventTemps(dir: string, nowMs: number = Date.now(), between?: (path: string) => void): number {
  let removed = 0;
  try {
    for (const file of readdirSync(dir)) {
      if (!file.startsWith(".") || !file.endsWith(".tmp")) continue;
      try {
        const path = join(dir, file);
        const info = lstatSync(path);
        if (!info.isFile() || nowMs - info.mtimeMs <= HOME_EVENT_STALE_TEMP_MS) continue;
        between?.(path);
        const again = lstatSync(path);
        if (again.isFile() && again.dev === info.dev && again.ino === info.ino && nowMs - again.mtimeMs > HOME_EVENT_STALE_TEMP_MS) { unlinkSync(path); removed += 1; }
      } catch { /* gone already, or not ours to remove */ }
    }
  } catch { /* no folder */ }
  return removed;
}

/** The time a restore was FIRST found stuck, kept in a small file next to the restore journal so every restart of one stuck restore reports the same
 *  (type, at) and so the same spool file. Written once; cleared when the restore is no longer stuck. */
export function firstStuckAt(file: string, nowMs: number = Date.now()): number {
  try {
    const value = Number(readFileSync(file, "utf8").trim());
    if (Number.isSafeInteger(value) && value > 0) return value;
  } catch { /* first sighting */ }
  try {
    const tmp = `${file}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try { writeSync(fd, String(nowMs)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
  } catch { /* the time is still returned; the next restart may stamp a new one */ }
  return nowMs;
}
export function clearStuckAt(file: string): void { try { unlinkSync(file); } catch { /* none */ } }

let spoolFailures = 0;
/** How many spool writes failed since this process started (the health answer carries it; murage-control raises it as an event). */
export function homeEventSpoolFailures(): number { return spoolFailures; }
export function resetHomeEventSpoolFailuresForTest(): void { spoolFailures = 0; }

/** Returns the file name written, or null (no folder: nothing to do; the write failed: counted and logged, and an alert never breaks what raised it). */
export function spoolHomeEvent(dir: string | undefined, type: HomeEventType, at: number): string | null {
  if (!dir) return null;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    sweepStaleHomeEventTemps(dir);
    const name = `${type}-${at}.json`, tmp = join(dir, homeEventTempName(name));
    // Same type and time = same alert (the restore job's own timestamp): written over, never doubled. A full spool drops the oldest, counted.
    const held = readdirSync(dir).map(file => ({ file, match: SPOOL_NAME.exec(file) })).filter((row): row is { file: string; match: RegExpExecArray } => row.match !== null && row.file !== name)
      .sort((a, b) => Number(a.match[2]) - Number(b.match[2]));
    for (const row of held.slice(0, Math.max(0, held.length - (HOME_EVENT_SPOOL_CAP - 1)))) {
      try { unlinkSync(join(dir, row.file)); spoolFailures += 1; console.error(`[home-events] spool full: dropped the oldest alert ${row.file} (counted: ${spoolFailures})`); } catch { /* counted by the write below if it also fails */ }
    }
    const fd = openSync(tmp, "w", 0o600);
    try { writeSync(fd, JSON.stringify({ type, at })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, join(dir, name));
    return name;
  } catch (error) {
    spoolFailures += 1;
    console.error(`[home-events] could not spool ${type}: ${(error as NodeJS.ErrnoException).code ?? "error"} (failures: ${spoolFailures})`);
    return null;
  }
}

// ======================================================================================================================================
// J5b r8: the single-writer channel. The app makes each event durable in its own checksummed outbox (fsync before it is served), serves it in
// /api/health `homeEvents` once murage-control has advertised channel v1 in its ACK file, and retires an item only through a durable `done` record.
// ======================================================================================================================================
export const FAILURE_TYPE = "home.event_spool_failed";
export type OutboxType = HomeEventType | typeof FAILURE_TYPE;
export const HOME_EVENTS_MIN_CONTROL = 1;
export const OUTBOX_RESTORE_ITEMS = 31;
export const OUTBOX_SERVED_MAX = 32;
export const OUTBOX_TOMBSTONES_PER_TYPE = 128;
export const OUTBOX_COMPACT_LINES = 256;
const ACK_IDS_MAX = 512;
const HEX16 = /^[0-9a-f]{16}$/;
const TYPES: readonly string[] = ["restore.aborted", "restore.stuck", "restore.finished", FAILURE_TYPE];

interface Entry { id: string; type: string; at: number; durable: boolean; retiring: boolean }
type Op = { r: "add" | "done"; id: string; type: string; at: number } | { r: "floor"; type: string; at: number };

const st = {
  map: new Map<string, Entry>(),
  recovered: new Set<string>(), // reloaded adds whose previous receipt may have been memory-only
  tomb: new Map<string, Map<number, string>>(), // type -> at -> id (retained tombstones)
  tombIds: new Set<string>(),
  floor: new Map<string, number>(),
  memTombs: [] as Array<{ id: string; type: string; at: number }>, // tombstones of items that never had a durable add, written by the next record
  fd: -1, goodLen: 0, lines: 0, repair: false, relink: false, healthy: false, notAdmitted: 0,
  extended: false, holdAck: false, loaded: false,
};

const testing = (): boolean => Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";
function outboxPath(): string | undefined {
  return process.env.MURAGE_HOME_EVENTS_OUTBOX ?? (process.env.MURAGE_TRUSTED_PROXY ? "/data/home-events.outbox" : undefined);
}
function ackPath(): string { return (testing() && process.env.MURAGE_HOME_EVENTS_ACK_FILE) || "/run/murage-control/home-events-ack.json"; }
const crcHex = (raw: Buffer): string => (crc32(raw) >>> 0).toString(16).padStart(8, "0");
function recordLine(ops: Op[]): Buffer {
  const raw = Buffer.from(JSON.stringify({ v: 1, ops }));
  return Buffer.concat([Buffer.from(crcHex(raw) + " "), raw, Buffer.from("\n")]);
}
function validOp(op: unknown): op is Op {
  if (!op || typeof op !== "object") return false;
  const o = op as Record<string, unknown>;
  if (typeof o.type !== "string" || !TYPES.includes(o.type) || !Number.isSafeInteger(o.at) || (o.at as number) < 0) return false;
  if (o.r === "floor") return Object.keys(o).length === 3;
  return (o.r === "add" || o.r === "done") && typeof o.id === "string" && HEX16.test(o.id) && Object.keys(o).length === 4;
}
function fsyncDir(path: string): void {
  const fd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function tombstone(type: string, at: number, id: string): void {
  let row = st.tomb.get(type);
  if (!row) st.tomb.set(type, (row = new Map()));
  row.set(at, id);
  st.tombIds.add(id);
}
function apply(op: Op): void {
  if (op.r === "floor") { st.floor.set(op.type, Math.max(st.floor.get(op.type) ?? 0, op.at)); return; }
  if (op.r === "add") { st.map.set(op.id, { id: op.id, type: op.type, at: op.at, durable: true, retiring: false }); return; }
  st.map.delete(op.id);
  tombstone(op.type, op.at, op.id);
}

/** Loads the outbox: replays the valid prefix, truncates anything after it (a bad line is never skipped), removes a stale `.new`. */
export function loadHomeEventsOutbox(): void {
  st.map.clear(); st.recovered.clear(); st.tomb.clear(); st.tombIds.clear(); st.floor.clear(); st.memTombs = [];
  st.lines = 0; st.healthy = false; st.notAdmitted = 0; st.repair = false; st.relink = false;
  if (st.fd >= 0) { try { closeSync(st.fd); } catch { /* gone */ } st.fd = -1; }
  st.loaded = true;
  const path = outboxPath();
  if (!path) return;
  try { unlinkSync(path + ".new"); } catch { /* none */ }
  let data: Buffer;
  try { data = readFileSync(path); } catch { return; }
  let offset = 0;
  while (offset < data.length) {
    const end = data.indexOf(0x0a, offset);
    if (end < 0) break;
    const line = data.subarray(offset, end), space = line.indexOf(0x20);
    if (space < 0 || line.subarray(0, space).toString() !== crcHex(line.subarray(space + 1))) break;
    let ops: unknown;
    try { ops = (JSON.parse(line.subarray(space + 1).toString()) as { v?: unknown; ops?: unknown }); } catch { break; }
    const body = ops as { v?: unknown; ops?: unknown };
    if (body.v !== 1 || !Array.isArray(body.ops) || !body.ops.every(validOp)) break;
    for (const op of body.ops as Op[]) apply(op);
    st.lines += 1;
    offset = end + 1;
  }
  for (const id of st.map.keys()) st.recovered.add(id);
  if (offset < data.length) {
    try { const fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW); try { ftruncateSync(fd, offset); fsyncSync(fd); } finally { closeSync(fd); } } catch { /* read-only: the prefix is still used */ }
  }
}

function openOutbox(): boolean {
  const path = outboxPath();
  if (!path) return false;
  try {
    const existed = (() => { try { statSync(path); return true; } catch { return false; } })();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    st.fd = fd;
    st.goodLen = fstatSync(fd).size;
    if (!existed) fsyncDir(path);
    return true;
  } catch { st.fd = -1; return false; }
}
/** Rule R: after the compaction rename the old descriptor is closed at once; nothing is appended or claimed until the new inode is open and identified. */
function relinkOutbox(): boolean {
  const path = outboxPath()!;
  try {
    fsyncDir(path);
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    const a = fstatSync(fd), b = statSync(path);
    if (a.dev !== b.dev || a.ino !== b.ino) { closeSync(fd); return false; }
    st.fd = fd; st.goodLen = a.size; st.relink = false; st.repair = false;
    return true;
  } catch { return false; }
}
function identityHolds(): boolean {
  try { const a = fstatSync(st.fd), b = statSync(outboxPath()!); return a.dev === b.dev && a.ino === b.ino; } catch { return false; }
}
function compact(): void {
  const path = outboxPath()!, tmp = path + ".new";
  const ops: Op[] = [];
  for (const e of st.map.values()) if (e.durable) ops.push({ r: "add", id: e.id, type: e.type, at: e.at });
  for (const type of TYPES) {
    const row = st.tomb.get(type);
    if (!row) continue;
    const ordered = [...row.entries()].sort((a, b) => b[0] - a[0]);
    const keep = ordered.slice(0, OUTBOX_TOMBSTONES_PER_TYPE);
    let floor = st.floor.get(type) ?? 0;
    for (const [at, id] of ordered.slice(OUTBOX_TOMBSTONES_PER_TYPE)) { floor = Math.max(floor, at); row.delete(at); st.tombIds.delete(id); }
    if (floor > 0 && floor !== (st.floor.get(type) ?? 0)) st.floor.set(type, floor);
    for (const [at, id] of keep.reverse()) ops.push({ r: "done", id, type, at });
    if ((st.floor.get(type) ?? 0) > 0) ops.push({ r: "floor", type, at: st.floor.get(type)! });
  }
  const chunks: Buffer[] = [];
  for (let i = 0; i < ops.length; i += 64) chunks.push(recordLine(ops.slice(i, i + 64)));
  const body = Buffer.concat(chunks);
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
    try { let n = 0; while (n < body.length) n += writeSync(fd, body, n); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch { try { unlinkSync(tmp); } catch { /* none */ } return; } // rename failed: the old descriptor still names the file at `path`
  try { closeSync(st.fd); } catch { /* gone */ }
  st.fd = -1; st.relink = true; st.lines = chunks.length;
  relinkOutbox();
}
/** Appends ONE atomic record. Returns false (and leaves the file as it was at `goodLen`) on any failure. */
function append(ops: Op[]): boolean {
  if (st.recovered.size > 0) return false; // do not pass an unresolved retirement after restart
  if (ops.length === 0) return true;
  try {
    if (st.relink && !relinkOutbox()) throw new Error("relink");
    if (st.fd < 0 && !openOutbox()) throw new Error("open");
    if (!identityHolds()) { try { closeSync(st.fd); } catch { /* gone */ } st.fd = -1; st.relink = true; if (!relinkOutbox()) throw new Error("relink"); }
    if (st.repair) { ftruncateSync(st.fd, st.goodLen); fsyncSync(st.fd); st.repair = false; }
    const line = recordLine(ops);
    st.repair = true;
    let n = 0;
    while (n < line.length) n += writeSync(st.fd, line, n);
    fsyncSync(st.fd);
    st.repair = false; st.goodLen += line.length; st.lines += 1; st.healthy = true;
  } catch { st.healthy = false; return false; }
  return true;
}
/** Compaction runs only after the in-memory state matches what the record said, so a live add is never missing from the rewritten file. */
function maybeCompact(): void { if (st.lines > OUTBOX_COMPACT_LINES && st.fd >= 0) compact(); }

let legacyFailures = 0;
const retiringList = (): Entry[] => [...st.map.values()].filter(e => e.retiring);
const hasDurable = (): boolean => [...st.map.values()].some(e => e.durable);
/** Writes everything owed in one record: `done` of every retiring item first (rule P), then the memory tombstones, then each add that is not yet durable. */
function settle(extra: Op[] = [], apply_: () => void = () => undefined): boolean {
  const ops: Op[] = [];
  // A rejected admission is historical loss, not an item still waiting after recovery.
  // Commit its failure report before clearing the customer count.
  const lost = st.notAdmitted > 0 ? { id: randomBytes(8).toString("hex"), type: FAILURE_TYPE, at: chooseAt(FAILURE_TYPE, Date.now()), durable: true, retiring: false } : undefined;
  const oldFailure = lost ? [...st.map.values()].find(e => e.type === FAILURE_TYPE && !e.retiring) : undefined;
  for (const e of retiringList()) ops.push({ r: "done", id: e.id, type: e.type, at: e.at });
  for (const t of st.memTombs) ops.push({ r: "done", ...t });
  ops.push(...extra);
  for (const e of st.map.values()) if (!e.durable && !e.retiring && !extra.some(o => o.r === "add" && o.id === e.id)) ops.push({ r: "add", id: e.id, type: e.type, at: e.at });
  if (lost) {
    if (oldFailure) ops.push({ r: "done", id: oldFailure.id, type: oldFailure.type, at: oldFailure.at });
    ops.push({ r: "add", id: lost.id, type: lost.type, at: lost.at });
  }
  if (ops.length === 0) return true;
  if (!append(ops)) return false;
  for (const e of retiringList()) st.map.delete(e.id);
  st.memTombs = [];
  for (const e of st.map.values()) if (!e.durable) e.durable = true;
  apply_();
  if (lost) {
    if (oldFailure) { st.map.delete(oldFailure.id); tombstone(oldFailure.type, oldFailure.at, oldFailure.id); }
    st.map.set(lost.id, lost);
    st.notAdmitted = 0;
  }
  maybeCompact();
  return true;
}

function chooseAt(type: string, at: number): number {
  const taken = new Set<number>(st.tomb.get(type)?.keys() ?? []);
  for (const e of st.map.values()) if (e.type === type) taken.add(e.at);
  let value = Math.max(at, (st.floor.get(type) ?? 0) + 1 > 1 ? (st.floor.get(type) ?? 0) + 1 : at);
  while (taken.has(value)) value += 1;
  return value;
}

/** Reports one event: durable in the outbox before it is served. A re-asserted id (in the map, or tombstoned) adds nothing. */
export function reportHomeEvent(type: string, at: number, id: string): void {
  if (!outboxPath() || !TYPES.includes(type) || !HEX16.test(id)) return;
  if (!st.loaded) loadHomeEventsOutbox();
  readAck();
  if (st.map.has(id) || st.tombIds.has(id)) return;
  const entry: Entry = { id, type, at: chooseAt(type, at), durable: false, retiring: false };
  const failureSlot = (): Entry | undefined => [...st.map.values()].find(e => e.type === FAILURE_TYPE && !e.retiring);
  const nonFailure = [...st.map.values()].filter(e => e.type !== FAILURE_TYPE && !e.retiring);
  if (type === FAILURE_TYPE) {
    if (st.recovered.size > 0) { st.notAdmitted = Math.min(OUTBOX_SERVED_MAX, st.notAdmitted + 1); return; }
    const old = failureSlot();
    if (old) { old.retiring = true; tombstone(old.type, old.at, old.id); }
    st.map.set(id, entry);
    if (!settle() && !st.extended) countLegacy();
    return;
  }
  if (nonFailure.length >= OUTBOX_RESTORE_ITEMS) {
    const oldest = nonFailure[0], fail = failureSlot();
    const failure: Entry = { id: randomBytes(8).toString("hex"), type: FAILURE_TYPE, at: chooseAt(FAILURE_TYPE, Date.now()), durable: false, retiring: false };
    const ops: Op[] = [{ r: "done", id: oldest.id, type: oldest.type, at: oldest.at }, { r: "add", id, type, at: entry.at }];
    if (fail) ops.push({ r: "done", id: fail.id, type: fail.type, at: fail.at });
    ops.push({ r: "add", id: failure.id, type: failure.type, at: failure.at });
    const holdPlain = [...retiringList()];
    const prepared = holdPlain.length === 0 ? append(ops) : append([...retiringList().map((e): Op => ({ r: "done", id: e.id, type: e.type, at: e.at })), ...ops]);
    if (prepared) {
      for (const e of retiringList()) st.map.delete(e.id);
      st.map.delete(oldest.id); tombstone(oldest.type, oldest.at, oldest.id);
      if (fail) { st.map.delete(fail.id); tombstone(fail.type, fail.at, fail.id); }
      entry.durable = true; failure.durable = true; st.notAdmitted = 0;
      st.map.set(id, entry); st.map.set(failure.id, failure);
      for (const e of st.map.values()) if (!e.durable) e.durable = true;
      maybeCompact();
      return;
    }
    const memoryOnly = nonFailure.find(e => !e.durable);
    if (memoryOnly) { st.map.delete(memoryOnly.id); tombstone(memoryOnly.type, memoryOnly.at, memoryOnly.id); st.memTombs.push({ id: memoryOnly.id, type: memoryOnly.type, at: memoryOnly.at }); st.map.set(id, entry); return; }
    st.notAdmitted = Math.min(OUTBOX_SERVED_MAX, st.notAdmitted + 1);
    return;
  }
  st.map.set(id, entry);
  if (!settle() && !st.extended) countLegacy();
}
function countLegacy(): void { legacyFailures += 1; console.error(`[home-events] could not write the outbox (failures: ${legacyFailures})`); }

export function noteRestoreAborted(job: { id: string; at: number }): void {
  reportHomeEvent("restore.aborted", job.at, createHash("sha256").update("restore.aborted\0" + job.id).digest("hex").slice(0, 16));
}

interface StuckMarker { at: number; nonce: string }
function readStuckMarker(file: string): StuckMarker | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<StuckMarker>;
    if (Number.isSafeInteger(value.at) && typeof value.nonce === "string" && /^[0-9a-f]{16}$/.test(value.nonce)) return value as StuckMarker;
  } catch { /* none */ }
  return null;
}
/** Boot recovery's verdict on a restore. Stuck: the marker (time first found plus a nonce) is written once, fsynced with its directory, and the item's id
 *  comes from the nonce, so one incident is one id and a later incident at the same millisecond is another. Not stuck: a paired completion is reported before the marker is cleared. */
export function noteRestoreStuck(_dir: string | undefined, stuckFile: string, stuck: boolean): void {
  let marker = readStuckMarker(stuckFile);
  if (!stuck) {
    if (marker) reportHomeEvent("restore.finished", Date.now(), createHash("sha256").update("restore.finished\0" + marker.nonce).digest("hex").slice(0, 16));
    clearStuckAt(stuckFile);
    return;
  }
  if (!marker) {
    marker = { at: Date.now(), nonce: randomBytes(8).toString("hex") };
    try {
      const tmp = `${stuckFile}.tmp`, fd = openSync(tmp, "w", 0o600);
      try { writeSync(fd, JSON.stringify(marker)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, stuckFile);
      fsyncDir(stuckFile);
    } catch { /* the item is still reported; a restart may stamp a new marker */ }
  }
  reportHomeEvent("restore.stuck", marker.at, createHash("sha256").update("restore.stuck\0" + marker.nonce).digest("hex").slice(0, 16));
}

function readAckText(): string | null {
  const file = ackPath();
  try {
    if (testing() && process.env.MURAGE_HOME_EVENTS_ACK_FILE) {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = fstatSync(fd), want = Number(process.env.MURAGE_HOME_EVENTS_ACK_UID ?? 0);
        if (!info.isFile() || info.uid !== want || (info.mode & 0o022) || info.size > 16_384) return null;
        const buffer = Buffer.alloc(info.size); let n = 0;
        while (n < buffer.length) { const c = readSync(fd, buffer, n, buffer.length - n, null); if (!c) break; n += c; }
        return buffer.subarray(0, n).toString("utf8");
      } finally { closeSync(fd); }
    }
    return readHomePublicMetadata(file);
  } catch { return null; }
}
interface Ack { control: number; acked: string[]; accepted: string[] }
export function parseHomeEventsAck(text: string): Ack | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "accepted,acked,control,v" || o.v !== 1 || !Number.isSafeInteger(o.control) || (o.control as number) < 0) return null;
  const lists = [o.acked, o.accepted];
  if (!lists.every(l => Array.isArray(l) && l.every(i => typeof i === "string" && HEX16.test(i)))) return null;
  const all = [...(o.acked as string[]), ...(o.accepted as string[])];
  if (all.length > ACK_IDS_MAX || new Set(all).size !== all.length) return null;
  return { control: o.control as number, acked: o.acked as string[], accepted: o.accepted as string[] };
}
/** Reads the ACK file: the advertisement (sticky) and the ids control has taken. Every id listed is retired: an id with a durable add becomes `retiring`
 *  (its `done` is appended, and only that append removes it); an id that never had a durable add is removed and its tombstone kept in memory. */
function readAck(): void {
  if (!outboxPath()) return;
  if (st.extended && process.env.MURAGE_HOME_EVENTS_HOLD_ACK && testing()) return;
  const text = readAckText();
  const ack = text === null ? null : parseHomeEventsAck(text);
  if (!ack) return;
  if (ack.control >= HOME_EVENTS_MIN_CONTROL) st.extended = true;
  for (const id of [...ack.acked, ...ack.accepted]) {
    const e = st.map.get(id);
    if (!e || e.retiring) continue;
    st.recovered.delete(id);
    if (e.durable) { e.retiring = true; tombstone(e.type, e.at, e.id); }
    else { st.map.delete(id); tombstone(e.type, e.at, id); st.memTombs.push({ id, type: e.type, at: e.at }); }
  }
}
function degradedCount(): number {
  let n = st.notAdmitted;
  for (const e of st.map.values()) if (!e.durable || e.retiring || st.recovered.has(e.id)) n += 1;
  return Math.min(OUTBOX_SERVED_MAX, n);
}
/** One render tick: read the ACK, then write whatever is owed (retirements, undelivered adds). */
function tick(): void { if (!outboxPath()) return; if (!st.loaded) loadHomeEventsOutbox(); readAck(); settle(); }

/** The fields the health answer carries. Extended mode (a v1 control advertised): `homeEvents`; legacy mode: the base counter. `opsAlertsWaiting` is the hold count in both. */
export function homeEventsHealthFields(env: NodeJS.ProcessEnv): Record<string, unknown> {
  if (!outboxPath()) return { eventSpoolFailures: spoolFailures, opsAlertsWaiting: heldHomeEvents(homeEventsDir(env)) };
  tick();
  const waiting = degradedCount();
  if (!st.extended) return { eventSpoolFailures: spoolFailures + legacyFailures, opsAlertsWaiting: waiting };
  const gate = !st.healthy && hasDurable();
  const items = [...st.map.values()].filter(e => !e.retiring && (!gate || e.durable)).slice(0, OUTBOX_SERVED_MAX).map(e => ({ id: e.id, type: e.type, at: e.at }));
  return { opsAlertsWaiting: waiting, ...(env.MURAGE_TRUSTED_PROXY ? { homeEvents: { v: 1, items, outboxDegraded: waiting } } : {}) };
}
/** Exit 75 and close: waits only while degraded items exist, ends as soon as they are accepted or retired. */
export async function drainHomeEvents(ms: number): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    tick();
    if (!outboxPath() || degradedCount() === 0 || Date.now() >= end) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
/** The count the restore status line and /api/health report: items held for lack of a durable write (0 on a desktop install). */
export function heldOutboxEvents(): number { return outboxPath() ? degradedCount() : 0; }
