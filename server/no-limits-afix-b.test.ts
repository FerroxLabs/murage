// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lex, literalText, type Word } from './shell/lex.ts';
import { newContext, simpleCommand } from './shell/walk.ts';
import { inspectNativeEffects, noLimitsDisk, resolveNoLimitsPath } from './no-limits-fs.ts';
import { effectiveDestinations } from './no-limits-placement.ts';
import { collectProducer } from './no-limits-producers.ts';
import { producerHazards, producerPrefixMatches } from './no-limits-producer-hazards.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'nl-afix-b-')); roots.push(cwd);
  for (const dir of ['home', '~', 'src', 'out', 'safe', 'basis', 'backup']) mkdirSync(join(cwd, dir));
  for (const file of ['plain', 'src/hosts', 'safe/hosts', 'home/h']) writeFileSync(join(cwd, file), 'fake data');
  // Protected disk names use fixture stats. Never read or change their contents.
  const disk = { ...noLimitsDisk,
    lstat: (path: string) => noLimitsDisk.lstat(path === '/etc' ? join(cwd, 'safe') : path === '/etc/hosts' ? join(cwd, 'safe/hosts') : path),
    stat: (path: string) => noLimitsDisk.stat(path === '/etc/hosts' ? join(cwd, 'safe/hosts') : path),
    readdir: (path: string) => path === '/etc' ? ['hosts'] : noLimitsDisk.readdir(path),
  };
  return { cwd, home: join(cwd, 'home'), disk };
}
function command(text: string, ctx: ReturnType<typeof fixture>) {
  const words = lex(text).filter(token => token.kind === 'word').map(token => (token as { word: Word }).word);
  const walk = newContext(ctx.cwd);
  return { cmd: simpleCommand(literalText(words[0]!)!, words.slice(1), walk), walk };
}

describe('review B literal readlink targets', () => {
  it.each([true, false])('literal tilde target protected=%s, independent of HOME', protectedTarget => {
    const ctx = fixture();
    symlinkSync('~/h', join(ctx.cwd, 'h'));
    symlinkSync(protectedTarget ? '/etc/hosts' : '../plain', join(ctx.cwd, '~/h'));
    expect(resolveNoLimitsPath('h', ctx)).toMatchObject({ kind: 'known', physical: protectedTarget ? '/etc/hosts' : join(ctx.cwd, 'plain'), linkValues: expect.arrayContaining(['~/h']) });
    expect(inspectNativeEffects([{ op: 'write', path: 'h', followFinal: true }], ctx).verdict).toBe(protectedTarget ? 'hold' : 'run');
  });
  it('resolves link text from the actual link parent, while shell operand tilde still expands', () => {
    const ctx = fixture(); mkdirSync(join(ctx.cwd, 'out/~'));
    symlinkSync('~/h', join(ctx.cwd, 'out/h')); symlinkSync('/etc/hosts', join(ctx.cwd, 'out/~/h'));
    expect(resolveNoLimitsPath('out/h', ctx)).toMatchObject({ kind: 'known', physical: '/etc/hosts' });
    expect(resolveNoLimitsPath('~/h', ctx)).toMatchObject({ kind: 'known', physical: join(ctx.home, 'h') });
  });
});

describe('review B rsync receiver-relative paths', () => {
  it.each(['--link-dest', '--copy-dest', '--backup-dir'])('%s taints only from its receiving-directory path', option => {
    for (const protectedTarget of [true, false]) {
      const ctx = fixture(); symlinkSync(protectedTarget ? '/etc' : join(ctx.cwd, 'safe'), join(ctx.cwd, 'out/ref'));
      const { cmd, walk } = command(`rsync -a ${option}=ref src/hosts out/hosts`, ctx);
      const op = collectProducer('rsync', cmd, ctx, walk)!;
      const hazards = producerHazards(op.id, op.operands, op.destinationRoots, ctx);
      expect(hazards.some(hit => hit.cause === 'protected')).toBe(protectedTarget);
      if (!protectedTarget) expect(hazards).toEqual([]);
      expect(op.operands).toContainEqual(expect.objectContaining({ role: option === '--backup-dir' ? 'backup' : 'source', value: 'ref', cwd: join(ctx.cwd, 'out') }));
      // The taint and the later write share a hold prefix even though out/hosts is absent.
      expect(op.destinationPrefixes.some(prefix => producerPrefixMatches(join(ctx.cwd, 'out/hosts'), prefix))).toBe(true);
      if (option === '--backup-dir') {
        expect(op.destinationRoots.some(root => root.path === join(ctx.cwd, 'out/ref'))).toBe(true);
        expect(op.effects).toContainEqual(expect.objectContaining({ path: join(ctx.cwd, 'out/ref'), followFinal: false }));
      }
    }
  });
  it.each(['src/hosts out/', 'src/hosts out', 'src/ missing/', 'src missing', 'src/hosts plain out/'])('receiving root follows rsync placement: %s', operands => {
    const ctx = fixture(); const { cmd, walk } = command(`rsync -a --link-dest=ref ${operands}`, ctx);
    const op = collectProducer('rsync', cmd, ctx, walk)!;
    expect(op.operands.find(value => value.id.includes(':link-base:'))?.cwd).toBe(join(ctx.cwd, operands.includes('missing') ? 'missing' : 'out'));
  });
  it('absolute option paths remain absolute and a protected command-cwd decoy does not taint', () => {
    const ctx = fixture(); symlinkSync('/etc', join(ctx.cwd, 'ref')); mkdirSync(join(ctx.cwd, 'out/ref'));
    for (const option of ['--link-dest', '--copy-dest', '--backup-dir']) {
      const { cmd, walk } = command(`rsync -a ${option}=ref src/hosts out/hosts`, ctx);
      const op = collectProducer('rsync', cmd, ctx, walk)!;
      expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx)).toEqual([]);
      const absolute = command(`rsync -a ${option}=${ctx.cwd}/safe src/hosts out/hosts`, ctx);
      const abs = collectProducer('absolute', absolute.cmd, ctx, absolute.walk)!;
      expect(producerHazards(abs.id, abs.operands, abs.destinationRoots, ctx)).toEqual([]);
    }
  });
  it('a preserved source symlink stays a single-file transfer; dereferenced directories use the destination root', () => {
    const ctx = fixture(); symlinkSync('src', join(ctx.cwd, 'source-link'));
    for (const [flags, source, receiver] of [['-a', 'source-link', ctx.cwd], ['-aL', 'source-link', join(ctx.cwd, 'new-root')], ['-a', 'source-link/', join(ctx.cwd, 'new-root')]] as const) {
      const text = `rsync ${flags} --link-dest=basis ${source} new-root`;
      const { cmd, walk } = command(text, ctx);
      const op = collectProducer('rsync', cmd, ctx, walk)!;
      expect(op.operands.find(value => value.id.includes(':link-base:'))?.cwd).toBe(receiver);
    }
  });
});

describe('review B replacement referent preflight', () => {
  it.each(['cp --remove-destination', 'mv -T', 'install', 'ln -sf'])('%s replaces an ordinary name pointing to a protected referent', program => {
    const ctx = fixture(); symlinkSync('/etc/hosts', join(ctx.cwd, 'h'));
    const { cmd, walk } = command(`${program} plain h`, ctx);
    const placed = effectiveDestinations(cmd, ctx, walk)!;
    expect(placed.destinations[0]).toMatchObject({ path: 'h', followFinal: false, decisions: [] });
    expect(placed.decisions).toEqual([]);
    const through = command('cp plain h', ctx);
    expect(effectiveDestinations(through.cmd, ctx, through.walk)!.decisions.length).toBeGreaterThan(0);
    symlinkSync('/etc/hosts', join(ctx.cwd, 'out/plain'));
    const child = command('cp --remove-destination plain out', ctx);
    expect(effectiveDestinations(child.cmd, ctx, child.walk)!.decisions).toContainEqual(expect.objectContaining({ reason: 'effective-destination', physical: '/etc/hosts' }));
  });
});
