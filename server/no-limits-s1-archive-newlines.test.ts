// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { describeOwnerNoLimits as describeAction } from './decision/action.ts';
import { shellPathTargetsOwnerNl as shellPathTargets, simpleCommandsOwnerNl as simpleCommands } from './no-limits-shell.ts';

const separators = ['\n', '\n\n', '\r\n', ';', '&&', '||', '|', '&'];
const extraction = (archive: string, root: string) => archive === 'tar'
  ? `tar -xf /tmp/a -C ${root}` : `unzip /tmp/a.zip -d ${root}`;

describe('Round 3: stopped-walker archive command boundaries', () => {
  for (const separator of separators) {
    for (const archive of ['tar', 'unzip']) {
      it.each([['/etc', true], ['./out', false]] as const)(
        `${archive} after ${JSON.stringify(separator)} to %s`, (root, held) => {
          // No indentation after the separator: the old test's inserted space
          // accidentally concealed the merged --\ntar token.
          const command = `set --${separator}${extraction(archive, root)}`;
          expect(shellPathTargets(command, '/w').some(target => target.op === 'write' && target.path.endsWith(root))).toBe(true);
          const action = describeAction({ tool: 'Bash', input: { command, cwd: '/w' } });
          expect(protectedEvidence(action).length > 0).toBe(held);
        },
      );
    }
    it(`retains read-only modes after ${JSON.stringify(separator)}`, () => {
      for (const command of ['tar -tf /etc/a.tar', 'unzip -t /etc/a.zip']) {
        expect(protectedEvidence(describeAction({ tool: 'Bash', input: { command: `set --${separator}${command}`, cwd: '/w' } }))).toEqual([]);
      }
    });
    it.each(["'", '"'])(`keeps ${JSON.stringify(separator)} inside %s quoted data`, quote => {
      const data = `ordinary${separator}tar -xf /tmp/a -C /etc`;
      const command = `set --;echo ${quote}${data}${quote}`;
      expect(simpleCommands(command)).toEqual([['set', '--'], ['echo', data]]);
      expect(protectedEvidence(describeAction({ tool: 'Bash', input: { command, cwd: '/w' } }))).toEqual([]);
    });
  }

  it('does not split an escaped separator into executable code', () => {
    expect(simpleCommands('echo ordinary\\;tar')).toEqual([['echo', 'ordinary;tar']]);
  });
  it('joins a backslash-newline continuation within an executable name', () => {
    const command = 'set --\nt\\\nar -xf /tmp/a -C /etc';
    expect(simpleCommands(command)).toEqual([['set', '--'], ['tar', '-xf', '/tmp/a', '-C', '/etc']]);
    expect(protectedEvidence(describeAction({ tool: 'Bash', input: { command, cwd: '/w' } })).length).toBeGreaterThan(0);
  });
});

// MAIN r2 H1/r2.1: owner evidence is authoritative; legacy protectedEvidence stays Full access.
import { ownerNlProtectedEvidence } from './no-limits-authority.ts';
const protectedEvidence=(action:ReturnType<typeof describeAction>)=>ownerNlProtectedEvidence(action.ownerAuthority);
