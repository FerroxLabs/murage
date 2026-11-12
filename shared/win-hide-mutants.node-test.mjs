import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { removeTempDir } from '../server/testing/cleanup.ts';
const source=readFileSync(new URL('./win-hide-child-process.cjs',import.meta.url),'utf8');
const mutants=[
 ['drop native env normalization','    normalizeChildEnv(options);','    /* child env repair removed */','win-hide-generated.node-test.mjs'],
 ['remove prototype hook','options.windowsHide = true;','/* missing prototype default */','win-hide-generated.node-test.mjs'],
 ['drop function in slot 1','const nativeSpawn = binding.spawn;',"if (typeof args[1] === 'function') return Reflect.apply(target, receiver, args);\nconst nativeSpawn = binding.spawn;",'win-hide-generated.node-test.mjs'],
 ['strip execArgv preload','process.execArgv.splice(0, process.execArgv.length, flag, ...withoutPreload(process.execArgv));','/* missing execArgv inheritance */','win-hide-inheritance.node-test.mjs'],
 ['strip NODE_OPTIONS preload','process.env.NODE_OPTIONS = inherit({ env: process.env }).env.NODE_OPTIONS;','/* missing NODE_OPTIONS inheritance */','win-hide-inheritance.node-test.mjs'],
];
for(const [name,from,to,suite] of mutants)test(`mutant RED: ${name}`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'murage-hide-mutant-'));
 try {
  assert.ok(source.includes(from));let mutated=source.replace(from,to);
  if(name==='strip execArgv preload') mutated=mutated.replace('result.execArgv = [flag, ...withoutPreload(options.execArgv)];','result.execArgv = [...options.execArgv];');assert.notEqual(mutated,source);
  if(name==='drop native env normalization') mutated=mutated.replace('          normalizeChildEnv(options);','          /* child env repair removed */');
  const file=join(root,'win-hide-child-process.cjs');writeFileSync(file,mutated);
  const env={...process.env,WINHIDE_INSTALLER_URL:pathToFileURL(file).href};delete env.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,['--test',new URL(suite,import.meta.url).pathname],{env,encoding:'utf8',timeout:45000});
  assert.equal(result.error,undefined);assert.notEqual(result.status,0,`${name} survived\n${result.stdout}`);
  assert.match(result.stdout+result.stderr,/AssertionError/,'fails an assertion, not a loader error');
 }finally{await removeTempDir(root);}
});
test('mutant RED: env literal without inheritance helper',async()=>{
 const {inspectChildEntries}=await import('../scripts/check-windows-hide-entries.mjs');
 const result=inspectChildEntries('server/mutant.ts',`import {spawn} from 'node:child_process';spawn('node',[],{env:{}});`);
 assert.equal(result.failures.length,1);
});
