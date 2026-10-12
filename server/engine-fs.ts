// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The strict reader behind every engine-history plan and every executor read (the one place that touches the engines'
// files). Only lstat and readdir may answer "not there" (ENOENT, ENOTDIR). Everything else that goes wrong (EIO, EACCES,
// EMFILE, a corrupt zstd frame, missing zstd support, a SQLite open or query error, a line that names the conversation but
// does not parse) throws PlanError, so a read that could not be done is never mistaken for an empty answer.
//
// `fsOps` is the raw read layer and `mutOps` the raw write layer: tests replace members to inject a failure or to record every
// call. They are the ONLY place the deletion code touches node:fs and node:sqlite (engine-plan-structure.test.ts): the planners
// reach the world through the strict reader below, the executor through both layers, and the worker through the driver alone.
import { chmodSync, closeSync, utimesSync, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { uptime } from "node:os";
import zlib from "node:zlib";
import { heldFileOf, loadExclusionAddon, type Barrier, type FileWriters, type NativeProcess } from "./engine-exclusion.ts";
import { MAX_LINE_BYTES, mentions as mentionsIn, PlanError, rolloutEvidence, type DbReader, type EngineFs, type FileRef, type HeldFile, type JsonLine } from "./engine-plan-core.ts";

export interface RawDb { all(sql: string, params: Array<string | number>): Array<Record<string, unknown>>; close(): void }

function readHeadRaw(path: string, bytes: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}
function zstdRaw(bytes: Buffer): Buffer {
  const decode = (zlib as unknown as { zstdDecompressSync?: (input: Buffer) => Buffer }).zstdDecompressSync;
  if (!decode) throw new Error("zstd support is not available in this Node");
  return decode(bytes);
}
/** A database opened for the PLAN, read only: it never runs a checkpoint and never creates or removes the -wal and -shm of a database an
 * engine may have open (a read-write connection that closes last deletes them). */
function openDbRaw(path: string): RawDb {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA busy_timeout=5000;");
  return { all: (sql, params) => db.prepare(sql).all(...params) as Array<Record<string, unknown>>, close: () => db.close() };
}

function readAtRaw(fd: FileRef, buffer: Buffer, position: number): number {
  if (typeof fd !== "number") {
    const got = fd.read(buffer.length, position);
    got.copy(buffer, 0, 0, got.length);
    return got.length;
  }
  return readSync(fd, buffer, 0, buffer.length, position);
}

/** The raw calls every read goes through. Tests replace members to inject a listing or read failure. */
export const fsOps = {
  openRead: (path: string): number => openSync(path, "r"),
  readAt: readAtRaw,
  closeFd: (fd: number): void => closeSync(fd),
  lstat: lstatSync,
  readdir: readdirSync,
  readFile: readFileSync,
  readlink: readlinkSync,
  readHead: readHeadRaw,
  zstd: zstdRaw,
  openDb: openDbRaw,
};

function openDbWriteRaw(path: string, pragmas: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try { db.exec(pragmas); } catch (error) { db.close(); throw error; }
  return db;
}
function preadRaw(fd: FileRef, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    if (typeof fd !== "number") {
      const piece = fd.read(length - got, position + got);
      if (piece.length === 0) break;
      piece.copy(buffer, got);
      got += piece.length;
      continue;
    }
    const read = readSync(fd, buffer, got, length - got, position + got);
    if (read === 0) break;
    got += read;
  }
  return buffer.subarray(0, got);
}
/** ONE write at `position`; returns how many bytes it put. The executor asks its guard again before it writes what is left. */
function pwriteRaw(fd: FileRef, bytes: Buffer, position: number): number {
  if (typeof fd !== "number") { const put = fd.write(bytes, position); return typeof put === "number" ? put : bytes.length; }
  return writeSync(fd, bytes, 0, bytes.length, position);
}
function sleepRaw(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export type { FileWriters };

/** fsync, through the drive's own cache where the system has a call for it (macOS F_FULLFSYNC, by the addon): a rename, a link or a
 * journal that must be on disk before the next step is only there once the drive says so. Says which barrier it was (the addon's own
 * answer); a plain fsync with no addon to ask, or an answer that is not one of the two, is "none". */
function durableSync(fd: number): Barrier {
  const addon = process.platform === "win32" ? null : loadExclusionAddon();
  if (!addon?.fullSync) { fsyncSync(fd); return "none"; }
  const said: unknown = addon.fullSync(fd);
  return said === "full" || said === "fallback" ? said : "none";
}

/** The raw calls every change goes through (and the reads that must happen on an open handle). Tests replace members to inject
 * a failure, to run a writer between two calls, or to count calls. */
export const mutOps = {
  openRead: (path: string): number => openSync(path, "r"),
  openReadWrite: (path: string): number => openSync(path, "r+"),
  openAppend: (path: string): number => openSync(path, "a"),
  close: (fd: FileRef): void => { if (typeof fd === "number") closeSync(fd); else fd.close(); },
  /** size and inode of an open file (a held file reports its file index as a Number, as Node's own stat does on Windows) */
  fstat: (fd: FileRef): { size: number; ino: number } => { if (typeof fd === "number") { const stat = fstatSync(fd); return { size: stat.size, ino: stat.ino }; } return { size: fd.size(), ino: Number(fd.id().ino) }; },
  pread: preadRaw,
  pwrite: pwriteRaw,
  append: (fd: number, bytes: Buffer): void => { let done = 0; while (done < bytes.length) done += writeSync(fd, bytes, done, bytes.length - done); },
  fsync: (fd: FileRef): void => { if (typeof fd === "number") fsyncSync(fd); else fd.sync(); },
  /** cuts an open file back to `length` bytes (only a join's own bytes are ever cut: engine-exec.ts undoJoin) */
  ftruncate: (fd: number, length: number): void => { ftruncateSync(fd, length); },
  rename: renameSync,
  /** a new name for a file, failing with EEXIST if the name is taken (unlike rename, never replaces) */
  link: linkSync,
  /** device and inode of a path (no link followed) or of an open file, as BigInt */
  idOf: (path: string): { dev: bigint; ino: bigint; mtimeNs: bigint } => { const stat = lstatSync(path, { bigint: true }); return { dev: stat.dev, ino: stat.ino, mtimeNs: stat.mtimeNs }; },
  idOfFd: (fd: FileRef): { dev: bigint; ino: bigint } => { if (typeof fd !== "number") return fd.id(); const stat = fstatSync(fd, { bigint: true }); return { dev: stat.dev, ino: stat.ino }; },
  removeTree: (path: string): void => rmSync(path, { recursive: true, force: true }),
  unlink: unlinkSync,
  mkdir: (path: string): void => mkdirSync(path),
  /** a folder and the ones above it, private to the owner (Murage's own crash journal) */
  mkdirp: (path: string): void => { mkdirSync(path, { recursive: true, mode: 0o700 }); },
  /** a NEW file of Murage's own (a crash journal): created (never replacing a file that is there: EEXIST), written whole and synced
   * before this returns */
  writeDurable: (path: string, bytes: Buffer): void => {
    const fd = openSync(path, "wx", 0o600);
    try { let done = 0; while (done < bytes.length) done += writeSync(fd, bytes, done, bytes.length - done); durableSync(fd); } finally { closeSync(fd); }
  },
  /** makes a folder's names durable (where the system can: Windows cannot open a folder). On macOS through the drive's own cache
   * (F_FULLFSYNC), which also makes durable every write already synced on that drive. */
  fsyncDir: (path: string): Barrier => {
    if (process.platform === "win32") return "full";
    const fd = openSync(path, "r");
    try { return durableSync(fd); } finally { closeSync(fd); }
  },
  /** makes a file's written bytes durable through the drive's own cache (macOS F_FULLFSYNC), on a descriptor of its own that cannot
   * write. Windows: nothing (the writes were flushed on the handle that made them, and a read-only handle cannot be flushed). A file
   * that is gone has nothing to make durable. */
  fsyncFile: (path: string): Barrier => {
    if (process.platform === "win32") return "full";
    let fd: number;
    try { fd = openSync(path, "r"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "full"; throw error; }
    try { return durableSync(fd); } finally { closeSync(fd); }
  },
  /** a monotonic clock in milliseconds: how long a hold has lasted. Tests replace it to stall Murage. */
  now: (): number => performance.now(),
  /** sets a path's modification time to now (a directory lock is kept fresh this way) */
  touch: (path: string): void => { const now = new Date(); utimesSync(path, now, now); },
  /** sets a path's modification time to `seconds` since the epoch (fractional): a folder Murage makes is stamped with a time of its own,
   * so that a folder that takes its name later cannot be mistaken for it even if the file system gives it the same inode number */
  touchAt: (path: string, seconds: number): void => { utimesSync(path, seconds, seconds); },
  rmdir: rmdirSync,
  chmod: chmodSync,
  openDbWrite: openDbWriteRaw,
  sleep: sleepRaw,
};

/** The name the addon is handed. On Windows a path is given its long form (\\?\C:\... or \\?\UNC\...) as Node does for its own calls:
 * without it the system refuses any path longer than 260 characters, and an engine's session folders (named after a whole working
 * folder) are often longer than that. Elsewhere the path as it is. */
const longPath = (path: string): string => {
  if (process.platform !== "win32" || path.startsWith("\\\\?\\")) return path;
  if (/^[A-Za-z]:[\\/]/.test(path)) return `\\\\?\\${path.replace(/\//g, "\\")}`;
  if (/^[\\/]{2}[^\\/]/.test(path)) return `\\\\?\\UNC\\${path.slice(2).replace(/\//g, "\\")}`;
  return path;
};

/** Real exclusion on an engine's file, from the native addon (engine-exclusion.ts). Tests replace members or the whole object to model
 * an engine that holds a lock or has a file open. With no addon `available()` is false and the executor changes nothing. */
export const exclOps = {
  mode: (process.platform === "win32" ? "win32" : "posix") as "posix" | "win32",
  available: (): boolean => loadExclusionAddon() !== null,
  /** The engine's own whole-file lock on `fd` (waits up to a second). False: someone else has it. (macOS, Linux) */
  lock: (fd: number): boolean => loadExclusionAddon()!.lock(fd),
  /** Looking at an engine's own lock files (engine-closed.ts), outside the strict reader: the modification time of a path (null: not
   * there), the names in a folder (none: not there), and a small file's text (null: not there). Any other failure throws. */
  mtimeOf: (path: string): number | null => { try { return lstatSync(path).mtimeMs; } catch (error) { if (isAbsent(error)) return null; throw error; } },
  namesIn: (dir: string): string[] => { try { return readdirSync(dir); } catch (error) { if (isAbsent(error)) return []; throw error; } },
  textOf: (path: string): string | null => { try { return readFileSync(path, "utf8"); } catch (error) { if (isAbsent(error)) return null; throw error; } },
  /** This process's id (it is never an engine), its parent's, and the user it runs as (null where the system has none). */
  ownPid: (): number => process.pid,
  ownPpid: (): number => process.ppid,
  ownUid: (): number | null => (typeof process.getuid === "function" ? process.getuid() : null),
  /** When this computer last started, in milliseconds since the epoch (null: not known). A descriptor never outlives a restart. */
  bootTimeMs: (): number | null => { const up = uptime(); return Number.isFinite(up) && up > 0 ? Date.now() - up * 1000 : null; },
  /** The real path of a program or script (every link followed); null when it cannot be resolved. */
  realpathOf: (path: string): string | null => { try { return realpathSync.native(path); } catch { return null; } },
  /** Every running process, for deciding whether an engine is open (engine-closed.ts). */
  processes: (): NativeProcess[] => loadExclusionAddon()!.processes(),
  /** macOS, Linux: the other processes that have one of `paths` open for writing, and those whose open files could not be read. */
  writers: (paths: string[]): FileWriters => loadExclusionAddon()!.writers!(paths),
  /** Moves `from` to `to` in one atomic step that never replaces an existing name. "exists": the name is taken (nothing moved).
   * "unsupported": this file system or system cannot do it (nothing moved). Never falls back to a replacing rename. */
  renameNoReplace: (from: string, to: string): "ok" | "exists" | "unsupported" => {
    const code = loadExclusionAddon()!.renameNoReplace(longPath(from), longPath(to));
    return code === 0 ? "ok" : code === 1 ? "exists" : "unsupported";
  },
  /** Windows: a file held by the addon: "exclusive" (share-none), "delete" (share-none, may be deleted), "shared" (for the
   * engine's lock) or "probe" (shared and read only: to look at the engine's lock without asking to write). null when something else
   * has it open. */
  openFile: (path: string, kind: "exclusive" | "delete" | "shared" | "probe"): HeldFile | null => {
    const addon = loadExclusionAddon()!;
    const native = addon.openFile!(longPath(path), kind === "exclusive" ? 0 : kind === "delete" ? 1 : kind === "shared" ? 2 : 3);
    return native ? heldFileOf(addon, native) : null;
  },
};

/** ENOENT and ENOTDIR mean the thing is not there. Any other error (EIO, EACCES, EMFILE, ...) means it could not be looked at. */
export const isAbsent = (error: unknown): boolean => { const code = (error as NodeJS.ErrnoException | undefined)?.code; return code === "ENOENT" || code === "ENOTDIR"; };

/** Does `text` mention any needle, raw or as it would be escaped inside a JSON string? (engine-plan-core.ts) */
export const mentions = mentionsIn;

/** Parse JSONL text. A blank line, a non-object line, or a torn line that mentions no needle is kept as it is (row null). A
 * torn line that mentions a needle could be this conversation's, so it throws. `cut` says the last piece is a partial line. */
export function parseJsonLines(path: string, text: string, needles: readonly string[], cut = false): JsonLine[] {
  const pieces = text.split("\n");
  return pieces.map((line, index) => {
    if (!line.trim()) return { text: line, row: null };
    try {
      const value = JSON.parse(line) as unknown;
      return { text: line, row: value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null };
    } catch (error) {
      if (cut && index === pieces.length - 1) return { text: line, row: null };
      if (mentions(line, needles)) throw new PlanError(path, new Error("a line that names this conversation could not be parsed", { cause: error }));
      return { text: line, row: null };
    }
  });
}

const CHUNK_BYTES = 1024 * 1024;

/** The lines of a file in order, read CHUNK_BYTES at a time; a line may span reads. `fd` is an open descriptor (left open), else
 * the path is opened and closed here. A line over MAX_LINE_BYTES is a PlanError: it cannot be read in full. */
function streamLines(fd: FileRef | undefined, path: string, visit: (line: Buffer, offset: number, cut: boolean) => void): void {
  const own = fd === undefined ? fsOps.openRead(path) : undefined;
  const at = fd ?? own!;
  try {
    let position = 0, lineStart = 0;
    let carry: Buffer[] = [], carried = 0;
    for (;;) {
      const chunk = Buffer.alloc(CHUNK_BYTES);
      const got = fsOps.readAt(at, chunk, position);
      if (got <= 0) break;
      position += got;
      let from = 0;
      for (let end = chunk.indexOf(0x0a, from); end >= 0 && end < got; end = chunk.indexOf(0x0a, from)) {
        const piece = chunk.subarray(from, end);
        if (carried + piece.length > MAX_LINE_BYTES) throw new Error("a line is longer than Murage reads");
        const line = carried ? Buffer.concat([...carry, piece]) : piece;
        visit(line, lineStart, false);
        lineStart += line.length + 1;
        carry = []; carried = 0;
        from = end + 1;
      }
      if (from < got) {
        carry.push(chunk.subarray(from, got)); carried += got - from;
        if (carried > MAX_LINE_BYTES) throw new Error("a line is longer than Murage reads");
      }
    }
    if (carried) visit(Buffer.concat(carry), lineStart, true);
  } finally {
    if (own !== undefined) fsOps.closeFd(own);
  }
}

/** A line as an object, or null (blank, not an object, or a torn last line). A line that does not parse and names a needle throws. */
function parseRow(path: string, line: Buffer, needles: readonly string[], cut: boolean): Record<string, unknown> | null {
  const text = line.toString("utf8");
  if (!text.trim()) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch (error) {
    if (cut) return null;
    if (mentions(text, needles)) throw new PlanError(path, new Error("a line that names this conversation could not be parsed", { cause: error }));
    return null;
  }
}

function guarded<T>(path: string, work: () => T): T {
  try { return work(); } catch (error) { throw error instanceof PlanError ? error : new PlanError(path, error); }
}

/** The strict reader, over whatever `fsOps` is at the time of each call. */
export function realEngineFs(): EngineFs {
  const lstat = (path: string): Stats | null => {
    try { return fsOps.lstat(path) as Stats; } catch (error) {
      if (isAbsent(error)) return null;
      throw new PlanError(path, error);
    }
  };
  const plainFile = (path: string): Stats | null => {
    const stat = lstat(path);
    return stat && stat.isFile() && !stat.isSymbolicLink() ? stat : null;
  };
  return {
    lstat,
    readdir(path) {
      const stat = lstat(path);
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return [];
      return guarded(path, () => fsOps.readdir(path) as string[]);
    },
    readText(path) {
      if (!plainFile(path)) return null;
      return guarded(path, () => fsOps.readFile(path, "utf8") as string);
    },
    readBytes(path) {
      if (!plainFile(path)) return null;
      return guarded(path, () => fsOps.readFile(path) as Buffer);
    },
    readHead(path, bytes) {
      const stat = plainFile(path);
      if (!stat) return null;
      const buffer = guarded(path, () => fsOps.readHead(path, Math.min(bytes, stat.size)));
      return { text: buffer.toString("utf8"), cut: stat.size > bytes };
    },
    zstdFirstLine(path) {
      const stat = lstat(path);
      if (!stat || !stat.isFile()) return null;
      const bytes = guarded(path, () => fsOps.readFile(path) as Buffer);
      return guarded(path, () => fsOps.zstd(bytes).toString("utf8").split("\n", 1)[0] ?? "");
    },
    rolloutOwner(path, held) {
      const zst = /\.zst(?:\.murage-deleting)?$/.test(path);
      let bytes: Buffer;
      if (held !== undefined) {
        const size = typeof held === "number" ? fstatSync(held).size : held.size();
        bytes = guarded(path, () => preadRaw(held, zst ? size : Math.min(size, 1024 * 1024), 0));
      } else {
        const stat = plainFile(path);
        if (!stat) return "";
        bytes = guarded(path, () => (zst ? (fsOps.readFile(path) as Buffer) : fsOps.readHead(path, Math.min(stat.size, 1024 * 1024))));
      }
      const line = guarded(path, () => (zst ? fsOps.zstd(bytes) : bytes).toString("utf8").split("\n", 1)[0] ?? "");
      try { return rolloutEvidence(JSON.parse(line) as Parameters<typeof rolloutEvidence>[0]) ?? ""; } catch { return ""; }
    },
    readlink: (path) => guarded(path, () => fsOps.readlink(path) as string),
    withDb<T>(path: string, use: (db: DbReader) => T): T | null {
      if (!plainFile(path)) return null;
      const raw = guarded(path, () => fsOps.openDb(path));
      try {
        return use({ all: (sql, params = []) => guarded(path, () => raw.all(sql, params)) });
      } finally {
        raw.close();
      }
    },
    jsonLines: parseJsonLines,
    eachLine(path, visit, fd) {
      if (fd === undefined && !plainFile(path)) return false;
      guarded(path, () => streamLines(fd, path, visit));
      return true;
    },
    eachRow(path, needles, visit, fd) {
      if (fd === undefined && !plainFile(path)) return false;
      guarded(path, () => streamLines(fd, path, (line, offset, cut) => visit(parseRow(path, line, needles, cut), line, offset, cut)));
      return true;
    },
    jsonValue(path, text, needles) {
      if (!text.trim()) return undefined;
      try { return JSON.parse(text) as unknown; } catch (error) {
        if (mentions(text, needles)) throw new PlanError(path, new Error("a file that names this conversation could not be parsed", { cause: error }));
        return undefined;
      }
    },
  };
}
