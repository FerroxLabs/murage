// SPDX-License-Identifier: AGPL-3.0-or-later
import {mkdtempSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import {expect,it} from 'vitest';

// Run the actual output-selection prelude with inert filesystem functions.
// No source tree, fixture, report or mutation is created by this probe.
function output(env={}) {
 const source=readFileSync(new URL('./verify-w1sec-mutants.mjs',import.meta.url),'utf8');
 const prefix=source.slice(0,source.indexOf('const root=')).replace(/^import .*;$/gm,'');
 const writes=[];
 runInNewContext(prefix,{process:{cwd:()=>resolve('.'),env,argv:[]},resolve,relative,isAbsolute,dirname,sep,tmpdir,
  existsSync:()=>true,realpathSync:p=>p,randomUUID:()=> 'fixture',
  join:(...parts)=>resolve(...parts),mkdirSync:path=>writes.push(path),
  mkdtempSync:path=>path+'fixture'});
 return writes;
}
it('mutant reports default to an external evidence directory',()=>{
 const writes=output();
 expect(writes).toHaveLength(1);
 expect(relative(resolve('.'),writes[0]).startsWith('..')).toBe(true);
});
it('mutant reports honor an external evidence directory',()=>{
 const target=resolve(tmpdir(),'verification-evidence');
 expect(output({W1SEC_EVIDENCE_DIR:target})).toEqual([target]);
});
it.each(['.', 'evidence/mutants'])('refuses repository evidence output: %s',target=>{
 expect(()=>output({W1SEC_EVIDENCE_DIR:target})).toThrow(/outside/);
});

it('refuses an external symlink alias into the repository before creating reports',()=>{
 const root=mkdtempSync(join(tmpdir(),'w1sec-output-'));
 try {
  symlinkSync(resolve('.'),join(root,'source'),'junction');
  const result=spawnSync(process.execPath,['scripts/verify-w1sec-mutants.mjs','--check-output'],{
   env:{...process.env,W1SEC_EVIDENCE_DIR:join(root,'source','uncreated','reports')},encoding:'utf8',
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('must be outside the repository');
 } finally {rmSync(root,{recursive:true,force:true});}
});

it('checks a default temporary destination through symlinks before making it',()=>{
 const root=mkdtempSync(join(tmpdir(),'w1sec-default-'));
 try {
  const alias=join(root,'source');symlinkSync(resolve('.'),alias,'junction');
  const env={...process.env,TMPDIR:alias,TEMP:alias,TMP:alias};delete env.W1SEC_EVIDENCE_DIR;
  const result=spawnSync(process.execPath,['scripts/verify-w1sec-mutants.mjs','--check-output'],{env,encoding:'utf8'});
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('must be outside the repository');
 } finally {rmSync(root,{recursive:true,force:true});}
});
