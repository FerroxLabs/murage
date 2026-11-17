// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lex, literalText, type Word } from './shell/lex.ts';
import { newContext, simpleCommand } from './shell/walk.ts';
import { collectNoLimits } from './no-limits-collect.ts';
import { collectProducer } from './no-limits-producers.ts';
import { producerHazards, producerPrefixMatches } from './no-limits-producer-hazards.ts';
import { effectiveDestinations } from './no-limits-placement.ts';
import { inspectNativeEffects } from './no-limits-fs.ts';
const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'nl-b3-')); fixtures.push(cwd);
  for (const name of ['home', 'src', 'out', 'safe']) mkdirSync(join(cwd, name));
  for (const name of ['src/hosts', 'safe/hosts', '-t']) writeFileSync(join(cwd, name), 'fake');
  return { cwd, home: join(cwd, 'home') };
}
const word = (text: string): Word => ({ parts: [{ kind: 'lit', text, quote: 'single' }] });
function command(text: string, ctx: ReturnType<typeof fixture>) {
  const words = lex(text).filter(t => t.kind === 'word').map(t => t.word);
  const walk = newContext(ctx.cwd);
  return { cmd: simpleCommand(literalText(words[0]!)!, words.slice(1), walk), walk };
}
it.each(['--link-dest', '--copy-dest', '--compare-dest'])('R-CARD %s checks both receiver directories with selection and trailing slash', basis => {
  for (const selection of ['--files-from=list', '--include=hosts', '--exclude=ignored', '--filter=+hosts', '']) {
    for (const protectedTarget of [true, false]) {
      const ctx = fixture();
      symlinkSync(protectedTarget ? '/etc' : join(ctx.cwd, 'safe'), join(ctx.cwd, 'out/ref'));
      const { cmd, walk } = command(`rsync -a ${selection} ${basis}=ref ${selection ? 'src' : 'src/'} out/hosts`, ctx);
      const op = collectProducer('b3', cmd, ctx, walk)!;
      const hazards = producerHazards(op.id, op.operands, op.destinationRoots, ctx);
      expect(hazards.some(hit => hit.cause === 'protected')).toBe(protectedTarget);
      expect(op.operands).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'source', value: 'ref', cwd: join(ctx.cwd, 'out') }),
        expect.objectContaining({ role: 'source', value: 'ref', cwd: join(ctx.cwd, 'out/hosts') }),
      ]));
      expect(op.effects).toContainEqual(expect.objectContaining({ path: 'out/hosts' }));
      expect(op.destinationPrefixes.some(prefix => producerPrefixMatches(join(ctx.cwd, 'out/hosts'), prefix))).toBe(true);
      if (!protectedTarget) { expect(hazards).toEqual([]); expect(inspectNativeEffects(op.effects, ctx).verdict).toBe('run'); }
    }
  }
});
it('R-CARD unknown cp sources retain the destination itself and both receiver directories', () => {
  const ctx = fixture();
  const { cmd, walk } = command('cp -a "$source" out', ctx);
  const placed = effectiveDestinations(cmd, ctx, walk)!;
  expect(placed.destinations).toContainEqual(expect.objectContaining({ path: 'out' }));
  expect(placed.receiverDirectories).toEqual(['out', '.']);
  expect(placed.unknown).toBe(true);
});
it.each(['Copy-Item', 'cpi', 'cp', 'Move-Item'])('R-OPERAND pipeline filename -t remains a source for %s', name => {
  for (const protectedTarget of [true, false]) for (const typed of [false, true]) {
    const ctx = fixture();
    symlinkSync(protectedTarget ? '/etc/hosts' : join(ctx.cwd, 'safe/hosts'), join(ctx.cwd, 'out/-t'));
    const walk = newContext(ctx.cwd);
    const cmd = simpleCommand(name, ['-Destination', './out'].map(word), walk,
      { stdin: { kind: 'literal', text: '-t', words: typed ? [word('-t')] : [] } });
    const op = collectProducer('pipeline', cmd, ctx, walk, 'pwsh')!;
    expect(op.directDecisions.some(hit => hit.reason === 'effective-destination')).toBe(protectedTarget);
    expect(op.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: './out/-t', followFinal: name !== 'Move-Item' }),
      expect.objectContaining({ path: './out' }),
    ]));
    expect(op.destinationRoots).toContainEqual(expect.objectContaining({ path: join(ctx.cwd, 'out/-t') }));
    expect(op.operands).toContainEqual(expect.objectContaining({ role: 'source', value: '-t' }));
    if (!protectedTarget) { expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx)).toEqual([]); expect(inspectNativeEffects(op.effects, ctx).verdict).toBe('run'); }
  }
});

it.each([true, false])('literal review commands preserve C3 HOLD facts, protected=%s', protectedTarget => {
  for (const pipeline of [false, true]) {
    const ctx = fixture();
    symlinkSync(protectedTarget ? '/etc' : join(ctx.cwd, 'safe'), join(ctx.cwd, 'out/ref'));
    symlinkSync(protectedTarget ? '/etc/hosts' : join(ctx.cwd, 'safe/hosts'), join(ctx.cwd, 'out/-t'));
    const text = pipeline ? "'-t' | Copy-Item -Destination ./out" :
      'rsync -a --files-from=list --link-dest=ref src/ out/hosts; printf x > out/hosts';
    const collected = collectNoLimits(text, { cwd: ctx.cwd, dialect: pipeline ? 'pwsh' : 'posix' });
    const operations = collected.commands.flatMap(record => {
      const operation = collectProducer(record.syntaxId, record.command, ctx, record.context, record.dialect);
      return operation ? [operation] : [];
    });
    expect(operations).toHaveLength(1);
    const op = operations[0]!;
    const hazards = producerHazards(op.id, op.operands, op.destinationRoots, ctx);
    const write = join(ctx.cwd, pipeline ? 'out/-t' : 'out/hosts');
    const selected = hazards.length > 0 && op.destinationPrefixes.some(prefix => producerPrefixMatches(write, prefix));
    const held = op.directDecisions.length > 0 || selected;
    expect(held).toBe(protectedTarget);
    if (!protectedTarget) expect(inspectNativeEffects(op.effects, ctx).verdict).toBe('run');
  }
});

it('R-CARD retains both targets even when the destination currently looks like one file', () => {
  const ctx = fixture();
  writeFileSync(join(ctx.cwd, 'out/file'), 'ordinary');
  const { cmd, walk } = command('cp -- -t out/file', ctx);
  const placed = effectiveDestinations(cmd, ctx, walk, undefined, true)!;
  expect(placed.destinations.map(item => item.path)).toEqual(['out/file', 'out/file/-t']);
  expect(placed.receiverDirectories).toEqual(['out/file', 'out']);
});

it.each([['C:/', 'C:/'], ['//server/share/', '//server/share']])('R-CARD receiver parent preserves filesystem root %s', (path, expected) => {
  const ctx = { ...fixture(), windows: true };
  const walk = newContext(ctx.cwd);
  const cmd = simpleCommand('cp', ['--', '-t', path].map(word), walk);
  const placed = effectiveDestinations(cmd, ctx, walk, undefined, true)!;
  expect(placed.receiverDirectories).toEqual([expected]);
});

it.each([true, false])('R-CARD files-from directory source without slash inspects member child, protected=%s', protectedTarget => {
  const ctx = fixture();
  mkdirSync(join(ctx.cwd, 'out/received'));
  symlinkSync(protectedTarget ? '/etc/hosts' : join(ctx.cwd, 'safe/hosts'), join(ctx.cwd, 'out/received/hosts'));
  const { cmd, walk } = command('rsync --files-from=list src out/received', ctx);
  const placed = effectiveDestinations(cmd, ctx, walk)!;
  expect(placed.destinations).toContainEqual(expect.objectContaining({ path: 'out/received/hosts' }));
  expect(placed.decisions.some(hit => hit.reason === 'effective-destination')).toBe(protectedTarget);
  if (!protectedTarget) expect(inspectNativeEffects(placed.destinations.map(item => item.effect), ctx).verdict).toBe('run');
});
