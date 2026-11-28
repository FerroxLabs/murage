// SPDX-License-Identifier: AGPL-3.0-or-later
// OVERREACH #6 (MAIN-RULING 2026-11-27T01:45Z (2)): at No limits the decision layer (describeNoLimits and the release guard, the production
// path of every No limits request) cards a script this session wrote that deletes the home folder, and a whole mounted volume, as a wipe.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { d, fixture, baseRun } from './fixture.ts';
import { beginOutsideTurn, noteSessionEdit, restartOutsideForTests, wireOutsideStore } from '../email/external-marks.ts';
import { fileOutsideStore } from '../outside-store.ts';
import { installWipeContextReader } from '../wipe/context.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'overreach6-dec-'));
  expect(wireOutsideStore(fileOutsideStore(join(dir, 'outside.jsonl')))).toBe(true);
  beginOutsideTurn('t', 'p', 'turn', false);
  writeFileSync(join(dir, 'wipe.sh'), 'rm -rf ~\n');
  writeFileSync(join(dir, 'fine.sh'), 'echo fine\n');
  for (const name of ['wipe.sh', 'fine.sh', 'gone.sh']) noteSessionEdit('t', 'p', join(dir, name));
});
afterEach(() => { restartOutsideForTests(); rmSync(dir, { recursive: true, force: true }); });

it.each([
  ['a written script that deletes the home folder', 'wipe.sh', true],
  ['a written script whose file cannot be read', 'gone.sh', true],
  ['a written script that deletes nothing', 'fine.sh', false],
])('No limits decision: %s', async (_label, name, cards) => {
  const f = fixture();
  try {
    const h = f.open('r', { command: `bash ${join(dir, name)}` });
    const out = d.decide(h, baseRun);
    expect(out.kind).toBe(cards ? 'card' : 'run');
    if (!cards) return;
    if (out.kind !== 'card') throw Error('wipe card required');
    await d.presentApproval(out.ref, { title: 'Wipe', subtitle: 'Fixture' });
    expect(d.readApproval(out.ref.approvalId)).toMatchObject({ why: 'wipe' });
    await d.deliverRequest(h);
    expect(f.respond).not.toHaveBeenCalled();
    await d.answerApproval(out.ref, { behavior: 'allow' });
    expect(f.respond).toHaveBeenCalledOnce();
  } finally { f.dispose(); }
});

it.each(['rm -rf /Volumes/Backup', 'rm -rf /mnt/backup'])('No limits decision: %s (a mounted volume) is a wipe card', (command) => {
  const f = fixture();
  const uninstall = installWipeContextReader(() => ({
    mountInventory: { contains: (path: string) => path === '/Volumes/Backup' || path === '/mnt/backup' },
    pathPort: { realpath: (path: string) => path, isBlockDevice: () => null, stat: () => ({ dev: 1, ino: 1 }), lstat: () => ({ dev: 1, ino: 1 }) },
  }));
  try { expect(d.decide(f.open('r', { command }), baseRun).kind).toBe('card'); } finally { uninstall(); f.dispose(); }
});
it('No limits decision: a folder inside a volume runs', () => {
  const f = fixture();
  try { expect(d.decide(f.open('r', { command: 'rm -rf /mnt/backup/old' }), baseRun).kind).toBe('run'); } finally { f.dispose(); }
});
