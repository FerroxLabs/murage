// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,it } from 'vitest';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';
import { readExecutableOwnerNl as ownerRead, readExecutable } from './no-limits-code.ts';
import { mkdtempSync,mkdirSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDirSync } from './testing/cleanup.ts';
// Historical baselines expose only the legacy reader. Assert the missing
// authority as a behavioral RED rather than counting an import/runtime error.
const readExecutableOwnerNl=(...args:Parameters<typeof ownerRead>)=>{const read=(ownerRead??readExecutable)(...args);expect(read).toHaveProperty('authority');return read as ReturnType<typeof ownerRead>;};
it('H2 r2.1 physical PWD survives later logical cd and stack restoration',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'nl-r2-cwd-'));
 try{
 mkdirSync(join(cwd,'safe/deep'),{recursive:true});symlinkSync('/etc/ssl',join(cwd,'e'));symlinkSync(join(cwd,'safe/deep'),join(cwd,'o'));
 for(const [command,hold] of [
 ['cd -P e && cd .. && printf x > hosts',true],
 ['cd -L e && cd .. && printf x > hosts',false],
 ['cd -P o && cd .. && printf x > hosts',false],
 ['cd -P e && cd -L . && cd .. && printf x > hosts',true],
 ['d=./e; cd -Pe "$d" && cd .. && printf x > hosts',true],
 ['cd -P e && pushd '+cwd+' && popd && cd .. && printf x > hosts',true],
 ['cd -P e && cd - && cd - && cd .. && printf x > hosts',true],
 ] as const){
 expect(!!noLimitsProtectedWrite('if; '+command,{commandCwd:cwd},undefined,true),command).toBe(hold);
 expect(readExecutableOwnerNl('sh','set --; '+command,undefined,0,cwd).authority.decisions.length>0,command).toBe(hold);
 }
 }finally{removeTempDirSync(cwd);}
});

it('H2 && selects success only inside the chain',()=>{
 expect(noLimitsProtectedWrite('if; cd /tmp && printf x > hosts',{commandCwd:'/etc'},undefined,true)).toBeNull();
 expect(readExecutableOwnerNl('sh','cd /tmp && printf x > hosts',undefined,0,'/etc').authority.decisions).toEqual([]);
 expect(noLimitsProtectedWrite('if; cd /tmp && true; printf x > hosts',{commandCwd:'/etc'},undefined,true)).toMatchObject({rule:'protected-path'});
});
it('H2 retains protected suffixes after unknown prefixes without inventing a path',()=>{
 for(const [suffix,hold] of [['hosts',true],['notes',false]] as const){
  const command=`if; cd "$d"; tee "$prefix/${suffix}"`;
  expect(!!noLimitsProtectedWrite(command,{commandCwd:'/work'},undefined,true)).toBe(hold);
  expect(readExecutableOwnerNl('sh',command,undefined,0,'/work').authority.decisions.some(d=>d.source==='unknown-cwd-protected-suffix')).toBe(hold);
 }
});
it('H4 nested owner inspection retains the parent PowerShell dialect',()=>{
 for(const [leaf,hold] of [['HOSTS',true],['NOTES',false]] as const){
  const read=readExecutableOwnerNl('pwsh',`cd $d; Set-Content -Path ${leaf} -Value x`,undefined,0,'/work');
  expect(read.authority.decisions.length>0).toBe(hold);
 }
});
it('H4 program roots keep unknown cwd and protected suffix evidence',()=>{
 for(const [leaf,hold] of [['hosts',true],['notes',false]] as const){
  const command=`if; tar -tf ./a -C "$d" --rsh-command='tee ${leaf}'`;
  expect(!!noLimitsProtectedWrite(command,{commandCwd:'/work'},undefined,true)).toBe(hold);
  expect(readExecutableOwnerNl('sh',command,undefined,0,'/work').authority.decisions.length>0).toBe(hold);
 }
});
