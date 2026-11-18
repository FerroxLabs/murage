// SPDX-License-Identifier: AGPL-3.0-or-later
// All destinations and transport witnesses belong to the isolated test home.
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {expect, it, vi} from 'vitest';
import {autoVerdict,noLimitsInitiator} from '../auto-approve.ts';
import {noLimitsAppliesTo} from '../no-limits-origin.ts';
import {piGateAsk} from '../drivers/pi.ts';
import {requiredDriverFields as requiredFields} from '../drivers/contracts.ts';
import {resolveCall} from '../../shared/app-action-grant.ts';
import {boundedProjection} from './bounds.ts';
import {baseRun, card, d, fixture} from './fixture.ts';
import type {Registration, RequestOpenedEvent} from './types.ts';

function destination() {
 const root=mkdtempSync(join(homedir(),'projection-fixture-'));
 mkdirSync(join(homedir(),'.ssh'),{recursive:true});mkdirSync(root,{recursive:true});
 const protectedPath=join(homedir(),'.ssh','config');writeFileSync(protectedPath,'old');
 const path=join(root,'notes');symlinkSync(protectedPath,path);
 return {root,path,protectedPath};
}
function editEvent(f:ReturnType<typeof fixture>,id:string,input:Record<string,unknown>,sensitive?:string) {
 const gate=piGateAsk(JSON.stringify({tool:'edit',input,...(sensitive?{sensitive}:{})}));
 // Match Pi.open's field order: toolCall precedes filePaths, localHold and engine.
 return f.event(id,input,{tool:gate.tool,summary:gate.summary,toolCall:gate.toolCall,
  filePaths:gate.filePaths,...(gate.localHold?{localHold:gate.localHold}:{}),toolEngine:'pi'});
}
function policy(level:Registration['level']) {
 return vi.fn((r:Registration)=>{
  const e=r.snapshot!.event;
  return autoVerdict({autoApprove:level!=='ask',fullAccess:level==='full',noLimits:level==='unlimited'},e.tool!,e.summary??'',{
   fullAccessOrigin:'owner',localHold:e.localHold,
   call:{toolCall:e.toolCall,engine:e.toolEngine},
   realPaths:e.filePaths?.map(path=>realpathSync(path)),
  });
 });
}

it.each(['ask','auto','full'] as const)('H1 exact Pi edit projection at %s refuses before BASE and sends no allow',async level=>{
 const f=fixture(level);
 try {
  const {path}=destination(),input={newText:'x'.repeat(1_000_100),oldText:'old',path};
  const event=editEvent(f,'audit',input,'ssh-config');
  const projected=boundedProjection(event);
  expect(projected.toolCall.input.path).toBeUndefined();
  expect(projected.filePaths).toBeUndefined();expect(projected.localHold).toBeUndefined();expect(projected.toolEngine).toBeUndefined();
  f.publish(event);const h=d.openRequest({kind:'engine',threadId:'t',requestId:'audit'}),base=policy(level);
  expect(d.decide(h,base).kind).toBe('refuse');expect(base).not.toHaveBeenCalled();
  await d.deliverRequest(h);
  expect(f.respond).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({behavior:'deny'}),expect.anything());
 } finally {f.dispose();}
});
it('H1 a downgrade before registration cannot discard projection overflow',()=>{
 const f=fixture();
 try {
  const {path}=destination(),input={newText:'x'.repeat(1_000_100),oldText:'old',path};
  f.publish(editEvent(f,'downgrade',input,'ssh-config'));f.setLevel('full');
  const h=d.openRequest({kind:'engine',threadId:'t',requestId:'downgrade'});
  expect(d.decide(h,baseRun).kind).toBe('refuse');
 } finally {f.dispose();}
});
it('H1 a complete small Pi edit at Full access runs through BASE and delivers allow',async()=>{
 const f=fixture('full');
 try {
  const {root}=destination(),path=join(root,'ordinary'),input={newText:'new',oldText:'old',path};writeFileSync(path,'old');
  f.publish(editEvent(f,'small',input));const h=d.openRequest({kind:'engine',threadId:'t',requestId:'small'}),base=policy('full');
  expect(d.decide(h,base).kind).toBe('run');expect(base).toHaveBeenCalledTimes(1);
  await d.deliverRequest(h);expect(f.respond).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({behavior:'allow'}),expect.anything());
 } finally {f.dispose();}
});
it.each(['ask','auto','full'] as const)('H1 native content hashing at %s retains an incomplete card rather than BASE auto-allow',async level=>{
 const f=fixture(level);
 try {
  const {root}=destination(),input={path:join(root,'ordinary'),content:'fixture'.repeat(200_000)};
  const h=f.open('body',input,{tool:'write_file',toolCall:{name:'write_file',input},toolEngine:'pi'}),base=vi.fn(baseRun);
  const outcome=d.decide(h,base);expect(outcome.kind).toBe('card');expect(base).not.toHaveBeenCalled();
  await d.presentApproval(card(outcome),{title:'Write',subtitle:'Complete destination, bounded content'});
  expect(d.readApproval(card(outcome).approvalId)?.why).toBe('base');expect(f.respond).not.toHaveBeenCalled();
 } finally {f.dispose();}
});
it('H1 No limits runs the exact oversized protected Pi edit without consulting BASE',async()=>{
 const f=fixture();
 try {
  const {path}=destination(),input={newText:'x'.repeat(1_000_100),oldText:'old',path};
  f.publish(editEvent(f,'unlimited',input,'ssh-config'));const h=d.openRequest({kind:'engine',threadId:'t',requestId:'unlimited'}),base=policy('unlimited');
  expect(d.decide(h,base).kind).toBe('run');expect(base).not.toHaveBeenCalled();
  await d.deliverRequest(h);expect(f.respond).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({behavior:'allow'}),expect.anything());
  expect(d.openApprovals('t')).toHaveLength(0);
 } finally {f.dispose();}
});
it('H1 No limits checks a native wipe operand beyond the projection budget',async()=>{
 const f=fixture();
 try {
  const input={padding:'x'.repeat(1_000_100),paths:['/']};
  const h=f.open('wipe',input,{tool:'delete_files',toolCall:{name:'delete_files',input},toolEngine:'pi'});
  const outcome=d.decide(h,baseRun);expect(outcome.kind).toBe('card');await d.presentApproval(card(outcome),{title:'Wipe check',subtitle:'Complete original input'});
  expect(d.readApproval(card(outcome).approvalId)?.why).toBe('wipe');
  await d.deliverRequest(h);expect(f.respond).not.toHaveBeenCalled();
 } finally {f.dispose();}
});
it('H1 No limits runs the oversized ordinary edit after retaining its wipe-relevant fields',async()=>{
 const f=fixture();
 try {
  const input={newText:'x'.repeat(17*1024*1024),oldText:'old',path:'/tmp/ordinary'};
  const h=f.open('unread',input,{tool:'Edit',toolCall:{name:'edit',input},toolEngine:'pi'});
  const outcome=d.decide(h,baseRun);
  // MAIN RULING 1114-PI-FLOOR-FOLLOWS-AUTHORITY: size alone is not a wipe; the complete ordinary destination runs.
  expect(outcome.kind).toBe('run');expect(d.openApprovals('t')).toHaveLength(0);
  await d.deliverRequest(h);
  // MAIN RULING 1114-PI-FLOOR-FOLLOWS-AUTHORITY: the approved RUN verdict delivers allow for the unchanged oversized input.
  expect(f.respond).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({behavior:'allow'}),expect.anything());
 } finally {f.dispose();}
});
it('H1 the same oversized capture path retains a real home wipe and withholds delivery',async()=>{
 const f=fixture();
 try {
  const input={padding:'x'.repeat(17*1024*1024),command:'rm -rf ~'};
  const h=f.open('oversized-wipe',input,{tool:'Bash',toolCall:{name:'bash',input},toolEngine:'pi'});
  const outcome=d.decide(h,baseRun);expect(outcome.kind).toBe('card');
  await d.presentApproval(card(outcome),{title:'Wipe check',subtitle:'Home wipe retained'});
  expect(d.readApproval(card(outcome).approvalId)?.why).toBe('wipe');
  await d.deliverRequest(h);expect(f.respond).not.toHaveBeenCalled();
 } finally {f.dispose();}
});
it.each(['path','oldText','filePaths','localHold','toolEngine'] as const)('H1 losing %s alone retains the overflow refusal',field=>{
 const f=fixture('full');
 try {
  const {path}=destination(),input:Record<string,unknown>={newText:'new',oldText:'old',path};
  let event=editEvent(f,'field',input,'ssh-config') as unknown as Record<string,unknown>;
  if(field==='path'||field==='oldText') {
   const {[field]:value,...rest}=input;
   const metadata=Object.fromEntries(Object.entries(event).filter(([key])=>key!=='toolCall'));
   event={...metadata,toolCall:{name:'edit',input:{...rest,padding:'x'.repeat(1_000_100),[field]:value}}};
  } else {
   const {[field]:value,...rest}=event;event={...rest,padding:'x'.repeat(1_000_100),[field]:value};
  }
  const projected=boundedProjection(event);
  expect(projected.toolCall.input.path).toBe(field==='path'?undefined:path);
  expect(projected.toolCall.input.oldText).toBe(field==='oldText'?undefined:'old');
  expect(projected.filePaths).toEqual(field==='filePaths'?undefined:[path]);
  expect(projected.localHold).toBe(field==='localHold'?undefined:'ssh-config');
  expect(projected.toolEngine).toBe(field==='toolEngine'?undefined:'pi');
  f.publish(event as unknown as RequestOpenedEvent);
  expect(d.decide(d.openRequest({kind:'engine',threadId:'t',requestId:'field'}),baseRun).kind).toBe('refuse');
 } finally {f.dispose();}
});
it.each(['ask','full'] as const)('H1 missing engine metadata fails the contract and %s policy closed',level=>{
 const call={engine:undefined,toolCall:{name:'edit',input:{newText:'new'}}};
 expect(requiredFields(undefined,resolveCall(call),call)).toEqual({ok:false,field:'engine'});
 expect(autoVerdict({autoApprove:level!=='ask',fullAccess:level==='full'},'Edit','Edit notes',{fullAccessOrigin:'owner',call})).toMatchObject({approve:null,source:'unread-call'});
});

it.each([undefined,{}, {toolKind:'edit'}, {inputMissing:'path'}] as const)('H1 missing engine metadata cannot validate an absent or partial call: %j',call=>{
 expect(requiredFields(undefined,{kind:'unstamped'},call)).toEqual({ok:false,field:'engine'});
});

it('H1 frozen BASE calls without engine metadata retain explicit refusal assertions',()=>{
 const rows=JSON.parse(readFileSync(new URL('../testing/fixtures/no-limits-r13b-base.json',import.meta.url),'utf8')).rows;
 let cells=0;
 for(const row of rows){
  const initiator=noLimitsInitiator(row.bot,row.context);
  const origin=row.context?.noLimitsOrigin??(initiator==='routine'&&row.context?.unattended!==true?'owner-routine':initiator);
  if(!row.context?.call||row.context.call.engine||row.expected.source==='always-ask'||noLimitsAppliesTo(origin,row.bot))continue;
  // Exercise the modern driver envelope explicitly; legacy pinned calls keep
  // their original BASE comparisons in the frozen corpus suites.
  const call={...row.context.call,engine:undefined};
  const actual=autoVerdict(row.bot,row.tool,row.summary,{...row.context,call});
  expect(requiredFields(undefined,resolveCall(call),call),row.id).toEqual({ok:false,field:'engine'});
  expect(actual,row.id).toEqual({approve:null,source:'unread-call',rule:'the call does not carry what this tool needs (engine)'});
  cells++;
 }
 expect(cells).toBeGreaterThan(0);
});
