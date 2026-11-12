// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

it('Medium: C3 qualification maps every baseline probe to a pinned starting-commit assertion failure', () => {
  const qualification = JSON.parse(readFileSync('evidence/nlsym-build-B/C3-QUALIFICATION.json', 'utf8'));
  expect(qualification.startingCommitRed).toBeDefined();
  const mapping = JSON.parse(readFileSync(qualification.startingCommitRed.mapping, 'utf8'));
  expect(mapping.baseline).toBe('ff106a925d56be3bbeb06f4d57528f470063d454');
  const harness = readFileSync(mapping.harness);
  expect(createHash('sha256').update(harness).digest('hex')).toBe(mapping.harnessSha256);
  expect(mapping.rows.length).toBeGreaterThanOrEqual(40);
  expect(new Set(mapping.rows.map((row: any) => row.id)).size).toBe(mapping.rows.length);
  for (const row of mapping.rows) {
    expect(row.baseline.assertionFailed, row.id).toBe(true);
    expect(row.baseline.error, row.id).toContain('AssertionError');
    expect(row.candidate.passed, row.id).toBe(true);
    expect(row.assertion, row.id).toBeTruthy();
    expect(row.designRows.length, row.id).toBeGreaterThan(0);
  }
  expect(existsSync(qualification.startingCommitRed.log)).toBe(true);
});

it('Low: the C3 report inventories the added presentation and diagnostic English strings', () => {
  const report = readFileSync('evidence/nlsym-build-B/C3-REPORT.md', 'utf8');
  for (const text of ['This writes a protected path.', 'executable inspection overflow', 'code inspection overflow', 'shell inspection overflow', 'fork bomb']) {
    expect(report).toContain('`' + text + '`');
  }
  expect(report).toContain('diagnostic');
});

it('B3 Medium pins protected A01/A04 hazards, destination anchors and independent archive effects', () => {
  const mapping = JSON.parse(readFileSync('evidence/nlsym-build-B/afix/starting-commit-mapping.json', 'utf8'));
  const rows = new Map<string, any>(mapping.rows.map((row: any) => [row.id, row]));
  for (const [id, design, anchor] of [
    ['A01-no-clobber-hazard', 'A01', 'moved'],
    ['A04-recursive-hazard', 'A04', 'out/src/h'],
  ]) {
    const row = rows.get(id!);
    expect(row, id).toBeDefined();
    expect(row.designRows).toContain(design);
    expect(row.input).toContain('/etc/hosts');
    expect(row.assertion).toContain('protected');
    expect(row.assertion).toContain(anchor);
  }
  const effects = [
    [['/etc/list', 'write', true]],
    [['./a.tar', 'write', true], ['/etc/b.tar', 'write', true]],
    [['./a.tar', 'write', true], ['/etc/snapshot', 'write', true]],
    [['./a.tar', 'write', true], ['/etc/hosts', 'delete', false]],
    [['$CWD/./out', 'write', true], ['/etc/hosts', 'write', true]],
    [['-', 'write', true]],
    [['/etc', 'write', true]],
  ];
  for (const [index, expected] of effects.entries()) {
    expect(rows.get(`archive-${index + 1}`).assertion).toBe(`exact archive effects ${JSON.stringify(expected)}`);
  }
});
