// Sean 2026-11-12 02:05Z: protected findings are evidence; admitted No limits permits these non-wipe writes.
import { describe, expect, it } from 'vitest';
import { autoVerdict } from './auto-approve.ts';
const bot = { id: 'bc', autoApprove: true, fullAccess: true, noLimits: true };
const owner = { fullAccessOrigin: 'owner' as const, ownerStarted: true, commandCwd: '/w', outsideRead: null };

describe('No limits gate-file operations', () => {
  it.each(['cat ~/.ssh/id_rsa', 'cat ~/.zshrc', 'grep x .git/config', 'echo murage-hook.mjs', 'node_modules/.bin/vitest run'])( 'C read, mention or tooling runs: %s', command => {
    expect(autoVerdict(bot, 'Bash', command, { ...owner, commandText: command }).approve).toBeTruthy();
  });
  it('C a PowerShell tooling launcher runs', () => {
    const command = String.raw`& C:\Users\me\AppData\Roaming\npm\pnpm.cmd install`;
    expect(autoVerdict(bot, 'PowerShell', command, { ...owner, commandText: command }).approve).toBeTruthy();
  });
  it.each(['printf x >> ~/.ssh/config', 'cd ~/.ssh && printf x >> config', 'touch ~/.bashrc', 'printf x > .git/hooks/pre-commit'])( 'C gate write asks: %s', command => {
    expect(autoVerdict(bot, 'Bash', command, { ...owner, commandText: command })).toMatchObject({ approve: expect.any(String), source: 'no-limits' });
  });
});
