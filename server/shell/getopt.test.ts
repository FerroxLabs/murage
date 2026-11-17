// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { getopt } from './getopt.ts';

describe('shared option engine', () => {
  it('keeps unknown words and the operand reading after unknown options (G1/G2)', () => {
    const r = getopt([undefined, '--mystery', '/etc/x'], {});
    expect(r.unknown).toBe(true);
    expect(r.operands.map(x => x.value)).toEqual([undefined, '/etc/x']);
  });
  it('keeps dash, stops at double dash, and permutes by default (G3)', () => {
    const r = getopt(['-', 'file', '-v', '--', '-x'], { flags: 'v' });
    expect(r.operands.map(x => x.value)).toEqual(['-', 'file', '-x']);
    expect(r.items.some(x => x.kind === 'end')).toBe(true);
    expect(getopt(['file', '-v'], { flags: 'v', permute: false }).operands.map(x => x.value)).toEqual(['file', '-v']);
  });
  it('reads long equals, separate required values and unique prefixes', () => {
    const spec = { long: { expression: 'required', file: 'required', force: 'none' } } as const;
    expect(getopt(['--expr=x', '--expression', 'y'], spec).items).toEqual([
      { arg: 0, offset: 7, kind: 'value', key: '--expression', value: 'x' },
      { arg: 2, offset: 0, kind: 'value', key: '--expression', value: 'y' },
    ]);
    expect(getopt(['--f', 'x'], spec).unknown).toBe(true);
    expect(getopt(['--expression'], spec).unknown).toBe(true);
  });
  it('a valued short letter ends the cluster and consumes the attached remainder', () => {
    expect(getopt(['-xvf./a', '-C/etc'], { flags: 'xv', valued: 'fC' }).items).toEqual([
      { arg: 0, offset: 1, kind: 'flag', key: '-x', value: 'x' },
      { arg: 0, offset: 2, kind: 'flag', key: '-v', value: 'v' },
      { arg: 0, offset: 4, kind: 'value', key: '-f', value: './a' },
      { arg: 1, offset: 2, kind: 'value', key: '-C', value: '/etc' },
    ]);
  });
  it('optional short and long values are attached only', () => {
    const r = getopt(['-i.bak', '-i', 'script', '--in-place=', 'file'], { optional: 'i', long: { 'in-place': 'optional' } });
    expect(r.items.filter(x => x.key).map(x => [x.key, x.value])).toEqual([['-i', '.bak'], ['-i', ''], ['--in-place', '']]);
    expect(r.operands.map(x => x.value)).toEqual(['script', 'file']);
  });
  it('attached-only options never eat a following operand', () => {
    const r = getopt(['-o/etc', '-w', 'file'], { attachedOnly: 'ow' });
    expect(r.items.filter(x => x.key).map(x => x.value)).toEqual(['/etc', '']);
    expect(r.operands.map(x => x.value)).toEqual(['file']);
  });
  it('old-style tar values follow the cluster in letter order', () => {
    const r = getopt(['xfC', './a.tar', '/etc', 'hosts'], { flags: 'x', valued: 'fC', oldStyleFirst: true });
    expect(r.items.filter(x => x.kind === 'value').map(x => [x.key, x.arg, x.value])).toEqual([['-f', 1, './a.tar'], ['-C', 2, '/etc']]);
    expect(r.operands.map(x => x.value)).toEqual(['hosts']);
  });
  it('single-dash long names and colon values preserve source offsets', () => {
    const r = getopt(['-LiteralP:/etc/x', '-Path', 'other'], { singleDashLong: true, long: { LiteralPath: 'required', Path: 'required' } });
    expect(r.items.map(x => [x.key, x.arg, x.offset, x.value])).toEqual([['-LiteralPath', 0, 10, '/etc/x'], ['-Path', 2, 0, 'other']]);
  });
});
