// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { gitFixture } from '../server/testing/git-fixture.mjs';
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';

it('archive fixtures copy the exact tracked inventory without ingesting private job output', () => {
  const source = mkdtempSync(join(tmpdir(), 'murage-fixture-inventory-'));
  let fixture;
  try {
    mkdirSync(join(source, 'server/testing'), { recursive: true });
    writeFileSync(join(source, 'server/testing/.git-ls-files.fixture'), 'tracked.txt\0');
    writeFileSync(join(source, 'tracked.txt'), 'tracked source');
    writeFileSync(join(source, 'private-job-output.txt'), 'untracked fixture data');
    fixture = gitFixture(undefined, { sourceRoot: source });
    expect(fixture.git('ls-files', '-z').split('\0').filter(Boolean)).toEqual(['tracked.txt']);
    expect(readFileSync(join(fixture.root, 'tracked.txt'), 'utf8')).toBe('tracked source');
    expect(existsSync(join(fixture.root, 'private-job-output.txt'))).toBe(false);
  } finally { fixture?.dispose(); safeWipeSync(source); }
});

it('explicit fixture inventories remain exact and refuse paths outside their source', () => {
  const source = mkdtempSync(join(tmpdir(), 'murage-fixture-inventory-'));
  let fixture;
  try {
    writeFileSync(join(source, 'tracked.txt'), 'source');
    writeFileSync(join(source, 'unselected.txt'), 'not selected');
    fixture = gitFixture(['tracked.txt'], { sourceRoot: source });
    expect(fixture.git('ls-files', '-z').split('\0').filter(Boolean)).toEqual(['tracked.txt']);
    expect(existsSync(join(fixture.root, 'unselected.txt'))).toBe(false);
    expect(() => gitFixture(['../outside.txt'], { sourceRoot: source })).toThrow('Invalid fixture inventory path');
  } finally { fixture?.dispose(); safeWipeSync(source); }
});
