// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { describeOwnerNoLimits as describeAction } from './decision/action.ts';
import { readExecutableOwnerNl as readExecutable } from './no-limits-code.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';

// Reader inputs only: neither archives nor requested commands are executed.
const evidence = (command: string) => protectedEvidence(describeAction({ tool: 'Bash', input: { command, cwd: '/w' } }));

describe('BLOCK 1: executable spelling cannot bypass archive writes', () => {
  const spellings = [String.raw`t\ar`, 't""ar', "t'ar'", '/bin/t""ar', String.raw`un\zip`, 'u""nzip', 'un"zi"p'];
  for (const spelling of spellings) {
    const tar = !spelling.startsWith('u');
    it.each([['/etc', true], ['/w/out', false]] as const)('%s destination with ' + spelling, (root, held) => {
      const command = tar ? `${spelling} -xf /tmp/a -C ${root}` : `${spelling} /tmp/a.zip -d ${root}`;
      expect(!!noLimitsProtectedWrite(command, { commandCwd: '/w' }), 'compatibility twin').toBe(held);
      expect(evidence(command).length > 0, 'S1 twin').toBe(held);
    });
    it('keeps read-only mode for ' + spelling, () => {
      expect(evidence(tar ? `${spelling} -tf /etc/a.tar` : `${spelling} -t /etc/a.zip`)).toEqual([]);
    });
  }
});

describe('BLOCK 2: protected member tails survive bounded projection', () => {
  for (const count of [126, 127, 128, 129, 256]) {
    for (const climb of [false, true]) {
      it.each([['etc', true], ['ordinary', false]] as const)(`${count} members, climb=${climb}, tail=%s`, (folder, held) => {
        const member = `${climb ? '..' : ''}/${folder}/hosts`;
        const command = `tar -xPf /tmp/a ${Array.from({ length: count }, (_, i) => `member${i}`).join(' ')} ${member}`;
        expect(!!noLimitsProtectedWrite(command, { commandCwd: '/w' }), 'compatibility twin').toBe(held);
        expect(readExecutable('sh', command, undefined, 0, '/w').targets.some(t => t.path.endsWith(member)), 'all destinations reach policy').toBe(true);
        const action = describeAction({ tool: 'Bash', input: { command, cwd: '/w' } });
        expect(action.targets.length, 'display projection remains bounded').toBeLessThanOrEqual(256);
        expect(protectedEvidence(action).length > 0, 'protected tail reaches S1 policy').toBe(held);
      });
    }
  }
});

describe('BLOCK 3: unreadable commands retain subsequent concrete extraction', () => {
  for (const prefix of ['set --;', 'shift;', 'set -- &&', 'set --\n']) {
    for (const archive of ['tar', 'unzip']) {
      it.each([['/etc', true], ['/w/out', false]] as const)(`${prefix} ${archive} to %s`, (root, held) => {
        const command = `${prefix} ${archive === 'tar' ? `tar -xf /tmp/a -C ${root}` : `unzip /tmp/a.zip -d ${root}`}`;
        expect(evidence(command).length > 0).toBe(held);
      });
    }
  }
  it.each([
    'set --; tar -tf /etc/a.tar',
    'set --; unzip -t /etc/a.zip',
    'set --; echo "tar -xf /tmp/a -C /etc"',
    'set --; echo "unzip /tmp/a.zip -d /etc"',
    'set --; tar -xf /tmp/a -C relative',
    'set --; unzip /tmp/a.zip -d relative',
  ])('keeps ordinary or data work running: %s', command => {
    expect(evidence(command)).toEqual([]);
  });
});

// MAIN r2 H1/r2.1: owner evidence is authoritative; legacy protectedEvidence stays Full access.
import { ownerNlProtectedEvidence } from './no-limits-authority.ts';
const protectedEvidence=(action:ReturnType<typeof describeAction>)=>ownerNlProtectedEvidence(action.ownerAuthority);
