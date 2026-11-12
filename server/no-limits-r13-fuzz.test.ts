import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { judge } from './no-limits-code.ts';
const rows=readFileSync(new URL('./testing/fixtures/no-limits-r13-fuzz.jsonl',import.meta.url),'utf8').trim().split('\n').map(line=>JSON.parse(line));
it.each(rows)('$id minimized oracle witness',row=>{
  const got=judge(row.identity,row.payload,row.mode);
  expect(got.verdict+(got.cls?':'+got.cls:'')).toBe(row.expected);
});
