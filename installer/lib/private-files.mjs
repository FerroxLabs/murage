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
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

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
