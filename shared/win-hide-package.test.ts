// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('loads the archived ESM wrapper and its ordinary-Node preload outside ASAR', () => {
  const root = mkdtempSync(join(tmpdir(), 'win-hide-package-')); roots.push(root);
  const archived = join(root, 'resources', 'app.asar', 'shared');
  const external = join(root, 'resources', 'shared');
  mkdirSync(archived, { recursive: true }); mkdirSync(external, { recursive: true });
  copyFileSync(new URL('./win-hide-child-process.mjs', import.meta.url), join(archived, 'win-hide-child-process.mjs'));
  copyFileSync(new URL('./win-hide-child-process.cjs', import.meta.url), join(external, 'win-hide-child-process.cjs'));
  copyFileSync(new URL('./win-hide-child-process.cjs', import.meta.url), join(archived, 'win-hide-child-process.cjs'));
  expect(readFileSync(join(archived, 'win-hide-child-process.cjs'))).toEqual(readFileSync(join(external, 'win-hide-child-process.cjs')));
  const config = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
  expect(config).toContain('  - shared/win-hide-child-process.cjs');
  const manifest = parse(config);
  expect(manifest.files).toContainEqual({ from: 'dist-server/shared', to: 'shared', filter: ['win-hide-child-process.cjs'] });
  expect(manifest.extraResources).toContainEqual({ from: 'shared/win-hide-child-process.cjs', to: 'shared/win-hide-child-process.cjs' });
  const source = `import { withHideInherit, windowsHidePrelude } from ${JSON.stringify(pathToFileURL(join(archived, 'win-hide-child-process.mjs')).href)};
    const options = { windowsHide: true }; if (process.platform !== 'win32' && withHideInherit(options) !== options) throw Error('POSIX options changed');
    if (!windowsHidePrelude.includes('murage.windowsHide.installed')) throw Error('Missing descendant guard');
    console.log('archive loader ready');`;
  expect(execFileSync(process.execPath, ['--require', join(external, 'win-hide-child-process.cjs'), '--input-type=module', '-e', source], { encoding: 'utf8' }).trim()).toBe('archive loader ready');
});
