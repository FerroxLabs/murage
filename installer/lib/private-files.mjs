/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Files this installer creates for itself: staged units, auth-key files, the
 * env file and the door nonce.
 *
 * Every one of them used to be written with `writeFileSync(path, …, { mode })`
 * at a predictable path. The `mode` option does not apply to a file that is
 * already there, so a file (or a symlink) planted at that path first kept its
 * owner, and the installer wrote through it. Three rules replace that:
 *
 *  - a temporary directory is created fresh, randomly named and 0700, and its
 *    owner and mode are read back before anything goes into it;
 *  - a new file is created with O_EXCL (and O_NOFOLLOW where the platform has
 *    it), so an existing file or symlink is refused rather than reused;
 *  - a file that replaces another is written beside it under a random name and
 *    renamed over it, so a reader sees the old complete file or the new
 *    complete file and never a truncated one.
 *
 * Root preparing files for the service account adds a fourth rule. The data
 * directory belongs to that account, which runs the agent runtime. Anything
 * root does there by path, the account can redirect between the check and the
 * use: it can rename the directory away and plant a symlink, or swap a file
 * for a link to /etc/shadow. Node has no openat(), so no amount of checking by
 * path closes that race. `asAccount` closes it: root takes the account's
 * effective uid, gid and groups for the duration of the file work, so the
 * worst any redirect reaches is what that account could already reach itself.
 * `readRegularFile` and `openOwnedDir` add a check that works from an fd
 * rather than from a path, so the object that was checked is the object used.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;

/** The errno a NOFOLLOW open of a symlink fails with (ELOOP on Linux and
 * macOS; EMLINK on FreeBSD), and ENOTDIR for an O_DIRECTORY open of a file. */
const NOT_PLAIN = new Set(["ELOOP", "EMLINK", "ENOTDIR", "EFTYPE"]);

export class NotPlainFile extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "NotPlainFile";
    this.code = "NOT_PLAIN_FILE";
  }
}

/**
 * Read a regular file through an fd opened without following a final
 * symlink, and check the object the fd refers to, not the path. O_NONBLOCK
 * keeps a FIFO planted at the path from hanging the open. Returns null when
 * the path does not exist.
 * @param {string} path
 * @param {{ uid?: number | null }} [opts] the owner the file must have
 * @returns {{ bytes: Buffer, uid: number, mode: number } | null}
 */
export function readRegularFile(path, { uid = null } = {}) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === "ENOENT") return null;
    if (code && NOT_PLAIN.has(code)) throw new NotPlainFile(`${path} is not a regular file (a symlink or something else)`);
    throw error;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new NotPlainFile(`${path} is not a regular file (a symlink or something else)`);
    if (uid !== null && st.uid !== uid) throw new NotPlainFile(`${path} is owned by uid ${st.uid}, not by uid ${uid}`);
    const chunks = [];
    const chunk = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      chunks.push(Buffer.from(chunk.subarray(0, n)));
    }
    return { bytes: Buffer.concat(chunks), uid: st.uid, mode: st.mode & 0o777 };
  } finally {
    closeSync(fd);
  }
}

/**
 * Check an existing directory before writing into it, through an fd opened
 * without following a final symlink: it must be a real directory, owned by
 * `uid`, and writable by nobody else (otherwise somebody else could replace
 * what is written there). Returns the open fd, which the caller closes; any
 * change of mode goes through that fd, never back through the path.
 * @param {string} dir
 * @param {{ uid?: number | null }} [opts]
 * @returns {{ fd: number, mode: number }}
 */
export function openOwnedDir(dir, { uid = effectiveUid() } = {}) {
  let fd;
  try {
    fd = openSync(dir, constants.O_RDONLY | NOFOLLOW | DIRECTORY);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code && NOT_PLAIN.has(code)) throw new NotPlainFile(`${dir} is not a plain directory (a symlink or something else); nothing is written through it`);
    throw error;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isDirectory()) throw new NotPlainFile(`${dir} is not a plain directory; nothing is written through it`);
    if (uid !== null && st.uid !== uid) {
      throw new NotPlainFile(`${dir} is owned by uid ${st.uid}, not by uid ${uid}; nothing is written into it`);
    }
    if (process.platform !== "win32" && (st.mode & 0o022) !== 0) {
      throw new NotPlainFile(`${dir} is writable by other accounts (mode 0${(st.mode & 0o777).toString(8)}); nothing is written into it`);
    }
    return { fd, mode: st.mode & 0o777 };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/**
 * Run `fn` with the effective uid, gid and groups of `account`, when this
 * process is root and `account` is not; otherwise just run it. The identity
 * is restored before this returns or throws. `fn` must be synchronous: every
 * file operation it makes is checked by the kernel against the account, not
 * against root.
 *
 * The real and saved uids stay 0, which is what allows the way back, and
 * which also keeps the account from ptracing or signalling the process while
 * it wears the account's identity.
 * @template T
 * @param {{ uid: number, gid: number, groups?: number[] } | null | undefined} account
 * @param {() => T} fn
 * @param {{ proc?: Pick<NodeJS.Process, "geteuid" | "getegid" | "getgroups" | "setgroups" | "setegid" | "seteuid"> }} [seams]
 * @returns {T}
 */
export function asAccount(account, fn, { proc = process } = {}) {
  if (!account || typeof proc.geteuid !== "function" || proc.geteuid() !== 0 || account.uid === 0) return fn();
  const egid = proc.getegid();
  const groups = proc.getgroups();
  const wanted = [...new Set([account.gid, ...(account.groups ?? [])])];
  /** @type {Array<() => void>} */
  const undo = [];
  try {
    proc.setgroups(wanted);
    undo.push(() => proc.setgroups(groups));
    proc.setegid(account.gid);
    undo.push(() => proc.setegid(egid));
    proc.seteuid(account.uid);
    undo.push(() => proc.seteuid(0));
    return fn();
  } finally {
    // Reverse order: euid 0 first, since only root can restore gid and groups.
    for (const step of undo.reverse()) step();
  }
}

/** @returns {number | null} */
function effectiveUid() {
  return typeof process.geteuid === "function" ? process.geteuid() : null;
}

/**
 * Prove a directory is a real directory, owned by this process, and private.
 * @param {string} dir
 * @param {{ uid?: number | null }} [opts]
 */
export function assertPrivateDir(dir, { uid = effectiveUid() } = {}) {
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a directory this installer created`);
  if (uid !== null && st.uid !== uid) throw new Error(`${dir} is owned by uid ${st.uid}, not by this process (uid ${uid})`);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    throw new Error(`${dir} is not private (mode 0${(st.mode & 0o777).toString(8)})`);
  }
  return st;
}

/**
 * A fresh, randomly named 0700 directory under `root`.
 * @param {string} prefix
 * @param {string} [root]
 * @returns {string}
 */
export function makePrivateTempDir(prefix, root = tmpdir()) {
  const dir = mkdtempSync(join(root, prefix));
  chmodSync(dir, 0o700);
  assertPrivateDir(dir);
  return dir;
}

/**
 * Create exactly this directory, 0700. Not recursive, so a path somebody
 * else already created, including a symlink, is refused.
 * @param {string} dir
 * @returns {string}
 */
export function makePrivateDir(dir) {
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  assertPrivateDir(dir);
  return dir;
}

/**
 * Create a new file and write all of `data` into it. Refuses an existing file
 * or symlink at `path`. On failure the partial file is removed.
 * @param {string} path
 * @param {string | Buffer} data
 * @param {{ mode?: number, owner?: { uid: number, gid: number } | null }} [opts]
 */
export function writeExclusiveFile(path, data, { mode = 0o600, owner = null } = {}) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode);
  let written = false;
  try {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    // Explicitly, because the mode passed to open() is masked by the umask.
    fchmodSync(fd, mode);
    if (owner) fchownSync(fd, owner.uid, owner.gid);
    fsyncSync(fd);
    written = true;
  } finally {
    closeSync(fd);
    if (!written) rmSync(path, { force: true });
  }
}

/**
 * Replace `path` with `data` atomically: a complete new file under a random
 * name in the same directory, then one rename. If anything fails before the
 * rename, the previous file is exactly as it was.
 * @param {string} path
 * @param {string | Buffer} data
 * @param {{ mode?: number, owner?: { uid: number, gid: number } | null, rename?: typeof renameSync }} [opts]
 */
export function atomicWriteFile(path, data, { mode = 0o600, owner = null, rename = renameSync } = {}) {
  const dir = dirname(path);
  const temp = join(dir, `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  writeExclusiveFile(temp, data, { mode, owner });
  try {
    rename(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  try {
    const handle = openSync(dir, "r");
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  } catch {
    // Not every platform can fsync a directory; the rename already happened.
  }
}
