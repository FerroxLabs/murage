// SPDX-License-Identifier: AGPL-3.0-or-later
// 1021 Retry (RETRY-DESIGN-r2 STOP ROW, W1/W6 stop-row rows): the decision interrupt notes its host stop before it interrupts.
// A stop that did not land is patched to say the bot was not stopped; a later stop for the same ask patches that same row back
// instead of adding a second one. The real decisionInterrupt and Store; only the engine adapter is faked.
import {expect,it} from 'vitest';
import {fixture} from './fixture.ts';
import {decisionInterrupt,isStopFailed,PERMISSION_UNDELIVERED_STOP_REASON,PERMISSION_UNDELIVERED_NOT_STOPPED} from './host-stop-interrupt.ts';
import {hostStoppedActivityName,hostStoppedReason} from '../../shared/host-stop.ts';

it('a stop the driver resolved stop-failed reads "not stopped"; the next stop for the same ask reuses that row (one row per ask)',async()=>{
 const f=fixture();
 let fail=true;
 const interrupt=decisionInterrupt({
  adapter:()=>({interruptTurn:async()=>fail?{closeConfirmed:false,reason:'stop-failed'}:{closeConfirmed:true}}),
  botFor:()=>'b',
  noteHostStop:(threadId,_botId,reason)=>f.store.appendMessage(threadId,{role:'bot',kind:'activity',tool:{name:hostStoppedActivityName(reason),ok:false}}).id,
  patchHostStop:(threadId,rowId,name)=>{f.store.patchMessagePoint(threadId,rowId,{tool:{name,ok:false}});},
 });
 const target={providerInstanceId:'p',threadId:'t',generation:'g',turnId:'turn',requestId:'r'};
 const rows=()=>f.store.messagesFor('t').filter(m=>m.kind==='activity');
 await expect(interrupt(target,PERMISSION_UNDELIVERED_STOP_REASON)).rejects.toThrow();
 expect(rows().map(m=>m.tool?.name)).toEqual([PERMISSION_UNDELIVERED_NOT_STOPPED]);
 // not a host-stop row: the turn was not stopped, so nothing settles as stopped on it
 expect(hostStoppedReason(rows()[0].tool?.name)).toBeUndefined();
 await expect(interrupt(target,PERMISSION_UNDELIVERED_STOP_REASON)).rejects.toThrow();
 expect(rows()).toHaveLength(1);
 fail=false;
 await interrupt(target,PERMISSION_UNDELIVERED_STOP_REASON);
 expect(rows().map(m=>hostStoppedReason(m.tool?.name))).toEqual([PERMISSION_UNDELIVERED_STOP_REASON]);
 // another ask gets its own row
 await interrupt({...target,requestId:'other'},PERMISSION_UNDELIVERED_STOP_REASON);
 expect(rows()).toHaveLength(2);
 f.dispose();
});

it('(Opus r2 H2) a driver that resolves closeConfirmed:false stop-failed is a failed stop; timeout, confirmed and legacy void are not',async()=>{
 const f=fixture();
 let result:unknown;
 const interrupt=decisionInterrupt({
  adapter:()=>({interruptTurn:async()=>result}),
  botFor:()=>'b',
  noteHostStop:(threadId,_botId,reason)=>f.store.appendMessage(threadId,{role:'bot',kind:'activity',tool:{name:hostStoppedActivityName(reason),ok:false}}).id,
  patchHostStop:(threadId,rowId,name)=>{f.store.patchMessagePoint(threadId,rowId,{tool:{name,ok:false}});},
 });
 const target=(requestId:string)=>({providerInstanceId:'p',threadId:'t',generation:'g',turnId:'turn',requestId});
 const row=(_ask?:string)=>f.store.messagesFor('t').filter(m=>m.kind==='activity').at(-1)?.tool?.name;
 result={closeConfirmed:false,reason:'stop-failed'};
 await expect(interrupt(target('a'),PERMISSION_UNDELIVERED_STOP_REASON)).rejects.toThrow();
 expect(row('a')).toBe(PERMISSION_UNDELIVERED_NOT_STOPPED);
 for(const [id,value] of [['b',{closeConfirmed:false,reason:'timeout'}],['c',{closeConfirmed:true}],['d',undefined]] as const){
  result=value;
  await expect(interrupt(target(id),PERMISSION_UNDELIVERED_STOP_REASON)).resolves.toBeUndefined();
  expect(hostStoppedReason(row(id))).toBe(PERMISSION_UNDELIVERED_STOP_REASON);
 }
 f.dispose();
});

it('(r3 N1) a stop whose adapter throws keeps its stopped row: unknown, never "not stopped"',async()=>{
 const f=fixture();
 const interrupt=decisionInterrupt({
  adapter:()=>({interruptTurn:async()=>{throw new Error('adapter-threw');}}),
  botFor:()=>'b',
  noteHostStop:(threadId,_botId,reason)=>f.store.appendMessage(threadId,{role:'bot',kind:'activity',tool:{name:hostStoppedActivityName(reason),ok:false}}).id,
  patchHostStop:(threadId,rowId,name)=>{f.store.patchMessagePoint(threadId,rowId,{tool:{name,ok:false}});},
 });
 const error=await interrupt({providerInstanceId:'p',threadId:'t',generation:'g',turnId:'turn',requestId:'r'},PERMISSION_UNDELIVERED_STOP_REASON).catch(e=>e);
 expect(isStopFailed(error)).toBe(false);
 expect(f.store.messagesFor('t').filter(m=>m.kind==='activity').map(m=>hostStoppedReason(m.tool?.name))).toEqual([PERMISSION_UNDELIVERED_STOP_REASON]);
 f.dispose();
});
