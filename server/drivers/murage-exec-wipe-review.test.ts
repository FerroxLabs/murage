// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { registeredWipeProjects } from '../wipe/registry.ts';
import { mountedRoots } from '../wipe/mounts.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { wipeGuardRootPaths } from './murage-exec-wipe.ts';

const dirs: string[] = [];
const owner = 'bot:guard-review:cwd';
let mount: string | undefined;
afterEach(() => {
  registeredWipeProjects.drop(owner);
  if (mount) mountedRoots.drop(mount);
  mount = undefined;
  for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'guard-review-')); dirs.push(root); return root; };

it('H2: physical roots cover a linked project and a macOS-style etc alias including child coverage', () => {
  const root = temp(), physical = join(root, 'private'), project = join(physical, 'project'), etc = join(physical, 'etc');
  mkdirSync(physical); mkdirSync(project); mkdirSync(etc); mkdirSync(join(project, 'child')); mkdirSync(join(etc, 'child'));
  const alias = join(root, 'project'), etcAlias = join(root, 'etc');
  symlinkSync(project, alias, 'dir'); symlinkSync(etc, etcAlias, 'dir');
  const roots = wipeGuardRootPaths({ project: alias }, [etcAlias]);
  expect(roots).toContain(realpathSync(project)); expect(roots).toContain(realpathSync(etc));
  expect(roots).not.toContain(alias); expect(roots).not.toContain(etcAlias);
});
