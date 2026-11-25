// SPDX-License-Identifier: AGPL-3.0-or-later
// Leaf write accounting for the budget, helper and copy sinks. WIN-IOMETER
// counts SQLite xWrite and routed file writes in the shared native meter. The
// old resourceUsage fsWrite count remains zero on Windows because it includes
// pipe/IPC traffic. Coverage gaps are explicit in io-meter.ts and keep Windows
// verdicts unknown; measured bytes are still charged. WAL/output estimates are
// retained for source builds without the meter, never added beside native bytes.
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { endianness } from "node:os";

/** The meter installs this narrow adapter after loading. The accounting leaf
 * itself keeps no dependency on application/native-addon loader modules. */
interface WrittenMeter { active(): boolean; snapshot(): {buckets: Array<[string,number]>} | null }
let writtenMeter: WrittenMeter | undefined;
export function setWrittenMeter(meter: WrittenMeter): void { writtenMeter = meter; }

/** On non-Windows OSes, resourceUsage().fsWrite is getrusage's block-output count, charged at 512 bytes per block. */
export const BLOCK_BYTES = 512;

/** The process's cumulative disk write blocks: getrusage's count off Windows, 0 on win32 (see the header). */
export function osWriteBlocks(usage: { fsWrite: number } = process.resourceUsage(), platform: string = process.platform): number {
  return platform === "win32" ? 0 : usage.fsWrite;
}

/** Logical bytes the sinks above wrote and the budget has not yet taken. Per thread and process: only the main thread's budget
 *  drains it, so a note in a worker thread or a child helper is dropped there (as its writes were never in the parent's OS counter).
 *  Bounded by name: at most WRITTEN_NAMES names, then "other-files". */
const written = new Map<string, number>();
const WRITTEN_NAMES = 32;
const meteredPrevious=new Map<string,number>();
export function noteWrittenBytes(source: string, bytes: number): void {
  // Once writes are metered at their boundary, output-size/WAL estimates would double charge them.
  if (writtenMeter?.active()) return;
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const name = written.has(source) || written.size < WRITTEN_NAMES ? source : "other-files";
  written.set(name, (written.get(name) ?? 0) + bytes);
}
/** Charges a finished output file's size (what was just written to it). A missing file charges nothing. */
export function noteWrittenFile(source: string, path: string): void {
  try { noteWrittenBytes(source, statSync(path).size); } catch { /* gone already: nothing to charge */ }
}
/** q1022-ordfiles: the native meter's database buckets moved since the last call (bytes per database file, whoever wrote them). Only the
 *  budget's minute line reads it, to name bytes no source's transaction took; it never charges anything (the meter total already does). */
const databasePrevious=new Map<string,number>();
export function takeDatabaseBuckets(): Array<[string, number]> {
  const moved: Array<[string, number]> = [];
  if(!writtenMeter?.active())return moved;
  const snapshot=writtenMeter.snapshot();
  if(snapshot)for(const [name,total] of snapshot.buckets){
    if(!name.startsWith("database:"))continue;
    const before=databasePrevious.get(name);
    if(total>(before??0))moved.push([name,total-(before??0)]);
    databasePrevious.set(name,total);
  }
  return moved;
}
/** Everything noted since the last call, and clears it. */
export function takeWrittenBytes(): Array<[string, number]> {
  const taken = [...written];
  written.clear();
  if(writtenMeter?.active()){
    const snapshot=writtenMeter.snapshot();
    if(snapshot)for(const [name,total] of snapshot.buckets){
      // Database buckets already have transaction-boundary attribution. This
      // adds disjoint plain-file/native buckets only; total process bytes are
      // still a maximum at the judge, so the same write is never added twice.
      if(name.startsWith("database:"))continue;
      const before=meteredPrevious.get(name)??0;
      if(total>before)taken.push([name,total-before]);
      meteredPrevious.set(name,total);
    }
  }
  return taken;
}

/** File growth is cumulative across truncation and recreation between samples.
 * Existing bytes form the baseline. In-place rewrites need explicit counters. */
export function fileGrowthReader(paths: readonly string[]): () => number {
  const size = (path: string) => { try { return statSync(path).size; } catch { return 0; } };
  const previous = paths.map(size);
  let total = 0;
  return () => {
    paths.forEach((path,index) => {
      const current = size(path);
      total += Math.max(0, current - previous[index]);
      previous[index] = current;
    });
    return total;
  };
}

/** The read-only descriptors this process keeps on -shm files, one per shm inode, shared by every reader (1.0.22 fix1022-revoke-ioerr):
 * walFrameReader, walIndexReader and the session collector's commit sign (memory/session-proof-schema.ts, through readShmHeader).
 * On POSIX one is never closed while its inode is still the file at its path: closing any descriptor on a file drops every fcntl lock the
 * process holds on it, and the checkpointer and search worker threads keep connections (and their WAL locks on this shm) after a reader's
 * owner let go (closeDatabase), so a close here let another process cut the log under them ("disk I/O error"). Once the path no longer
 * names that inode (SQLite's last connection deleted the sidecar, which it does only with no connection left on it, or the file was
 * replaced), no lock of this process lives on it: the next lookup of a new inode closes it (releaseGoneShm), so a reopened database never
 * keeps an old descriptor and the count stays one per live shm inode. Windows locks are per handle, and a held handle leaves a deleted
 * sidecar delete-pending (the next open fails ERROR_ACCESS_DENIED): there nothing is kept, every reader closes its own. */
const keptShm = new Map<string, { path: string; fds: number[] }>();
const KEEP_SHM = process.platform !== "win32";
function releaseGoneShm(): void {
  for (const [key, kept] of keptShm) {
    let now: { dev: bigint; ino: bigint } | undefined;
    try { now = statSync(kept.path, { bigint: true, throwIfNoEntry: false }); } catch { continue; } // unknown: kept
    if (now && `${now.dev}:${now.ino}` === key) continue;
    keptShm.delete(key);
    for (const fd of kept.fds) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}
function shmDescriptor(shm: string, now: { dev: bigint; ino: bigint }): number {
  if (!KEEP_SHM) return openSync(shm, "r");
  const held = keptShm.get(`${now.dev}:${now.ino}`);
  if (held) return held.fds[0]!;
  releaseGoneShm(); // a new inode: the ones their paths no longer name go first
  // keyed by what the descriptor itself holds: a file replaced between the stat and the open is not mislabelled
  const opened = openSync(shm, "r"), got = fstatSync(opened, { bigint: true }), real = `${got.dev}:${got.ino}`;
  const kept = keptShm.get(real);
  if (kept) { kept.fds.push(opened); return kept.fds[0]!; } // a second descriptor on a kept inode stays open with it (closed only with it)
  keptShm.set(real, { path: shm, fds: [opened] });
  return opened;
}
/** The first `length` bytes of `<db>-shm` (the session collector's commit sign), read through the kept descriptor of its inode. */
export function readShmHeader(shm: string, into: Buffer, length: number): number {
  const fd = shmDescriptor(shm, statSync(shm, { bigint: true }));
  try { return readSync(fd, into, 0, length, 0); } finally { letGo(fd); }
}
function letGo(fd: number | undefined): void { if (fd !== undefined && !KEEP_SHM) { try { closeSync(fd); } catch { /* already closed */ } } }

/** WAL frames appended, read from the wal-index header in `<db>-shm`. A WAL
 * that has reached its working size is rewritten in place after each
 * checkpoint, so its file size stops growing while writes continue; the
 * header's frame count and salt keep counting them. Falls back to file growth
 * when the header cannot be read consistently. */
export function walFrameReader(databaseFile: string): (() => number) & { close(): void; fd(): number | undefined } {
  const growth = fileGrowthReader([`${databaseFile}-wal`]);
  // The -shm file is the one SQLite maps and takes POSIX locks on in this very
  // process. Closing ANY descriptor on a file drops every lock the process holds
  // on it, so an open/read/close here let another process run wal-index recovery
  // and truncate the shm under SQLite's live mapping (SIGBUS). Keep one read-only
  // descriptor per shm inode and never close it while that inode is current.
  const shm = `${databaseFile}-shm`;
  let held: { fd: number; ino: number | bigint; dev: number | bigint } | undefined;
  let closed = false;
  const header = (): { salt: string; frames: number; frameBytes: number } | null => {
    // After close() nothing reads or reopens a descriptor; callers fall back to WAL file growth.
    if (closed) return null;
    try {
      const now = statSync(shm, { bigint: true });
      if (held && (held.ino !== now.ino || held.dev !== now.dev)) {
        // A different file now: stop using the old inode's descriptor (kept, never closed on POSIX: see keptShm).
        letGo(held.fd);
        held = undefined;
      }
      if (!held) held = { fd: shmDescriptor(shm, now), ino: now.ino, dev: now.dev };
      const raw = Buffer.alloc(96);
      if (readSync(held.fd, raw, 0, 96, 0) < 96 || !raw.subarray(0, 48).equals(raw.subarray(48, 96)) || raw[12] !== 1) return null;
      const little = endianness() === "LE";
      const page = little ? raw.readUInt16LE(14) : raw.readUInt16BE(14);
      const frames = little ? raw.readUInt32LE(16) : raw.readUInt32BE(16);
      return { salt: raw.subarray(32, 40).toString("hex"), frames, frameBytes: (page === 1 ? 65536 : page) + 24 };
    } catch { return null; }
  };
  let last = header(), total = 0, grown = growth();
  const read = () => {
    const fileBytes = growth() - grown;
    grown += fileBytes;
    const next = header();
    if (next && last) total += (next.salt === last.salt ? Math.max(0, next.frames - last.frames) : next.frames) * next.frameBytes;
    else total += fileBytes;
    if (next) last = next;
    return total;
  };
  // Stops reading. On POSIX the descriptor stays kept (keptShm): this process's other connections may still hold
  // locks on the shm. Idempotent; held is cleared first so a second call cannot close a reused descriptor number.
  const close = () => {
    closed = true;
    const fd = held?.fd;
    held = undefined;
    letGo(fd);
  };
  return Object.assign(read, { close, fd: () => held?.fd });
}

/** The wal-index header of `<db>-shm` as the MEMW charge needs it (memory/index-wal.ts): mxFrame (frames in the log now), nBackfill
 * (frames already copied back) and the salt. null when the header cannot be read consistently (both copies equal, isInit set).
 * Same descriptor rule as walFrameReader: the process-wide kept descriptor of the shm inode (keptShm). */
export function walIndexReader(databaseFile: string): (() => { mxFrame: number; nBackfill: number; salt: string } | null) & { close(): void } {
  const shm = `${databaseFile}-shm`;
  let held: { fd: number; ino: number | bigint; dev: number | bigint } | undefined;
  let closed = false;
  const read = () => {
    if (closed) return null;
    try {
      const now = statSync(shm, { bigint: true });
      if (held && (held.ino !== now.ino || held.dev !== now.dev)) { letGo(held.fd); held = undefined; }
      if (!held) held = { fd: shmDescriptor(shm, now), ino: now.ino, dev: now.dev };
      const raw = Buffer.alloc(100);
      if (readSync(held.fd, raw, 0, 100, 0) < 100 || !raw.subarray(0, 48).equals(raw.subarray(48, 96)) || raw[12] !== 1) return null;
      const little = endianness() === "LE";
      const mxFrame = little ? raw.readUInt32LE(16) : raw.readUInt32BE(16), nBackfill = little ? raw.readUInt32LE(96) : raw.readUInt32BE(96);
      return { mxFrame, nBackfill, salt: raw.subarray(32, 40).toString("hex") };
    } catch { return null; }
  };
  const close = () => { closed = true; const fd = held?.fd; held = undefined; letGo(fd); };
  return Object.assign(read, { close });
}
