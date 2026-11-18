// SPDX-License-Identifier: AGPL-3.0-or-later
// Commands are inert reader inputs; only isolated directory links are created.
import { mkdtempSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { alwaysAskCommand } from './always-ask.ts';
import { autoVerdict } from './auto-approve.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
import { withoutDoubts } from './shell/marks.ts';

// Full access uses the legacy reader with closed-list doubts disabled.
const fullRead = (command: string, cwd: string) => withoutDoubts(() => alwaysAskCommand(command, cwd));

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
function links() {
  const cwd = mkdtempSync(join(tmpdir(), 'projected-writes-'));
  roots.push(cwd);
  symlinkSync('/etc', join(cwd, 'directory'));
  symlinkSync('/etc/hosts', join(cwd, 'file'));
  symlinkSync('loop', join(cwd, 'loop'));
  return cwd;
}

it.each([
  'tar -xPf /tmp/a.tar ../etc/hosts',
  'tar -xPf /tmp/a.tar -C /w ../etc/hosts',
  'tar -xPf /tmp/a.tar /etc/hosts',
  "bash -c 'tar -xPf /tmp/a.tar ../etc/hosts'",
])('Full access holds an extracted protected member: %s', command => {
  expect(fullRead(command, '/w')).toMatchObject({ rule: 'protected-path', protectedClass: 'system' });
  expect(autoVerdict({ autoApprove: true, fullAccess: true }, 'Bash', command,
    { commandText: command, commandCwd: '/w', fullAccessOrigin: 'owner', stopLine: null, outsideRead: null }).approve).toBeNull();
});

it.each([
  'ln -sf /tmp/blob ./directory',
  'ln --symbolic --force /tmp/blob ./directory',
  'ln -sf /tmp/blob ./directory/',
  'ln -s -t ./directory /tmp/blob',
  "bash -c 'ln -sf /tmp/blob ./directory'",
])('Full access holds placement through a directory link: %s', command => {
  const cwd = links();
  expect(fullRead(command, cwd)).toMatchObject({ rule: 'protected-path', protectedClass: 'system' });
  expect(autoVerdict({ autoApprove: true, fullAccess: true }, 'Bash', command,
    { commandText: command, commandCwd: cwd, fullAccessOrigin: 'owner', stopLine: null, outsideRead: null }).approve).toBeNull();
});

it.each([
  'ln -sfn /tmp/blob ./directory',
  'ln -sfT /tmp/blob ./directory',
  'ln -sf --no-dereference /tmp/blob ./directory',
  'ln -sf --no-target-directory /tmp/blob ./directory',
  'ln -sf /tmp/blob ./file',
  'ln -s /etc/hosts ./new-link',
  'tar -xPf /tmp/a.tar ordinary/hosts',
  'tar -xPf /tmp/a.tar -C /w ../ordinary/hosts',
])('Full access keeps an ordinary replacement or extraction unheld: %s', command => {
  expect(fullRead(command, links())).toBeNull();
});

it('Full access keeps a card when a placement link cannot be resolved within the bound', () => {
  const cwd = links();
  expect(fullRead('ln -sf /tmp/blob ./loop/', cwd)).toMatchObject({ rule: 'unreadable' });
  expect(fullRead('echo fixture', cwd)).toBeNull();
});

it('a later named wipe keeps precedence over a projected protected write', () => {
  expect(fullRead('tar -xPf /tmp/a.tar ../etc/hosts; rm -rf /', '/w')).toMatchObject({ rule: 'delete-root' });
});


it('Full access holds a bound-variable glob whose placement is uncertain', () => {
  const cwd = links();
  symlinkSync('/etc', join(cwd, 'h'));
  expect(fullRead('d=.; ln -sf /tmp/blob "$d"/h*', cwd)).toMatchObject({ rule: 'unreadable' });
  expect(fullRead('echo fixture', cwd)).toBeNull();
});

it('Full access holds glob overflow before an unchecked protected tail', () => {
  const cwd = links();
  // Put the protected match beyond the 4,096-entry scan deterministically.
  for (let i = 0; i < 4097; i++) writeFileSync(join(cwd, `h${i}`), 'fixture');
  symlinkSync('/etc', join(cwd, 'hzz-protected'));
  expect(readdirSync(cwd).filter(name => name.startsWith('h')).indexOf('hzz-protected')).toBeGreaterThanOrEqual(4096);
  expect(fullRead('ln -sf /tmp/blob ./h*', cwd)).toMatchObject({ rule: 'unreadable' });
});

it.each(['-tf', '-xf'])('Full access bounds repeated tar directory alternatives in %s mode', mode => {
  // Fourteen repetitions reproduce the old exponential projection without
  // exhausting the test worker. The same limit applies even to list mode.
  const command = `tar ${mode} /tmp/a.tar ${'-C {a,b} '.repeat(14)}`;
  expect(fullRead(command, '/w')).toMatchObject({ rule: 'unreadable' });
  expect(fullRead('tar -tf /tmp/a.tar -C ordinary', '/w')).toBeNull();
});

it('projection exhaustion retains a later named wipe', () => {
  expect(fullRead(`tar -tf /tmp/a.tar ${'-C {a,b} '.repeat(14)}; rm -rf /`, '/w'))
    .toMatchObject({ rule: 'delete-root' });
});

it('uncertain placement retains a later named wipe', () => {
  const cwd = links();
  symlinkSync('/etc', join(cwd, 'h'));
  expect(fullRead('d=.; ln -sf /tmp/blob "$d"/h*; rm -rf /', cwd)).toMatchObject({ rule: 'delete-root' });
});
