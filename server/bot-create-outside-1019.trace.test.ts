import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as S from './turn-settle.ts';
import * as G from './outside-authority.ts';
import { World, traces } from './testing/botcreate-world.ts';

describe('BOT-CREATE-OUTSIDE-1019 r3.3.1', () => {
  it('pins the byte-identical normative traces', () => {
    const bytes = readFileSync(new URL('./testing/botcreate-spec/traces.tsv', import.meta.url));
    expect(createHash('sha256').update(bytes.toString().split('\n').slice(0, 109).join('\n') + '\n').digest('hex')).toBe('78e77f533db5a9a8204fd3a634b8e2d4b97c243dfd6944446b7ecad5ae32b959');
    expect(traces).toHaveLength(111);
    expect(traces.filter(t => t.kind === 'accept')).toHaveLength(35);
    expect(traces.filter(t => t.kind === 'reject')).toHaveLength(76);
    expect(traces.filter(t => /^(SUSAN|SABLE)-/.test(t.id))).toHaveLength(5);
  });
  for (const [file, hash] of Object.entries({ 'settle.py': 'a321500feeb8439937f165e69dbb4957f46b9ab79adedc72a5bd8b02d788355a', 'gate.py': '78eccb4ae57fbc012f3bde0701d3e2a2466cff2fd0ae990bd94d2c99666e88a6' })) it(`pins ${file}`, () => {
    expect(createHash('sha256').update(readFileSync(new URL(`./testing/botcreate-spec/${file}`, import.meta.url))).digest('hex')).toBe(hash);
  });
  for (const trace of traces) it(trace.id, () => {
    expect(new World(S, G).run(trace), trace.id).toEqual([]);
  });
});
