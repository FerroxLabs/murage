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

import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { atomicWriteFile } from "./private-files.mjs";

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
 * @param {string} path
 * @returns {{ exists: boolean, bag: Record<string, string>, problems: string[] }}
 */
export function inspectEnvFile(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return { exists: false, bag: {}, problems: [] };
    throw error;
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return { exists: true, bag: {}, problems: [`${path} is not a regular file (a symlink or something else)`] };
  }
  const text = readFileSync(path, "utf8");
  /** @type {string[]} */
  const problems = [];
  text.split("\n").forEach((line, index) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    const i = t.indexOf("=");
    if (i <= 0) problems.push(`line ${index + 1} is not KEY=value`);
    else if (!ENV_KEY.test(t.slice(0, i).trim())) problems.push(`line ${index + 1} has a key that is not a valid name`);
  });
  return { exists: true, bag: problems.length ? {} : parseEnv(text), problems };
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
 * @param {string} path
 * @param {Record<string, string>} bag
 * @param {{ owner?: { uid: number, gid: number } | null, rename?: typeof renameSync }} [opts]
 */
export function writeEnvFile(path, bag, { owner = null, rename = renameSync } = {}) {
  const text = serializeEnv(bag);
  const dir = dirname(path);
  const created = mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (owner && created) chownSync(dir, owner.uid, owner.gid);
  chmodSync(dir, 0o700);
  atomicWriteFile(path, text, { mode: 0o600, owner, rename });
}

/**
 * Keep the current file as `<path>.previous` (0600) before it is replaced.
 * @param {string} path
 * @param {{ owner?: { uid: number, gid: number } | null }} [opts]
 * @returns {string | null} the copy's path, or null when there was no file
 */
export function retainRecoveryCopy(path, { owner = null } = {}) {
  if (!existsSync(path)) return null;
  const copy = `${path}.previous`;
  atomicWriteFile(copy, readFileSync(path), { mode: 0o600, owner });
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
