// SPDX-License-Identifier: AGPL-3.0-or-later
// OVERREACH #6: the Claude Bash hook's wipe check (the recovery read when the broker cannot answer) reads a script this session wrote, for the wipe check only.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { relayClaudeBash } from './claude-bash-hook.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'overreach6-hook-'));
  writeFileSync(join(dir, 'wipe.sh'), 'rm -rf ~\n');
  writeFileSync(join(dir, 'fine.sh'), 'echo fine\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const decide = async (command: string, written: string[]) => {
  const out: any = await relayClaudeBash(join(dir, 'absent.sock'), { command, cwd: dir }, new AbortController().signal,
    () => ({ platform: 'linux', home: '/home/tester', env: { HOME: '/home/tester' }, cwd: dir, project: dir, sessionEdits: new Set(written.map(name => join(dir, name))) }));
  return out.hookSpecificOutput.permissionDecision;
};
it.each([
  ['a written script that deletes the home folder', 'bash wipe.sh', ['wipe.sh'], 'deny'],
  ['a written script that deletes nothing', 'bash fine.sh', ['fine.sh'], 'allow'],
  ['a written script whose file cannot be read', 'bash gone.sh', ['gone.sh'], 'deny'],
  ['a script this session did not write is not read', 'bash wipe.sh', [], 'allow'],
] as const)('Claude Bash hook wipe check: %s', async (_label, command, written, expected) => {
  expect(await decide(command, [...written])).toBe(expected);
});
