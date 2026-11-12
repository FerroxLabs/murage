// Sean 2026-11-12 02:05Z: protected findings are evidence; admitted No limits permits these non-wipe writes.
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { autoVerdict, type AutoContext } from './auto-approve.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';
const bot = { autoApprove: true, fullAccess: true, noLimits: true };
const owner: AutoContext = { fullAccessOrigin: 'owner', ownerStarted: true, commandCwd: '/w', outsideRead: null };

describe('BLOCK 3: archive mode and operand roles', () => {
  it.each([
    'tar -tf /etc/archive.tar', 'tar tf /etc/archive.tar', 'tar --list --file=/etc/archive.tar',
    'tar -tvf /etc/archive.tar -C /etc', 'unzip -l /etc/archive.zip', 'unzip -t /etc/archive.zip',
    'unzip -p /etc/archive.zip', 'unzip -Z /etc/archive.zip',
    'tar -cf /tmp/archive.tar /etc/hosts', 'tar -xf /etc/archive.tar -C /w',
    'tar -df /etc/archive.tar /etc/hosts', 'tar --compare --file=/etc/archive.tar',
    'tar -xOf /etc/archive.tar', 'tar -xf /etc/archive.tar --to-stdout',
    'tar -cf/tmp/archive.tar -C /etc hosts', 'tar cfC /tmp/archive.tar /etc hosts',
    'tar -xf /tmp/archive.tar -C /etc -C /w',
    'unzip -v /etc/archive.zip', 'unzip -c /etc/archive.zip', 'unzip -z /etc/archive.zip',
    'unzip -o /etc/archive.zip -d/w', 'unzip -l /tmp/archive.zip -d /etc',
    'unzip /etc/archive.zip -d /w',
    'dest=/w/archive.tar; tar -cf "$dest" /etc/hosts',
    'dest=/w; unzip /etc/archive.zip -d"$dest"',
    'tar -cf - /etc/hosts', 'tar -tf /etc/archive.tar --listed-incremental=/etc/snapshot',
    'tar -cf /w/archive.tar --listed-incremental=/w/snapshot /etc/hosts',
  ])('runs archive reads with ordinary output: %s', command => {
    const context = { ...owner, commandText: command };
    expect(noLimitsProtectedWrite(command, context)).toBeNull();
    expect(autoVerdict(bot, 'Bash', command, context).approve).toBeTruthy();
  });
  it.each([
    'tar -cf /etc/archive.tar /w/input', 'tar cf /etc/archive.tar /w/input',
    'tar --create --file=/etc/archive.tar /w/input', 'tar -rf /etc/archive.tar /w/input',
    'tar --delete -f /etc/archive.tar entry', 'tar -xf /tmp/archive.tar -C /etc',
    'tar --extract --file=/tmp/archive.tar --directory=/etc', 'unzip /tmp/archive.zip -d /etc',
    'unzip -p /tmp/archive.zip > /etc/output',
    'tar -uf /etc/archive.tar /w/input', 'tar -Af /etc/archive.tar /w/other.tar',
    'tar -cf/etc/archive.tar /w/input', 'tar -xC /etc -f /tmp/archive.tar',
    'tar -xf /tmp/archive.tar -C/etc', 'unzip -od /etc /tmp/archive.zip',
    'unzip /tmp/archive.zip -d/etc', 'tar -tf /tmp/archive.tar > /etc/list',
    'tar -tf /tmp/archive.tar --index-file=/etc/list',
    'dest=/etc/archive.tar; tar -cf "$dest" /w/input',
    'dest=/etc; unzip /tmp/archive.zip -d"$dest"',
    'tar -cf /w/archive.tar --listed-incremental=/etc/snapshot /w/input',
    'tar -cf /w/archive.tar --remove-files /etc/hosts',
    'tar -cf /w/archive.tar --remove-files -C /etc hosts',
  ])('holds actual protected archive writes: %s', command => {
    const context = { ...owner, commandText: command };
    expect(noLimitsProtectedWrite(command, context)).toMatchObject({ rule: 'protected-path' });
    expect(autoVerdict(bot, 'Bash', command, context).approve).toBeTruthy();
  });
  it.each(['tar -xf /tmp/archive.tar', 'unzip /tmp/archive.zip',
    'tar -xf /tmp/archive.tar -C /w -C /etc'])(
    'holds extraction into a protected working folder: %s', command => {
      const context = { ...owner, commandCwd: '/etc', commandText: command };
      expect(noLimitsProtectedWrite(command, context)).toMatchObject({ rule: 'protected-path' });
      expect(autoVerdict(bot, 'Bash', command, context).approve).toBeTruthy();
    });
  it.each(['tar -tf /tmp/archive.tar', 'tar -cf /w/archive.tar /etc/hosts',
    'tar -xOf /tmp/archive.tar', 'unzip -t /tmp/archive.zip', 'unzip -p /tmp/archive.zip',
    'unzip /tmp/archive.zip -d /w'])(
    'allows read modes and explicit ordinary output from a protected working folder: %s', command => {
      const context = { ...owner, commandCwd: '/etc', commandText: command };
      expect(noLimitsProtectedWrite(command, context)).toBeNull();
      expect(autoVerdict(bot, 'Bash', command, context).approve).toBeTruthy();
    });
});
