// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copied into server/ in the candidate snapshot. Commands are inert strings:
// this test calls the product decision function and never executes a shell.
import { describe, expect, it } from 'vitest';
import { autoVerdict } from './auto-approve.ts';
import { classifyStopLine } from './stop-line.ts';
import { finalDecision, cleanRead } from '../shared/no-limits-decision.ts';
const bot = { autoApprove: true, fullAccess: true, noLimits: true };
const cwd = '/home/fixture/project', home = '/home/fixture';
const place = { cwd, roots: [cwd, '/tmp'], home, knownRecipients: new Set<string>(), realpath: (s: string) => s };
function decide(command: string, tool: string) {
  return autoVerdict(bot, tool, command, { fullAccessOrigin: 'owner', ownerStarted: true,
    // NOLIMITS-MEANS-IT r4 C2: absent outsideRead means tainted.
    outsideRead: null, commandText: command, commandCwd: cwd, promptFacts: { cwd, home }, unseen: { platform: 'posix' },
    stopLine: classifyStopLine(tool, { command }, '', place) });
}
// Engine-native transport is separately UNVERIFIED. These are policy fixtures.
for (const tool of ['Bash']) describe(tool, () => {
  it('ssh/cd: owner No limits has zero holds for both field commands', () => {
    for (const command of ["ssh host 'cmd'", 'cd some/dir && ls']) expect(decide(command, tool).approve, command).toBeTruthy();
  });
  it('compound: commit + push + remove one temporary file has zero holds', () => {
    expect(decide('git commit -am x && git push origin HEAD && rm -f /tmp/x.tmp', tool).approve).toBeTruthy();
  });
  it('deny set: home and root wipes still hold', () => {
    for (const command of ['rm -rf ~', 'rm -rf /']) expect(decide(command, tool).approve, command).toBeNull();
  });
});
it('a deny-rule hit holds even when the owner and every reader are clean', () => {
  expect(finalDecision([cleanRead('inert-deny-fixture')], 'Bash', { kind: 'clean-owner', deny: true }).approve).toBeNull();
});
