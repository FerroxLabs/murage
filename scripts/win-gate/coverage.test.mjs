// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Release coverage contract: restoring a blanket skip must fail on Linux too.
const required = [
  'full-access-api', 'full-access-options-api', 'nolimits-owner-started-api', 'approve-all-http',
  'routine-permissions-api', 'routine-approval-hold-api', 'own-workspace-approval-wiring',
  'backup-waiting-api', 'backup-failure-notice-api', 'steer-queue-restore-api',
  'project-restore-admission', 'engine-setup-check-api', 'engine-signin-api',
  'nolimits-node-109', 'installation-state-snapshot', 'installation-database-snapshot',
  'installation-damaged-export', 'restore-review-size', 'package-import-transaction',
  'attachment-read-http', 'attachment-remove-api', 'image-reference-resolver', 'claude-update-route', 'browser-owner-policy',
].map(name => `server/${name}.test.ts`);

describe('Windows approval and backup release coverage', () => {
  it.each(required)('%s is collected on Windows and belongs to the Windows gate', file => {
    const source = readFileSync(file, 'utf8');
    expect(source).not.toMatch(/describe\.skipIf\(process\.platform === ["']win32["']\)/);
    const row = readFileSync('ci/gate-tests.txt', 'utf8').split('\n').find(line => line.startsWith(`${file}\t`));
    expect(row?.split('\t')[1]).toBe('all');
    expect(JSON.parse(readFileSync('scripts/win-gate/files.json', 'utf8'))).toContain(file);
  });
});
