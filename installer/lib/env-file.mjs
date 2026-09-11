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
 */

import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Keys whose values must never be echoed to a terminal or a log. */
const SECRET_KEYS = /(_KEY|_TOKEN|_SECRET|AUTHKEY|PASSWORD)$/i;

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
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`refusing to write malformed env key ${JSON.stringify(k)}`);
    lines.push(`${k}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Write the env file 0600 inside a 0700 directory.
 *
 * `chmodSync` is called explicitly after each write: the `mode` option on
 * `mkdirSync`/`writeFileSync` is masked by the process umask, so on a box with
 * a permissive umask the "0600" would silently come out 0644 — and this file
 * holds provider API keys.
 *
 * `owner` is the service account when setup runs as root on its behalf: the
 * file, and a directory this call had to create, are handed to that account
 * so the service can read them. Existing directories are not re-owned.
 * @param {string} path
 * @param {Record<string, string>} bag
 * @param {{ owner?: { uid: number, gid: number } | null }} [opts]
 */
export function writeEnvFile(path, bag, { owner = null } = {}) {
  const dir = dirname(path);
  const created = mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (owner && created) chownSync(dir, owner.uid, owner.gid);
  chmodSync(dir, 0o700);
  writeFileSync(path, serializeEnv(bag), { mode: 0o600 });
  chmodSync(path, 0o600);
  if (owner) chownSync(path, owner.uid, owner.gid);
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
