import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {it,expect} from 'vitest';
import {check,select,nodeGateFiles,readLists} from './ci-test-tiers.mjs';
import {removeTempDirSync} from '../server/testing/cleanup.ts';
it.each(['double', 'single', 'bare'])('registered Node gates (%s) must have a blocking runner and never enter a Vitest shard', (quoting)=>{
 const root=mkdtempSync(join(tmpdir(),'ci-node-gates-'));
 try{
  for(const dir of ['ci','electron','shared'])mkdirSync(join(root,dir));
  writeFileSync(join(root,'vite.config.ts'),'test: {include: ["shared/*.test.ts"],exclude: []}');
  writeFileSync(join(root,'shared/example.test.ts'),'');writeFileSync(join(root,'electron/startup.node-test.mjs'),'');
  writeFileSync(join(root,'ci/gate-tests.txt'),'shared/example.test.ts\tall\tfixture\nelectron/startup.node-test.mjs\tall\tstartup\n');writeFileSync(join(root,'ci/extended-tests.txt'),'');
  writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{'test:electron':`node --test ${quoting === 'double' ? '"electron/*.node-test.mjs"' : quoting === 'single' ? "'electron/*.node-test.mjs'" : 'electron/startup.node-test.mjs'}`}}));
  expect(check(root).problems).toEqual([]);expect(select({tier:'gate'},root).files).toEqual(['shared/example.test.ts']);
  writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{}}));expect(check(root).problems).toHaveLength(1);
 }finally{removeTempDirSync(root);}
});

it('registered probe Node tests stay out of Vitest and require their blocking runner',()=>{
 const root=mkdtempSync(join(tmpdir(),'ci-probe-node-gates-'));
 try{
  for(const dir of ['ci','scripts'])mkdirSync(join(root,dir));
  writeFileSync(join(root,'vite.config.ts'),'test: {include: ["scripts/*.test.mjs"],exclude: ["scripts/probe.test.mjs"]}');
  writeFileSync(join(root,'scripts/unit.test.mjs'),'');writeFileSync(join(root,'scripts/probe.test.mjs'),'');
  writeFileSync(join(root,'ci/gate-tests.txt'),'scripts/unit.test.mjs\tall\tunit\nscripts/probe.test.mjs\tall\tprobe\n');writeFileSync(join(root,'ci/extended-tests.txt'),'');
  writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{'test:electron':'node --test "scripts/probe.test.mjs"'}}));
  expect(check(root).problems).toEqual([]);expect(select({tier:'gate'},root).files).toEqual(['scripts/unit.test.mjs']);
  writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{}}));expect(check(root).problems).toHaveLength(1);
 }finally{removeTempDirSync(root);}
});

it('No limits release rulings are blocking Node gates outside every Vitest shard',()=>{
 for(const path of ['scripts/no-limits-live/ruling-1019.node-test.mjs','scripts/no-limits-live/ruling.node-test.mjs']) {
  expect(nodeGateFiles()).toContain(path);
  expect(readLists().gate.has(path)).toBe(true);
  expect(select({tier:'gate'}).files).not.toContain(path);
 }
 expect(check().problems).toEqual([]);
});

it('all 30 added release Vitest files and the Node ruling have blocking tiers',()=>{
 const rows=readFileSync(new URL('../ci/test-truth-r2-tiers.tsv',import.meta.url),'utf8').trim().split('\n').slice(1).map(line=>line.split('\t'));
 expect(rows).toHaveLength(31);
 const lists=readLists();
 for(const [path,tier,oses,reason] of rows){
  expect(tier,path).toBe('gate');expect(oses,path).toBe('all');expect(reason,path).not.toBe('');
  expect(lists.gate.has(path),path).toBe(true);expect(lists.extended.has(path),path).toBe(false);
 }
});
