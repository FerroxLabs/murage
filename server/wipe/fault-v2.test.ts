// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach,expect,it,vi } from 'vitest';
import * as invocation from './invocation.ts';
import * as evidence from './evidence.ts';
import { wipeBreaker } from '../wipe-breaker.ts';
afterEach(()=>vi.restoreAllMocks());
it.each(['echo hi','echo "rm -rf /"','rm /','mv ./a /work/project','rm -rf /work/project'])('F5 F6 H1 parser fault retains executable semantics: %s',(text)=>{
 vi.spyOn(invocation,'parse').mockImplementation(()=>{throw Error('parser fixture');});
 const found=wipeBreaker(text,{cwd:'/work/project',project:'/work/project',home:'/home/u'});
 expect(found?.rule??null).toBe(text==='rm -rf /work/project'?'delete-system-folder':null);
});
it('F7 double checker fault remains distinct from a wipe',()=>{
 vi.spyOn(invocation,'parse').mockImplementation(()=>{throw Error('parser fixture');});
 vi.spyOn(invocation,'walk').mockImplementation(()=>{throw Error('evidence fixture');});
 // MAIN RULING 23:15Z(d), WIPE-V3 S9: readable harmless double faults run.
 expect(wipeBreaker('echo hi',{cwd:'/work/project'})).toBeNull();
});

it.each([undefined,'pwsh'] as const)('MAIN 1114-WIPE-REVIEW-BOUND parser fault cards plain rd with dialect %s',dialect=>{
 vi.spyOn(invocation,'parse').mockImplementation(()=>{throw Error('parser fixture');});
 expect(wipeBreaker('rd -r -fo ~',{cwd:'/work/project',project:'/work/project',home:'/home/u',dialect})?.rule).toBe('delete-home');
});
it('MAIN 1114-WIPE-REVIEW-BOUND double fault on plain rd retains a fault card',()=>{
 vi.spyOn(invocation,'parse').mockImplementation(()=>{throw Error('parser fixture');});
 vi.spyOn(evidence,'evidenceScan').mockImplementation(()=>{throw Error('recovery fixture');});
 expect(wipeBreaker('rd -r -fo ~',{cwd:'/work/project',home:'/home/u'})?.rule).toBe('wipe-check-fault');
});
