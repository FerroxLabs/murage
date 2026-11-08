import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {it,expect} from 'vitest';
import {check,select} from './ci-test-tiers.mjs';
import {removeTempDirSync} from '../server/testing/cleanup.ts';
it('registered Node gates must have a blocking runner and never enter a Vitest shard',()=>{
 const root=mkdtempSync(join(tmpdir(),'ci-node-gates-'));
 try{
  for(const dir of ['ci','electron','shared'])mkdirSync(join(root,dir));
  writeFileSync(join(root,'vite.config.ts'),'test: {include: ["shared/*.test.ts"],exclude: []}');
  writeFileSync(join(root,'shared/example.test.ts'),'');writeFileSync(join(root,'electron/startup.node-test.mjs'),'');
  writeFileSync(join(root,'ci/gate-tests.txt'),'shared/example.test.ts\tall\tfixture\nelectron/startup.node-test.mjs\tall\tstartup\n');writeFileSync(join(root,'ci/extended-tests.txt'),'');
  writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{'test:electron':'node --test "electron/*.node-test.mjs"'}}));
  expect(check(root).problems).toEqual([]);expect(select({tier:'gate'},root).files).toEqual(['shared/example.test.ts']);
  writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{}}));expect(check(root).problems).toHaveLength(1);
 }finally{removeTempDirSync(root);}
});
