// SPDX-License-Identifier: AGPL-3.0-or-later
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { isAbsolute, win32 } from 'node:path';
import { windowsAclCheck, windowsAclRestrict } from '../sentinel/win-acl.ts';

export function secureGuardFilePath(path: string): void {
  if (process.platform === 'win32' && (!windowsAclRestrict(path) || windowsAclCheck(path) !== 'owner-only')) throw Error('wipe-guard-private-path-required');
}

export interface GuardFile {
  v: 1;
  socket: string;
  threadId: string;
  token: string;
  roots: readonly string[];
  client: readonly [string, string, ...string[]];
  realTools: Readonly<Record<string, string>>;
  off: boolean;
}
// 1 MiB: room for GUARD_LIMITS.roots (8192) work folders at their real length (about 110 bytes each). client.mjs MAX_GUARD and the
// shim reader (shim/guard-lib.sh) carry the same number; routine-workfolders-1020.test.ts holds the three together.
export const MAX_GUARD_FILE_BYTES = 1024 * 1024;
const absolute = (value: string) => isAbsolute(value) || win32.isAbsolute(value);

/** Create only in the random private turn directory; never overwrite a stale file. */
export function writeGuardFile(file: string, data: GuardFile): () => void {
  if (!data.client.every(absolute) || !Object.values(data.realTools).every(absolute)) throw Error('wipe-guard-absolute-client-and-tools-required');
  const text = JSON.stringify(data) + '\n';
  if (Buffer.byteLength(text) > MAX_GUARD_FILE_BYTES) throw Error('wipe-guard-file-too-large');
  const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  let identity: Stats;
  try { secureGuardFilePath(file); writeFileSync(fd, text); identity = fstatSync(fd); }
  catch (error) { unlinkSync(file); throw error; }
  finally { closeSync(fd); }
  return () => {
    try {
      const current = lstatSync(file);
      // Do not remove a replacement belonging to another turn, even at the same path.
      if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) return;
      if ((JSON.parse(readFileSync(file, 'utf8')) as GuardFile).token !== data.token) return;
      unlinkSync(file);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
}
