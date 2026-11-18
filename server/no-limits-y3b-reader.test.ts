// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from 'vitest';
import * as code from './no-limits-code.ts';
import { ReaderBudget } from './no-limits-budget.ts';
import type { Payload } from './no-limits-shell.ts';
// Isolate the queue contract from Seat X's segment caps. No program executes.
vi.hoisted(()=>vi.resetModules());
vi.mock('./no-limits-shell.ts',async original=>{
 const real=await original<typeof import('./no-limits-shell.ts')>();
 const shellRead=vi.fn((text:string,depth:number,nested:Payload[])=>{
   if(text.startsWith('ROOT'))for(let i=0;i<80;i++)nested.push(['sh',`PAYLOAD-${i}`,depth+1,'subst']);
   if(text==='THROW')throw new Error('reader failed');return ['','exec'];
 });
 const paths=vi.fn((text:string)=>text==='PAYLOAD-79'?[{path:'/etc/hosts',op:'write'}]:[]);
 return {...real,readShellExec:shellRead,shellPathTargets:paths,shellExecutables:(source:string)=>source,readShellExecOwnerNl:shellRead,shellPathTargetsOwnerNl:paths};
});
const read=(...args:Parameters<typeof code.readExecutable>)=>((code as any).readExecutableOwnerNl??code.readExecutable)(...args);
it('H3 retains the eightieth executable payload',()=>{
 const result=read('sh','ROOT'+' '.repeat(1000));
 expect(result.targets).toContainEqual({path:'/etc/hosts',op:'write'});
});
it('H3 retains work beyond the legacy depth cutoff',()=>{
 const result=read('sh','PAYLOAD-79',undefined,5);
 expect(result.targets).toContainEqual({path:'/etc/hosts',op:'write'});
});
it('H3 an exceeded byte budget is refused, never sliced',()=>{
 expect(()=>read('sh','ROOT')).toThrow();
});
it('H3 reader exceptions propagate',()=>{
 expect(()=>read('sh','THROW')).toThrow('reader failed');
});
it('H3 explicit budget exceptions propagate',()=>{
 const budget=new ReaderBudget();budget.left=0;
 expect(()=>read('sh','PAYLOAD-79',budget)).toThrow();
});
it('H3 ordinary 256 KiB reader input is supplied whole without refusal',async()=>{
 const source='echo ordinary\n'.repeat(20000);
 const shell=await import('./no-limits-shell.ts');
 vi.mocked(shell.readShellExecOwnerNl).mockClear();
 expect(()=>read('sh',source)).not.toThrow();
 expect(vi.mocked(shell.readShellExecOwnerNl).mock.calls[0][0]).toBe(source);
});
it('H3 depth beyond the supported envelope is explicit overflow',()=>{
 expect(()=>read('sh','PAYLOAD-79',undefined,9)).toThrow();
});
it('H3 language-reader text exhaustion propagates',()=>{
 expect(()=>read('py','#'+'x'.repeat(1_000_000))).toThrow();
});
