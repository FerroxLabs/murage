// SPDX-License-Identifier: AGPL-3.0-or-later
// Commands are permission data only. The decision transport is an inert fake.
import { afterEach, expect, it, vi } from 'vitest';
import { realpathSync } from 'node:fs';
import { autoVerdict } from './auto-approve.ts';
import { readExecutableOwnerNl } from './no-limits-code.ts';
import * as authority from './no-limits-authority.ts';
import { PyReader } from './no-limits-python.ts';
import { wipeFingerprint } from './decision/wipe-fingerprint.ts';
import { d, fixture, baseRun } from './decision/fixture.ts';
import { DATA_DIR } from './config.ts';

afterEach(() => vi.restoreAllMocks());
const noLimits = { autoApprove: true, fullAccess: true, noLimits: true };

it.each(['sudo srm -r /usr', 'srm -rf /usr', 'srm --recursive /usr'])(
  'review High: secure recursive removal requires owner approval: %s', async command => {
    const input = { command, cwd: DATA_DIR };
    const evidence = readExecutableOwnerNl('sh', command, undefined, 0, DATA_DIR);
    expect.soft(evidence.targets).toEqual(expect.arrayContaining([
      { path: '/usr', op: 'write' }, { path: '/usr', op: 'delete' },
    ]));
    expect.soft(autoVerdict(noLimits, 'Bash', command, {
      fullAccessOrigin: 'owner', commandText: command, commandCwd: DATA_DIR,
    })).toMatchObject({ approve: null, source: 'always-ask', rule: 'delete-system-folder' });
    const f = fixture();
    try {
      const outcome = d.decide(f.open('secure-removal', input), baseRun);
      expect(outcome.kind).toBe('card');
      expect(f.respond).not.toHaveBeenCalled();
      if (outcome.kind !== 'card') throw Error('owner approval required');
      await d.presentApproval(outcome.ref, { title: 'Approval', subtitle: 'Inert fixture' });
      await d.answerApproval(outcome.ref, { behavior: 'allow' });
      expect(f.respond).toHaveBeenCalledOnce();
    } finally { f.dispose(); }
  },
);

it.each(['srm -r ./ordinary-tree', 'truncate -s 0 /etc/hosts', 'shred -u ./ordinary-file'])(
  'review High control: ordinary overwrites remain allowed: %s', command => {
    expect(autoVerdict(noLimits, 'Bash', command, {
      fullAccessOrigin: 'owner', commandText: command, commandCwd: DATA_DIR,
    }).approve).toBeTruthy();
  },
);

it('review Medium: release fingerprints ignore optional protected-path diagnostics and retain semantic targets', () => {
  const operation = { kind: 'code' as const, lang: 'py' as const,
    text: `import subprocess; subprocess.run(['rm', '-rf', ${JSON.stringify(DATA_DIR)}])`, cwd: DATA_DIR, cwdInvalid: false };
  const before = wipeFingerprint(operation, 'delete-system-folder');
  expect(before.resolvedTargets).toContain(realpathSync.native(DATA_DIR));
  const diagnostic = vi.spyOn(authority, 'inspectOwnerTargets').mockReturnValue({ version: 1, decisions: [], exhausted: true });
  expect(readExecutableOwnerNl('py', operation.text, undefined, 0, DATA_DIR).authority.exhausted).toBe(true);
  expect(diagnostic).toHaveBeenCalledOnce();
  expect(wipeFingerprint(operation, 'delete-system-folder')).toEqual(before);
  expect(diagnostic).toHaveBeenCalledOnce();
});

it('review Medium control: an incomplete semantic walk cannot mint a release fingerprint', () => {
  vi.spyOn(PyReader.prototype, 'run').mockImplementation(() => { throw Error('injected semantic reader failure'); });
  expect(() => wipeFingerprint({ kind: 'code', lang: 'py', text: "import subprocess; subprocess.run(['rm', '-rf', '/usr'])",
    cwd: DATA_DIR, cwdInvalid: false }, 'delete-system-folder')).toThrow();
});
