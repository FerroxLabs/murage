// SPDX-License-Identifier: AGPL-3.0-or-later
// Commands are inert reader inputs. Only the isolated link is real; access errors are faked.
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { alwaysAskCommand } from './always-ask.ts';
import { autoVerdict } from './auto-approve.ts';
import { resolveNoLimitsPath } from './no-limits-fs.ts';
import { withoutDoubts } from './shell/marks.ts';
import { removeTempDirSync } from './testing/cleanup.ts';

const access = vi.hoisted(() => {
  vi.resetModules();
  return { prefix: '', directory: '', code: 'EACCES', children: [] as string[] };
});
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const inspect = (original: typeof fs.lstatSync) => (path: string, options?: Parameters<typeof fs.lstatSync>[1]) => {
    if (access.prefix && (path === access.prefix || access.prefix.startsWith(path + '/'))) return original(access.directory, options);
    if (access.prefix && path.startsWith(access.prefix + '/')) {
      access.children.push(path);
      throw Object.assign(new Error('Fixture directory is not traversable'), { code: access.code });
    }
    return original(path, options);
  };
  return { ...fs, lstatSync: inspect(fs.lstatSync), statSync: inspect(fs.statSync) };
});
afterEach(() => {
  access.prefix = '';
  if (access.directory) removeTempDirSync(access.directory);
  access.directory = '';
  access.children = [];
});

for (const code of ['EACCES', 'EPERM']) for (const protectedTarget of [true, false]) {
  it(`H3 retains an inaccessible destination's protected prefix: ${code}, protected=${protectedTarget}`, () => {
    access.directory = mkdtempSync(join(tmpdir(), 'inaccessible-write-'));
    access.prefix = protectedTarget ? '/etc/restricted' : '/ordinary/restricted';
    access.code = code;
    symlinkSync(access.prefix, join(access.directory, 'h'));
    const command = 'sudo ln -sf /tmp/blob ./h';
    expect(resolveNoLimitsPath('./h/blob', { cwd: access.directory, followFinal: false })).toMatchObject({
      kind: 'unknown', cause: `disk-${code}`, fixedPrefix: `${access.prefix}/blob`,
    });
    const read = () => withoutDoubts(() => alwaysAskCommand(command, access.directory));
    if (protectedTarget) expect(read()).toMatchObject({ rule: 'protected-path', protectedClass: 'system' });
    else expect(read()).toBeNull();
    expect(access.children).toContain(`${access.prefix}/blob`);
    const context = { commandText: command, commandCwd: access.directory, fullAccessOrigin: 'owner' as const,
      stopLine: null, outsideRead: null };
    expect(autoVerdict({ autoApprove: true, fullAccess: true }, 'Bash', command, context).approve === null).toBe(protectedTarget);
    if (protectedTarget) expect(withoutDoubts(() => alwaysAskCommand(command + '; rm -rf /', access.directory)))
      .toMatchObject({ rule: 'delete-root' });
  });
}
