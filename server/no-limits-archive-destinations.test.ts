// Sean 2026-11-12 02:05Z: protected findings are evidence; admitted No limits permits these non-wipe writes.
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { autoVerdict } from './auto-approve.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';
const bot = { autoApprove: true, fullAccess: true, noLimits: true };

describe('BLOCK 3: archive destination roles', () => {
  it.each([
    ['tar -xf /tmp/archive.tar -C /etc hosts -C /w other', '/w'],
    ['mode=-xf; tar "$mode" /tmp/archive.tar -C /etc', '/w'],
    ['mode=-cf; tar "$mode" /etc/archive.tar /w/input', '/w'],
    ['tar -xf /tmp/archive.tar -C /etc -T /w/members -C /w other', '/w'],
    ['unzip /tmp/archive.zip -d -', '/etc'],
    ['tar -tf /tmp/archive.tar --index-file=-', '/etc'],
    ['tar -cf /w/archive.tar --listed-incremental=- /w/input', '/etc'],
  ])('holds every actual destination in %s from %s', (command, commandCwd) => {
    const context = { fullAccessOrigin: 'owner' as const, ownerStarted: true, outsideRead: null, commandText: command, commandCwd };
    expect(noLimitsProtectedWrite(command, context)).toMatchObject({ rule: 'protected-path' });
    expect(autoVerdict(bot, 'Bash', command, context).approve).toBeTruthy();
  });
  it.each([
    'tar -xf /etc/archive.tar -C /etc -C /w hosts',
    'tar -cf - /etc/hosts',
    'mode=-tf; tar "$mode" /etc/archive.tar',
    'unzip /etc/archive.zip -d -',
    'tar -tf /etc/archive.tar --index-file=-',
  ])('runs ordinary destinations and archive stdout in %s', command => {
    const context = { fullAccessOrigin: 'owner' as const, ownerStarted: true, outsideRead: null, commandText: command, commandCwd: '/w' };
    expect(noLimitsProtectedWrite(command, context)).toBeNull();
    expect(autoVerdict(bot, 'Bash', command, context).approve).toBeTruthy();
  });
});
