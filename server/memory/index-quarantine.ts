// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMINDEX-BUSY-109. The memory search index is a projection of messages.db: a damaged one is set aside and rebuilt from messages.db
// (index.ts), so the set-aside copy is never read again. It still holds the words of every conversation it indexed, including ones the
// owner deleted after it was set aside, and nothing scrubs it. So it is removed as soon as the new index is open, and so is any copy an
// earlier build left. Only the index's own directory is looked at (never recursively), only names `<index file>.corrupt-<digits>` and
// their `-wal`/`-shm`, only regular files (never a link or a directory). No other quarantine (messages.db's included) is touched.
import { lstatSync, readdirSync, renameSync, unlinkSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** SQLITE_CORRUPT and SQLITE_NOTADB: the only errors that say the file itself is damaged. */
const DAMAGED_CODES: ReadonlySet<number> = new Set([11, 26]);

/** Thrown when quick_check runs and answers something other than "ok". */
export class IndexDamagedError extends Error { constructor(answer: unknown) { super(`MEMORY_INDEX_DAMAGED:${String(answer).slice(0, 200)}`); } }

/** Whether an error from the integrity check means the file is damaged (set it aside), as against busy, locked, out of memory or an
 * I/O fault, which say nothing about the file: those are thrown, the helper's start fails and the controller starts it again later. */
export function indexDamaged(error: unknown): boolean {
  if (error instanceof IndexDamagedError) return true;
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && DAMAGED_CODES.has(code & 0xff);
}

/** quick_check on an open handle: returns normally for "ok", throws IndexDamagedError for any other answer, and lets a SQLite error through. */
export function checkIndex(db: DatabaseSync): void {
  const answer = db.prepare("PRAGMA quick_check").get()?.quick_check;
  if (answer !== "ok") throw new IndexDamagedError(answer);
}

/** The index's log files. SQLite opens them by name beside the index file and follows a link. */
const LOG_SUFFIXES = ["-wal", "-shm"] as const;
const UNSAFE = "UNSAFE_MEMORY_INDEX";

/** lstat that answers null for a name that is not there; any other fault is thrown (fail closed). */
function entry(path: string): Stats | null {
  try { return lstatSync(path); } catch (error) { if ((error as { code?: unknown })?.code === "ENOENT") return null; throw error; }
}

/** Run before every open of the index. A log file that is a link, a directory or anything but a regular file stops the start
 * (UNSAFE_MEMORY_INDEX): SQLite would read and write through it. With no index file, a log file at the live name belongs to no database
 * (a set-aside that failed half way, a crash): opened beside the new empty file, a WAL would bring the old words back into it. It is
 * removed, and if it cannot be the start fails and is retried, so a fresh index is never opened beside it. */
export function prepareIndexOpen(path: string, unlink: (file: string) => void = unlinkSync): void {
  const indexFile = entry(path);
  if (indexFile && (!indexFile.isFile() || indexFile.isSymbolicLink())) throw new Error(UNSAFE);
  for (const suffix of LOG_SUFFIXES) {
    const file = `${path}${suffix}`, stat = entry(file);
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(UNSAFE);
    if (indexFile) continue;
    try { unlink(file); } catch (error) { if ((error as { code?: unknown })?.code !== "ENOENT") throw error; }
  }
}

/** For read-only connections (index-reader.ts), which must not write either: true only when the index file and any log file are regular
 * files (no link, no directory) and could be looked at. A read-only open still maps and can write the -shm, so a link there is refused. */
export function indexFilesRegular(path: string): boolean {
  try {
    for (const file of [path, ...LOG_SUFFIXES.map(suffix => `${path}${suffix}`)]) {
      const stat = entry(file);
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) return false;
    }
    return true;
  } catch { return false; }
}

/** Moves a damaged index and its log files aside under one name, as one set: if any rename fails, the ones already done are moved back
 * and the error is thrown (the start fails and is retried). Left at the live name, a log would be read into the new empty file. A log
 * that is not a regular file is refused (UNSAFE_MEMORY_INDEX). Returns the main file's new name. `rename` is for tests only. */
export function quarantineIndex(path: string, now = Date.now(), rename: (from: string, to: string) => void = renameSync): string {
  const aside = `${path}.corrupt-${now}`, moved: Array<[from: string, to: string]> = [];
  try {
    for (const suffix of ["", ...LOG_SUFFIXES]) {
      const from = `${path}${suffix}`, to = `${aside}${suffix}`;
      if (suffix) { const stat = entry(from); if (!stat) continue; if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(UNSAFE); }
      rename(from, to);
      moved.push([from, to]);
    }
  } catch (error) {
    // Logs first, the index file last. If a log cannot be put back, the index file stays aside: restored without its log it could pass
    // the check while missing the log's writes (deletions among them). With no index file the next start removes any log at the live
    // name (prepareIndexOpen) and rebuilds; the sweep removes the set-aside copies.
    let whole = true;
    for (const [from, to] of moved.reverse()) {
      if (from === path && !whole) break;
      try { rename(to, from); } catch { whole = false; }
    }
    throw error;
  }
  return aside;
}

function quarantinePattern(indexPath: string): RegExp {
  const name = basename(indexPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${name}\\.corrupt-\\d+(?:-wal|-shm)?$`);
}

/** Unlinks every set-aside copy of this index (and its log files) in the index's own directory. A file that cannot be removed now
 * (held open elsewhere, on Windows) is named in `left`; the memory controller tries again (worker-controller.ts sweepIndexQuarantines).
 * `left` is also set when the directory could not be read. */
export function removeIndexQuarantines(indexPath: string): { removed: string[]; left: string[] } {
  const directory = dirname(indexPath), pattern = quarantinePattern(indexPath), removed: string[] = [], left: string[] = [];
  let names: string[];
  try { names = readdirSync(directory); } catch (error) { return { removed, left: (error as { code?: unknown })?.code === "ENOENT" ? [] : [directory] }; }
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const file = join(directory, name);
    let stat: Stats | null;
    try { stat = entry(file); } catch { left.push(name); continue; } // could not be looked at now: tried again later, never taken as gone
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) continue;
    try { unlinkSync(file); removed.push(name); } catch (error) { if ((error as { code?: unknown })?.code !== "ENOENT") left.push(name); }
  }
  return { removed, left };
}
