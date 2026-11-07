// SPDX-License-Identifier: AGPL-3.0-or-later
// The io-budget's write readings, as a leaf (Node built-ins only), so the memory helper and the copy/snapshot sinks can count their
// writes without the budget's import graph (observe, health, net-meter). io-budget.ts re-exports these and drains takeWrittenBytes.
//
// Windows (WIN-IOB-QUICK, 1.0.18): resourceUsage().fsWrite there is GetProcessIoCounters' WriteOperationCount, which counts every
// handle (pipes, IPC, sockets), not disk blocks: 2000 child.send calls read as 2000 "blocks". So the OS floor is 0 on win32 and the
// verdict comes from application bytes only: WAL frames of instrumented databases and of the memory helper's index, and the logical
// output sizes noted here (skill index build, health stats DB, VACUUM INTO and backup copies). Page rewrites, rollback journals,
// checkpoints and temp spills stay unseen on win32 until the full meter (WIN-IOMETER, 1.0.19).
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { endianness } from "node:os";

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
export function noteWrittenBytes(source: string, bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const name = written.has(source) || written.size < WRITTEN_NAMES ? source : "other-files";
  written.set(name, (written.get(name) ?? 0) + bytes);
}
/** Charges a finished output file's size (what was just written to it). A missing file charges nothing. */
export function noteWrittenFile(source: string, path: string): void {
  try { noteWrittenBytes(source, statSync(path).size); } catch { /* gone already: nothing to charge */ }
}
/** Everything noted since the last call, and clears it. */
export function takeWrittenBytes(): Array<[string, number]> {
  const taken = [...written];
  written.clear();
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
      const now = statSync(shm);
      if (held && (held.ino !== now.ino || held.dev !== now.dev)) {
        // A different file now: the old inode is no longer SQLite's, closing it drops no live lock.
        try { closeSync(held.fd); } catch { /* already closed */ }
        held = undefined;
      }
      if (!held) held = { fd: openSync(shm, "r"), ino: now.ino, dev: now.dev };
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
  // Call only after the database handle is closed: closing any descriptor on the shm
  // drops the process's locks on it. Idempotent; held is cleared before closing so a
  // second call cannot close a reused descriptor number.
  const close = () => {
    closed = true;
    const fd = held?.fd;
    held = undefined;
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  };
  return Object.assign(read, { close, fd: () => held?.fd });
}
