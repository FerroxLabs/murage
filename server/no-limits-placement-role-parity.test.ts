// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lex, literalText, type Word } from './shell/lex.ts';
import { newContext, simpleCommand } from './shell/walk.ts';
import { effectiveDestinations } from './no-limits-placement.ts';

it('ROLE-PARITY-C2b preserves frozen rows plus the three binding R-CARD receiver additions', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'nl-role-parity-'));
  try {
    for (const dir of ['src', 'd/src', 'safe', 'home']) mkdirSync(join(cwd, dir), { recursive: true });
    for (const file of ['blob', 'plain', 'src/blob']) writeFileSync(join(cwd, file), 'fixture');
    symlinkSync('/etc/hosts', join(cwd, 'd/blob'));
    symlinkSync('/etc/hosts', join(cwd, 'd/src/blob'));
    symlinkSync('d', join(cwd, 'linkdir'));
    symlinkSync('plain', join(cwd, 'h'));
    const commands = ['cp', 'mv', 'ln', 'install'].flatMap(program => [
      `${program} blob d`, `${program} -- blob d`, `${program} blob plain d/`,
      ...['-t d', '-td', '--target-directory=d', '--target-directory d'].map(opt => `${program} ${opt} blob plain`),
      `${program} -T blob d`, `${program} --no-target-directory blob d`,
      `${program} -b -S .old blob d`, `${program} --backup=numbered --suffix=.old blob d`,
    ]).concat([
      'ln blob', 'ln -snf blob linkdir', 'ln -sf blob linkdir', 'ln -snf -t linkdir blob',
      'cp -s blob d', 'cp -l blob d', 'cp -a h d', 'cp --remove-destination blob d',
      'cp "$source" /etc', 'cp blob "$destination"', 'cp -L blob d',
      'install -d -m 0700 -o fixture d safe', 'install -m 0600 -o fixture -g fixture blob d',
      'rsync -rt src/ d/', 'rsync -r src d/', 'rsync -r --inplace src/ d/',
      'rsync --relative src d/', 'rsync -e "sh -c true" blob d/',
      'rsync --backup-dir=safe --suffix=.old blob d/', 'rsync -T safe blob d/',
      'rsync --link-dest=safe blob d/', 'rsync --copy-dest safe blob d/',
    ]);
    const rows = commands.map(text => {
      const words = lex(text).filter(token => token.kind === 'word').map(token => (token as { word: Word }).word);
      const walk = newContext(cwd);
      const result = effectiveDestinations(simpleCommand(literalText(words[0]!)!, words.slice(1), walk), { cwd, home: join(cwd, 'home') }, walk)!;
      return { text, sources: result.sources, sourceWords: result.sourceWords, destinationWord: result.destinationWord,
        directoryOperands: result.directoryOperands, destinations: result.destinations.map(item => ({
          path: item.path, source: item.source, semantics: item.semantics, followFinal: item.followFinal, effect: item.effect,
          observed: { kind: item.observed.kind, lexical: item.observed.lexical, physical: item.observed.kind === 'known' ? item.observed.physical : undefined },
        })), decisions: result.decisions.map(decision => ({ reason: decision.reason, lexical: decision.lexical, physical: decision.physical, placement: decision.destinationPlacement })) };
    });
    const normalized = JSON.stringify(rows, null, 2).replaceAll(cwd, '<root>') + '\n';
    const target = new URL('./testing/fixtures/no-limits-placement-c2b-base.json', import.meta.url);
    if (process.env.NLSYM_C3_CAPTURE_PLACEMENT === '1') writeFileSync(target, normalized);
    const expected = JSON.parse(readFileSync(target, 'utf8'));
    // R-CARD deliberately adds the single-target possibility to these three
    // formerly directory-only rows. Keep the original fixture byte-identical
    // and pin only the authorized additions; all other fields still compare.
    const unknownCopy = expected.find((row: any) => row.text === 'cp "$source" /etc');
    unknownCopy.destinations.push({ path: '/etc', semantics: 'write-through', followFinal: true,
      effect: { operandId: 'destination:destination', op: 'write', path: '/etc', followFinal: true },
      observed: { kind: 'known', lexical: '/etc', physical: '/etc' } });
    unknownCopy.decisions.push({ reason: 'direct-path', lexical: '/etc', physical: '/etc' },
      { reason: 'effective-destination', lexical: '/etc', physical: '/etc', placement: {
        sourceOperandId: 'destination', directory: '/etc', child: '/etc', semantics: 'write-through' } });
    for (const command of ['rsync -rt src/ d/', 'rsync -r --inplace src/ d/']) {
      const row = expected.find((row: any) => row.text === command);
      const followFinal = command.includes('--inplace');
      row.destinations.unshift({ path: 'd/', semantics: followFinal ? 'write-through' : 'replace-entry', followFinal,
        effect: { operandId: 'destination:destination', op: followFinal ? 'write' : 'create-name', path: 'd/', followFinal },
        observed: { kind: 'known', lexical: '<root>/d', physical: '<root>/d' } });
    }
    expect(normalized).toBe(JSON.stringify(expected, null, 2) + '\n');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
