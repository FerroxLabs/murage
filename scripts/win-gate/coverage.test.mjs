// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { windowsExclusions } from './coverage-guards.mjs';

// Release coverage contract: restoring a blanket skip must fail on Linux too.
const required = [
  'full-access-api', 'full-access-options-api', 'nolimits-owner-started-api', 'approve-all-http',
  'routine-permissions-api', 'routine-approval-hold-api', 'own-workspace-approval-wiring',
  'backup-waiting-api', 'backup-failure-notice-api', 'steer-queue-restore-api',
  'project-restore-admission', 'workspace-files-write-stopped-turn', 'engine-setup-check-api', 'engine-signin-api',
  'nolimits-node-109', 'installation-state-snapshot', 'installation-database-snapshot',
  'installation-damaged-export', 'restore-review-size', 'package-import-transaction',
  'attachment-read-http', 'attachment-remove-api', 'image-reference-resolver', 'claude-update-route', 'browser-owner-policy',
].map(name => `server/${name}.test.ts`);

describe('Windows approval and backup release coverage', () => {
  it.each(required)('%s is collected on Windows and belongs to the Windows gate', file => {
    const source = readFileSync(file, 'utf8');
    // These exact POSIX primitives have portable close-boundary twins below.
    const kernelOnly = file === 'server/nolimits-node-109.test.ts' ? [
      'a FIFO, or a link to one, asks',
      'a folder with a backslash in its name is checked as itself, never as `/` (Astra r7)',
    ] : file === 'server/project-restore-admission.test.ts' ? [
      "Stop then an immediate Restore waits for the stopped turn's engine to close, then restores",
      "a stopped turn that does not close within the engine's budget refuses the restore as still closing, and a retry after the close succeeds",
    ] : file === 'server/workspace-files-write-stopped-turn.test.ts' ? [
      "Stop then an immediate editor Save waits for the stopped turn's engine to close, then writes",
      "a stopped turn that does not close within the engine's budget refuses the Save as workspace_stopped_turn_closing, and a retry after the close writes",
    ] : [];
    // MAIN RULING INT-CONFLICT-DEFAULT 505dec8a83 / cccd5c1fd2: AST checks aliases and keeps true POSIX-only cases; all-platform close tests cover Windows.
    expect(windowsExclusions(source).filter(row => !(row.kind === 'test' && kernelOnly.includes(row.title)))).toEqual([]);
    const row = readFileSync('ci/gate-tests.txt', 'utf8').split('\n').find(line => line.startsWith(`${file}\t`));
    expect(row?.split('\t')[1]).toBe('all');
    expect(JSON.parse(readFileSync('scripts/win-gate/files.json', 'utf8'))).toContain(file);
  });
});
