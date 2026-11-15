import { expect, it, vi } from 'vitest';
import { finalDecision, cleanRead, cutRead, observed } from '../shared/no-limits-decision.ts';
import { autoVerdict, finalizeNoLimits } from './auto-approve.ts';
import { routeDelivery } from './drivers/codex-hook.ts';
import { turnPermissionEnforcement } from './routine-permissions.ts';
const bot={autoApprove:true,fullAccess:true,noLimits:true};
const context={fullAccessOrigin:'owner' as const, ownerStarted:true, commandText:'printf ok', workFolder:'/tmp', commandCwd:'/tmp'};
it('requires every producer to be complete and clean',()=>{
  expect(finalDecision([]).verdict).toBe('card');
  expect(finalDecision([cleanRead('a'),cutRead('b'),cleanRead('c')]).cls).toBe('cut');
  expect(finalDecision([cleanRead('a'),cleanRead('b')]).verdict).toBe('run');
  expect(finalDecision([cutRead('a'),observed('b','root')]).cls).toBe('root');
  expect(finalDecision([cutRead('a'),observed('b','word')]).cls).toBe('word');
});
// Sean 2026-11-12 02:05Z: reader incompleteness is never a No limits hold.
it('runs existing approval candidates and unreadable producer findings',()=>{
  expect(finalizeNoLimits(bot,'Bash','printf ok',{...context,inputTruncated:true},{approve:'candidate',source:'always-allow'}).approve).toBeTruthy();
  expect(finalizeNoLimits(bot,'Bash','printf ok',context,{approve:null,source:'always-ask',rule:'unreadable'}).approve).toBeTruthy();
});
it('propagates no-limits routing and closes every Codex local shortcut',()=>{
  expect(turnPermissionEnforcement(bot)).toEqual({stopLine:true,noLimits:true});
  for (const name of ['apply_patch','view_image','read_file','update_plan','exec_command','mcp__memory__search']) {
    expect(routeDelivery({tool_use_id:"fixture",tool_name:name,tool_input:{command:'printf ok',path:'/tmp/a',note:'x'}},{mounts:[],project:'/tmp',noLimits:true}).route,name).toBe('ask');
  }
});
it('keeps the effect if protocol and environment fail too',()=>{
  vi.spyOn(console,'info').mockImplementation(()=>{});
  try {
    const result=autoVerdict(bot,'Bash','rm -rf /',{...context,commandText:'rm -rf /',inputTruncated:true,envUnchecked:{reason:'timeout'}});
    expect(result).toMatchObject({approve:null,rule:'delete-root'});
  } finally {vi.restoreAllMocks();}
});
it('retains an emitted effect when the shared budget is exhausted immediately afterward', async()=>{
  const {PyReader}=await import('./no-limits-python.ts');
  const {judge}=await import('./no-limits-code.ts');
  const original=PyReader.prototype.twinDelete;
  const spy=vi.spyOn(PyReader.prototype,'twinDelete').mockImplementation(function(this: InstanceType<typeof PyReader>,...args){
    original.apply(this,args); this.budget.left=-1;
  });
  try { expect(judge('python',"import shutil as s; s.rmtree('/')").cls).toBe('root'); }
  finally {spy.mockRestore();}
});
