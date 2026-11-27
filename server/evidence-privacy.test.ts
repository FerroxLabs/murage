// secret-scan: fixture
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { gitFixture } from './testing/git-fixture.mjs';

// @ts-expect-error Custody tooling is shared with the Node index gate.
import { candidatePaths, retiredEvidencePath } from '../scripts/check-repository-custody.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const privateText = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}|\\?\/(?:root|Users)\\?\//;
function inspectEvidence(checkout: string) {
  const paths: string[] = candidatePaths(checkout);
  const retired = paths.filter(path => retiredEvidencePath(path));
  const retained = paths.filter(path => path.startsWith('docs/verification/') && /(?:evidence|proof)(?:[-.]|$)/i.test(path)
    && lstatSync(join(checkout, path), { throwIfNoEntry: false })?.isFile());
  const offenders = retained.filter(path => {
    const bytes = readFileSync(join(checkout, path));
    return !bytes.includes(0) && privateText.test(bytes.toString('utf8'));
  });
  return { retired, retained, offenders };
}

test('M5 repository evidence contains no email addresses or private home paths', () => {
  const { retired, retained, offenders } = inspectEvidence(root);
  expect(retired).toEqual([]);
  expect(retained).toContain('docs/verification/signal-sync-proof.json');
  expect(offenders).toEqual([]);
});

test('M5 ignores the historical checkout but scans retained proof and rejects staged receipts', () => {
  const fixture = gitFixture([]);
  try {
    const retained = 'docs/verification/signal-sync-proof.json';
    const historical = '.vrel-ref/docs/verification/evidence/old.json';
    for (const [path, content] of [[retained, 'owner@example.test'], [historical, '{}']]) {
      mkdirSync(dirname(join(fixture.root, path)), { recursive: true });
      writeFileSync(join(fixture.root, path), content);
    }
    fixture.git('add', '--force', retained);
    expect(inspectEvidence(fixture.root)).toEqual({ retired: [], retained: [retained], offenders: [retained] });
    fixture.git('add', '--force', historical);
    expect(inspectEvidence(fixture.root).retired).toEqual([historical]);
  } finally {
    fixture.dispose();
  }
});

test('M5 the evidence guard catches email addresses, POSIX homes and JSON-escaped paths', () => {
  for (const value of ['owner@example.test','/root/build/data','/Users/owner/data','{"path":"/root/build"}', String.raw`\/Users\/owner\/file`]) expect(privateText.test(value)).toBe(true);
  expect(privateText.test('REDACTED_EMAIL /home/build/evidence /fixture-home/data')).toBe(false);
});
