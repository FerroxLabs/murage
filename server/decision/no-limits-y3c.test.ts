// Sean 2026-11-12 02:05Z: reader cuts and protected aliases run at No limits.
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { d, fixture, baseRun } from './fixture.ts';
import { describeOwnerNoLimits } from './action.ts';
import { readExecutableOwnerNl } from '../no-limits-code.ts';
import * as python from '../no-limits-python.ts';
import * as javascript from '../no-limits-javascript.ts';
import * as authority from '../no-limits-authority.ts';
import { ReaderBudget, ReaderCut } from '../no-limits-budget.ts';

vi.hoisted(()=>vi.resetModules());
afterEach(()=>vi.restoreAllMocks());
const request=(tool:string,input:unknown)=>({tool,toolCall:{name:tool,input}});

it('H3 Python nesting cut alone runs at ingress and allows delivery',async()=>{
 const source='('.repeat(201)+'0'+')'.repeat(201);
 const budget=Object.assign(new ReaderBudget(),{left:8*source.length+1});
 expect(python.readPython(source,budget).cut).toBe(true);
 expect(budget.left).toBeGreaterThan(0);
 const f=fixture(),input={code:source};
 try {
  const handle=f.open('python-cut',input,request('python',input));
  expect(d.decide(handle,baseRun).kind).toBe('run');
  await d.deliverRequest(handle);
  expect(f.respond.mock.calls[0][1].behavior).toBe('allow');
 } finally { f.dispose(); }
});

for(const lang of ['py','js'] as const){
 it.each([new ReaderCut('parser nesting limit'),new Error('reader exception')])(`H3 ${lang} caught %s alone runs with budget remaining`,async error=>{
  // Both legacy readers turn caught exceptions (including ReaderCut) into cut.
  // Exercise that actual catch, rather than returning a synthetic cut object.
  const method=lang==='py'?python.PyReader.prototype:javascript.JsReader.prototype;
  vi.spyOn(method,'run').mockImplementationOnce(()=>{throw error;});
  const reader=lang==='py'?vi.spyOn(python,'readPython'):vi.spyOn(javascript,'readJavascript');
  const f=fixture(),tool=lang==='py'?'python':'node',input={code:lang==='py'?'0':'0;'};
  try {
   const handle=f.open('caught-cut',input,request(tool,input));
   expect(reader.mock.results[0].value.cut).toBe(true);
   expect(reader.mock.calls[0][1]!.left).toBeGreaterThan(0);
   expect(d.decide(handle,baseRun).kind).toBe('run');
   await d.deliverRequest(handle);
   expect(f.respond.mock.calls[0][1].behavior).toBe('allow');
  } finally { f.dispose(); }
 });
 it(`H3 ${lang} escaping reader exception propagates through the owner adapter`,()=>{
  const reader=lang==='py'?vi.spyOn(python,'readPython'):vi.spyOn(javascript,'readJavascript');
  reader.mockImplementationOnce(()=>{throw new Error('reader exception');});
  expect(()=>readExecutableOwnerNl(lang,'0')).toThrow('reader exception');
 });
 it(`H3 ${lang} ordinary input still runs`,async()=>{
  const f=fixture(),tool=lang==='py'?'python':'node',input={code:lang==='py'?'0':'0;'};
  try {
   const handle=f.open('ordinary',input,request(tool,input));
   expect(d.decide(handle,baseRun).kind).toBe('run');
   await d.deliverRequest(handle);
   expect(f.respond.mock.calls[0][1].behavior).toBe('allow');
  } finally { f.dispose(); }
 });
}

it.each([false,true])('native-file inspector transports decisions and exhausted=%s',async exhausted=>{
 const decision:authority.OwnerNlDecision={kind:'deny',class:'system',ruleId:'native-alias',span:'/w/ordinary',source:'alias',resolution:'protected',taint:{source:'/etc/hosts',destination:'/w/ordinary'},identity:{dev:'1',ino:'2'}};
 const inspected:authority.OwnerNlAuthority={version:1,decisions:[decision],exhausted};
 const inspector=vi.spyOn(authority,'inspectOwnerTargets').mockReturnValue(inspected);
 const input={path:'/w/ordinary',cwd:'/w'};
 expect(describeOwnerNoLimits({tool:'write_file',input}).ownerAuthority).toEqual(inspected);
 expect(inspector).toHaveBeenCalledWith([{path:'/w/ordinary',op:'write'}],'/w');
 const f=fixture();
 try {
  const handle=f.open('native',input,request('write_file',input));
  const outcome=d.decide(handle,baseRun);
  expect(outcome.kind).toBe('run');
  await d.deliverRequest(handle);
  expect(d.openApprovals('t')).toHaveLength(0);
  expect(f.respond.mock.calls[0][1].behavior).toBe('allow');
 } finally { f.dispose(); }
});

it.each(['py','js'] as const)('C3 %s reader fault cannot hide a visible executable home wipe',async lang=>{
 const method=lang==='py'?python.PyReader.prototype:javascript.JsReader.prototype;
 const spy=vi.spyOn(method,'run').mockImplementationOnce(()=>{throw new Error('reader fault');});
 const f=fixture(),tool=lang==='py'?'python':'node';
 const input={code:lang==='py'?"import shutil; shutil.rmtree('/')":"require('fs').rmSync('/', {recursive:true})"};
 try{const h=f.open('fault-wipe',input,request(tool,input));const outcome=d.decide(h,baseRun);
 expect(spy.mock.results[0]?.type).toBe('throw');
 expect(outcome.kind).toBe('card');if(outcome.kind==='card'){await d.presentApproval(outcome.ref,{title:'Wipe',subtitle:'Fixture'});expect(d.readApproval(outcome.ref.approvalId)).toMatchObject({why:'wipe'});}
 await d.deliverRequest(h);expect(f.respond).not.toHaveBeenCalled();
 }finally{spy.mockRestore();f.dispose();}
});
