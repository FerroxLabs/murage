// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DATA_DIR, EVENTS_DIR, NATIVE_DIR, ensureDirs } from './config.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
import { createPrivateWindowsDirectories } from './windows-private-directory.ts';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.restoreAllMocks(); });
it('F2 ensureDirs boots a fresh Windows data root when whoami fails, retaining app data and warning once', async () => {
  removeTempDirSync(DATA_DIR);
  const runner = vi.fn(() => { throw Error('native security tools disabled'); });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  expect(() => ensureDirs({ run: runner })).not.toThrow();
  // ensureDirs starts ACL repair without blocking startup. Join that exact
  // in-flight repair before checking its warning, rather than awaiting void.
  await createPrivateWindowsDirectories([DATA_DIR, EVENTS_DIR, NATIVE_DIR], { run: runner, retryProtection: true });
  expect([DATA_DIR, EVENTS_DIR, NATIVE_DIR].every(existsSync)).toBe(true);
  const record = join(EVENTS_DIR, 'startup-fixture.json');
  writeFileSync(record, '{"history":"retained"}');
  expect(() => ensureDirs({ run: runner })).not.toThrow();
  expect(readFileSync(record, 'utf8')).toBe('{"history":"retained"}');
  expect(runner).toHaveBeenCalled();
  expect(warn).toHaveBeenCalledTimes(1);
});
