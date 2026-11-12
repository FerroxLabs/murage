// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Word } from './shell/lex.ts';
import { newContext, simpleCommand, type Provenance } from './shell/walk.ts';
import { collectProducer } from './no-limits-producers.ts';
import { producerHazards, producerPrefixMatches } from './no-limits-producer-hazards.ts';
import { inspectNativeEffects, type FsContext } from './no-limits-fs.ts';
import { commandRoles } from './shell/roles.ts';

const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });
const word = (text: string): Word => ({ parts: [{ kind: 'lit', text, quote: 'single' }] });
function fixture(): FsContext & { cwd: string; home: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'afix-nlsym-b2-')); fixtures.push(cwd);
  for (const name of ['src', 'out', 'home']) mkdirSync(join(cwd, name));
  writeFileSync(join(cwd, 'plain'), 'ordinary fixture');
  return { cwd, home: join(cwd, 'home') };
}
function operation(ctx: FsContext, name: string, args: string[], stdin?: Provenance) {
  const walk = newContext(ctx.cwd);
  return collectProducer('afix', simpleCommand(name, args.map(word), walk, { stdin }), ctx, walk, 'pwsh')!;
}

it.each(['Rename-Item', 'rni'])('reordered %s parameters retain source-tree taint and next/h selection', name => {
  for (const protectedTarget of [true, false]) {
    const ctx = fixture();
    symlinkSync(protectedTarget ? '/etc/hosts' : join(ctx.cwd, 'plain'), join(ctx.cwd, 'src/h'));
    for (const args of [
      ['-NewName', 'next', '-Path', './src'],
      ['-LiteralPath', './src', '-NewName', 'next'],
      ['-NewName:next', '-Path:./src'],
    ]) {
      const op = operation(ctx, name, args);
      const hazards = producerHazards(op.id, op.operands, op.destinationRoots, ctx);
      expect(hazards.some(hit => hit.cause === 'protected')).toBe(protectedTarget);
      expect(op.operands).toContainEqual(expect.objectContaining({ role: 'source', value: './src', tree: true }));
      expect(op.destinationRoots).toContainEqual(expect.objectContaining({ path: join(ctx.cwd, 'next') }));
      expect(op.effects).toContainEqual(expect.objectContaining({ path: './src', op: 'delete', followFinal: false }));
      expect(op.destinationPrefixes.some(prefix => producerPrefixMatches(join(ctx.cwd, 'next/h'), prefix))).toBe(true);
    }
  }
});

it('shared Rename-Item roles assign source and NewName independently of parameter order', () => {
  const roles = commandRoles(['Rename-Item', '-NewName', 'next', '-Path', './src'], 'pwsh');
  expect(roles.known).toBe(true);
  expect(roles.slots).toContainEqual(expect.objectContaining({ key: '-NewName', value: 'next', role: 'write' }));
  expect(roles.slots).toContainEqual(expect.objectContaining({ key: '-Path', value: './src', role: 'write' }));
});

it.each(['Copy-Item', 'cpi', 'cp', 'Move-Item'])('literal pipeline %s inspects the actual destination child and ordinary twin', name => {
  for (const protectedTarget of [true, false]) {
    const ctx = fixture();
    symlinkSync(protectedTarget ? '/etc/hosts' : join(ctx.cwd, 'plain'), join(ctx.cwd, 'out/plain'));
    for (const words of [[], [word('plain')]]) {
      const op = operation(ctx, name, ['-Destination', './out'], { kind: 'literal', text: 'plain', words });
      expect(op.directDecisions.some(hit => hit.reason === 'effective-destination')).toBe(protectedTarget);
      expect(op.destinationRoots).toContainEqual(expect.objectContaining({ path: join(ctx.cwd, 'out/plain') }));
      expect(op.effects).toContainEqual(expect.objectContaining({ path: './out/plain', followFinal: name !== 'Move-Item' }));
      expect(op.operands.filter(value => value.role === 'source')).toEqual([
        expect.objectContaining({ value: 'plain', tree: true }),
      ]);
      if (!protectedTarget) {
        expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx)).toEqual([]);
        expect(inspectNativeEffects(op.effects, ctx).verdict).toBe('run');
      }
    }
  }
});
