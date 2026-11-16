// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
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

it('H1: every static POSIX OS root is in the shim inventory', () => {
  expect(wipeGuardRootPaths({})).toEqual(expect.arrayContaining(['/lib32', '/libx32', '/libexec']));
});
it('H1: another registered project and a mounted root enter the actual default inventory', () => {
  const root = temp(), project = join(root, 'other-project'); mount = join(root, 'volume');
  mkdirSync(project); mkdirSync(mount);
  registeredWipeProjects.replace(owner, [project]); mountedRoots.add(mount);
  expect(wipeGuardRootPaths({ project: join(root, 'current') })).toEqual(expect.arrayContaining([realpathSync(project), realpathSync(mount)]));
});
