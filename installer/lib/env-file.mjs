/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * The 0600 env file `murage setup` writes and `murage start` reads.
 *
 * Shape borrowed from Wayland's installer (same idea, same file mode); the
 * defaults are not. Wayland writes `ALLOW_REMOTE=true`, which is what makes its
 * server bind `0.0.0.0`. The base written here has no such key, and
 * `MURAGE_BIND_MODE=loopback` is the only thing it says about reachability.
 *
 * A setup rerun edits this file; it does not start it over. Setup reads and
 * validates what is there first (`inspectEnvFile`), changes only the fields it
 * selects, and publishes the result atomically, so an interrupted write leaves
 * the previous complete file. When the operator replaces a key, the previous
 * file is kept beside it (`retainRecoveryCopy`), because that key may have no
 * other copy.
 */

import { chmodSync, closeSync, existsSync, fchmodSync, fchownSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { NotPlainFile, atomicWriteFile, openOwnedDir, readRegularFile } from "./private-files.mjs";

/** @returns {number | null} */
function effectiveUid() {
  return typeof process.geteuid === "function" ? process.geteuid() : null;
}

/** Keys whose values must never be echoed to a terminal or a log. */
const SECRET_KEYS = /(_KEY|_TOKEN|_SECRET|AUTHKEY|PASSWORD)$/i;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** @param {string} key @returns {boolean} */
export function isSecretKey(key) {
  return SECRET_KEYS.test(key);
}

/**
 * Redact a bag for display. Used by `murage status`, which an operator will
 * paste into a bug report.
 * @param {Record<string, string>} bag
 * @returns {Record<string, string>}
 */
export function redact(bag) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(bag)) out[k] = isSecretKey(k) ? "<redacted>" : v;
  return out;
}

/**
 * Parse env-file text. Deliberately dumb: `KEY=value`, no quoting, no
 * interpolation, no `export`. Anything cleverer becomes a place for a shell
 * metacharacter to hide.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1);
  }
  return out;
}

/**
 * Serialise a bag. Refuses newlines in values — a newline would let one setting
 * inject another when the file is read back.
 * @param {Record<string, string>} bag
 * @param {string} [header]
 * @returns {string}
 */
export function serializeEnv(bag, header = "# Written by `murage setup`. Read by `murage start`. Mode 0600.") {
  const lines = [header];
  for (const [k, v] of Object.entries(bag)) {
    const value = String(v);
    if (/[\r\n]/.test(value)) throw new Error(`refusing to write ${k}: value contains a newline`);
    if (!ENV_KEY.test(k)) throw new Error(`refusing to write malformed env key ${JSON.stringify(k)}`);
    lines.push(`${k}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Read the existing file for a rewrite, and say what setup could not carry
 * over. A file with problems is not rewritten at all: dropping a line setup
 * does not understand is exactly the silent loss a rerun must not cause.
 * Problems name line numbers and never quote a line, which may hold a key.
 *
 * The file is read once, through an fd that does not follow a symlink, and
 * the bytes that were checked are returned as `bytes`. Everything later in
 * setup (the recovery copy included) uses those bytes rather than reading the
 * path again, because by then the path may be something else.
 * @param {string} path
 * @param {{ uid?: number | null }} [opts] when set, the account the file must belong to
 * @returns {{ exists: boolean, bag: Record<string, string>, problems: string[], bytes: Buffer | null }}
 */
export function inspectEnvFile(path, { uid = null } = {}) {
  let read;
  try {
    read = readRegularFile(path, { uid });
  } catch (error) {
    if (error instanceof NotPlainFile) return { exists: true, bag: {}, problems: [error.message], bytes: null };
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "EACCES") {
      return { exists: true, bag: {}, problems: [`${path} cannot be read by the account setup writes it for`], bytes: null };
    }
    throw error;
  }
  if (!read) return { exists: false, bag: {}, problems: [], bytes: null };
  const text = read.bytes.toString("utf8");
  /** @type {string[]} */
  const problems = [];
  text.split("\n").forEach((line, index) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    const i = t.indexOf("=");
    if (i <= 0) problems.push(`line ${index + 1} is not KEY=value`);
    else if (!ENV_KEY.test(t.slice(0, i).trim())) problems.push(`line ${index + 1} has a key that is not a valid name`);
  });
  return { exists: true, bag: problems.length ? {} : parseEnv(text), problems, bytes: read.bytes };
}

/**
 * Publish the env file: 0600, inside a 0700 directory, atomically.
 *
 * The bytes go to a new exclusive file beside the old one and are renamed
 * over it, so a reader (or a crash) sees the previous complete file or the new
 * complete file, never a truncated one; the permissions are set on the new
 * file itself rather than inherited from whatever was there.
 *
 * `owner` is the service account when setup runs as root on its behalf: the
 * file, and a directory this call had to create, are handed to that account
 * so the service can read them. Existing directories are not re-owned.
 *
 * The directory is checked through an fd, not by path. One that already
 * exists must be a real directory (not a symlink), owned by the account the
 * file is for, and writable by nobody else, or nothing is written. Only a
 * directory this call created has its mode changed: an existing one is never
 * chmodded, because a chmod by path follows a symlink planted in its place
 * (MURAGE_ENV_FILE=/etc/murage.env, or a data directory swapped for a link to
 * /etc, would otherwise make root chmod /etc). Setup tightens the data
 * directory itself, once, in `prepareDataDir`.
 * @param {string} path
 * @param {Record<string, string>} bag
 * @param {{ owner?: { uid: number, gid: number } | null, rename?: typeof renameSync }} [opts]
 */
export function writeEnvFile(path, bag, { owner = null, rename = renameSync } = {}) {
  const text = serializeEnv(bag);
  const dir = dirname(path);
  const created = mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    if (created) chmodSync(dir, 0o700);
  } else {
    const self = effectiveUid();
    // A directory this call just made belongs to this process until it is
    // handed over; one that already existed must already be the owner's.
    const { fd } = openOwnedDir(dir, { uid: created ? self : owner ? owner.uid : self });
    try {
      if (created) {
        fchmodSync(fd, 0o700);
        if (owner) fchownSync(fd, owner.uid, owner.gid);
      }
    } finally {
      closeSync(fd);
    }
  }
  atomicWriteFile(path, text, { mode: 0o600, owner, rename });
}

/**
 * Keep the previous file as `<path>.previous` (0600) before it is replaced.
 *
 * Pass `bytes`, the content `inspectEnvFile` read and checked. Reading the
 * path again here would read whatever is there now: when root runs setup for
 * the service account, that account owns the directory and has the whole
 * key prompt to swap the file for a symlink to /etc/shadow, which root would
 * then copy into a file the account can read. Without `bytes`, the path is
 * read once through a no-follow fd, and a symlink, a non-file, or a file
 * belonging to someone other than `owner` is refused.
 * @param {string} path
 * @param {{ owner?: { uid: number, gid: number } | null, bytes?: Buffer | string | null }} [opts]
 * @returns {string | null} the copy's path, or null when there was no file
 */
export function retainRecoveryCopy(path, { owner = null, bytes } = {}) {
  const source = bytes === undefined ? (readRegularFile(path, { uid: owner ? owner.uid : null })?.bytes ?? null) : bytes;
  if (source === null) return null;
  const copy = `${path}.previous`;
  atomicWriteFile(copy, source, { mode: 0o600, owner });
  return copy;
}

/** @param {string} path @returns {Record<string, string>} */
export function readEnvFile(path) {
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, "utf8"));
}

/**
 * Report the file's actual permission bits, so `murage status` can tell an
 * operator their key file went world-readable rather than assuming it did not.
 * @param {string} path
 * @returns {{ exists: boolean, mode: number | null, private: boolean }}
 */
export function envFilePermissions(path) {
  if (!existsSync(path)) return { exists: false, mode: null, private: false };
  const mode = statSync(path).mode & 0o777;
  return { exists: true, mode, private: (mode & 0o077) === 0 };
}
