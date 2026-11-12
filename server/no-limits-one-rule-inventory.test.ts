// SPDX-License-Identifier: AGPL-3.0-or-later
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {expect,it} from 'vitest';
// @ts-expect-error AST checker is a standalone build script.
import {inventory} from '../scripts/inventory-one-rule.mjs';
it('permission cards and approval waits have gate edges',()=>{
 expect(inventory(resolve('.')).errors).toEqual([]);
});
it('a direct producer mutant goes RED',()=>{
 const root=mkdtempSync(join(tmpdir(),'one-rule-mutant-'));
 try {
  mkdirSync(join(root,'server'));mkdirSync(join(root,'shared'));
  writeFileSync(join(root,'server','mutant.ts'),`export function bypass(store,threadId) { return store.appendMessage(threadId,{role:'bot',kind:'options',card:{title:'Approve',options:['Allow','Deny'],requestId:'bypass',tool:'shell'}}); }`);
  expect(inventory(root).errors).toEqual([expect.stringContaining('ungated card')]);
 }finally{rmSync(root,{recursive:true,force:true});}
});

it('a gate in an unrelated conditional does not cover a direct producer',()=>{
 const root=mkdtempSync(join(tmpdir(),'one-rule-conditional-'));
 try {
  mkdirSync(join(root,'server'));mkdirSync(join(root,'shared'));
  writeFileSync(join(root,'server','mutant.ts'),`export function bypass(store,threadId,condition) { if(condition) approvalDecision(threadId,'tool',{}); return store.appendMessage(threadId,{kind:'options',card:{requestId:'bypass',tool:'shell'}}); }`);
  expect(inventory(root).errors).toEqual([expect.stringContaining('ungated card')]);
 }finally{rmSync(root,{recursive:true,force:true});}
});

it('a direct producer using an intermediate card variable goes RED',()=>{
 const root=mkdtempSync(join(tmpdir(),'one-rule-variable-'));
 try {
  mkdirSync(join(root,'server'));mkdirSync(join(root,'shared'));
  writeFileSync(join(root,'server','mutant.ts'),`export function bypass(store,threadId) { const line={kind:'options',card:{requestId:'bypass',tool:'shell'}}; return store.appendMessage(threadId,line); }`);
  expect(inventory(root).errors).toEqual([expect.stringContaining('ungated card')]);
 }finally{rmSync(root,{recursive:true,force:true});}
});
