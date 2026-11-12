// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FsContext, NativeEffect } from './no-limits-fs.ts';
import { collectNativeProducer, collectNativeProducers } from './no-limits-native-producers.ts';
import { producerParent } from './no-limits-producer-anchors.ts';
import { producerHazards, producerPrefixMatches } from './no-limits-producer-hazards.ts';
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'nl-native-producer-')); roots.push(cwd);
  for (const name of ['home', 'data', 'safe']) mkdirSync(join(cwd, name));
  writeFileSync(join(cwd, 'plain'), 'fixture'); writeFileSync(join(cwd, 'data/f'), 'fixture');
  return { cwd, home: join(cwd, 'home') };
}
it('typed native symbolic/hard links preserve target taint and mandatory hard-source decisions', () => {
  const ctx = fixture();
  const effects: NativeEffect[] = [
    { path: './symbol', op: 'create-name', followFinal: false, linkKind: 'symbolic', targetValue: '/etc/hosts' },
    { path: './hard', op: 'link', followFinal: false, linkKind: 'hard', source: '/etc/hosts', sourceFollowFinal: true },
  ];
  const operations = collectNativeProducers('native', effects, ctx);
  expect(operations).toHaveLength(2);
  const roots = operations.flatMap(value => value.destinationRoots);
  for (const op of operations) expect(producerHazards(op.id, op.operands, roots, ctx).some(hit => hit.cause === 'protected')).toBe(true);
  expect(operations[1]!.directDecisions).toContainEqual(expect.objectContaining({ reason: 'hard-link-source', sourcePhysical: '/etc/hosts' }));
  expect(operations.every(op => op.program === 'native')).toBe(true);
});
it('typed native batches collect every destination before dependent-link queries, with an independent RUN twin', () => {
  const ctx = fixture();
  for (const dependent of [true, false]) {
    const operations = collectNativeProducers('native', [
      { path: './a', op: 'link', followFinal: false, linkKind: 'symbolic', targetValue: './data' },
      { path: './b', op: 'link', followFinal: false, linkKind: 'symbolic', targetValue: dependent ? './a' : './data' },
    ], ctx);
    expect(operations).toHaveLength(2);
    const roots = operations.flatMap(value => value.destinationRoots);
    const hazards = operations.flatMap(op => producerHazards(op.id, op.operands, roots, ctx));
    expect(hazards.some(value => value.cause === 'producer-dependency')).toBe(dependent);
    if (!dependent) expect(hazards).toEqual([]);
  }
});
it('typed rename and recursive copy retain subtree hazards and exact source removals', () => {
  const ctx = fixture(); symlinkSync('/etc/hosts', join(ctx.cwd, 'data/h'));
  const moved = collectNativeProducer('move', { path: './out', source: './data', op: 'rename', followFinal: false }, ctx)!;
  expect(moved).toBeDefined();
  expect(moved.effects).toContainEqual(expect.objectContaining({ path: './data', op: 'delete', followFinal: false }));
  expect(producerHazards(moved.id, moved.operands, moved.destinationRoots, ctx).some(hit => hit.cause === 'protected')).toBe(true);
  const copied = collectNativeProducer('copy', { path: './out', source: './data', op: 'copy', followFinal: true, recursive: true }, ctx)!;
  expect(copied).toBeDefined();
  expect(producerHazards(copied.id, copied.operands, copied.destinationRoots, ctx).some(hit => hit.cause === 'protected')).toBe(true);
  expect(collectNativeProducer('plain-copy', { path: './out', source: './plain', op: 'copy', followFinal: true }, ctx)).toBeUndefined();
  expect(collectNativeProducers('writes', [{ path: './out', op: 'write', followFinal: true }], ctx)).toEqual([]);
});
it('native inode evidence is lossless and ordinary hard-link sources remain untainted', () => {
  const ctx = fixture(); writeFileSync(join(ctx.home, '.zshrc'), 'fixture');
  linkSync(join(ctx.home, '.zshrc'), join(ctx.cwd, 'alias'));
  const op = collectNativeProducer('hard', { path: './out', source: './alias', op: 'link', followFinal: false, linkKind: 'hard' }, ctx)!;
  expect(op).toBeDefined();
  expect(op.directDecisions).toContainEqual(expect.objectContaining({ reason: 'hard-link-source', namedProtectedPath: join(ctx.home, '.zshrc') }));
  linkSync(join(ctx.cwd, 'plain'), join(ctx.cwd, 'ordinary-alias'));
  const ordinary = collectNativeProducer('ordinary', { path: './out', source: './ordinary-alias', op: 'link', followFinal: false, linkKind: 'hard' }, ctx)!;
  expect(ordinary).toBeDefined(); expect(ordinary.directDecisions).toEqual([]);
  expect(producerHazards(ordinary.id, ordinary.operands, ordinary.destinationRoots, ctx)).toEqual([]);
});
it('drive and UNC roots remain roots for shell/native anchors', () => {
  expect(producerParent('/')).toBe('/'); expect(producerParent('C:/')).toBe('C:/');
  expect(producerParent('C:/file')).toBe('C:/');
  expect(producerParent('//server/share/')).toBe('//server/share');
  const ctx: FsContext = { cwd: 'C:/work', windows: true, remote: true };
  for (const path of ['C:/', '//server/share/']) {
    const op = collectNativeProducer('root', { path, op: 'link', followFinal: false, linkKind: 'symbolic', targetValue: 'C:/work/plain' }, ctx)!;
    expect(op).toBeDefined();
    expect(op.destinationPrefixes).not.toContain('C'); expect(op.destinationPrefixes).not.toContain('//server');
    expect(op.destinationPrefixes.some(prefix => producerPrefixMatches('//server/other/file', prefix, true))).toBe(false);
  }
});
