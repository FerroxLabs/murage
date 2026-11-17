// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { ParkFs } from './park-fs.ts';
import { removeTempDirSync } from '../../testing/cleanup.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });

test('source content changed at the flush barrier cannot publish under a stale manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'park-publish-')); roots.push(root);
  const source = join(root, 'signal'), key = join(source, 'auth/key-0'), target = join(root, 'bundle/signal');
  mkdirSync(join(source, 'auth'), { recursive: true, mode: 0o700 });
  writeFileSync(key, 'FAKE-KEY', { mode: 0o600 });
  const sid = 'S-1-5-21-1-2-3-1001';
  const io = new ParkFs(root, {
    platform: 'win32', windowsSid: () => sid, sync: () => 'synced', protectNewWindowsEntry: () => true,
    windowsRun: (_exe, _args, options) => {
      const paths = JSON.parse(options.env.MURAGE_SIGNAL_ROOTS!) as string[];
      const trees = JSON.parse(options.env.MURAGE_SIGNAL_TREES ?? '[]') as string[];
      const rows: unknown[] = [], seen = new Set<string>();
      function visit(path: string, recurse: boolean) {
        if (seen.has(path)) return; seen.add(path);
        const stat = lstatSync(path);
        rows.push({ path, attributes: stat.isDirectory() ? 16 : 0, sddl: `O:${sid}D:P(A;;FA;;;${sid})(A;;FA;;;SY)` });
        if (recurse && stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name), true);
      }
      for (const path of paths) visit(path, options.env.MURAGE_SIGNAL_TREE === path || trees.includes(path));
      return rows.map(row => JSON.stringify(row)).join('\n');
    },
  });
  const manifest = io.fingerprint(source, true);
  io.mkdir(join(root, 'bundle'));
  let changed = false, published = false;
  io.options.after = (operation, path) => {
    if (operation === 'barrier' && path === source && !changed) {
      changed = true;
      writeFileSync(key, 'NEW--KEY');
      const stat = lstatSync(key);
      utimesSync(key, stat.atime, new Date(stat.mtimeMs + 2000));
    }
    if (operation === 'rename') published = true;
  };
  expect(() => io.move(source, target, manifest, true)).toThrow('changed');
  expect(changed).toBe(true);
  expect(published).toBe(false);
  expect(existsSync(target)).toBe(false);
  expect(readFileSync(key, 'utf8')).toBe('NEW--KEY');
});
