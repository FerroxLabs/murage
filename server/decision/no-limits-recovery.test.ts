// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {d,fixture,baseRun} from './fixture.ts';
import {guardEngineRelease} from './provider-release.ts';
import {registerRecoveryScriptRequest,isRecoveryScriptRequest} from '../no-limits-wipe-scripts.ts';
const identity={threadId:'t',providerInstanceId:'p',turnId:'turn',requestId:'recovery'};
it('R4 host recovery marker is scoped and removed at retirement',async()=>{
 const f=fixture(),release=registerRecoveryScriptRequest(identity);
 try{
  const h=f.open('recovery',{command:'bash -e cleanup.sh'}),out=d.decide(h,baseRun);
  expect(out.kind).toBe('run'); // MAIN RULING 2026-11-13 narrow-wipe (Sean)

  expect(d.openApprovals('t')).toHaveLength(0);
  expect(guardEngineRelease(identity)).toBe(true);
  await d.deliverRequest(h);expect(f.respond).toHaveBeenCalledOnce();expect(f.respond.mock.calls[0][1].behavior).toBe('allow');
  for(const field of ['threadId','providerInstanceId','turnId','requestId'] as const)expect(isRecoveryScriptRequest({...identity,[field]:'other'})).toBe(false);
  release();expect(isRecoveryScriptRequest(identity)).toBe(false);
 }finally{release();f.dispose();}
});
it('R4 serialized recovery flags cannot change the authenticated path',()=>{
 const f=fixture();
 try{
  const input={command:'bash -e cleanup.sh',recoveryScript:true};
  const h=f.open('recovery',input,{recoveryScript:true});
  expect(d.decide(h,baseRun).kind).toBe('run');
 }finally{f.dispose();}
});
it.each(['rm -rf /','rm -rf ~','rm -rf /w/ordinary','echo ordinary'])('R4 final writer rechecks a recovery replacement: %s',async command=>{
 const f=fixture(),release=registerRecoveryScriptRequest(identity),catastrophic=command==='rm -rf /'||command==='rm -rf ~';
 try{
  const h=f.open('recovery',{command:"bash -c 'echo ok'"});expect(d.decide(h,baseRun).kind).toBe('run');
  expect(guardEngineRelease(identity,{command})).toBe(!catastrophic);
  expect(d.openApprovals('t')).toHaveLength(catastrophic?1:0);
  if(catastrophic){
   const card=d.openApprovals('t')[0];expect(card).toMatchObject({why:'wipe'});
   await d.deliverRequest(h);expect(f.respond).not.toHaveBeenCalled();
   await d.answerApproval(card.ref,{behavior:'allow'});
   expect(f.respond).toHaveBeenCalledOnce();
  }else{
   await d.deliverRequest(h);expect(f.respond).toHaveBeenCalledOnce();
  }
  expect(f.respond.mock.calls[0][1].behavior).toBe('allow');
 }finally{release();f.dispose();}
});

it('R4 recovery marker does not waive a catastrophic operation',async()=>{
 const f=fixture(),release=registerRecoveryScriptRequest(identity);
 try{
  const h=f.open('recovery',{command:'rm -rf /'}),out=d.decide(h,baseRun);
  expect(out.kind).toBe('card');
  if(out.kind!=='card')throw Error('wipe card required');
  await d.presentApproval(out.ref,{title:'Wipe',subtitle:'Fixture'});
  expect(d.readApproval(out.ref.approvalId)).toMatchObject({why:'wipe'});
  expect(guardEngineRelease(identity)).toBe(false);expect(f.respond).not.toHaveBeenCalled();
 }finally{release();f.dispose();}
});
