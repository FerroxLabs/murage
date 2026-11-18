// secret-scan: fixture
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const privateText = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}|\\?\/(?:root|Users)\\?\//;
function evidenceFiles(dir: string, inside = false): string[] {
  return readdirSync(dir, {withFileTypes:true}).flatMap(entry => {
    if (entry.isSymbolicLink()) return [];
    if (!inside && ['node_modules','.git','.test-tmp','dist','build','.cache'].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return evidenceFiles(path, inside || entry.name.includes('evidence'));
    return inside && entry.isFile() ? [path] : [];
  });
}
test('M5 repository evidence contains no email addresses or private home paths', () => {
  const files = evidenceFiles(root);
  expect(files.length).toBeGreaterThan(100);
  const offenders = files.filter(path => {
    const bytes = readFileSync(path);
    return !bytes.includes(0) && privateText.test(bytes.toString('utf8'));
  }).map(path => relative(root, path));
  expect(offenders).toEqual([]);
});
test('M5 the evidence guard catches email addresses, POSIX homes and JSON-escaped paths', () => {
  for (const value of ['owner@example.test','/root/build/data','/Users/owner/data','{"path":"/root/build"}', String.raw`\/Users\/owner\/file`]) expect(privateText.test(value)).toBe(true);
  expect(privateText.test('REDACTED_EMAIL /home/build/evidence /fixture-home/data')).toBe(false);
});
