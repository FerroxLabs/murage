// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { constants, openSync, closeSync, fstatSync, readFileSync, lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { digest } from './binary-digest.mjs';
export { digest };
const fail = message => { throw Error('Signal runtime: ' + message); };
export function safePath(path) {
  if (typeof path !== 'string' || !/^[A-Za-z0-9_@.+/-]+$/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) fail('invalid artifact path');
  return path;
}
export function readRegular(path) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const st = fstatSync(fd); if (!st.isFile() || st.nlink !== 1) fail('artifact must be a regular unshared file'); return readFileSync(fd); }
  finally { closeSync(fd); }
}
/** Stable sorted tree digest: SHA256(JSON.stringify(rows)); symlink rows pin
 * their relative target and must resolve inside this tree. File rows pin bytes
 * and executable bits (zero on Windows, where executable modes do not apply). */
export function treeRecords(root, { exclude = [] } = {}) {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) fail("artifact root must be a directory");
  const records = [];
  const walk = dir => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path), rel = relative(root, path).split(sep).join("/");
      if (exclude.includes(rel)) continue;
      safePath(rel);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path).split(sep).join("/");
        const actual = relative(realpathSync(root), realpathSync(path));
        if (!actual || isAbsolute(actual) || actual === ".." || actual.startsWith(`..${sep}`) || resolve(root, actual) !== realpathSync(path)) fail("artifact link escapes its tree");
        records.push({ path: rel, link: target });
      } else if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        const bytes = readRegular(path);
        records.push({ path: rel, bytes: bytes.length, sha256: digest(bytes), executable: process.platform === "win32" ? 0 : stat.mode & 0o111 });
      } else fail("unsupported artifact file type");
    }
  };
  walk(root); return records;
}
export const treeDigest = root => digest(JSON.stringify(treeRecords(root)));
