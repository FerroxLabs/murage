// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { MAX_GUARD_FILE_BYTES, writeGuardFile, type GuardFile } from './guard-file.ts';
const parents: string[] = [];
afterEach(() => { for (const path of parents.splice(0)) removeTempDirSync(path); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'wg-file-')); parents.push(directory);
  const file = join(directory, 'guard.json');
  const data: GuardFile = { v: 1, socket: join(directory, 's.sock'), threadId: 'fixture-thread', token: randomBytes(32).toString('hex'),
    roots: [directory], client: [process.execPath, join(directory, 'client.mjs')], realTools: { rm: process.execPath }, off: false };
  return { file, data, directory };
}
it('writes the MAIN addendum schema in one compact JSON line and removes the owned file', () => {
  const { file, data } = fixture(), remove = writeGuardFile(file, data);
  expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(data) + '\n');
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  remove(); remove(); expect(existsSync(file)).toBe(false);
});
it('never overwrites a stale file', () => {
  const { file, data } = fixture(); writeFileSync(file, 'stale-fixture', { mode: 0o600 });
  expect(() => writeGuardFile(file, data)).toThrow(); expect(readFileSync(file, 'utf8')).toBe('stale-fixture');
});
it('removal cannot unlink a replacement from a later turn', () => {
  const { file, data, directory } = fixture(), remove = writeGuardFile(file, data);
  renameSync(file, join(directory, 'old.json'));
  writeFileSync(file, JSON.stringify({ ...data, token: randomBytes(32).toString('hex') }), { mode: 0o600 });
  remove(); expect(existsSync(file)).toBe(true);
});
it('requires absolute shipped client argv and resolved real-tool paths', () => {
  const { file, data } = fixture();
  expect(() => writeGuardFile(file, { ...data, client: ['node', 'client.mjs'] })).toThrow('absolute');
  expect(() => writeGuardFile(file, { ...data, realTools: { rm: 'rm' } })).toThrow('absolute');
  expect(existsSync(file)).toBe(false);
});
it('bounds the emitted guard file before creating it', () => {
  const { file, data } = fixture();
  expect(() => writeGuardFile(file, { ...data, roots: ['x'.repeat(MAX_GUARD_FILE_BYTES)] })).toThrow('too-large'); expect(existsSync(file)).toBe(false);
});
