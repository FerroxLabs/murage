// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lex, literalText, type Word } from './shell/lex.ts';
import { newContext, simpleCommand } from './shell/walk.ts';
import { archiveRoles, archiveWrites } from './no-limits-archives.ts';
import { archiveCommandEffects, collectProducer } from './no-limits-producers.ts';
import { producerHazards, producerPrefixMatches } from './no-limits-producer-hazards.ts';
import { inspectNativeEffects, noLimitsDisk, type FsContext, type NoLimitsDisk } from './no-limits-fs.ts';
import { collectNoLimits } from './no-limits-collect.ts';
import { initialCwds, transitionCwd } from './no-limits-cwd.ts';
import { roleText } from './no-limits-role-adapter.ts';
import { expandProducerGlob, producerValues } from './no-limits-producer-values.ts';

const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): FsContext & { cwd: string; home: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'nl-producer-')); fixtures.push(cwd);
  for (const name of ['data', 'src', 'out', 'home', 'safe']) mkdirSync(join(cwd, name));
  for (const name of ['plain', 'blob', 'a.tar', 'a.zip', 'a.cpio', 'data/f', 'src/f']) writeFileSync(join(cwd, name), 'opaque fixture');
  return { cwd, home: join(cwd, 'home') };
}
function command(text: string, ctx: FsContext) {
  const words = lex(text).filter(token => token.kind === 'word').map(token => (token as { word: Word }).word);
  const walk = newContext(ctx.cwd);
  return { cmd: simpleCommand(literalText(words[0]!)!, words.slice(1), walk), walk };
}
function producer(text: string, ctx: FsContext = fixture(), dialect: 'posix' | 'cmd' | 'pwsh' = 'posix') {
  const { cmd, walk } = command(text, ctx);
  return collectProducer('op', cmd, ctx, walk, dialect);
}
function envelope(text: string, ctx = fixture()) {
  const collected = collectNoLimits(text, { cwd: ctx.cwd });
  const operations = collected.commands.flatMap(record => {
    const value = collectProducer(record.syntaxId, record.command, ctx, record.context, record.dialect);
    return value ? [value] : [];
  });
  const roots = operations.flatMap(op => op.destinationRoots);
  return { ctx, operations, roots, hazards: operations.flatMap(op => producerHazards(op.id, op.operands, roots, ctx)) };
}

describe('C3 producer inventory and ordinary RUN boundaries', () => {
  it.each([
    ['ln -s ./data ./h', 'link'], ['ln ./plain ./h', 'link'], ['link ./plain ./h', 'link'], ['symlink ./data ./h', 'link'],
    ['mv -n ./plain ./moved', 'relocate'], ['cp -RP src out', 'copy'], ['cp -L plain out', 'copy'], ['cp -H plain out', 'copy'],
    ['cp -l plain out', 'copy'], ['cp -s plain out', 'copy'], ['cp -d plain out', 'copy'], ['cp -a src out', 'copy'],
    ['cp --symbolic-link plain out', 'copy'], ['cp --no-dereference plain out', 'copy'], ['cp --backup=simple plain out', 'copy'],
    ['install -b plain out', 'copy'], ['rsync -a src/ out/', 'copy'], ['rsync --links src/ out/', 'copy'],
    ['rsync --hard-links src/ out/', 'copy'], ['rsync --copy-links src/ out/', 'copy'],
    ['rsync --link-dest=./safe src/ out/', 'copy'], ['rsync --copy-dest ./safe src/ out/', 'copy'],
    ['sed -i.bak s/x/y/ plain', 'backup'], ['perl -i.bak -pe s/x/y/ plain', 'backup'],
    ['tar -xf ./a.tar -C ./out', 'extract'], ['tar xf ./a.tar -C ./out', 'extract'],
    ['unzip ./a.zip -d ./out', 'extract'], ['cpio -idm -D ./out', 'extract'], ['cpio --extract -D ./out', 'extract'],
    ['7z x ./a.zip -oout', 'extract'],
  ])('%s is collected as %s with an untainted ordinary twin', (text, family) => {
    const ctx = fixture(), op = producer(text, ctx)!;
    expect(op).toMatchObject({ family });
    expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx)).toEqual([]);
  });

  it.each(['cp plain out', 'cp -- plain out', 'install -s plain out', 'rsync -t plain out', 'rsync -P plain out',
    'sed -i s/x/y/ plain', 'sed -b s/x/y/ plain', 'perl -i -pe s/x/y/ plain',
    'tar -tf ./a.tar', 'tar -cf ./new.tar ./plain', 'unzip -t ./a.zip', '7z l ./a.zip', 'git arbitrary opaque', 'echo opaque'])
  ('%s creates no alias operation', text => expect(producer(text)).toBeUndefined());

  it('unknown option-position expansions include copy form; after -- stays outside inventory', () => {
    expect(producer('cp "$opts" plain out')).toMatchObject({ family: 'copy' });
    expect(producer('cp -- "$source" out')).toBeUndefined();
    expect(producer('cp -t "$destination" plain')).toBeUndefined();
    expect(producer('cp ./"$source" out')).toBeUndefined();
    expect(producer('cp {plain,blob} out')).toBeUndefined();
    expect(producer('rsync -e "$opaqueCode" plain out')).toBeUndefined();
    const ctx = fixture(), { cmd, walk } = command('ln -s "$target" ./h', ctx);
    walk.bound.set('target', [{ parts: [{ kind: 'lit', text: './plain', quote: 'single' }] }]);
    const op = collectProducer('op', cmd, ctx, walk)!;
    expect(op.operands).toContainEqual(expect.objectContaining({ role: 'target', value: './plain', unknownCause: 'dynamic-producer-value' }));
    expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx).some(hit => hit.cause === 'unknown-expansion')).toBe(true);
  });
  it('absolute program paths retain placement and typed hard-source decisions', () => {
    const ctx = fixture(), op = producer('/usr/bin/ln /etc/hosts out/h', ctx)!;
    expect(op.placement).toBeDefined();
    expect(op.effects).toContainEqual(expect.objectContaining({ path: 'out/h', source: '/etc/hosts', linkKind: 'hard', sourceFollowFinal: false }));
    expect(inspectNativeEffects(op.effects, ctx).decisions).toContainEqual(expect.objectContaining({ reason: 'hard-link-source', sourcePhysical: '/etc/hosts', lexical: join(ctx.cwd, 'out/h') }));
    expect(producer('/usr/bin/cp plain out', ctx)).toBeUndefined();
  });
  it('known braces stay untainted and glob-produced option positions stay conservative', () => {
    const ctx = fixture(), op = producer('ln {plain,blob} out/', ctx)!;
    expect(op.unknownDestination).toBe(false);
    expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx)).toEqual([]);
    expect(producer('cp * out', ctx)?.operands).toContainEqual(expect.objectContaining({ unknownCause: 'unknown-producer-options' }));
    expect(producer('cp -- * out', ctx)).toBeUndefined();
    writeFileSync(join(ctx.cwd, '-l'), 'fixture');
    expect(producer('cp * out', ctx)?.operands).toContainEqual(expect.objectContaining({ unknownCause: 'unknown-producer-options' }));
    expect(producer('cp ./* out', ctx)).toBeUndefined();
  });
});

describe('C3 whole-envelope roots, subtree hazards and backup anchors', () => {
  it.each([
    ['ln -s /tmp ./a; ln -s a/../etc ./b; tee ./b/hosts', ['dotdot-value', 'producer-dependency']],
    ['ln -s ./data ./a; ln -s ./a ./b; tee ./b/notes', ['producer-dependency']],
    ['ln -s ./a ./b; ln -s ./data ./a; tee ./b/notes', ['producer-dependency']],
    ['ln -s ./data/../data ./cur; tee ./cur/notes', ['dotdot-value']],
  ])('D31 keeps %s Unknown before initial absence can prove safety', (text, causes) => {
    const result = envelope(text);
    expect(result.hazards.map(hit => hit.cause)).toEqual(expect.arrayContaining(causes));
    expect(result.hazards.every(hit => hit.operationId && hit.operandId)).toBe(true);
  });
  it.each(['ln -s ./data ./cur; tee ./cur/notes', 'ln -s ./data ./a; ln -s ./data ./b; tee ./b/notes',
    'ln -s ./data ./b; ln -s ./data ./a; tee ./b/notes', 'ln -s ./file..txt ./h'])
  ('U31 independent ordinary twin %s remains untainted', text => expect(envelope(text).hazards).toEqual([]));

  it.each([false, true])('raw glob traversal detects future matches in either order (%s)', reverse => {
    const ctx = fixture();
    mkdirSync(join(ctx.cwd, 'a1')); writeFileSync(join(ctx.cwd, 'a1/safe'), 'ordinary');
    writeFileSync(join(ctx.cwd, 'data/hosts'), 'ordinary'); symlinkSync('/etc', join(ctx.cwd, 'out/a2'));
    const commands = ['ln -s ./data ./a2', 'ln -s a*/* out'];
    const result = envelope((reverse ? commands.reverse() : commands).join('; ') + '; tee out/hosts', ctx);
    expect(result.hazards).toContainEqual(expect.objectContaining({ cause: 'producer-dependency', detail: 'raw-glob-traverses-other-producer-destination' }));
    const ordinary = envelope('ln -s ./data ./z2; ln -s a*/* out; tee out/notes', ctx);
    expect(ordinary.hazards).toEqual([]);
  });

  it('static brace argv arity exposes source trees and static option alternatives', () => {
    const ctx = fixture(); symlinkSync('/etc/hosts', join(ctx.cwd, 'src/escape'));
    const protectedOp = producer('cp -a blob {src,out}', ctx)!;
    expect(producerHazards(protectedOp.id, protectedOp.operands, protectedOp.destinationRoots, ctx)).toContainEqual(expect.objectContaining({ cause: 'protected' }));
    const ordinary = producer('cp -a blob {safe,out}', ctx)!;
    expect(producerHazards(ordinary.id, ordinary.operands, ordinary.destinationRoots, ctx)).toEqual([]);
    const literal = (text: string): Word => ({ parts: [{ kind: 'lit', text, quote: 'none' }] });
    const walk = newContext(ctx.cwd);
    const link = collectProducer('brace-option', simpleCommand('cp', [{ parts: [{ kind: 'brace', alts: [literal('-l'), literal('plain')] }] }, literal('out')], walk), ctx, walk)!;
    expect(link.effects).toContainEqual(expect.objectContaining({ linkKind: 'hard', source: 'plain' }));
  });

  it('unknown editor option positions retain backup possibility; known code values stay opaque', () => {
    const ctx = fixture(), op = producer('sed "$opts" s/x/y/ plain', ctx)!;
    expect(op.family).toBe('backup');
    expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx)).toContainEqual(expect.objectContaining({ cause: 'unknown-expansion' }));
    for (const text of ['sed -e "$code" plain', 'sed -e"$code" plain', 'perl -e "$code" plain', 'ruby -e "$code" plain']) expect(producer(text, ctx)).toBeUndefined();
    const archive = producer('tar -xf a.tar -C out --to-command="$body"', ctx)!;
    expect(producerHazards(archive.id, archive.operands, archive.destinationRoots, ctx)).toEqual([]);
  });

  it('PowerShell hard targets stay relative to cwd rather than the destination parent', () => {
    const ctx = fixture(); symlinkSync('/etc/hosts', join(ctx.cwd, 'safe/plain'));
    const op = producer('New-Item -ItemType HardLink -Path safe/h -Value plain', ctx, 'pwsh')!;
    expect(op.operands.some(value => value.id.includes(':link-parent:'))).toBe(false);
    expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx)).toEqual([]);
  });

  it('POSIX literal backslashes retain the real destination child', () => {
    const ctx = fixture();
    writeFileSync(join(ctx.cwd, 'plain\\h'), 'ordinary');
    symlinkSync('/etc/hosts', join(ctx.cwd, 'out/plain\\h'));
    const op = producer("ln 'plain\\h' out/", ctx)!;
    expect(op.destinationRoots).toContainEqual(expect.objectContaining({ path: join(ctx.cwd, 'out/plain\\h') }));
    expect(op.directDecisions).toContainEqual(expect.objectContaining({ reason: 'effective-destination' }));
  });
  it('hidden backup families do not match a default non-dot glob', () => {
    const ctx = fixture(), op = producer('ln data/* out/', ctx)!;
    const root = { operationId: 'backup', path: join(ctx.cwd, 'data/.hidden'), backupOf: join(ctx.cwd, 'data/.hidden') };
    expect(producerHazards(op.id, op.operands, [root], ctx)).toEqual([]);
  });

  it('dependency roots are actual child names; broad hold prefixes also cover siblings', () => {
    const ctx = fixture(), op = producer('ln -s ./data -t out', ctx)!;
    expect(op.destinationRoots.map(root => root.path)).toContain(join(ctx.cwd, 'out/data'));
    expect(op.destinationRoots.map(root => root.path)).not.toContain(ctx.cwd);
    expect(op.destinationPrefixes).toContain(ctx.cwd);
    expect(producerHazards('other', [{ id: 'x', role: 'target', value: './out/data/f' }], op.destinationRoots, ctx).some(hit => hit.cause === 'producer-dependency')).toBe(true);
    expect(producerHazards('other', [{ id: 'x', role: 'target', value: './data' }], op.destinationRoots, ctx)).toEqual([]);
    expect(producerPrefixMatches(ctx.cwd + '/note', ctx.cwd)).toBe(true);
    expect(producerPrefixMatches(ctx.cwd + '/outlier', ctx.cwd + '/out')).toBe(false);
    expect(producerPrefixMatches('D:/work/f', 'C:/work', true)).toBe(false);
    expect(producerPrefixMatches('C:/WORK/f', 'c:/work', true)).toBe(true);
    const moved = producer('mv plain out', ctx)!;
    expect(producerHazards(moved.id, moved.operands, [{ operationId: 'other', path: join(ctx.cwd, 'out/unrelated') }], ctx)).toEqual([]);
  });
  it('unknown destinations keep their longest raw fixed directory rather than widening to cwd', () => {
    const ctx = fixture(), op = producer(`ln -s /etc/hosts -- ${ctx.cwd}/out/"$name"`, ctx)!;
    expect(op.unknownDestination).toBe(true);
    expect(op.destinationPrefixes).toContain(join(ctx.cwd, 'out'));
    expect(op.destinationPrefixes).not.toContain(ctx.cwd);
    expect(op.destinationPrefixes.some(prefix => producerPrefixMatches(join(ctx.cwd, 'unrelated'), prefix))).toBe(false);
  });
  it('A01 A02 replacement success, negation and no-clobber never subtract disk hazards', () => {
    const ctx = fixture(); symlinkSync('/etc/hosts', join(ctx.cwd, 'h'));
    for (const text of ['mv -n blob h && tee h', '! mv -n blob h; tee h', 'ln -sf --backup=simple plain h && tee h~']) {
      const result = envelope(text, ctx);
      expect(result.hazards.some(hit => hit.cause === 'protected')).toBe(true);
      expect(result.operations.flatMap(op => op.destinationPrefixes)).toContain(ctx.cwd);
    }
    expect(envelope('mv -n blob safe/h && tee safe/h').hazards).toEqual([]);
  });
  it('A03 A04 recursive/relocated trees retain alias evidence and ordinary twins', () => {
    for (const protectedTarget of [true, false]) {
      const ctx = fixture(); symlinkSync(protectedTarget ? '/etc/hosts' : join(ctx.cwd, 'plain'), join(ctx.cwd, 'src/h'));
      for (const text of ['mv src dst; mv dst final; tee final/h', 'cp -RP src out']) {
        const result = envelope(text, ctx);
        expect(result.hazards.some(hit => hit.cause === 'protected')).toBe(protectedTarget);
      }
      expect(envelope('mv src first; mv data final; tee final/f', ctx).hazards.some(hit => hit.cause === 'protected')).toBe(protectedTarget);
    }
  });
  it.each(['-b', '--backup=simple', '--backup=numbered', '-b -S .bak', '-b -S.bak', '--backup --suffix=.bak'])
  ('A02 backup %s keeps actual siblings and broad parents', options => {
    const ctx = fixture(), op = producer(`cp ${options} plain out/new`, ctx)!;
    expect(op.destinationPrefixes).toContain(join(ctx.cwd, 'out'));
    expect(op.destinationRoots.some(root => root.path?.startsWith(join(ctx.cwd, 'out/new')))).toBe(true);
    const backupName = options.includes('bak') ? './out/new.bak' : './out/new~';
    expect(producerHazards('other', [{ id: 'x', role: 'source', value: backupName }], op.destinationRoots, ctx).some(hit => hit.cause === 'producer-dependency')).toBe(true);
    if (options === '-b') expect(producerHazards('other', [{ id: 'x', role: 'source', value: './out/new.~42~' }], op.destinationRoots, ctx).some(hit => hit.cause === 'producer-dependency')).toBe(true);
    expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx)).toEqual([]);
  });
  it('backup suffixes, backup dirs and in-place writers retain raw roles', () => {
    const ctx = fixture(), sed = producer('sed -i.bak s/etc/hosts/ plain', ctx)!;
    expect(sed.operands.filter(op => op.role === 'source').map(op => op.value)).toEqual(['plain']);
    expect(sed.destinationRoots.map(root => root.path)).toContain(join(ctx.cwd, 'plain.bak'));
    const dynamic = producer('cp -b -S "$suffix" plain out/new', ctx)!;
    expect(producerHazards(dynamic.id, dynamic.operands, dynamic.destinationRoots, ctx).some(hit => hit.cause === 'unknown-expansion')).toBe(true);
    const rsync = producer('rsync --backup-dir=./safe -a src/ out/', ctx)!;
    expect(rsync.operands).toContainEqual(expect.objectContaining({ role: 'backup', value: './safe', tree: true }));
    expect(rsync.destinationPrefixes).toContain(join(ctx.cwd, 'out/safe'));
    const other = fixture(), distinct = producer(`rsync --backup-dir=${other.cwd} -a src/ out/`, ctx)!;
    expect(distinct.destinationPrefixes.some(prefix => producerPrefixMatches(other.cwd + '/selected', prefix))).toBe(true);
  });
  it('cwd transitions use the same numbered-backup dependency matcher', () => {
    const ctx = fixture(), op = producer('cp -b plain out/new', ctx)!;
    const dependent = transitionCwd(initialCwds(ctx), 'cd', ['out/new.~7~/sub'], { ...ctx, cwdDependencyPatterns: op.destinationRoots });
    expect(dependent.success).toContainEqual(expect.objectContaining({ unknownCause: 'producer-dependency-cwd' }));
    const independent = transitionCwd(initialCwds(ctx), 'cd', ['data'], { ...ctx, cwdDependencyPatterns: op.destinationRoots });
    expect(independent.success.every(value => !value.unknownCause)).toBe(true);
  });
  it('symbolic target is also inspected relative to each effective link parent', () => {
    const ctx = fixture(); symlinkSync('/etc', join(ctx.cwd, 'out/sys'));
    const op = producer('ln -s sys/hosts out/h', ctx)!;
    expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx).some(hit => hit.cause === 'protected' && hit.decisions.some(decision => decision.physical === '/etc/hosts'))).toBe(true);
    expect(producerHazards('ordinary', producer('ln -s ./plain ./h', ctx)!.operands, [], ctx)).toEqual([]);
    symlinkSync('/etc/hosts', join(ctx.cwd, 'safe/plain'));
    const hard = producer('link plain safe/h', ctx)!;
    expect(producerHazards(hard.id, hard.operands, hard.destinationRoots, ctx)).toEqual([]);
  });
  it('directory-valued symbolic targets retain nested alias hazards and their ordinary twin', () => {
    for (const protectedTarget of [true, false]) {
      const ctx = fixture(); symlinkSync(protectedTarget ? '/etc/hosts' : join(ctx.cwd, 'plain'), join(ctx.cwd, 'data/escape'));
      const op = producer('ln -s ./data ./h', ctx)!;
      expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx).some(hit => hit.cause === 'protected')).toBe(protectedTarget);
    }
  });
  it('backup suffix text is not a cwd filename; actual backup paths are hazard operands', () => {
    const ctx = fixture(); symlinkSync('/etc/hosts', join(ctx.cwd, '.bak'));
    let op = producer('sed -i.bak s/x/y/ plain', ctx)!;
    expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx)).toEqual([]);
    symlinkSync('/etc/hosts', join(ctx.cwd, 'plain.bak'));
    op = producer('sed -i.bak s/x/y/ plain', ctx)!;
    expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx)).toContainEqual(expect.objectContaining({ role: 'backup', cause: 'protected' }));
    const backed = producer('rsync --backup-dir=./safe -a src/ out/', ctx)!;
    expect(backed.destinationRoots.some(root => root.path === join(ctx.cwd, 'safe~'))).toBe(false);
  });
});

describe('C3 shared archive roles and output parity', () => {
  const archiveCases = [
    'tar -tf ./a.tar --index-file=/etc/list', 'tar -cf ./a.tar -f /etc/b.tar ./plain',
    'tar -cf ./a.tar --listed-incremental=/etc/snapshot ./plain', 'tar -cf ./a.tar --remove-files /etc/hosts',
    'tar -xPf ./a.tar -C ./out /etc/hosts', 'tar -tf ./a.tar --index-file=-', 'unzip ./a.zip -d /etc',
    'cpio -idm -D ./out', 'tar -xOf ./a.tar -C /etc', 'unzip -p ./a.zip -d /etc',
    'tar -xf ./a.tar -C ./out member -C ./safe another', '7z x ./a.zip -oout',
  ];
  it.each(archiveCases)('AR11 consumes every shared output without parsing %s again', text => {
    const ctx = fixture(), { cmd, walk } = command(text, ctx);
    const fact = archiveCommandEffects('archive', cmd, ctx, walk)!;
    expect(fact.roles).toEqual(archiveRoles(cmd.name, cmd.args.map(roleText)));
    const expected = archiveWrites(cmd.name, cmd.args.map(word => roleText(word) ?? '\u0001'), cmd.operands, ctx.cwd);
    expect(fact.outputs).toEqual(expected);
    expect(fact.effects.map(effect => effect.path)).toEqual(expected);
  });
  it('protected extraction input taints; ordinary opaque archive contents remain untainted', () => {
    const ctx = fixture();
    for (const [text, protectedInput] of [['tar -xf ~/.ssh/a.tar -C out', true], ['tar -xf ./a.tar -C out', false]] as const) {
      const op = producer(text, ctx)!;
      expect(op.operands.some(value => value.role === 'archive-input')).toBe(true);
      expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx).some(hit => hit.cause === 'protected')).toBe(protectedInput);
    }
  });
  it('stdout-only extraction has no artificial writes, even when a read operand taints', () => {
    const ctx = fixture();
    for (const text of ['tar -xOf ~/.ssh/a.tar -C /etc', 'unzip -p ~/.ssh/a.zip -d /etc']) {
      const op = producer(text, ctx)!;
      expect(op.effects).toEqual([]); expect(op.destinationRoots).toEqual([]);
      expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx).some(hit => hit.cause === 'protected')).toBe(true);
    }
  });
  it.each(['tar -xOf ~/.ssh/a.tar -- "$member"', 'unzip -p ~/.ssh/a.zip "$member"'])
  ('stdout-only unknown member creates no destination anchor: %s', text => {
    const ctx = fixture(), op = producer(text, ctx)!;
    expect(op.effects).toEqual([]); expect(op.destinationRoots).toEqual([]); expect(op.destinationPrefixes).toEqual([]);
    expect(op.destinationPrefixes.some(prefix => producerPrefixMatches(join(ctx.cwd, 'notes'), prefix))).toBe(false);
    expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx).some(hit => hit.cause === 'protected')).toBe(true);
  });
  it('unknown roots remain unknown despite archiveWrites removing UNKNOWN_MARK', () => {
    const ctx = fixture(), op = producer('tar -xf ./a.tar -C "$dest"', ctx)!;
    expect(op.unknownDestination).toBe(true);
    expect(op.operands.some(value => value.unknownCause)).toBe(true);
    expect(op.effects.some(effect => effect.path.includes('\u0001'))).toBe(true);
  });
  it.each(['tar "$mode" -f ./a.tar -C out', 'cpio "$mode" -D out', '7z "$mode" ./a.zip -oout'])
  ('consumes the shared unknown-mode extraction reading: %s', text => {
    const ctx = fixture(), op = producer(text, ctx)!;
    expect(op).toBeDefined(); expect(op.family).toBe('extract');
    expect(op.effects.length).toBeGreaterThan(0);
    expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx).some(hit => hit.cause === 'unknown-expansion')).toBe(true);
  });
  it('archive removals preserve unlink semantics and every shared output', () => {
    const ctx = fixture(); writeFileSync(join(ctx.home, '.zshrc'), 'fixture');
    unlinkSync(join(ctx.cwd, 'plain')); linkSync(join(ctx.home, '.zshrc'), join(ctx.cwd, 'plain'));
    symlinkSync('/etc/hosts', join(ctx.cwd, 'h'));
    for (const source of ['plain', 'h']) {
      const { cmd, walk } = command(`tar -cf ./new.tar --remove-files ${source}`, ctx);
      const fact = archiveCommandEffects('remove', cmd, ctx, walk)!;
      expect(fact.effects.map(effect => effect.path)).toEqual(fact.outputs);
      expect(fact.effects).toContainEqual(expect.objectContaining({ path: `${ctx.cwd}/${source}`, op: 'delete', followFinal: false }));
      expect(inspectNativeEffects(fact.effects, ctx).verdict).toBe('run');
    }
  });
  it('cpio named input provenance participates while opaque stream contents do not invent a hazard', () => {
    const ctx = fixture(), walk = newContext(ctx.cwd);
    const args = lex('-idm -D out').filter(token => token.kind === 'word').map(token => (token as { word: Word }).word);
    for (const [path, tainted] of [[join(ctx.home, '.ssh/a.cpio'), true], [join(ctx.cwd, 'a.cpio'), false]] as const) {
      const cmd = simpleCommand('cpio', args, walk, { stdin: { kind: 'file', path } });
      const op = collectProducer('cpio', cmd, ctx, walk)!;
      expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx).some(hit => hit.cause === 'protected')).toBe(tainted);
    }
    const opaque = simpleCommand('cpio', args, walk, { stdin: { kind: 'value', why: 'opaque archive stream' } });
    const op = collectProducer('cpio', opaque, ctx, walk)!;
    expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx)).toEqual([]);
  });
});

describe('C3 Windows mandatory role collection', () => {
  const ctx: FsContext = { cwd: 'C:/work', home: 'C:/Users/fixture', windows: true, remote: true };
  const word = (text: string): Word => ({ parts: [{ kind: 'lit', text, quote: 'single' }] });
  function windows(name: string, args: string[], dialect: 'cmd' | 'pwsh') {
    const walk = newContext(ctx.cwd);
    return collectProducer('windows', simpleCommand(name, args.map(word), walk), ctx, walk, dialect);
  }
  it.each(['/J', '/D', '/H', ''])('W12 cmd mklink %s and ordinary twin', option => {
    for (const protectedTarget of [true, false]) {
      const op = windows('mklink', [...(option ? [option] : []), '.\\h', protectedTarget ? 'C:\\Windows\\named' : 'C:\\work\\plain'], 'cmd');
      expect(op).toBeDefined(); if (!op) return;
      expect(op.family).toBe('link'); expect(op.effects).toHaveLength(1);
      expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx).some(hit => hit.cause === 'protected')).toBe(protectedTarget);
    }
  });
  it.each(['SymbolicLink', 'Junction', 'HardLink'])('W12 PowerShell %s and ordinary twin', type => {
    for (const protectedTarget of [true, false]) {
      const op = windows('New-Item', ['-ItemType', type, '-Path', '.\\h', '-Value', protectedTarget ? 'C:\\Windows\\named' : 'C:\\work\\plain'], 'pwsh');
      expect(op).toBeDefined(); if (!op) return;
      expect(op.family).toBe('link'); expect(op.effects).toHaveLength(1);
      expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx).some(hit => hit.cause === 'protected')).toBe(protectedTarget);
    }
  });
  it('Windows shell anchors stop at drive and UNC share roots', () => {
    for (const path of ['C:/', '//server/share/']) {
      const op = windows('mklink', ['/D', path, 'C:/work/plain'], 'cmd');
      expect(op?.destinationPrefixes).not.toContain('C');
      expect(op?.destinationPrefixes).not.toContain('//server');
      expect(op?.destinationPrefixes.some(prefix => producerPrefixMatches('//server/other/file', prefix, true))).toBe(false);
    }
  });
  it('fsutil hardlink, source removals, aliases and pipeline unknowns retain roles', () => {
    expect(windows('fsutil', ['hardlink', 'create', './h', 'C:/Windows/named'], 'cmd')?.family).toBe('link');
    for (const name of ['Move-Item', 'mi', 'mv']) {
      const op = windows(name, ['-LiteralPath', 'C:/Windows/named', '-Destination', './out'], 'pwsh');
      expect(op?.effects).toContainEqual(expect.objectContaining({ path: 'C:/Windows/named', op: 'delete', followFinal: false }));
    }
    for (const name of ['Copy-Item', 'cpi', 'cp']) expect(windows(name, ['-Path', './plain', '-Destination', './out'], 'pwsh')?.family).toBe('copy');
    expect(windows('Move-Item', ['-Destination', './out'], 'pwsh')?.operands).toContainEqual(expect.objectContaining({ role: 'source', unknownCause: 'missing-operand' }));
    expect(windows('Rename-Item', ['-Path', './safe/plain', '-NewName', 'next'], 'pwsh')?.destinationRoots).toContainEqual(expect.objectContaining({ path: 'C:/work/safe/next' }));
    expect(windows('New-Item', ['-ItemType', 'File', '-Path', './plain'], 'pwsh')).toBeUndefined();
    const walk = newContext(ctx.cwd);
    const pathWord: Word = { parts: [{ kind: 'var', name: 'path', quote: 'double' }] };
    const file = simpleCommand('New-Item', [...['-ItemType', 'File', '-Path'].map(word), pathWord], walk);
    expect(collectProducer('file', file, ctx, walk, 'pwsh')).toBeUndefined();
  });
  it('PowerShell Name and known pipeline data retain effective destinations and source roles', () => {
    const op = windows('New-Item', ['-ItemType', 'HardLink', '-Path', './safe', '-Name', 'h', '-Value', './plain'], 'pwsh');
    expect(op?.destinationRoots).toContainEqual(expect.objectContaining({ path: 'C:/work/safe/h' }));
    expect(op?.effects).toContainEqual(expect.objectContaining({ path: './safe/h', source: './plain', linkKind: 'hard' }));
    const walk = newContext(ctx.cwd);
    const cmd = simpleCommand('Move-Item', ['-Destination', './out'].map(word), walk, { stdin: { kind: 'literal', text: 'C:/work/plain', words: [] } });
    const pipeline = collectProducer('pipe', cmd, ctx, walk, 'pwsh')!;
    expect(pipeline.operands).toContainEqual(expect.objectContaining({ role: 'source', value: 'C:/work/plain' }));
    expect(producerHazards(pipeline.id, pipeline.operands, pipeline.destinationRoots, ctx)).toEqual([]);
  });
  it('Windows copy/move semantic twins use the same child preflight and actual dependency names', () => {
    for (const protectedTarget of [true, false]) {
      const local = fixture();
      symlinkSync(protectedTarget ? '/etc/hosts' : join(local.cwd, 'blob'), join(local.cwd, 'out/plain'));
      for (const name of ['Copy-Item', 'Move-Item']) {
        const walk = newContext(local.cwd);
        const cmd = simpleCommand(name, ['-Path', 'plain', '-Destination', 'out'].map(word), walk);
        const op = collectProducer('windows', cmd, { ...local, windows: true }, walk, 'pwsh')!;
        expect(op.destinationRoots).toContainEqual(expect.objectContaining({ path: join(local.cwd, 'out/plain') }));
        expect(op.directDecisions.some(hit => hit.reason === 'effective-destination')).toBe(protectedTarget);
        expect(op.effects).toContainEqual(expect.objectContaining({ path: 'out/plain', followFinal: name === 'Copy-Item' }));
      }
    }
  });
});

describe('C3 producer glob provenance and limits', () => {
  it('preserves each brace alternative quote mask when a later part globs', () => {
    for (const protectedTarget of [true, false]) {
      const ctx = fixture(); writeFileSync(join(ctx.cwd, 'data/ah'), 'fixture');
      symlinkSync(protectedTarget ? '/etc/hosts' : join(ctx.cwd, 'plain'), join(ctx.cwd, 'data/[a]h'));
      // The typed Word seam can carry quoted alternatives even when the
      // legacy textual lexer refuses this compound syntax.
      writeFileSync(join(ctx.cwd!, 'data/xh'), 'ordinary');
      const source: Word = { parts: [{ kind: 'lit', text: 'data/', quote: 'none' }, { kind: 'brace', alts: [
        { parts: [{ kind: 'lit', text: '[a]', quote: 'single' }] }, { parts: [{ kind: 'lit', text: 'x', quote: 'none' }] },
      ] }, { kind: 'glob', text: '?' }] };
      const walk = newContext(ctx.cwd);
      expect(producerValues(source, walk, ctx).map(value => value.value)).toContain('data/[a]h');
      const op = collectProducer('brace', simpleCommand('ln', [source, { parts: [{ kind: 'lit', text: 'out/', quote: 'none' }] }], walk), ctx, walk)!;
      expect(op.operands.filter(value => value.role === 'source').map(value => value.value)).toContain('data/[a]h');
      expect(op.destinationRoots).toContainEqual(expect.objectContaining({ path: join(ctx.cwd, 'out/[a]h') }));
      expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx).some(hit => hit.cause === 'protected')).toBe(protectedTarget);
    }
  });
  it('overflow preserves already exposed protected candidates and no-match stays Unknown', () => {
    const ctx = fixture(); symlinkSync('/etc/hosts', join(ctx.cwd, 'data/h'));
    const disk: NoLimitsDisk = { ...noLimitsDisk, readdir: () => ['h', ...Array.from({ length: 4096 }, (_, i) => 'f' + i)] };
    const { cmd, walk } = command('ln data/* out/', ctx);
    const values = producerValues(cmd.args[0], walk, { ...ctx, disk });
    expect(values).toContainEqual(expect.objectContaining({ value: 'data/h' }));
    expect(values).toContainEqual(expect.objectContaining({ unknownCause: 'glob-overflow' }));
    expect(expandProducerGlob('data/missing*', ctx)).toContainEqual(expect.objectContaining({ unknownCause: 'unmatched-glob' }));
    expect(expandProducerGlob('data/.*', ctx)).toContainEqual(expect.objectContaining({ unknownCause: 'glob-parent-selection' }));
  });
  it('static brace argv shares one original-word glob budget', () => {
    const ctx = fixture(), ordinary = noLimitsDisk.lstat(join(ctx.cwd, 'plain'));
    const disk: NoLimitsDisk = { ...noLimitsDisk,
      readdir: () => [...Array.from({ length: 2200 }, (_, i) => 'a' + i), ...Array.from({ length: 2200 }, (_, i) => 'b' + i)],
      lstat: path => /\/data\/[ab]\d+$/.test(path) ? ordinary : noLimitsDisk.lstat(path),
    };
    const op = producer('ln data/{a*,b*} out/', { ...ctx, disk })!;
    expect(op.operands.filter(value => value.role === 'source' && !value.unknownCause)).toHaveLength(4096);
    expect(op.operands).toContainEqual(expect.objectContaining({ role: 'source', unknownCause: 'glob-overflow' }));
    expect(op.placement?.unknown).toBe(true);
    // R-CARD's receiver target is separate from the per-word source budget.
    expect(op.placement!.destinations.filter(item => item.source !== undefined).length).toBeLessThanOrEqual(4096);
    expect(op.placement!.destinations.filter(item => item.source === undefined)).toHaveLength(1);
  });
  it('unsupported locale glob classes become Unknown instead of an absent literal path', () => {
    const ctx = fixture(); symlinkSync('/etc/hosts', join(ctx.cwd, 'data/h'));
    const op = producer('ln data/[[:alpha:]] out/', ctx)!;
    expect(op.operands).toContainEqual(expect.objectContaining({ unknownCause: 'unknown-glob-pattern' }));
    expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx).some(hit => hit.cause === 'unknown-expansion')).toBe(true);
  });
  it('retains quoted wildcards within a partly globbed Word', () => {
    const ctx = fixture();
    writeFileSync(join(ctx.cwd, 'data/literal*x'), 'fixture');
    symlinkSync('/etc/hosts', join(ctx.cwd, 'data/literal-otherx'));
    const op = producer("ln 'data/literal*'? out/", ctx)!;
    expect(op.operands.filter(value => value.role === 'source').map(value => value.value)).toEqual(['data/literal*x']);
    expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx)).toEqual([]);
  });
  it('bracket globs expose actual child dependency roots and ignore nonmatching entries', () => {
    const ctx = fixture(), op = producer('ln data/[f] out/', ctx)!;
    expect(op.destinationRoots).toContainEqual(expect.objectContaining({ path: join(ctx.cwd, 'out/f') }));
    const disk: NoLimitsDisk = { ...noLimitsDisk, readdir: () => [...Array.from({ length: 5000 }, (_, index) => `unrelated${index}`), 'f'] };
    expect(expandProducerGlob('data/f*', { ...ctx, disk })).toEqual([expect.objectContaining({ value: 'data/f', rawValue: 'data/f*' })]);
  });
  it('ordinary glob links remain known while protected aliases and overflow taint', () => {
    const ctx = fixture();
    let op = producer('ln data/* out/', ctx)!;
    expect(op.operands.filter(value => value.role === 'source').map(value => value.value)).toEqual(['data/f']);
    expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx)).toEqual([]);
    symlinkSync('/etc/hosts', join(ctx.cwd, 'data/h'));
    op = producer('ln data/* out/', ctx)!;
    expect(producerHazards(op.id, op.operands, op.destinationRoots, ctx).some(hit => hit.cause === 'protected')).toBe(true);
    const disk: NoLimitsDisk = { ...noLimitsDisk, readdir: () => Array.from({ length: 4097 }, (_, index) => `f${index}`) };
    const { cmd, walk } = command('ln data/* out/', ctx);
    expect(expandProducerGlob('data/*', { ...ctx, disk }).some(value => value.unknownCause === 'glob-overflow')).toBe(true);
    expect(producerValues(cmd.args[0], walk, { ...ctx, disk }).some(value => value.unknownCause === 'glob-overflow')).toBe(true);
    expect(op.destinationRoots.some(root => root.path === join(ctx.cwd, 'out/f'))).toBe(true);
    expect(producer('ln data/* out/', fixture())!.unknownDestination).toBe(false);
  });
});
