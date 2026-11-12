import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import * as S from './turn-settle.ts';
import * as G from './outside-authority.ts';
import { World, traces } from './testing/botcreate-world.ts';
import { mutations } from './testing/botcreate-mutants.ts';
const bytes = readFileSync(new URL('./testing/botcreate-spec/mutants.tsv', import.meta.url));
const ids = bytes.toString().trim().split('\n').slice(1).map(l => l.split('\t')[0]);
const sources = { settle: readFileSync(new URL('./turn-settle.ts', import.meta.url), 'utf8'), gate: readFileSync(new URL('./outside-authority.ts', import.meta.url), 'utf8') };
describe('r3.3.1 single-edit mutation parity', () => {
  it('pins every normative mutant', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('5f93fd414d5d21435a5be0e4cbecfe82fce02bfa4170d658195ab97eb8b6bddf');
    expect(ids).toHaveLength(81); expect(Object.keys(mutations).sort()).toEqual([...ids].sort());
  });
  for (const id of ids) it(id, () => {
    const [file, old, replacement] = mutations[id];
    expect(sources[file].split(old).length - 1, 'single edit site').toBe(1);
    const js = ts.transpileModule(sources[file].replace(old, replacement), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {}; new Function('exports', js)(exports);
    const mismatches = traces.filter(t => new World(file === 'settle' ? exports as typeof S : S, file === 'gate' ? exports as typeof G : G).run(t).length > 0).map(t => t.id);
    const own = traces.filter(t => t.guard.split(',').includes(id)).map(t => t.id);
    expect(own.length).toBeGreaterThan(0);
    for (const trace of own) expect(mismatches, `must be RED through ${trace}`).toContain(trace);
    console.info(`KILLED ${id} mismatches=${mismatches.length} by ${own.join(',')}`);
  });
});
